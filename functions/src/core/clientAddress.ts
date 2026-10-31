/**
 * Client address for IP-keyed rate limiting behind Cloud Run.
 *
 * Cloud Run appends the caller's address as the RIGHTMOST entry of
 * `X-Forwarded-For`, so a client-sent leading entry cannot impersonate another
 * client. Reading the rightmost entry is what `app.set("trust proxy", 1)`
 * does for `req.ip`; this helper names the decision so it can be unit-tested
 * and used by the limiter's key generator.
 */
export function resolveClientAddress(
  forwardedFor: string | string[] | undefined,
  remoteAddress?: string
): string {
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (typeof raw === "string" && raw.trim()) {
    const parts = raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return remoteAddress && remoteAddress.trim() ? remoteAddress.trim() : "unknown";
}
