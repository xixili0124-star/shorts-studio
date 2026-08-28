"""사용자 영상·GPU·모델 다운로드 없이 PC 추적의 입력과 수명 관리를 검사한다."""

from contextlib import contextmanager, nullcontext
import copy
import hashlib
import io
import json
from pathlib import Path
import queue
import tempfile
import threading
import unittest
from types import SimpleNamespace, ModuleType
from unittest.mock import Mock, patch
import zipfile
import sys

import numpy as np
from PIL import Image
import pc_tracking as service
import pc_tracking_worker as worker
import setup_pc_tracking as setup


OPTIONS = {'start': 10, 'duration': 2, 'seedTime': 1,
           'box': {'x': .2, 'y': .1, 'w': .3, 'h': .5}}


def result_fixture():
    return {'model': worker.MODEL_NAME, 'modelRevision': worker.MODEL_REV,
            'sourceRevision': worker.SOURCE_REV, 'device': 'cuda', 'computeType': 'bfloat16',
            'duration': 2, 'seedTime': 1, 'sampledSeedTime': 1,
            'confidenceKind': 'sam-object-presence',
            'points': [{'t': t, 'x': .2, 'y': .1, 'w': .3, 'h': .5,
                        'lost': False, 'confidence': .9} for t in (0, .5, 1, 1.5)]}


class TrackingInputTests(unittest.TestCase):
    def test_trim_start_is_not_added_to_local_seed(self):
        result = worker.validate_options(OPTIONS)
        self.assertEqual((result['start'], result['seedTime']), (10, 1))

    def test_invalid_times_and_boxes_are_rejected(self):
        for key, value in [('duration', 181), ('duration', 0), ('seedTime', 3),
                           ('start', -1), ('start', True), ('duration', float('nan'))]:
            with self.subTest(key=key, value=value), self.assertRaises(worker.TrackingError):
                worker.validate_options({**OPTIONS, key: value})
        for box in ({'x': .9, 'y': 0, 'w': .2, 'h': .2},
                    {'x': 0, 'y': 0, 'w': 0, 'h': .2}):
            with self.assertRaises(worker.TrackingError):
                worker.validate_options({**OPTIONS, 'box': box})

    def test_only_supported_binary_containers_are_accepted(self):
        self.assertEqual(worker.validate_video(b'\0\0\0\x18ftypisom0000'), 'mov')
        self.assertEqual(worker.validate_video(b'\x1aE\xdf\xa3' + b'0' * 16), 'matroska')
        for content in (b'https://example.invalid/a.mp4', b'#EXTM3U\nhttp://x', b'RIFF0000WAVE'):
            with self.assertRaises(worker.TrackingError):
                worker.validate_video(content)

    def test_schedule_includes_seed_and_is_bounded(self):
        times = worker.sample_schedule(180, 10.123)
        self.assertIn(10.123, times)
        self.assertLess(len(times), worker.MAX_FRAMES)
        self.assertEqual(times, sorted(set(times)))
        self.assertLess(times[-1], 180)
        self.assertEqual(worker.nearest_seed_index([0, .1, .2], .11), 1)

    def test_empty_mask_does_not_become_a_successful_box(self):
        blank = np.zeros((20, 30), dtype=bool)
        point = worker.point_from_mask(blank, 8, .3, OPTIONS['box'])
        self.assertTrue(point['lost'])
        self.assertEqual(point['confidence'], 0)
        self.assertEqual(point['x'], OPTIONS['box']['x'])

    def test_mask_bounds_use_exclusive_bottom_and_right(self):
        mask = np.zeros((20, 30), dtype=bool)
        mask[4:10, 6:15] = True
        self.assertEqual(worker.mask_box(mask), {'x': .2, 'y': .2, 'w': .3, 'h': .3})
        self.assertTrue(worker.point_from_mask(mask, -2, 0, OPTIONS['box'])['lost'])
        self.assertFalse(worker.point_from_mask(mask, 2, 0, OPTIONS['box'])['lost'])

    def test_result_removes_private_fields_and_preserves_loss(self):
        data = result_fixture()
        data['privatePath'] = 'private-path'
        data['warnings'] = ['private-path']
        data['points'][1]['lost'] = True
        data['points'][1]['privatePath'] = 'private-path'
        result = service.public_result(data, OPTIONS)
        self.assertNotIn('private-path', json.dumps(result))
        self.assertTrue(result['points'][1]['lost'])
        self.assertEqual([row['t'] for row in result['points']], [0, .5, 1, 1.5])

    def test_invalid_model_device_and_timing_are_rejected(self):
        for key, value in [('model', 'fake'), ('computeType', 'float32'), ('device', 'cpu'),
                           ('modelRevision', 'main'), ('duration', 3), ('sampledSeedTime', .123)]:
            with self.subTest(key=key), self.assertRaises(worker.TrackingError):
                service.public_result({**result_fixture(), key: value}, OPTIONS)
        for key, value in [('t', -1), ('t', 2), ('confidence', float('nan')),
                           ('w', 1), ('lost', 1)]:
            data = result_fixture()
            data['points'][0][key] = value
            with self.subTest(key=key), self.assertRaises(worker.TrackingError):
                service.public_result(data, OPTIONS)

    def test_duplicate_frame_time_is_rejected(self):
        data = result_fixture()
        data['points'][1]['t'] = 0
        with self.assertRaises(worker.TrackingError):
            service.public_result(data, OPTIONS)


class TrackingStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='studio-tracking-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def test_offline_model_requires_hash_not_just_file_size(self):
        model = self.root / 'model'
        model.mkdir()
        payload = b'pinned model test'
        digest = hashlib.sha256(payload).hexdigest()
        files = {worker.MODEL_FILE: (len(payload), digest)}
        (model / worker.MODEL_FILE).write_bytes(payload)
        (model / worker.MODEL_MARKER).write_text(json.dumps({
            'provider': 'sam2', 'modelName': worker.MODEL_NAME, 'modelRevision': worker.MODEL_REV,
            'sourceRevision': worker.SOURCE_REV,
            'files': {worker.MODEL_FILE: {'size': len(payload), 'sha256': digest}}}), encoding='utf-8')
        with patch.object(worker, 'MODEL_FILES', files):
            self.assertEqual(worker.validate_model_directory(model), model)
            (model / worker.MODEL_FILE).write_bytes(b'x' * len(payload))
            with self.assertRaises(worker.TrackingError):
                worker.validate_model_directory(model)

    def test_engine_setup_refuses_an_unrelated_environment(self):
        engine = self.root / 'existing'
        engine.mkdir()
        (engine / 'keep.txt').write_text('original', encoding='utf-8')
        with self.assertRaises(RuntimeError):
            setup.claim_engine_directory(engine)
        self.assertEqual((engine / 'keep.txt').read_text(encoding='utf-8'), 'original')

    def test_config_activation_preserves_voice_and_asr_files(self):
        local = self.root / 'local'
        local.mkdir()
        preserved = {'pc-voice.json': 'original voice config', 'pc-asr.json': 'original asr config'}
        for name, value in preserved.items():
            (local / name).write_text(value, encoding='utf-8')
        engine = self.root / 'engine'
        with patch.object(setup, 'register_installation') as register:
            setup.write_config(engine, engine / 'source', engine / 'model', engine / 'python.exe', local)
        for name, value in preserved.items():
            self.assertEqual((local / name).read_text(encoding='utf-8'), value)
        self.assertEqual(json.loads((local / 'pc-tracking.json').read_text(encoding='utf-8'))['provider'], 'sam2')
        register.assert_called_once()

    def test_settings_reject_an_executable_outside_claimed_engine(self):
        engine = self.root / 'engine'
        source = engine / 'source'
        model = engine / 'model'
        source.mkdir(parents=True)
        model.mkdir()
        python = self.root / 'unrelated-python.exe'
        python.write_bytes(b'test')
        config = {'version': 1, 'provider': 'sam2', 'modelName': worker.MODEL_NAME,
                  'modelRevision': worker.MODEL_REV, 'sourceRevision': worker.SOURCE_REV,
                  'device': 'cuda', 'computeType': 'bfloat16', 'engine': str(engine),
                  'source': str(source), 'model': str(model), 'python': str(python)}
        (self.root / 'pc-tracking.json').write_text(json.dumps(config), encoding='utf-8')
        with self.assertRaises(worker.TrackingError) as error:
            service.read_settings(self.root)
        self.assertEqual(error.exception.code, 'TRACKING_NOT_INSTALLED')

    def test_engine_claim_can_be_resumed_only_for_same_provider(self):
        engine = setup.claim_engine_directory(self.root / 'new')
        self.assertEqual(setup.claim_engine_directory(engine), engine)
        marker = engine / setup.ENVIRONMENT_MARKER
        value = json.loads(marker.read_text(encoding='utf-8'))
        value['provider'] = 'faster-whisper'
        marker.write_text(json.dumps(value), encoding='utf-8')
        with self.assertRaises(RuntimeError):
            setup.claim_engine_directory(engine)

    def test_source_archive_rejects_traversal(self):
        for suffix in ('sam2/../../outside.py', 'sam2/a:stream', 'sam2/back\\slash.py'):
            payload = io.BytesIO()
            with zipfile.ZipFile(payload, 'w') as bundle:
                entry = zipfile.ZipInfo()
                entry.filename = 'sam2-' + worker.SOURCE_REV + '/' + suffix
                bundle.writestr(entry, b'x')
            with zipfile.ZipFile(io.BytesIO(payload.getvalue())) as bundle:
                with self.subTest(suffix=suffix), self.assertRaises(RuntimeError):
                    setup.source_members(bundle)

    def test_source_archive_skips_only_exact_unused_legacy_aliases(self):
        prefix = 'sam2-' + worker.SOURCE_REV + '/'
        aliases = ['sam2_hiera_b+.yaml', 'sam2_hiera_l.yaml',
                   'sam2_hiera_s.yaml', 'sam2_hiera_t.yaml']
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, 'w') as bundle:
            for name in aliases:
                entry = zipfile.ZipInfo(prefix + 'sam2/' + name)
                entry.create_system = 3
                entry.external_attr = 0o120777 << 16
                bundle.writestr(entry, 'configs/sam2/' + name)
            bundle.writestr(prefix + 'sam2/configs/sam2.1/sam2.1_hiera_s.yaml', '{}')
        with zipfile.ZipFile(io.BytesIO(payload.getvalue())) as bundle:
            retained = setup.source_members(bundle)
        self.assertEqual([parts for _, parts in retained],
                         [('sam2', 'configs', 'sam2.1', 'sam2.1_hiera_s.yaml')])
        for name, target in [('sam2_hiera_s.yaml', '../../outside'),
                             ('other.yaml', 'configs/sam2/other.yaml')]:
            payload = io.BytesIO()
            with zipfile.ZipFile(payload, 'w') as bundle:
                entry = zipfile.ZipInfo(prefix + 'sam2/' + name)
                entry.create_system = 3
                entry.external_attr = 0o120777 << 16
                bundle.writestr(entry, target)
            with zipfile.ZipFile(io.BytesIO(payload.getvalue())) as bundle:
                with self.subTest(name=name), self.assertRaises(RuntimeError):
                    setup.source_members(bundle)

    def test_frame_loader_keeps_two_frames_and_same_normalization(self):
        paths = []
        for index in range(3):
            path = self.root / f'{index}.png'
            Image.new('RGB', (4, 2), (255, 0, 0)).save(path)
            paths.append(path)
        frames = worker.VideoFrames(tuple(paths), (0, .1, .2), 4, 2, 1)
        fake_torch = SimpleNamespace(from_numpy=lambda array: SimpleNamespace(
            permute=lambda *axes: np.transpose(array, axes)))
        loader = worker.CpuFrameStore(frames, 4, fake_torch)
        first = loader[0]
        self.assertIs(loader[0], first)
        loader[1]
        loader[2]
        self.assertEqual(list(loader.cache), [1, 2])
        np.testing.assert_allclose(first[:, 0, 0], [(1 - .485) / .229, -.456 / .224, -.406 / .225], rtol=1e-6)

    def test_state_pruning_preserves_seed_and_recent_outputs(self):
        state = {'output_dict_per_obj': {0: {'cond_frame_outputs': {10: 'seed'},
                  'non_cond_frame_outputs': {index: index for index in range(101)}}},
                 'frames_tracked_per_obj': {0: {index: {} for index in range(101)}}}
        worker.prune_state(state, 100)
        outputs = state['output_dict_per_obj'][0]
        self.assertEqual(outputs['cond_frame_outputs'], {10: 'seed'})
        self.assertEqual(min(outputs['non_cond_frame_outputs']), 36)
        self.assertEqual(min(state['frames_tracked_per_obj'][0]), 36)

    def test_loader_patch_is_restored_after_failure(self):
        original = Mock()
        module = SimpleNamespace(load_video_frames=original)
        frames = worker.VideoFrames((), (), 4, 2, 0)
        with self.assertRaises(RuntimeError):
            with worker.bounded_load_frames(module, frames, SimpleNamespace()):
                self.assertIsNot(module.load_video_frames, original)
                raise RuntimeError('stop')
        self.assertIs(module.load_video_frames, original)

    def test_ndjson_reader_rejects_bad_and_excessive_messages(self):
        messages = queue.SimpleQueue()
        service.read_messages(io.BytesIO(b'{"type":"progress"}\n'), messages)
        self.assertEqual(messages.get()[0], 'message')
        self.assertEqual(messages.get()[0], 'eof')
        for content in (b'invalid\n', b'[]\n', b'{}', b'x' * 33):
            messages = queue.SimpleQueue()
            with patch.object(service, 'MAX_MESSAGE_BYTES', 32):
                service.read_messages(io.BytesIO(content), messages)
            self.assertEqual(messages.get()[0], 'invalid')

    def test_offline_environment_removes_foreign_python_paths(self):
        env = worker.offline_environment({'PYTHONPATH': 'foreign', 'PYTHONHOME': 'foreign'})
        self.assertNotIn('PYTHONPATH', env)
        self.assertNotIn('PYTHONHOME', env)
        self.assertEqual(env['HF_HUB_OFFLINE'], '1')
        self.assertEqual(env['TORCH_FORCE_WEIGHTS_ONLY_LOAD'], '1')


class FakeVoice:
    def __init__(self, events):
        self.lock, self.uncertain, self.events = threading.Lock(), False, events

    @contextmanager
    def exclusive(self):
        with self.lock:
            yield

    def reserve_asr(self, **kwargs):
        self.events.append(('reserve', kwargs))
        return {'token': 'test-lease'}

    def release_asr(self, token):
        if not self.lock.locked():
            raise AssertionError('GPU gate released before process cleanup')
        self.events.append(('release', token))


class FakeProcess:
    def __init__(self, messages, running=False):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(b''.join((json.dumps(value) + '\n').encode() for value in messages))
        self.returncode = None if running else 0
        self.pid = 99999999

    def poll(self):
        return self.returncode


class TrackingLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='studio-tracking-lifecycle-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.events = []
        self.voice = FakeVoice(self.events)
        self.service = service.PcTrackingService(self.root, self.voice)
        self.settings = {'engine': str(self.root / 'engine'), 'python': 'fake-python',
                         'model': str(self.root / 'engine' / 'model')}
        self.job_id = 'a' * 32
        self.job = {'state': 'running', 'progress': 0, 'message': '', 'created': 0,
                    'cancel': threading.Event(), 'process': None}
        self.service.jobs[self.job_id] = self.job
        self.service.active = self.job_id
        self.process_job = Mock(name=None)
        self.process_job.name = None
        self.process_job.close.side_effect = lambda: self.events.append(('job-close',))

    def run_worker(self, process, collect=None):
        def stop(owned):
            self.assertIs(owned, process)
            self.events.append(('stop-process',))
            owned.returncode = -1
        with patch.object(service, 'WindowsJob', return_value=self.process_job), \
                patch.object(service.subprocess, 'Popen', return_value=process) as launch, \
                patch.object(service, 'stop_process', side_effect=stop):
            if collect:
                with patch.object(self.service, '_collect', side_effect=collect):
                    self.service._run(self.job_id, b'video-test-only', OPTIONS, self.settings)
            else:
                self.service._run(self.job_id, b'video-test-only', OPTIONS, self.settings)
        self.assertTrue(launch.called)

    def test_result_published_after_gpu_release_and_temp_cleanup(self):
        process = FakeProcess([{'type': 'progress', 'progress': .4, 'phase': 'tracking'},
                               {'type': 'result', 'result': result_fixture()}])
        self.run_worker(process)
        self.assertEqual(self.job['state'], 'done')
        self.assertEqual([event[0] for event in self.events], ['reserve', 'job-close', 'release'])
        self.assertEqual(self.events[0][1]['required_free_mib'], 6144)
        self.assertEqual(list((self.root / 'engine' / 'data' / 'tracking-jobs').iterdir()), [])

    def test_cancel_stops_tree_before_releasing_lease(self):
        process = FakeProcess([], running=True)
        def cancel(process, job, messages, options):
            job['cancel'].set()
            return None
        self.run_worker(process, cancel)
        self.assertEqual(self.job['state'], 'cancelled')
        self.assertEqual([event[0] for event in self.events], ['reserve', 'job-close', 'stop-process', 'release'])
        self.assertNotIn('result', self.job)

    def test_unconfirmed_tree_termination_is_fail_closed(self):
        self.process_job.close.side_effect = OSError('private engine path')
        process = FakeProcess([{'type': 'result', 'result': result_fixture()}])
        self.run_worker(process)
        self.assertTrue(self.service.uncertain)
        self.assertTrue(self.voice.uncertain)
        self.assertEqual(self.job['state'], 'failed')
        self.assertNotIn('release', [event[0] for event in self.events])
        self.assertNotIn('private engine path', json.dumps(self.service.get(self.job_id)))
        self.assertNotIn('result', self.job)

    def test_worker_error_is_sanitized_and_releases_owned_resources(self):
        process = FakeProcess([{'type': 'error', 'error': {'code': 'TRACKING_GPU_MEMORY',
                                                        'message': 'private media path'}}])
        self.run_worker(process)
        self.assertEqual(self.job['error']['code'], 'TRACKING_GPU_MEMORY')
        self.assertNotIn('private media path', json.dumps(self.service.get(self.job_id)))
        self.assertEqual(self.events[-1], ('release', 'test-lease'))

    def test_timeout_error_on_release_keeps_both_services_uncertain(self):
        with patch.object(self.voice, 'release_asr', side_effect=OSError('private path')):
            self.run_worker(FakeProcess([{'type': 'result', 'result': result_fixture()}]))
        self.assertEqual(self.job['error']['code'], 'TRACKING_RELEASE_FAILED')
        self.assertTrue(self.service.uncertain)
        self.assertTrue(self.voice.uncertain)


class FakeTensor:
    def __init__(self, value):
        self.value = np.asarray(value)

    def __getitem__(self, index):
        return FakeTensor(self.value[index])

    def __gt__(self, value):
        return FakeTensor(self.value > value)

    def detach(self):
        return self

    def cpu(self):
        return self

    def float(self):
        return self

    def item(self):
        return self.value.item()

    def numpy(self):
        return self.value


class TrackingPredictorTests(unittest.TestCase):
    def test_bidirectional_seed_and_loss_contract_with_fake_predictor(self):
        frames = worker.VideoFrames(tuple(Path(str(index)) for index in range(4)),
                                    (0, .5, 1, 1.5), 30, 20, 2)
        calls = []

        class Predictor:
            num_maskmem = 7
            memory_temporal_stride_for_eval = 1
            max_obj_ptrs_in_encoder = 16

            def init_state(self, path, **kwargs):
                calls.append(('init', kwargs))
                return {'output_dict_per_obj': {0: {'cond_frame_outputs': {}, 'non_cond_frame_outputs': {}}},
                        'frames_tracked_per_obj': {0: {}}}

            def add_new_points_or_box(self, state, **kwargs):
                calls.append(('seed', kwargs))

            def propagate_in_video(self, state, start_frame_idx, reverse):
                calls.append(('direction', reverse))
                indices = range(start_frame_idx, -1, -1) if reverse else range(start_frame_idx, 4)
                for index in indices:
                    mask = np.zeros((1, 1, 20, 30), dtype=np.float32)
                    if index != 1:
                        mask[0, 0, 2:12, 6 + index:15 + index] = 1
                    state['output_dict_per_obj'][0]['non_cond_frame_outputs'][index] = {
                        'object_score_logits': FakeTensor(3.0)}
                    yield index, [1], FakeTensor(mask)

            def reset_state(self, state):
                state.clear()

        fake_torch = ModuleType('torch')
        fake_torch.__version__ = worker.TORCH_VERSION
        fake_torch.cuda = SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True)
        fake_torch.bfloat16 = 'bfloat16'
        fake_torch.set_num_threads = lambda count: None
        fake_torch.inference_mode = nullcontext
        fake_torch.autocast = lambda **kwargs: nullcontext()
        sam = ModuleType('sam2')
        predictor_module = ModuleType('sam2.sam2_video_predictor')
        predictor_module.load_video_frames = Mock()
        builder = ModuleType('sam2.build_sam')
        builder.build_sam2_video_predictor = Mock(return_value=Predictor())
        sam.sam2_video_predictor = predictor_module
        sam.build_sam = builder
        versions = {'torchvision': worker.TORCHVISION_VERSION, 'SAM-2': worker.SAM_PACKAGE_VERSION}
        with patch.dict(sys.modules, {'torch': fake_torch, 'sam2': sam,
                                     'sam2.sam2_video_predictor': predictor_module, 'sam2.build_sam': builder}), \
                patch.object(worker, 'validate_model_directory', return_value=Path('fake-model')), \
                patch.object(worker, 'extract_frames', return_value=frames), \
                patch.object(worker.importlib.metadata, 'version', side_effect=versions.__getitem__):
            result = worker.track_video('fake-video', 'fake-frames', 'fake-model', OPTIONS)
        self.assertEqual([row['t'] for row in result['points']], [0, .5, 1, 1.5])
        self.assertTrue(result['points'][1]['lost'])
        self.assertFalse(result['points'][2]['lost'])
        self.assertEqual([value for kind, value in calls if kind == 'direction'], [False, True])
        for kind, value in calls:
            if kind == 'init':
                self.assertTrue(value['offload_video_to_cpu'])
                self.assertTrue(value['offload_state_to_cpu'])
            if kind == 'seed':
                self.assertEqual(value['frame_idx'], 2)
                np.testing.assert_allclose(value['box'], [6, 2, 15, 12])
