"""Artifact-only integrity checks for the owned planning review packet."""

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
ROOT = HERE.parents[3]
PLAN = HERE.parent / "launch-plan-20261028"
STAGE = ROOT / "stages/08_menu"
RECHECKED = {
    "03-DELIVERY-DESIGN.md": "80885B7B86A11CA12F87A4861F308949FB7E64F8B5D8493996AB8D6749CBFE65",
    "05-BACKEND-SECURITY.md": "04F1819712E770AEE443E4EF793AB9A5F0FF5ABC3D073EA2D25535C6C2791D18",
    "08-SCHEDULE.md": "2558600E541F43E5197916756A1611877C4DBB7A2C8BE175607BF1DDBADA56AE",
    "09-ACCEPTANCE-MATRIX.md": "7BB61E2592A5C47DB96B0E94A69E9A85128BC18248495AB9193D3730E54D4F70",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest().upper()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="validation.json")
    args = parser.parse_args()
    if Path(args.output).name != args.output or not args.output.endswith(".json"):
        raise RuntimeError("Output must be a JSON filename in this review directory")
    destination = HERE / args.output
    if destination.exists():
        raise RuntimeError("Validation result exists; do not overwrite historical evidence")
    errors = []
    links = tables = 0
    files = sorted(set(PLAN.rglob("*.md")) | set(HERE.glob("*.md")) | {STAGE / "CONTEXT.md", STAGE / "output/stage_summary.md"})
    for path in files:
        text = path.read_bytes().decode("utf-8")
        if not text.endswith("\n") or any(line.rstrip() != line for line in text.splitlines()):
            errors.append(f"Whitespace/newline: {path.relative_to(ROOT)}")
        fenced = False
        table_width = None
        for line in text.splitlines():
            if line.startswith("```"):
                fenced = not fenced
                table_width = None
            elif not fenced and line.startswith("|"):
                clean = re.sub(r"`[^`]*`", "CODE", line)
                width = len(re.split(r"(?<!\\)\|", clean.strip().strip("|")))
                if table_width is None:
                    table_width = width
                    tables += 1
                elif width != table_width:
                    errors.append(f"Table width: {path.name}: {line[:90]}")
            else:
                table_width = None
        if fenced:
            errors.append(f"Unbalanced fence: {path.name}")
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            if urlsplit(target).scheme or target.startswith("#"):
                continue
            relative = unquote(target.split("#", 1)[0])
            resolved = (path.parent / relative).resolve()
            if relative and not resolved.exists() and resolved != destination.resolve():
                errors.append(f"Broken link: {path.name}: {target}")
            links += 1
    ast.parse(Path(__file__).read_text(encoding="utf-8"), filename=__file__)
    helper = PLAN / "phase-a/capture-baseline.py"
    spec = importlib.util.spec_from_file_location("capture_review_validation", helper)
    capture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capture)
    sources = capture.selected_source()
    errors.extend("Selected source drift: " + row["path"] for row in sources if not row["matches"])
    public = json.loads((HERE / "public-native-inputs.json").read_text(encoding="utf-8"))
    extra = public["additionalReadOnlySourceInputs"] + [row for native in public["native"] for row in native["sourceFingerprints"]]
    for row in extra:
        if digest(ROOT / row["file"]).lower() != row["sha256"].lower():
            errors.append("Additional source drift: " + row["file"])
    proposal = PLAN / "proposals/v1"
    assets = json.loads((proposal / "asset-manifest.json").read_text(encoding="utf-8"))
    render = json.loads((proposal / "image-manifest-r1.json").read_text(encoding="utf-8"))
    artifact_rows = assets["assets"] + render["sourceFingerprints"] + render["screenshots"] + render["contactSheets"]
    for row in artifact_rows:
        path = proposal / row["file"]
        if not path.resolve().is_relative_to(proposal) or digest(path).lower() != row["sha256"].lower():
            errors.append("Proposal artifact drift: " + row["file"])
    observation_rows = re.findall(r"^\| `(evidence/[^`]+)` \| `([0-9A-F]{64})` \|$", (PLAN / "11-VALIDATION-AND-NEXT-APPROVAL.md").read_text(encoding="utf-8"), re.M)
    if len(observation_rows) != 6:
        errors.append("Expected six original observation-image fingerprints")
    for relative, expected in observation_rows:
        if digest(PLAN / relative) != expected:
            errors.append("Observation image drift: " + relative)
    required = {
        "03-DELIVERY-DESIGN.md": ["240 UTF-16 code units", "history-chain segment", "explicit serialised handover"],
        "05-BACKEND-SECURITY.md": ["B1's first activity", "main dirty root/app checkouts", "default-denying", "zero further automatic POSTs"],
        "08-SCHEDULE.md": ["D3 early category-resolution contract → D2 Home", "does not wait for D2", "design approval **and gate C**", "24–40 hands-on hours"],
        "09-ACCEPTANCE-MATRIX.md": ["both** root and app-mirror", "rolling per-release window", "cannot satisfy G03"],
    }
    for name, fragments in required.items():
        text = (PLAN / name).read_text(encoding="utf-8")
        for fragment in fragments:
            if fragment not in text:
                errors.append(f"Missing accepted correction in {name}: {fragment}")
    reviews = (HERE / "02-MODEL-REVIEWS.md").read_text(encoding="utf-8")
    for route in ("opencode/deepseek-v4.1-flash-free", "opencode-go/deepseek-v4.1-flash", "phoenix-grove/deepseek-v4.1-flash-1017", "opencode/glm-5.3-flash-free", "nvidia/minimaxai/minimax-m3.1-flash"):
        if route not in reviews:
            errors.append("Missing exact route outcome: " + route)
    fresh = json.loads((HERE / "fresh-observations.json").read_text(encoding="utf-8"))
    baseline = json.loads((PLAN / "phase-a/baseline-snapshot.json").read_text(encoding="utf-8"))
    owned = ("stages/08_menu/output/launch-plan-20261028/phase-a/", "stages/08_menu/output/launch-plan-20261028/proposals/v1/", "stages/08_menu/output/launch-plan-review-20261028/")
    preservation = []
    for repository in fresh["repositories"]:
        root = Path(repository["path"])
        current = capture.status(root)
        original = next(row for row in baseline["repositories"] if row["group"] == repository["group"])
        before_paths = {(row["status"], row["path"]) for row in original["dirtyOverlay"] if not row["path"].startswith(owned)}
        after_paths = {(row["status"], row["path"]) for row in current if not row["path"].startswith(owned)}
        record = {"group": repository["group"], "headUnchanged": capture.git(root, "rev-parse", "HEAD").strip() == repository["head"], "stagedCount": sum(row["status"][0] not in (" ", "?") for row in current), "trackedDirtyCount": sum(row["status"] != "??" for row in current), "statusPathsUnchangedOutsideArtifactDirs": before_paths == after_paths}
        preservation.append(record)
        if not record["headUnchanged"] or record["stagedCount"] or record["trackedDirtyCount"] != repository["trackedDirty"] or before_paths != after_paths:
            errors.append("Repository metadata drift: " + repository["group"])
    scope = ["stages/08_menu/CONTEXT.md", "stages/08_menu/output/stage_summary.md"]
    diff = subprocess.run(["git", "--no-optional-locks", "-C", str(ROOT), "diff", "--check", "--", *scope], capture_output=True, text=True)
    if diff.returncode:
        errors.append("Scoped git diff --check failed")
    review_binding = [{"file": name, "reviewedSHA256": expected, "finalSHA256": digest(PLAN / name), "changedAfterRecheck": digest(PLAN / name) != expected} for name, expected in RECHECKED.items()]
    if {row["file"] for row in review_binding if row["changedAfterRecheck"]} != {"03-DELIVERY-DESIGN.md", "08-SCHEDULE.md"}:
        errors.append("Unexpected scope of final edits after independent recheck")
    fingerprints = [{"file": str(path.relative_to(ROOT)).replace("\\", "/"), "sha256": digest(path)} for path in files]
    report = {"checkedAt": datetime.now().astimezone().isoformat(timespec="seconds"), "command": "python -B stages/08_menu/output/launch-plan-review-20261028/validate-review.py", "cwd": str(ROOT), "scope": "planning/source/artifact identity only; not application tests/builds/security/native/provider/store acceptance", "markdownFiles": len(files), "localLinks": links, "tables": tables, "selectedSourceEntries": len(sources), "selectedSourceMatches": sum(row["matches"] for row in sources), "additionalSourceChecks": len(extra), "proposalArtifactChecks": len(artifact_rows), "observationImageChecks": len(observation_rows), "scopedGitDiffCheckExit": diff.returncode, "repositoryMetadataPreservation": preservation, "independentReviewBindings": review_binding, "finalMarkdownFingerprints": fingerprints, "limits": "No complete release manifest or every-unmanifested-byte preservation proof; final two LOW document edits parent-only verified. No app gate executed.", "errors": errors, "exit": 1 if errors else 0}
    destination.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "finalMarkdownFingerprints"}))
    raise SystemExit(report["exit"])


if __name__ == "__main__":
    main()
