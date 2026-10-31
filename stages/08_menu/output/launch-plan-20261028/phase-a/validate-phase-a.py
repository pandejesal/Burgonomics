"""Verify this documentation/mockup packet without running either application."""

import argparse
import ast
import hashlib
import importlib.util
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
PLAN = HERE.parent
ROOT = HERE.parents[4]
PROPOSAL = PLAN / "proposals/v1"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="validation.json")
    args = parser.parse_args()
    if Path(args.output).name != args.output or not args.output.endswith(".json"):
        raise RuntimeError("Validation output must be a JSON filename in Phase A")
    destination = HERE / args.output
    if destination.exists():
        raise RuntimeError("Refusing to overwrite the validation record")
    errors, links, tables = [], 0, 0
    docs = sorted(PLAN.rglob("*.md")) + [ROOT / "stages/08_menu/CONTEXT.md", ROOT / "stages/08_menu/output/stage_summary.md"]
    for path in docs:
        raw = path.read_bytes()
        text = raw.decode("utf-8")
        if not raw.endswith(b"\n") or any(line.rstrip() != line for line in text.splitlines()):
            errors.append(f"Whitespace/newline: {path.name}")
        if sum(line.startswith("```") for line in text.splitlines()) % 2:
            errors.append(f"Unbalanced fence: {path.name}")
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            if urlsplit(target).scheme or target.startswith("#"):
                continue
            relative = unquote(target.split("#", 1)[0])
            if relative and not (path.parent / relative).exists():
                errors.append(f"Broken relative link in {path.name}: {target}")
            links += 1
        previous = False
        for line in text.splitlines():
            row = line.startswith("|")
            if row and not previous:
                tables += 1
            previous = row
    for script in (HERE / "capture-baseline.py", HERE / "validate-phase-a.py", PROPOSAL / "prepare-assets.py", PROPOSAL / "render-mockups.py"):
        ast.parse(script.read_text(encoding="utf-8"), filename=str(script))
    checked = subprocess.run(["node", "--check", str(PROPOSAL / "mockups.js")], capture_output=True, text=True)
    if checked.returncode:
        errors.append("Mockup JavaScript syntax check failed")
    assets = json.loads((PROPOSAL / "asset-manifest.json").read_text())
    render = json.loads((PROPOSAL / "image-manifest-r1.json").read_text())
    hash_count = 0
    for row in assets["assets"] + render["sourceFingerprints"] + render["screenshots"] + render["contactSheets"]:
        path = PROPOSAL / row["file"]
        if not path.resolve().is_relative_to(PROPOSAL) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
            errors.append(f"Artifact fingerprint: {row['file']}")
        hash_count += 1
    if render["pageErrors"] or render["externalRequestsBlocked"] or not all(r["local"] and r["method"] == "GET" for r in render["requests"]):
        errors.append("Mockup render network/page error")
    for row in render["screenshots"]:
        observed = row["layoutObservation"]
        if observed["pageWidth"] > row["viewportWidth"] or observed["clipping"] or observed["smallTargets"] or observed["placeholderOcclusion"]:
            errors.append(f"Mockup layout observation: {row['id']}")
        if row["screen"] == "cart-note" and observed["noteFields"] != 1:
            errors.append(f"Cooking note count: {row['id']}")
    if any(not row["passes"] for group in render["contrastTokenChecks"].values() for row in group):
        errors.append("Token contrast threshold failed")
    spec = importlib.util.spec_from_file_location("phase_a_capture", HERE / "capture-baseline.py")
    capture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capture)
    sources = capture.selected_source()
    if not all(row["matches"] for row in sources):
        errors.extend("Selected source drift: " + row["path"] for row in sources if not row["matches"])
    baseline = json.loads((HERE / "baseline-snapshot.json").read_text())
    preservation = []
    own = ("stages/08_menu/output/launch-plan-20261028/phase-a/", "stages/08_menu/output/launch-plan-20261028/proposals/v1/")
    for repository in baseline["repositories"]:
        root = Path(repository["path"])
        head = capture.git(root, "rev-parse", "HEAD").strip()
        current = capture.status(root)
        staged = sum(row["status"][0] not in (" ", "?") for row in current)
        before = {(row["status"], row["path"]) for row in repository["dirtyOverlay"] if not row["path"].startswith(own)}
        after = {(row["status"], row["path"]) for row in current if not row["path"].startswith(own)}
        record = {"group": repository["group"], "headUnchanged": head == repository["head"], "stagedCount": staged, "statusPathsUnchangedOutsideOwnedArtifactDirectories": before == after}
        preservation.append(record)
        if not record["headUnchanged"] or staged or before != after:
            errors.append("Repository metadata changed outside Phase A: " + repository["group"])
    report = {"checkedAt": datetime.now().astimezone().isoformat(timespec="seconds"), "scope": "Phase A artifacts only; no application/package/provider/native/store gate", "markdownFiles": len(docs), "relativeLinks": links, "tables": tables, "artifactFingerprintChecks": hash_count, "sourceEntries": len(sources), "sourceMatches": sum(r["matches"] for r in sources), "pythonHelpersParsed": 4, "mockupJavaScriptSyntaxExit": checked.returncode, "renderRevision": render["revision"], "reviewRenders": len(render["screenshots"]), "reviewBoards": len(render["contactSheets"]), "contrastChecks": sum(len(rows) for rows in render["contrastTokenChecks"].values()), "repositoryMetadataPreservation": preservation, "limits": "Status-path equality does not prove every unmanifested byte is unchanged; no ownership or release baseline inferred. Earlier render retained as superseded.", "errors": errors, "exit": 1 if errors else 0}
    destination.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps(report))
    raise SystemExit(report["exit"])


if __name__ == "__main__":
    main()
