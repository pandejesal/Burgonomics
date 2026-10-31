"""Read Petpooja/Borzo references only; exclude the user-rejected Shadowfax document."""

import ast
import hashlib
import json
import re
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

HERE = Path(__file__).resolve().parent
TEMP = Path(r"C:\Users\DELL\AppData\Local\Temp\opencode")
INPUTS = [
    ("Petpooja", Path(r"C:\Users\DELL\Desktop\PETPOOJA API Docs.txt"), "ff6abc5801ed836eb45f2d7f35f4a7dd5bd6fd4407ebb0f6430001f5216e20ea"),
    ("Borzo", Path(r"C:\Users\DELL\Desktop\Borzo API Docs.txt"), "c74fbe21023c80932a80c0b9d67a6b8049ad77eaf4d491c670219cf37a8bbd78"),
]
EXCLUDED_INPUTS = [{
    "provider": "Shadowfax", "source": r"C:\Users\DELL\Desktop\ShadowFax API Docs.txt",
    "status": "Rejected by user: wrong documentation; correct replacement pending",
    "usedForContract": False, "contentReadByThisHelper": False,
    "scope": "Earlier size/hash inventory is not approval; do not read, copy, summarize or implement this document",
}]
SENSITIVE = r"(?:authorization|(?:x[-_])?(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|client[-_]?id|app[-_]?key|app[-_]?secret|app[-_]?id|secret[-_]?key|password|token|signature)|customer[-_]?name|contact[-_]?(?:name|number)|phone(?:[-_]?number)?|mobile(?:[-_]?number)?|email|(?:customer[-_]?|delivery[-_]?|pickup[-_]?)?address|latitude|longitude|lat|lng)"
ASSIGNMENT = re.compile(r"(?i)([\"']?\b" + SENSITIVE + r"\b[\"']?\s*[:=]\s*)(\"(?:\\.|[^\"\r\n])*\"|'(?:\\.|[^'\r\n])*'|[^\r\n,}]+)")
NEXT_VALUE = re.compile(r"(?i)[\"']?\b" + SENSITIVE + r"\b[\"']?\s*[:=]\s*$")
URL = re.compile(r"https?://[^\s<>\"'`)]+", re.I)
INDEX_TERMS = {
    "version": r"\bversion\b|v[123]\.\d|business/\d",
    "auth": r"authorization|authenticat|access.token|api.key|secret|signature|hmac",
    "lifecycle": r"idempot|duplicat|client.order|external.order|reconcil|retry|timeout",
    "callbacks": r"webhook|callback|callback.url|notification.url|event.url",
    "dispatch": r"create.order|calculate.order|place.order|cancel.order|track.order|order.status|order.detail",
    "money": r"cod|cash.on|payment.type|payment.mode|tax|discount|gst|delivery.charge|order.total",
    "notes": r"instruction|description|comment|special.note|order.note|max.length|character.limit",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_url(match):
    try:
        parsed = urlsplit(match[0].rstrip(".,;"))
        host = parsed.hostname or "[unparsed-host]"
        if parsed.port:
            host += ":" + str(parsed.port)
        path = re.sub(r"[A-Za-z0-9_-]{28,}", "[redacted-opaque-segment]", parsed.path)
        return urlunsplit((parsed.scheme, host, path, "", ""))
    except ValueError:
        return "[redacted-unparsed-url]"


def redact(text):
    output, redactions, private_block, next_value = [], 0, False, False
    for line in text.splitlines():
        if "-----BEGIN" in line and "PRIVATE KEY" in line:
            private_block = True
        if private_block:
            output.append("[REDACTED PRIVATE MATERIAL]")
            redactions += 1
            if "-----END" in line and "PRIVATE KEY" in line:
                private_block = False
            continue
        safe = URL.sub(safe_url, line)
        if next_value and line.strip():
            safe = "[REDACTED FIELD VALUE]"
            redactions += 1
            next_value = False
        else:
            safe, count = ASSIGNMENT.subn(lambda match: match[1] + '"[REDACTED VALUE]"', safe)
            redactions += count
        next_value = bool(NEXT_VALUE.search(line))
        safe, count = re.subn(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[REDACTED EMAIL]", safe, flags=re.I)
        redactions += count
        safe, count = re.subn(r"(?<![A-Za-z0-9])\+?\d[\d -]{8,17}\d(?![A-Za-z0-9])", "[REDACTED LONG NUMBER]", safe)
        redactions += count
        safe, count = re.subn(r"(?<![A-Za-z0-9_])[A-Za-z0-9_+/=-]{28,}(?![A-Za-z0-9_])", "[REDACTED OPAQUE VALUE]", safe)
        redactions += count
        output.append(safe)
    return output, redactions


def main():
    destination = HERE / "local-inputs.json"
    if destination.exists():
        raise RuntimeError("Input review exists; do not overwrite completed work")
    if not TEMP.is_dir():
        raise RuntimeError("Approved temporary directory is unavailable")
    inputs = []
    for provider, path, expected in INPUTS:
        raw = path.read_bytes()
        if digest(raw) != expected:
            raise RuntimeError("User document changed since inventory: " + path.name)
        encoding = "utf-8-sig"
        try:
            text = raw.decode(encoding)
        except UnicodeDecodeError:
            encoding = "cp1252"
            text = raw.decode(encoding)
        inputs.append((provider, path, raw, text, encoding))
    views = Path(tempfile.mkdtemp(prefix="provider-doc-review-20261028-", dir=TEMP))
    records = []
    for provider, path, raw, text, encoding in inputs:
        lines, count = redact(text)
        view = views / (provider.lower() + ".redacted.txt")
        view.write_text("\n".join(lines) + "\n", encoding="utf-8")
        indices = {name: [{"line": number, "text": line[:220]} for number, line in enumerate(lines, 1) if re.search(pattern, line, re.I)][:35]
                   for name, pattern in INDEX_TERMS.items()}
        urls = list(dict.fromkeys(match[0].rstrip(".,;") for line in lines for match in URL.finditer(line)))
        records.append({"provider": provider, "source": str(path), "bytes": len(raw), "sha256": digest(raw),
                        "encoding": encoding, "lines": len(lines), "redactedView": str(view), "redactedViewSHA256": digest(view.read_bytes()),
                        "conservativeRedactions": count, "urls": urls, "termIndex": indices,
                        "limits": "User-supplied local reference; publisher/version/merchant applicability require reconciliation. Redactions can include public samples and schema prose; not proof of live credentials or complete secret detection."})
    ast.parse(Path(__file__).read_text(encoding="utf-8"), filename=__file__)
    report = {"inspectedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
              "scope": "Local user-supplied provider-document intake only; no provider/account calls, code changes or baseline adoption",
              "documents": records, "excludedDocuments": EXCLUDED_INPUTS, "helperSHA256": digest(Path(__file__).read_bytes()),
              "privacy": "Raw originals unchanged on Desktop; no raw copy in the repository. Local views redact credential-like/example/PII/opaque values and URL query/userinfo. Do not publish, execute embedded examples or infer credential entitlement."}
    with destination.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(report, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps({"output": str(destination), "documents": [{k: row[k] for k in ("provider", "bytes", "sha256", "lines", "conservativeRedactions", "redactedView")} for row in records]}))


if __name__ == "__main__":
    main()
