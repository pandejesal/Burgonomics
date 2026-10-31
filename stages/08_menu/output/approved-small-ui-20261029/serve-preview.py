"""Loopback-only inert preview. Never expose APKs, logs, env or app sessions."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
PAGES = {
    "index.html", "preview.js", "README.md", "integration-readiness.md",
    "home-light.html", "home-dark.html", "cart-light.html", "cart-dark.html",
    "menu-light.html", "menu-dark.html",
    "burgonomics-logo.png",
    "followup/index.html", "followup/preview.js", "followup/README.md",
}

class PreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        path = unquote(urlsplit(self.path).path).lstrip("/") or "index.html"
        target = (ROOT / path).resolve()
        if not target.is_relative_to(ROOT):
            self.send_error(404)
            return None
        relative = target.relative_to(ROOT).as_posix()
        if not (
            relative in PAGES or relative.startswith("fonts/") or relative.startswith("images/")
        ) or not target.is_file():
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None

server = ThreadingHTTPServer(("127.0.0.1", 48244), PreviewHandler)
print(json.dumps({"pid": os.getpid(), "url": "http://127.0.0.1:48244/", "readOnly": True}), flush=True)
server.serve_forever()
