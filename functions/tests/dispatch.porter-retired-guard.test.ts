import { describe, it, expect, vi } from "vitest";

/**
 * Porter is RETIRED. Direct booking endpoints (/porter/book, /porter/rebook)
 * used to ignore config.porter.enabled entirely, so a stale Partner button
 * could dispatch a real paid rider from a cancelled carrier. These guards must
 * fire BEFORE any Firestore read or provider call.
 *
 * The db mock throws on any access, so a regression that moves the guard below
 * the first read fails loudly instead of silently passing.
 */

vi.hoisted(() => {
  delete process.env.PORTER_ENABLED;
});

vi.mock("../src/core/firebase", () => {
  const forbidden = () => {
    throw new Error("db must not be touched when Porter is retired");
  };
  return {
    db: {
      collection: forbidden,
      doc: forbidden,
      runTransaction: forbidden,
    },
  };
});

const { bookPorterRider, rebookPorterRider } = await import(
  "../src/modules/porter/porter.service"
);

function expectRetired(error: any) {
  expect(error?.statusCode).toBe(409);
  expect(error?.code).toBe("PORTER_RETIRED");
  expect(String(error?.message)).toMatch(/in-house rider/i);
}

describe("Porter retirement — direct booking refuses before any I/O", () => {
  it("refuses /porter/book with a typed 409 and never reads the order", async () => {
    await expect(bookPorterRider("order_retired_1")).rejects.toSatisfy(
      (error: any) => {
        expectRetired(error);
        return true;
      }
    );
  });

  it("refuses /porter/rebook with the same typed 409", async () => {
    await expect(rebookPorterRider("order_retired_2")).rejects.toSatisfy(
      (error: any) => {
        expectRetired(error);
        return true;
      }
    );
  });
});
