"""Snapshot approved planning inputs; copy only the six verified local mockup assets."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLAN = HERE.parents[1]
ROOT = HERE.parents[5]
V1 = HERE.parent / "v1"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, indent=2, ensure_ascii=True) + "\n")


def file_rows(directory):
    return [{"file": path.relative_to(directory).as_posix(), "sha256": digest(path)}
            for path in sorted(directory.rglob("*")) if path.is_file()]


def load_capture():
    helper = PLAN / "phase-a/capture-baseline.py"
    if not helper.is_file():
        raise RuntimeError("Verified Phase A helper is missing")
    spec = importlib.util.spec_from_file_location("v2_capture", helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    destinations = [HERE / name for name in ("input-snapshot.json", "asset-manifest.json", "assets")]
    if any(path.exists() for path in destinations):
        raise RuntimeError("Input evidence/assets already exist; refusing to overwrite")
    manifest = json.loads((V1 / "asset-manifest.json").read_text(encoding="utf-8"))
    expected = {"mascot.png", "burger.jpg", "fries.jpg", "shake.jpg", "InterVariable.woff2", "Inter-OFL.txt"}
    if {Path(row["file"]).name for row in manifest["assets"]} != expected:
        raise RuntimeError("Unexpected asset set; owner review needed")
    for row in manifest["assets"]:
        path = V1 / row["file"]
        if not path.is_file() or not path.resolve().is_relative_to(V1) or digest(path).lower() != row["sha256"].lower():
            raise RuntimeError("Prior approved asset identity mismatch: " + row["file"])
    capture = load_capture()
    selected = capture.selected_source()
    if any(not row["matches"] for row in selected):
        raise RuntimeError("Selected source drift; preserve and investigate before continuing")
    public_path = PLAN.parent / "launch-plan-review-20261028/public-native-inputs.json"
    public = json.loads(public_path.read_text(encoding="utf-8"))
    extras = public["additionalReadOnlySourceInputs"] + [row for native in public["native"] for row in native["sourceFingerprints"]]
    for row in extras:
        path = ROOT / row["file"]
        if not path.is_file() or capture.EXCLUDED.search(row["file"]) or digest(path).lower() != row["sha256"].lower():
            raise RuntimeError("Additional public source identity mismatch: " + row["file"])
    repositories = []
    for group, root in capture.REPOSITORIES.items():
        entries = capture.status(root)
        repositories.append({"group": group, "head": capture.git(root, "rev-parse", "HEAD").strip(),
                             "stagedCount": sum(row["status"][0] not in (" ", "?") for row in entries),
                             "trackedDirtyCount": sum(row["status"] != "??" for row in entries),
                             "dirtyPaths": entries})
    protected = [{"directory": V1.relative_to(ROOT).as_posix(), "files": file_rows(V1)},
                 {"directory": (PLAN.parent / "launch-plan-review-20261028").relative_to(ROOT).as_posix(),
                  "files": file_rows(PLAN.parent / "launch-plan-review-20261028")}]
    plan_inputs = ["03-DELIVERY-DESIGN.md", "04-PARTNER-DESIGN.md", "01-DECISIONS-AND-OWNERSHIP.md", "05-BACKEND-SECURITY.md"]
    snapshot = {"capturedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
                "scope": "v2 artifact input identity only; no baseline adoption or private material",
                "protectedTrees": protected, "selectedSource": selected, "additionalPublicSource": extras,
                "repositories": repositories,
                "planInputs": [{"file": name, "sha256": digest(PLAN / name)} for name in plan_inputs],
                "limits": "Partial source manifests and Git metadata, not proof of every unmanifested byte or human ownership. No source/worktree is adopted."}
    (HERE / "assets").mkdir()
    reused = []
    for row in manifest["assets"]:
        destination = HERE / row["file"]
        destination.write_bytes((V1 / row["file"]).read_bytes())
        reused.append({"file": row["file"], "sha256": digest(destination), "bytes": destination.stat().st_size,
                       "copiedFrom": "../v1/" + row["file"], "originalSource": row.get("source"),
                       "scope": "Previously approved assets reused for internal mockups only; not public/store approval"})
    write_json(HERE / "asset-manifest.json", {"scope": "non-production internal v2 mockups", "interCommit": manifest["interCommit"], "assets": reused})
    write_json(HERE / "input-snapshot.json", snapshot)
    print(json.dumps({"reusedAssets": len(reused), "selectedSourceMatches": len(selected), "additionalSourceMatches": len(extras),
                      "protectedTreeFiles": sum(len(row["files"]) for row in protected),
                      "repositories": [{k: row[k] for k in ("group", "head", "stagedCount", "trackedDirtyCount")} for row in repositories]}))


if __name__ == "__main__":
    main()
