import { defineConfig } from "vitest/config";
import path from "path";

// B6-S1: ops tooling moved out of the deploy path (scripts/backfill/) still
// imports the bare `firebase-admin` specifier. From outside the package root
// Node/Vite resolution cannot walk up into functions/node_modules, so alias
// it (and the firestore subpath) to the same files every other test already
// resolves. No behavior change for existing suites — identical module code.
export default defineConfig({
  test: {
    // Files run in separate PROCESSES, not threads.
    //
    // Several suites declare a capability as a module-load side effect because
    // the config module reads process.env at import time — e.g.
    // dispatch.autoRebook sets PORTER_ENABLED=true in vi.hoisted, while
    // dispatch.porter-retired asserts the unset default. Under the default
    // thread pool those files share one process.env, so the pair raced: the
    // full suite intermittently reported "is disabled when PORTER_ENABLED is
    // unset" as failing while passing in isolation. Fork isolation removes the
    // shared mutable state by construction instead of serialising the files.
    pool: "forks",
    // Emulator-backed suites are excluded from the default run because they
    // require a live emulator that `npm test` does not start (the deploy script
    // requires `npm test` to pass on a bare machine). They are NOT deleted or
    // weakened: `npm run test:storage-rules` wraps vitest in
    // `firebase emulators:exec`, which exports STORAGE_EMULATOR_HOST — and that
    // is what re-enables the file here. No extra dependency, no env plumbing.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(process.env.STORAGE_EMULATOR_HOST ? [] : ["tests/storage.rules.test.ts"]),
      ...(process.env.FIRESTORE_EMULATOR_HOST
        ? []
        : [
            "tests/rules.cod-courier.emulator.test.ts",
            "tests/rules.settlements.emulator.test.ts",
            "tests/fr-checkout.rules.emulator.test.ts",
            "tests/rules.counter.cash.emulator.test.ts",
            "tests/capture.recovery.rules.emulator.test.ts",
          ]),
    ],
  },
  resolve: {
    alias: [
      {
        find: "firebase-admin/firestore",
        replacement: path.resolve(__dirname, "node_modules/firebase-admin/lib/firestore/index.js"),
      },
      {
        find: "firebase-admin",
        replacement: path.resolve(__dirname, "node_modules/firebase-admin/lib/index.js"),
      },
      {
        find: "@burgonomics/shared",
        replacement: path.resolve(__dirname, "../shared/src"),
      },
    ],
  },
});
