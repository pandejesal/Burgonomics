/**
 * Petpooja POS module barrel (Batch 1 S1 — H11/C2).
 *
 * Canonical split modules only. The legacy `petpooja.service.ts` was deleted
 * in Batch 4 S1 after verifying zero importers (PLAN-B §4.5) — it duplicated
 * these symbols with unscoped prod_{itemid} ids and a fabricated fallback phone.
 */
export { syncPetpoojaMenu, handlePetpoojaMenuWebhook } from "./menuSyncWebhook";
export { pushOrderToPetpooja, formatPetpoojaOrderPayload } from "./orderPush";
export {
  handlePetpoojaStockWebhook,
  pushItemStockToPetpooja,
  handlePetpoojaWebhook,
  normalizePetpoojaStatus,
  resolveBranchIdForRestId,
} from "./item86ingSync";
export { getPetpoojaConfig, verifyPetpoojaSignature } from "./client";
export {
  syncAllBranchesPetpoojaMenu,
  retryPendingPetpoojaOrdersWorker,
} from "./petpooja.scheduler";
