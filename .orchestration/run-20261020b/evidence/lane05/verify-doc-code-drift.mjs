#!/usr/bin/env node
/**
 * lane05 - doc-vs-code drift probe for the ambiguous-book contract.
 *
 * WHAT IT CHECKS
 *  A) CODE FACTS (must hold in the working tree):
 *     A1 borzo.adapter.ts      throws a PLAIN error tagged PROVIDER_BOOK_AMBIGUOUS
 *     A2 shadowfax.adapter.ts  throws a PLAIN error tagged PROVIDER_BOOK_AMBIGUOUS
 *     A3 porter.service.ts     tags the same condition (err.code = PROVIDER_BOOK_AMBIGUOUS)
 *     A4 porter.adapter.ts     does NOT preserve it (no tag reference AND no code-equality check)
 *     A5 dispatch.router.ts    walks on only for ProviderDispatchError (failover contract)
 *     A6 borzo.adapter.ts      exposes the borzoBookAmbiguous() helper with >=3 throw sites
 *  B) DOC FACTS (what references/delivery_routing.md is allowed to claim):
 *     A7 the doc must not pin line numbers on the concurrently-edited adapters
 *     B1 the doc must not assert the ambiguity rule holds universally (widened patterns)
 *     B2 the doc must carry a Porter deviation note with NEGATIVE polarity
 *     B3 CONSISTENCY: deviation note present iff the code actually drifts (both directions)
 *
 * LIMITS, STATED HONESTLY: this is a text-level probe. A sufficiently creative paraphrase
 * can still evade a regex list, and an adapter fix that hides the tag behind an imported
 * constant name this script does not know would read as "still drifting". B3 ties the two
 * directions together so the common failure (code fixed, doc left stale / code drifting,
 * doc claims compliance) is caught; the independent human/GLM verifier covers the rest.
 *
 * FAILS (exit 1) when the doc and the code disagree. PASSES (exit 0) when they match.
 *
 * USAGE
 *   node verify-doc-code-drift.mjs [--repo <root>] [--doc <md>] [--json <out>]
 * `--doc` lets the same probe run against another revision of the doc
 * (e.g. `git show HEAD:references/delivery_routing.md > old.md`) as a control.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const REPO = path.resolve(arg("--repo", path.resolve(HERE, "../../../..")));
const DOC = path.resolve(arg("--doc", path.join(REPO, "references/delivery_routing.md")));
const JSON_OUT = arg("--json", null);

const P = {
  borzo: path.join(REPO, "functions/src/modules/dispatch/providers/borzo.adapter.ts"),
  shadowfax: path.join(REPO, "functions/src/modules/dispatch/providers/shadowfax.adapter.ts"),
  porterAdapter: path.join(REPO, "functions/src/modules/dispatch/providers/porter.adapter.ts"),
  porterService: path.join(REPO, "functions/src/modules/porter/porter.service.ts"),
  router: path.join(REPO, "functions/src/modules/dispatch/dispatch.router.ts"),
};

const read = (p) => readFileSync(p, "utf8");
const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} - ${detail}`);
};

let code, doc;
try {
  code = {
    borzo: read(P.borzo),
    shadowfax: read(P.shadowfax),
    porterAdapter: read(P.porterAdapter),
    porterService: read(P.porterService),
    router: read(P.router),
  };
  doc = read(DOC);
} catch (err) {
  console.error(`probe could not read inputs: ${err.message}`);
  process.exit(2);
}

const AMBIG = "PROVIDER_BOOK_AMBIGUOUS";
const TAGGED = `err.code = "${AMBIG}"`;
/** The adapter "preserves" the tag if it references it at all, or checks it by equality. */
const porterAdapterReferencesTag =
  code.porterAdapter.includes(AMBIG) ||
  /\.code\s*===\s*["'][A-Z_]*AMBIGUOUS[A-Z_]*["']/.test(code.porterAdapter);

// --- A) code facts ---------------------------------------------------------
check(
  "A1",
  code.borzo.includes(TAGGED),
  "borzo.adapter.ts throws a plain error tagged " + AMBIG
);
check(
  "A2",
  code.shadowfax.includes(TAGGED) && /new Error\(/.test(code.shadowfax),
  "shadowfax.adapter.ts throws a plain error tagged " + AMBIG
);
check(
  "A3",
  code.porterService.includes(TAGGED),
  "porter.service.ts tags the no-order-id condition as " + AMBIG
);
check(
  "A4",
  porterAdapterReferencesTag === false,
  porterAdapterReferencesTag === false
    ? "porter.adapter.ts does NOT reference the tag (drift: ambiguity is re-wrapped as transient)"
    : "porter.adapter.ts references the tag - ambiguity may now be preserved; re-check the doc deviation note"
);
check(
  "A5",
  /isProviderDispatchError\(err\)\) \{[\s\S]{0,600}?continue;/.test(code.router),
  "dispatch.router.ts walks on (continue) only for ProviderDispatchError"
);
check(
  "A5b",
  /\/\/[^\n]*(?:Unexpected error|release the claim)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*await releaseClaimFailed\([\s\S]{0,300}?\);\s*throw err;/.test(
    code.router
  ),
  "dispatch.router.ts releases the claim then RETHROWS for plain errors, anchored on the comment immediately above the call (a mutation that folds plain errors into the walk must fail this)"
);
// A6: the tagged throw anchor must exist in SOME form (helper function or inline throw
// sites). The adapter is being rewritten by another lane, so the shape is allowed to vary;
// the doc is required to cite it by behaviour/symbol rather than by line number (A7).
const borzoHelper = /function borzoBookAmbiguous\(/.test(code.borzo);
const borzoThrowSites = (code.borzo.match(/throw\s+borzoBookAmbiguous\(/g) || []).length;
const borzoInlineTaggedThrows = (code.borzo.match(new RegExp(`err\\.code = "${AMBIG}"`, "g")) || [])
  .length;
check(
  "A6",
  borzoHelper ? borzoThrowSites >= 1 : borzoInlineTaggedThrows >= 1,
  borzoHelper
    ? `borzo.adapter.ts uses the borzoBookAmbiguous() helper with ${borzoThrowSites} throw site(s)`
    : `borzo.adapter.ts uses ${borzoInlineTaggedThrows} inline tagged throw site(s)`
);

// --- B) doc facts ---------------------------------------------------------
// A7: do not pin line numbers on files other lanes are actively editing.
check(
  "A7",
  !/borzo\.adapter\.ts:\d/.test(doc) && !/shadowfax\.adapter\.ts:\d/.test(doc),
  /borzo\.adapter\.ts:\d/.test(doc) || /shadowfax\.adapter\.ts:\d/.test(doc)
    ? "doc pins line numbers on adapter files that are being edited concurrently"
    : "doc cites the concurrently-edited adapters by symbol, not by line number"
);

// B1: no universal-compliance claim. Two detectors:
//  (i) explicit phrasings; (ii) any bullet/paragraph that asserts Porter itself complies.
const UNIVERSAL_PATTERNS = [
  /same rule for all three providers/i,
  /\bholds? for all (three )?providers\b/i,
  /\bapplies to all (three )?providers\b/i,
  /(rule|guarantee|contract)[^.\n]{0,40}(holds?|applies|extend\w*|preserv\w*|inherit\w*)[^.\n]{0,60}porter/i,
  /porter[^.\n]{0,60}(preserv\w*|inherit\w*|extend\w*)[^.\n]{0,40}(ambiguit|contract|rule|guarantee|no-failover)/i,
  /(borzo|shadowfax)[^.\n]{0,60}porter[^.\n]{0,60}(comply|complian|honou?r|satisf|implement|preserv|inherit|extend)/i,
];
const explicitHit = UNIVERSAL_PATTERNS.find((re) => re.test(doc));
// Bullet/paragraph-level scan: split on blank lines and list/heading markers.
const blocks = doc.split(/\r?\n(?=\s*(?:[-*#|]|\d+\.))|\r?\n\s*\r?\n/);
const RULE_CONTEXT =
  /(ambiguit|failover|fail-over|fail over|no-failover|PROVIDER_BOOK_AMBIGUOUS|second courier|second real courier|walk)/i;
// Positive-guarantee phrasings: asserting a property that only a FIXED adapter could have.
const POSITIVE_GUARANTEE =
  /(never books a second|no second courier is (ever )?(booked|added|possible)|cannot book a second)/i;
// Negation must be positional AND scoped to a rule-violation word. "Porter does not FAIL the
// no-failover rule" phrased that way still asserts compliance, so a bare "not"/"never" must NOT
// buy the exemption (GLM counter 2); only drift-conceding verbs do.
const SCOPED_NEGATION =
  /(does not|doesn't|do not|\bnot\b|no longer)[^.;]{0,40}(satisf|holds\b|compl|implement)/i;
const DEVIATION_PHRASES =
  /(does not satisfy|does not implement|not satisfied|does not hold|do not rely on|KNOWN DEVIATION|deviation)/i;
// Porter must be the GRAMMATICAL subject (±40 chars) of a rule-compliance verb -- "staff books
// a rider in the Porter app" (DR8) is normal usage, so "books"/"books a rider" is excluded and
// only ambiguity-rule compliance verbs count here.
const SUBJECT_COMPLIANCE =
  /(\bPorter\b[^.;\n]{0,40}\b(complies|compliant|honou?r[sz]?\w*|satisfies|implements|applies|extends?|preserves?|inherits?|rethrow\w*|reraise\w*|throws?)\b|\b(complies|compliant|honou?r[sz]?\w*|satisfies|implements|applies|extends?|preserves?|inherits?|rethrow\w*|reraise\w*|throws?)\b[^.;\n]{0,40}\bPorter\b)/i;
const porterAssertion = blocks.find(
  (b) =>
    /\bPorter\b/.test(b) &&
    RULE_CONTEXT.test(b) &&
    (SUBJECT_COMPLIANCE.test(b) || POSITIVE_GUARANTEE.test(b)) &&
    !SCOPED_NEGATION.test(b) &&
    !DEVIATION_PHRASES.test(b)
);
const universalHit = explicitHit
  ? String(explicitHit)
  : porterAssertion
    ? `a Porter compliance assertion: "${porterAssertion.trim().slice(0, 120)}"`
    : null;
check(
  "B1",
  !universalHit,
  universalHit
    ? `delivery_routing.md still asserts compliance the code does not provide (${universalHit})`
    : "delivery_routing.md makes no universal-compliance claim"
);

// B2: the deviation note must exist AND have negative polarity.
const deviationWindow = (() => {
  const i = doc.search(/KNOWN DEVIATION/i);
  if (i < 0) return "";
  return doc.slice(i, i + 700);
})();
const deviationPresent = /KNOWN DEVIATION[\s\S]{0,400}?Porter/i.test(doc);
const negativePolarity =
  /(does not satisfy|does not implement|not satisfied|does not hold|do not rely on)/i.test(
    deviationWindow
  );
const falseResolution =
  /(now (also )?(compl|satisf|honou?r)|is (now )?(fully )?compliant|resolved|fixed|has been fixed)/i.test(
    deviationWindow
  );
const docDeclaresDeviation = deviationPresent && negativePolarity && !falseResolution;
check(
  "B2",
  docDeclaresDeviation,
  docDeclaresDeviation
    ? "delivery_routing.md carries a Porter deviation note with negative polarity"
    : !deviationPresent
      ? "delivery_routing.md has no Porter KNOWN DEVIATION note"
      : negativePolarity && falseResolution
        ? "the deviation note is polarity-ambiguous (contains a resolution claim)"
        : "the deviation note does not state Porter fails the rule"
);

// B3: bidirectional consistency - note present iff the code drifts.
const codeDrifts = porterAdapterReferencesTag === false;
const consistent = codeDrifts ? docDeclaresDeviation : !docDeclaresDeviation;
check(
  "B3",
  consistent,
  consistent
    ? codeDrifts
      ? "code drifts and the doc declares the deviation (consistent)"
      : "code no longer drifts and the doc declares no deviation (consistent)"
    : codeDrifts
      ? "code drifts but the doc does not declare the deviation"
      : "code no longer drifts but the doc still declares an open deviation (stale)"
);

const failed = results.filter((r) => !r.ok);
const summary = {
  repo: REPO,
  doc: DOC,
  porterAdapterReferencesTag,
  codeDrifts,
  docDeclaresDeviation,
  passed: results.length - failed.length,
  failed: failed.length,
  failedIds: failed.map((r) => r.id),
  verdict: failed.length ? "DRIFT_PRESENT" : "DOC_MATCHES_CODE",
};
console.log(JSON.stringify(summary, null, 2));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, results }, null, 2));
process.exit(failed.length ? 1 : 0);
