"""Preserve hash-bound, privacy-cropped observations without touching apps or raw frames."""

import ast
import hashlib
import json
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
RAW = Path(r"C:\Users\DELL\AppData\Local\Temp\opencode\burgonomics-ui-observations-20261028-3kntut4p")
CASES = [
    ("delivery-home", "Burgonomics Delivery / Home", "com.burgonomics", "b0ffd4e5da2a6468afa4c4e33ab9b59a0b2722633a46e204a0924f6b9fd9b791", "ev_a2ccd1fca0e0675cd735bae92dab108b5714d12c49d4653c21d4577f49d17791", (0, 285, 1080, 2280)),
    ("delivery-banner-after", "Delivery / outside-banner control, after scroll", "com.burgonomics", "a4a819ee6013185883072e04e8abe5510bc6984b15a4e52c15f84bd3ec76fa25", "ev_e7c0ad36896fbebf131d4fc1f40ac57c8af5e7414cbdae36a9c1365fc2406989", (0, 105, 1080, 2280)),
    ("martinoz-home", "Martinoz / Home reference", "app.martinoz.pizza", "acf3ff4bb0dc323c88b97835dc8e16c95e9f9f8b8f3279725cd30b5761dda155", "ev_da1ec1c41defc3f3bb7181240d305aa68c60e3c92613e95247656f7e49a2600d", (0, 500, 1080, 2250)),
    ("lapinoz-home", "La Pino'z / Home reference", "com.app.uengage.lapinoz", "865c8686b2e0053c01d1316b8d166fcf8899bd7f8032f9bac24dff3eab8abb07", "ev_0218fb866d955996d3e714b50e72d8356271ecd42d06eb032204595dc09b7db4", (0, 599, 1080, 2280)),
    ("lapinoz-menu", "La Pino'z / filters and featured-item reference", "com.app.uengage.lapinoz", "748b46141028981579c6ea78d4ef82090eb2bc1d239596d5e2f9cf20e3f82dd2", "ev_5e06d75db07ff4d14fc00fbb225bca4d752d07b7d9f67092ea9448763dd240cd", (0, 540, 1080, 1680)),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    manifest = HERE / "image-manifest.json"
    destinations = [HERE / (row[0] + ".png") for row in CASES]
    if manifest.exists() or any(path.exists() for path in destinations):
        raise RuntimeError("Observation outputs exist; preserve them, do not recapture/overwrite")
    for case, title, package, expected, evidence, crop in CASES:
        source = RAW / case / "screen.png"
        if not source.is_file() or digest(source) != expected:
            raise RuntimeError("Raw frame identity mismatch: " + case)
        with Image.open(source) as image:
            if image.size != (1080, 2340):
                raise RuntimeError("Unexpected frame dimensions: " + case)
    font_path = Path(r"C:\Windows\Fonts\segoeui.ttf")
    title_font = ImageFont.truetype(str(font_path), 24)
    caption_font = ImageFont.truetype(str(font_path), 22)
    rows = []
    for case, title, package, expected, evidence, crop in CASES:
        with Image.open(RAW / case / "screen.png") as original:
            panel = original.convert("RGB").crop(crop)
        canvas = Image.new("RGB", (panel.width, panel.height + 192), "#f5f7f5")
        canvas.paste(panel, (0, 104))
        draw = ImageDraw.Draw(canvas)
        draw.text((24, 12), "OBSERVED INSTALLED BUILD — NOT v2 MOCKUP", font=title_font, fill="#16281d")
        draw.text((24, 55), title + " / 28 October 2026", font=caption_font, fill="#586b60")
        draw.text((24, panel.height + 120), "Internal comparison only. Header/status/personal content cropped out.", font=caption_font, fill="#16281d")
        draw.text((24, panel.height + 155), "APK/source binding and native/backend acceptance are not established.", font=caption_font, fill="#586b60")
        destination = HERE / (case + ".png")
        canvas.save(destination)
        rows.append({"file": destination.name, "sha256": digest(destination), "pixelDimensions": list(canvas.size),
                     "package": package, "reaEvidenceId": evidence, "rawRelativePath": case + "/screen.png",
                     "rawSHA256": expected, "rawDimensions": [1080, 2340], "cropLTRB": list(crop),
                     "captionBandsAdded": True, "scope": "Current installed-app observation, not proposed/new-source/functional proof"})
    ast.parse(Path(__file__).read_text(encoding="utf-8"), filename=__file__)
    report = {"preparedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
              "command": "python -B stages/08_menu/output/launch-plan-20261028/phase-a/device-review-20261028/prepare-images.py",
              "rawCaptureRoot": str(RAW), "images": rows,
              "privacy": "Raw frames stay in the approved temporary directory. Retained crops omit personal header/greeting/status-bar content; the La Pino'z menu crop excludes the personalised favourites section. Inspect the crops before sharing internally.",
              "limits": "Single Android device; package inventory only, no APK identity/source binding. No payment/POS/auth/stock/dispatch/native release acceptance. The excluded black frame is not evidence of a startup defect; user explained closing the app.",
              "helperSHA256": digest(Path(__file__))}
    with manifest.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(report, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps({"images": len(rows), "rawHashesMatched": len(rows), "output": str(manifest), "syntaxParsed": True}))


if __name__ == "__main__":
    main()
