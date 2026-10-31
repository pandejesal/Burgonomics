#!/usr/bin/env node
/**
 * 8.2 pre-import snapshot — lists every document of one or more Firestore
 * collections via the REST API and writes them verbatim (raw field values,
 * no transformation) to a JSON file.
 *
 * Usage:
 *   FIRESTORE_TOKEN=$(gcloud auth application-default print-access-token) \
 *     node references/verification/8.2/snapshot.mjs \
 *       [--collections products,categories,banners] \
 *       [--out references/verification/8.2/pre-import-snapshot.json]
 *
 * Token resolution order: env FIRESTORE_TOKEN > argv --token > gcloud ADC.
 * The token is never written to disk.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT = "burgonomics-7faa8";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function resolveToken() {
  if (process.env.FIRESTORE_TOKEN) return process.env.FIRESTORE_TOKEN;
  const fromArg = arg("token", null);
  if (fromArg) return fromArg;
  const { execFileSync } = await import("node:child_process");
  // Windows ships `gcloud.cmd`/`gcloud.ps1`; spawning "gcloud" directly fails
  // with EINVAL/ENOENT, so run it through cmd.exe where gcloud is on PATH.
  try {
    const out = execFileSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "gcloud auth application-default print-access-token"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    if (!line || /\s/.test(line)) throw new Error(`unexpected gcloud output: ${out.slice(0, 80)}`);
    return line;
  } catch (e) {
    throw new Error(
      `No Firestore token available (gcloud ADC failed: ${e.message}). ` +
        `Set FIRESTORE_TOKEN or run 'gcloud auth application-default login'.`,
    );
  }
}

/** List all documents of a collection (handles pageToken pagination). */
async function listCollection(token, collectionId) {
  const docs = [];
  let pageToken = "";
  for (;;) {
    const url =
      `${BASE}/${collectionId}?pageSize=300` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`list ${collectionId} -> HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    const json = await res.json();
    for (const d of json.documents ?? []) docs.push(d);
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return docs;
}

const collections = arg("collections", "products,categories,banners").split(",").map((s) => s.trim()).filter(Boolean);
const outPath = resolve(arg("out", "references/verification/8.2/pre-import-snapshot.json"));

const token = await resolveToken();
const snapshot = {
  project: PROJECT,
  capturedAt: new Date().toISOString(),
  method: "firestore.rest.listDocuments",
  collections: {},
};

for (const c of collections) {
  try {
    const docs = await listCollection(token, c);
    snapshot.collections[c] = { count: docs.length, documents: docs };
    console.log(`${c}: ${docs.length} docs`);
  } catch (e) {
    snapshot.collections[c] = { count: null, error: String(e.message ?? e), documents: [] };
    console.error(`${c}: ERROR ${e.message}`);
  }
}

writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
console.log(`snapshot -> ${outPath}`);
