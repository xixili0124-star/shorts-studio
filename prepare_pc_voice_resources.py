"""Download pronunciation resources during setup, never during voice generation."""
import argparse
import json
from pathlib import Path, PurePosixPath
import shutil
import zipfile

from setup_pc_voice import download, sha256

NLTK_RESOURCES = {
    'corpora/cmudict': 'd07cca47fd72ad32ea9d8ad1219f85301eeaf4568f8b6b73747506a71fb5afd6',
    'taggers/averaged_perceptron_tagger': 'e1f13cf2532daadfd6f3bc481a49859f0b8ea6432ccdcd83e6a49a5f19008de9',
    'taggers/averaged_perceptron_tagger_eng': '6025f530624335c67d6547d44757b357b4e79bae030a0383e9887a92c1718f0b',
}
FASTTEXT_SHA256 = '7e69ec5451bc261cc7844e49e4792a85d7f09c06789ec800fc4a44aec362764e'


def extract_resource(archive, destination):
    destination = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        if sum(info.file_size for info in bundle.infolist()) > 64 * 1024 * 1024:
            raise RuntimeError('Unexpected pronunciation resource size')
        for info in bundle.infolist():
            parts = PurePosixPath(info.filename).parts
            if not parts or any(part in ('..', '.', '/') or ':' in part or '\\' in part for part in parts):
                raise RuntimeError('Unsafe pronunciation resource path')
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError('Resource links are not allowed')
            target = destination.joinpath(*parts)
            if not target.resolve().is_relative_to(destination):
                raise RuntimeError('Unsafe pronunciation resource path')
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as original, target.open('wb') as output:
                    shutil.copyfileobj(original, output)


def prepare(data, source, binary_dir):
    data, source, binary_dir = data.resolve(), source.resolve(), binary_dir.resolve()
    nltk_dir = data / 'nltk_data'
    for name, digest in NLTK_RESOURCES.items():
        archive = nltk_dir / (name + '.zip')
        download('https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/' + name + '.zip', archive, digest)
        # g2pk2/g2p-en look for the ZIP; NLTK 3.9 also needs the extracted JSON.
        extract_resource(archive, archive.parent)
    detector = source / 'GPT_SoVITS' / 'pretrained_models' / 'fast_langdetect' / 'lid.176.bin'
    download('https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin', detector, FASTTEXT_SHA256)
    print('Official fastText model SHA-256: ' + sha256(detector), flush=True)
    import imageio_ffmpeg
    binary_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(imageio_ffmpeg.get_ffmpeg_exe(), binary_dir / 'ffmpeg.exe')
    (data / 'resources-ready.json').write_text(json.dumps({'version': 1, 'nltk': NLTK_RESOURCES,
        'fastTextSha256': sha256(detector)}, indent=2), encoding='utf-8')
    print('Offline pronunciation resources are ready.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-data', required=True, type=Path)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--bin', required=True, type=Path)
    args = parser.parse_args()
    prepare(args.engine_data, args.source, args.bin)
