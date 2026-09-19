// Minimal static file server with SPA fallback (Node built-ins only).
// Serves a production build directory; extensionless routes fall back to
// index.html so client-side routers (TanStack Router, React Router) work.
// Missing file assets (with an extension) still 404.
//
// Usage: node scripts/spa-server.mjs <rootDir> <port>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function serveFile(filePath, res) {
  fs.readFile(filePath, (readErr, data) => {
    if (readErr) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const filePath = path.join(root, urlPath);
  // Prevent path traversal escapes.
  if (path.relative(root, filePath).startsWith("..")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      serveFile(filePath, res);
      return;
    }
    if (!err && stat.isDirectory()) {
      serveFile(path.join(filePath, "index.html"), res);
      return;
    }
    // Missing path: SPA fallback for extensionless client-side routes,
    // hard 404 for missing file assets so broken bundles stay visible.
    if (!path.extname(urlPath)) {
      serveFile(path.join(root, "index.html"), res);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[spa-server] serving ${root} on http://localhost:${port}`);
});
