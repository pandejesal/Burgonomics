"""Fetch the official OFL font once, verify provenance, encode a local WOFF2."""
import hashlib
import io
import json
from pathlib import Path
from urllib.request import urlopen

from fontTools.ttLib import TTFont

ROOT = Path(r"C:\Users\DELL\Desktop\Burgonomics\.swarm-worktrees\delivery-launch-ui-20261028")
BASE = "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/"
FONT_URL = BASE + "Montserrat%5Bwght%5D.ttf"
LICENSE_URL = BASE + "OFL.txt"
source = urlopen(FONT_URL, timeout=30).read()
licence = urlopen(LICENSE_URL, timeout=30).read()
blob = hashlib.sha1(b"blob " + str(len(source)).encode() + b"\0" + source).hexdigest()
if len(source) != 744936 or blob != "c97aca18592834d8706549c279cb8d5ac5d85f69":
    raise SystemExit("Official font differs from the inspected revision; review before writing")
if len(licence) != 4400 or b"SIL OPEN FONT LICENSE Version 1.1" not in licence:
    raise SystemExit("Unexpected licence; no assets written")
font = TTFont(io.BytesIO(source))
axes = {axis.axisTag: [axis.minValue, axis.maxValue] for axis in font["fvar"].axes}
if axes.get("wght") != [100, 900]:
    raise SystemExit("Unexpected Montserrat weight axis")
font.flavor = "woff2"
buffer = io.BytesIO()
font.save(buffer)
woff = buffer.getvalue()
for name, data in [("MontserratVariable.woff2", woff), ("Montserrat-OFL.txt", licence)]:
    destination = ROOT / "public" / "fonts" / name
    if destination.exists() and destination.read_bytes() != data:
        raise SystemExit(f"Refusing to overwrite a different existing asset: {name}")
    destination.write_bytes(data)
report = {
    "fontSource": FONT_URL, "licenceSource": LICENSE_URL,
    "sourceGitBlob": blob, "sourceBytes": len(source), "weightAxes": axes,
    "sourceSha256": hashlib.sha256(source).hexdigest(),
    "woff2Bytes": len(woff), "woff2Sha256": hashlib.sha256(woff).hexdigest(),
    "licenceBytes": len(licence), "licenceSha256": hashlib.sha256(licence).hexdigest(),
    "encoding": "fontTools full-font WOFF2, no subsetting, original family names",
    "licence": "unchanged SIL OFL 1.1", "existingFontsModified": False,
}
Path(__file__).with_name("montserrat-provenance.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report, indent=2))
