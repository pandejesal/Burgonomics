"""Validate only the owned design artifacts and create a whitelist-only internal review ZIP."""

from __future__ import annotations

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
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image

HERE = Path(__file__).resolve().parent
PLAN = HERE.parents[1]
ROOT = HERE.parents[5]
PHASE_INDEX = PLAN / "phase-a/README.md"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def markdown_checks(files, prospective):
    errors, links, tables = [], 0, 0
    for path in files:
        text = path.read_bytes().decode("utf-8")
        if not text.endswith("\n") or any(line.rstrip() != line for line in text.splitlines()):
            errors.append("Markdown whitespace/newline: " + path.name)
        fenced, width = False, None
        for line in text.splitlines():
            if line.startswith("```"):
                fenced, width = not fenced, None
            elif not fenced and line.startswith("|"):
                clean = re.sub(r"`[^`]*`", "CODE", line)
                current = len(re.split(r"(?<!\\)\|", clean.strip().strip("|")))
                if width is None:
                    tables += 1
                    width = current
                elif width != current:
                    errors.append("Markdown table shape: " + path.name)
            else:
                width = None
        if fenced:
            errors.append("Markdown fence: " + path.name)
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            if urlsplit(target).scheme or target.startswith("#"):
                continue
            relative = unquote(target.split("#", 1)[0].split("?", 1)[0])
            resolved = (path.parent / relative).resolve()
            if relative and not resolved.exists() and resolved not in prospective:
                errors.append("Broken Markdown link: " + path.name + ": " + target)
            links += 1
    return {"files": len(files), "localLinks": links, "tables": tables}, errors


def team_package(revision, render, assets):
    zip_path = HERE / f"burgonomics-proposed-v2-{revision}.zip"
    manifest_path = HERE / f"team-manifest-{revision}.json"
    root_name = f"burgonomics-proposed-v2-{revision}/"
    names = ["preview.html", "catalog.js", "mockups.css", "mockups.js", render["reviewIndex"]["file"]]
    names += [row["file"] for row in assets]
    names += [row["file"] for row in render["screenshots"] + render["contactSheets"]]
    if len(names) != len(set(names)):
        raise RuntimeError("Duplicate package entries")
    data = {name: (HERE / name).read_bytes() for name in names}
    intro = f"""# Burgonomics proposed v2-{revision} — internal team review

**PROPOSED — NOT IMPLEMENTED. Synthetic data; all product controls disconnected.**

Open [the team-review index](REVIEW-{revision}.md) for 38 state pairs, 13 layout/type/spacing samples and 10 boards. Open the full PNGs before commenting; boards are scaled previews.

Reply with **v2-{revision} / full image ID / element / accept, change or hold / requested change and reason**. Record approver/date and exact approved IDs separately. No team approval is recorded in this packet.

This packet contains no accounts, real orders, live services, signing material or application source. Keep the existing assets internal; they are not approved store creative. [Inter font licence](assets/Inter-OFL.txt) is included.

PNG review needs no setup. The optional disconnected HTML preview requires a local HTTP server for font/CSP handling; serve only this extracted packet folder on loopback, never the repository root. It has no functioning login, payment, POS, stock, audio, courier booking or persistence.

The keyboard view reserves labelled space only. CSS enlarged-type/text-spacing samples are not native keyboard, Dynamic Type, browser zoom or accessibility certification. Finance/vendor, auth/security, stock/dispatch, operator/native and store gates remain unexecuted. No implementation, baseline selection, external sending, deployment or submission is authorised here.

The earlier partial run was recovered without overwriting its 45 PNGs; the current packet includes the completed revision only. The original 3 November RC / 8 November public targets are unchanged and not guaranteed.
"""
    data["START-HERE.md"] = intro.encode("utf-8")
    manifest = {"revision": "v2-" + revision, "scope": "Internal static design review only; no application/repository/account metadata",
                "files": [{"file": name, "bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()} for name, value in sorted(data.items())]}
    manifest_bytes = (json.dumps(manifest, indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    data[manifest_path.name] = manifest_bytes
    if zip_path.exists() != manifest_path.exists():
        raise RuntimeError("Incomplete package outputs exist; preserve them rather than overwrite")
    if not manifest_path.exists():
        with manifest_path.open("xb") as stream:
            stream.write(manifest_bytes)
        with ZipFile(zip_path, "x", compression=ZIP_DEFLATED, compresslevel=7) as archive:
            for name, value in sorted(data.items()):
                archive.writestr(root_name + name, value)
    elif manifest_path.read_bytes() != manifest_bytes:
        raise RuntimeError("Existing package manifest does not match current whitelist bytes")
    with ZipFile(zip_path, "r") as archive:
        if archive.testzip() is not None or set(archive.namelist()) != {root_name + name for name in data} or len(archive.namelist()) != len(data):
            raise RuntimeError("Archive CRC or entry-set mismatch")
        for name, value in data.items():
            if archive.read(root_name + name) != value:
                raise RuntimeError("Archive bytes differ: " + name)
    return {"file": zip_path.name, "sha256": digest(zip_path), "bytes": zip_path.stat().st_size,
            "entries": len(data), "crcAndAllEntryBytesVerified": True,
            "manifest": {"file": manifest_path.name, "sha256": digest(manifest_path)}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    if not re.fullmatch(r"r\d{1,3}", args.revision):
        raise RuntimeError("Use a render revision r-number")
    output_name = args.output or f"validation-{args.revision}.json"
    if Path(output_name).name != output_name or not output_name.endswith(".json"):
        raise RuntimeError("Output must be a JSON filename inside this directory")
    output = HERE / output_name
    if output.exists():
        raise RuntimeError("Result exists; preserve history and choose a new --output filename")
    errors = []
    prepared = load_module("v2_preparation_validation", "prepare-inputs.py")
    renderer = load_module("v2_render_validation", "render-mockups.py")
    capture = prepared.load_capture()
    inputs = load_json(HERE / "input-snapshot.json")
    render_path = HERE / f"image-manifest-{args.revision}.json"
    render = load_json(render_path)
    assets = load_json(HERE / "asset-manifest.json")["assets"]
    catalog = renderer.read_catalog()

    def check_rows(base, rows, label, images=False):
        for row in rows:
            path = base / row["file"]
            if not path.resolve().is_relative_to(base.resolve()) or not path.is_file() or digest(path).lower() != row["sha256"].lower():
                errors.append(label + " identity: " + row["file"])
                continue
            if images:
                with Image.open(path) as image:
                    if list(image.size) != row["pixelDimensions"]:
                        errors.append(label + " dimensions: " + row["file"])
                    image.verify()

    check_rows(HERE, render["sourceFingerprints"], "Current render source")
    check_rows(HERE, render["screenshots"] + render["contactSheets"], "Current PNG", images=True)
    check_rows(HERE, [render["reviewIndex"]] + assets, "Current index/asset")
    if not render["artifactChecksPassed"] or any(render["failures"].values()) or render["stateCount"] != 38:
        errors.append("Current render has failed observations or the wrong state count")
    if len(render["screenshots"]) != 89 or len(render["contactSheets"]) != 10 or sum(bool(row["sample"]) for row in render["screenshots"]) != 13:
        errors.append("Expected 76 paired state PNGs, 13 samples and 10 boards")
    pair_set = {(row["stateId"], row["theme"]) for row in render["screenshots"] if not row["sample"]}
    if pair_set != {(row["id"], theme) for row in catalog for theme in ("light", "dark")}:
        errors.append("Missing or unexpected light/dark state pairs")
    actual_images = {p.relative_to(HERE).as_posix() for p in (HERE / f"screenshots-{args.revision}").glob("*.png")}
    if actual_images != {row["file"] for row in render["screenshots"] + render["contactSheets"]}:
        errors.append("Image directory differs from manifest")
    previous = load_json(HERE / "image-manifest-r0.json")
    check_rows(HERE, previous["screenshots"] + previous["contactSheets"], "Retained r0 PNG", images=True)
    check_rows(HERE, [previous["reviewIndex"]], "Retained r0 index")
    recovery = render.get("interruptionRecovery")
    if recovery:
        check_rows(HERE, [recovery], "Recovery record")
        recovery_data = load_json(HERE / recovery["file"])
        check_rows(HERE, recovery_data["existingImages"], "Retained interrupted PNG")
        check_rows(HERE, recovery_data["currentSourceFingerprints"], "Recovery source binding")
        if recovery["existingCount"] != 45 or sum("exact current pixel match" in row["captureDisposition"] for row in render["screenshots"]) != 45:
            errors.append("Recovery does not bind the expected 45 retained PNGs")
    else:
        errors.append("Expected the interruption/recovery evidence for r1")
    protected_count = 0
    for tree in inputs["protectedTrees"]:
        base = ROOT / tree["directory"]
        actual = prepared.file_rows(base)
        if actual != tree["files"]:
            errors.append("Protected artifact tree changed: " + tree["directory"])
        protected_count += len(tree["files"])
    check_rows(PLAN, inputs["planInputs"], "Input planning document")
    current_sources = capture.selected_source()
    if any(not row["matches"] for row in current_sources) or current_sources != inputs["selectedSource"]:
        errors.append("Selected-source drift; no baseline may be inferred")
    check_rows(ROOT, inputs["additionalPublicSource"], "Additional public source")
    metadata = []
    owned_prefix = HERE.relative_to(ROOT).as_posix() + "/"
    owned_document = PHASE_INDEX.relative_to(ROOT).as_posix()
    for before in inputs["repositories"]:
        root = capture.REPOSITORIES[before["group"]]
        after = capture.status(root)
        def outside(rows):
            return {(row["status"], row["path"]) for row in rows if not row["path"].startswith(owned_prefix) and row["path"] != owned_document}
        row = {"group": before["group"], "headUnchanged": capture.git(root, "rev-parse", "HEAD").strip() == before["head"],
               "stagedCount": sum(item["status"][0] not in (" ", "?") for item in after),
               "trackedDirtyCount": sum(item["status"] != "??" for item in after),
               "statusPathsUnchangedOutsideOwnedArtifacts": outside(before["dirtyPaths"]) == outside(after)}
        metadata.append(row)
        if not row["headUnchanged"] or row["stagedCount"] != before["stagedCount"] or row["trackedDirtyCount"] != before["trackedDirtyCount"] or not row["statusPathsUnchangedOutsideOwnedArtifacts"]:
            errors.append("Repository metadata drift: " + before["group"])
    files = sorted(HERE.glob("*.md")) + [PHASE_INDEX]
    prospective = {output.resolve(), (HERE / f"validation-{args.revision}.json").resolve(),
                   (HERE / f"burgonomics-proposed-v2-{args.revision}.zip").resolve()}
    markdown, doc_errors = markdown_checks(files, prospective)
    errors.extend(doc_errors)
    python_files = sorted(HERE.glob("*.py"))
    for path in python_files:
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    javascript = []
    for name in ("catalog.js", "mockups.js"):
        result = subprocess.run(["node", "--check", str(HERE / name)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        javascript.append({"file": name, "command": "node --check " + name, "exit": result.returncode})
        if result.returncode:
            errors.append("Proposal JavaScript syntax: " + name + ": " + result.stderr[:300])
    diff = subprocess.run(["git", "--no-optional-locks", "-C", str(ROOT), "diff", "--check", "--", owned_prefix, owned_document],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if diff.returncode:
        errors.append("Scoped git diff --check failed")
    package = None
    if not errors:
        package = team_package(args.revision, render, assets)
    fingerprint_files = sorted(set(files + python_files + [HERE / "catalog.js", HERE / "mockups.js", HERE / "mockups.css", HERE / "preview.html", render_path]))
    report = {"checkedAt": datetime.now().astimezone().isoformat(timespec="seconds"), "revision": "v2-" + args.revision,
              "scope": "Owned mockup artifacts, partial source identity and static internal-review ZIP only; no app/native/provider/store gate",
              "command": "python -B stages/08_menu/output/launch-plan-20261028/proposals/v2/validate-packet.py --revision " + args.revision,
              "markdown": markdown, "states": len(catalog), "stateAndSamplePNGChecks": len(render["screenshots"]), "boardPNGChecks": len(render["contactSheets"]),
              "retainedR0PNGChecks": len(previous["screenshots"]) + len(previous["contactSheets"]), "protectedTreeFileChecks": protected_count,
              "selectedSourceEntries": len(current_sources), "selectedSourceMatches": sum(row["matches"] for row in current_sources),
              "additionalPublicSourceChecks": len(inputs["additionalPublicSource"]), "inputPlanDocumentChecks": len(inputs["planInputs"]),
              "repositoryMetadata": metadata, "pythonASTFiles": len(python_files), "javascriptSyntax": javascript,
              "scopedGitDiffCheckExit": diff.returncode, "interruptionRecovery": recovery,
              "parentVisualInspectionR1": ["D02-L", "P18-L", "P21-L-320-200", "P06-D-390", "D12-D-320-200", "board-discovery", "board-notes", "board-feed", "board-stock-dispatch"],
              "visualInspectionLimits": "Bounded parent-only inspection of the named images; not every PNG, no independent/team/operator approval",
              "package": package, "finalArtifactFingerprints": [{"file": path.relative_to(ROOT).as_posix(), "sha256": digest(path)} for path in fingerprint_files],
              "limits": "Partial manifests/status only, not every unmanifested byte, full release provenance or human ownership. No application tests/builds, security/native/provider acceptance or store action.",
              "errors": errors, "exit": 1 if errors else 0}
    prepared.write_json(output, report)
    print(json.dumps({key: value for key, value in report.items() if key not in ("finalArtifactFingerprints", "parentVisualInspectionR1")}))
    raise SystemExit(report["exit"])


if __name__ == "__main__":
    main()
