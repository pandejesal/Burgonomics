"""Round-2 probe: enumerate Shadowfax hyperlocal subpages + locate Reelo Postman JSON."""
import json
import re

from scrapling.fetchers import Fetcher

out = {}

# 1) Shadowfax developer docs: collect sibling links
body = Fetcher.get("https://developer.shadowfax.in/docs/api/hyperlocal-marketplace",
                   timeout=45).body.decode("utf-8", "ignore")
links = set(re.findall(r'href="([^"]+)"', body))
resolved = sorted({
    "https://developer.shadowfax.in" + l if l.startswith("/") and not l.startswith("//") else l
    for l in links
    if (("/docs/" in l) or ("hyperlocal" in l))
    and not re.search(r"\.(css|js|png|svg|ico|woff2?)($|\?)", l)
    and not l.startswith("//")
})
out["shadowfax_links_total"] = len(resolved)
out["shadowfax_links"] = resolved

# 2) Reelo Postman documenter: hunt for the embedded collection/schema asset
pbody = Fetcher.get("https://documenter.getpostman.com/view/14784368/TzzBov5g",
                    timeout=45).body.decode("utf-8", "ignore")
out["postman_html_len"] = len(pbody)
urls = sorted(set(re.findall(r"https?://[^\s\"'<>()]+", pbody)))
out["postman_candidate_urls"] = [u for u in urls if "postman" in u and (
    "schema" in u or "collection" in u or ".json" in u or "documenter" in u)]
out["postman_markers"] = sorted(set(re.findall(r"window\.(__[A-Z_]+__)", pbody)))
rel = sorted(set(re.findall(r"(?:src|href|action)=\"([^\"]*(?:schema|collection)[^\"]*)\"", pbody, re.I)))
out["postman_relative_refs"] = rel
# documenter pages typically embed a POSTMAN_DOCUMENTER / __NEXT_DATA__ blob; look for 'collectionJson' keys
out["postman_keys_hits"] = sorted(set(re.findall(r"[\"']([A-Za-z_/]*[Cc]ollection[A-Za-z_/.]*)[\"']", pbody)))[:40]

print(json.dumps(out, indent=2))
