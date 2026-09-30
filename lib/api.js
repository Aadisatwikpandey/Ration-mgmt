// HTTP API shared by the Mac mini server (server.js) and Vercel functions (api/*.js).
// Handlers take Node's (req, res), which both environments provide.
import { applyOps, validOp } from "../public/shared/ops.js";
import { looksLikeData } from "./defaults.js";
import { buildIcs } from "./ics.js";

const MAX_BODY = 1024 * 1024;
const MAX_OPS = 500;

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isText = typeof body === "string";
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw Object.assign(new Error("expected application/json"), { status: 415 });
  }
  if (Number(req.headers["content-length"] || 0) > MAX_BODY) {
    throw Object.assign(new Error("body too large"), { status: 413 });
  }
  // Vercel may have parsed the body already.
  if (req.body !== undefined) {
    const b = req.body;
    return typeof b === "string" || Buffer.isBuffer(b) ? JSON.parse(String(b)) : b;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Writes must come from this site (the cookie is SameSite=Strict too; this is a second check).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers["x-forwarded-host"] || req.headers.host);
  } catch {
    return false;
  }
}

function appUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http");
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}/`;
}

/**
 * @param {object} o
 * @param {{kind:string, where:string, get:Function, update:Function, snapshot:Function}} o.store
 * @param {ReturnType<import("./auth.js").makeAuth>} o.auth
 * @param {number} o.pollMs  how often open pages check for changes from other phones
 * @param {number} o.saveDelayMs  how long pages batch edits before saving
 * @param {string} [o.setupError]  set when the deployment is misconfigured; locks the API
 */
export function createApi({ store, auth, pollMs, saveDelayMs, setupError }) {
  const routes = {
    "GET /api/session": async (req) => ({
      authRequired: auth.required,
      authed: auth.isAuthed(req),
      storage: store.kind,
      where: store.where,
      pollMs,
      saveDelayMs,
      setupError,
    }),

    "POST /api/login": async (req, res) => {
      const { pin } = await readJson(req);
      const r = await auth.login(req, String(pin ?? ""));
      send(res, r.status, r.body, r.cookie ? { "Set-Cookie": r.cookie } : {});
    },

    "POST /api/logout": async (req, res) => {
      send(res, 200, { ok: true }, { "Set-Cookie": auth.logoutCookie(req) });
    },

    "GET /api/state": async (req, res, url) => {
      const data = await store.get();
      if (!data) return send(res, 503, { error: "no data yet" });
      if (Number(url.searchParams.get("rev")) === data.rev) return { rev: data.rev, unchanged: true };
      return { rev: data.rev, data };
    },

    "POST /api/ops": async (req) => {
      const { ops } = await readJson(req);
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS || !ops.every(validOp)) {
        throw Object.assign(new Error("invalid ops"), { status: 400 });
      }
      const data = await store.update((d) => applyOps(d, ops));
      return { rev: data.rev, data };
    },

    "GET /api/export": async (req, res) => {
      const data = await store.get();
      const name = `ration-backup-${new Date().toISOString().slice(0, 10)}.json`;
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data, null, 1));
    },

    // Replaces everything with an uploaded backup, after saving a copy of what's there now.
    "POST /api/import": async (req) => {
      const { data } = await readJson(req);
      if (!looksLikeData(data)) throw Object.assign(new Error("that file isn't a ration backup"), { status: 400 });
      await store.snapshot("pre-import");
      const saved = await store.update((current) => ({ ...data, lastBackupDay: current.lastBackupDay }));
      return { rev: saved.rev, data: saved };
    },

    "GET /api/calendar": async (req, res) => {
      const data = await store.get();
      const ics = buildIcs(data.settings, appUrl(req));
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="ration-reminders.ics"',
        "Cache-Control": "no-store",
      });
      res.end(ics);
    },
  };

  const open = new Set(["GET /api/session", "POST /api/login", "POST /api/logout"]);

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://local");
    } catch {
      return send(res, 400, { error: "bad url" });
    }
    const key = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
    const route = routes[key];
    try {
      if (!route) return send(res, 404, { error: "not found" });
      if (setupError && key !== "GET /api/session") return send(res, 503, { error: setupError });
      if (req.method !== "GET" && !sameOrigin(req)) return send(res, 403, { error: "cross-site request blocked" });
      if (!open.has(key) && !auth.isAuthed(req)) return send(res, 401, { error: "PIN required" });
      const out = await route(req, res, url);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error(key, e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "server error" : e.message });
    }
  };
}
