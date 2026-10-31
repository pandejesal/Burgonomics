"""Capture source identities only; never load configuration secrets or app data."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import subprocess

ROOT = Path(r"C:\Users\DELL\Desktop\Burgonomics")
OUT = Path(__file__).resolve().parent
TREES = {
    "backend": ROOT / ".swarm-worktrees/backend-email-contract-20261029",
    "delivery": ROOT / ".swarm-worktrees/delivery-launch-ui-20261028",
    "partner": ROOT / ".swarm-worktrees/partner-launch-ui-20261029",
}
SCOPES = {
    "backend": ["functions/src", "functions/tests", "firestore.rules", "firebase.json", "functions/package.json"],
    "delivery": ["src/features/auth", "src/core/config/firebase.ts", "src/routes/auth.otp.tsx", "tests", "firestore.rules", "package.json"],
    "partner": ["src/stores/authStore.ts", "src/config/firebase.ts", "tests/auth-rbac.test.ts", "tests/auth-failclosed.test.ts", "firestore.rules", "package.json"],
}

def git(tree, *args):
    result = subprocess.run(["git", "--no-optional-locks", "-C", str(tree), *args],
                            text=True, capture_output=True, timeout=30, check=True)
    return result.stdout.strip()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

record = {"capturedAt": datetime.now(timezone.utc).isoformat(), "trees": {},
          "rootRulesSha256": digest(ROOT / "firestore.rules")}
for name, tree in TREES.items():
    files = {}
    for scope in SCOPES[name]:
        target = tree / scope
        paths = target.rglob("*") if target.is_dir() else [target]
        for path in paths:
            if path.is_file() and path.suffix in {".ts", ".tsx", ".rules", ".json"}:
                files[path.relative_to(tree).as_posix()] = digest(path)
    record["trees"][name] = {"path": str(tree), "head": git(tree, "rev-parse", "HEAD"),
                             "status": git(tree, "status", "--porcelain=v1"), "files": files}
dest = OUT / "baseline.json"
with dest.open("x", encoding="utf-8") as stream:
    json.dump(record, stream, indent=2)
print(json.dumps({"file": str(dest), "sha256": digest(dest),
                  "files": {name: len(data["files"]) for name, data in record["trees"].items()}}, indent=2))
