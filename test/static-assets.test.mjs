import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";

import { serveStatic } from "../dist/src/server-helpers.js";

const staticDir = path.resolve("dist", "src", "static");
const assets = [
  ["app-shell.css", "text/css; charset=utf-8"],
  ["reader.css", "text/css; charset=utf-8"],
  ["vendor/lucide/book-open.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/chart-no-axes-column.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/chevron-down.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/ellipsis.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/external-link.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/moon.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/network.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/search.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/settings-2.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/star.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/sun.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/x.svg", "image/svg+xml; charset=utf-8"],
  ["vendor/lucide/LICENSE", "text/plain; charset=utf-8"],
  ["vendor/lucide/README.md", "text/plain; charset=utf-8"]
];

test("normal HTTP static serving returns Reader assets with their source bodies and MIME types", async (t) => {
  const server = createServer((req, res) => {
    serveStatic(new URL(req.url || "/", "http://127.0.0.1").pathname, res);
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  for (const [asset, contentType] of assets) {
    const response = await fetch(`${baseUrl}/static/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers.get("content-type"), contentType, asset);
    assert.equal(await response.text(), readFileSync(path.join(staticDir, asset), "utf8"), asset);
  }
});
