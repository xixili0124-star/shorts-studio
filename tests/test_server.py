"""실제 AI 호출 없이 동의·입력 제한·로컬 서버를 검사합니다."""
import importlib.util
import base64
from contextlib import nullcontext
import io
import json
import os
from pathlib import Path
import threading
import time
import tempfile
import subprocess
import sys
import unittest
from types import SimpleNamespace
import wave
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch, Mock
from pc_voice import VoiceCloneService, VoiceError, wav_info, MAX_REFERENCE_BODY, local_engine_key, engine_proof
from pc_voice_config import activate_config, provider_of, read_config, settings_path, service_identity
from vox_voice_engine import VoxEngine, korean_score_text, speech_chunks, validate_request, validate_generation_length
from pc_voice_engine import EngineASRReservation
import pc_asr
from pc_asr import PcAsrService, AsrError, validate_audio, public_result

spec=importlib.util.spec_from_file_location('studio_server',Path(__file__).resolve().parents[1]/'studio_server.py')
studio=importlib.util.module_from_spec(spec)
# 모듈 초기화도 실제 PC 엔진 설정을 읽지 않도록 격리한다.
with patch('pc_voice_config.service_identity',return_value=('gpt-sovits',None)):
    spec.loader.exec_module(studio)
studio.service_identity=service_identity

class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=studio.ThreadingHTTPServer(('127.0.0.1',0),studio.StudioHandler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.env=patch.dict(os.environ,{'OPENAI_API_KEY':''})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.upstream=patch.object(studio,'urlopen')
        self.call=self.upstream.start()
        self.addCleanup(self.upstream.stop)
        studio.REQUEST_TIMES.clear()
        temporary=tempfile.TemporaryDirectory(prefix='studio-voice-test-')
        self.addCleanup(temporary.cleanup)
        self.pc=VoiceCloneService(Path(temporary.name)/'private-voices')
        self.server.pc_voice=self.pc
        self.asr=PcAsrService(Path(temporary.name)/'asr-config',voice=self.pc)
        self.server.pc_asr=self.asr
        self.addCleanup(self.asr.close)
        self.asr_job_patch=patch.object(pc_asr,'WindowsJob')
        self.asr_job_factory=self.asr_job_patch.start()
        self.addCleanup(self.asr_job_patch.stop)
        self.asr_job=self.asr_job_factory.return_value
        self.asr_job.name=None
        self.asr_job.close.return_value=True
        self.pc_mock=patch.object(self.pc.opener,'open')
        self.pc_call=self.pc_mock.start()
        self.addCleanup(self.pc_mock.stop)
        # Isolate storage/locking/output tests; identity is covered separately
        # and is not mocked in the real loopback transport test below.
        self.engine_auth=patch.object(self.pc,'require_engine')
        self.engine_auth.start()
        self.addCleanup(self.engine_auth.stop)

    def request(self,path='/api/tts',body=None,headers=None,method=None):
        default={'Origin':self.base,'Content-Type':'application/json','X-Studio-Consent':'text-to-openai'}
        default.update(headers or {})
        default={key:value for key,value in default.items() if value is not None}
        payload=None if body is None else json.dumps(body).encode()
        req=Request(self.base+path,data=payload,headers=default,method=method)
        try:
            with urlopen(req,timeout=5) as response:
                return response.status,response.read(),response.headers
        except HTTPError as error:
            return error.code,error.read(),error.headers

    def pc_request(self,path='status',body=None,headers=None):
        return self.request('/api/voice-clone/'+path,body,
                            {'X-Studio-PC-Voice':'1','X-Studio-Consent':'voice-clone-local',**(headers or {})})

    def asr_request(self,path='status',body=None,headers=None):
        selected={'Origin':self.base,'X-Studio-PC-ASR':'1','X-Studio-Consent':'audio-to-local-asr',
            'Content-Type':'audio/wav' if isinstance(body,bytes) else 'application/json',**(headers or {})}
        selected={key:value for key,value in selected.items() if value is not None}
        data=body if body is None or isinstance(body,bytes) else json.dumps(body).encode()
        request=Request(self.base+'/api/pc-asr/'+path,data=data,headers=selected)
        try:
            with urlopen(request,timeout=5) as response:return response.status,json.loads(response.read())
        except HTTPError as error:return error.code,json.loads(error.read())

    def wait_asr(self,job_id):
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            result=self.asr.get(job_id)
            if result['state']!='running':return result
            time.sleep(.01)
        self.fail('ASR test job did not finish')

    def asr_settings(self):
        return {'engine':str(self.pc.directory.parent/'asr-engine'),'python':str(Path(sys.executable)),
            'model':str(self.pc.directory.parent/'model'),'device':'cuda','computeType':'int8_float16',
            'modelRevision':'test-revision'}

    def test_asr_api_requires_same_origin_header_and_explicit_audio_consent(self):
        audio=self.pcm_wave(1,16000)
        with patch.object(pc_asr.subprocess,'Popen') as process:
            for headers in ({'X-Studio-PC-ASR':None},{'Origin':'https://evil.test'},
                    {'Host':'evil.test'},{'Sec-Fetch-Site':'cross-site'}):
                self.assertEqual(self.asr_request(headers=headers)[0],403)
                self.assertEqual(self.asr_request('transcribe',audio,headers)[0],403)
            self.assertEqual(self.asr_request('transcribe',audio,{'Origin':None})[0],403)
            self.assertEqual(self.asr_request('transcribe',audio,{'X-Studio-Consent':None})[0],403)
            self.assertEqual(self.asr_request('transcribe',audio,{'X-Studio-Consent':'audio-to-openai'})[0],403)
            process.assert_not_called()
        self.call.assert_not_called()

    def test_asr_status_without_install_does_not_use_cloud_or_read_voice_profiles(self):
        with patch.object(self.pc,'profiles',side_effect=AssertionError('ASR must not read references')):
            status,data=self.asr_request()
        self.assertEqual(status,200)
        self.assertFalse(data['configured'])
        self.assertFalse(data['available'])
        self.assertEqual(data['model'],'large-v3-turbo')
        self.assertNotIn('profiles',data)
        self.assertEqual(self.asr_request('jobs/'+'0'*32)[0],404)
        self.assertEqual(self.asr_request('cancel',{'jobId':'../private'})[0],404)
        self.assertEqual(self.asr_request('cancel',{'jobId':'0'*32,'path':'private'})[0],400)
        self.call.assert_not_called()
        self.pc_call.assert_not_called()

    def test_asr_rejects_invalid_audio_and_never_starts_a_process(self):
        with patch.object(pc_asr.subprocess,'Popen') as process:
            self.assertEqual(self.asr_request('transcribe',b'not a wav')[0],413)
            self.assertEqual(self.asr_request('transcribe',self.pcm_wave(1,32000))[0],400)
            self.assertEqual(self.asr_request('transcribe',self.pcm_wave(1,16000)[:-2])[0],400)
            self.assertEqual(self.asr_request('transcribe',{'endpoint':'https://evil.test'})[0],415)
            self.assertEqual(self.asr_request('transcribe',self.pcm_wave(1,16000),{'Transfer-Encoding':'chunked'})[0],413)
            process.assert_not_called()
        self.call.assert_not_called()

    def test_asr_completed_job_preserves_real_segment_fallback_and_releases_lease(self):
        audio=self.pcm_wave(2,16000)
        word={'word':'안녕','start':0.1,'end':0.6,'probability':.9}
        payload={'model':'large-v3-turbo','text':'안녕 테스트','device':'cuda','computeType':'int8_float16',
            'words':[word],'segments':[{'text':'안녕','start':.1,'end':.6,'words':[word]},
                {'text':'테스트','start':1,'end':1.7,'words':[]}], 'secretPath':'C:/private/not-returned'}
        process=Mock();process.returncode=None;process.poll.side_effect=lambda:process.returncode
        def complete(input=None,timeout=None):
            self.assertEqual(input,audio)
            process.returncode=0
            return json.dumps(payload).encode(),None
        process.communicate.side_effect=complete
        with patch.object(pc_asr,'read_settings',return_value=self.asr_settings()), \
                patch.object(pc_asr.subprocess,'Popen',return_value=process) as launch, \
                patch.object(self.pc,'reserve_asr',return_value={'token':'private-lease'}) as reserve, \
                patch.object(self.pc,'release_asr') as release:
            status,data=self.asr_request('transcribe',audio)
            self.assertEqual(status,202)
            result=self.wait_asr(data['jobId'])
            self.assertEqual(result['state'],'done')
            self.assertEqual(result['result']['segments'][1]['text'],'테스트')
            self.assertEqual(result['result']['segments'][1]['start'],1)
            self.assertEqual(result['result']['timingMode'],'mixed')
            self.assertNotIn('secretPath',result['result'])
            reserve.assert_called_once_with(required_free_mib=3584,ttl=660)
            release.assert_called_once_with('private-lease')
            self.asr_job.close.assert_called_once_with()
            arguments=launch.call_args.args[0]
            self.assertIn('--compute-type',arguments)
            self.assertIn('int8_float16',arguments)
            self.assertNotIn('https://',str(arguments))
            self.assertEqual(launch.call_args.kwargs['env']['HF_HUB_OFFLINE'],'1')
            self.assertNotIn('OPENAI_API_KEY',launch.call_args.kwargs['env'])
        self.call.assert_not_called()

    def test_asr_cancel_waits_for_owned_process_exit_before_releasing_voice_lease(self):
        entered=threading.Event();stopped=threading.Event();order=[]
        self.asr_job.close.side_effect=lambda:order.append('job-closed') or True
        process=Mock();process.returncode=None;process.poll.side_effect=lambda:process.returncode
        def pending(input=None,timeout=None):
            entered.set();time.sleep(.01)
            raise subprocess.TimeoutExpired('test-asr',.01)
        def stop(target):
            self.assertIs(target,process);process.returncode=-9;stopped.set();order.append('stopped')
        def release(token):
            self.assertTrue(stopped.is_set());order.append('released')
        process.communicate.side_effect=pending
        with patch.object(pc_asr,'read_settings',return_value=self.asr_settings()), \
                patch.object(pc_asr.subprocess,'Popen',return_value=process), \
                patch.object(pc_asr,'stop_process',side_effect=stop), \
                patch.object(self.pc,'reserve_asr',return_value={'token':'private-lease'}), \
                patch.object(self.pc,'release_asr',side_effect=release):
            job_id=self.asr.start(self.pcm_wave(1,16000))
            self.assertTrue(entered.wait(2))
            with self.assertRaises(AsrError):self.asr.start(self.pcm_wave(1,16000))
            self.assertEqual(self.asr_request('cancel',{'jobId':job_id})[0],200)
            result=self.wait_asr(job_id)
            self.assertEqual(result['state'],'cancelled')
            self.assertNotIn('result',result)
            self.assertEqual(order,['job-closed','stopped','released'])
        self.assertFalse(self.pc.lock.locked())

    def test_asr_job_close_failure_blocks_reuse_without_releasing_voice_lease(self):
        process=Mock(returncode=0)
        process.poll.return_value=0
        process.communicate.return_value=(json.dumps({'text':'', 'model':'large-v3-turbo',
            'device':'cuda','computeType':'int8_float16','words':[],'segments':[]}).encode(),None)
        self.asr_job.close.side_effect=RuntimeError('private job detail')
        with patch.object(pc_asr,'read_settings',return_value=self.asr_settings()), \
                patch.object(pc_asr.subprocess,'Popen',return_value=process), \
                patch.object(self.pc,'reserve_asr',return_value={'token':'private-lease'}), \
                patch.object(self.pc,'release_asr') as release:
            job_id=self.asr.start(self.pcm_wave(1,16000))
            result=self.wait_asr(job_id)
            self.assertEqual(result['state'],'failed')
            self.assertEqual(result['error']['code'],'ASR_STOP_FAILED')
            self.assertNotIn('result',result)
            self.assertNotIn('private job detail',json.dumps(result))
            self.assertTrue(self.asr.uncertain)
            self.assertTrue(self.pc.uncertain)
            release.assert_not_called()
            with self.assertRaises(AsrError) as caught:self.asr.start(self.pcm_wave(1,16000))
            self.assertEqual(caught.exception.code,'ASR_RESTART_REQUIRED')

    def test_asr_results_must_match_supported_device_pair_and_requested_settings(self):
        valid={'text':'test','model':'large-v3-turbo','device':'cuda','computeType':'int8_float16',
            'words':[{'word':'test','start':.2,'end':.8}],'segments':[]}
        expected={'device':'cuda','computeType':'int8_float16'}
        self.assertEqual(public_result(valid,1,expected)['words'],valid['words'])
        for device,compute in (('cpu','int8_float16'),('cuda','int8'),('auto','int8')):
            with self.subTest(device=device,compute=compute):
                with self.assertRaises(AsrError):public_result({**valid,'device':device,'computeType':compute},1)
        with self.assertRaises(AsrError):
            public_result({**valid,'device':'cpu','computeType':'int8'},1,expected)
        with self.assertRaises(AsrError):
            public_result(valid,1,{'device':'cpu','computeType':'int8'})

    def test_asr_invalid_times_do_not_create_plausible_fake_subtitles(self):
        valid={'text':'자막','model':'large-v3-turbo','device':'cuda','computeType':'int8_float16',
            'words':[{'word':'자막','start':.2,'end':.8}], 'segments':[]}
        self.assertEqual(public_result(valid,1)['words'][0]['start'],.2)
        for start,end in ((None,.8),(.2,float('nan')),(-1,.8),(.8,.2),(.2,5),(True,.8),(1.01,1.05)):
            with self.subTest(start=start,end=end):
                with self.assertRaises(AsrError):public_result({**valid,'words':[{'word':'자막','start':start,'end':end}]},1)
        self.assertAlmostEqual(validate_audio(self.pcm_wave(1.25,16000)),1.25)

    def test_engine_asr_reservation_excludes_tts_and_other_asr_until_release(self):
        prepare=Mock(return_value={'modelUnloaded':False,'freeMiB':8192,'memoryStatus':'sufficient'})
        jobs=EngineASRReservation('voxcpm2',prepare)
        request={'requiredFreeMiB':3584,'ttlSeconds':60}
        jobs.begin_tts()
        for operation in (jobs.begin_tts,lambda:jobs.reserve(request)):
            with self.assertRaises(VoiceError) as caught:operation()
            self.assertEqual(caught.exception.code,'VOICE_BUSY')
        prepare.assert_not_called()
        jobs.finish_tts()
        lease=jobs.reserve(request)
        prepare.assert_called_once_with(3584)
        for operation in (jobs.begin_tts,lambda:jobs.reserve(request)):
            with self.assertRaises(VoiceError) as caught:operation()
            self.assertEqual(caught.exception.code,'VOICE_BUSY')
        jobs.release({'token':lease['token']})
        jobs.begin_tts()
        jobs.finish_tts()

    def test_engine_asr_release_requires_exact_current_token_and_is_retryable(self):
        jobs=EngineASRReservation('voxcpm2')
        request={'requiredFreeMiB':3584,'ttlSeconds':60}
        with patch('pc_voice_engine.secrets.token_hex',side_effect=['a'*64,'b'*64]):
            first=jobs.reserve(request)
            for supplied in ({'token':'bad'},{'token':'c'*64},{'token':first['token'],'extra':True}):
                with self.subTest(supplied=supplied):
                    with self.assertRaises(VoiceError):jobs.release(supplied)
                    with self.assertRaises(VoiceError) as caught:jobs.begin_tts()
                    self.assertEqual(caught.exception.code,'VOICE_BUSY')
            self.assertEqual(jobs.release({'token':first['token']}),{'released':True})
            self.assertEqual(jobs.release({'token':first['token']}),{'released':True})
            second=jobs.reserve(request)
            with self.assertRaises(VoiceError) as caught:jobs.release({'token':first['token']})
            self.assertEqual(caught.exception.code,'ASR_RESERVATION_MISMATCH')
            with self.assertRaises(VoiceError):jobs.begin_tts()
            jobs.release({'token':second['token']})
            jobs.begin_tts()
            jobs.finish_tts()

    def test_engine_asr_expired_ttl_does_not_prove_worker_finished(self):
        clock=Mock(return_value=100.0)
        jobs=EngineASRReservation('voxcpm2',clock=clock)
        request={'requiredFreeMiB':3584,'ttlSeconds':30}
        lease=jobs.reserve(request)
        clock.return_value=131.0
        for operation in (jobs.begin_tts,lambda:jobs.reserve(request)):
            with self.assertRaises(VoiceError) as caught:operation()
            self.assertEqual(caught.exception.code,'ENGINE_RESTART_REQUIRED')
        jobs.release({'token':lease['token']})
        jobs.begin_tts()
        jobs.finish_tts()

    def test_engine_unconfirmed_memory_or_tts_failure_blocks_later_gpu_work(self):
        request={'requiredFreeMiB':3584,'ttlSeconds':60}
        for failure in ('prepare','tts'):
            with self.subTest(failure=failure):
                prepare=Mock(side_effect=RuntimeError('unknown GPU state'))
                jobs=EngineASRReservation('voxcpm2',prepare)
                if failure=='prepare':
                    with self.assertRaises(RuntimeError):jobs.reserve(request)
                else:
                    jobs.begin_tts()
                    jobs.finish_tts(completed=False)
                for operation in (jobs.begin_tts,lambda:jobs.reserve(request)):
                    with self.assertRaises(VoiceError) as caught:operation()
                    self.assertEqual(caught.exception.code,'ENGINE_RESTART_REQUIRED')

    def test_engine_known_memory_shortage_does_not_leave_an_unused_reservation(self):
        prepare=Mock(side_effect=VoiceError('ASR_GPU_MEMORY','test memory shortage',503))
        jobs=EngineASRReservation('voxcpm2',prepare)
        with self.assertRaises(VoiceError) as caught:
            jobs.reserve({'requiredFreeMiB':3584,'ttlSeconds':60})
        self.assertEqual(caught.exception.code,'ASR_GPU_MEMORY')
        jobs.begin_tts()
        jobs.finish_tts()

    def private_engine_health(self):
        key='private_test_key_'+'a'*32
        self.pc.engine_headers={'X-Studio-Engine-Key':key}
        def read(maximum):
            request=self.pc_call.call_args.args[0]
            return json.dumps({'service':'shorts-studio-pc-voice','protocol':1,
                'proof':engine_proof(key,request.get_header('X-studio-engine-nonce'))}).encode()
        self.pc_call.return_value.__enter__.return_value.read.side_effect=read
        return key

    @staticmethod
    def pcm_wave(duration=3.25,rate=32000,silent=False):
        stream=io.BytesIO()
        with wave.open(stream,'wb') as audio:
            audio.setparams((1,2,rate,0,'NONE','not compressed'))
            audio.writeframes((b'\0\0' if silent else b'\xe8\x03')*int(duration*rate))
        return stream.getvalue()

    def new_reference(self):
        data={'name':'내 목소리','promptText':'안녕하세요. 참고 음성입니다.','consent':True,
              'audio':base64.b64encode(self.pcm_wave()).decode()}
        return self.pc.register(data)

    def test_static_editor_and_no_key_status(self):
        status,body,_=self.request('/studio.html')
        self.assertEqual(self.request('/pc-voice-setup.html')[0],200)
        self.assertEqual(status,200)
        self.assertIn(b'js/studio-app.js',body)
        self.assertIn(b'id="rippleDeleteClip"',body)
        status,body,_=self.request('/js/timeline-edits.js')
        self.assertEqual(status,200)
        self.assertIn(b'export function planVideoPlacement',body)
        for path,marker in (
            ('/js/font-catalog.js',b'export const FONTS'),
            ('/js/safe-areas.js',b'export const SAFE_AREAS'),
            ('/js/sound-effects.js',b'export const SOUND_EFFECTS'),
            ('/js/visual-transform.js',b'export function transformOf'),
            ('/js/batch-edits.js',b'export function planBatchSplit'),
            ('/js/monitor-editor.js',b'export class MonitorEditor'),
            ('/js/studio-tools.js',b'export class StudioTools'),
            ('/js/silence.js',b'export function analyzeSilence'),
            ('/js/mosaic.js',b'export function mosaicAt'),
            ('/js/video-analysis.js',b'export async function trackMosaic'),
            ('/js/local-ai.js',b'export function runLocalAI'),
            ('/js/pc-voice.js',b'export function isPcVoiceOrigin'),
            ('/js/tts-worker.js',b'TextToSpeech'),
            ('/js/asr-worker.js',b'automatic-speech-recognition'),
        ):
            with self.subTest(module=path):
                status,body,_=self.request(path)
                self.assertEqual(status,200)
                self.assertIn(marker,body)
        for path,mime in (
            ('/vendor/onnxruntime-web/1.23.2/ort.wasm.min.mjs','text/javascript'),
            ('/vendor/onnxruntime-web/1.23.2/ort-wasm-simd-threaded.wasm','application/wasm'),
            ('/vendor/transformers/3.8.1/ort-wasm-simd-threaded.jsep.mjs','text/javascript'),
            ('/vendor/transformers/3.8.1/ort-wasm-simd-threaded.jsep.wasm','application/wasm'),
        ):
            with self.subTest(runtime=path):
                status,_,headers=self.request(path,method='HEAD')
                self.assertEqual(status,200)
                self.assertEqual(headers.get_content_type(),mime)
                self.assertGreater(int(headers['Content-Length']),1000)
        status,body,_=self.request('/api/ai/status')
        self.assertFalse(json.loads(body)['configured'])
        self.assertFalse(json.loads(body)['verified'])
        self.call.assert_not_called()

    def test_missing_key_fails_without_network(self):
        status,body,_=self.request(body={'text':'테스트','voice':'marin'})
        self.assertEqual(status,503)
        self.assertEqual(json.loads(body)['error']['code'],'AI_NOT_CONFIGURED')
        self.call.assert_not_called()

    def test_external_origin_and_missing_consent_are_rejected(self):
        for headers in ({'Origin':'https://example.org'},{'X-Studio-Consent':''},{'Host':'evil.test'}):
            with self.subTest(headers=headers):
                status,_,_=self.request(body={'text':'hello'},headers=headers)
                self.assertEqual(status,403)
        self.call.assert_not_called()

    def test_validation_rejects_unsupported_voice_speed_and_large_text(self):
        for data in ({'text':''},{'text':'x'*2001},{'text':'x','voice':'fake'},{'text':'x','speed':True},{'text':'x','speed':float('nan')},{'text':'x','speed':5}):
            with self.subTest(data_type=list(data)):
                with self.assertRaises(ValueError):studio.validate_tts(data)
        result=studio.validate_tts({'text':'한국어','voice':'cedar','speed':1.1})
        self.assertEqual(result['model'],'gpt-4o-mini-tts')
        self.assertEqual(result['response_format'],'wav')

    def test_content_type_and_size_limits(self):
        status,_,_=self.request(body={'text':'hello'},headers={'Content-Type':'text/plain'})
        self.assertEqual(status,415)
        status,_,_=self.request(body={'text':'x'*70000})
        self.assertEqual(status,413)
        self.call.assert_not_called()

    def test_mock_speech_success_never_exposes_key(self):
        # 가짜 토큰과 가짜 upstream 응답만 사용합니다.
        wave=b'RIFF'+b'\x24\x00\x00\x00'+b'WAVE'+bytes(32)
        self.call.return_value.__enter__.return_value.read.return_value=wave
        with patch.dict(os.environ,{'OPENAI_API_KEY':'test-placeholder-only'}):
            status,body,headers=self.request(body={'text':'hello','voice':'marin'})
            self.assertEqual(status,200)
            self.assertEqual(body,wave)
            self.assertEqual(headers['Content-Type'],'audio/wav')
            _,state,_=self.request('/api/ai/status')
            self.assertNotIn(b'test-placeholder-only',state)
        request=self.call.call_args.args[0]
        self.assertEqual(request.full_url,'https://api.openai.com/v1/audio/speech')

    def test_timestamp_multipart_uses_word_and_segment(self):
        body,content_type=studio.transcription_body(b'wave-bytes')
        self.assertIn(b'whisper-1',body)
        self.assertIn(b'verbose_json',body)
        self.assertEqual(body.count(b'name="timestamp_granularities[]"'),2)
        self.assertIn(b'wave-bytes',body)
        self.assertTrue(content_type.startswith('multipart/form-data; boundary=studio-'))

    def test_pc_status_checks_api_without_claiming_inference_and_hides_paths(self):
        profile=self.new_reference()
        self.private_engine_health()
        status,body,_=self.pc_request()
        self.assertEqual(status,200)
        data=json.loads(body)
        self.assertEqual(data['state'],'ready')
        self.assertFalse(data['inferenceVerified'])
        self.assertEqual(data['profiles'][0]['id'],profile['id'])
        self.assertNotIn(str(self.pc.directory).encode(),body)
        self.assertNotIn(b'ref_audio_path',body)
        self.assertEqual(self.pc_call.call_args.args[0].full_url,'http://127.0.0.1:9880/studio/health')
        self.call.assert_not_called()

    def test_pc_register_delete_and_static_server_never_serves_reference(self):
        data={'name':'내 목소리','promptText':'읽은 문장','consent':True,
              'audio':base64.b64encode(self.pcm_wave()).decode()}
        status,body,_=self.pc_request('references',data)
        self.assertEqual(status,201)
        profile=json.loads(body)['profile']
        self.assertEqual(profile['duration'],3.25)
        self.assertTrue((self.pc.directory/(profile['id']+'.wav')).exists())
        self.assertEqual(self.request('/.studio-local/voices/'+profile['id']+'.wav')[0],404)
        status,_,_=self.pc_request('delete',{'profileId':profile['id'],'consent':True})
        self.assertEqual(status,200)
        self.assertEqual(list(self.pc.directory.iterdir()),[])
        self.pc_call.assert_not_called()
        self.call.assert_not_called()

    def test_pc_requests_reject_cross_origin_missing_headers_and_consent(self):
        for route in ('references','delete','synthesize'):
            for headers in ({'Origin':'https://evil.test'},{'Origin':'null'},{'Origin':None},
                            {'Host':'evil.test'},{'X-Studio-PC-Voice':None},{'X-Studio-Consent':None},
                            {'Sec-Fetch-Site':'cross-site'}):
                with self.subTest(route=route,headers=headers):
                    self.assertEqual(self.pc_request(route,{'consent':True},headers)[0],403)
        self.assertEqual(self.pc_request(headers={'Origin':'https://evil.test'})[0],403)
        self.assertEqual(self.pc_request(headers={'X-Studio-PC-Voice':None})[0],403)
        self.pc_call.assert_not_called()
        self.assertFalse(self.pc.directory.exists())

    def test_pc_partial_delete_keeps_reference_visible_and_retryable(self):
        original_unlink=Path.unlink
        for blocked_suffix in ('.wav','.json'):
            with self.subTest(blocked_suffix=blocked_suffix):
                profile=self.new_reference()
                def locked(path,*args,**kwargs):
                    if path.stem==profile['id'] and path.suffix==blocked_suffix:raise PermissionError('test file lock')
                    return original_unlink(path,*args,**kwargs)
                with patch.object(Path,'unlink',locked):
                    with self.assertRaises(VoiceError):self.pc.delete(profile['id'])
                listed=self.pc.profiles()
                self.assertEqual(len(listed),1)
                self.assertEqual(listed[0]['audioAvailable'],blocked_suffix=='.wav')
                self.pc.delete(profile['id'])
                self.assertEqual(list(self.pc.directory.iterdir()),[])

    def test_pc_bad_unicode_is_rejected_before_private_files_are_written(self):
        for key in ('name','promptText'):
            data={'name':'valid','promptText':'valid','consent':True,'audio':base64.b64encode(self.pcm_wave()).decode()}
            data[key]='\ud800'
            with self.assertRaises(VoiceError) as caught:self.pc.register(data)
            self.assertEqual(caught.exception.code,'INVALID_REFERENCE_TEXT')
            self.assertEqual(list(self.pc.directory.glob('*')),[])

    def test_pc_engine_key_is_sent_only_in_private_upstream_headers(self):
        key=self.private_engine_health()
        status=self.pc.status()
        self.assertNotIn(key,json.dumps(status))
        self.assertIsNone(self.pc_call.call_args.args[0].get_header('X-studio-engine-key'))
        profile=self.new_reference()
        self.pc_call.return_value.__enter__.return_value.read.side_effect=None
        self.pc_call.return_value.__enter__.return_value.read.return_value=self.pcm_wave(1)
        self.pc.synthesize({'profileId':profile['id'],'text':'test','consent':True})
        request=self.pc_call.call_args.args[0]
        self.assertEqual(request.get_header('X-studio-engine-key'),key)
        self.assertNotIn(key,request.data.decode())
        settings=self.pc.directory/'settings.json'
        settings.write_text(json.dumps({'engineKey':key}),encoding='utf-8')
        self.assertEqual(local_engine_key(settings),key)
        settings.write_text('{"engineKey":"bad\\nheader"}',encoding='utf-8')
        self.assertIsNone(local_engine_key(settings))

    def test_pc_status_rejects_raw_engines_and_forged_or_replayed_health(self):
        self.private_engine_health()
        self.assertEqual(self.pc.status()['state'],'ready')
        read=self.pc_call.return_value.__enter__.return_value.read
        recorded=read.side_effect(4097)
        read.side_effect=None
        for result in (b'{"paths":{"/tts":{"post":{}}}}',
                       b'{"service":"shorts-studio-pc-voice","protocol":1,"proof":"fake"}',recorded):
            read.return_value=result
            self.assertEqual(self.pc.status()['state'],'offline')

    def test_pc_generation_rechecks_identity_without_sending_key_or_voice_to_another_server(self):
        self.engine_auth.stop()
        self.private_engine_health()
        self.assertEqual(self.pc.status()['state'],'ready')
        profile=self.new_reference()
        self.pc_call.reset_mock()
        self.pc_call.return_value.__enter__.return_value.read.side_effect=None
        self.pc_call.return_value.__enter__.return_value.read.return_value=b'{"paths":{"/tts":{"post":{}}}}'
        with self.assertRaises(VoiceError) as caught:self.pc.synthesize({'profileId':profile['id'],'text':'PRIVATE SCRIPT','consent':True})
        self.assertEqual(caught.exception.code,'ENGINE_NOT_READY')
        self.assertEqual(self.pc_call.call_count,1)
        request=self.pc_call.call_args.args[0]
        self.assertEqual(request.get_method(),'GET')
        self.assertTrue(request.full_url.endswith('/studio/health'))
        self.assertIsNone(request.get_header('X-studio-engine-key'))
        self.assertIsNone(request.data)

    def test_vox_authentication_binds_provider_model_and_protocol_before_any_private_post(self):
        self.engine_auth.stop()
        profile=self.new_reference()
        key=self.private_engine_health()
        self.pc.provider='voxcpm2'
        # A valid legacy proof is not proof that a Vox engine is running.
        self.assertEqual(self.pc.status()['state'],'offline')
        for provider,model,proof_provider,protocol in (
            ('gpt-sovits','v2ProPlus','gpt-sovits',2),
            ('voxcpm2','different-model','voxcpm2',2),
            ('voxcpm2','VoxCPM2-2B','gpt-sovits',2),
            ('voxcpm2','VoxCPM2-2B','voxcpm2',99),
        ):
            with self.subTest(provider=provider,model=model,protocol=protocol):
                def health(maximum):
                    request=self.pc_call.call_args.args[0]
                    return json.dumps({'service':'shorts-studio-pc-voice','protocol':protocol,
                        'provider':provider,'model':model,
                        'proof':engine_proof(key,request.get_header('X-studio-engine-nonce'),proof_provider,model)}).encode()
                self.pc_call.return_value.__enter__.return_value.read.side_effect=health
                self.pc_call.reset_mock()
                with self.assertRaises(VoiceError):self.pc.synthesize({'profileId':profile['id'],'text':'PRIVATE SCRIPT','consent':True})
                self.assertEqual(self.pc_call.call_count,1)
                request=self.pc_call.call_args.args[0]
                self.assertEqual(request.get_method(),'GET')
                self.assertIsNone(request.get_header('X-studio-engine-key'))
                self.assertIsNone(request.data)

    def test_vox_uses_same_reference_and_only_sends_owned_id_after_valid_proof(self):
        self.engine_auth.stop()
        profile=self.new_reference()
        original={path.name:path.read_bytes() for path in self.pc.directory.iterdir()}
        key=self.private_engine_health()
        self.pc.provider='voxcpm2'
        def read(maximum):
            request=self.pc_call.call_args.args[0]
            if request.get_method()=='POST':return self.pcm_wave(1.2,48000)
            return json.dumps({'service':'shorts-studio-pc-voice','protocol':2,'provider':'voxcpm2','model':'VoxCPM2-2B',
                'proof':engine_proof(key,request.get_header('X-studio-engine-nonce'),'voxcpm2','VoxCPM2-2B')}).encode()
        self.pc_call.return_value.__enter__.return_value.read.side_effect=read
        status=self.pc.status()
        self.assertEqual((status['state'],status['provider'],status['modelName']),('ready','voxcpm2','VoxCPM2'))
        self.assertNotIn(key,json.dumps(status))
        audio,info=self.pc.synthesize({'profileId':profile['id'],'text':'새 원고','speed':1.1,'consent':True,
                                      'ref_audio_path':'C:/private.txt','prompt_text':'not allowed'})
        payload=json.loads(self.pc_call.call_args.args[0].data)
        self.assertEqual(payload,{'text':'새 원고','profileId':profile['id'],'speed':1.1})
        self.assertEqual(info['sampleRate'],48000)
        self.assertEqual(audio,self.pcm_wave(1.2,48000))
        self.assertEqual(original,{path.name:path.read_bytes() for path in self.pc.directory.iterdir()})

    def test_provider_migration_preserves_legacy_config_key_and_reference_bytes(self):
        profile=self.new_reference()
        local=self.pc.directory.parent/'settings'
        local.mkdir()
        previous={'engineKey':'legacy_key_'+'a'*32,'engine':'C:/old-engine','custom':'keep this'}
        original=json.dumps(previous,ensure_ascii=False,indent=3).encode()
        (local/'pc-voice.json').write_bytes(original)
        refs={path.name:path.read_bytes() for path in self.pc.directory.iterdir()}
        self.assertEqual(provider_of(read_config(local/'pc-voice.json')),'gpt-sovits')
        self.assertEqual(settings_path(local,'gpt-sovits'),local/'pc-voice.json')
        new={'provider':'voxcpm2','engineKey':'new_vox_key_'+'b'*32,'engine':'C:/new-engine'}
        activate_config(local,new)
        self.assertEqual((local/'pc-voice-gpt-sovits.json').read_bytes(),original)
        self.assertEqual(read_config(local/'pc-voice.json'),new)
        self.assertEqual(service_identity(local),('voxcpm2',new['engineKey']))
        self.assertEqual(service_identity(local,'gpt-sovits'),('gpt-sovits',previous['engineKey']))
        self.assertEqual(refs,{path.name:path.read_bytes() for path in self.pc.directory.iterdir()})
        with self.assertRaises(ValueError):activate_config(local,{'provider':'unknown','engineKey':'x'*40})
        self.assertEqual(read_config(local/'pc-voice.json'),new)

    def test_failed_vox_install_does_not_activate_or_modify_existing_installation(self):
        import setup_vox_voice as setup
        root=self.pc.directory.parent/'install-root'
        local=root/'.studio-local'
        local.mkdir(parents=True)
        previous=b'{"engineKey":"existing_private_key_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
        (local/'pc-voice.json').write_bytes(previous)
        with patch.object(setup,'ROOT',root), \
             patch.object(sys,'argv',['setup_vox_voice.py','--yes','--engine-dir',str(root/'vox')]), \
             patch.object(setup,'prepare_models',return_value=root/'vox'/'model'), \
             patch.object(setup,'prepare_runtime',side_effect=RuntimeError('failed import')), \
             patch.object(setup,'write_config') as activate:
            with self.assertRaises(RuntimeError):setup.main()
            activate.assert_not_called()
        self.assertEqual((local/'pc-voice.json').read_bytes(),previous)
        self.assertFalse((local/'pc-voice-voxcpm2.json').exists())

    def test_failed_final_config_replace_keeps_active_engine_and_legacy_backup(self):
        local=self.pc.directory.parent/'settings'
        local.mkdir()
        previous=b'{"engineKey":"previous_key_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
        active=local/'pc-voice.json'
        active.write_bytes(previous)
        replace=Path.replace
        def guarded_replace(path,target):
            if path==local/'pc-voice.json.tmp':raise PermissionError('simulated file lock')
            return replace(path,target)
        with patch.object(Path,'replace',guarded_replace):
            with self.assertRaises(PermissionError):activate_config(local,{'provider':'voxcpm2','engineKey':'v'*40})
        self.assertEqual(active.read_bytes(),previous)
        self.assertEqual((local/'pc-voice-gpt-sovits.json').read_bytes(),previous)
        self.assertEqual(service_identity(local)[0],'gpt-sovits')

    def test_explicit_provider_rejects_a_mislabeled_saved_config(self):
        local=self.pc.directory.parent/'settings'
        local.mkdir()
        (local/'pc-voice-gpt-sovits.json').write_text(json.dumps({'provider':'voxcpm2','engineKey':'x'*40}),encoding='utf-8')
        with self.assertRaises(ValueError):settings_path(local,'gpt-sovits')
        self.assertEqual(service_identity(local,'gpt-sovits'),('gpt-sovits',None))

    def test_uncertain_inference_cannot_delete_a_reference_still_in_use(self):
        profile=self.new_reference()
        self.pc.uncertain=True
        with self.assertRaises(VoiceError) as caught:self.pc.delete(profile['id'])
        self.assertEqual(caught.exception.code,'ENGINE_RESTART_REQUIRED')
        self.assertTrue(self.pc._path(profile['id'],'.wav').is_file())
        self.assertTrue(self.pc._path(profile['id'],'.json').is_file())

    def test_vox_scores_and_chunking_preserve_ordinary_counts_and_all_script_content(self):
        self.assertEqual(korean_score_text('베트남이 태국을 4대 2로 꺾고'), '베트남이 태국을 사 대 이로 꺾고')
        self.assertEqual(korean_score_text('14대12, 0대0, 21 대 9'), '십사 대 십이, 영 대 영, 이십일 대 구')
        for text in ('차량 4대', '4:20에 출발', '144대2', '4대2.5', '사대 이로 꺾고'):
            self.assertEqual(korean_score_text(text),text)
        text=('이번 경기는 4대 2로 끝났습니다. 다음 문장도 빠짐없이 읽어 주세요!\n'*40).strip()
        chunks=speech_chunks(text)
        self.assertGreater(len(chunks),1)
        self.assertTrue(all(0<len(chunk)<=120 for chunk in chunks))
        self.assertEqual(''.join(''.join(chunks).split()),''.join(korean_score_text(text).split()))

    def test_vox_worker_rejects_paths_urls_unbounded_text_and_invalid_rates(self):
        good={'profileId':'a'*32,'text':'테스트','speed':1}
        self.assertEqual(validate_request(good),('테스트','a'*32,1))
        for update in ({'ref_audio_path':'C:/secret.wav'},{'endpoint':'https://example.test'},
                       {'profileId':'../secret'},{'text':'x'*2001},{'speed':True},{'speed':float('nan')},{'speed':0}):
            with self.subTest(update=update):
                with self.assertRaises(VoiceError):validate_request({**good,**update})

    def test_vox_rejects_final_failed_retries_at_dynamic_or_global_output_limits(self):
        validate_generation_length(10,30)
        validate_generation_length(100,383)
        # Ten tokens have a 70-patch cap (11.2s), not a sixty-second cap.
        for tokens,patches in ((10,70),(10,60),(100,384),(0,1),(1,0)):
            with self.subTest(tokens=tokens,patches=patches):
                with self.assertRaises(VoiceError):validate_generation_length(tokens,patches)

    def test_vox_caches_reference_once_and_never_returns_partial_audio_after_chunk_failure(self):
        profile=self.new_reference()
        engine=VoxEngine.__new__(VoxEngine)
        engine.references=self.pc
        engine.sample_rate=48000
        class Samples:
            size=4800
            def __len__(self):return 4800
        generated=Mock()
        generated.detach.return_value.float.return_value.cpu.return_value.numpy.return_value.reshape.return_value=Samples()
        tts=Mock()
        tts.generate_with_prompt_cache.side_effect=[(generated,SimpleNamespace(numel=lambda:5),SimpleNamespace(shape=(3,4,64))),RuntimeError('middle chunk failed')]
        engine.model=SimpleNamespace(tts_model=tts)
        fake_numpy=SimpleNamespace(isfinite=lambda pcm:SimpleNamespace(all=lambda:True))
        fake_torch=SimpleNamespace(manual_seed=lambda seed:None,inference_mode=nullcontext)
        before={p.name:p.read_bytes() for p in self.pc.directory.iterdir()}
        with patch.dict(sys.modules,{'numpy':fake_numpy,'torch':fake_torch}):
            with self.assertRaisesRegex(RuntimeError,'middle chunk failed'):
                engine.synthesize({'profileId':profile['id'],'text':'오늘은 긴 문장을 나누어 읽는 기능을 확인합니다. '*10,'speed':1})
        self.assertEqual(tts.build_prompt_cache.call_count,1)
        self.assertEqual(tts.generate_with_prompt_cache.call_count,2)
        self.assertEqual(tts.build_prompt_cache.call_args.kwargs['prompt_text'],profile['promptText']+' ')
        self.assertFalse(self.pc.lock.locked())
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.pc.directory.iterdir()})

    def vox_memory_fixture(self,free_mib):
        engine=VoxEngine.__new__(VoxEngine)
        engine.references=self.pc
        engine.device='cuda'
        engine.model_path=str(self.pc.directory.parent/'fake-vox-model')
        engine.model=object()
        cuda=Mock()
        cuda.mem_get_info.side_effect=[(free*1024**2,12288*1024**2) for free in free_mib]
        constructor=Mock(return_value=SimpleNamespace(tts_model=SimpleNamespace(sample_rate=48000)))
        return engine,SimpleNamespace(cuda=cuda),constructor

    def test_vox_asr_memory_keeps_loaded_model_when_enough_is_free(self):
        engine,torch,constructor=self.vox_memory_fixture([5000])
        original=engine.model
        with patch.dict(sys.modules,{'torch':torch,'voxcpm':SimpleNamespace(VoxCPM=constructor)}):
            result=engine.prepare_asr_memory(3584)
            self.assertFalse(result['modelUnloaded'])
            self.assertIs(engine._ensure_model(),original)
            constructor.assert_not_called()
        torch.cuda.empty_cache.assert_not_called()
        torch.cuda.synchronize.assert_not_called()
        self.assertFalse(self.pc.lock.locked())

    def test_vox_asr_memory_releases_unused_cache_before_unloading_a_model(self):
        engine,torch,constructor=self.vox_memory_fixture([2048,5000])
        original=engine.model
        with patch.dict(sys.modules,{'torch':torch,'voxcpm':SimpleNamespace(VoxCPM=constructor)}):
            result=engine.prepare_asr_memory(3584)
        self.assertFalse(result['modelUnloaded'])
        self.assertIs(engine.model,original)
        torch.cuda.empty_cache.assert_called_once_with()
        torch.cuda.synchronize.assert_not_called()
        constructor.assert_not_called()

    def test_vox_asr_memory_unloads_only_when_needed_and_reloads_lazily(self):
        engine,torch,constructor=self.vox_memory_fixture([1024,2048,6500])
        def collect():
            self.assertIsNone(engine.model)
            self.assertTrue(self.pc.lock.locked())
            return 0
        with patch.dict(sys.modules,{'torch':torch,'voxcpm':SimpleNamespace(VoxCPM=constructor)}), \
                patch('gc.collect',side_effect=collect) as garbage:
            result=engine.prepare_asr_memory(3584)
            self.assertTrue(result['modelUnloaded'])
            self.assertIsNone(engine.model)
            constructor.assert_not_called()
            torch.cuda.synchronize.assert_called_once_with('cuda')
            self.assertEqual(torch.cuda.empty_cache.call_count,2)
            garbage.assert_called_once_with()
            # 예약 해제가 아닌 다음 음성 요청의 모델 확인 시점에만 다시 만든다.
            reloaded=engine._ensure_model()
            self.assertIs(engine._ensure_model(),reloaded)
            self.assertIs(reloaded,constructor.return_value)
            constructor.assert_called_once()
            self.assertEqual(constructor.call_args.kwargs['voxcpm_model_path'],engine.model_path)
        self.assertFalse(self.pc.lock.locked())

    def test_vox_asr_memory_shortage_after_unload_does_not_reload_to_retry(self):
        engine,torch,constructor=self.vox_memory_fixture([512,1024,2048])
        with patch.dict(sys.modules,{'torch':torch,'voxcpm':SimpleNamespace(VoxCPM=constructor)}), \
                patch('gc.collect',return_value=0):
            with self.assertRaises(VoiceError) as caught:engine.prepare_asr_memory(3584)
            self.assertEqual(caught.exception.code,'ASR_GPU_MEMORY')
        self.assertIsNone(engine.model)
        constructor.assert_not_called()
        self.assertFalse(self.pc.lock.locked())

    def test_pc_installer_does_not_publish_settings_before_resources_succeed(self):
        import setup_pc_voice as setup
        previous=self.pc.directory.parent/'old-settings.json'
        previous.write_text('existing working installation',encoding='utf-8')
        engine=self.pc.directory.parent/'new-engine'
        def install(command,**kwargs):
            if any(str(part).endswith('prepare_pc_voice_resources.py') for part in command):
                raise subprocess.CalledProcessError(1,command)
        with patch.object(sys,'argv',['setup_pc_voice.py','--yes','--engine-dir',str(engine)]), \
             patch.object(setup,'prepare_source',return_value=engine/'source'), \
             patch.object(setup,'prepare_models'), patch.object(setup,'prepare_uv',return_value=engine/'uv.exe'), \
             patch.object(setup.subprocess,'check_output',return_value=sys.executable), \
             patch.object(setup.subprocess,'run',side_effect=install), patch.object(setup,'write_config') as publish:
            with self.assertRaises(subprocess.CalledProcessError):setup.main()
            publish.assert_not_called()
        self.assertEqual(previous.read_text(),'existing working installation')

    def test_pc_engine_process_blocks_external_resolution_and_allows_loopback(self):
        code="""
import socket
from pc_voice_engine import restrict_engine_network
restrict_engine_network()
for operation in (lambda: socket.getaddrinfo('example.invalid',443), lambda: socket.gethostbyname('example.invalid')):
    try: operation()
    except OSError: pass
    else: raise AssertionError('External resolution was allowed')
with socket.socket() as server:
    try: server.bind(('0.0.0.0',0))
    except OSError: pass
    else: raise AssertionError('Public bind was allowed')
    server.bind(('127.0.0.1',0)); server.listen(1)
    with socket.create_connection(server.getsockname(),timeout=2) as client:
        peer,_=server.accept()
        with peer:
            client.sendall(b'local'); assert peer.recv(5)==b'local'
"""
        result=subprocess.run([sys.executable,'-c',code],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)

    @unittest.skipUnless(os.name=='nt','Windows process job lifecycle')
    def test_pc_launcher_exit_reaps_its_children_without_targeting_other_processes(self):
        code="""
import os, subprocess, sys
from start_pc_voice import own_windows_process_tree
job=own_windows_process_tree()
grandchild_code="import subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(10)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW); print(child.pid,flush=True); time.sleep(10)"
child=subprocess.Popen([sys.executable,'-c',grandchild_code],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
grandchild_pid=child.stdout.readline().strip()
print(child.pid,grandchild_pid,flush=True)
os._exit(0)
"""
        result=subprocess.run([sys.executable,'-c',code],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        import ctypes
        from ctypes import wintypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];kernel.WaitForSingleObject.restype=wintypes.DWORD
        kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        children=[int(value) for value in result.stdout.split()]
        self.assertEqual(len(children),2)
        for child in children:
            handle=kernel.OpenProcess(0x00100000,False,child)
            if handle:
                try:self.assertEqual(kernel.WaitForSingleObject(handle,3000),0,'Owned descendant survived launcher exit')
                finally:kernel.CloseHandle(handle)
            else:self.assertEqual(ctypes.get_last_error(),87,'Could not verify owned descendant termination')

    def test_pc_reference_rejects_bad_wav_silence_duration_and_truncation(self):
        valid=self.pcm_wave()
        for content in (b'not audio',valid[:-2],self.pcm_wave(2.99),self.pcm_wave(10.01),self.pcm_wave(silent=True)):
            with self.subTest(length=len(content)):
                with self.assertRaises(VoiceError):wav_info(content,reference=True)
        self.assertEqual(wav_info(self.pcm_wave(3),reference=True)['duration'],3)
        self.assertEqual(wav_info(self.pcm_wave(10),reference=True)['duration'],10)
        for data in ({'consent':False},{'consent':True,'name':'x','promptText':'x','audio':'!!!'},
                     {'consent':True,'name':'x','promptText':'','audio':base64.b64encode(valid).decode()}):
            with self.assertRaises(VoiceError):self.pc.register(data)
        self.assertEqual(self.pc_request('references',{'audio':'x'*MAX_REFERENCE_BODY})[0],413)
        self.assertEqual(self.pc_request('references',{},headers={'Content-Type':'text/plain'})[0],415)
        self.assertFalse(self.pc.directory.exists())

    def test_pc_synthesis_uses_owned_path_and_actual_wave_metadata(self):
        profile=self.new_reference();result=self.pcm_wave(1.5,48000)
        self.pc_call.return_value.__enter__.return_value.read.return_value=result
        status,body,headers=self.pc_request('synthesize',{'profileId':profile['id'],'text':'새로운 원고','speed':1.1,
                              'ref_audio_path':'C:/private.txt','endpoint':'https://evil.test','consent':True})
        self.assertEqual(status,200)
        self.assertEqual(body,result)
        self.assertEqual(headers['X-Studio-Audio-Rate'],'48000')
        self.assertEqual(float(headers['X-Studio-Audio-Duration']),1.5)
        request=self.pc_call.call_args.args[0];data=json.loads(request.data)
        self.assertEqual(request.full_url,'http://127.0.0.1:9880/tts')
        self.assertEqual(data['text_lang'],'ko')
        self.assertEqual(data['prompt_text'],profile['promptText'])
        self.assertEqual(Path(data['ref_audio_path']),self.pc.directory/(profile['id']+'.wav'))
        self.assertFalse(data['streaming_mode'])
        self.assertNotIn('endpoint',data)
        self.call.assert_not_called()

    def test_pc_validation_rejects_arbitrary_profile_paths_and_nonfinite_speed(self):
        profile=self.new_reference()
        for profile_id in ('../outside','/tmp/file','C:\\private','a'*31,'a'*33,None):
            with self.subTest(profile_id=profile_id):
                with self.assertRaises(VoiceError):self.pc.delete(profile_id)
        for changes in ({'text':''},{'text':'x'*2001},{'speed':True},{'speed':float('nan')},{'speed':float('inf')},
                        {'speed':0},{'profileId':'../outside'},{'consent':False}):
            with self.subTest(changes=list(changes)):
                with self.assertRaises(VoiceError):self.pc.synthesize({'profileId':profile['id'],'text':'원고','consent':True,**changes})
        self.pc_call.assert_not_called()

    def test_pc_model_work_keeps_lock_until_response_finishes(self):
        profile=self.new_reference();entered=threading.Event();release=threading.Event();errors=[]
        def read(maximum):
            entered.set()
            if not release.wait(4):raise TimeoutError()
            return self.pcm_wave(1)
        self.pc_call.return_value.__enter__.return_value.read.side_effect=read
        def generate():
            try:self.pc.synthesize({'profileId':profile['id'],'text':'원고','consent':True})
            except Exception as error:errors.append(error)
        thread=threading.Thread(target=generate);thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.pc.status()['state'],'busy')
            for operation in (lambda:self.pc.delete(profile['id']),lambda:self.pc.synthesize({'profileId':profile['id'],'text':'새 원고','consent':True})):
                with self.assertRaises(VoiceError) as caught:operation()
                self.assertEqual(caught.exception.code,'VOICE_BUSY')
            self.assertEqual(self.pc_call.call_count,1)
        finally:release.set();thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors,[])
        self.pc.delete(profile['id'])

    def test_pc_uncertain_timeout_blocks_retry_and_invalid_audio_is_not_returned(self):
        profile=self.new_reference();payload={'profileId':profile['id'],'text':'원고','consent':True}
        self.pc_call.return_value.__enter__.return_value.read.return_value=b'not a wav'
        self.assertEqual(self.pc_request('synthesize',payload)[0],502)
        self.pc_call.side_effect=TimeoutError()
        status,body,_=self.pc_request('synthesize',payload)
        self.assertEqual(status,503)
        self.assertEqual(json.loads(body)['error']['code'],'ENGINE_RESTART_REQUIRED')
        self.pc_call.reset_mock()
        self.assertEqual(self.pc.status()['state'],'restart-required')
        self.assertEqual(self.pc_request('synthesize',payload)[0],503)
        self.pc_call.assert_not_called()

    def test_pc_http_errors_do_not_expose_internal_paths_or_prompt(self):
        profile=self.new_reference()
        self.pc_call.side_effect=HTTPError('http://127.0.0.1:9880/tts',500,'C:/private/secret prompt',{},io.BytesIO(b'secret model path'))
        status,body,_=self.pc_request('synthesize',{'profileId':profile['id'],'text':'원고','consent':True})
        self.assertEqual(status,502)
        self.assertNotIn(b'secret',body)
        self.assertNotIn(b'C:/',body)
        self.assertNotIn(str(self.pc.directory).encode(),body)

    def test_pc_opener_ignores_proxy_and_does_not_follow_redirects(self):
        seen=[];redirect=[False];audio=self.pcm_wave(1);key='isolated_test_engine_'+'x'*32
        class Upstream(studio.SimpleHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(inner):
                seen.append((inner.path,inner.headers.get('X-Studio-Engine-Key')))
                proof=engine_proof(key,inner.headers['X-Studio-Engine-Nonce'])
                body=json.dumps({'service':'shorts-studio-pc-voice','protocol':1,'proof':proof}).encode()
                inner.send_response(200);inner.send_header('Content-Type','application/json');inner.end_headers();inner.wfile.write(body)
            def do_POST(inner):
                seen.append((inner.path,inner.headers.get('X-Studio-Engine-Key')));inner.rfile.read(int(inner.headers.get('Content-Length','0')))
                if redirect[0]:
                    inner.send_response(307);inner.send_header('Location','http://127.0.0.1:'+str(inner.server.server_port)+'/leak');inner.end_headers()
                else:
                    inner.send_response(200);inner.send_header('Content-Type','audio/wav');inner.end_headers();inner.wfile.write(audio)
        upstream=studio.ThreadingHTTPServer(('127.0.0.1',0),Upstream)
        worker=threading.Thread(target=upstream.serve_forever,daemon=True);worker.start()
        try:
            service=VoiceCloneService(self.pc.directory,port=upstream.server_port,engine_key=key)
            profile=self.new_reference();payload={'profileId':profile['id'],'text':'원고','consent':True}
            with patch.dict(os.environ,{'HTTP_PROXY':'http://127.0.0.1:1','HTTPS_PROXY':'http://127.0.0.1:1','NO_PROXY':''}):
                result,_=service.synthesize(payload)
            self.assertEqual(result,audio)
            redirect[0]=True
            with self.assertRaises(VoiceError):service.synthesize(payload)
            self.assertEqual(seen,[('/studio/health',None),('/tts',key),('/studio/health',None),('/tts',key)])
        finally:upstream.shutdown();upstream.server_close();worker.join()

if __name__=='__main__':unittest.main()
