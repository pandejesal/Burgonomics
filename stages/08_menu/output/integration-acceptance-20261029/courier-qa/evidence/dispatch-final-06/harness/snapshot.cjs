'use strict';
// Read source bytes only. Never load application config or execute moving source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const BASE = __dirname;
const DEPENDENCY_PACKAGE = 'C:\\Users\\DELL\\Desktop\\Burgonomics\\.swarm-worktrees\\backend-email-contract-20261029\\functions\\package.json';
const ts = createRequire(DEPENDENCY_PACKAGE)('typescript');
const knownCandidates = {
  pos: { root: 'C:\\Users\\DELL\\Desktop\\Burgonomics\\.swarm-worktrees\\backend-pos-20261028', entries: ['functions/src/modules/petpooja/orderPush.ts', 'functions/src/modules/petpooja/petpooja.scheduler.ts'], auxiliary: ['functions/tests/petpooja.ambiguous-send.test.ts'] },
  dispatch: { root: 'C:\\Users\\DELL\\Desktop\\Burgonomics\\.swarm-worktrees\\backend-email-contract-20261029', entries: ['functions/src/modules/dispatch/dispatch.router.ts', 'functions/src/modules/dispatch/types.ts', 'functions/src/modules/dispatch/providers/shared.ts', 'functions/src/modules/dispatch/providers/borzo.adapter.ts', 'functions/src/modules/dispatch/providers/shadowfax.adapter.ts'] },
};
const candidateIndex = process.argv.indexOf('--candidate');
const selected = candidateIndex < 0 ? 'all' : process.argv[candidateIndex + 1];
if (!['pos', 'dispatch', 'all'].includes(selected)) throw new Error('Unknown candidate scope');
const candidates = Object.fromEntries(Object.entries(knownCandidates).filter(([name]) => selected === 'all' || name === selected));
const stamp = process.argv[2] || new Date().toISOString().replace(/[:.]/g, '-');
if (!/^[a-zA-Z0-9_-]+$/.test(stamp)) throw new Error('Invalid snapshot label');
const out = path.join(BASE, 'snapshots', stamp);
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'manifest.json'))) throw new Error('Snapshots are immutable; choose a new label');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const manifest = { createdAt: new Date().toISOString(), label: stamp, scope: selected, acceptance: false, note: 'Capture alone is NOT acceptance. Final checks require separately supplied owner-ready hashes. Only frozen copied bytes may execute.', dependenciesFrom: DEPENDENCY_PACKAGE, candidates: {}, files: [] };
for (const [name, candidate] of Object.entries(candidates)) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: candidate.root, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  manifest.candidates[name] = { root: candidate.root, head: head.status === 0 ? head.stdout.trim() : 'unavailable', entries: candidate.entries, auxiliary: candidate.auxiliary || [] };
  const queue = [...candidate.entries];
  const visited = new Set();
  while (queue.length) {
    const rel = queue.shift().replaceAll('\\', '/');
    if (visited.has(rel)) continue;
    visited.add(rel);
    if (!rel.endsWith('.ts') || !rel.startsWith('functions/src/') || rel.includes('/../')) throw new Error('Refusing non-source path: ' + rel);
    const source = path.join(candidate.root, rel);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('Verified entry/dependency missing: ' + source);
    const before = fs.statSync(source);
    const bytes = fs.readFileSync(source);
    const after = fs.statSync(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Source changed during read: ' + source);
    const destination = path.join(out, name, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    manifest.files.push({ candidate: name, relativePath: rel, sha256: sha(bytes), bytes: bytes.length, sourceMtimeMs: before.mtimeMs });
    for (const imp of ts.preProcessFile(bytes.toString('utf8'), true, true).importedFiles) {
      if (!imp.fileName.startsWith('.')) continue;
      const stem = path.resolve(path.dirname(source), imp.fileName);
      const target = [stem + '.ts', path.join(stem, 'index.ts')].find(f => fs.existsSync(f) && fs.statSync(f).isFile());
      if (!target) throw new Error('Unresolved local import: ' + imp.fileName + ' from ' + source);
      const relative = path.relative(candidate.root, target).replaceAll('\\', '/');
      if (!relative.startsWith('functions/src/')) throw new Error('Dependency outside functions/src requires explicit review: ' + relative);
      queue.push(relative);
    }
  }
  for (const rel of candidate.auxiliary || []) {
    const source = path.join(candidate.root, rel);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('Verified auxiliary source missing: ' + source);
    const bytes = fs.readFileSync(source);
    const destination = path.join(out, name, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    manifest.files.push({ candidate: name, relativePath: rel, sha256: sha(bytes), bytes: bytes.length, auxiliaryNotExecuted: true });
  }
}
// Detect cross-file edits during capture; never silently combine changing bytes.
for (const item of manifest.files) {
  const original = path.join(candidates[item.candidate].root, item.relativePath);
  if (sha(fs.readFileSync(original)) !== item.sha256) throw new Error('Capture raced an edit; discard snapshot label: ' + original);
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ event: 'snapshot-captured-not-accepted', directory: out, fileCount: manifest.files.length, entryHashes: manifest.files.filter(f => candidates[f.candidate].entries.includes(f.relativePath)) }, null, 2));
