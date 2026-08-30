# BURGONOMICS — Petpooja POS Integration (Layer 3 Constraint)

> **Reference Specification**: Petpooja POS menu ingestion, live KOT push, item out-of-stock webhooks (instant 86ing), and backoff retries.

---

## 1. Credentials & Configuration
Each branch stores credentials under `branches/{branchId}.petpooja`:
```json
{
  "restId": "REST_AHMEDABAD_01",
  "appKey": "pp_key_...",
  "appSecret": "pp_sec_...",
  "accessToken": "pp_token_..."
}
```

---

## 2. Menu Sync & Pricing Truth
- **Hourly Cron Worker (`syncMenu`)**: Fetches menu categories and items from Petpooja Menu API (`V1/get_menu`).
- **MRP Truth**: Item MRP is authoritative from Petpooja. Client UI displays cached data; Cloud Functions recompute authoritative totals at checkout.
- **Pre-Configured Items**: All burgers, sides, and drinks are ingested without modifier builders.

---

## 3. Order Push & Idempotency
- Triggered immediately upon payment capture (`payment.status == 'paid'`).
- Calls Petpooja Order Push API (`V1/push_order`) with idempotency key `orderId`.
- **Retry Queue**: In case of temporary Petpooja gateway failure, backoff retries occur at 1 min, 5 mins, and 30 mins (`pending_petpooja_retry`).
- Orders are visible immediately in Partner POS regardless of Petpooja status.

---

## 4. Instant 86ing & Post-Order Rejections
- **Stock Webhook (`petpoojaStockWebhook`)**: When Petpooja marks an ingredient or item out-of-stock, the Cloud Function updates `products/{productId}.available = false` instantly.
- **Post-Checkout Auto-Refund**: If an item is 86ed during cooking, the branch manager can adjust the order, automatically triggering a partial refund via Razorpay.
