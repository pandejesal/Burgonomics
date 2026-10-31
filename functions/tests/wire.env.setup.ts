import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// The wire probe needs the real functions/.env, but env.ts deliberately skips
// dotenv when VITEST=true (local env must never flip fail-closed suite
// expectations). This side-effect module runs BEFORE the adapter import
// evaluates, so config reads an already-populated process.env. Loads nothing
// unless the probe was explicitly requested.
if (process.env.WIRE_BORZO === "1") {
  dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
}
