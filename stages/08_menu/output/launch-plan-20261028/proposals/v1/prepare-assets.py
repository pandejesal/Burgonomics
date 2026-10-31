"""Copy approved internal assets and pin the licensed Inter font for offline comps."""

import hashlib
import json
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[5]
PUBLIC = ROOT / "burgonomics-foundation-core/public"
ASSETS = HERE / "assets"
COMMIT = "353b61b9f4430d5f420d56605a6e7993e0941470"
LOCAL = {
    "mascot.png": "burgonomics-logo.png",
    "burger.jpg": "images/menu/classic-burgers/hero-burger.jpg",
    "fries.jpg": "images/menu/fries/salted-fries.jpg",
    "shake.jpg": "images/menu/thick-shakes/oreo-shake.jpg",
}
REMOTE = {
    "InterVariable.woff2": ("docs/font-files/InterVariable.woff2", "5a8d3e72ad7ffb62af3b146e1b1f54ab5813a212"),
    "Inter-OFL.txt": ("LICENSE.txt", "9b2ca37b3ffc77391d8b2ebef4a974ef32bf46ea"),
}


def save(name, data):
    path = ASSETS / name
    if path.exists():
        raise RuntimeError(f"Refusing to overwrite asset: {name}")
    path.write_bytes(data)
    return {"file": "assets/" + name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main():
    manifest = HERE / "asset-manifest.json"
    if manifest.exists():
        raise RuntimeError("Asset manifest already exists; use a new revision")
    ASSETS.mkdir(parents=True, exist_ok=True)
    records = []
    for name, relative in LOCAL.items():
        source = PUBLIC / relative
        if not source.is_file():
            raise RuntimeError(f"Verified local asset no longer exists: {relative}")
        record = save(name, source.read_bytes())
        record.update({"source": str(source.relative_to(ROOT)).replace("\\", "/"), "scope": "user-approved internal v0 only; not public/store approval"})
        records.append(record)
    for name, (relative, expected_blob) in REMOTE.items():
        url = f"https://raw.githubusercontent.com/rsms/inter/{COMMIT}/{relative}"
        request = urllib.request.Request(url, headers={"User-Agent": "Burgonomics-PhaseA-asset-check"})
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError("Official Inter download failed")
            data = response.read(1_000_001)
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if blob != expected_blob:
            raise RuntimeError(f"Inter Git blob mismatch: {name}")
        if name.endswith("woff2") and data[:4] != b"wOF2":
            raise RuntimeError("Downloaded font is not WOFF2")
        record = save(name, data)
        record.update({"source": url, "gitBlobSha1": blob, "license": "SIL Open Font License 1.1; see Inter-OFL.txt"})
        records.append(record)
    manifest.write_text(json.dumps({"scope": "non-production internal mockups", "interCommit": COMMIT, "assets": records}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"assets": len(records), "manifest": str(manifest), "appSourceChanged": False}))


if __name__ == "__main__":
    main()
