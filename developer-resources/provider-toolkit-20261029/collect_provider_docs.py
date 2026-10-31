"""Download public reference text only; never call authenticated provider APIs.

The 2026-10-29 refresh of provider-toolkit-20261027 focused on:
- NEW sources: Shadowfax official developer portal (hyperlocal marketplace API),
  Reelo official POS Integration API (Postman), Reelo website, Petpooja third-party
  API profile repo (cloned separately), Porter website snapshot.
- Broader official docs: Razorpay Orders/Payments API, Firebase CLI/Functions/
  Security rules/FCM pages alongside the existing MCP pages.
Static fetch first; JS-heavy pages automatically fall back to an ephemeral
headless browser (Scrapling DynamicFetcher). No overwrite of any existing file.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
import json
import time
from pathlib import Path

from scrapling.fetchers import DynamicFetcher, Fetcher

ROOT = Path(r"C:\Users\DELL\Desktop\Burgonomics\developer-resources\provider-toolkit-20261029")
MIN_CHARS = 400

PAGES = [
    # Razorpay (official)
    ("razorpay-mcp", "https://razorpay.com/docs/mcp-server", "Official Razorpay MCP overview"),
    ("razorpay-mcp-local", "https://razorpay.com/docs/mcp-server/local", "Official Razorpay local MCP setup"),
    ("razorpay-webhook-validation", "https://razorpay.com/docs/webhooks/validate-test", "Official webhook validation and testing"),
    ("razorpay-webhook-practices", "https://razorpay.com/docs/webhooks/best-practices", "Official webhook best practices"),
    ("razorpay-orders-api", "https://razorpay.com/docs/api/orders", "Official Orders API documentation"),
    ("razorpay-payments-api", "https://razorpay.com/docs/api/payments", "Official Payments API documentation"),
    # Firebase (official)
    ("firebase-mcp", "https://firebase.google.com/docs/ai-assistance/mcp-server", "Official Firebase MCP documentation"),
    ("firebase-cli", "https://firebase.google.com/docs/cli", "Official Firebase CLI documentation"),
    ("firebase-functions-get-started", "https://firebase.google.com/docs/functions/get-started", "Official Cloud Functions get-started documentation"),
    ("firebase-security-rules", "https://firebase.google.com/docs/firestore/security/get-started", "Official Firestore security rules documentation"),
    ("firebase-fcm-server", "https://firebase.google.com/docs/cloud-messaging/server", "Official FCM server integration documentation"),
    # Borzo (official)
    ("borzo-business-api", "https://borzodelivery.com/in/business-api/doc", "Official Borzo India Business API documentation"),
    ("borzo-integration", "https://borzodelivery.com/in/api-integration", "Official Borzo India integration overview"),
    # Shadowfax (official developer portal + public marketing pages)
    ("shadowfax-dev-hyperlocal", "https://developer.shadowfax.in/docs/api/hyperlocal-marketplace", "OFFICIAL Shadowfax Hyperlocal Marketplace API developer documentation"),
    ("shadowfax-dev-root", "https://developer.shadowfax.in/docs", "Official Shadowfax developer docs index"),
    ("shadowfax-hyperlocal-web", "https://www.shadowfax.in/hyperlocal", "Official Shadowfax hyperlocal marketing page; not an API contract"),
    ("shadowfax-platform", "https://www.shadowfax.in/innovation", "Official platform overview only; not a confirmed Shadowfax API contract"),
    # Petpooja (official; third-party profile repo cloned separately in repos/)
    ("petpooja-online-ordering", "https://onlineorderingapisv210.docs.apiary.io/", "Petpooja V2.1.0 public API documentation; cross-check against the vendor-issued contract"),
    ("petpooja-integrations", "https://www.petpooja.com/poss/restaurant-integrations", "Official integration overview, not an API schema"),
    # Reelo (official website + official Postman API documentation)
    ("reelo-website", "https://reelo.io", "Official Reelo restaurant CRM/loyalty marketing overview"),
    ("reelo-pos-integration-api", "https://documenter.getpostman.com/view/14784368/TzzBov5g", "OFFICIAL Reelo POS Integration API (Postman) documentation linked from reelo.io footer"),
    # Porter ("etc." companion in this workspace; vendor API contract remains gated)
    ("porter-website", "https://porter.in", "Official Porter marketing overview; claims API integration but no public REST contract verified"),
    # Tooling
    ("shadcn-mcp", "https://ui.shadcn.com/docs/mcp", "Official shadcn MCP documentation"),
]


def save_snapshot(slug, url, description, text, method):
    """Write one snapshot file; refusals to overwrite are fatal by design."""
    target = ROOT / "docs" / f"{slug}.md"
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite {target}")
    retrieved = datetime.now(timezone.utc).isoformat()
    target.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"# {description}\n\nSource: {url}\n"
        f"Retrieved UTC: {retrieved}\nRetrieval method: {method}\n\n"
        "Public webpage text snapshot for local development reference. "
        "Not an API conformance or vendor-approval verdict; copyright remains "
        "with the publisher. Scripts/styles were not retained or executed.\n\n---\n\n"
    )
    data = (header + text + "\n").encode("utf-8")
    target.write_bytes(data)
    record = {
        "id": slug,
        "url": url,
        "description": description,
        "retrieved_at_utc": retrieved,
        "method": method,
        "status": "DOWNLOADED_TEXT" if method == "static" else "DOWNLOADED_DYNAMIC_TEXT",
        "text_characters": len(text),
        "file": str(target.relative_to(ROOT)),
        "bytes": len(data),
        "sha256": sha256(data).hexdigest(),
    }
    return record


def extract_text(page):
    candidates = page.css("main") or page.css("article")
    content = candidates[0] if candidates else page
    return str(content.get_all_text(separator="\n", strip=True)).strip()


def static_collect(entry):
    slug, url, description = entry
    result = {"id": slug, "url": url, "description": description,
              "retrieved_at_utc": datetime.now(timezone.utc).isoformat(), "method": "static"}
    try:
        page = Fetcher.get(url, timeout=45)
        result["http_status"] = page.status
        if page.status != 200:
            result["status"] = "HTTP_ERROR"
            return result
        text = extract_text(page)
        result["text_characters"] = len(text)
        # An HTTP success can still be a JS shell or generic marketing page.
        if len(text) < MIN_CHARS:
            result["status"] = "INSUFFICIENT_STATIC_CONTENT"
            return result
        record = save_snapshot(slug, url, description, text, "static")
        record["static_attempt"] = {k: result[k] for k in
                                    ("http_status", "text_characters", "retrieved_at_utc")}
        return record
    except FileExistsError as error:
        return {**result, "status": "REFUSED_OVERWRITE", "error": str(error)[:400]}
    except Exception as error:  # network/SSL/impersonation failures
        result["status"] = "FETCH_FAILED"
        result["error"] = str(error)[:400]
        return result


def dynamic_collect(entry, static_result):
    """Ephemeral headless browser retry for pages static fetching could not render."""
    slug, url, description = entry
    result = static_result if static_result else {
        "id": slug, "url": url, "description": description,
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(), "method": "static"}
    result["render_attempt"] = {
        "method": "Scrapling DynamicFetcher, ephemeral public-page browser",
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    time.sleep(2)
    try:
        page = DynamicFetcher.fetch(url, headless=True, timeout=60000)
        result["render_attempt"]["http_status"] = page.status
        if page.status != 200:
            result["render_attempt"]["status"] = "HTTP_ERROR"
            return result
        text = extract_text(page)
        result["render_attempt"]["text_characters"] = len(text)
        if len(text) < MIN_CHARS:
            result["render_attempt"]["status"] = "INSUFFICIENT_DYNAMIC_CONTENT"
            result["status"] = result["status"] if "status" in result else "HTTP_ERROR"
            return result
        record = save_snapshot(slug, url, description, text, "dynamic")
        return record
    except Exception as error:
        result["render_attempt"]["status"] = "RENDER_FAILED"
        result["render_attempt"]["error"] = str(error)[:400]
        return result


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "docs").mkdir(exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(static_collect, PAGES))

    # Sequential dynamic retries, one at a time, for anything static could not get.
    dynamic_retries = []
    final_results = []
    for entry, result in zip(PAGES, results):
        if result.get("status") in ("HTTP_ERROR", "INSUFFICIENT_STATIC_CONTENT", "FETCH_FAILED"):
            dynamic_retries.append((entry, result))
        else:
            final_results.append(result)
    for entry, static_result in dynamic_retries:
        final_results.append(dynamic_collect(entry, static_result))

    manifest = sorted(final_results, key=lambda r: r["id"])
    (ROOT / "documentation-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")
    for result in manifest:
        print(json.dumps(result), flush=True)
