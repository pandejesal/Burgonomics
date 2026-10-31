"""Capture only the authorised app; crop/redact in memory before saving or viewing."""
import argparse
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import subprocess

from PIL import Image, ImageDraw


def rectangle(value):
    try:
        parts = tuple(int(part) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("Expected four integer pixel coordinates") from error
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("Expected left,top,right,bottom")
    left, top, right, bottom = parts
    if not (0 <= left < right <= 1080 and 0 <= top < bottom <= 2340):
        raise argparse.ArgumentTypeError("Rectangle must be within the verified phone screen")
    return parts


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--device", required=True, choices=["RZCX51TXRKB"])
parser.add_argument("--name", required=True)
parser.add_argument("--region", type=rectangle, default=(0, 120, 1080, 2280))
parser.add_argument("--mask", type=rectangle, action="append", default=[])
args = parser.parse_args()
if Path(args.name).name != args.name or not args.name.startswith("phone-") or not args.name.endswith(".png"):
    parser.error("Output must be a new local phone-*.png filename")
if args.region[1] < 120 or args.region[3] > 2280:
    parser.error("Status and system-navigation areas must remain excluded")
destination = Path(__file__).resolve().parent / args.name
if destination.exists():
    parser.error("Refusing to overwrite existing evidence")
adb = Path(r"C:\Users\DELL\AppData\Local\Android\Sdk\platform-tools\adb.exe")


def run(*arguments):
    result = subprocess.run([str(adb), "-s", args.device, *arguments], capture_output=True, timeout=30)
    if result.returncode:
        raise SystemExit("ADB capture/foreground check failed; no evidence saved")
    return result.stdout


def require_app_foreground():
    # Do not print or persist other windows, notification labels or private text.
    windows = run("shell", "dumpsys", "window").decode("utf-8", errors="replace")
    focus = re.search(r"mCurrentFocus=Window\{[^\n]*\s(com\.burgonomics)/", windows)
    if focus is None:
        raise SystemExit("Burgonomics is not focused; capture discarded without saving")


require_app_foreground()
pixels = run("exec-out", "screencap", "-p")
require_app_foreground()
with Image.open(BytesIO(pixels)) as image:
    if image.size != (1080, 2340):
        raise SystemExit("Unexpected phone dimensions; no evidence saved")
    redacted = image.convert("RGB")
    draw = ImageDraw.Draw(redacted)
    for bounds in args.mask:
        draw.rectangle(bounds, fill="#f2f2ee")
        draw.text((bounds[0] + 24, bounds[1] + 24), "Private address / store selection hidden", fill="#1e3924")
    safe = redacted.crop(args.region)
    with destination.open("xb") as stream:
        safe.save(stream, format="PNG")
with Image.open(destination) as saved:
    saved.verify()
print(json.dumps({
    "file": destination.name, "device": args.device,
    "capturedAt": datetime.now(timezone.utc).isoformat(),
    "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
    "regionPhysicalPixels": args.region, "maskedPhysicalPixels": args.mask,
    "foregroundCheckedBeforeAndAfter": True, "rawScreenshotWritten": False,
    "statusAndSystemNavigationExcluded": True,
}, indent=2))
