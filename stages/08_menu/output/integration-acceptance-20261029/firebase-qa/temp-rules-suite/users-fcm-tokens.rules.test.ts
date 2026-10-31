import { readFileSync } from "fs";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
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
  arrayUnion,
  arrayRemove,
  deleteField,
  serverTimestamp,
} from "firebase/firestore";

/**
 * Lane 07 (Firebase) — FCM fan-out list ownership on users/{uid}.
 *
 * The server owns device-token identity: POST /notifications/registerToken
 * (functions/src/core/deviceTokenRegister.ts) refuses to rebind a token that
 * another account already owns (409), and POST /notifications/unregisterToken
 * refuses non-owner deletes. Those refusals are meaningless if the client SDK
 * can write the same fan-out field directly: fcmClient.ts reads
 * users/{uid}.fcmTokens, so a client-side append re-creates exactly the
 * foreign-token adoption the server gate rejects.
 *
 * Client writers, verified by grep of both app sources:
 *  - profile creation (authService.ts setDoc)  -> id/phone/createdAt only
 *  - profile update  (profileService.ts setDoc) -> cleanPatch, never fcmTokens
 *  - logout fallback (notificationsService.ts unlinkUserFromDeviceToken)
 *    -> fcmTokens: arrayRemove(token) + updatedAt on the caller's OWN doc
 *  - no brand/operator client writer touches fcmTokens (grep of
 *    burgonomics-partner/src finds the field nowhere)
 *
 * Contract asserted here: the client may only SHRINK the fan-out list (subset
 * of the stored list, never larger), may not plant it at creation, and brand
 * authority is bounded by the same invariant. Adding a token stays server-only
 * (Admin SDK bypasses rules).
 */

const PROJECT_ID = "burgonomics-test-rules";
const EMULATOR_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);

const OWNER_UID = "fcm_owner";
const OWN_TOKENS = ["tok_owner_aaa", "tok_owner_bbb"];
const FOREIGN_TOKEN = "tok_stranger_zzz";

describe("Firestore Security Rules — users/{uid}.fcmTokens is removal-only", () => {
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
          "Firestore emulator unavailable in CI — the rules job must start it (see .github/workflows/ci.yml `rules` job).",
        );
      }
      context.skip();
      return;
    }

    await testEnv.clearFirestore();

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // Owner profile as the server writes it (registerToken arrayUnion).
      await setDoc(doc(db, "users", OWNER_UID), {
        id: OWNER_UID,
        phone: "+919800000001",
        fullName: "FCM Owner",
        fcmTokens: OWN_TOKENS,
      });
      // Legacy profile created before push existed (no fcmTokens key at all).
      await setDoc(doc(db, "users", "fcm_nofield"), {
        id: "fcm_nofield",
        phone: "+919800000003",
        fullName: "No Field Yet",
      });
      // Brand authority fixture (tenant fields stay brand-writable).
      await setDoc(doc(db, "admins", "brand_owner_1"), {
        role: "brand_owner",
        email: "brand@burgonomics.com",
      });
    });
  });

  it("1. [FCM-SELF-APPEND-DENY] owner cannot arrayUnion a foreign token onto their fan-out list", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: arrayUnion(FOREIGN_TOKEN),
      }),
    );
  });

  it("2. [FCM-SELF-REPLACE-DENY] owner cannot replace the list with a foreign token", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: [FOREIGN_TOKEN],
      }),
    );
  });

  it("3. [FCM-CREATE-PLANT-DENY] self profile creation cannot plant fcmTokens", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const newDb = testEnv!.authenticatedContext("fcm_new").firestore();

    await assertFails(
      setDoc(doc(newDb, "users", "fcm_new"), {
        id: "fcm_new",
        phone: "+919800000002",
        fcmTokens: [FOREIGN_TOKEN],
      }),
    );
  });

  it("4. [FCM-LOGOUT-ARRAYREMOVE-ALLOW] owner may arrayRemove their own token with updatedAt (logout fallback payload)", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    // Exact notificationsService.unlinkUserFromDeviceToken fallback payload.
    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: arrayRemove("tok_owner_aaa"),
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it("5. [FCM-LOGOUT-STALE-REMOVE-ALLOW] removing an absent token stays a no-op success", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: arrayRemove("tok_already_gone"),
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it("6. [FCM-SUBSET-WRITE-ALLOW] owner may write any subset of the stored list", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: ["tok_owner_bbb"],
      }),
    );
    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: [],
      }),
    );
  });

  it("7. [FCM-CROSS-USER-WRITE-DENY] another signed-in user cannot touch the owner's fan-out list", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const attackerDb = testEnv!.authenticatedContext("fcm_attacker").firestore();

    await assertFails(
      updateDoc(doc(attackerDb, "users", OWNER_UID), {
        fcmTokens: [FOREIGN_TOKEN],
      }),
    );
  });

  it("8. [FCM-PROFILE-UPDATE-UNTOUCHED-ALLOW] ordinary profile updates still pass (no over-block)", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID), { fullName: "FCM Owner Renamed" }),
    );
  });

  it("9. [FCM-BRAND-FANOUT-DENY] brand authority cannot attach a foreign token either", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const brandDb = testEnv!.authenticatedContext("brand_owner_1").firestore();

    // Tenant/trust fields are brand-writable, but the token fan-out invariant
    // binds every client role — the Admin SDK seams are the only adders.
    await assertFails(
      updateDoc(doc(brandDb, "users", OWNER_UID), {
        fcmTokens: [FOREIGN_TOKEN],
      }),
    );
    await assertSucceeds(
      updateDoc(doc(brandDb, "users", OWNER_UID), {
        active: false,
        fcmTokens: ["tok_owner_aaa"],
      }),
    );
  });

  it("10. [FCM-REMOVAL-PERSISTS] an allowed removal leaves exactly the remaining token", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: arrayRemove("tok_owner_aaa"),
      }),
    );
    const snap = await getDoc(doc(ownerDb, "users", OWNER_UID));
    expect(snap.data()?.fcmTokens).toEqual(["tok_owner_bbb"]);
  });

  it("11. [FCM-NON-LIST-DENY] a non-list fcmTokens value is denied by the type guard", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: { leaked: FOREIGN_TOKEN },
      }),
    );
  });

  it("12. [FCM-SHRINK-PLUS-ROLE-DENY] a shrinking fcmTokens edit cannot smuggle a protected field", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: ["tok_owner_aaa"],
        role: "brand_owner",
      }),
    );
  });

  it("13. [FCM-MERGE-CREATE-PLANT-DENY] setDoc merge on a missing doc cannot plant fcmTokens", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const newDb = testEnv!.authenticatedContext("fcm_merge").firestore();

    // The shape profileService.update actually uses (setDoc + merge).
    await assertFails(
      setDoc(
        doc(newDb, "users", "fcm_merge"),
        { id: "fcm_merge", fcmTokens: [FOREIGN_TOKEN] },
        { merge: true },
      ),
    );
  });

  it("14. [FCM-DUP-INFLATE-DENY] duplicates cannot grow the list past its stored size", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    // Every element exists (hasOnly passes) but the array grew 2 -> 3.
    await assertFails(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: ["tok_owner_aaa", "tok_owner_aaa", "tok_owner_bbb"],
      }),
    );
  });

  it("15. [FCM-LEGACY-NO-FIELD-ALLOW] a profile with no fcmTokens key can still log out cleanly", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const legacyDb = testEnv!.authenticatedContext("fcm_nofield").firestore();

    await assertSucceeds(
      updateDoc(doc(legacyDb, "users", "fcm_nofield"), {
        fcmTokens: arrayRemove("tok_unknown_device"),
      }),
    );
  });

  it("16. [FCM-MERGE-EXISTING-DENY] setDoc merge over an existing doc cannot append a foreign token", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    // Existing doc -> update semantics: the subset arm must still bind.
    await assertFails(
      setDoc(
        doc(ownerDb, "users", OWNER_UID),
        { fcmTokens: [...OWN_TOKENS, FOREIGN_TOKEN] },
        { merge: true },
      ),
    );
  });

  it("17. [FCM-READD-AFTER-SHRINK-DENY] a token removed earlier cannot be re-added in a later write", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: arrayRemove("tok_owner_aaa"),
      }),
    );
    // Resource is now ['tok_owner_bbb']; re-adding 'tok_owner_aaa' must fail,
    // proving the guard reads the committed resource, not a cached intent.
    await assertFails(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: OWN_TOKENS,
      }),
    );
  });

  it("18. [FCM-DELETE-FIELD-ALLOW] deleteField clears the list and cannot be undone by an add", async (context) => {
    if (!emulatorAvailable) return context.skip();
    const ownerDb = testEnv!.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: deleteField(),
      }),
    );
    // Field is now absent -> the stored set is empty, so re-adding is denied.
    await assertFails(
      updateDoc(doc(ownerDb, "users", OWNER_UID), {
        fcmTokens: ["tok_owner_aaa"],
      }),
    );
  });
});
