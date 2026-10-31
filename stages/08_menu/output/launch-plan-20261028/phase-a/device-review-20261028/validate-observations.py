"""Artifact-only checks; no device, cloud, application test/build or provider calls."""

import ast
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

from PIL import Image

HERE = Path(__file__).resolve().parent
PHASE = HERE.parent
PLAN = HERE.parents[1]
ROOT = HERE.parents[5]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    destination = HERE / "validation.json"
    if destination.exists():
        raise RuntimeError("Artifact result exists; preserve historical evidence")
    errors, links, tables = [], 0, 0
    manifest_path = HERE / "image-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if len(manifest["images"]) != 5:
        errors.append("Expected five prepared consumer observation crops")
    raw_root = Path(manifest["rawCaptureRoot"])
    for row in manifest["images"]:
        path = HERE / row["file"]
        raw = raw_root / row["rawRelativePath"]
        if not path.resolve().is_relative_to(HERE) or digest(path) != row["sha256"]:
            errors.append("Cropped observation identity: " + row["file"])
        if not raw.resolve().is_relative_to(raw_root) or digest(raw) != row["rawSHA256"]:
            errors.append("Raw observation identity: " + row["file"])
        with Image.open(path) as image:
            if list(image.size) != row["pixelDimensions"]:
                errors.append("Cropped dimensions: " + row["file"])
            image.verify()
    if digest(HERE / "prepare-images.py") != manifest["helperSHA256"]:
        errors.append("Observation preparation helper changed after execution")
    excluded = HERE / "delivery-black-frame.png"
    if digest(excluded) != "5f12ea0c5fb596346d3ef9a0068306fe6b74a5eccd1a9ad8db7ad662d614a145":
        errors.append("Excluded interrupted frame identity changed")
    files = [HERE / "README.md", PHASE / "README.md", PHASE / "ORIGINAL-BRIEF-RESUMPTION-20261028.md"]
    for path in files:
        text = path.read_bytes().decode("utf-8")
        if not text.endswith("\n") or any(line.rstrip() != line for line in text.splitlines()):
            errors.append("Markdown whitespace/newline: " + path.name)
        fenced, width = False, None
        for line in text.splitlines():
            if line.startswith("```"):
                fenced, width = not fenced, None
            elif not fenced and line.startswith("|"):
                cleaned = re.sub(r"`[^`]*`", "CODE", line)
                current = len(re.split(r"(?<!\\)\|", cleaned.strip().strip("|")))
                if width is None:
                    tables += 1
                    width = current
                elif current != width:
                    errors.append("Markdown table shape: " + path.name)
            else:
                width = None
        if fenced:
            errors.append("Markdown fence: " + path.name)
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            if urlsplit(target).scheme or target.startswith("#"):
                continue
            resolved = (path.parent / unquote(target.split("#", 1)[0])).resolve()
            if not resolved.exists() and resolved != destination:
                errors.append("Broken local link: " + path.name + ": " + target)
            links += 1
    python_files = sorted(HERE.glob("*.py"))
    for path in python_files:
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    old_validation = json.loads((PLAN / "proposals/v2/validation-r1.json").read_text(encoding="utf-8"))
    zip_row = old_validation["package"]
    zip_matches = digest(PLAN / "proposals/v2" / zip_row["file"]) == zip_row["sha256"]
    if not zip_matches:
        errors.append("Completed v2-r1 review ZIP identity changed")
    scopes = [(HERE.relative_to(ROOT).as_posix() + "/"), (PHASE / "README.md").relative_to(ROOT).as_posix(),
              (PHASE / "ORIGINAL-BRIEF-RESUMPTION-20261028.md").relative_to(ROOT).as_posix()]
    diff = subprocess.run(["git", "--no-optional-locks", "-C", str(ROOT), "diff", "--check", "--", *scopes],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if diff.returncode:
        errors.append("Scoped git diff --check failed")
    fingerprints = files + python_files + [manifest_path]
    report = {"checkedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
              "command": "python -B stages/08_menu/output/launch-plan-20261028/phase-a/device-review-20261028/validate-observations.py",
              "scope": "Only new observation documents/images/helper syntax and retained ZIP identity; no application/native/provider acceptance",
              "markdownFiles": len(files), "localLinks": links, "tables": tables, "preparedImageChecks": len(manifest["images"]),
              "rawImageHashChecks": len(manifest["images"]), "excludedInterruptedFrameChecked": True,
              "pythonASTFiles": len(python_files), "scopedGitDiffCheckExit": diff.returncode,
              "previousV2ReviewZipUnchanged": zip_matches,
              "parentCropInspection": [row["file"] for row in manifest["images"]],
              "privacyScope": "Five crops visually inspected; no personal header/greeting/status/favourites content retained. No raw hierarchy or operational records archived.",
              "deviceScope": "One Android phone; two Delivery gestures and selected consumer views; Partner entry keywords only. No APK/source binding, iOS/native matrix or operational acceptance.",
              "sourceAndApplicationGates": "Application source not edited. Existing 118-source/14-public-source results remain historical; not rerun here. No app typecheck, unit suite, build, emulator, live backend/payment/POS/dispatch/signing/store action.",
              "fingerprints": [{"file": path.relative_to(ROOT).as_posix(), "sha256": digest(path)} for path in fingerprints],
              "errors": errors, "exit": 1 if errors else 0}
    with destination.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(report, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "fingerprints"}))
    raise SystemExit(report["exit"])


if __name__ == "__main__":
    main()
