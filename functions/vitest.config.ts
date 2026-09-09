import { defineConfig } from "vitest/config";
import path from "path";

// B6-S1: ops tooling moved out of the deploy path (scripts/backfill/) still
// imports the bare `firebase-admin` specifier. From outside the package root
// Node/Vite resolution cannot walk up into functions/node_modules, so alias
// it (and the firestore subpath) to the same files every other test already
// resolves. No behavior change for existing suites — identical module code.
export default defineConfig({
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
    ],
  },
});
