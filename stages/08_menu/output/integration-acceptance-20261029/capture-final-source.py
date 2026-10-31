"""Hash explicit candidate inputs; never read env values, credentials or app data."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(r"C:\Users\DELL\Desktop\Burgonomics")
OUTPUT = Path(__file__).resolve().parent
TREES = {
    "delivery": ROOT / ".swarm-worktrees/delivery-launch-ui-20261028",
    "partner": ROOT / ".swarm-worktrees/partner-launch-ui-20261029",
    "backend": ROOT / ".swarm-worktrees/backend-email-contract-20261029",
}
SCOPES = {
    "delivery": ["src", "tests", "public", "package.json", "tsconfig.json",
                 "vite.config.ts", "vite.mobile.config.ts", "vitest.config.ts",
                 "capacitor.config.ts", "android/app/build.gradle",
                 "android/app/src/main/AndroidManifest.xml"],
    "partner": ["src", "tests", "package.json", "tsconfig.json", "vite.config.ts"],
    "backend": ["functions/src", "functions/tests", "functions/package.json",
                "functions/tsconfig.json", "firestore.rules", "firebase.json"],
}


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(tree, *arguments):
    result = subprocess.run(["git", "--no-optional-locks", "-C", str(tree), *arguments],
                            capture_output=True, text=True, check=True, timeout=30)
    return result.stdout.strip()


def capture(lane):
    tree = TREES[lane]
    files = {}
    missing = []
    for scope in SCOPES[lane]:
        target = tree / scope
        if not target.exists():
            missing.append(scope)
            continue
        for path in target.rglob("*") if target.is_dir() else [target]:
            if path.is_file() and path.name != ".env" and not path.name.startswith(".env."):
                files[path.relative_to(tree).as_posix()] = sha256(path)
    return {"capturedAt": datetime.now(timezone.utc).isoformat(), "lane": lane,
            "path": str(tree), "head": git(tree, "rev-parse", "HEAD"),
            "status": git(tree, "status", "--porcelain=v1"),
            "missingOptionalInputs": missing, "files": dict(sorted(files.items()))}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lane", choices=TREES)
    parser.add_argument("tag")
    parser.add_argument("--compare", type=Path)
    args = parser.parse_args()
    if not args.tag or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for c in args.tag):
        parser.error("tag must contain only lowercase letters, digits, '-' and '_'")
    record = capture(args.lane)
    if args.compare:
        previous = json.loads(args.compare.read_text(encoding="utf-8-sig"))
        if previous.get("lane") != args.lane or previous.get("path") != record["path"]:
            parser.error("comparison must name the same lane and candidate")
        before = previous["files"]
        changed = [name for name in sorted(before.keys() | record["files"].keys())
                   if before.get(name) != record["files"].get(name)]
        record["comparison"] = {"previous": str(args.compare), "changedFiles": changed,
                                "sourceUnchanged": not changed and previous["head"] == record["head"]}
    destination = OUTPUT / f"{args.lane}-source-{args.tag}.json"
    with destination.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2)
    print(json.dumps({"file": str(destination), "sha256": sha256(destination),
                      "files": len(record["files"]), "comparison": record.get("comparison")}))
    if record.get("comparison", {}).get("sourceUnchanged") is False:
        raise SystemExit(2)
