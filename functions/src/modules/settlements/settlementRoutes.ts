import type { Response } from "express";
import type { AuthenticatedRequest } from "../../core/middleware";
import { SettlementError } from "./settlementService";
import { db } from "../../core/firebase";

/**
 * HTTP mapping for the settlement routes. Kept separate from `index.ts` so the
 * status/code contract can be unit-tested without booting the whole app, and so
 * the route list changes stay to a few lines.
 */
export function settlementErrorResponse(err: any): {
  status: number;
  body: Record<string, any>;
} {
  if (err instanceof SettlementError) {
    return {
      status: err.statusCode,
      body: { code: err.code, error: err.message },
    };
  }
  // Anything unexpected is a server fault; never leak the message.
  return {
    status: 500,
    body: { error: "Settlement request failed" },
  };
}

/** Sends a CSV body the browser can save as a file. */
export function sendCsvDownload(res: Response, filename: string, csv: string): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  res.setHeader("Cache-Control", "no-store, private");
  res.status(200).send(csv);
}

/** The verified caller shape the settlement service expects. */
export async function settlementCaller(user: AuthenticatedRequest["user"]): Promise<{
  uid: string;
  role?: string;
  email?: string | null;
  branchIds?: string[];
} | null> {
  if (!user?.uid) return null;
  const token = user as any;
  const staff = (await db.collection("admins").doc(user.uid).get()).data();
  // §9: the registry is the AUTHORITY, the token is only an identity. A demoted
  // owner loses generate/mark-paid/resolve immediately instead of when its token
  // refreshes, and a stale brand claim cannot grant a role the registry removed.
  // A suspended or missing registry row grants nothing (fail closed).
  const role = staff?.active === false || staff?.suspended === true ? undefined : staff?.role;
  const held = Array.isArray(staff?.branchIds)
    ? staff.branchIds
    : typeof staff?.branchId === "string"
      ? [staff.branchId]
      : [];
  return {
    uid: user.uid,
    role: typeof role === "string" ? role : undefined,
    email: typeof token.email === "string" ? token.email : null,
    branchIds: held.filter((b: unknown): b is string => typeof b === "string" && !!b),
  };
}
