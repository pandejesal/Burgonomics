"""Second intake: correct Shadowfax documents only. Redacted local views, no provider calls."""

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
    ("Shadowfax official rider booking API", "Shadowfax - Official Rider Booking API Docs.txt",
     "3f82aaf144514c43ebae337f8494e196994b35aa9fba859728f4ece02819c760", "vendor-document"),
    ("Shadowfax integration gap analysis", "Shadowfax - Integration Gap Analysis.md",
     "8089057361f112a920082fbe76082098ccc543d6ccc01f387a89a20f37457dcd", "supplied-analysis"),
]
SENSITIVE = r"(?:authorization|(?:x[-_])?(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|client[-_]?id|app[-_]?key|app[-_]?secret|app[-_]?id|secret[-_]?key|password|token|signature)|customer[-_]?name|contact[-_]?(?:name|number)|phone(?:[-_]?number)?|mobile(?:[-_]?number)?|email|(?:customer[-_]?|delivery[-_]?|pickup[-_]?)?address|latitude|longitude|lat|lng)"
ASSIGNMENT = re.compile(r"(?i)([\"']?\b" + SENSITIVE + r"\b[\"']?\s*[:=]\s*)(\"(?:\\.|[^\"\r\n])*\"|'(?:\\.|[^'\r\n])*'|[^\r\n,}]+)")
NEXT_VALUE = re.compile(r"(?i)[\"']?\b" + SENSITIVE + r"\b[\"']?\s*[:=]\s*$")
URL = re.compile(r"https?://[^\s<>\"'`)]+", re.I)
TERMS = {
    "auth": r"authenticat|authorization|token|secret|signature|hmac|apikey|api.key",
    "booking": r"create.\s*order|place\s*order|book|dispatch|allocation|assign",
    "cancel": r"cancel",
    "status": r"status|webhook|callback|track|poll",
    "money": r"cod|cash|collect|payment|amount|charge|fare|price",
    "idempotency": r"idempot|duplicate|unique|request.id|reference",
    "notes": r"instruction|note|description|max.length|character",
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
    destination = HERE / "shadowfax-inputs.json"
    if destination.exists():
        raise RuntimeError("Shadowfax intake exists; preserve it")
    if not TEMP.is_dir():
        raise RuntimeError("Approved temporary directory is unavailable")
    data = []
    for label, name, expected, kind in INPUTS:
        path = Path(r"C:\Users\DELL\Desktop") / name
        if not path.is_file():
            raise RuntimeError("Missing source: " + name)
        raw = path.read_bytes()
        if digest(raw) != expected:
            raise RuntimeError("Source identity mismatch: " + name)
        try:
            text = raw.decode("utf-8-sig")
            encoding = "utf-8-sig"
        except UnicodeDecodeError:
            text = raw.decode("cp1252")
            encoding = "cp1252"
        data.append((label, name, kind, path, raw, text, encoding))
    views = Path(tempfile.mkdtemp(prefix="shadowfax-review-20261028-", dir=TEMP))
    records = []
    for label, name, kind, path, raw, text, encoding in data:
        lines, count = redact(text)
        view = views / (name.rsplit(".", 1)[0].replace(" ", "-").lower() + ".redacted.txt")
        view.write_text("\n".join(lines) + "\n", encoding="utf-8")
        index = {term: [{"line": number, "text": line[:220]} for number, line in enumerate(lines, 1) if re.search(pattern, line, re.I)][:40]
                 for term, pattern in TERMS.items()}
        urls = list(dict.fromkeys(match[0].rstrip(".,;") for line in lines for match in URL.finditer(line)))
        records.append({"label": label, "source": str(path), "kind": kind, "bytes": len(raw), "sha256": digest(raw),
                        "encoding": encoding, "lines": len(lines), "redactedView": str(view),
                        "redactedViewSHA256": digest(view.read_bytes()), "conservativeRedactions": count,
                        "urls": urls, "termIndex": index,
                        "authority": ("vendor-supplied rider booking reference" if kind == "vendor-document"
                                      else "supplied analysis; claims require independent vendor confirmation"),
                        "limits": "Local reference only. Merchant entitlement, current version, approved host, credentials, SLA and production behaviour are not established."})
    ast.parse(Path(__file__).read_text(encoding="utf-8"), filename=__file__)
    report = {"inspectedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
              "scope": "Corrected Shadowfax intake only; the earlier rejected file stays excluded",
              "documents": records, "helperSHA256": digest(Path(__file__).read_bytes()),
              "privacy": "Raw originals stay on Desktop. No raw copy or credential value stored in the repository; URL queries/userinfo stripped."}
    with destination.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(report, indent=2, ensure_ascii=True) + "\n")
    print(json.dumps({"output": str(destination), "documents": [{k: row[k] for k in ("label", "bytes", "sha256", "lines", "conservativeRedactions", "redactedView")} for row in records]}))


if __name__ == "__main__":
    main()
