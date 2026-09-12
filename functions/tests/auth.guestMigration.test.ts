import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, savedDocs, batchUpdates, batchSets, batchDeletes } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const batchUpdates: Array<{ ref: any; data: any }> = [];
  const batchSets: Array<{ ref: any; data: any }> = [];
  const batchDeletes: Array<{ ref: any }> = [];

  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => {
        const id = docId || `mock_id_${Math.random().toString(36).substring(2, 7)}`;
        return {
          id,
          path: `${colName}/${id}`,
          set: vi.fn(async (data: any, options?: any) => {
            const docPath = `${colName}/${id}`;
            if (options?.merge && savedDocs[docPath]) {
              savedDocs[docPath] = { ...savedDocs[docPath], ...data };
            } else {
              savedDocs[docPath] = data;
            }
          }),
          get: vi.fn(async () => {
            const docPath = `${colName}/${id}`;
            return {
              exists: !!savedDocs[docPath],
              data: () => savedDocs[docPath] || {},
            };
          }),
          // Mirrors Firestore create(): fails when the doc already exists.
          create: vi.fn(async (data: any) => {
            const docPath = `${colName}/${id}`;
            if (savedDocs[docPath]) {
              const err: any = new Error("ALREADY_EXISTS: Document already exists");
              err.code = 6;
              throw err;
            }
            savedDocs[docPath] = data;
          }),
          delete: vi.fn(async () => {
            delete savedDocs[`${colName}/${id}`];
          }),
        };
      },
      where: (field: string, op: string, val: any) => {
        const createQuery = (filters: Array<{ field: string; op: string; val: any }>) => ({
          where: (f2: string, o2: string, v2: any) => createQuery([...filters, { field: f2, op: o2, val: v2 }]),
          limit: (n: number) => ({
            get: async () => {
              const matched: any[] = [];
              for (const [docPath, data] of Object.entries(savedDocs)) {
                if (!docPath.startsWith(`${colName}/`)) continue;
                const matchesAll = filters.every((f) => data[f.field] === f.val);
                if (matchesAll) {
                  matched.push({
                    ref: { id: docPath.replace(`${colName}/`, ""), path: docPath },
                    data: () => data,
                  });
                }
              }
              return {
                empty: matched.length === 0,
                docs: matched.slice(0, n),
              };
            },
          }),
          get: async () => {
            const matched: any[] = [];
            for (const [docPath, data] of Object.entries(savedDocs)) {
              if (!docPath.startsWith(`${colName}/`)) continue;
              const matchesAll = filters.every((f) => data[f.field] === f.val);
              if (matchesAll) {
                matched.push({
                  ref: { id: docPath.replace(`${colName}/`, ""), path: docPath },
                  data: () => data,
                });
              }
            }
            return {
              empty: matched.length === 0,
              docs: matched,
            };
          },
        });

        return createQuery([{ field, op, val }]);
      },
    }),
    batch: () => ({
      update: vi.fn((ref: any, data: any) => {
        batchUpdates.push({ ref, data });
        const docPath = ref.path || `orders/${ref.id}`;
        savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...data };
      }),
      set: vi.fn((ref: any, data: any, options?: any) => {
        batchSets.push({ ref, data });
        const docPath = ref.path || `docs/${ref.id}`;
        if (options?.merge && savedDocs[docPath]) {
          savedDocs[docPath] = { ...savedDocs[docPath], ...data };
        } else {
          savedDocs[docPath] = data;
        }
      }),
      delete: vi.fn((ref: any) => {
        batchDeletes.push({ ref });
        const docPath = ref.path || `docs/${ref.id}`;
        delete savedDocs[docPath];
      }),
      commit: async () => {},
    }),
  };

  return { mockDb, savedDocs, batchUpdates, batchSets, batchDeletes };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
  };

  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;

  // Default: the source UID is a genuine anonymous account (no providers).
  const mockAuth = {
    getUser: vi.fn(async (uid: string) => ({ uid, providerData: [] })),
  };

  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => mockAuth),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => mockAuth),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import {
  areAddressesDuplicate,
  verifyBonusEligibility,
  migrateGuestAccount,
} from "../src/modules/auth/guestMigration";

describe("Auth Module — Guest Account Migration, Order Relink & Loyalty Fraud Prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    batchUpdates.length = 0;
    batchSets.length = 0;
    batchDeletes.length = 0;
  });

  describe("1. Address Deduplication Algorithm", () => {
    it("detects duplicate addresses based on close GPS coordinates (< 50 meters)", () => {
      const addr1 = { lat: 23.0225, lng: 72.5714, fullAddress: "101 Alpha Tower, Ahmedabad" };
      const addr2 = { lat: 23.0226, lng: 72.5715, fullAddress: "Flat 101, Alpha Tower, Ahmedabad" };
      expect(areAddressesDuplicate(addr1, addr2)).toBe(true);
    });

    it("allows distinct addresses with different coordinates", () => {
      const addr1 = { lat: 23.0225, lng: 72.5714, fullAddress: "101 Alpha Tower, Ahmedabad" };
      const addr2 = { lat: 21.1702, lng: 72.8311, fullAddress: "202 Beta Square, Surat" };
      expect(areAddressesDuplicate(addr1, addr2)).toBe(false);
    });

    it("detects duplicate addresses based on normalized text string", () => {
      const addr1 = { fullAddress: "402, High Street Mall, CG Road, Ahmedabad" };
      const addr2 = { full: "402 High Street Mall, C.G. Road, Ahmedabad!" };
      expect(areAddressesDuplicate(addr1, addr2)).toBe(true);
    });
  });

  describe("2. Loyalty Welcome Bonus Eligibility Verification", () => {
    it("marks a brand new phone and account eligible for the welcome bonus", async () => {
      const result = await verifyBonusEligibility("+91 98250 99999", "usr_new_user_123");
      expect(result.eligible).toBe(true);
    });

    it("blocks welcome bonus if the user account has already claimed it", async () => {
      savedDocs["users/usr_existing_123"] = {
        hasClaimedWelcomeBonus: true,
      };

      const result = await verifyBonusEligibility("+91 98250 99999", "usr_existing_123");
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/already been claimed by this account/);
    });

    it("blocks welcome bonus if the phone number previously claimed a bonus (anti-fraud)", async () => {
      // Ledger stores canonical E.164; the query must match formatting
      // variants (+91 prefix, spaces) to the same identity.
      savedDocs["coin_transactions/tx_old_bonus_1"] = {
        phone: "+919825011111",
        type: "welcome_bonus",
      };

      const result = await verifyBonusEligibility("+91 98250 11111", "usr_fresh_alt_account");
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/already been claimed for this phone number/);
    });

    it("normalizes phone variants to one E.164 identity", async () => {
      const { normalizePhoneIN } = await import("../src/modules/auth/guestMigration");
      expect(normalizePhoneIN("+91 98250 11111")).toBe("+919825011111");
      expect(normalizePhoneIN("9825011111")).toBe("+919825011111");
      expect(normalizePhoneIN("09825011111")).toBe("+919825011111");
      expect(normalizePhoneIN("not-a-phone")).toBeNull();
    });

    it("awards the welcome bonus exactly once under concurrent claims (deterministic create)", async () => {
      const { awardWelcomeBonus } = await import("../src/modules/auth/guestMigration");
      // Truly concurrent (not sequential awaits): exactly one claim wins.
      const [first, second] = await Promise.all([
        awardWelcomeBonus("usr_race_1", "+91 98250 22222", 50),
        awardWelcomeBonus("usr_race_1", "9825022222", 50),
      ]);
      expect([first, second].sort()).toEqual([0, 50]);
    });
  });

  describe("3. Full Atomic Guest Account Migration", () => {
    it("relins orders, deduplicates addresses, migrates cart, and awards first-time welcome bonus", async () => {
      const guestSessionId = "sess_guest_abc_999";
      const permanentUid = "usr_aarav_phone_999";
      const phone = "+91 98250 55555";

      // Seed 2 guest orders
      savedDocs["orders/ord_guest_1"] = {
        id: "ord_guest_1",
        guestSessionId,
        customerId: "guest",
        total: 450,
      };
      savedDocs["orders/ord_guest_2"] = {
        id: "ord_guest_2",
        guestSessionId,
        customerId: "guest",
        total: 299,
      };

      // Seed guest cart
      savedDocs[`carts/guest_${guestSessionId}`] = {
        items: [{ id: "b1", name: "Smash Burger", quantity: 1, price: 199 }],
      };

      // Seed permanent user with 1 existing address
      savedDocs[`users/${permanentUid}`] = {
        name: "Aarav",
        addresses: [
          { id: "addr_1", lat: 23.0131, lng: 72.5085, fullAddress: "Existing Home", isDefault: true },
        ],
      };

      const migrationResult = await migrateGuestAccount({
        guestSessionId,
        permanentUid,
        phone,
        addresses: [
          // 1 duplicate address
          { lat: 23.0132, lng: 72.5086, fullAddress: "Existing Home Duplicate" },
          // 1 new unique address
          { lat: 23.0338, lng: 72.5262, fullAddress: "Work Office Vastrapur" },
        ],
      });

      expect(migrationResult.success).toBe(true);
      expect(migrationResult.migratedOrdersCount).toBe(2);
      expect(migrationResult.migratedAddressesCount).toBe(1); // only 1 unique new address
      expect(migrationResult.cartMigrated).toBe(true);
      expect(migrationResult.welcomeBonusAwarded).toBe(true);
      expect(migrationResult.bonusCoins).toBe(50);

      // Verify orders were updated to permanentUid
      expect(savedDocs["orders/ord_guest_1"].customerId).toBe(permanentUid);
      expect(savedDocs["orders/ord_guest_1"].originalGuestSessionId).toBe(guestSessionId);
      expect(savedDocs["orders/ord_guest_2"].customerId).toBe(permanentUid);

      // Verify cart was moved and old guest cart purged
      expect(savedDocs[`carts/${permanentUid}`]).toBeDefined();
      expect(savedDocs[`carts/guest_${guestSessionId}`]).toBeUndefined();

      // Verify addresses merged on user profile
      const updatedUser = savedDocs[`users/${permanentUid}`];
      expect(updatedUser.addresses.length).toBe(2);
      expect(updatedUser.hasClaimedWelcomeBonus).toBe(true);

      // Readiness-1: the bonus credits the SPENDABLE ledger field
      // (customers.loyaltyPoints), never the dead users.grillCoins.
      const coinCredit = batchSets.find(
        (s: any) => s.ref?.path === `customers/${permanentUid}`
      );
      expect(coinCredit).toBeDefined();
      expect(coinCredit.data.loyaltyPoints).toBe(50);
      const deadWrites = batchSets.filter(
        (s: any) =>
          typeof s.ref?.path === "string" &&
          s.ref.path.startsWith("users/") &&
          s.data &&
          "grillCoins" in s.data
      );
      expect(deadWrites).toHaveLength(0);
    });

    it("refuses to migrate orders from an identified (non-anonymous) account", async () => {
      const { auth } = await import("../src/core/firebase");
      (auth.getUser as any).mockResolvedValueOnce({
        uid: "usr_identified_victim",
        providerData: [{ providerId: "phone" }],
      });

      await expect(
        migrateGuestAccount({
          anonymousUid: "usr_identified_victim",
          permanentUid: "usr_attacker_999",
        })
      ).rejects.toThrow(/not anonymous/);
    });

    it("handles recurring customer sign-in without awarding duplicate welcome bonus", async () => {
      const guestSessionId = "sess_guest_returning_777";
      const permanentUid = "usr_returning_777";
      const phone = "+91 98250 77777";

      // Mark phone as having claimed bonus (canonical E.164, as new writes store)
      savedDocs["coin_transactions/tx_prev_bonus"] = {
        phone: "+919825077777",
        type: "welcome_bonus",
      };

      // B3-S1: phone-ledger dedup keys on the OTP-VERIFIED token phone, so
      // the caller carries it (as the route passes req.user through).
      const result = await migrateGuestAccount(
        {
          guestSessionId,
          permanentUid,
          phone,
        },
        { uid: permanentUid, phone_number: phone }
      );

      expect(result.success).toBe(true);
      expect(result.welcomeBonusAwarded).toBe(false);
      expect(result.bonusCoins).toBe(0);
    });
  });

  describe("4. B3-S1 Attack Denials (guest-relink / proof / phone / target bind)", () => {
    it("refuses to relink orders owned by an identified UID via a guessed session id", async () => {
      const guestSessionId = "sess_guest_attacker_guess_1";
      // Victim's real order happens to carry the guessed session stamp but is
      // owned by an identified account — the classic guest-relink hijack.
      savedDocs["orders/ord_victim_real"] = {
        id: "ord_victim_real",
        guestSessionId,
        customerId: "usr_victim_identified",
        total: 999,
      };

      const result = await migrateGuestAccount(
        { guestSessionId, permanentUid: "usr_attacker_999" },
        { uid: "usr_attacker_999" }
      );

      expect(result.success).toBe(true);
      expect(result.migratedOrdersCount).toBe(0);
      expect(result.skippedProtectedCount).toBe(1);
      expect(savedDocs["orders/ord_victim_real"].customerId).toBe("usr_victim_identified");
      expect(savedDocs["orders/ord_victim_real"].migratedAt).toBeUndefined();
    });

    it("rejects a tampered guest-ownership proof but accepts a valid one", async () => {
      process.env.OTP_HMAC_SECRET = "test-guest-proof-secret";
      try {
        const { mintGuestOwnershipProof } = await import("../src/modules/auth/guestMigration");
        const guestSessionId = "sess_guest_proofed_12345";
        const goodProof = mintGuestOwnershipProof(guestSessionId);

        savedDocs["orders/ord_proofed_1"] = {
          id: "ord_proofed_1",
          guestSessionId,
          customerId: "guest",
          total: 199,
        };

        await expect(
          migrateGuestAccount(
            { guestSessionId, permanentUid: "usr_proofed_user", guestProof: `${goodProof}ff` },
            { uid: "usr_proofed_user" }
          )
        ).rejects.toThrow(/invalid guest-ownership proof/);
        expect(savedDocs["orders/ord_proofed_1"].customerId).toBe("guest");

        const ok = await migrateGuestAccount(
          { guestSessionId, permanentUid: "usr_proofed_user", guestProof: goodProof },
          { uid: "usr_proofed_user" }
        );
        expect(ok.migratedOrdersCount).toBe(1);
        expect(savedDocs["orders/ord_proofed_1"].customerId).toBe("usr_proofed_user");
      } finally {
        delete process.env.OTP_HMAC_SECRET;
      }
    });

    it("refuses a body phone that contradicts the OTP-verified token phone", async () => {
      await expect(
        migrateGuestAccount(
          {
            guestSessionId: "sess_guest_phone_clash_1",
            permanentUid: "usr_clash_1",
            phone: "+91 98250 11111",
          },
          { uid: "usr_clash_1", phone_number: "+91 98250 22222" }
        )
      ).rejects.toThrow(/does not match the OTP-verified number/);
    });

    it("refuses migration into another user's account (target != caller UID)", async () => {
      await expect(
        migrateGuestAccount(
          { guestSessionId: "sess_guest_cross_acct_1", permanentUid: "usr_victim_acct" },
          { uid: "usr_attacker_acct" }
        )
      ).rejects.toThrow(/does not match the authenticated caller/);
    });

    it("refuses guessable/short guest session ids outright", async () => {
      await expect(
        migrateGuestAccount(
          { guestSessionId: "abc", permanentUid: "usr_short_1" },
          { uid: "usr_short_1" }
        )
      ).rejects.toThrow(/not a valid unguessable token/);
    });

    it("mints the UID-keyed (not phone-keyed) bonus when the caller has no verified phone", async () => {
      const { normalizePhoneIN } = await import("../src/modules/auth/guestMigration");
      expect(normalizePhoneIN("+91 98250 33333")).toBe("+919825033333");
      const result = await migrateGuestAccount(
        {
          guestSessionId: "sess_guest_unverified_ph_1",
          permanentUid: "usr_unverified_ph_1",
          phone: "+91 98250 33333", // unverified body phone: ignored
        },
        { uid: "usr_unverified_ph_1" }
      );
      expect(result.welcomeBonusAwarded).toBe(true);
      expect(result.bonusCoins).toBe(50);
      // No phone-ledger entry burned for an unverified number…
      expect(savedDocs["coin_transactions/welcome_bonus_phone_919825033333"]).toBeUndefined();
      // …and the unverified number is NOT written to the profile either.
      expect(savedDocs["users/usr_unverified_ph_1"].phone).toBeUndefined();
    });
  });
});
