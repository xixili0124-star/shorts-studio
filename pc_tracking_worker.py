"""선택한 영상 영역을 실제 SAM 2.1 Small로 추적하는 격리 작업 프로세스."""

import argparse
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys


MODEL_ID = 'facebook/sam2.1-hiera-small'
MODEL_NAME = 'sam2.1-hiera-small'
MODEL_REV = 'ee5bba1d82bb8749febdf90f45e84b687142ba03'
SOURCE_REV = '2b90b9f5ceec907a1c18123530e92e794ad901a4'
MODEL_FILE = 'sam2.1_hiera_small.pt'
MODEL_FILES = {MODEL_FILE: (184416285, '6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38')}
MODEL_MARKER = 'studio-model-ready.json'
MODEL_CONFIG = 'configs/sam2.1/sam2.1_hiera_s.yaml'
TORCH_VERSION = '2.5.1+cu124'
TORCHVISION_VERSION = '0.20.1+cu124'
SAM_PACKAGE_VERSION = '1.0'
MAX_VIDEO_BYTES = 256 * 1024 * 1024
MAX_DURATION = 180
SAMPLE_FPS = 15
MAX_FRAMES = MAX_DURATION * SAMPLE_FPS + 4
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_FRAMES_BYTES = 1024 * 1024 * 1024
MAX_IMAGE_EDGE = 1024
MAX_SOURCE_PIXELS = 8192 * 4096
MAX_REQUEST_BYTES = 8192
KEEP_STATE_FRAMES = 64


class TrackingError(ValueError):
    """입력 영상이나 개인 경로가 포함되지 않는 공개 오류."""

    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def finite_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise TrackingError('TRACKING_INVALID_REQUEST', '추적 영역과 시간을 다시 지정해 주세요.')
    return float(value)


def validate_options(value):
    """시각은 원본 시작초와 잘라낸 구간 안의 시드초로 명확히 구분한다."""
    if not isinstance(value, dict):
        raise TrackingError('TRACKING_INVALID_REQUEST', '추적 영역과 시간을 다시 지정해 주세요.')
    start = finite_number(value.get('start', 0))
    duration = finite_number(value.get('duration'))
    seed = finite_number(value.get('seedTime'))
    box = value.get('box')
    if not 0 <= start <= 86400 or not 0 < duration <= MAX_DURATION or not 0 <= seed <= duration:
        raise TrackingError('TRACKING_DURATION_LIMIT', '추적은 한 번에 3분까지 가능합니다.', 413)
    if not isinstance(box, dict):
        raise TrackingError('TRACKING_INVALID_REQUEST', '영상에서 추적할 영역을 지정해 주세요.')
    x, y, width, height = (finite_number(box.get(key)) for key in ('x', 'y', 'w', 'h'))
    if not (0 <= x < 1 and 0 <= y < 1 and .001 <= width <= 1 and .001 <= height <= 1
            and x + width <= 1 + 1e-8 and y + height <= 1 + 1e-8):
        raise TrackingError('TRACKING_INVALID_REQUEST', '추적 영역은 원본 영상 안에 있어야 합니다.')
    return {'start': start, 'duration': duration, 'seedTime': seed,
            'box': {'x': x, 'y': y, 'w': min(width, 1 - x), 'h': min(height, 1 - y)}}


def container_format(header):
    """재생목록·원격 URL·외부 파일 참조를 입력으로 받지 않는다."""
    if not isinstance(header, bytes):
        raise TrackingError('TRACKING_INVALID_VIDEO', 'MP4/MOV 또는 WebM 영상이 필요합니다.')
    if len(header) >= 12 and header[4:8] == b'ftyp':
        return 'mov'
    if header[:4] == b'\x1aE\xdf\xa3':
        return 'matroska'
    raise TrackingError('TRACKING_INVALID_VIDEO', 'MP4/MOV 또는 WebM 영상만 PC 추적에 사용할 수 있습니다.')


def validate_video(content):
    if not isinstance(content, bytes) or not 12 <= len(content) <= MAX_VIDEO_BYTES:
        raise TrackingError('TRACKING_VIDEO_LIMIT', 'PC 추적 영상은 256MB 이하로 준비해 주세요.', 413)
    return container_format(content[:64])


def offline_environment(base=None):
    env = dict(os.environ if base is None else base)
    env.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                'HF_DATASETS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1',
                'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1', 'DO_NOT_TRACK': '1',
                'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                'PYTHONUTF8': '1', 'TOKENIZERS_PARALLELISM': 'false',
                'OMP_NUM_THREADS': '4', 'TORCH_FORCE_WEIGHTS_ONLY_LOAD': '1'})
    for key in ('PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV'):
        env.pop(key, None)
    return env


def configure_offline():
    """다운로드 API를 사용하지 않으며 Python의 실제 외부 통신도 거부한다."""
    import logging
    os.environ.update(offline_environment())
    logging.disable(logging.CRITICAL)

    def deny_network(event, args):
        if event in ('socket.connect', 'socket.bind', 'socket.getaddrinfo',
                     'socket.gethostbyname', 'socket.gethostbyaddr', 'socket.sendto', 'socket.sendmsg'):
            raise OSError('Network access is disabled during PC tracking.')

    sys.addaudithook(deny_network)


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def validate_model_directory(model, revision=MODEL_REV):
    """공식 체크포인트를 해시까지 검사한 뒤 weights_only 로더로만 연다."""
    bad = TrackingError('TRACKING_MODEL_NOT_READY', 'PC 추적 모델 설치 또는 검증이 필요합니다.', 503)
    path = Path(model)
    try:
        if revision != MODEL_REV or not path.is_absolute() or path.is_symlink() or not path.is_dir():
            raise bad
        path = path.resolve()
        marker_path = path / MODEL_MARKER
        if marker_path.is_symlink() or marker_path.stat().st_size > 16384:
            raise bad
        marker = json.loads(marker_path.read_text(encoding='utf-8'))
        if (not isinstance(marker, dict) or marker.get('provider') != 'sam2'
                or marker.get('modelName') != MODEL_NAME or marker.get('modelRevision') != revision
                or marker.get('sourceRevision') != SOURCE_REV):
            raise bad
        for name, (size, digest) in MODEL_FILES.items():
            item = path / name
            if (item.is_symlink() or item.resolve().parent != path or not item.is_file()
                    or item.stat().st_size != size
                    or marker.get('files', {}).get(name) != {'size': size, 'sha256': digest}
                    or file_sha256(item) != digest):
                raise bad
    except (OSError, ValueError, TypeError, AttributeError):
        raise bad from None
    return path


@dataclass(frozen=True)
class VideoFrames:
    paths: tuple
    times: tuple
    width: int
    height: int
    seed_index: int


def sample_schedule(duration, seed_time, fps=SAMPLE_FPS):
    """등간격 샘플 외에 사용자가 본 시드 시각도 별도로 포함한다."""
    times = [index / fps for index in range(max(1, math.ceil(duration * fps)))]
    if seed_time < duration:
        times.append(seed_time)
    return sorted(set(times))


def nearest_seed_index(times, seed_time):
    if not times:
        raise TrackingError('TRACKING_INVALID_VIDEO', '영상 프레임을 찾지 못했습니다.')
    return min(range(len(times)), key=lambda index: abs(times[index] - seed_time))


def extract_frames(video, directory, options, progress=None):
    """오디오를 읽지 않고 실제 PTS를 가진 제한된 프레임만 임시 JPEG로 보관한다."""
    import av
    from PIL import Image
    source = Path(video)
    folder = Path(directory)
    options = validate_options(options)
    if (not source.is_absolute() or source.is_symlink() or not source.is_file()
            or not 12 <= source.stat().st_size <= MAX_VIDEO_BYTES or not folder.is_dir()):
        raise TrackingError('TRACKING_INVALID_VIDEO', '분석할 임시 영상을 확인하지 못했습니다.')
    target_times = sample_schedule(options['duration'], options['seedTime'])
    paths, times = [], []
    next_target, total_bytes = 0, 0
    width = height = 0
    latest_time = None
    previous_time = None
    with source.open('rb') as stream:
        format_name = container_format(stream.read(64))
        stream.seek(0)
        # 강제 컨테이너와 프로토콜 제한은 FFmpeg의 외부 URL·파일 열기도 막는다.
        with av.open(stream, mode='r', format=format_name,
                     options={'protocol_whitelist': 'pipe', 'enable_drefs': '0', 'use_absolute_path': '0'}) as container:
            if not container.streams.video:
                raise TrackingError('TRACKING_INVALID_VIDEO', '영상 트랙이 없는 파일입니다.')
            track = container.streams.video[0]
            track.thread_type = 'SLICE'
            track.codec_context.thread_count = 2
            if not 0 < track.width * track.height <= MAX_SOURCE_PIXELS:
                raise TrackingError('TRACKING_VIDEO_LIMIT', '원본 영상 해상도가 PC 추적 범위를 넘습니다.', 413)
            origin = float((track.start_time or 0) * track.time_base)
            seek_seconds = max(0, options['start'] - 1)
            if seek_seconds:
                container.seek(int((origin + seek_seconds) / track.time_base),
                               stream=track, backward=True, any_frame=False)
            for decoded_count, frame in enumerate(container.decode(track)):
                if decoded_count > 120 * (MAX_DURATION + 20):
                    raise TrackingError('TRACKING_VIDEO_LIMIT', '원본 프레임 수가 너무 많습니다. 짧은 MP4로 변환해 주세요.', 413)
                if frame.pts is None or frame.time_base is None:
                    raise TrackingError('TRACKING_INVALID_VIDEO', '영상에 정확한 프레임 시각이 없습니다.')
                local_time = float(frame.pts * frame.time_base) - origin - options['start']
                if not math.isfinite(local_time) or previous_time is not None and local_time < previous_time - 1e-6:
                    raise TrackingError('TRACKING_INVALID_VIDEO', '영상 프레임 시각의 순서를 확인하지 못했습니다.')
                previous_time = local_time
                latest_time = local_time
                if local_time >= options['duration']:
                    break
                if local_time < -1e-6 or next_target >= len(target_times) or local_time + 1e-6 < target_times[next_target]:
                    continue
                if not 0 < frame.width * frame.height <= MAX_SOURCE_PIXELS:
                    raise TrackingError('TRACKING_VIDEO_LIMIT', '영상 프레임 해상도가 너무 큽니다.', 413)
                image = frame.to_image().convert('RGB')
                # PyAV가 제공하는 표시 회전을 적용해 브라우저의 세로 영상과 좌표를 맞춘다.
                rotation = float(getattr(frame, 'rotation', 0) or 0)
                if not rotation:
                    try:
                        rotation = float(track.metadata.get('rotate', 0))
                    except (ValueError, TypeError):
                        raise TrackingError('TRACKING_INVALID_VIDEO', '영상 회전 정보를 확인하지 못했습니다.') from None
                if not math.isfinite(rotation) or abs(rotation / 90 - round(rotation / 90)) > .001:
                    raise TrackingError('TRACKING_INVALID_VIDEO', '이 영상은 회전을 적용한 MP4로 변환한 뒤 추적해 주세요.')
                if rotation % 360:
                    image = image.rotate(rotation, expand=True)
                image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
                if paths and image.size != (width, height):
                    raise TrackingError('TRACKING_INVALID_VIDEO', '도중에 해상도가 바뀌는 영상은 지원하지 않습니다.')
                width, height = image.size
                path = folder / f'{len(paths):06d}.jpg'
                image.save(path, format='JPEG', quality=94, subsampling=0)
                size = path.stat().st_size
                total_bytes += size
                if size > MAX_FRAME_BYTES or total_bytes > MAX_FRAMES_BYTES or len(paths) >= MAX_FRAMES:
                    raise TrackingError('TRACKING_VIDEO_LIMIT', '분석용 프레임이 너무 큽니다. 구간을 나눠 주세요.', 413)
                paths.append(path)
                times.append(max(0.0, local_time))
                while next_target < len(target_times) and target_times[next_target] <= local_time + 1e-6:
                    next_target += 1
                if progress:
                    progress(.02 + .18 * min(1, local_time / options['duration']), 'decoding')
            # 끝 프레임의 표시 시간만큼은 허용하되 실제보다 긴 구간을 만들어내지 않는다.
            rate = float(track.average_rate) if track.average_rate else 30.0
            frame_tail = min(.5, 1 / max(1, rate))
            if latest_time is None or latest_time + frame_tail + .05 < options['duration']:
                raise TrackingError('TRACKING_INVALID_VIDEO', '선택한 구간 끝까지 영상 프레임을 읽지 못했습니다.')
    if not paths:
        raise TrackingError('TRACKING_INVALID_VIDEO', '선택한 구간의 영상 프레임을 찾지 못했습니다.')
    return VideoFrames(tuple(paths), tuple(times), width, height,
                       nearest_seed_index(times, options['seedTime']))


class CpuFrameStore:
    """SAM의 입력 정규화를 유지하며 영상 전체 대신 최근 두 프레임만 RAM에 둔다."""

    def __init__(self, frames, image_size, torch_module, capacity=2):
        self.frames, self.image_size, self.torch = frames, image_size, torch_module
        self.capacity, self.cache = capacity, OrderedDict()

    def __len__(self):
        return len(self.frames.paths)

    def __getitem__(self, index):
        import numpy as np
        from PIL import Image
        if not isinstance(index, int) or not 0 <= index < len(self):
            raise IndexError(index)
        if index in self.cache:
            self.cache.move_to_end(index)
            return self.cache[index]
        with Image.open(self.frames.paths[index]) as image:
            # upstream _load_img_as_tensor와 같은 PIL resize·RGB·평균/표준편차를 사용한다.
            pixels = np.array(image.convert('RGB').resize((self.image_size, self.image_size)), dtype=np.float32)
        pixels /= 255.0
        pixels -= np.array([.485, .456, .406], dtype=np.float32)
        pixels /= np.array([.229, .224, .225], dtype=np.float32)
        tensor = self.torch.from_numpy(pixels).permute(2, 0, 1)
        self.cache[index] = tensor
        while len(self.cache) > self.capacity:
            self.cache.popitem(last=False)
        return tensor


@contextmanager
def bounded_load_frames(predictor_module, frames, torch_module):
    """이 작업 프로세스에서만 upstream의 전체 프레임 선적재를 제한한다."""
    original = predictor_module.load_video_frames

    def load(video_path, image_size, offload_video_to_cpu, **kwargs):
        if offload_video_to_cpu is not True:
            raise TrackingError('TRACKING_RUNTIME_NOT_READY', 'CPU 프레임 보관 설정을 확인해 주세요.', 503)
        return CpuFrameStore(frames, image_size, torch_module), frames.height, frames.width

    predictor_module.load_video_frames = load
    try:
        yield
    finally:
        predictor_module.load_video_frames = original


def prune_state(state, frame_index, keep=KEEP_STATE_FRAMES):
    """시드 마스크와 모델이 참조하는 최근 메모리는 남기고 오래된 출력만 비운다."""
    for outputs in state['output_dict_per_obj'].values():
        values = outputs['non_cond_frame_outputs']
        for index in list(values):
            if abs(frame_index - index) > keep:
                del values[index]
    for values in state['frames_tracked_per_obj'].values():
        for index in list(values):
            if abs(frame_index - index) > keep:
                del values[index]


def presence_probability(logit):
    value = finite_number(logit)
    return 1.0 / (1.0 + math.exp(-max(-80.0, min(80.0, value))))


def mask_box(mask):
    """실제 SAM 마스크의 경계를 정규화한다. 빈 마스크를 가상 위치로 대체하지 않는다."""
    import numpy as np
    array = np.asarray(mask)
    if array.ndim != 2 or not array.size or array.shape[0] > MAX_IMAGE_EDGE or array.shape[1] > MAX_IMAGE_EDGE:
        raise TrackingError('TRACKING_INVALID_RESULT', '추적 마스크의 크기를 확인하지 못했습니다.', 502)
    ys, xs = np.nonzero(array)
    if len(xs) < 8:
        return None
    height, width = array.shape
    left, top = int(xs.min()), int(ys.min())
    right, bottom = int(xs.max()) + 1, int(ys.max()) + 1
    return {'x': left / width, 'y': top / height,
            'w': (right - left) / width, 'h': (bottom - top) / height}


def point_from_mask(mask, logit, timestamp, last_box):
    probability = presence_probability(logit)
    box = mask_box(mask)
    lost = box is None or probability < .5
    # 마지막 상자는 미리보기 위치일 뿐이며 lost=True 구간의 성공 판정에는 쓰지 않는다.
    return {'t': timestamp, **(last_box if lost else box),
            'lost': lost, 'confidence': probability if box is not None else 0.0}


def state_presence(state, frame_index):
    outputs = state['output_dict_per_obj'][0]
    output = outputs['cond_frame_outputs'].get(frame_index)
    if output is None:
        output = outputs['non_cond_frame_outputs'].get(frame_index)
    if output is None or 'object_score_logits' not in output:
        raise TrackingError('TRACKING_INVALID_RESULT', '모델의 대상 존재 점수를 확인하지 못했습니다.', 502)
    return float(output['object_score_logits'].detach().float().item())


def track_video(video, frames_directory, model, options, revision=MODEL_REV, progress=None):
    options = validate_options(options)
    model_path = validate_model_directory(model, revision)
    import torch
    import sam2.sam2_video_predictor as predictor_module
    from sam2.build_sam import build_sam2_video_predictor

    if (torch.__version__ != TORCH_VERSION
            or importlib.metadata.version('torchvision') != TORCHVISION_VERSION
            or importlib.metadata.version('SAM-2') != SAM_PACKAGE_VERSION):
        raise TrackingError('TRACKING_RUNTIME_NOT_READY', '고정된 PC 추적 실행 환경이 필요합니다.', 503)
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise TrackingError('TRACKING_GPU_UNAVAILABLE', 'BF16을 지원하는 NVIDIA GPU가 필요합니다.', 503)
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    frames = extract_frames(video, frames_directory, options, progress)
    if progress:
        progress(.2, 'loading')
    predictor = build_sam2_video_predictor(
        MODEL_CONFIG, str(model_path / MODEL_FILE), device='cuda',
        apply_postprocessing=False, vos_optimized=False,
        hydra_overrides_extra=[
            '++model.sam_mask_decoder_extra_args.dynamic_multimask_via_stability=true',
            '++model.sam_mask_decoder_extra_args.dynamic_multimask_stability_delta=0.05',
            '++model.sam_mask_decoder_extra_args.dynamic_multimask_stability_thresh=0.98',
            '++model.binarize_mask_from_pts_for_mem_enc=true',
            '++model.fill_hole_area=0',
            '++model.compile_image_encoder=false',
        ])
    # 공식 기본값보다 넉넉하게 최근 상태를 유지하되 전 영상 길이만큼 누적하지 않는다.
    history = max(KEEP_STATE_FRAMES,
                  int(predictor.num_maskmem) * int(predictor.memory_temporal_stride_for_eval) + 2,
                  int(predictor.max_obj_ptrs_in_encoder) + 2)
    if history > 128:
        raise TrackingError('TRACKING_RUNTIME_NOT_READY', '추적 상태 보관 설정이 예상 범위를 넘었습니다.', 503)
    box = options['box']
    pixel_box = [box['x'] * frames.width, box['y'] * frames.height,
                 (box['x'] + box['w']) * frames.width, (box['y'] + box['h']) * frames.height]
    points = {}
    processed = 0
    total = len(frames.times) + (1 if frames.seed_index else 0)
    with torch.inference_mode(), torch.autocast(device_type='cuda', dtype=torch.bfloat16):
        with bounded_load_frames(predictor_module, frames, torch):
            for reverse in (False, True):
                if reverse and frames.seed_index == 0:
                    continue
                state = predictor.init_state(str(frames_directory), offload_video_to_cpu=True,
                                             offload_state_to_cpu=True, async_loading_frames=False)
                predictor.add_new_points_or_box(state, frame_idx=frames.seed_index,
                                                obj_id=1, box=pixel_box)
                last_box = dict(box)
                for index, object_ids, logits in predictor.propagate_in_video(
                        state, start_frame_idx=frames.seed_index, reverse=reverse):
                    if object_ids != [1] or not 0 <= index < len(frames.times):
                        raise TrackingError('TRACKING_INVALID_RESULT', '추적 결과의 대상이나 시각이 맞지 않습니다.', 502)
                    mask = (logits[0, 0] > 0).detach().cpu().numpy()
                    point = point_from_mask(mask, state_presence(state, index), frames.times[index], last_box)
                    if not point['lost']:
                        last_box = {key: point[key] for key in ('x', 'y', 'w', 'h')}
                    if index not in points:
                        points[index] = point
                    processed += 1
                    prune_state(state, index, history)
                    if progress:
                        progress(min(.98, .25 + .73 * processed / max(1, total)), 'tracking')
                    del mask, logits
                predictor.reset_state(state)
                del state
    ordered = [points[index] for index in range(len(frames.times))]
    if all(point['lost'] for point in ordered):
        raise TrackingError('TRACKING_TARGET_NOT_FOUND', '지정한 대상을 찾지 못했습니다. 더 선명한 프레임에서 다시 지정해 주세요.')
    warnings = ['대상 존재 점수는 동일 인물임을 보장하는 확률이 아닙니다. 결과를 직접 확인해 주세요.']
    if any(point['lost'] for point in ordered):
        warnings.append('가림·화면 이탈 등으로 대상을 놓친 구간이 있습니다. 재지정 또는 수동 보정이 필요합니다.')
    return {'model': MODEL_NAME, 'modelRevision': MODEL_REV, 'sourceRevision': SOURCE_REV,
            'device': 'cuda', 'computeType': 'bfloat16', 'duration': options['duration'],
            'seedTime': options['seedTime'], 'sampledSeedTime': frames.times[frames.seed_index],
            'sampleFps': SAMPLE_FPS, 'confidenceKind': 'sam-object-presence',
            'points': ordered, 'warnings': warnings}


def emit(stream, value):
    stream.write((json.dumps(value, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8'))
    stream.flush()


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise TrackingError('TRACKING_INVALID_REQUEST', 'PC 추적 실행 옵션을 확인해 주세요.')


def main(argv=None, stdin=None, stdout=None):
    output = stdout if stdout is not None else sys.stdout.buffer
    source = stdin if stdin is not None else sys.stdin.buffer
    try:
        parser = _ArgumentParser(add_help=False)
        parser.add_argument('--model', required=True)
        parser.add_argument('--revision', required=True)
        parser.add_argument('--video', required=True)
        parser.add_argument('--work-dir', required=True)
        parser.add_argument('--job-name')
        args = parser.parse_args(argv)
        if args.job_name is not None:
            from pc_asr_process import WindowsJob
            try:
                WindowsJob.join_current(args.job_name)
            except (OSError, ValueError):
                raise TrackingError('TRACKING_ISOLATION_FAILED', '추적 작업의 안전한 종료 환경을 준비하지 못했습니다.', 503) from None
        configure_offline()
        raw = source.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise TrackingError('TRACKING_INVALID_REQUEST', '추적 설정이 너무 큽니다.')
        options = validate_options(json.loads(raw))
        working = Path(args.work_dir)
        video = Path(args.video)
        if (not working.is_absolute() or working.is_symlink() or not working.is_dir()
                or video.is_symlink() or video.resolve().parent != working.resolve()):
            raise TrackingError('TRACKING_INVALID_REQUEST', '추적 임시 작업 공간을 확인하지 못했습니다.')
        frames = working / 'frames'
        frames.mkdir(exist_ok=False)
        progress = lambda amount, phase: emit(output, {'type': 'progress', 'progress': amount, 'phase': phase})
        result = track_video(video, frames, args.model, options, args.revision, progress)
        emit(output, {'type': 'result', 'result': result})
        return 0
    except TrackingError as error:
        payload = {'code': error.code, 'message': error.message}
    except (ImportError, ModuleNotFoundError):
        payload = {'code': 'TRACKING_RUNTIME_NOT_READY', 'message': 'PC 추적 전용 실행 환경을 다시 설치해 주세요.'}
    except Exception as error:
        # 경로·미디어 정보가 들어갈 수 있는 원본 예외는 외부로 출력하지 않는다.
        memory = 'out of memory' in str(error).lower()
        payload = {'code': 'TRACKING_GPU_MEMORY' if memory else 'TRACKING_ENGINE_FAILED',
                   'message': 'GPU 메모리가 부족합니다. 다른 GPU 작업을 끝내 주세요.' if memory
                   else 'PC 추적을 완료하지 못했습니다. 설치 상태와 영상 형식을 확인해 주세요.'}
    emit(output, {'type': 'error', 'error': payload})
    return 1


if __name__ == '__main__':
    # 외부 라이브러리의 출력은 버리고 NDJSON 전용 파이프만 별도로 유지한다.
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb') as output, open(os.devnull, 'w') as sink:
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(sink.fileno(), sys.stdout.fileno())
        os.dup2(sink.fileno(), sys.stderr.fileno())
        sys.stdout = sink
        sys.stderr = sink
        sys.exit(main(stdout=output))
