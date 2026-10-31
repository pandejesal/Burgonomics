"""Read owner sources and the public site; generate only local evidence/assets."""
from pathlib import Path
from urllib.parse import urljoin, urlparse
from io import BytesIO
import hashlib
import json
import re
import pymupdf
from PIL import Image
from scrapling.fetchers import Fetcher

ROOT = Path(__file__).resolve().parent
PDF = Path(r"C:\Users\DELL\Downloads\Burgonomics Franchise PPT (6).pdf")
WEBSITE = Path(r"C:\Users\DELL\Desktop\BURGONOMICS WEBSITE\burgonomics final ebsite - Copy")
ASSETS = Path(r"C:\Users\DELL\Desktop\Burgonomics\.swarm-worktrees\delivery-launch-ui-20261028\public\images\brand")
ASSETS.mkdir(parents=True, exist_ok=True)
manifest = {"pdf": {"file": PDF.name, "sha256": hashlib.sha256(PDF.read_bytes()).hexdigest()}, "assets": [], "website": []}
doc = pymupdf.open(PDF)
images = {
    "times-iconic-burger-2025": (6, 84),
    "times-iconic-burger-certificate-2025": (6, 85),
    "food-connoisseurs-ceremony-2026": (7, 121),
    "food-connoisseurs-team-2026": (7, 124),
    "food-connoisseurs-qsr-certificate-2026": (7, 125),
    "food-connoisseurs-burger-certificate-2026": (7, 126),
}
for name, (slide, xref) in images.items():
    data = doc.extract_image(xref)["image"]
    im = Image.open(BytesIO(data)).convert("RGB")
    dest = ASSETS / f"{name}.webp"
    im.save(dest, "WEBP", quality=90, method=6)
    manifest["assets"].append({"file": dest.name, "slide": slide, "xref": xref, "width": im.width, "height": im.height, "bytes": dest.stat().st_size, "sha256": hashlib.sha256(dest.read_bytes()).hexdigest()})
for slide in (6, 7, 8):
    pix = doc[slide - 1].get_pixmap(matrix=pymupdf.Matrix(3.5, 3.5), alpha=False)
    im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    dest = ASSETS / f"franchise-slide-{slide:02}.webp"
    im.save(dest, "WEBP", quality=88, method=6)
    manifest["assets"].append({"file": dest.name, "slide": slide, "width": im.width, "height": im.height, "bytes": dest.stat().st_size, "sha256": hashlib.sha256(dest.read_bytes()).hexdigest()})

locations_path = WEBSITE / "src/components/Locations/locationsData.js"
raw = locations_path.read_text(encoding="utf-8")
upcoming = []
for block in re.findall(r'\{\s*id:.*?coordinates:.*?\n\s*\}', raw, re.S):
    fields = dict(re.findall(r'(id|name|city|state|status|openingDate|address):\s*"([^"]*)"', block))
    if fields.get("status") == "upcoming":
        upcoming.append(fields)
manifest["localLocations"] = {"source": str(locations_path), "sha256": hashlib.sha256(locations_path.read_bytes()).hexdigest(), "upcoming": upcoming}

fetcher = Fetcher()
url = "https://burgonomics.com/locations"
page = fetcher.get(url, timeout=30)
html = page.html_content
(ROOT / "website-locations.html").write_text(html, encoding="utf-8")
manifest["website"].append({"url": str(page.url), "status": page.status, "sha256": hashlib.sha256(html.encode()).hexdigest()})
scripts = page.css("script[src]::attr(src)").getall()
for index, src in enumerate(scripts[:4]):
    script_url = urljoin(str(page.url), src)
    if urlparse(script_url).hostname not in {"burgonomics.com", "www.burgonomics.com"}:
        continue
    script = fetcher.get(script_url, timeout=30)
    text = script.body.decode("utf-8", errors="replace")
    dest = ROOT / f"website-bundle-{index}.js"
    dest.write_text(text, encoding="utf-8")
    manifest["website"].append({"url": script_url, "status": script.status, "file": dest.name, "bytes": len(script.body), "sha256": hashlib.sha256(script.body).hexdigest()})
(ROOT / "source-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps({"assets": len(manifest["assets"]), "upcoming": upcoming, "website": manifest["website"]}, indent=2, ensure_ascii=False))
