"""명시 실행용 SAM 실기 검사. 사용자 영상 대신 직접 만든 도형만 추적한다."""

import argparse
from fractions import Fraction
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pc_tracking import PcTrackingService


def target_box(source_time):
    return {'x': (60 + 80 * source_time) / 640, 'y': 80 / 360,
            'w': 130 / 640, 'h': 180 / 360}


def make_fixture(path):
    import av
    from PIL import Image, ImageDraw
    with av.open(str(path), 'w', format='mp4') as container:
        stream = container.add_stream('libx264', rate=30)
        stream.width, stream.height, stream.pix_fmt = 640, 360, 'yuv420p'
        stream.options = {'crf': '18', 'preset': 'fast'}
        for index in range(90):
            image = Image.new('RGB', (640, 360), (27, 34, 45))
            draw = ImageDraw.Draw(image)
            for x in range(0, 640, 32):
                draw.line((x, 0, x, 360), fill=(38, 44, 56))
            box = target_box(index / 30)
            left = round(box['x'] * 640)
            draw.rectangle((left, 80, left + 129, 259), fill=(238, 96, 43))
            for y in range(90, 249, 20):
                for x in range(left + 10, left + 120, 20):
                    if ((x - left - 10) // 20 + (y - 90) // 20) % 2:
                        draw.rectangle((x, y, x + 11, y + 11), fill=(253, 210, 65))
            draw.ellipse((500, 105, 600, 205), fill=(31, 143, 183))
            frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base = index, Fraction(1, 30)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def gpu_used_mib():
    result = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'],
                            capture_output=True, text=True, timeout=10,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=True)
    return int(result.stdout.strip().splitlines()[0])


def overlap(first, second):
    width = max(0, min(first['x'] + first['w'], second['x'] + second['w']) - max(first['x'], second['x']))
    height = max(0, min(first['y'] + first['h'], second['y'] + second['h']) - max(first['y'], second['y']))
    intersection = width * height
    return intersection / max(1e-12, first['w'] * first['h'] + second['w'] * second['h'] - intersection)


def wait_job(service, job_id, cancel=False):
    started, next_poll = time.monotonic(), 0
    peak = gpu_used_mib()
    cancelled = False
    while True:
        result = service.get(job_id)
        if time.monotonic() >= next_poll:
            peak = max(peak, gpu_used_mib())
            next_poll = time.monotonic() + .75
        if result['state'] != 'running':
            return result, peak, time.monotonic() - started
        if cancel and result.get('progress', 0) > .25 and not cancelled:
            service.cancel(job_id)
            cancelled = True
        if time.monotonic() - started > 600:
            service.cancel(job_id)
            raise RuntimeError('Synthetic tracking verification timed out.')
        time.sleep(.1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary = {'fixture': 'generated-moving-checker-rectangle', 'userMediaUsed': False}
    before = gpu_used_mib()
    service = PcTrackingService(args.local_dir, voice=None, timeout=540)
    try:
        with tempfile.TemporaryDirectory(prefix='synthetic-', dir=args.output_dir) as directory:
            fixture = Path(directory) / 'fixture.mp4'
            make_fixture(fixture)
            video = fixture.read_bytes()
            options = {'start': .5, 'duration': 2, 'seedTime': .9, 'box': target_box(1.4)}
            job_id = service.start(video, options)
            result, peak, elapsed = wait_job(service, job_id)
            if result['state'] != 'done':
                raise RuntimeError('Synthetic tracking failed: ' + result.get('error', {}).get('code', result['state']))
            points = result['result']['points']
            scores = [overlap(row, target_box(options['start'] + row['t'])) for row in points if not row['lost']]
            time.sleep(.5)
            after = gpu_used_mib()
            summary.update({'model': result['result']['model'], 'points': len(points),
                            'lostPoints': sum(row['lost'] for row in points),
                            'firstTime': points[0]['t'], 'lastTime': points[-1]['t'],
                            'meanBoxIoU': statistics.mean(scores), 'minBoxIoU': min(scores),
                            'elapsedSeconds': elapsed,
                            'gpuUsedMiBBefore': before, 'gpuUsedMiBPeak': peak, 'gpuUsedMiBAfter': after})
            (args.output_dir / 'synthetic-result.json').write_text(json.dumps(result['result'], indent=2), encoding='utf-8')
            assert 25 <= len(points) <= 34
            assert 0 <= points[0]['t'] < .05 and 1.85 < points[-1]['t'] < 2
            assert summary['meanBoxIoU'] >= .5
            assert service.active is None and not service.uncertain
            cancel_id = service.start(video, options)
            cancelled, cancel_peak, cancel_elapsed = wait_job(service, cancel_id, cancel=True)
            time.sleep(.5)
            summary.update({'cancelState': cancelled['state'], 'cancelElapsedSeconds': cancel_elapsed,
                            'cancelGpuPeakMiB': cancel_peak, 'gpuUsedMiBAfterCancel': gpu_used_mib()})
            assert cancelled['state'] == 'cancelled'
            assert 'result' not in cancelled and service.active is None and not service.uncertain
    finally:
        service.close()
        (args.output_dir / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
