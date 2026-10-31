// Copies only explicitly listed, already approved local assets into this proposal.
// No application edits, dependency installation or network access.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const output = path.dirname(fileURLToPath(import.meta.url));
const candidate = String.raw`C:\Users\DELL\Desktop\Burgonomics\.swarm-worktrees\delivery-launch-ui-20261028`;
const publicRoot = path.join(candidate, "public");
const sources = {
  "brand/logo.png": "burgonomics-logo.png",
  "fonts/InterVariable.woff2": "fonts/InterVariable.woff2",
  "fonts/Inter-OFL.txt": "fonts/Inter-OFL.txt",
  "food/hero.jpg": "images/menu/big-bang-burgers/super-hero-burger.jpg",
  "food/burgers.jpg": "images/menu/classic-burgers/hero-burger.jpg",
  "food/fries.jpg": "images/menu/fries/salted-fries.jpg",
  "food/shake.jpg": "images/menu/thick-shakes/oreo-shake.jpg",
  "food/cheese-burst.jpg": "images/menu/big-bang-burgers/cheese-burst-burger.jpg",
  "food/great-indian.jpg": "images/menu/big-bang-burgers/great-indian-burger.jpg",
  "food/tandoori-paneer.jpg": "images/menu/big-bang-burgers/tandoori-paneer-burger.jpg",
  "food/big-bang-meal.jpg": "images/menu/combos/big-bang-meal.jpg",
  "food/classic-meal.jpg": "images/menu/combos/classic-burger-meal.jpg",
  "food/pink-pasta.jpg": "images/menu/pasta/pink-sauce-pasta.jpg",
  "food/white-pasta.jpg": "images/menu/pasta/alfredo-cheese-sauce-pasta.jpg",
  "brand/ceremony.webp": "images/brand/food-connoisseurs-ceremony-2026.webp",
  "brand/times.webp": "images/brand/times-iconic-burger-2025.webp",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = [];
for (const [relative, source] of Object.entries(sources)) {
  const sourcePath = path.join(publicRoot, source);
  const bytes = await fs.readFile(sourcePath);
  const destination = path.join(output, "assets", relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(destination, bytes, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST" || hash(await fs.readFile(destination)) !== hash(bytes)) throw error;
  }
  manifest.push({ asset: `assets/${relative}`, source: sourcePath, sha256: hash(bytes) });
}

// Use the installed Lucide icon set, not hand-drawn brand/product substitutes.
const require = createRequire(path.join(candidate, "package.json"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const lucide = require("lucide-react");
const icons = {
  home: "Home", menu: "UtensilsCrossed", bag: "ShoppingBag", profile: "UserRound",
  search: "Search", down: "ChevronDown", left: "ChevronLeft", right: "ChevronRight",
  plus: "Plus", minus: "Minus", check: "Check", clock: "Clock", pin: "MapPin",
  kitchen: "Flame", orders: "ClipboardList", stock: "PackageCheck", dispatch: "Truck",
  settings: "Settings2", help: "CircleHelp", alert: "CircleAlert", refresh: "RotateCw",
  grid: "LayoutGrid", list: "List", close: "X", bell: "Bell", arrow: "ArrowRight",
};
const symbols = Object.entries(icons).map(([id, name]) => {
  if (!lucide[name]) throw new Error(`Installed icon missing: ${name}`);
  const svg = renderToStaticMarkup(React.createElement(lucide[name]));
  const body = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<symbol id="${id}" viewBox="0 0 24 24">${body}</symbol>`;
}).join("\n");
const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide icons, ISC license. -->\n${symbols}\n</svg>`;
await fs.writeFile(path.join(output, "assets/icons.svg"), sprite, { flag: "wx" });
manifest.push({ asset: "assets/icons.svg", source: "installed lucide-react icon components (ISC)", sha256: hash(sprite) });
await fs.writeFile(path.join(output, "asset-manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
console.log(`Prepared ${manifest.length} local assets; app/backend source untouched.`);
