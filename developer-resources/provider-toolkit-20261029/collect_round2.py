"""Round-2 downloads: Shadowfax developer-doc subpages + Reelo official Postman collection.

Still public reference material only. The Postman gateway URL is the anonymous
asset the public documenter page itself loads; no account, no secrets, no
authenticated provider calls.
"""
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import time

from scrapling.fetchers import DynamicFetcher, Fetcher

ROOT = Path(r"C:\Users\DELL\Desktop\Burgonomics\developer-resources\provider-toolkit-20261029")
MIN_CHARS = 400
MANIFEST = ROOT / "documentation-manifest.json"

SHADOWFAX_SUBPAGES = [
    ("shadowfax-api-hyperlocal-authentication", "https://developer.shadowfax.in/docs/api/hyperlocal-marketplace/authentication", "Official Shadowfax Hyperlocal authentication page (token + OAuth2)"),
    ("shadowfax-api-hyperlocal-orders", "https://developer.shadowfax.in/docs/api/hyperlocal-marketplace/orders", "Official Shadowfax Hyperlocal orders API page (place/edit/dispatch/tracking/cancel)"),
    ("shadowfax-api-hyperlocal-serviceability", "https://developer.shadowfax.in/docs/api/hyperlocal-marketplace/serviceability", "Official Shadowfax Hyperlocal serviceability API page"),
    ("shadowfax-api-hyperlocal-sandbox", "https://developer.shadowfax.in/docs/api/hyperlocal-marketplace/sandbox", "Official Shadowfax Hyperlocal sandbox simulation API page"),
    ("shadowfax-api-hyperlocal-schemas", "https://developer.shadowfax.in/docs/api/hyperlocal-marketplace/~schemas", "Official Shadowfax Hyperlocal JSON schemas page"),
    ("shadowfax-callbacks", "https://developer.shadowfax.in/docs/hyperlocal/marketplace/callbacks", "Official Shadowfax hyperlocal marketplace callbacks guide"),
    ("shadowfax-hyperlocal-overview", "https://developer.shadowfax.in/docs/hyperlocal/overview", "Official Shadowfax hyperlocal product overview"),
    ("shadowfax-api-reference", "https://developer.shadowfax.in/docs/api-reference", "Official Shadowfax API reference index"),
    ("shadowfax-reference-authentication", "https://developer.shadowfax.in/docs/reference/authentication", "Official Shadowfax reference authentication page"),
    ("shadowfax-exchange-quickstart", "https://developer.shadowfax.in/docs/exchange/quickstart", "Official Shadowfax exchange quickstart"),
    ("shadowfax-forward-logistics-quickstart", "https://developer.shadowfax.in/docs/forward-logistics/quickstart", "Official Shadowfax forward logistics quickstart"),
    ("shadowfax-reverse-logistics-quickstart", "https://developer.shadowfax.in/docs/reverse-logistics/quickstart", "Official Shadowfax reverse logistics quickstart"),
    ("shadowfax-quick-commerce-overview", "https://developer.shadowfax.in/docs/quick-commerce/overview", "Official Shadowfax quick commerce overview"),
]

POSTMAN_URL = "https://documenter.gw.postman.com/api/collections/14784368/TzzBov5g?segregateAuth=true&versionTag=latest"
POSTMAN_HUMAN = "https://documenter.getpostman.com/view/14784368/TzzBov5g"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def save_snapshot(slug, url, description, text, method):
    target = ROOT / "docs" / f"{slug}.md"
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"# {description}\n\nSource: {url}\n"
        f"Retrieved UTC: {now_iso()}\nRetrieval method: {method}\n\n"
        "Public webpage text snapshot for local development reference. "
        "Not an API conformance or vendor-approval verdict; copyright remains "
        "with the publisher. Scripts/styles were not retained or executed.\n\n---\n\n"
    )
    data = (header + text + "\n").encode("utf-8")
    target.write_bytes(data)
    return {
        "id": slug, "url": url, "description": description,
        "retrieved_at_utc": now_iso(), "method": method,
        "status": "DOWNLOADED_TEXT" if method == "static" else "DOWNLOADED_DYNAMIC_TEXT",
        "text_characters": len(text),
        "file": str(target.relative_to(ROOT)),
        "bytes": len(data), "sha256": sha256(data).hexdigest(),
    }


def extract_text(page):
    candidates = page.css("main") or page.css("article")
    content = candidates[0] if candidates else page
    return str(content.get_all_text(separator="\n", strip=True)).strip()


def static_collect(entry):
    slug, url, description = entry
    try:
        page = Fetcher.get(url, timeout=45)
        if page.status != 200:
            return {"id": slug, "url": url, "description": description,
                    "retrieved_at_utc": now_iso(), "method": "static",
                    "http_status": page.status, "status": "HTTP_ERROR"}
        text = extract_text(page)
        if len(text) < MIN_CHARS:
            return {"id": slug, "url": url, "description": description,
                    "retrieved_at_utc": now_iso(), "method": "static",
                    "http_status": 200, "text_characters": len(text),
                    "status": "INSUFFICIENT_STATIC_CONTENT"}
        record = save_snapshot(slug, url, description, text, "static")
        record["static_attempt"] = {"http_status": 200, "text_characters": len(text)}
        return record
    except FileExistsError as error:
        return {"id": slug, "url": url, "description": description,
                "retrieved_at_utc": now_iso(), "method": "static",
                "status": "REFUSED_OVERWRITE", "error": str(error)[:400]}
    except Exception as error:
        return {"id": slug, "url": url, "description": description,
                "retrieved_at_utc": now_iso(), "method": "static",
                "status": "FETCH_FAILED", "error": str(error)[:400]}


def dynamic_collect(entry, static_result):
    slug, url, description = entry
    static_result["render_attempt"] = {"method": "Scrapling DynamicFetcher, ephemeral public-page browser",
                                       "retrieved_at_utc": now_iso()}
    try:
        page = DynamicFetcher.fetch(url, headless=True, timeout=60000)
        static_result["render_attempt"]["http_status"] = page.status
        if page.status != 200:
            static_result["render_attempt"]["status"] = "HTTP_ERROR"
            return static_result
        text = extract_text(page)
        static_result["render_attempt"]["text_characters"] = len(text)
        if len(text) < MIN_CHARS:
            static_result["render_attempt"]["status"] = "INSUFFICIENT_DYNAMIC_CONTENT"
            return static_result
        return save_snapshot(slug, url, description, text, "dynamic")
    except Exception as error:
        static_result["render_attempt"]["status"] = "RENDER_FAILED"
        static_result["render_attempt"]["error"] = str(error)[:400]
        return static_result


def strip_html(text, limit=4000):
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(text))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def render_postman_url(url):
    if not isinstance(url, dict):
        return str(url)
    return url.get("raw", "")


def render_postman_request(request, level):
    pad = "#" * min(level + 3, 6)
    lines = []
    method = request.get("method", "GET")
    lines.append(f"{pad} `{method}` `{render_postman_url(request.get('url', {}))}`")
    desc = request.get("description")
    desc_text = strip_html(desc if not isinstance(desc, dict) else desc.get("content", ""))
    if desc_text:
        lines.append(desc_text)
    headers = request.get("header") or []
    for header in headers:
        key, value = header.get("key", ""), str(header.get("value", "")).strip()
        if key.lower() in ("authorization",):
            value = f"<{len(value)} chars withheld>"
        lines.append(f"- Header: `{key}`: `{value}`")
    body = request.get("body")
    if body:
        mode = body.get("mode")
        if mode == "raw" and body.get("raw"):
            lines.append("- Body (raw):")
            lines.append("```json" if isinstance(body.get("raw"), str) and body["raw"].strip().startswith(("{", "[")) else "```")
            lines.append(str(body.get("raw")))
            lines.append("```")
        elif mode in ("urlencoded", "formdata", "graphql"):
            items = body.get("urlencoded") or body.get("formdata") or [body.get("graphql", {})]
            for item in items:
                key = item.get("key", "") if isinstance(item, dict) else ""
                value = item.get("value", "") if isinstance(item, dict) else ""
                lines.append(f"- Body field: `{key}`")
    return "\n".join(lines) + "\n"


def render_postman_node(node, level, out):
    if "item" in node:
        name = node.get("name", "Group")
        out.append(f"{'#' * min(level + 3, 6)} {name}\n")
        group_desc = node.get("description")
        if isinstance(group_desc, dict):
            group_desc = group_desc.get("content")
        group_text = strip_html(group_desc)
        if group_text:
            out.append(group_text + "\n")
        for child in node["item"]:
            render_postman_node(child, level + 1, out)
    else:
        out.append(f"{node.get('name', 'Request')}\n")
        if node.get("request"):
            out.append(render_postman_request(node["request"], level))
        else:
            out.append("*(no request definition)*\n")


def collect_reelo_postman():
    """Snapshot the official public Reelo collection JSON verbatim + render Markdown."""
    results = []
    response = Fetcher.get(POSTMAN_URL, timeout=60)
    if response.status != 200:
        return [{"id": "reelo-pos-integration-api", "url": POSTMAN_URL,
                 "description": "Official Reelo POS Integration API (Postman) collection JSON",
                 "retrieved_at_utc": now_iso(), "method": "static",
                 "http_status": response.status, "status": "HTTP_ERROR"}]
    raw = response.body
    try:
        doc = json.loads(raw.decode("utf-8", "ignore"))
    except Exception as error:
        return [{"id": "reelo-pos-integration-api", "url": POSTMAN_URL,
                 "description": "Official Reelo POS Integration API (Postman) collection JSON",
                 "retrieved_at_utc": now_iso(), "method": "static",
                 "status": "JSON_PARSE_FAILED", "error": str(error)[:400]}]

    # Verbatim JSON copy (representative payload; no secrets expected in a public doc)
    raw_target = ROOT / "raw" / "reelo-pos-integration-api.json"
    if raw_target.exists():
        raise FileExistsError(f"Refusing to overwrite {raw_target}")
    raw_target.parent.mkdir(parents=True, exist_ok=True)
    raw_target.write_bytes(raw)
    raw_record = {
        "id": "reelo-pos-integration-api-json", "url": POSTMAN_URL,
        "description": "Verbatim official Reelo POS Integration API Postman collection JSON (public documenter asset)",
        "retrieved_at_utc": now_iso(), "method": "static",
        "status": "DOWNLOADED_JSON",
        "file": str(raw_target.relative_to(ROOT)),
        "bytes": len(raw), "sha256": sha256(raw).hexdigest(),
    }
    results.append(raw_record)

    info = doc.get("info", {})
    title = info.get("name", "Reelo POS Integration API")
    intro = info.get("description")
    if isinstance(intro, dict):
        intro = intro.get("content")
    lines = [
        f"# {title} - OFFICIAL Reelo API (Postman collection, rendered contract)",
        "",
        f"Source page: {POSTMAN_HUMAN}",
        f"Verbatim JSON: {POSTMAN_URL}",
        f"Retrieved UTC: {now_iso()}",
        "",
        "Rendered read-only from the official public Postman documenter JSON that the",
        "public page itself loads anonymously. The raw JSON is preserved verbatim in",
        "raw/ alongside this file. Scripts were not executed.",
        "",
        "---",
        "",
    ]
    intro_text = strip_html(intro)
    if intro_text:
        lines += [intro_text, ""]
    out = []
    for item in doc.get("item", []):
        render_postman_node(item, 0, out)
    text = "\n".join(lines + out).strip()
    md_record = save_snapshot("reelo-pos-integration-api",
                              POSTMAN_URL + " (rendered from " + POSTMAN_HUMAN + ")",
                              "OFFICIAL Reelo POS Integration API (Postman) documentation "
                              "linked from reelo.io footer",
                              text, "json-render")
    md_record["status"] = "DOWNLOADED_FROM_JSON"
    md_record["raw_file"] = raw_record["file"]
    md_record["raw_sha256"] = raw_record["sha256"]
    md_record["requests_rendered"] = text.count("```") // 2
    results.append(md_record)
    return results


def main():
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=3) as pool:
        static_results = list(pool.map(static_collect, SHADOWFAX_SUBPAGES))
    results = []
    for entry, static_result in zip(SHADOWFAX_SUBPAGES, static_results):
        if static_result.get("status") in ("HTTP_ERROR", "INSUFFICIENT_STATIC_CONTENT", "FETCH_FAILED"):
            results.append(dynamic_collect(entry, static_result))
        else:
            results.append(static_result)
    results.extend(collect_reelo_postman())

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    manifest = [m for m in manifest if m["id"] != "reelo-pos-integration-api"]
    manifest.extend(results)
    manifest = sorted(manifest, key=lambda r: r["id"])
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    for result in results:
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
