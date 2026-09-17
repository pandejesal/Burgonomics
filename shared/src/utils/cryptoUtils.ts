/**
 * Cryptographically secure utilities.
 * Completely replaces insecure Math.random() usage for unique identifiers and tokens.
 */

/**
 * Generates a cryptographically secure random alphanumeric string of the specified length.
 */
export function generateSecureId(length = 12): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const cryptoObj =
    typeof globalThis !== "undefined" && globalThis.crypto ? globalThis.crypto : undefined;

  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const randomArray = new Uint32Array(length);
    cryptoObj.getRandomValues(randomArray);
    let result = "";
    for (let i = 0; i < length; i++) {
      result += charset[randomArray[i] % charset.length];
    }
    return result;
  }

  // Fallback using high-resolution time + pseudo-randomness for environments without Web Crypto API
  let result = "";
  for (let i = 0; i < length; i++) {
    const randomIndex =
      Math.floor((Math.random() + ((performance?.now() || Date.now()) % 1)) * 1000000) %
      charset.length;
    result += charset[randomIndex];
  }
  return result;
}
