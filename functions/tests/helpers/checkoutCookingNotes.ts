import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

// The default suite is standalone. The linked proof sets this directory and
// uses the exact JSON bodies captured at the Customer checkout transport.
export function checkoutCookingNoteBody<T>(name: string, path: string, fallback: T): T {
  const directory = process.env.C9_COOKING_NOTE_FIXTURES;
  if (!directory) return fallback;
  const { url, body } = JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8"));
  expect(new URL(url).pathname.endsWith(path)).toBe(true);
  return body;
}
