"""Read-only Git/source inventory; writes only the new Phase A JSON artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
OUTPUT = Path(__file__).resolve().parent
PLAN = OUTPUT.parent
REPOSITORIES = {
    "G-ROOT": ROOT,
    "G-DELIVERY": ROOT / "burgonomics-foundation-core",
    "G-PARTNER": ROOT / "burgonomics-partner",
}
EXCLUDED = re.compile(
    r"(^|/)(\.env(?:\..*)?|auth\.json|credentials?[^/]*|secrets?[^/]*|"
    r"key(?:store)?\.properties|local\.properties|google-services\.json|"
    r"GoogleService-Info\.plist)$|\.(jks|keystore|p12|pfx|pem|key|mobileprovision)$",
    re.I,
)


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "--no-optional-locks", "-C", str(root), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Git metadata failed at {root}: {result.stderr[:200]}")
    return result.stdout


def status(root: Path) -> list[dict]:
    parts = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0")
    records = []
    index = 0
    while index < len(parts) and parts[index]:
        entry = parts[index]
        record = {"status": entry[:2], "path": entry[3:]}
        if "R" in entry[:2] or "C" in entry[:2]:
            index += 1
            record["originalPath"] = parts[index]
        record["owner"] = "unresolved; status is not authorship or authorisation"
        record["contentExcluded"] = bool(EXCLUDED.search(record["path"]))
        records.append(record)
        index += 1
    return records


def worktrees(root: Path) -> list[dict]:
    result = []
    for block in git(root, "worktree", "list", "--porcelain").strip().split("\n\n"):
        if not block:
            continue
        row = dict(line.split(" ", 1) if " " in line else (line, True) for line in block.splitlines())
        row["owner"] = "unresolved; branch/path name is not ownership evidence"
        row["selectedForRelease"] = False
        result.append(row)
    return result


def selected_source() -> list[dict]:
    text = (PLAN / "10-SOURCE-FINGERPRINTS.md").read_text(encoding="utf-8-sig")
    group = None
    records = []
    for line in text.splitlines():
        if line.startswith("## G-"):
            group = line[3:]
        elif line.startswith("## Supplemental"):
            group = "supplemental"
        match = re.fullmatch(r"([0-9A-F]{64})  (.+)", line)
        if not match:
            continue
        expected, relative = match.groups()
        if EXCLUDED.search(relative):
            raise RuntimeError(f"Sensitive path refused: {relative}")
        base = ROOT if group == "supplemental" else REPOSITORIES[group]
        path = base / relative
        if not path.is_file() or not path.resolve().is_relative_to(ROOT):
            records.append({"group": group, "path": relative, "matches": False, "reason": "missing/outside workspace"})
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest().upper()
        records.append({"group": group, "path": relative, "expected": expected, "observed": actual, "matches": actual == expected})
    if len(records) != 118:
        raise RuntimeError(f"Expected 118 planning entries, got {len(records)}")
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="baseline-snapshot.json")
    args = parser.parse_args()
    destination = OUTPUT / args.output
    if destination.exists() or destination.parent != OUTPUT:
        raise RuntimeError("Refusing to replace an existing snapshot or write outside Phase A")
    captured = datetime.now().astimezone().isoformat(timespec="seconds")
    repositories = []
    for group, root in REPOSITORIES.items():
        entries = status(root)
        trees = worktrees(root)
        repositories.append({
            "group": group, "path": str(root), "head": git(root, "rev-parse", "HEAD").strip(),
            "branch": git(root, "branch", "--show-current").strip(),
            "stagedCount": sum(row["status"][0] not in (" ", "?") for row in entries),
            "trackedDirtyCount": sum(row["status"] != "??" for row in entries),
            "untrackedCount": sum(row["status"] == "??" for row in entries),
            "dirtyOverlay": entries, "worktrees": trees, "releaseBaselineApproved": False,
        })
    candidate = ROOT / ".swarm-worktrees/petpooja-vendor-contract-20261028"
    manifest_path = candidate / "stages/05_orders/output/petpooja-vendor-review-20261028/candidate-manifest.json"
    candidate_record = {"path": str(candidate), "ownerSession": "ses_e94d6379dffePDVml2TD7LGSxA", "selectedForRelease": False}
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        files = []
        for row in manifest["candidateFiles"]:
            path = candidate / row["file"]
            if EXCLUDED.search(row["file"]) or not path.resolve().is_relative_to(candidate):
                raise RuntimeError("Refusing unsafe candidate path")
            files.append({"path": row["file"], "matchesRecordedHash": path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == row["sha256"]})
        candidate_record.update({"base": manifest["baseCommit"], "head": git(candidate, "rev-parse", "HEAD").strip(), "files": files, "dirtyOverlay": status(candidate), "limits": "uncommitted, not integrated/deployed; official current vendor documentation review and sandbox acceptance outstanding"})
    report = {
        "capturedAt": captured, "scope": "Phase A read-only metadata and selected-source inventory; not a complete release manifest",
        "privateMaterialPolicy": "No environment/private signing/credential contents or private-material hashes captured; dirty-path metadata only",
        "repositories": repositories, "selectedSourceRecheck": selected_source(), "petpoojaCandidate": candidate_record,
        "ownershipLimits": "No author inferred from Git status, branch names or shared session snapshots. Existing writers/overlay owners require owner confirmation. No worktree adopted or changed.",
        "releaseBaselineApproved": False,
    }
    destination.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(destination), "capturedAt": captured, "sourceEntries": len(report["selectedSourceRecheck"]), "sourceMatches": sum(r["matches"] for r in report["selectedSourceRecheck"]), "worktrees": sum(len(r["worktrees"]) for r in repositories), "candidateMatches": sum(r["matchesRecordedHash"] for r in candidate_record.get("files", []))}))


if __name__ == "__main__":
    main()
