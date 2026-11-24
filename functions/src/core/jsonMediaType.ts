/**
 * JSON media-type matching for `express.json()`.
 *
 * Cycle 10 staging (2026-11-24, Customer 67371ec / backend 568f151): the
 * deployed Customer bundle merged its HttpClient default (`content-type`) with a
 * capital `Content-Type` from the payment services, and Fetch joined the two
 * keys into ONE header value:
 *
 *     Content-Type: application/json, application/json
 *
 * `type-is` does not match that value, so `express.json()` skipped the body and
 * `validateBody` reported it as `{}` — "items: expected array, received
 * undefined" — on cash checkout (two screens), online draft creation and a valid
 * ₹0 checkout, while every request with a single header kept working.
 *
 * Two constraints shape this module:
 *
 *  1. The cycle-10 APKs already installed on real phones have the client bug
 *     baked in, and cached web bundles repeat it until they update. Refusing the
 *     header would convert today's silent 400 into a hard outage for them.
 *  2. Accepting anything looser than JSON would let a caller smuggle a body past
 *     the parser's expectations.
 *
 * So the matcher accepts EXACTLY the two shapes that unambiguously mean "this is
 * a JSON body": a single JSON media type, or a comma-separated list in which
 * EVERY entry is JSON (with an optional charset). A list mixing JSON with any
 * other type is refused with a typed 415 rather than guessed at.
 */

/** One media type with parameters (`; charset=...`) stripped, lowercased. */
export function mediaTypeOf(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/** `application/json`, `application/ld+json`, `application/vnd.x+json`. */
const JSON_MEDIA_TYPE = /^application\/(?:[\w.-]+\+)?json$/;

/** True for a single JSON media type (parameters allowed). */
export function isJsonMediaType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return JSON_MEDIA_TYPE.test(mediaTypeOf(contentType));
}

export type JsonMediaTypeVerdict =
  | { action: "accept" }
  | { action: "repair"; value: string }
  | { action: "reject"; value: string };

/**
 * Classify a `content-type` header for the JSON body parser.
 *
 * - one JSON type                     → accept
 * - every comma-separated part JSON   → repair (the duplicated-key defect)
 * - JSON mixed with a non-JSON type   → reject (415), never guess
 * - no JSON anywhere                  → accept silently (the parser ignores it,
 *                                       as it must for form/multipart bodies)
 *
 * Repair matters beyond parsing: `body-parser` reads the charset from the raw
 * header and a joined value makes that read ambiguous. Collapsing to the first
 * entry keeps `application/json; charset=utf-8` working when a client repeats it.
 */
export function classifyJsonMediaType(contentType: string | undefined): JsonMediaTypeVerdict {
  if (!contentType) return { action: "accept" };
  const parts = contentType.split(",");
  if (parts.length < 2) return { action: "accept" };
  const jsonParts = parts.filter((part) => isJsonMediaType(part)).length;
  if (jsonParts === 0) return { action: "accept" };
  if (jsonParts === parts.length) return { action: "repair", value: parts[0].trim() };
  return { action: "reject", value: contentType };
}

/**
 * The `type` option for `express.json()`. Accepts a single JSON media type or a
 * list made entirely of JSON media types; never widens to non-JSON.
 */
export function isJsonBodyMediaType(req: { headers: Record<string, unknown> }): boolean {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw.join(", ") : (raw as string | undefined);
  if (!value) return false;
  const parts = value.split(",");
  return parts.length > 0 && parts.every((part) => isJsonMediaType(part));
}

/**
 * Express middleware: collapse a duplicated JSON media type to its first entry
 * (so the parser's charset read stays unambiguous), and answer a typed 415 when
 * a header claims JSON together with a non-JSON type. Runs before the parser.
 */
export function normalizeJsonMediaType() {
  return (
    req: { headers: Record<string, string | string[] | undefined> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ): void => {
    const raw = req.headers["content-type"];
    const value = Array.isArray(raw) ? raw.join(", ") : raw;
    const verdict = classifyJsonMediaType(value);
    if (verdict.action === "reject") {
      res.status(415).json({
        code: "INVALID_CONTENT_TYPE",
        error:
          "Content-Type must be a single JSON media type. The request declared JSON together with another type, so the body was not parsed.",
      });
      return;
    }
    if (verdict.action === "repair") req.headers["content-type"] = verdict.value;
    next();
  };
}
