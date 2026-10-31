import { readFileSync } from "fs";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection } from "firebase/firestore";

const PROJECT_ID = "burgonomics-test-rules";

// Default matches firebase.json; override only when 8080 is occupied locally
// (e.g. a proxy daemon owns it) by running the emulator on another port and
// pointing this at it. CI leaves it unset and keeps the canonical port.
const EMULATOR_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);

describe("Firestore Security Rules — CRM Hierarchy & RBAC", () => {
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
      // Silent skips let RBAC rules rot green forever (Loop 9): in CI the
      // emulator job must run — fail hard instead of skipping.
      if (process.env.CI === "true") {
        throw new Error(
          "Firestore emulator unavailable in CI — the rules job must start it (see .github/workflows/ci.yml `rules` job)."
        );
      }
      context.skip();
      return;
    }

    await testEnv.clearFirestore();

    // Seed administrative users & baseline data using withSecurityRulesDisabled
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      // Brand Owner Admin Doc
      await setDoc(doc(db, "admins", "brand_owner_1"), {
        email: "brand@burgonomics.com",
        role: "brand_owner",
        name: "Yash Brand Owner",
      });

      // Branch Owner 1 (Branch 01) Admin Doc
      await setDoc(doc(db, "admins", "branch_owner_1"), {
        email: "branch1@burgonomics.com",
        role: "branch_owner",
        branchId: "branch_01",
        name: "Navrangpura Operator",
      });

      // Branch Owner 2 (Branch 02) Admin Doc
      await setDoc(doc(db, "admins", "branch_owner_2"), {
        email: "branch2@burgonomics.com",
        role: "branch_owner",
        branchId: "branch_02",
        name: "Nehrunagar Operator",
      });

      // Existing Customer
      await setDoc(doc(db, "customers", "cust_100"), {
        customerId: "cust_100",
        fullName: "Rahul Patel",
        phone: "+919876543210",
        loyaltyPoints: 250,
      });

      // Existing user profile (self-profile owner path for R17 trust-field tests)
      await setDoc(doc(db, "users", "cust_100"), {
        id: "cust_100",
        phone: "+919876543210",
        fullName: "Rahul Patel",
      });

      // Existing Branch 01
      await setDoc(doc(db, "branches", "branch_01"), {
        name: "Burgonomics Navrangpura",
        city: "Ahmedabad",
        status: "active",
      });

      // Existing Order at Branch 01
      await setDoc(doc(db, "orders", "order_501"), {
        orderId: "order_501",
        customerId: "cust_100",
        branchId: "branch_01",
        status: { kind: "in_progress", code: "PREPARING" },
        totals: { grandTotal: 349 },
        placedAt: new Date().toISOString(),
      });

      // Existing App Settings
      await setDoc(doc(db, "app_settings", "pricing"), {
        gstRate: 0.05,
        packingCharge: 20,
      });

      // 1:1 chat thread with stamped participants (writers must set these —
      // message reads are participant-gated, not admin-wide)
      await setDoc(doc(db, "chats", "branch_01_brand_owner_1"), {
        participantIds: ["branch_owner_1", "brand_owner_1"],
        branchId: "branch_01",
      });

      // Branch support ticket (Loop: pins the staff update field mask —
      // workflow fields allowed, money-action fields server-only)
      await setDoc(doc(db, "support_tickets", "tkt_rules_01"), {
        ticketNumber: "TICK-RULES-01",
        customerId: "cust_100",
        branchId: "branch_01",
        status: "open",
        subject: "Rules pin ticket",
      });

      // Loop 12: OTP-bypass pins — delivery vs takeaway handover paths
      await setDoc(doc(db, "orders", "ord_deliver_01"), {
        orderId: "ord_deliver_01",
        customerId: "cust_100",
        branchId: "branch_01",
        orderType: "delivery",
        status: { kind: "in_progress", code: "OUT_FOR_DELIVERY" },
        placedAt: new Date().toISOString(),
      });
      await setDoc(doc(db, "orders", "ord_takeaway_01"), {
        orderId: "ord_takeaway_01",
        customerId: "cust_100",
        branchId: "branch_01",
        orderType: "takeaway",
        status: { kind: "in_progress", code: "READY_FOR_PICKUP" },
        placedAt: new Date().toISOString(),
      });
      // Petpooja webhook log probe (Loop 1/120: rule block was top-level dead
      // code outside the documents match — admin reads default-denied)
      await setDoc(doc(db, "petpooja_webhook_logs", "wh_rules_01"), {
        storeId: "branch_01",
        type: "order",
        status: "success",
        timestamp: new Date().toISOString(),
      });
    });
  });

  // =========================================================================
  // 1. Anonymous Access Tests (5 cases)
  // =========================================================================

  it("1. [ANON-DENY] Anonymous request to read orders is DENIED", async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthedDb, "orders", "order_501")));
  });

  it("2. [ANON-DENY] Anonymous request to read customer profile is DENIED", async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthedDb, "customers", "cust_100")));
  });

  it("3. [ANON-DENY] Anonymous request to read admin profile is DENIED", async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthedDb, "admins", "brand_owner_1")));
  });

  it("4. [ANON-DENY] Anonymous request to write payment audit is DENIED", async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(unauthedDb, "paymentAudits", "audit_999"), {
        orderId: "order_501",
        branchId: "branch_01",
        discrepancy: 50,
      })
    );
  });

  it("5. [BRANCHES-ANON-DENY] Anonymous request to read branches is DENIED (hardened: was public)", async () => {
    const unauthedDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthedDb, "branches", "branch_01")));
  });

  it("5b. [BRANCHES-SIGNEDIN-ALLOW] Any signed-in user can read branches (customer app never reads branches/*; partner hooks are signed-in)", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertSucceeds(getDoc(doc(custDb, "branches", "branch_01")));
  });

  // =========================================================================
  // 2. Customer Scoping & Loyalty Global Tests (5 cases)
  // =========================================================================

  it("6. [CUSTOMER-READ-OWN] Customer can read their own order", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertSucceeds(getDoc(doc(custDb, "orders", "order_501")));
  });

  it("7. [CUSTOMER-CROSS-READ-DENY] Customer cannot read another customer's order", async () => {
    const intruderDb = testEnv.authenticatedContext("cust_999").firestore();
    await assertFails(getDoc(doc(intruderDb, "orders", "order_501")));
  });

  it("8. [CUSTOMER-LOYALTY-READ] Customer can read their own global loyalty points", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    const snap = await getDoc(doc(custDb, "customers", "cust_100"));
    expect(snap.exists()).toBe(true);
    expect(snap.data()?.loyaltyPoints).toBe(250);
  });

  it("9. [CUSTOMER-LOYALTY-MUTATION-DENY] Customer cannot directly modify loyalty points", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(
      updateDoc(doc(custDb, "customers", "cust_100"), {
        loyaltyPoints: 99999,
      })
    );
  });

  it("10. [CUSTOMER-CREATE-ORDER] Customer can create pending order for self (pins the real ordersService.createOrder payload: BOTH customerId+userId, initial PLACED status meta)", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertSucceeds(
      setDoc(doc(custDb, "orders", "order_new_1"), {
        orderId: "order_new_1",
        customerId: "cust_100",
        userId: "cust_100",
        branchId: "branch_01",
        paymentStatus: "Pending",
        status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
        totals: { grandTotal: 499 },
      })
    );
  });

  // =========================================================================
  // 3. Branch Scoping & ownsBranch Tests (4 cases)
  // =========================================================================

  it("11. [BRANCH-OWNS-READ] Branch Owner of branch_01 can read orders at branch_01", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(getDoc(doc(branch1Db, "orders", "order_501")));
  });

  it("12. [BRANCH-CROSS-READ-DENY] Branch Owner of branch_02 CANNOT read orders at branch_01", async () => {
    const branch2Db = testEnv.authenticatedContext("branch_owner_2").firestore();
    await assertFails(getDoc(doc(branch2Db, "orders", "order_501")));
  });

  it("13. [BRANCH-STATUS-UPDATE] Branch Owner of branch_01 can update order status at branch_01", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(
      updateDoc(doc(branch1Db, "orders", "order_501"), {
        status: { kind: "in_progress", code: "READY_FOR_PICKUP" },
      })
    );
  });

  it("14. [BRANCH-MUTATE-TOTALS-DENY] Branch Owner cannot tamper with order totals or pricing", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertFails(
      updateDoc(doc(branch1Db, "orders", "order_501"), {
        totals: { grandTotal: 9999 },
      })
    );
  });

  // =========================================================================
  // 4. Upcoming Branches & Brand Owner Privileges (2 cases)
  // =========================================================================

  it("15. [BRAND-CREATE-UPCOMING] Brand Owner CAN create upcoming branches (Q10)", async () => {
    const brandDb = testEnv.authenticatedContext("brand_owner_1").firestore();
    await assertSucceeds(
      setDoc(doc(brandDb, "branches", "branch_upcoming_03"), {
        name: "Burgonomics South Bopal",
        city: "Ahmedabad",
        status: "upcoming",
        expectedOpenDate: "2026-11-01",
      })
    );
  });

  it("16. [BRANCH-CREATE-UPCOMING-DENY] Branch Owner CANNOT create upcoming branches (Q10)", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertFails(
      setDoc(doc(branch1Db, "branches", "branch_upcoming_04"), {
        name: "Burgonomics Rogue Store",
        city: "Ahmedabad",
        status: "upcoming",
      })
    );
  });

  // =========================================================================
  // 5. 1:1 Direct Chat Scoping & Payment Audit Immutability (2 cases)
  // =========================================================================

  it("17. [CHAT-PAIR-ALLOW] Branch Owner 1 and Brand Owner CAN message in their pair", async () => {
    const pairId = "branch_01_brand_owner_1";
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(
      setDoc(doc(branch1Db, "chats", pairId, "messages", "msg_001"), {
        senderId: "branch_owner_1",
        text: "Stock delivered for today",
        createdAt: new Date().toISOString(),
      })
    );

    const brandDb = testEnv.authenticatedContext("brand_owner_1").firestore();
    await assertSucceeds(getDoc(doc(brandDb, "chats", pairId, "messages", "msg_001")));

    // Participant staffer reads its own thread even without brand role.
    const branch1ReaderDb = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(getDoc(doc(branch1ReaderDb, "chats", pairId, "messages", "msg_001")));
  });

  it("18. [CHAT-CROSS-DENY] Branch Owner 2 CANNOT access messages for Branch 1 pair", async () => {
    const pairId = "branch_01_brand_owner_1";
    const branch2Db = testEnv.authenticatedContext("branch_owner_2").firestore();
    await assertFails(getDoc(doc(branch2Db, "chats", pairId, "messages", "msg_001")));
  });

  it("19. [TICKET-STAFF-MASK-ALLOW] Branch staff CAN advance workflow fields (incl dotted assignedTo.tier)", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(
      updateDoc(doc(branch1Db, "support_tickets", "tkt_rules_01"), {
        status: "in_progress",
        resolution: "Looking into it",
        "assignedTo.tier": "branch",
        timeline: [{ action: "message_added" }],
      })
    );
  });

  it("20. [TICKET-MONEY-DENY] Branch staff CANNOT write money-action fields directly", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertFails(
      updateDoc(doc(branch1Db, "support_tickets", "tkt_rules_01"), {
        status: "resolved",
        refundAmount: 99,
      })
    );
  });

  it("21. [WEBHOOKLOG-ADMIN-ALLOW] Brand Owner CAN read petpooja webhook logs", async () => {
    const brandDb = testEnv.authenticatedContext("brand_owner_1").firestore();
    await assertSucceeds(getDoc(doc(brandDb, "petpooja_webhook_logs", "wh_rules_01")));
  });

  it("22. [WEBHOOKLOG-ANON-DENY] Anonymous request to read petpooja webhook logs is DENIED", async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, "petpooja_webhook_logs", "wh_rules_01")));
  });

  it("23. [OTP-BYPASS-DENY] Branch staff CANNOT flip a delivery order straight to DELIVERED", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertFails(
      updateDoc(doc(branch1Db, "orders", "ord_deliver_01"), {
        status: { kind: "completed", code: "DELIVERED" },
      })
    );
  });

  it("24. [TAKEAWAY-DELIVER-ALLOW] Branch staff CAN complete a takeaway order directly", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(
      updateDoc(doc(branch1Db, "orders", "ord_takeaway_01"), {
        status: { kind: "completed", code: "DELIVERED" },
      })
    );
  });

  it("25. [BROADCAST-ADMIN-ALLOW] Brand Owner CAN read broadcast history", async () => {
    const brandDb = testEnv.authenticatedContext("brand_owner_1").firestore();
    await assertSucceeds(getDoc(doc(brandDb, "broadcasts", "bc_rules_01")));
  });

  it("26. [BROADCAST-WRITE-DENY] Branch staff CANNOT write broadcast history directly", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertFails(
      setDoc(doc(branch1Db, "broadcasts", "bc_rules_evil"), {
        title: "Fake",
        successCount: 99999,
      })
    );
  });

  it("27. [CUSTOMER-WHATSAPP-OPTIN-ALLOW] Customer can toggle their own whatsappOptIn preference", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertSucceeds(
      updateDoc(doc(custDb, "orders", "order_501"), {
        whatsappOptIn: false,
        updatedAt: new Date().toISOString(),
      })
    );
  });

  it("28. [CUSTOMER-ORDER-FIELD-DENY] Customer cannot write money fields on their own order", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(
      updateDoc(doc(custDb, "orders", "order_501"), {
        totals: { grandTotal: 1 },
        whatsappOptIn: false,
      })
    );
  });

  // =========================================================================
  // 6. ORDERS CREATE HARDENING (audit: identity-only create was
  //    client-priced / privileged-key plantable)
  // =========================================================================

  it("29. [ORDERS-CREATE-VICTIM-ID-DENY] Customer cannot birth an order stamped to a victim in BOTH identity fields", async () => {
    const attackerDb = testEnv.authenticatedContext("attacker_1").firestore();
    await assertFails(
      setDoc(doc(attackerDb, "orders", "ord_evil_1"), {
        customerId: "victim_999",
        userId: "victim_999",
        branchId: "branch_01",
        status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
        totals: { grandTotal: 1 },
      })
    );
  });

  it("30. [ORDERS-CREATE-SPLIT-IDENTITY-DENY] Customer cannot pair own customerId with a victim userId (old `||` lanes both closed)", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(
      setDoc(doc(custDb, "orders", "ord_evil_2"), {
        customerId: "cust_100",
        userId: "victim_999",
        branchId: "branch_01",
        status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
      })
    );
  });

  it("31. [ORDERS-CREATE-PRIVILEGED-KEYS-DENY] Customer create cannot carry server-owned keys at birth (OTP/refund/pricing/dispatch)", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(
      setDoc(doc(custDb, "orders", "ord_evil_3"), {
        customerId: "cust_100",
        userId: "cust_100",
        branchId: "branch_01",
        status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
        deliveryOtp: "123456",
        deliveryOtpHash: "deadbeef",
        refundStatus: "approved",
        pricing: { grandTotal: 1 },
        petpoojaOrderId: "PP-FAKE-1",
        dispatchStatus: "booked",
      })
    );
  });

  it("32. [ORDERS-CREATE-PLANTED-STATUS-DENY] Customer create cannot be born DELIVERED/terminal", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(
      setDoc(doc(custDb, "orders", "ord_evil_4"), {
        customerId: "cust_100",
        userId: "cust_100",
        branchId: "branch_01",
        status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
      })
    );
  });

  it("33. [ORDERS-CREATE-PLANTED-PAID-DENY] Customer create cannot be born paid ('paid' or POS 'completed')", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    const base = {
      customerId: "cust_100",
      userId: "cust_100",
      branchId: "branch_01",
      status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
    };
    await assertFails(setDoc(doc(custDb, "orders", "ord_evil_5a"), { ...base, paymentStatus: "paid" }));
    await assertFails(setDoc(doc(custDb, "orders", "ord_evil_5b"), { ...base, paymentStatus: "completed" }));
  });

  it("34. [ORDERS-CREATE-WALKIN-ALLOW] Branch staff CAN birth a POS walk-in order (customerId 'cust_walkin' + staff userId + own branch, born completed)", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(
      setDoc(doc(branch1Db, "orders", "ord_pos_01"), {
        customerId: "cust_walkin",
        userId: "branch_owner_1",
        customerName: "Walk-in Customer",
        branchId: "branch_01",
        status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
        paymentStatus: "completed",
        total: 349,
      })
    );
  });

  it("35. [ORDERS-CREATE-WALKIN-NONSTAFF-DENY] A customer cannot use the walk-in lane", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(
      setDoc(doc(custDb, "orders", "ord_pos_evil_1"), {
        customerId: "cust_walkin",
        userId: "cust_100",
        branchId: "branch_01",
        status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
        paymentStatus: "completed",
      })
    );
  });

  it("36. [ORDERS-CREATE-WALKIN-CROSS-BRANCH-DENY] Branch staff cannot create walk-in orders stamped to someone else's branch", async () => {
    const branch2Db = testEnv.authenticatedContext("branch_owner_2").firestore();
    await assertFails(
      setDoc(doc(branch2Db, "orders", "ord_pos_evil_2"), {
        customerId: "cust_walkin",
        userId: "branch_owner_2",
        branchId: "branch_01",
        status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
        paymentStatus: "completed",
      })
    );
  });

  it("37. [ORDERS-CREATE-WALKIN-PRIVILEGED-KEYS-DENY] Walk-in lane cannot plant delivery OTP at birth either", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertFails(
      setDoc(doc(branch1Db, "orders", "ord_pos_evil_3"), {
        customerId: "cust_walkin",
        userId: "branch_owner_1",
        branchId: "branch_01",
        status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
        paymentStatus: "completed",
        deliveryOtp: "999999",
      })
    );
  });

  // =========================================================================
  // 7. SHADOW SUBCOLLECTION, CUSTOMERS DENYLIST, CHATS MASK,
  //    PRODUCTS CREATE, TICKETS CREATE (audit hardening)
  // =========================================================================

  it("38. [USER-ORDERS-SUBCOLLECTION-DENY] users/{uid}/orders is server-only — owner cannot create shadow orders", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(
      setDoc(doc(custDb, "users", "cust_100", "orders", "shadow_1"), {
        totals: { grandTotal: 99999 },
        status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
      })
    );
  });

  it("39. [CUSTOMERS-CREATE-ALLOW] Customer can create their own clean profile doc", async () => {
    const newCustDb = testEnv.authenticatedContext("cust_new").firestore();
    await assertSucceeds(
      setDoc(doc(newCustDb, "customers", "cust_new"), {
        customerId: "cust_new",
        fullName: "New User",
      })
    );
  });

  it("40. [CUSTOMERS-CREATE-ESCALATION-DENY] Customer cannot birth their profile with role/claim/PII escalation fields", async () => {
    const newCustDb = testEnv.authenticatedContext("cust_new").firestore();
    await assertFails(
      setDoc(doc(newCustDb, "customers", "cust_new"), {
        customerId: "cust_new",
        role: "brand_owner",
        isAdmin: true,
        loyaltyPoints: 99999,
      })
    );
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(
      setDoc(doc(custDb, "customers", "cust_100"), {
        customerId: "cust_100",
        phone: "+919999999999",
        email: "spoof@evil.test",
        createdAt: new Date().toISOString(),
      })
    );
  });

  it("41. [CUSTOMERS-UPDATE-ESCALATION-DENY] Customer update cannot write escalation/PII projection fields", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(
      updateDoc(doc(custDb, "customers", "cust_100"), { phone: "+919999999999" })
    );
    await assertFails(
      updateDoc(doc(custDb, "customers", "cust_100"), { isAdmin: true })
    );
    await assertFails(
      updateDoc(doc(custDb, "customers", "cust_100"), { createdAt: new Date().toISOString() })
    );
  });

  it("42. [CUSTOMERS-CLEAN-UPDATE-ALLOW] Customer can update their own non-privileged profile fields", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertSucceeds(
      updateDoc(doc(custDb, "customers", "cust_100"), { fullName: "Rahul P." })
    );
  });

  it("43. [CHATS-REPLY-ALLOW] Participant can update reply metadata on their thread", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(
      updateDoc(doc(branch1Db, "chats", "branch_01_brand_owner_1"), {
        lastMessageText: "Acknowledged",
        lastMessageSender: "Navrangpura Operator",
        lastMessageAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
  });

  it("44. [CHATS-PARTICIPANT-REWRITE-DENY] Participant cannot rewrite thread membership (participantIds/participantNames)", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertFails(
      updateDoc(doc(branch1Db, "chats", "branch_01_brand_owner_1"), {
        participantIds: ["branch_owner_1", "brand_owner_1", "victim_999"],
      })
    );
    await assertFails(
      updateDoc(doc(branch1Db, "chats", "branch_01_brand_owner_1"), {
        participantNames: { branch_owner_1: "Hijacked" },
      })
    );
  });

  it("45. [PRODUCTS-COMBO-CREATE-ALLOW] Branch staff can create a combo product with price (pins createComboMeal payload)", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(
      setDoc(doc(branch1Db, "products", "combo_rules_01"), {
        id: "combo_rules_01",
        name: "Rules Combo",
        description: "Burger + Fries",
        price: 299,
        originalPrice: 349,
        categoryId: "cat_combos",
        categoryName: "Combo Meals",
        branchId: "branch_01",
        inStock: true,
        isCombo: true,
      })
    );
  });

  it("46. [PRODUCTS-CREATE-DENYLIST-DENY] Branch staff cannot plant costPrice / discount fields / fabricated petpoojaItemId at birth", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    const base = {
      name: "Shady Item",
      price: 1,
      branchId: "branch_01",
    };
    await assertFails(
      setDoc(doc(branch1Db, "products", "prod_evil_1"), { ...base, costPrice: 500 })
    );
    await assertFails(
      setDoc(doc(branch1Db, "products", "prod_evil_2"), { ...base, discountPercentage: 99 })
    );
    await assertFails(
      setDoc(doc(branch1Db, "products", "prod_evil_3"), { ...base, petpoojaItemId: "PP-BRG-101" })
    );
  });

  it("47. [PRODUCTS-BRAND-CREATE-ALLOW] Brand owner catalog creates are unrestricted", async () => {
    const brandDb = testEnv.authenticatedContext("brand_owner_1").firestore();
    await assertSucceeds(
      setDoc(doc(brandDb, "products", "prod_brand_01"), {
        name: "Classic Burger",
        price: 129,
        costPrice: 60,
        branchId: "branch_01",
      })
    );
  });

  it("48. [TICKETS-CREATE-CLEAN-ALLOW] Authenticated user can create a clean ticket (status 'open')", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertSucceeds(
      setDoc(doc(branch1Db, "support_tickets", "tkt_new_01"), {
        ticketNumber: "TICK-NEW-01",
        customerId: "branch_owner_1",
        branchId: "branch_01",
        status: "open",
        subject: "Printer jam",
      })
    );
  });

  it("49. [TICKETS-CREATE-PRIORITY-DENY] Client create cannot self-set priority or assignedTo (server-stamped via POST /tickets/create)", async () => {
    const branch1Db = testEnv.authenticatedContext("branch_owner_1").firestore();
    await assertFails(
      setDoc(doc(branch1Db, "support_tickets", "tkt_evil_01"), {
        customerId: "branch_owner_1",
        branchId: "branch_01",
        status: "open",
        subject: "Queue jump",
        priority: "urgent",
      })
    );
    await assertFails(
      setDoc(doc(branch1Db, "tickets", "tkt_evil_02"), {
        customerId: "branch_owner_1",
        branchId: "branch_01",
        status: "open",
        subject: "Self-assign",
        assignedTo: { tier: "developer_team" },
      })
    );
  });

  // =========================================================================
  // R17: users/{uid} tenant/trust field protection
  // =========================================================================

  it("50. [USERS-CREATE-CLEAN-ALLOW] Self can create a clean user profile doc", async () => {
    const newCustDb = testEnv.authenticatedContext("cust_new").firestore();
    await assertSucceeds(
      setDoc(doc(newCustDb, "users", "cust_new"), {
        id: "cust_new",
        phone: "+919000000000",
        fullName: "New User",
        createdAt: new Date().toISOString(),
      })
    );
  });

  it("51. [USERS-CREATE-PROTECTED-DENY] Self cannot birth protected tenant/trust fields", async () => {
    const newCustDb = testEnv.authenticatedContext("cust_new").firestore();
    await assertFails(
      setDoc(doc(newCustDb, "users", "cust_new"), {
        id: "cust_new",
        phone: "+919000000000",
        role: "brand_owner",
      })
    );
    await assertFails(
      setDoc(doc(newCustDb, "users", "cust_new"), {
        id: "cust_new",
        phone: "+919000000000",
        branchIds: ["branch_01"],
      })
    );
    await assertFails(
      setDoc(doc(newCustDb, "users", "cust_new"), {
        id: "cust_new",
        phone: "+919000000000",
        cityIds: ["Ahmedabad"],
      })
    );
    await assertFails(
      setDoc(doc(newCustDb, "users", "cust_new"), {
        id: "cust_new",
        phone: "+919000000000",
        active: false,
      })
    );
    await assertFails(
      setDoc(doc(newCustDb, "users", "cust_new"), {
        id: "cust_new",
        phone: "+919000000000",
        isDeleted: true,
      })
    );
    await assertFails(
      setDoc(doc(newCustDb, "users", "cust_new"), {
        id: "cust_new",
        phone: "+919000000000",
        deletedAt: new Date().toISOString(),
      })
    );
  });

  it("52. [USERS-UPDATE-ALLOWED-FIELD-ALLOW] Self can update non-protected profile fields", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertSucceeds(
      updateDoc(doc(custDb, "users", "cust_100"), { fullName: "Rahul P." })
    );
  });

  it("53. [USERS-UPDATE-PROTECTED-DENY] Self cannot update protected tenant/trust fields", async () => {
    const custDb = testEnv.authenticatedContext("cust_100").firestore();
    await assertFails(updateDoc(doc(custDb, "users", "cust_100"), { role: "brand_owner" }));
    await assertFails(updateDoc(doc(custDb, "users", "cust_100"), { branchIds: ["branch_01"] }));
    await assertFails(updateDoc(doc(custDb, "users", "cust_100"), { cityIds: ["Ahmedabad"] }));
    await assertFails(updateDoc(doc(custDb, "users", "cust_100"), { active: false }));
    await assertFails(updateDoc(doc(custDb, "users", "cust_100"), { isDeleted: true }));
    await assertFails(updateDoc(doc(custDb, "users", "cust_100"), { deletedAt: new Date().toISOString() }));
  });

  it("54. [USERS-BRAND-ASSIGNMENT-PATH-ALLOW] Authorized brand authority retains tenant/trust field assignment path", async () => {
    const brandDb = testEnv.authenticatedContext("brand_owner_1").firestore();
    await assertSucceeds(
      updateDoc(doc(brandDb, "users", "cust_100"), {
        branchIds: ["branch_01"],
        cityIds: ["Ahmedabad"],
        active: false,
        isDeleted: true,
        deletedAt: new Date().toISOString(),
      })
    );
  });

  // =========================================================================
  // 8. NESTED payment MAP AT ORDER CREATE — ALLOWLIST, BOTH LANES
  //
  // The pending-status check alone let a client plant `payment.routeTransfer`
  // (or receipt/capture bookkeeping) at birth. executeRouteSplit's fast path
  // treats ANY stored `payment.routeTransfer` as an already-executed payout
  // and returns "done" without POSTing the transfer, so a planted receipt
  // suppressed the real branch settlement. Only the display fields the apps
  // write (method/label/status/transactionId/paidAt) may be born client-side.
  // =========================================================================
});
