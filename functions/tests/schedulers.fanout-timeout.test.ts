import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A8-5 / A8-9 (preprod audit c11, package F7) — a fan-out scheduler whose
 * worker can outrun the 60s v2 default must declare its own timeout.
 *
 * `pollActivePorterDeliveries` pulls up to 25 stale orders in chunks of 5 with a
 * 15s GET each (~75s worst case) but carried no `timeoutSeconds`; the platform
 * would kill it at 60s, the later chunks would never run and their
 * `porterPollCount` would not advance. Its Shadowfax sibling already declares
 * 540. `hourlyPetpoojaMenuSync` has the same shape (branches in chunks of 4 with
 * a 15s menu GET each) and the same missing option, while its own comment
 * claims ">> 60s function timeout".
 *
 * This is a source contract test: the option must be present in the SAME
 * onSchedule options object as the schedule it belongs to, not merely somewhere
 * in the file.
 */

const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8").replace(/\r\n/g, "\n");

/** The options object literal that follows `export const <name> = onSchedule(`. */
function optionsBlockOf(exportName: string): string {
  const anchor = `export const ${exportName} = onSchedule(`;
  const start = src.indexOf(anchor);
  expect(start, `${exportName} is registered`).toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  expect(open).toBeGreaterThan(start);
  // Brace-match the options object so an unrelated later declaration cannot
  // satisfy the assertion.
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced options object for ${exportName}`);
}

describe("long fan-out schedulers declare their own timeout", () => {
  it("pollActivePorterDeliveries sets timeoutSeconds: 540", () => {
    const block = optionsBlockOf("pollActivePorterDeliveries");
    expect(block).toContain('schedule: "*/5 * * * *"');
    expect(block).toMatch(/timeoutSeconds:\s*540/);
  });

  it("pollActiveShadowfaxDeliveries keeps timeoutSeconds: 540 (sibling parity)", () => {
    const block = optionsBlockOf("pollActiveShadowfaxDeliveries");
    expect(block).toMatch(/timeoutSeconds:\s*540/);
  });

  it("hourlyPetpoojaMenuSync sets timeoutSeconds: 540", () => {
    const block = optionsBlockOf("hourlyPetpoojaMenuSync");
    expect(block).toContain('schedule: "0 * * * *"');
    expect(block).toMatch(/timeoutSeconds:\s*540/);
  });

  it("every 25-doc dispatch/menu fan-out worker is above the 60s default", () => {
    for (const name of [
      "pollActivePorterDeliveries",
      "pollActiveShadowfaxDeliveries",
      "hourlyPetpoojaMenuSync",
      "retryPetpoojaOrders",
    ]) {
      const block = optionsBlockOf(name);
      const match = block.match(/timeoutSeconds:\s*(\d+)/);
      expect(match, `${name} declares timeoutSeconds`).toBeTruthy();
      expect(Number(match![1]), `${name} timeout is above the 60s default`).toBeGreaterThan(60);
    }
  });
});
