"""명시한 공개 PC 지원 파일만 ZIP과 한 번 실행할 Windows 설치기로 묶습니다."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parent
PACKAGE_ID = 'shorts-studio-pc-support'
MANIFEST = 'pc-support-package.json'
ZIP_NAME = 'Shorts-Studio-PC-Support.zip'
INSTALLER_NAME = 'Shorts-Studio-PC-Setup.cmd'
VOICE_INSTALLER_NAME = 'Shorts-Studio-Voice-Setup.cmd'
DOWNLOAD_ORIGIN = 'https://shorts-studio-75p.pages.dev'
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
# https://developers.cloudflare.com/pages/platform/limits/ 의 개별 정적 파일 한도입니다.
CLOUDFLARE_MAX_ASSET_BYTES = 25 * 1024 * 1024
PC_FILES = (
    'install_pc_support.py', 'build_pc_support_package.py', 'install-pc-support.cmd',
    'studio_server.py', 'pc_installation.py', 'pc_bridge.py', 'pc_http.py', 'pc_runtime.py',
    'pc_voice.py', 'pc_voice_config.py', 'pc_voice_engine.py', 'vox_voice_engine.py',
    'pc_asr.py', 'pc_asr_worker.py', 'pc_asr_process.py', 'pc_tracking.py', 'pc_tracking_worker.py',
    'setup_pc_voice.py', 'setup_vox_voice.py', 'setup_pc_asr.py', 'setup_pc_tracking.py',
    'prepare_pc_voice_resources.py', 'start_pc_voice.py', 'start-pc-voice.cmd',
    'setup-pc-voice.cmd', 'setup-pc-asr.cmd', 'setup-pc-tracking.cmd', 'setup-gpt-voice.cmd',
    'pc-voice-requirements.txt', 'vox-voice-requirements.txt', 'pc-asr-requirements.txt', 'pc-tracking-requirements.txt',
    'CREDITS.md', 'public/pc-voice-setup.html', 'public/pc-asr-setup.html',
)
OPTIONAL_FILES = ('LICENSE', 'LICENSE.md', 'public/pc-tracking-setup.html')
UV_VERSION = '0.12.7'
PYTHON_VERSION = '3.11.13'
# 공식 PyPI 0.12.7 배포 메타데이터의 Windows x64 파일을 고정합니다.
UV_URL = 'https://files.pythonhosted.org/packages/e7/97/40a91354862028e8f8e547ac27c6acd7b7cc67b9003acc28596d9e90cd6b/uv-0.12.7-py3-none-win_amd64.whl'
UV_SHA256 = '277d326d7e63b912f3425c6e6d7d5d49f21b43d080d21859ff3c6819353f1847'
UV_SIZE = 18085016

# PowerShell 모듈 자동 로딩 없이 파일과 ZIP 항목에 같은 SHA-256 계산을 적용합니다.
BOOTSTRAP_FILE_FUNCTIONS = r"""
function SafeFile($p){if(Test-Path -LiteralPath $p){$a=(Get-Item -Force -LiteralPath $p).Attributes;if($a -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)){throw 'A linked or non-file download is not allowed.'}}};
function StreamSha256($s){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}};
function FileSha256($p){SafeFile $p;$s=[IO.File]::OpenRead($p);try{return StreamSha256 $s}finally{$s.Dispose()}};
function Fetch($url,$target,$hash,$size){SafeFile $target;if(Test-Path -LiteralPath $target){if((Get-Item -LiteralPath $target).Length -eq $size -and (FileSha256 $target) -eq $hash){return};throw 'An existing download does not match the pinned release.'};$part=$target+'.'+[Guid]::NewGuid().ToString('N')+'.part';$r=[Net.HttpWebRequest]::Create($url);$r.AllowAutoRedirect=$false;$r.Timeout=60000;$r.ReadWriteTimeout=120000;$s=$r.GetResponse();try{if([int]$s.StatusCode -ne 200){throw 'Download was redirected or rejected.'};$a=$s.GetResponseStream();$b=[IO.File]::Open($part,[IO.FileMode]::CreateNew);try{$buf=New-Object byte[] 65536;$n=0;while(($c=$a.Read($buf,0,$buf.Length)) -gt 0){$n+=$c;if($n -gt $size){throw 'Download exceeded its expected size.'};$b.Write($buf,0,$c)}}finally{$b.Dispose();$a.Dispose()}}finally{$s.Dispose()};if((Get-Item -LiteralPath $part).Length -ne $size -or (FileSha256 $part) -ne $hash){throw 'Download integrity verification failed.'};[IO.File]::Move($part,$target)};
"""


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def validate_public_content(name, content):
    """허용 소스에 개인 홈 경로나 고정 관리 키가 끼어 있어도 배포하지 않습니다."""
    home = rb'''(?i)(?:\b[a-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\s'"<>]+|(?<![A-Za-z0-9])/(?:home|Users)/[^\s'"<>]+)'''
    credential = rb'''(?i)["'](?:engineKey|key|apiKey|api_key|managementKey)["']\s*[:=]\s*["'][A-Za-z0-9_./+=-]{32,}["']'''
    if re.search(home, content) or re.search(credential, content):
        # 발견한 값은 출력하지 않아 오류 메시지를 통해서도 새지 않게 합니다.
        raise ValueError('개인 경로나 고정 키가 포함된 공개 소스는 패키징하지 않습니다: ' + name)


def check_release_assets(archive, command, *additional_commands):
    """전송용 gzip 크기와 별개로 배포할 원본 파일의 크기를 먼저 제한합니다."""
    commands = (command, *additional_commands)
    if any(len(value) > CLOUDFLARE_MAX_ASSET_BYTES for value in (archive, *commands)):
        raise ValueError('Cloudflare Pages의 개별 파일 25 MiB 한도를 초과했습니다.')
    if len(archive) > MAX_ARCHIVE_BYTES:
        raise ValueError('PC 지원 ZIP의 자체 크기 제한을 초과했습니다.')
    result = {'archiveBytes': len(archive), 'installerBytes': len(command),
            'gzipArchiveBytes': len(gzip.compress(archive, mtime=0)),
            'gzipInstallerBytes': len(gzip.compress(command, mtime=0)),
            'pagesMaxAssetBytes': CLOUDFLARE_MAX_ASSET_BYTES}
    if additional_commands:
        result['voiceInstallerBytes'] = len(additional_commands[0])
        result['gzipVoiceInstallerBytes'] = len(gzip.compress(additional_commands[0], mtime=0))
    return result


def safe_member(name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,199}', name):
        raise ValueError('허용하지 않는 패키지 파일 이름입니다.')
    parts = name.split('/')
    reserved = {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}
    if any(not part or part in ('.', '..') or part.endswith('.') or part.split('.')[0].upper() in reserved for part in parts):
        raise ValueError('안전하지 않은 패키지 경로입니다.')
    if PurePosixPath(name).is_absolute() or name not in (*PC_FILES, *OPTIONAL_FILES, MANIFEST):
        raise ValueError('패키지 허용 목록에 없는 파일입니다: ' + name)
    return name


def no_links(path, root):
    path, root = Path(path).absolute(), Path(root).absolute()
    if not path.is_relative_to(root):
        raise ValueError('패키지 범위 밖의 경로입니다.')
    for part in [path, *path.parents]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('링크나 재분석 지점을 패키지에 사용할 수 없습니다.')
        if part == root:
            break


def source_manifest(source=ROOT):
    source = Path(source).absolute()
    files = []
    for name in (*PC_FILES, *OPTIONAL_FILES):
        safe_member(name)
        path = source / name
        no_links(path, source)
        if not path.is_file():
            if name in OPTIONAL_FILES:
                continue
            raise ValueError('패키지에 필요한 파일이 없습니다: ' + name)
        size = path.stat().st_size
        if size <= 0 or size > MAX_FILE_BYTES:
            raise ValueError('패키지 파일의 크기가 올바르지 않습니다: ' + name)
        content = path.read_bytes()
        if len(content) != size:
            raise ValueError('검사 중 공개 소스 크기가 변경되었습니다: ' + name)
        validate_public_content(name, content)
        files.append({'path': name, 'size': size, 'sha256': hashlib.sha256(content).hexdigest()})
    if sum(item['size'] for item in files) > MAX_TOTAL_BYTES:
        raise ValueError('PC 지원 패키지가 예상 크기를 초과했습니다.')
    return {'version': 1, 'package': PACKAGE_ID, 'files': files}


def validate_manifest(data):
    if (not isinstance(data, dict) or set(data) != {'version', 'package', 'files'}
            or type(data.get('version')) is not int or data['version'] != 1
            or data.get('package') != PACKAGE_ID or not isinstance(data.get('files'), list)):
        raise ValueError('PC 지원 패키지 정보가 올바르지 않습니다.')
    names = set()
    for item in data['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'size', 'sha256'}:
            raise ValueError('PC 지원 패키지 파일 정보가 없습니다.')
        name = safe_member(item.get('path'))
        if name == MANIFEST or name.lower() in names or type(item.get('size')) is not int or not 0 < item['size'] <= MAX_FILE_BYTES:
            raise ValueError('중복되거나 너무 큰 패키지 파일이 있습니다.')
        if not isinstance(item.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', item['sha256']):
            raise ValueError('패키지 파일 검증값이 없습니다.')
        names.add(name.lower())
    if not {name.lower() for name in PC_FILES}.issubset(names) or sum(item['size'] for item in data['files']) > MAX_TOTAL_BYTES:
        raise ValueError('필수 파일이 없거나 패키지 크기가 너무 큽니다.')
    return data


def read_package(archive, expected_sha256=None):
    """압축을 풀기 전에 모든 경로·크기·파일 해시를 검사합니다."""
    archive = Path(archive)
    no_links(archive, archive.anchor)
    if not archive.is_file() or not 0 < archive.stat().st_size <= MAX_ARCHIVE_BYTES:
        raise ValueError('PC 지원 ZIP 크기나 경로가 올바르지 않습니다.')
    if expected_sha256 is not None and (not re.fullmatch(r'[a-f0-9]{64}', expected_sha256) or file_digest(archive) != expected_sha256):
        raise ValueError('PC 지원 ZIP의 SHA-256이 일치하지 않습니다.')
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > len(PC_FILES) + len(OPTIONAL_FILES) + 1 or sum(item.file_size for item in entries) > MAX_TOTAL_BYTES + 65536:
            raise ValueError('PC 지원 ZIP의 압축 해제 크기가 너무 큽니다.')
        names = set()
        for item in entries:
            safe_member(item.filename)
            if item.orig_filename != item.filename or item.is_dir() or item.filename.lower() in names or item.file_size > MAX_FILE_BYTES or item.flag_bits & 1:
                raise ValueError('PC 지원 ZIP 항목이 올바르지 않습니다.')
            if stat.S_IFMT(item.external_attr >> 16) not in (0, stat.S_IFREG):
                raise ValueError('PC 지원 ZIP의 링크나 특수 파일은 허용하지 않습니다.')
            names.add(item.filename.lower())
        if MANIFEST not in names or bundle.getinfo(MANIFEST).file_size > 65536:
            raise ValueError('PC 지원 ZIP의 파일 목록이 없습니다.')
        manifest = validate_manifest(json.loads(bundle.read(MANIFEST)))
        if names != {MANIFEST, *(item['path'].lower() for item in manifest['files'])}:
            raise ValueError('패키지 파일 목록과 ZIP 내용이 다릅니다.')
        for item in manifest['files']:
            content = bundle.read(item['path'])
            if len(content) != item['size'] or hashlib.sha256(content).hexdigest() != item['sha256']:
                raise ValueError('패키지 파일 검증에 실패했습니다: ' + item['path'])
            validate_public_content(item['path'], content)
    return manifest


def bootstrap_cmd(package_sha256=None, package_size=None, *, components=(), consumer=False):
    """실행 정책 변경 없이 읽을 수 있는 PowerShell 명령을 CMD에 넣습니다."""
    if package_sha256 is not None and (not re.fullmatch(r'[a-f0-9]{64}', package_sha256) or type(package_size) is not int or not 0 < package_size <= MAX_ARCHIVE_BYTES):
        raise ValueError('설치기에 고정할 패키지 정보가 올바르지 않습니다.')
    components = tuple(components)
    if any(name not in ('voice', 'asr', 'tracking') for name in components) or consumer and components != ('voice',):
        raise ValueError('소비자용 설치 기능 지정이 올바르지 않습니다.')
    script = r"""
$ErrorActionPreference='Stop';
if(-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'){throw 'Windows x64 is required.'};
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;
Add-Type -AssemblyName System.IO.Compression.FileSystem;
function SafeDir($p){$p=[IO.Path]::GetFullPath($p);if($p.StartsWith('\\')){throw 'A local directory is required.'};$q=$p;while($q){if((Test-Path -LiteralPath $q) -and ((Get-Item -Force -LiteralPath $q).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked setup directories are not allowed.'};$q=[IO.Path]::GetDirectoryName($q)};[IO.Directory]::CreateDirectory($p)|Out-Null;return $p};
__FILE_FUNCTIONS__
$base=SafeDir (Join-Path $env:LOCALAPPDATA 'ShortsStudio');
$runtime=SafeDir (Join-Path $base 'runtime');$cache=SafeDir (Join-Path $runtime 'downloads');
$wheel=Join-Path $cache 'uv-__UV_VERSION__-win64.whl';Fetch '__UV_URL__' $wheel '__UV_SHA__' __UV_SIZE__;
$uv=Join-Path $runtime 'uv.exe';SafeFile $uv;$z=[IO.Compression.ZipFile]::OpenRead($wheel);try{$e=@($z.Entries|Where-Object {$_.FullName.EndsWith('/uv.exe')});if($e.Count -ne 1 -or $e[0].Length -gt 134217728){throw 'Unexpected uv archive.'};if(-not(Test-Path -LiteralPath $uv)){[IO.Compression.ZipFileExtensions]::ExtractToFile($e[0],$uv,$false)}else{$a=$e[0].Open();try{$expected=StreamSha256 $a}finally{$a.Dispose()};if((FileSha256 $uv) -ne $expected){throw 'The existing uv executable does not match.'}}}finally{$z.Dispose()};
$env:UV_CACHE_DIR=Join-Path $runtime 'cache';$env:UV_PYTHON_INSTALL_DIR=Join-Path $runtime 'python';
& $uv python install '__PYTHON_VERSION__' --no-bin --no-registry;if($LASTEXITCODE -ne 0){throw 'Python preparation failed.'};
$python=(& $uv python find '__PYTHON_VERSION__' --managed-python|Out-String).Trim();if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $python -PathType Leaf)){throw 'Python was not found.'};
__PACKAGE_FETCH__
& $python -E -s -X utf8 (Join-Path $source 'install_pc_support.py') --source $source __INSTALL_ARGS__;if($LASTEXITCODE -ne 0){throw 'PC support setup did not finish.'};
"""
    if package_sha256:
        fetch = r"""
$stage=SafeDir (Join-Path (SafeDir (Join-Path $base 'staging')) ([Guid]::NewGuid().ToString('N')));
$zip=Join-Path $stage 'support.zip';Fetch '__ZIP_URL__' $zip '__ZIP_SHA__' __ZIP_SIZE__;
$source=SafeDir (Join-Path $stage 'source');$z=[IO.Compression.ZipFile]::OpenRead($zip);try{$total=0;$seen=@{};if($z.Entries.Count -gt 64){throw 'Too many package files.'};foreach($e in $z.Entries){$name=$e.FullName;if($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $name -match '(^|/)\.\.?(/|$)' -or $name -match '(^|/)[^/]*\.(/|$)' -or $name.EndsWith('/') -or $seen.ContainsKey($name.ToLowerInvariant()) -or (($e.ExternalAttributes -shr 16) -band 61440) -notin @(0,32768)){throw 'Unsafe package path.'};$seen[$name.ToLowerInvariant()]=$true;$total+=$e.Length;if($e.Length -gt 4194304 -or $total -gt 33554432){throw 'Package is too large.'};$target=[IO.Path]::GetFullPath((Join-Path $source $name));if(-not $target.StartsWith($source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Package escaped its directory.'};[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null;[IO.Compression.ZipFileExtensions]::ExtractToFile($e,$target,$false)}}finally{$z.Dispose()};
"""
        fetch = fetch.replace('__ZIP_URL__', DOWNLOAD_ORIGIN + '/downloads/' + ZIP_NAME).replace('__ZIP_SHA__', package_sha256).replace('__ZIP_SIZE__', str(package_size))
    else:
        fetch = "$source=$env:STUDIO_SETUP_SOURCE;if(-not(Test-Path -LiteralPath (Join-Path $source 'install_pc_support.py'))){throw 'Run this file beside install_pc_support.py.'};"
    install_args = ('--components ' + ' '.join(components) + ' ' if components else '') + ('--yes --consumer' if consumer else '')
    script = script.replace('__FILE_FUNCTIONS__', BOOTSTRAP_FILE_FUNCTIONS).replace('__PACKAGE_FETCH__', fetch).replace('__UV_VERSION__', UV_VERSION).replace('__UV_URL__', UV_URL).replace('__UV_SHA__', UV_SHA256).replace('__UV_SIZE__', str(UV_SIZE)).replace('__PYTHON_VERSION__', PYTHON_VERSION).replace('__INSTALL_ARGS__', install_args.strip())
    script = ' '.join(line.strip() for line in script.splitlines() if line.strip())
    command = 'powershell.exe -NoProfile -Command "& { ' + script + ' }"'
    if len(command) > 8000 or '"' in script:
        raise ValueError('설치 명령이 Windows CMD 제한을 초과했습니다.')
    heading = ('echo Shorts Studio custom voice setup.\r\n'
               'echo The required files will be prepared without another feature selection.\r\n') if consumer else (
               'echo Shorts Studio PC support setup. No administrator or security-policy changes are required.\r\n'
               'echo A verified Python runtime is prepared first. Model downloads require a separate choice.\r\n')
    return ('@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nset "STUDIO_SETUP_SOURCE=%~dp0"\r\n'
            + heading
            + command + '\r\nset "STUDIO_SETUP_EXIT=%errorlevel%"\r\n'
            'if not "%STUDIO_SETUP_EXIT%"=="0" echo Setup stopped. Existing files and voice recordings were not removed.\r\n'
            'pause\r\nexit /b %STUDIO_SETUP_EXIT%\r\n')


def build_package(source=ROOT, output=None):
    source, output = Path(source).absolute(), Path(output or ROOT / 'public' / 'downloads').absolute()
    manifest = source_manifest(source)
    no_links(output, output.anchor)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / ZIP_NAME
    temporary = archive.with_suffix('.zip.tmp')
    for name in (ZIP_NAME, temporary.name, INSTALLER_NAME, VOICE_INSTALLER_NAME, ZIP_NAME + '.sha256'):
        no_links(output / name, output)
    if temporary.exists():
        raise ValueError('기존 임시 파일이나 링크를 덮어쓰지 않습니다.')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for item in sorted(manifest['files'], key=lambda value: value['path']):
            content = (source / item['path']).read_bytes()
            if len(content) != item['size'] or hashlib.sha256(content).hexdigest() != item['sha256']:
                raise ValueError('패키징 중 소스가 변경되었습니다: ' + item['path'])
            info = zipfile.ZipInfo(item['path'], date_time=(2026, 1, 1, 0, 0, 0)); info.external_attr = stat.S_IFREG << 16
            bundle.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        info = zipfile.ZipInfo(MANIFEST, date_time=(2026, 1, 1, 0, 0, 0)); info.external_attr = stat.S_IFREG << 16
        bundle.writestr(info, json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
    read_package(temporary)
    digest, size = file_digest(temporary), temporary.stat().st_size
    installer = bootstrap_cmd(digest, size)
    voice_installer = bootstrap_cmd(digest, size, components=('voice',), consumer=True)
    sizes = check_release_assets(temporary.read_bytes(), installer.encode('utf-8'), voice_installer.encode('utf-8'))
    temporary.replace(archive)
    (output / INSTALLER_NAME).write_bytes(installer.encode('utf-8'))
    (output / VOICE_INSTALLER_NAME).write_bytes(voice_installer.encode('utf-8'))
    (output / (ZIP_NAME + '.sha256')).write_text(digest + '  ' + ZIP_NAME + '\n', encoding='ascii')
    return {'archive': str(archive), 'installer': str(output / INSTALLER_NAME),
            'voiceInstaller': str(output / VOICE_INSTALLER_NAME), 'sha256': digest,
            'size': size, 'files': len(manifest['files']), 'assetSizes': sizes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    print(json.dumps(build_package(args.source, args.output), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
