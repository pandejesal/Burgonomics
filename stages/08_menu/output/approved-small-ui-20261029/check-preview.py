"""Validate exported theme labels/inertness and preservation of the old Menu."""
from html.parser import HTMLParser
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT.parent / "integration-acceptance-20261029"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source-manifest", type=Path, default=EVIDENCE / "delivery-source-fonts-branches-r2-pre.json")
parser.add_argument("--output", type=Path, default=ROOT / "preview-scope-validation.json")
parser.add_argument("--allow-menu-change", action="append", default=[], choices=[
    "src/routes/menu.index.tsx", "src/routes/menu.continuous.test.tsx",
    "src/features/menu/components/MenuProductCard.tsx",
    "src/features/menu/components/MenuCategorySection.tsx",
    "src/features/menu/components/MenuProductCard.test.tsx",
    "src/features/menu/components/MenuProductCard.compact-grid.test.tsx",
    "src/features/menu/components/MenuCategorySection.compact-grid.test.tsx",
    "src/features/menu/services/menuService.ts",
    "src/features/menu/services/menuService.homeCatalog.test.ts",
    "src/features/menu/dietary-labels.polish.test.tsx",
], help="Explicit owner-authorised grid or Home-catalog glue paths; all other Menu files stay protected")
args = parser.parse_args()

class Snapshot(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root_class = ""
        self.scripts = 0
        self.links = 0
        self.assets = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html": self.root_class = attrs.get("class", "")
        if tag in {"script", "iframe", "object", "embed"}: self.scripts += 1
        if "href" in attrs or "action" in attrs or "formaction" in attrs: self.links += 1
        if tag == "img" and attrs.get("src", "").startswith("/"): self.assets.append(attrs["src"])

samples = []
for screen in ["home", "menu", "cart"]:
    for theme in ["light", "dark"]:
        filename = f"{screen}-{theme}.html"
        html = (ROOT / filename).read_text(encoding="utf-8")
        snapshot = Snapshot()
        snapshot.feed(html)
        row = {
            "file": filename, "dark": "dark" in snapshot.root_class.split(),
            "activeEmbedsOrScripts": snapshot.scripts, "navigationOrFormActions": snapshot.links,
            "localImagesPresent": all((ROOT / path.lstrip("/")).is_file() for path in snapshot.assets),
            "newFontPresent": "MontserratVariable.woff2" in html and "MonstroSolid.woff2" in html,
            "networkAndScriptsBlocked": "script-src 'none'" in html and "connect-src 'none'" in html,
        }
        row["pass"] = row["dark"] == (theme == "dark") and row["activeEmbedsOrScripts"] == 0 and row["navigationOrFormActions"] == 0 and row["localImagesPresent"] and row["newFontPresent"] and row["networkAndScriptsBlocked"]
        samples.append(row)

before = json.loads((EVIDENCE / "delivery-source-small-ui-native-pre.json").read_text(encoding="utf-8-sig"))["files"]
after = json.loads(args.source_manifest.read_text(encoding="utf-8-sig"))["files"]
protected = sorted(name for name in before.keys() | after.keys() if name.startswith("src/features/menu/") or name.startswith("src/routes/menu."))
menu_changes = [name for name in protected if before.get(name) != after.get(name)]
unexpected_menu_changes = sorted(set(menu_changes) - set(args.allow_menu_change))
result = {
    "status": "PASS" if all(row["pass"] for row in samples) and not unexpected_menu_changes else "FAIL",
    "snapshots": samples, "menuFilesCompared": len(protected), "menuChanges": menu_changes,
    "explicitOwnerMenuScope": args.allow_menu_change,
    "unexpectedMenuChanges": unexpected_menu_changes,
    "menuBaseline": "previous bounded UI source; only explicitly named owner-authorised grid or Home-catalog paths permitted",
    "currentSourceManifest": str(args.source_manifest),
    "physicalDeviceAcceptance": False, "providerAcceptance": False,
}
args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result, indent=2))
if result["status"] != "PASS": raise SystemExit(1)
