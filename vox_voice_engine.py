"""VoxCPM2 inference only. Imported after the private runtime blocks the network."""
import io
import math
import re
import wave

from pc_voice import VoiceCloneService, VoiceError, PROFILE_ID, MAX_REFERENCE_BYTES, wav_info


def korean_score_text(text):
    """Sports scores use Sino-Korean numbers; ordinary counts are left alone."""
    digits = ('영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구')
    def number(raw):
        value = int(raw)
        if value < 10:
            return digits[value]
        tens, ones = divmod(value, 10)
        return (digits[tens] if tens > 1 else '') + '십' + (digits[ones] if ones else '')
    return re.sub(r'(?<![\d.])([0-9]{1,2})\s*대\s*([0-9]{1,2})(?![\d.])',
                  lambda m: number(m[1]) + ' 대 ' + number(m[2]), text)


def speech_chunks(text, limit=120):
    """Keep model generations short; never silently truncate the user's script."""
    text = korean_score_text(text).strip()
    chunks = []
    while text:
        if len(text) <= limit:
            chunks.append(text)
            break
        prefix = text[:limit + 1]
        boundaries = [m.end() for m in re.finditer(r'[.!?。！？]\s+|\n+', prefix)]
        split = boundaries[-1] if boundaries else prefix.rfind(' ', limit // 2)
        if split <= 0:
            split = limit
        chunks.append(text[:split].strip())
        text = text[split:].strip()
    return chunks


def validate_request(data):
    if not isinstance(data, dict) or set(data) - {'text', 'profileId', 'speed'}:
        raise VoiceError('INVALID_SYNTHESIS', 'Invalid voice request')
    text, profile, speed = data.get('text'), data.get('profileId'), data.get('speed', 1)
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 2000:
        raise VoiceError('INVALID_SYNTHESIS', 'Invalid voice text')
    if not isinstance(profile, str) or not PROFILE_ID.fullmatch(profile):
        raise VoiceError('INVALID_PROFILE', 'Invalid private reference')
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not .75 <= speed <= 1.5:
        raise VoiceError('INVALID_SYNTHESIS', 'Invalid voice speed')
    return text.strip(), profile, speed


def validate_generation_length(token_count, patches):
    # Pinned 2.0.3 can return its final failed retry without an EOS indicator.
    # Its effective limit is dynamic, often much shorter than the 384 maximum.
    if token_count <= 0 or patches <= 0 or patches >= min(token_count * 6 + 10, 384) or patches >= token_count * 6:
        raise VoiceError('VOICE_RETRY_REQUIRED', 'Split the script into shorter sentences and retry', 422)


class VoxEngine:
    def __init__(self, settings):
        from importlib.metadata import version
        import torch
        from voxcpm import VoxCPM
        if version('voxcpm') != '2.0.3':
            raise RuntimeError('Unexpected VoxCPM package version')
        if settings['device'] == 'cuda' and not torch.cuda.is_available():
            raise RuntimeError('CUDA is unavailable')
        self.references = VoiceCloneService(settings['references'], provider='voxcpm2')
        self.model = VoxCPM(voxcpm_model_path=settings['model'], zipenhancer_model_path=None,
                            enable_denoiser=False, optimize=False, device=settings['device'])
        self.sample_rate = int(self.model.tts_model.sample_rate)
        if self.sample_rate != 48000:
            raise RuntimeError('Unexpected VoxCPM2 sample rate')

    def synthesize(self, data):
        import numpy as np
        import torch
        text, profile_id, speed = validate_request(data)
        # Includes reference reads and postprocessing. Cancellation does not
        # release this lock while the GPU is still using shared KV caches.
        with self.references.exclusive():
            profile = self.references._load(profile_id)
            reference = self.references._path(profile_id, '.wav')
            with reference.open('rb') as stream:
                wav_info(stream.read(MAX_REFERENCE_BYTES + 1), reference=True)
            if not 1 <= len(profile['promptText'].strip()) <= 500:
                raise VoiceError('INVALID_PROFILE', 'Invalid reference transcript')
            chunks = speech_chunks(text)
            results, length = [], 0
            torch.manual_seed(42)
            with torch.inference_mode():
                tts = self.model.tts_model
                # Cache once per request, never across profiles. The inference-
                # only separator keeps the reference and new words distinct;
                # the original transcript and WAV stay byte-for-byte unchanged.
                cache = tts.build_prompt_cache(prompt_text=profile['promptText'].strip() + ' ',
                    prompt_wav_path=str(reference), reference_wav_path=str(reference), trim_silence_vad=False)
                for index, chunk in enumerate(chunks):
                    # This model API skips the Chinese/English-only normalizer
                    # and optional denoiser entirely, including lazy downloads.
                    generated, text_tokens, features = tts.generate_with_prompt_cache(
                        target_text=re.sub(r'\s+', ' ', chunk), prompt_cache=cache,
                        cfg_value=2.0, inference_timesteps=10, min_len=2, max_len=384,
                        retry_badcase=True, retry_badcase_max_times=2, retry_badcase_ratio_threshold=6.0)
                    validate_generation_length(int(text_tokens.numel()), int(features.shape[0]))
                    pcm = generated.detach().float().cpu().numpy().reshape(-1)
                    if not pcm.size or not np.isfinite(pcm).all():
                        raise VoiceError('INVALID_AUDIO', 'Invalid generated audio', 502)
                    if index:
                        results.append(np.zeros(int(self.sample_rate * .12), dtype=np.float32))
                        length += len(results[-1])
                    results.append(pcm)
                    length += len(pcm)
                    if length / self.sample_rate / speed > 300:
                        raise VoiceError('VOICE_TOO_LONG', 'Split the script into shorter sections', 422)
            pcm = np.concatenate(results)
            if speed != 1:
                # Vox 2.0.3 has no public numeric speed control. Preserve pitch.
                import librosa
                pcm = librosa.effects.time_stretch(pcm, rate=float(speed))
            if not np.isfinite(pcm).all():
                raise VoiceError('INVALID_AUDIO', 'Invalid generated audio', 502)
            pcm16 = (np.clip(pcm, -1, 1) * 32767).round().astype('<i2')
            result = io.BytesIO()
            with wave.open(result, 'wb') as output:
                output.setparams((1, 2, self.sample_rate, 0, 'NONE', 'not compressed'))
                output.writeframes(pcm16.tobytes())
            audio = result.getvalue()
            wav_info(audio)
            return audio


def build_vox_app(settings):
    from fastapi import FastAPI, Request
    from starlette.concurrency import run_in_threadpool
    from starlette.responses import JSONResponse, Response
    import json
    engine = VoxEngine(settings)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.post('/tts')
    async def synthesize(request: Request):
        try:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 16384:
                    return JSONResponse({'error': 'Voice request too large'}, status_code=413)
            data = json.loads(body)
            validate_request(data)
            audio = await run_in_threadpool(engine.synthesize, data)
            return Response(audio, media_type='audio/wav', headers={'Cache-Control': 'no-store'})
        except VoiceError as error:
            return JSONResponse({'error': error.code}, status_code=error.status)
        except (ValueError, UnicodeError):
            return JSONResponse({'error': 'Invalid voice request'}, status_code=400)
        except Exception:
            # Never echo reference contents, filesystem paths, or model traces.
            return JSONResponse({'error': 'Voice generation failed'}, status_code=500)
    return app
