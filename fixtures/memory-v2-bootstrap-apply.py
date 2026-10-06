from pathlib import Path
import hashlib, json

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'src/bridge-controller.js'
MANIFEST = ROOT / 'config/safe-autonomy-manifest.json'


def abort(msg):
    raise SystemExit('MEMORY_V2_PATCH_ABORT: ' + msg)


def replace_once(text, old, new, label):
    if text.count(old) != 1:
        abort(f'{label}: expected exactly one anchor, found {text.count(old)}')
    return text.replace(old, new, 1)

# MEMORY_V2_PATCH_BODY