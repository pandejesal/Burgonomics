// rules-money-ownership.emulator.test.mjs
// OWNED ACCEPTANCE HARNESS — stages/08_menu/output/integration-acceptance-20261029/firebase-qa/
// NOT a shipped production test suite file. Runs against the LOCALLY CACHED Firestore
// emulator on loopback 127.0.0.1:${FIRESTORE_EMULATOR_PORT} under a SYNTHETIC demo project.
// No live Firebase, no credentials, no FCM, no storage, no functions, no production contact.
//
// Usage:
//   node rules-money-ownership.emulator.test.mjs <rulesFile> probe <outJson> [outLabel]
//   node rules-money-ownership.emulator.test.mjs <rulesFile> gate  <outJson> [outLabel]
//   (Rules file is a SOURCE-OF-TRUTH path: root repo rules, or the worktree candidate.)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc } from 'firebase/firestore';

const PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8166);
const HOST = '127.0.0.1';
const PROJECT_ID = 'demo-money-qa-20261029';

const rulesFile = process.argv[2];
const mode = process.argv[3]; // 'probe' | 'gate'
const outJson = process.argv[4];
const outLabel = process.argv[5] ?? 'run';

if (!rulesFile || !mode || !outJson) {
  console.error('usage: node rules-money-ownership.emulator.test.mjs <rulesFile> <probe|gate> <outJson> [label]');
  process.exit(2);
}

// Field groups whose state is SERVER-OWNED (Admin SDK writes only). The branch/staff
// arm of orders.update already carries this exact denylist on root policy (L277-284).
// The brand arm on root policy (L272 `allow update: if isBrandOwner() ||`) carries
// NO mask -> regression to reproduce (brand-owner client money writes succeed).
const MONEY_FIELDS = [
  ['paymentStatus', { paymentStatus: 'paid' }],
  ['payment', { payment: { status: 'verified', method: 'razorpay' } }],
  ['totals', { totals: { grandTotal: 1, tax: 1 } }],
  ['pricingSnapshot', { pricingSnapshot: { total: 1 } }],
  ['pricing', { pricing: { discounted: 1 } }],
  ['refundStatus', { refundStatus: 'processed' }],
  ['refundId', { refundId: 'rf_test_1' }],
  ['refundAmount', { refundAmount: 1 }],
  ['routeTransferStatus', { routeTransferStatus: 'rerouted' }],
  ['deliveryOtpHash', { deliveryOtpHash: 'deadbeef' }],
  ['deliveryOtpAttempts', { deliveryOtpAttempts: { count: 3 } }],
];

const PLACED = { code: 'PLACED', label: 'Placed', kind: 'upcoming', terminal: false };
const CANCELLED = { code: 'CANCELLED', label: 'Cancelled', kind: 'cancelled', terminal: true };
const IN_PREP = { code: 'IN_PREPARATION', label: 'In Preparation', kind: 'upcoming', terminal: false };

const rows = [];
const violations = [];

let testEnv;
async function attempt(fn) {
  try { await fn(); return { allowed: true }; }
  catch (e) { return { allowed: false, code: e?.code ?? String(e) }; }
}
function record(row, res, expect) {
  const r = { ...row, allowed: res.allowed, code: res.code ?? null, expect };
  rows.push(r);
  if (mode === 'gate') {
    const ok = expect === 'deny' ? !res.allowed : res.allowed;
    if (!ok) violations.push(`[${r.stage}] role=${r.role} op=${r.op} field=${r.field ?? '-'} doc=${r.docId} allowed=${res.allowed} code=${res.code ?? '-'} EXPECT=${expect}`);
  }
}

const rules = readFileSync(rulesFile, 'utf8');
testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: { rules, host: HOST, port: PORT },
});

// ---------------------------------------------------------------- seeds (admin bypass)
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'admins', 'brand_1'), { role: 'brand_owner', email: 'brand@qa.local' });
  await setDoc(doc(db, 'admins', 'dev_1'), { role: 'developer', email: 'dev@qa.local' });
  await setDoc(doc(db, 'admins', 'staff_1'), { role: 'branch_owner', branchId: 'branch_01', email: 's1@qa.local' });
  await setDoc(doc(db, 'admins', 'staff_2'), { role: 'branch_owner', branchId: 'branch_01', email: 's2@qa.local' });
  // orders_shared: branch_01 order; orders_f: branch_02 (foreign to staff_1); orders_x: staff_x target; orders_c: customer-owned
  const base = { customerId: 'cust_1', userId: 'cust_1', branchId: 'branch_01', status: PLACED, createdAt: 't0', updatedAt: 't0' };
  await setDoc(doc(db, 'orders', 'orders_shared'), { ...base });
  await setDoc(doc(db, 'orders', 'orders_f'), { ...base, branchId: 'branch_02' });
  await setDoc(doc(db, 'orders', 'orders_x'), { ...base });
  await setDoc(doc(db, 'orders', 'orders_c'), { ...base });
});

// contexts
const anon = () => testEnv.unauthenticatedContext();
const cust = () => testEnv.authenticatedContext('cust_1', { email: 'c@qa.local' });
const staff1 = () => testEnv.authenticatedContext('staff_1');
const staffNoClaims = () => testEnv.authenticatedContext('staff_x', { role: 'branch_owner' });
const foreign1 = () => testEnv.authenticatedContext('staff_1'); // same uid claim pattern; foreign doc branch_02
const foreignStaff = () => testEnv.authenticatedContext('staff_2'); // admins doc branch_01; targets branch_02 doc -> foreign
const brand = () => testEnv.authenticatedContext('brand_1');
const dev = () => testEnv.authenticatedContext('dev_1');

// ------------------------------------------------------------ INVARIANTS (root AND candidate identical): deny
const stage = outLabel;
for (const [field, patch] of MONEY_FIELDS) {
  // unauthenticated client
  record({ stage, role: 'anon', op: 'update', field, docId: 'orders_shared' },
    await attempt(() => updateDoc(doc(anon().firestore(), 'orders', 'orders_shared'), patch)), 'deny');
  // customer (owner of orders_c) — customer arms are masked on root already
  record({ stage, role: 'customer', op: 'update', field, docId: 'orders_c' },
    await attempt(() => updateDoc(doc(cust().firestore(), 'orders', 'orders_c'), patch)), 'deny');
  // branch staff of branch_01 on branch_01 doc — branch arm already masked on root
  record({ stage, role: 'branch-staff-own', op: 'update', field, docId: 'orders_shared' },
    await attempt(() => updateDoc(doc(staff1().firestore(), 'orders', 'orders_shared'), patch)), 'deny');
  // staff with role CLAIM but no branchIds/claims + no admins doc — fail-closed
  record({ stage, role: 'branch-staff-missing-claims', op: 'update', field, docId: 'orders_x' },
    await attempt(() => updateDoc(doc(staffNoClaims().firestore(), 'orders', 'orders_x'), patch)), 'deny');
  // foreign-branch staff (branch_01 admin doc) on branch_02 doc
  record({ stage, role: 'foreign-branch-staff', op: 'update', field, docId: 'orders_f' },
    await attempt(() => updateDoc(doc(foreignStaff().firestore(), 'orders', 'orders_f'), patch)), 'deny');
}

// brand-owner + developer client writes to the SAME server-owned fields:
// ROOT policy: these SUCCEED (the regression). MASKED candidate: must DENY.
for (const [field, patch] of MONEY_FIELDS) {
  record({ stage, role: 'brand-owner', op: 'update', field, docId: 'orders_shared' },
    await attempt(() => updateDoc(doc(brand().firestore(), 'orders', 'orders_shared'), patch)), 'deny');
  record({ stage, role: 'developer', op: 'update', field, docId: 'orders_shared' },
    await attempt(() => updateDoc(doc(dev().firestore(), 'orders', 'orders_shared'), patch)), 'deny');
}

// reads: anon deny; customer read own allow; foreign staff read foreign branch order deny
record({ stage, role: 'anon', op: 'read', field: '-', docId: 'orders_shared' },
  await attempt(() => getDoc(doc(anon().firestore(), 'orders', 'orders_shared'))), 'deny');
record({ stage, role: 'customer', op: 'read', field: '-', docId: 'orders_c' },
  await attempt(() => getDoc(doc(cust().firestore(), 'orders', 'orders_c'))), 'allow');
record({ stage, role: 'foreign-branch-staff', op: 'read', field: '-', docId: 'orders_f' },
  await attempt(() => getDoc(doc(foreignStaff().firestore(), 'orders', 'orders_f'))), 'deny');

// ------------------------------------------------------------ INVARIANTS: legit operations must stay allowed
// branch staff workflow status update on own-branch order
record({ stage, role: 'branch-staff-own', op: 'legit-status-update', field: 'status', docId: 'orders_shared' },
  await attempt(() => updateDoc(doc(staff1().firestore(), 'orders', 'orders_shared'), { status: IN_PREP, updatedAt: 't1' })), 'allow');
// customer cancels own pre-terminal order
record({ stage, role: 'customer', op: 'legit-cancel', field: 'status', docId: 'orders_c' },
  await attempt(() => updateDoc(doc(cust().firestore(), 'orders', 'orders_c'), { status: CANCELLED, completedAt: 't1', updatedAt: 't1' })), 'allow');
// customer whatsapp opt-in flag
record({ stage, role: 'customer', op: 'legit-whatsapp-optin', field: 'whatsappOptIn', docId: 'orders_c' },
  await attempt(() => updateDoc(doc(cust().firestore(), 'orders', 'orders_c'), { whatsappOptIn: true, updatedAt: 't2' })), 'allow');
// partner POS walk-in create (cash tendered at counter, PLACED status, own outlet)
record({ stage, role: 'branch-staff-own', op: 'legit-walkin-create', field: '-', docId: 'orders_walkin_1' },
  await attempt(() => setDoc(doc(staff1().firestore(), 'orders', 'orders_walkin_1'), { customerId: 'cust_walkin', userId: 'staff_1', branchId: 'branch_01', paymentStatus: 'completed', status: PLACED, createdAt: 't1' })), 'allow');
// customer creates a clean own order
record({ stage, role: 'customer', op: 'legit-customer-create', field: '-', docId: 'orders_c_new' },
  await attempt(() => setDoc(doc(cust().firestore(), 'orders', 'orders_c_new'), { customerId: 'cust_1', userId: 'cust_1', branchId: 'branch_01', status: PLACED, createdAt: 't1' })), 'allow');

// ------------------------------------------------------------ INVARIANTS: banned-plant create denied
record({ stage, role: 'customer', op: 'banned-plant-create', field: 'refundStatus', docId: 'orders_c_evil' },
  await attempt(() => setDoc(doc(cust().firestore(), 'orders', 'orders_c_evil'), { customerId: 'cust_1', userId: 'cust_1', branchId: 'branch_01', status: PLACED, refundStatus: 'processed' })), 'deny');
record({ stage, role: 'branch-staff-own', op: 'banned-plant-create', field: 'petpoojaOrderId', docId: 'orders_s_evil' },
  await attempt(() => setDoc(doc(staff1().firestore(), 'orders', 'orders_s_evil'), { customerId: 'cust_walkin', userId: 'staff_1', branchId: 'branch_01', status: PLACED, petpoojaOrderId: 'POS-001' })), 'deny');
// unauth create regardless of shape
record({ stage, role: 'anon', op: 'banned-plant-create', field: 'paymentStatus', docId: 'orders_a_evil' },
  await attempt(() => setDoc(doc(anon().firestore(), 'orders', 'orders_a_evil'), { customerId: 'cust_1', userId: 'cust_1', branchId: 'branch_01', status: PLACED, paymentStatus: 'pending' })), 'deny');

// ------------------------------------------------------------ summary + exit
const denyRows = rows.filter(r => r.expect === 'deny');
const allowRows = rows.filter(r => r.expect === 'allow');
const denyAllowed = denyRows.filter(r => r.allowed === true);
const allowDenied = allowRows.filter(r => r.allowed === false);

mkdirSync(path.dirname(outJson), { recursive: true });
const summary = {
  outLabel, rulesFile, mode, host: HOST, port: PORT, projectId: PROJECT_ID,
  ruleFileSha256: null, rowsTotal: rows.length,
  denyRows: denyRows.length, denyRowViolations: denyAllowed.length,
  allowRows: allowRows.length, allowRowViolations: allowDenied.length,
  violations, rows,
};
let passed;
if (mode === 'gate') {
  passed = violations.length === 0;
} else {
  passed = undefined; 
}
writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8');

console.log(`[harness:${outLabel}] rows=${rows.length} deny-rows=${denyRows.length} deny-violations=${denyAllowed.length} allow-rows=${allowRows.length} allow-violations=${allowDenied.length} mode=${mode}`);
for (const v of violations) console.log(`  VIOLATION ${v}`);
await testEnv.cleanup();
if (mode === 'gate') {
  console.log(passed ? `GATE PASS (${outLabel})` : `GATE FAIL (${outLabel}) — exit 1`);
  process.exit(passed ? 0 : 1);
}
console.log(`PROBE COMPLETE (${outLabel})`);
process.exit(0);

