import path from "node:path";

/**
 * QA-only Vite `enforce: 'pre'` transform overlay.
 * Injects emulator wiring immediately after the app's real db init.
 * No app file is modified; the transform asserts exactly one match.
 */
export function emulatorOverlay(appDir, kind) {
  const firebaseFile =
    kind === "delivery"
      ? path.resolve(appDir, "src/core/config/firebase.ts")
      : path.resolve(appDir, "src/config/firebase.ts");
  const marker =
    kind === "delivery"
      ? "const db = getFirestore(app);"
      : "export const db = getFirestore(app);";
  const injection = [
    marker,
    '__qaConnectAuth(auth, "http://127.0.0.1:48692", { disableWarnings: true });',
    "auth.settings.appVerificationDisabledForTesting = true;",
    '__qaConnectStore(db, "127.0.0.1", 48691);',
  ].join("\n");
  const imports =
    'import { connectAuthEmulator as __qaConnectAuth } from "firebase/auth";\n' +
    'import { connectFirestoreEmulator as __qaConnectStore } from "firebase/firestore";\n';

  return {
    name: "qa-auth-emulator-overlay",
    enforce: "pre",
    transformIndexHtml(html) {
      // QA-only: the shipped CSP forbids plain-HTTP loopback, which the
      // emulators require. Remove the meta in the served QA page only.
      return html.replace(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/i, "<!-- QA: CSP meta removed for loopback emulators -->");
    },
    transform(code, id) {
      const file = id.split("?")[0].replace(/\\/g, "/");
      if (path.resolve(file) !== firebaseFile) return null;
      const first = code.indexOf(marker);
      const last = code.lastIndexOf(marker);
      if (first < 0 || first !== last) {
        throw new Error(
          `QA overlay: expected exactly one "${marker}" in ${firebaseFile}, found ${first < 0 ? 0 : 2}+`
        );
      }
      return { code: imports + code.replace(marker, injection), map: null };
    },
  };
}

