import { readFileSync } from "fs";
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  Timestamp,
} from "firebase/firestore";

/**
 * Lane 07 — branch_announcements is branch-scoped.
 *
 * The rules were bare `isStaff()` on create/update/delete, but the WRITER
 * stamps a branchId the caller merely picked: partner
 * src/hooks/useBranches.ts broadcastLaunchAlert (BranchesPage.tsx:120) does
 *   addDoc('branch_announcements', { branchId, branchName, title, body,
 *     targetTopic: `upcoming_${branchId}`, createdAt })
 * and then POSTs /notifications/broadcast to fan out to `upcoming_<branchId>`.
 *
 * Unscoped, a branch operator of branch_02 could (a) publish an announcement
 * stamped branch_01 — it renders as a Navrangpura announcement for every
 * reader and the follow-up fan-out pushes to branch_01's subscribers; and
 * (b) update or delete ANY branch's announcement record (audit tampering),
 * since update/delete were bare isStaff() too. Brand/developer authority is
 * unaffected: ownsBranch() returns true for brand roles.
 */

const PROJECT_ID = "burgonomics-test-rules";
const EMULATOR_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);

const ANNOUNCEMENT_DOC = "ann_branch_01_1";

describe("Firestore Security Rules — branch_announcements is branch-scoped", () => {
  let testEnv: RulesTestEnvironment | null = null;
  let emulatorAvailable = false;

  beforeAll(async () => {
    try {
      testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
          rules: readFileSync("firestore.rules", "utf8"),
          host: "127.0.0.1",
          port: EMULATOR_PORT,
        },
      });
      emulatorAvailable = true;
    } catch {
      console.warn(
        `Firestore Emulator is not running on 127.0.0.1:${EMULATOR_PORT}. Skipping rules integration tests.`,
      );
      emulatorAvailable = false;
    }
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async (context) => {
    if (!emulatorAvailable || !testEnv) {
      if (process.env.CI === "true") {
        throw new Error(
          "Firestore emulator unavailable in CI — start one and run `node scripts/test-rules.mjs`.",
        );
      }
      context.skip();
      return;
    }

    await testEnv.clearFirestore();

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "admins", "brand_owner_1"), {
        role: "brand_owner",
        email: "brand@burgonomics.com",
      });
      await setDoc(doc(db, "admins", "branch_owner_1"), {
        role: "branch_owner",
        branchId: "branch_01",
      });
      await setDoc(doc(db, "admins", "branch_owner_2"), {
        role: "branch_owner",
        branchId: "branch_02",
      });
      await setDoc(doc(db, "branch_announcements", ANNOUNCEMENT_DOC), {
        branchId: "branch_01",
        branchName: "Burgonomics Navrangpura",
        title: "Launch day",
        body: "Branch is live",
        targetTopic: "upcoming_branch_01",
        createdAt: Timestamp.now(),
      });
    });
  });

  it("1. [ANNOUNCE-CROSS-BRANCH-CREATE-DENY] a branch operator cannot publish under another branch", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const b2Db = testEnv!.authenticatedContext("branch_owner_2").firestore();

    await assertFails(
      setDoc(doc(b2Db, "branch_announcements", "ann_branch_01_evil"), {
        branchId: "branch_01",
        branchName: "Burgonomics Navrangpura",
        title: "Launch day",
        body: "Branch is live",
        targetTopic: "upcoming_branch_01",
        createdAt: Timestamp.now(),
      }),
    );
  });

  it("2. [ANNOUNCE-CROSS-BRANCH-UPDATE-DENY] a branch operator cannot rewrite another branch's record", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const b2Db = testEnv!.authenticatedContext("branch_owner_2").firestore();

    await assertFails(
      updateDoc(doc(b2Db, "branch_announcements", ANNOUNCEMENT_DOC), {
        title: "Cross-branch tampering",
      }),
    );
  });

  it("3. [ANNOUNCE-CROSS-BRANCH-DELETE-DENY] a branch operator cannot erase another branch's record", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const b2Db = testEnv!.authenticatedContext("branch_owner_2").firestore();

    await assertFails(deleteDoc(doc(b2Db, "branch_announcements", ANNOUNCEMENT_DOC)));
  });

  it("4. [ANNOUNCE-CUSTOMER-DENY] customers (role claim) still cannot write announcements", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const custDb = testEnv!
      .authenticatedContext("cust_100", { role: "customer" })
      .firestore();

    await assertFails(
      setDoc(doc(custDb, "branch_announcements", "ann_cust_evil"), {
        branchId: "branch_01",
        branchName: "x",
        title: "spam",
        body: "spam",
        targetTopic: "upcoming_branch_01",
        createdAt: Timestamp.now(),
      }),
    );
  });

  it("5. [ANNOUNCE-OWN-BRANCH-ALLOW] a branch operator publishes for their own branch", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const b1Db = testEnv!.authenticatedContext("branch_owner_1").firestore();

    await assertSucceeds(
      setDoc(doc(b1Db, "branch_announcements", "ann_branch_01_countdown"), {
        branchId: "branch_01",
        branchName: "Burgonomics Navrangpura",
        title: "Launch countdown",
        body: "Branch is live",
        targetTopic: "upcoming_branch_01",
        createdAt: Timestamp.now(),
      }),
    );
  });

  it("6. [ANNOUNCE-INNER-PLANT-DENY] a branch operator cannot claim another branch inside their own doc's topic", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const b1Db = testEnv!.authenticatedContext("branch_owner_1").firestore();

    // Readable fields say branch_01 but the fan-out topic points to branch_02.
    await assertFails(
      setDoc(doc(b1Db, "branch_announcements", "ann_topic_hijack"), {
        branchId: "branch_01",
        branchName: "Burgonomics Navrangpura",
        title: "Countdown",
        body: "Branch is live",
        targetTopic: "upcoming_branch_02",
        createdAt: Timestamp.now(),
      }),
    );
  });

  it("7. [ANNOUNCE-TOPIC-BOUND] targetTopic must equal upcoming_<branchId>", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const b1Db = testEnv!.authenticatedContext("branch_owner_1").firestore();

    await assertSucceeds(
      setDoc(doc(b1Db, "branch_announcements", "ann_topic_ok"), {
        branchId: "branch_01",
        branchName: "x",
        title: "t",
        body: "b",
        targetTopic: "upcoming_branch_01",
        createdAt: Timestamp.now(),
      }),
    );
  });

  it("8. [ANNOUNCE-BRAND-ANY-BRANCH-ALLOW] brand authority keeps cross-branch operations", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const brandDb = testEnv!.authenticatedContext("brand_owner_1").firestore();

    await assertSucceeds(
      setDoc(doc(brandDb, "branch_announcements", "ann_brand_cross_branch"), {
        branchId: "branch_02",
        branchName: "Nehrunagar",
        title: "brand op",
        body: "b",
        targetTopic: "upcoming_branch_02",
        createdAt: Timestamp.now(),
      }),
    );
  });

  it("9. [ANNOUNCE-READ-PUBLIC] reads stay public for every rule state", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const anonDb = testEnv!.unauthenticatedContext().firestore();
    const { getDoc } = await import("firebase/firestore");
    await assertSucceeds(getDoc(doc(anonDb, "branch_announcements", ANNOUNCEMENT_DOC)));
  });

  it("10. [ANNOUNCE-APPEND-ONLY-DENY] no client can update or delete a record", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const b1Db = testEnv!.authenticatedContext("branch_owner_1").firestore();
    const brandDb = testEnv!.authenticatedContext("brand_owner_1").firestore();

    // Even the SAME branch and brand authority: no client update path exists
    // in either app (partner addDoc'ed only), and rewriting is the way an
    // audit record would be bent into another branch after creation.
    await assertFails(
      updateDoc(doc(b1Db, "branch_announcements", ANNOUNCEMENT_DOC), { title: "rewrite" }),
    );
    await assertFails(
      updateDoc(doc(b1Db, "branch_announcements", ANNOUNCEMENT_DOC), {
        branchId: "branch_02",
        targetTopic: "upcoming_branch_02",
      }),
    );
    await assertFails(
      updateDoc(doc(brandDb, "branch_announcements", ANNOUNCEMENT_DOC), { title: "brand rewrite" }),
    );
    await assertFails(updateDoc(doc(brandDb, "branch_announcements", ANNOUNCEMENT_DOC), { title: deleteField() }));
    await assertFails(deleteDoc(doc(b1Db, "branch_announcements", ANNOUNCEMENT_DOC)));
    await assertFails(deleteDoc(doc(brandDb, "branch_announcements", ANNOUNCEMENT_DOC)));
  });

  it("11. [ANNOUNCE-SUPPORT-GLOBAL-ALLOW] support keeps its shipped all-branch write", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const supportDb = testEnv!
      .authenticatedContext("support_1", { role: "support" })
      .firestore();

    await assertSucceeds(
      setDoc(doc(supportDb, "branch_announcements", "ann_support_02"), {
        branchId: "branch_02",
        branchName: "Nehrunagar",
        title: "Support notice",
        body: "Ops window",
        targetTopic: "upcoming_branch_02",
        createdAt: Timestamp.now(),
      }),
    );
  });

  it("12. [ANNOUNCE-REGIONAL-DENY] regional_manager no longer writes cross-city", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const regDb = testEnv!
      .authenticatedContext("regional_1", { role: "regional_manager" })
      .firestore();

    await assertFails(
      setDoc(doc(regDb, "branch_announcements", "ann_regional_02"), {
        branchId: "branch_02",
        branchName: "Nehrunagar",
        title: "Regional notice",
        body: "Ops window",
        targetTopic: "upcoming_branch_02",
        createdAt: Timestamp.now(),
      }),
    );
  });

  it("13. [ANNOUNCE-SHAPE-DENY] client payload is pinned to the six keys and text caps", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const b1Db = testEnv!.authenticatedContext("branch_owner_1").firestore();

    await assertFails(
      setDoc(doc(b1Db, "branch_announcements", "ann_extra_key"), {
        branchId: "branch_01",
        branchName: "x",
        title: "t",
        body: "b",
        targetTopic: "upcoming_branch_01",
        createdAt: Timestamp.now(),
        priority: 9,
      }),
    );
    await assertFails(
      setDoc(doc(b1Db, "branch_announcements", "ann_long_title"), {
        branchId: "branch_01",
        branchName: "x",
        title: "t".repeat(121),
        body: "b",
        targetTopic: "upcoming_branch_01",
        createdAt: Timestamp.now(),
      }),
    );
    await assertFails(
      setDoc(doc(b1Db, "branch_announcements", "ann_long_body"), {
        branchId: "branch_01",
        branchName: "x",
        title: "t",
        body: "b".repeat(1001),
        targetTopic: "upcoming_branch_01",
        createdAt: Timestamp.now(),
      }),
    );
  });

  it("14. [ANNOUNCE-SUBCOLLECTION-DENY] no subcollection escape hatch", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const b1Db = testEnv!.authenticatedContext("branch_owner_1").firestore();

    await assertFails(setDoc(doc(b1Db, "branch_announcements", ANNOUNCEMENT_DOC, "audit", "row_1"), { seeded: true }));
  });
});
