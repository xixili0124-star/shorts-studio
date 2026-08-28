"""Private provider settings, including migration of the original GPT setup."""
import json
from pathlib import Path
import re

PROVIDERS = {'gpt-sovits': ('GPT-SoVITS', 'v2ProPlus'), 'voxcpm2': ('VoxCPM2', 'VoxCPM2-2B')}


def provider_of(settings):
    if not isinstance(settings, dict):
        raise ValueError('Invalid PC voice settings')
    provider = settings.get('provider', 'gpt-sovits')
    if not isinstance(provider, str) or provider not in PROVIDERS:
        raise ValueError('Unknown PC voice provider')
    return provider


def read_config(path):
    path = Path(path)
    if path.is_symlink() or path.stat().st_size > 16384:
        raise ValueError('Invalid PC voice settings')
    settings = json.loads(path.read_text(encoding='utf-8'))
    provider_of(settings)
    key = settings.get('engineKey', '')
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key):
        raise ValueError('Invalid private engine credential')
    return settings


def settings_path(local, provider='auto'):
    local = Path(local)
    active = local / 'pc-voice.json'
    if provider == 'auto':
        return active
    if provider not in PROVIDERS:
        raise ValueError('Unknown PC voice provider')
    saved = local / ('pc-voice-' + provider + '.json')
    try:
        if provider_of(read_config(active)) == provider:
            return active
    except FileNotFoundError:
        pass
    if saved.is_file() and provider_of(read_config(saved)) != provider:
        raise ValueError('Selected PC voice provider does not match its saved settings')
    return saved


def activate_config(local, settings):
    """Call only after installation succeeds; never touch the shared references."""
    local = Path(local)
    local.mkdir(parents=True, exist_ok=True)
    provider = provider_of(settings)
    key = settings.get('engineKey', '')
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key):
        raise ValueError('Invalid private engine credential')
    active = local / 'pc-voice.json'
    encoded = json.dumps(settings, ensure_ascii=False, indent=2).encode('utf-8')
    if len(encoded) > 16384:
        raise ValueError('Invalid PC voice settings')
    # Preserve the exact previous bytes, including the old provider's key.
    if active.exists():
        previous = read_config(active)
        previous_provider = provider_of(previous)
        if previous_provider != provider:
            backup = local / ('pc-voice-' + previous_provider + '.json')
            temporary = backup.with_suffix('.json.tmp')
            temporary.write_bytes(active.read_bytes())
            temporary.replace(backup)
    saved = local / ('pc-voice-' + provider + '.json')
    temporary = saved.with_suffix('.json.tmp')
    temporary.write_bytes(encoded)
    temporary.replace(saved)
    temporary = active.with_suffix('.json.tmp')
    temporary.write_bytes(encoded)
    temporary.replace(active)


def service_identity(local, provider='auto'):
    """An incomplete install must not prevent ordinary browser editing."""
    try:
        settings = read_config(settings_path(local, provider))
        return provider_of(settings), settings['engineKey']
    except (OSError, ValueError, TypeError):
        return ('voxcpm2' if provider == 'auto' else provider), None
