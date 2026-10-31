"""Keep only app pixels; remove an owned raw capture after saving its safe copy."""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--raw", type=Path, required=True)
parser.add_argument("--name", required=True)
parser.add_argument("--mask-outlet", action="store_true")
parser.add_argument("--bottom", type=int, default=2280)
args = parser.parse_args()
raw_root = Path(r"C:\Users\DELL\AppData\Local\Temp\opencode\delivery-native-20261029")
if args.raw.resolve().parent != raw_root.resolve() or not args.raw.name.startswith("followup-"):
    raise SystemExit("Refusing an unowned raw path")
if Path(args.name).name != args.name or not args.name.endswith(".png"):
    raise SystemExit("Output must be a local PNG filename")
destination = Path(__file__).resolve().parent / args.name
if destination.exists():
    raise SystemExit("Refusing to overwrite existing evidence")
with Image.open(args.raw) as image:
    if image.size != (1080, 2340) or not 480 <= args.bottom <= 2280:
        raise SystemExit("Unexpected capture dimensions or crop")
    safe = image.crop((0, 120, 1080, args.bottom))
    if args.mask_outlet:
        draw = ImageDraw.Draw(safe)
        draw.rectangle((0, 165, 1080, 355), fill="#f2f2ee")
        draw.text((48, 225), "Address / store selection hidden for privacy", fill="#1e3924")
    safe.save(destination)
with Image.open(destination) as saved:
    saved.verify()
args.raw.unlink()
print(f"Saved {destination.name}; status/navigation chrome removed; owned raw removed")
