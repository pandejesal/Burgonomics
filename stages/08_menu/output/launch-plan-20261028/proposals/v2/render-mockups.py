"""Render isolated v2 design sheets. Never load an application, account or backend."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import textwrap
import threading
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from PIL import Image, ImageChops, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
TEMP = Path(r"C:\Users\DELL\AppData\Local\Temp\opencode")
SOURCES = ["preview.html", "catalog.js", "mockups.css", "mockups.js", "render-mockups.py", "prepare-inputs.py",
           "DESIGN.md", "COVERAGE.md", "brand-spec.md", "asset-manifest.json", "input-snapshot.json"]
EXTRAS = [
    ("D01", "light", 320, 1, False, "320"),
    ("D01", "dark", 768, 1, False, "768"),
    ("D01", "light", 320, 2, False, "320-200"),
    ("D04", "dark", 320, 2, False, "320-200"),
    ("D12", "dark", 320, 2, False, "320-200"),
    ("D12", "light", 390, 1, True, "390-spacing"),
    ("D14", "light", 320, 1, False, "320"),
    ("D17", "dark", 320, 2, False, "320-200"),
    ("P05", "light", 320, 1, False, "320"),
    ("P06", "dark", 390, 1, False, "390"),
    ("P16", "light", 320, 2, False, "320-200"),
    ("P19", "dark", 390, 1, True, "390-spacing"),
    ("P21", "light", 320, 2, False, "320-200"),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_catalog():
    text = (HERE / "catalog.js").read_text(encoding="utf-8")
    match = re.fullmatch(r'"use strict";\s*//[^\n]*\nwindow\.PROPOSED_STATES = (\[.*\]);\s*', text, re.S)
    if not match:
        raise RuntimeError("Catalog must remain a JSON-compatible assignment")
    catalog = json.loads(match[1])
    if len(catalog) != 38 or len({row["id"] for row in catalog}) != 38 or len({row["key"] for row in catalog}) != 38:
        raise RuntimeError("Expected 38 unique, explicitly scoped design states")
    return catalog


class LocalOnlyHandler(SimpleHTTPRequestHandler):
    allowed = {"/preview.html", "/catalog.js", "/mockups.js", "/mockups.css"}

    def do_GET(self):
        if urlsplit(self.path).path not in self.allowed:
            self.send_error(404)
            return
        super().do_GET()

    def log_message(self, *args):
        pass


def luminance(value):
    channels = [int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4 for x in channels]
    return sum(x * weight for x, weight in zip(linear, (.2126, .7152, .0722)))


def contrast_checks(tokens):
    pairs = [(fg, bg, 4.5) for fg in ("ink", "muted", "primary-text", "accent") for bg in ("canvas", "surface", "elevated")]
    pairs += [("on-primary", "primary", 4.5), ("warning-ink", "warning-surface", 4.5), ("positive-ink", "positive-surface", 4.5)]
    pairs += [(fg, bg, 3) for fg in ("control-line", "focus") for bg in ("canvas", "surface", "elevated")]
    result = []
    for fg, bg, minimum in pairs:
        low, high = sorted((luminance(tokens[fg]), luminance(tokens[bg])))
        ratio = (high + .05) / (low + .05)
        result.append({"foreground": fg, "background": bg, "ratio": ratio, "threshold": minimum, "passes": ratio >= minimum})
    return result


def board(rows, destination, title, revision):
    columns, cell_width, cell_height = 4, 352, 760
    canvas = Image.new("RGB", (columns * cell_width + 32, ((len(rows) + columns - 1) // columns) * cell_height + 100), "#f5f7f5")
    draw = ImageDraw.Draw(canvas)
    fontpath = Path(r"C:\Windows\Fonts\segoeui.ttf")
    if not fontpath.is_file():
        raise RuntimeError("Local board-label font is unavailable")
    heading_font = ImageFont.truetype(str(fontpath), 22)
    label_font = ImageFont.truetype(str(fontpath), 16)
    draw.text((20, 12), f"PROPOSED v2-{revision} — {title} — NOT IMPLEMENTED", fill="#16281d", font=heading_font)
    draw.text((20, 46), "Synthetic design data. Full uncropped PNGs in the image index; no app/native/provider acceptance.", fill="#586b60", font=label_font)
    for index, row in enumerate(rows):
        x = 20 + index % columns * cell_width
        y = 94 + index // columns * cell_height
        label = f'{row["id"]} / {row["viewportWidth"]}px / {row["textScale"] * 100}%'
        draw.text((x, y), label, fill="#16281d", font=label_font)
        for line_index, line in enumerate(textwrap.wrap(row["title"], width=37)):
            draw.text((x, y + 24 + 21 * line_index), line, fill="#586b60", font=label_font)
        with Image.open(HERE / row["file"]) as original:
            panel = original.convert("RGB")
            panel.thumbnail((320, 642), Image.Resampling.LANCZOS)
            canvas.paste(panel, (x + (320 - panel.width) // 2, y + 86))
    canvas.save(destination)


METRICS = """() => {
  const visible = e => e.getClientRects().length && !e.closest('.review-tools');
  const describe = e => ({tag:e.tagName, text:e.textContent.trim().slice(0,110)});
  const measured = [...document.querySelectorAll('h1,h2,h3,p,button,dt,dd,label,.notice-title,.proposal,.shortcut-caption')].filter(visible);
  const tokens = Object.fromEntries(['canvas','surface','elevated','ink','muted','primary','on-primary','primary-text','accent','warning-surface','warning-ink','positive-surface','positive-ink','control-line','focus'].map(k => [k,getComputedStyle(document.documentElement).getPropertyValue('--'+k).trim()]));
  const note = document.querySelector('#cooking-note');
  return {
    pageWidth:document.documentElement.scrollWidth,
    interLoaded:document.fonts.check('16px Inter'),
    fontSize:getComputedStyle(document.documentElement).fontSize,
    disclaimer:document.querySelector('.proposal').textContent,
    clipping:measured.filter(e => !e.closest('.jump-strip,.partner-nav') && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)).map(describe),
    outsidePage:measured.filter(e => !e.closest('.jump-strip,.partner-nav') && (e.getBoundingClientRect().left < -1 || e.getBoundingClientRect().right > innerWidth+1)).map(describe),
    smallTargets:[...document.querySelectorAll('button')].filter(visible).filter(e => e.getBoundingClientRect().width < 43.99 || e.getBoundingClientRect().height < 43.99).map(describe),
    placeholderOcclusion:[...document.querySelectorAll('.photo-placeholder')].filter(e => {const a=e.getBoundingClientRect(),b=e.closest('.shortcut-media').getBoundingClientRect(); return a.bottom > b.bottom+1 || a.top < b.top-1;}).map(describe),
    shortcutCount:document.querySelectorAll('.shortcut').length,
    noteFields:document.querySelectorAll('textarea').length,
    noteValueUnits:note ? note.value.length : null,
    noteReadOnly:note ? note.readOnly : null,
    noteCounter:document.querySelector('#note-count')?.textContent || null,
    historyRail:!!document.querySelector('.history'),
    deniedRecordNodes:document.querySelectorAll('.ticket,.partner-outlet,.facts').length,
    outletContext:document.querySelector('.outlet strong,.partner-outlet strong')?.textContent || null,
    activeNavHidden:[...document.querySelectorAll('.partner-nav [aria-current="page"],.jump-strip [aria-current="true"]')].filter(e => {const b=e.getBoundingClientRect(),r=e.parentElement.getBoundingClientRect();return b.left<r.left-1 || b.right>r.right+1;}).map(describe),
    reservedKeyboard:!!document.querySelector('.keyboard-space'),
    choices:document.querySelectorAll('[role="radio"]').length,
    current:window.PROPOSED_CURRENT,
    tokens
  };
}"""


def make_index(path, revision, catalog, renders, boards, passed):
    lines = [f"# Burgonomics proposed v2-{revision} — team review", "",
             "**PROPOSED — NOT IMPLEMENTED. Internal only. Synthetic data; product controls are disconnected.**", "",
             f"{len(catalog)} states, {len(renders)} PNGs including representative layout/type/spacing studies, and {len(boards)} boards.", "",
             "Artifact render checks: **" + ("passed within the recorded scope" if passed else "failed — do not treat this as the current clean packet") + "**. No app/security/native/provider/store gate is run or passed.", "",
             "## How to review", "", "1. Scan the relevant board, then open its full-resolution PNG. Boards are scaled previews, not cropped replacements.",
             f"2. Reply with `v2-{revision} / full image ID / element / accept, change or hold / requested change and reason`.",
             "3. Record exact image IDs, approver and date. Visual approval is separate from implementation permission, baseline/signing custody and operator acceptance.", "",
             "Focus: guest/no-history versus returning Cart; one 240-UTF-16-unit client-ceiling note; calm paid/POS-pending copy; stale versus empty feeds; invitation denials; stock/POS and courier certainty.", "",
             "Missing verified Wraps photo and prices stay placeholders. Awards/openings are hidden. No KOT, refund, rider, booking, fare, successful login or real-time feed is fabricated as live.", "",
             "The keyboard view is reserved-space artwork only. 200% CSS type and text-spacing samples are not native keyboard, Dynamic Type, actual browser zoom or WCAG conformance proof. Full-page image heights may exceed a viewport.", "",
             "No team approval has been recorded. No application implementation, account/provider mutation, store action or public creative use is authorised by these files.", "", "## Boards", ""]
    lines += [f'- [{row["title"]}]({row["file"]})' for row in boards]
    lines += ["", "## State pairs — full-resolution PNGs", "", "| ID | Proposed state | Light | Dark |", "|---|---|---|---|"]
    for state in catalog:
        pair = [next(row for row in renders if row["stateId"] == state["id"] and row["theme"] == theme and not row["sample"]) for theme in ("light", "dark")]
        lines.append(f'| {state["id"]} | {state["title"]} | [{pair[0]["id"]}]({pair[0]["file"]}) | [{pair[1]["id"]}]({pair[1]["file"]}) |')
    lines += ["", "## Representative layout studies", "", "| Full image ID | Width / type / spacing | PNG |", "|---|---|---|"]
    for row in renders:
        if row["sample"]:
            lines.append(f'| {row["id"]} | {row["viewportWidth"]} CSS px / {row["textScale"] * 100}% type / {"spacing override" if row["spacingOverride"] else "normal spacing"} | [Open]({row["file"]}) |')
    lines += ["", "## Evidence limits", "", "These are isolated local HTML/Chromium renders. Every state is a designed scenario, not observed application behaviour. Native gestures, bounded network queries, note persistence/Unicode boundaries, real keyboard/safe area, auth/rules, payment/POS reconciliation, stock propagation, alerts/push, courier contracts and store review remain separate unexecuted gates.", "",
              "Petpooja stays in scope, Borzo/Shadowfax contracts remain owner-controlled, Porter is retired, and Reelo is investigation-only. Original 3 November RC / 8 November public targets are unchanged and are not guaranteed.", "",
              "The font licence is retained in `assets/Inter-OFL.txt`. The mascot and selected photos remain internal-review assets, not approved store creative.", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--resume", action="store_true", help="Retain interrupted PNGs only after an exact pixel match against the current composition")
    args = parser.parse_args()
    if not re.fullmatch(r"r\d{1,3}", args.revision):
        raise RuntimeError("Use a new r-number revision")
    shots = HERE / ("screenshots-" + args.revision)
    manifest_path = HERE / ("image-manifest-" + args.revision + ".json")
    index_path = HERE / ("REVIEW-" + args.revision + ".md")
    if manifest_path.exists() or index_path.exists() or (shots.exists() and not args.resume):
        raise RuntimeError("Refusing to overwrite a prior render; use a new revision")
    if args.resume and not shots.is_dir():
        raise RuntimeError("Resume requires an existing interrupted screenshot directory")
    if not TEMP.is_dir():
        raise RuntimeError("Approved local browser temp directory is unavailable")
    assets = json.loads((HERE / "asset-manifest.json").read_text(encoding="utf-8"))["assets"]
    if any(digest(HERE / row["file"]) != row["sha256"] for row in assets):
        raise RuntimeError("Copied asset identity drift")
    source_rows = [{"file": name, "sha256": digest(HERE / name)} for name in SOURCES]
    catalog = read_catalog()
    jobs = [(state, theme, state["width"], 1, False, "") for state in catalog for theme in ("light", "dark")]
    jobs += [(next(state for state in catalog if state["id"] == identifier), theme, width, scale, spacing, sample)
             for identifier, theme, width, scale, spacing, sample in EXTRAS]
    initial_images, recovery = {}, None
    if args.resume:
        expected_names = {state["id"] + ("-L" if theme == "light" else "-D") + ("-" + sample if sample else "") + ".png"
                          for state, theme, width, scale, spacing, sample in jobs}
        existing = list(shots.iterdir())
        if any(not path.is_file() or path.name not in expected_names for path in existing):
            raise RuntimeError("Interrupted directory has unexpected/board files; preserve it and use a new revision")
        initial_images = {path.name: digest(path) for path in existing}
        sequence = 1
        recovery_path = HERE / f"resume-record-{args.revision}-{sequence}.json"
        while recovery_path.exists():
            sequence += 1
            recovery_path = HERE / f"resume-record-{args.revision}-{sequence}.json"
        recovery = {"resumedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "reason": "User reported server restart and cancelled render; original per-image metrics were not persisted",
                    "scope": "Retain each existing PNG byte-for-byte; bind to current sources only after an exact fresh pixel comparison. Never overwrite an existing PNG.",
                    "existingImages": [{"file": (shots / name).relative_to(HERE).as_posix(), "sha256": sha} for name, sha in sorted(initial_images.items())],
                    "currentSourceFingerprints": source_rows}
        with recovery_path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(recovery, indent=2, ensure_ascii=True) + "\n")
        recovery = {"file": recovery_path.name, "sha256": digest(recovery_path), "existingCount": len(initial_images)}
    else:
        shots.mkdir()
    os.environ["TEMP"] = os.environ["TMP"] = str(TEMP)
    LocalOnlyHandler.allowed = LocalOnlyHandler.allowed | {"/" + row["file"] for row in assets}
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(LocalOnlyHandler, directory=str(HERE)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    requests, blocked, page_errors, http_errors, renders = [], [], [], [], []
    tokens_by_theme = {}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--disable-background-networking"])
            browser_version = browser.version
            try:
                for state, theme, width, scale, spacing, sample in jobs:
                    identifier = state["id"] + ("-L" if theme == "light" else "-D") + ("-" + sample if sample else "")
                    context = browser.new_context(viewport={"width": width, "height": 844 if width < 700 else 1024},
                                                  device_scale_factor=1, reduced_motion="reduce", service_workers="block", locale="en-IN")
                    try:
                        def route_request(route):
                            request = route.request
                            path = urlsplit(request.url).path
                            allowed = request.url.startswith(origin + "/") and path in LocalOnlyHandler.allowed and request.method == "GET"
                            requests.append({"case": identifier, "method": request.method, "path": path, "allowedLocal": allowed})
                            if allowed:
                                route.continue_()
                            else:
                                blocked.append({"case": identifier, "path": path, "method": request.method})
                                route.abort()

                        context.route("**/*", route_request)
                        page = context.new_page()
                        page.on("pageerror", lambda error: page_errors.append({"case": identifier, "error": str(error)}))
                        page.on("response", lambda response: http_errors.append({"case": identifier, "path": urlsplit(response.url).path, "status": response.status}) if response.status >= 400 else None)
                        query = urlencode({"screen": state["key"], "theme": theme, "scale": scale, "spacing": int(spacing),
                                           "sample": sample, "revision": args.revision, "capture": 1})
                        page.goto(origin + "/preview.html?" + query, wait_until="networkidle")
                        page.evaluate("() => document.fonts.ready")
                        page.wait_for_function("() => window.PROPOSED_NAV_READY === true")
                        page.wait_for_function("() => [...document.images].every(i => i.complete && i.naturalWidth > 0)")
                        observation = page.evaluate(METRICS)
                        tokens_by_theme[theme] = observation.pop("tokens")
                        path = shots / (identifier + ".png")
                        disposition = "new capture"
                        if path.name in initial_images:
                            if digest(path) != initial_images[path.name]:
                                raise RuntimeError("Interrupted PNG changed during recovery: " + path.name)
                            fresh_bytes = page.screenshot(full_page=True, animations="disabled", scale="css")
                            with Image.open(path) as old, Image.open(io.BytesIO(fresh_bytes)) as fresh:
                                if old.size != fresh.size or ImageChops.difference(old.convert("RGB"), fresh.convert("RGB")).getbbox() is not None:
                                    raise RuntimeError("Existing PNG does not match current composition; preserved without overwrite: " + path.name)
                            disposition = "existing PNG retained; exact current pixel match"
                        else:
                            if path.exists():
                                raise RuntimeError("Concurrent/unexpected image refused: " + path.name)
                            page.screenshot(path=str(path), full_page=True, animations="disabled", scale="css")
                        with Image.open(path) as image:
                            dimensions = list(image.size)
                        renders.append({"id": identifier, "stateId": state["id"], "state": state["key"], "title": state["title"],
                                        "app": state["app"], "group": state["group"], "file": path.relative_to(HERE).as_posix(),
                                        "theme": theme, "viewportWidth": width, "textScale": scale, "spacingOverride": spacing,
                                        "sample": sample, "pixelDimensions": dimensions, "sha256": digest(path), "captureDisposition": disposition, "layoutObservation": observation})
                    finally:
                        context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
    boards = []
    for group in dict.fromkeys([state["group"] for state in catalog] + ["layout-studies"]):
        rows = [row for row in renders if (bool(row["sample"]) if group == "layout-studies" else row["group"] == group and not row["sample"])]
        path = shots / ("board-" + group + ".png")
        board(rows, path, group.replace("-", " "), args.revision)
        with Image.open(path) as image:
            dimensions = list(image.size)
        boards.append({"file": path.relative_to(HERE).as_posix(), "title": group.replace("-", " "),
                       "imageIds": [row["id"] for row in rows], "pixelDimensions": dimensions, "sha256": digest(path)})
    contrasts = {theme: contrast_checks(tokens) for theme, tokens in tokens_by_theme.items()}
    failures = {key: [] for key in ("horizontalOverflow", "clipping", "outsidePage", "smallTargets", "placeholderOcclusion", "activeNavHidden", "identityOrFont", "stateStructure", "contrast", "sourceDrift")}
    for row in renders:
        observation = row["layoutObservation"]
        if observation["pageWidth"] > row["viewportWidth"]:
            failures["horizontalOverflow"].append(row["id"])
        for key in ("clipping", "outsidePage", "smallTargets", "placeholderOcclusion", "activeNavHidden"):
            if observation[key]:
                failures[key].append({"id": row["id"], "details": observation[key]})
        if not observation["interLoaded"] or "PROPOSED — NOT IMPLEMENTED" not in observation["disclaimer"] or row["id"] not in observation["disclaimer"] or observation["current"]["id"] != row["id"] or observation["fontSize"] != ("32px" if row["textScale"] == 2 else "16px"):
            failures["identityOrFont"].append(row["id"])
        expects_note = row["state"] in ("note-expanded", "note-keyboard")
        wrong_note = observation["noteFields"] != int(expects_note) or (expects_note and (not observation["noteReadOnly"] or str(observation["noteValueUnits"]) + " / 240 UTF-16 units" != observation["noteCounter"]))
        wrong_history = observation["historyRail"] != (row["state"] == "cart-returning")
        denied_leak = row["state"].startswith("access-") and observation["deniedRecordNodes"] != 0
        wrong_shortcuts = observation["shortcutCount"] != (4 if row["state"].startswith("home") else 0)
        wrong_keyboard = observation["reservedKeyboard"] != (row["state"] == "note-keyboard")
        wrong_choices = observation["choices"] != (3 if row["state"].endswith("appearance") else 0)
        wrong_scope = (row["state"] == "stock-select-outlet" and observation["outletContext"] != "All Outlets — view only") or (row["state"] == "home-unmapped" and observation["outletContext"] != "Example selected outlet")
        if any((wrong_note, wrong_history, denied_leak, wrong_shortcuts, wrong_keyboard, wrong_choices, wrong_scope)):
            failures["stateStructure"].append(row["id"])
    failures["contrast"] = [theme for theme, checks in contrasts.items() if any(not row["passes"] for row in checks)]
    failures["sourceDrift"] = [row["file"] for row in source_rows if digest(HERE / row["file"]) != row["sha256"]]
    failures.update({"pageErrors": page_errors, "httpErrors": http_errors, "blockedRequests": blocked})
    passed = not any(failures.values())
    make_index(index_path, args.revision, catalog, renders, boards, passed)
    report = {"revision": "v2-" + args.revision, "capturedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
              "scope": "Isolated mockup rendering and bounded artifact observations only, not app/browser/native/provider acceptance",
               "command": f"python -B render-mockups.py --revision {args.revision}" + (" --resume" if args.resume else ""), "playwright": version("playwright"), "chromium": browser_version,
               "stateCount": len(catalog), "sourceFingerprints": source_rows, "screenshots": renders, "contactSheets": boards,
               "interruptionRecovery": recovery,
              "reviewIndex": {"file": index_path.name, "sha256": digest(index_path)}, "contrastTokenChecks": contrasts,
              "requests": requests, "externalOrNonGETRequestsBlocked": blocked, "pageErrors": page_errors,
              "failures": failures, "artifactChecksPassed": passed, "applicationSourcesLoaded": False,
              "ownerAccountsOpened": False, "limitations": "Static scenarios and readonly controls. No gesture/animation/auth/payment/POS/stock/dispatch/audio/push/real keyboard/native/store testing. CSS type scaling is not browser zoom. Request interception is not proof about all browser background traffic."}
    with manifest_path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(report, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps({"revision": report["revision"], "states": len(catalog), "screenshots": len(renders), "boards": len(boards),
                      "existingPNGsRetained": len(initial_images), "newPNGs": len(renders) - len(initial_images),
                      "artifactChecksPassed": passed, "failures": failures, "manifest": manifest_path.name}))
    raise SystemExit(0 if passed else 1)


if __name__ == "__main__":
    main()
