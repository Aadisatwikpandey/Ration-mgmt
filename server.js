#!/usr/bin/env node
// Mac mini server: serves public/ and the API, saving to data/data.json. No npm install needed.
//   npm start            (reads settings from .env if present)
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, SECURITY_HEADERS } from "./lib/api.js";
import { makeAuth } from "./lib/auth.js";
import { fileStore } from "./lib/store-file.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

// Random per-install secret for signing session cookies, kept next to the data.
async function loadSecret() {
  const file = path.join(DATA_DIR, ".secret");
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    const secret = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(file, secret, { mode: 0o600, flag: "wx" }).catch(() => {});
    return (await fs.readFile(file, "utf8")).trim();
  }
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, "http://local").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel === "/") rel = "/index.html";
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

const store = fileStore(DATA_DIR);
await store.init();
const pin = process.env.APP_PIN || "";
const auth = makeAuth({ pin, secret: await loadSecret() });
const api = createApi({ store, auth, pollMs: 5000, saveDelayMs: 400 });

http
  .createServer((req, res) => (req.url.startsWith("/api/") ? api(req, res) : serveStatic(req, res)))
  .listen(PORT, HOST, () => {
    const name = os.hostname().replace(/\.local$/, "");
    console.log("Ration app running. Open it on any phone on your Wi-Fi:");
    console.log(`  http://${name}.local:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  http://${ip}:${PORT}`);
    console.log(`Data: ${store.where}  (daily copies in ${path.join(DATA_DIR, "backups")})`);
    if (!pin) console.log("No APP_PIN set: anyone on your Wi-Fi can open it. Set one in .env to lock it.");
  });
