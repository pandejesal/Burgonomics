#!/usr/bin/env node
/**
 * Keep Firestore `banners` gradients inside the brand 60-30-10 scheme
 * (references/ui_ux_spec.md). Off-scheme colors — the #4A2E7A/#6D47B8 purple
 * that shipped on banner_myob — are rewritten in place.
 *
 * Reuses the 8.2 seed precedent (references/verification/8.2/seed-menu.mjs):
 * Firestore REST + a bearer token, no SDK, no service-account file on disk.
 * Token: env FIRESTORE_TOKEN > --token <t> > `gcloud auth application-default
 * print-access-token`.
 *
 * Usage:
 *   node scripts/fix-banner-gradient.mjs           # dry run
 *   node scripts/fix-banner-gradient.mjs --apply   # write + verify
 */
const PROJECT = "burgonomics-7faa8";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const APPLY = process.argv.includes("--apply");

const BRAND_FALLBACK = "bg-gradient-to-br from-[#0E4825] to-[#1B5934] text-white";

/** In-scheme replacements, keyed by banner id. */
const BANNER_GRADIENTS = {
  banner_myob: "bg-gradient-to-br from-[#FF6600] to-[#E55C00] text-white",
};

/** Same allow-list as parseTailwindGradient() in BannerCarousel.tsx. */
const ALLOWED_HEXES = new Set([
  "#0E4825", "#0A371C", "#145830", "#1B5934",
  "#FF6600", "#E55C00", "#4ADE80",
  "#CC5200", "#B34700", "#9A3412",
  "#B2452B", "#E06637", "#7A1F1F", "#C2452D",
]);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function resolveToken() {
  if (process.env.FIRESTORE_TOKEN) return process.env.FIRESTORE_TOKEN;
  const fromArg = arg("token", null);
  if (fromArg) return fromArg;
  const { execFileSync } = await import("node:child_process");
  // Windows ships gcloud as .cmd/.ps1; spawn through cmd.exe where it is on PATH.
  const out = execFileSync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", "gcloud auth application-default print-access-token"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (!line || /\s/.test(line)) throw new Error(`unexpected gcloud output: ${out.slice(0, 80)}`);
  return line;
}

function hexesOf(gradient) {
  return [...String(gradient).matchAll(/#([a-fA-F0-9]{3,8})/g)].map((m) => `#${m[1].toUpperCase()}`);
}

const inScheme = (gradient) => hexesOf(gradient).every((h) => ALLOWED_HEXES.has(h));

let token = await resolveToken();

async function request(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (res.status === 401) {
      token = await resolveToken();
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  }
}

const list = await request(`${BASE}/banners?pageSize=300`);
const docs = list.documents ?? [];

const fixes = [];
for (const doc of docs) {
  const id = doc.fields?.id?.stringValue ?? doc.name.split("/").pop();
  const current = doc.fields?.gradient?.stringValue ?? null;
  const target = BANNER_GRADIENTS[id] ?? BRAND_FALLBACK;
  if (current === target) continue; // already the desired value
  if (inScheme(current) && !BANNER_GRADIENTS[id]) continue; // in-scheme, no explicit fix — untouched
  fixes.push({ id, name: doc.name, current, target });
}

console.log(`banners    : ${docs.length}`);
for (const f of fixes) console.log(`  ${f.id}\n    from: ${f.current}\n    to  : ${f.target}`);
if (!fixes.length) console.log("no off-scheme banner gradients found");

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write.");
  process.exit(0);
}

for (const f of fixes) {
  const url = `${BASE}/${f.name.split("/").slice(-2).join("/")}?updateMask.fieldPaths=gradient`;
  await request(url, {
    method: "PATCH",
    body: JSON.stringify({ fields: { gradient: { stringValue: f.target } } }),
  });
  console.log(`  patched ${f.id}`);
}

// Verify: every live banner gradient must now be in-scheme.
const after = await request(`${BASE}/banners?pageSize=300`);
const bad = (after.documents ?? [])
  .map((d) => ({ id: d.fields?.id?.stringValue, gradient: d.fields?.gradient?.stringValue }))
  .filter((b) => !inScheme(b.gradient));
for (const b of bad) console.log(`  ! still off-scheme: ${b.id} ${b.gradient}`);
console.log(`\nverified   : ${after.documents?.length ?? 0} banners, ${bad.length} off-scheme`);
process.exit(bad.length ? 1 : 0);
