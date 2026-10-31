# Petpooja item images — what the pipeline actually does

## Vendor payload

The menu push item carries `item_image_url` (also seen spelled `itemimageurl` in
other vendor surfaces), and the API also documents `item_categoryid`,
`itemdescription`, `in_stock`, `item_attributeid` and `taxes`.

Observed production sample (`functions/tests/fixtures/petpooja-menupush-sample.json`):

```json
"item_image_url": ""
```

All 166 captured items in the current sample carry an **empty string**, so the
mapper correctly stores `imageUrl: null`. A test pins that behaviour
(`functions/tests/petpooja.menu-fetch.test.ts`, "picks up item_image_url when it
carries a value, and stays null when it is the empty string").

## Mapping chain

`functions/src/modules/petpooja/menuSyncWebhook.ts`

1. Read the vendor's own spellings first:
   `item.itemimageurl || item.item_image_url || item.image_url || item.image`.
2. Persist as `products/{id}.imageUrl` (null when absent/empty).
3. Client `mapProductDoc` (`src/features/menu/services/menuService.ts`) reads
   `imageUrl → image → image_url → itemimageurl`, then calls
   `resolveItemImage(name, raw)` for a local curated fallback by product name.

So images **are** wired to Petpooja, but today the vendor sends no per-item image
URLs. Until the outlet populates them in Petpooja, the app shows the curated
local photography and never invents a URL.

## What is not claimed

- No image is downloaded from Petpooja during this work.
- No live menu push was triggered.
- No fallback is presented as the vendor's photo.
- If Petpooja later sends an absolute URL, the app renders it; if it sends a
  relative path or a broken URL, the existing safe-image handling falls back to
  the local photo.

## Follow-up for the merchant

Ask the outlet to upload item images in Petpooja, then re-run the menu sync. That
is an operational task, not a code change.
