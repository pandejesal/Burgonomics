"""Validate the supplied-document review artifacts; no provider or application calls."""

import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
PHASE = HERE.parent
ROOT = HERE.parents[5]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_documents(records, label, errors):
    for row in records:
        view = Path(row["redactedView"])
        if not view.is_file() or digest(view) != row["redactedViewSHA256"]:
            errors.append("Redacted view identity: " + label(row))
        raw = Path(row["source"])
        if not raw.is_file() or digest(raw) != row["sha256"]:
            errors.append("Original source changed: " + label(row))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="validation-current.json")
    args = parser.parse_args()
    if Path(args.output).name != args.output or not args.output.endswith(".json"):
        raise RuntimeError("Output must be a JSON filename in this directory")
    destination = HERE / args.output
    if destination.exists():
        raise RuntimeError("Validation result exists; preserve it and choose a new output name")
    errors, links, tables = [], 0, 0
    inputs = json.loads((HERE / "local-inputs.json").read_text(encoding="utf-8"))
    shadowfax = json.loads((HERE / "shadowfax-inputs.json").read_text(encoding="utf-8"))
    if [row["provider"] for row in inputs["documents"]] != ["Petpooja", "Borzo"]:
        errors.append("Expected Petpooja and Borzo in the first reviewed set")
    excluded = inputs["excludedDocuments"]
    if len(excluded) != 1 or excluded[0]["provider"] != "Shadowfax" or excluded[0]["usedForContract"] or excluded[0]["contentReadByThisHelper"]:
        errors.append("Rejected AfterShip file must remain an explicit, unread exclusion")
    if digest(HERE / "inspect-local-docs.py") != inputs["helperSHA256"]:
        errors.append("First intake helper changed after execution")
    if digest(HERE / "inspect-shadowfax-docs.py") != shadowfax["helperSHA256"]:
        errors.append("Shadowfax intake helper changed after execution")
    check_documents(inputs["documents"], lambda row: row["provider"], errors)
    check_documents(shadowfax["documents"], lambda row: row["label"], errors)
    if [row["kind"] for row in shadowfax["documents"]] != ["vendor-document", "supplied-analysis"]:
        errors.append("Shadowfax vendor document and supplied analysis must stay distinguished")
    review = HERE / "CONTRACT-REVIEW.md"
    text = review.read_text(encoding="utf-8")
    required = ["Petpooja Online Ordering APIs", "save_order", "update_order_status", "callback_url",
                "X-DV-Auth-Token", "X-DV-Signature", "order_is_duplicate", "cancel-order",
                "Hyperlocal", "hlbackend.staging.shadowfax.in", "api.shadowfax.in",
                "dispatch-ready", "ALLOTTED", "DELIVERED", "RETURNED_TO_SELLER",
                "5 minutes, up to 7 attempts", "IP whitelisting", "Petpooja bills already sync into Reelo",
                "Excluded", "AfterShip", "3 November", "8 November"]
    for fragment in required:
        if fragment not in text:
            errors.append("Missing required contract statement: " + fragment)
    leaked = re.findall(r"(?i)\b(?:app_secret|access_token|X-DV-Auth-Token|client_id)\b\s*[:=]\s*[\"'][^\"']{6,}", text)
    if leaked:
        errors.append("Possible credential-shaped value in the review document")
    for path in (review, HERE / "README.md", PHASE / "README.md"):
        body = path.read_bytes().decode("utf-8")
        if not body.endswith("\n") or any(line.rstrip() != line for line in body.splitlines()):
            errors.append("Markdown whitespace/newline: " + path.name)
        fenced, width = False, None
        for line in body.splitlines():
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
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", body):
            if urlsplit(target).scheme or target.startswith("#"):
                continue
            resolved = (path.parent / unquote(target.split("#", 1)[0])).resolve()
            if not resolved.exists() and resolved != destination:
                errors.append("Broken local link: " + path.name + ": " + target)
            links += 1
    scopes = [HERE.relative_to(ROOT).as_posix() + "/", (PHASE / "README.md").relative_to(ROOT).as_posix()]
    diff = subprocess.run(["git", "--no-optional-locks", "-C", str(ROOT), "diff", "--check", "--", *scopes],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if diff.returncode:
        errors.append("Scoped git diff --check failed")
    files = [review, HERE / "README.md", HERE / "inspect-local-docs.py", HERE / "inspect-shadowfax-docs.py", PHASE / "README.md"]
    report = {"checkedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
              "command": "python -B stages/08_menu/output/launch-plan-20261028/phase-a/provider-doc-review-20261028/validate-review.py --output " + args.output,
              "outputFile": args.output,
              "scope": "Local provider-document intake, redacted-view identity and review-document structure only; not vendor/merchant/API acceptance",
              "reviewedProviders": [row["provider"] for row in inputs["documents"]] + [row["label"] for row in shadowfax["documents"]],
              "excludedProviders": [row["provider"] for row in excluded],
              "originalDocumentsHashChecked": len(inputs["documents"]) + len(shadowfax["documents"]),
              "redactedViewsHashChecked": len(inputs["documents"]) + len(shadowfax["documents"]),
              "markdownFiles": 3, "localLinks": links, "tables": tables,
              "scopedGitDiffCheckExit": diff.returncode, "credentialPatternHits": len(leaked),
              "providerCallsMade": 0, "applicationSourceEdited": False,
              "workspaceRollbackNote": "Earlier CONTRACT-REVIEW/Shadowfax/validation files were removed by an unexplained rollback; this pass validates only files recreated on disk and does not claim the lost records survived.",
              "fingerprints": [{"file": path.relative_to(ROOT).as_posix(), "sha256": digest(path)} for path in files],
              "limits": "User-supplied documents only. Publisher version, merchant entitlement, idempotency, callback authenticity and Shadowfax staging safety remain unverified. Adapter-gap claims are supplied analysis, not vendor statements.",
              "errors": errors, "exit": 1 if errors else 0}
    with destination.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(report, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "fingerprints"}))
    raise SystemExit(report["exit"])


if __name__ == "__main__":
    main()
