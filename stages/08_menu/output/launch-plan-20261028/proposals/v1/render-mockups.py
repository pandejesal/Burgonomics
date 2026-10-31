"""Render only the isolated static proposal; never launch either application."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import threading
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urlencode, urlparse

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "screenshots"
TEMP = Path(r"C:\Users\DELL\AppData\Local\Temp\opencode")
JOBS = [
    ("D01", "home", "light", 390, 1, ""),
    ("D02", "home", "dark", 390, 1, ""),
    ("D03", "menu", "light", 390, 1, ""),
    ("D04", "cart-empty", "light", 390, 1, ""),
    ("D05", "cart-note", "dark", 390, 1, ""),
    ("P01", "kds", "dark", 768, 1, ""),
    ("P02", "sign-in", "light", 390, 1, ""),
    ("D01-320", "home", "light", 320, 1, "320"),
    ("D01-768", "home", "light", 768, 1, "768"),
    ("D05-320-200", "cart-note", "dark", 320, 2, "320-200"),
    ("P01-320", "kds", "dark", 320, 1, "320"),
]


class LocalOnlyHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def luminance(colour):
    values = [int(colour[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in values]
    return sum(a * b for a, b in zip(linear, (.2126, .7152, .0722)))


def contrast_checks(tokens):
    pairs = [(fg, bg, 4.5) for fg in ("ink", "muted") for bg in ("canvas", "surface", "elevated")]
    pairs += [("on-primary", "primary", 4.5), ("primary-text", "canvas", 4.5), ("accent", "canvas", 4.5), ("warning-ink", "warning-surface", 4.5), ("positive-ink", "positive-surface", 4.5), ("control-line", "canvas", 3), ("control-line", "surface", 3), ("focus", "canvas", 3)]
    records = []
    for foreground, background, threshold in pairs:
        a, b = sorted((luminance(tokens[foreground]), luminance(tokens[background])))
        ratio = (b + .05) / (a + .05)
        records.append({"foreground": foreground, "background": background, "ratio": ratio, "threshold": threshold, "passes": ratio >= threshold})
    return records


def make_sheet(ids, filename, title):
    panels = []
    for identifier in ids:
        image = Image.open(SHOTS / f"{identifier}.png").convert("RGB")
        image.thumbnail((260 if identifier.startswith("D") else 640, 820))
        panels.append(image)
    width = 24 + sum(p.width + 20 for p in panels)
    height = 92 + max(p.height for p in panels)
    sheet = Image.new("RGB", (width, height), "#edf1ee")
    draw = ImageDraw.Draw(sheet)
    fontpath = Path(r"C:\Windows\Fonts\segoeui.ttf")
    font = ImageFont.truetype(str(fontpath), 20) if fontpath.is_file() else ImageFont.load_default()
    draw.text((24, 16), title, font=font, fill="#16281d")
    x = 24
    for identifier, panel in zip(ids, panels):
        draw.text((x, 46), identifier, font=font, fill="#16281d")
        sheet.paste(panel, (x, 76))
        x += panel.width + 20
    sheet.save(SHOTS / filename)


def main():
    global SHOTS
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", default="")
    args = parser.parse_args()
    if args.revision and not re.fullmatch(r"r[0-9]+", args.revision):
        raise RuntimeError("Revision must be r followed by digits")
    suffix = "-" + args.revision if args.revision else ""
    SHOTS = HERE / ("screenshots" + suffix)
    manifest_path = HERE / ("image-manifest" + suffix + ".json")
    if manifest_path.exists() or any((SHOTS / (job[0] + ".png")).exists() for job in JOBS):
        raise RuntimeError("Refusing to overwrite screenshots; use a new revision or remove only this task's rejected render explicitly")
    SHOTS.mkdir(exist_ok=True)
    if not TEMP.is_dir():
        raise RuntimeError("Approved browser temp directory is missing")
    os.environ["TEMP"] = str(TEMP)
    os.environ["TMP"] = str(TEMP)
    handler = partial(LocalOnlyHandler, directory=str(HERE))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    blocked, requests, renders, errors = [], [], [], []
    tokens_by_theme = {}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--disable-background-networking"])
            browser_version = browser.version
            try:
                for identifier, screen, theme, width, scale, case in JOBS:
                    context = browser.new_context(viewport={"width": width, "height": 844 if width < 700 else 1024}, device_scale_factor=1, reduced_motion="reduce", service_workers="block", locale="en-IN")

                    def route_request(route):
                        url = route.request.url
                        requests.append({"case": identifier, "method": route.request.method, "path": urlparse(url).path, "local": url.startswith(origin + "/")})
                        if url.startswith(origin + "/") and route.request.method == "GET":
                            route.continue_()
                        else:
                            blocked.append({"case": identifier, "url": url})
                            route.abort()

                    context.route("**/*", route_request)
                    page = context.new_page()
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    query = urlencode({"screen": screen, "theme": theme, "scale": scale, "case": case})
                    page.goto(origin + "/preview.html?" + query, wait_until="networkidle")
                    page.evaluate("() => document.fonts.ready")
                    page.wait_for_function("() => [...document.images].every(image => image.complete && image.naturalWidth > 0)")
                    metrics = page.evaluate("""() => ({
                      width: innerWidth, pageWidth: document.documentElement.scrollWidth,
                      interLoaded: document.fonts.check('16px Inter'),
                      textScale: getComputedStyle(document.documentElement).fontSize,
                      disclaimer: document.querySelector('.proposal').textContent,
                      clipping: [...document.querySelectorAll('h1,h2,h3,p,button,.proposal,.category-caption')].filter(e => !e.closest('.jump-strip,.partner-nav') && e.scrollWidth > e.clientWidth + 1).map(e => ({tag:e.tagName, text:e.textContent.slice(0,80)})),
                      smallTargets: [...document.querySelectorAll('button')].filter(e => e.getBoundingClientRect().width < 44 || e.getBoundingClientRect().height < 44).map(e => e.textContent),
                      placeholderOcclusion: [...document.querySelectorAll('.photo-placeholder')].filter(e => e.getBoundingClientRect().bottom > e.closest('.category').querySelector('.category-caption').getBoundingClientRect().top + 1).map(e => e.textContent),
                      noteFields: document.querySelectorAll('textarea').length,
                      categories: [...document.querySelectorAll('.category')].map(e => ({width:e.getBoundingClientRect().width, height:e.getBoundingClientRect().height})),
                      tokens: Object.fromEntries(['canvas','surface','elevated','ink','muted','primary','on-primary','primary-text','accent','warning-surface','warning-ink','positive-surface','positive-ink','control-line','focus'].map(k=>[k,getComputedStyle(document.documentElement).getPropertyValue('--'+k).trim()]))
                    })""")
                    if not metrics["interLoaded"] or "PROPOSED — NOT IMPLEMENTED" not in metrics["disclaimer"]:
                        raise RuntimeError(f"Missing font/disclaimer: {identifier}")
                    tokens_by_theme[theme] = metrics.pop("tokens")
                    path = SHOTS / f"{identifier}.png"
                    page.screenshot(path=str(path), full_page=True, animations="disabled", scale="css")
                    with Image.open(path) as image:
                        dimensions = list(image.size)
                    renders.append({"id": identifier, "file": f"{SHOTS.name}/{identifier}.png", "screen": screen, "theme": theme, "viewportWidth": width, "textScale": scale, "pixelDimensions": dimensions, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "layoutObservation": metrics})
                    context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
    make_sheet(["D01", "D02", "D03", "D04", "D05"], "delivery-overview.png", "PROPOSED v0 - Delivery - NOT IMPLEMENTED")
    make_sheet(["P01", "P02"], "partner-overview.png", "PROPOSED v0 - Partner - NOT IMPLEMENTED")
    sheets = []
    for name in ("delivery-overview.png", "partner-overview.png"):
        path = SHOTS / name
        with Image.open(path) as image:
            dimensions = list(image.size)
        sheets.append({"file": SHOTS.name + "/" + name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "pixelDimensions": dimensions})
    contrasts = {theme: contrast_checks(tokens) for theme, tokens in tokens_by_theme.items()}
    source_fingerprints = [{"file": name, "sha256": hashlib.sha256((HERE / name).read_bytes()).hexdigest()} for name in ("preview.html", "mockups.css", "mockups.js", "render-mockups.py", "asset-manifest.json")]
    report = {"revision": "v0" + suffix, "capturedAt": datetime.now().astimezone().isoformat(timespec="seconds"), "scope": "isolated local mockup render only; not browser/native/provider/app acceptance", "playwright": version("playwright"), "chromium": browser_version, "sourceFingerprints": source_fingerprints, "screenshots": renders, "contactSheets": sheets, "contrastTokenChecks": contrasts, "requests": requests, "externalRequestsBlocked": blocked, "pageErrors": errors, "appSourcesLoaded": False, "ownerAccountsOpened": False, "limitations": "v0 subset, static mock controls; no gesture/animation/auth/payment/live feed/keyboard/native/store verification"}
    manifest_path.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    failures = {"horizontalOverflow": [r["id"] for r in renders if r["layoutObservation"]["pageWidth"] > r["viewportWidth"]], "clipping": [r["id"] for r in renders if r["layoutObservation"]["clipping"]], "placeholderOcclusion": [r["id"] for r in renders if r["layoutObservation"]["placeholderOcclusion"]], "smallTargets": [r["id"] for r in renders if r["layoutObservation"]["smallTargets"]], "contrast": [theme for theme, rows in contrasts.items() if any(not r["passes"] for r in rows)], "pageErrors": errors, "blockedExternal": blocked}
    print(json.dumps({"screenshots": len(renders), "contactSheets": len(sheets), "failures": failures, "manifest": str(manifest_path)}))
    if any(failures.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
