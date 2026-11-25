import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { mirrorAndStripBranchSecrets } from "./branchSecrets";

/**
 * SEC-11 safety net (A3 finding 1).
 *
 * `branches/*` is readable by every operator role, so its POS/payment
 * identifiers now live in the brand-only `branch_secrets/{branchId}`. This
 * trigger mirrors and strips them on EVERY branch write, which covers a legacy
 * client, an ops console paste or any document that predates the rule change.
 *
 * Exposure window (documented, not hidden): between the branch write landing
 * and this trigger committing, a legacy write's secret field is on the branch
 * doc and therefore readable by a staff role. The window is one trigger hop.
 * It closes for good once the Partner screens write `branch_secrets` directly
 * (F6 change, posted on the bus as c11-files); this trigger stays as the net.
 */
export const onBranchWrittenSecretsMirror = onDocumentWritten(
  {
    document: "branches/{branchId}",
    region: "asia-south1",
    // A stalled mirror must not queue behind the default 60s budget; the work
    // is two document writes.
    timeoutSeconds: 60,
  },
  async (event) => {
    const branchId = event.params.branchId;
    if (!branchId) return;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    try {
      const result = await mirrorAndStripBranchSecrets(branchId, before, after);
      if (result.mirrored.length > 0 || result.stripped.length > 0) {
        console.log(
          `[BranchSecrets] branch ${branchId}: mirrored [${result.mirrored.join(
            ", "
          )}] stripped [${result.stripped.join(", ")}]`
        );
      }
    } catch (err: any) {
      // Never swallow silently: a branch left carrying secrets is the exact
      // regression this net exists to stop.
      console.error(
        `[BranchSecrets] mirror/strip FAILED for branch ${branchId}:`,
        err?.message || err
      );
      throw err;
    }
  }
);
