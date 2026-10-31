import { defineConfig } from 'vitest/config';
// OWNED harness config ? runs the byte-copied existing rules tests from THIS temp CWD
// so that readFileSync("firestore.rules") resolves to the harness-provided rules copy.
export default defineConfig({
  include: ['*.rules.test.ts'],
  test: {
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 180000,
    teardownTimeout: 60000,
  },
});
