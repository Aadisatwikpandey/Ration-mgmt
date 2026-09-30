// PIN login with a signed, HttpOnly session cookie. No PIN configured = open access (home Wi-Fi only).
import crypto from "node:crypto";

const COOKIE = "rs";
const SESSION_DAYS = 180;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// X-Forwarded-For is only trustworthy behind a proxy that sets it (Vercel, or TRUST_PROXY=1).
const trustProxy = !!(process.env.VERCEL || process.env.TRUST_PROXY);

export function clientIp(req) {
  const forwarded = trustProxy && req.headers["x-forwarded-for"];
  return String(forwarded || req.socket?.remoteAddress || "?").split(",")[0].trim();
}

const isHttps = (req) => req.headers["x-forwarded-proto"] === "https" || !!req.socket?.encrypted;

export function makeAuth({ pin, secret }) {
  const required = !!pin;
  // Keyed on the PIN too, so changing the PIN signs every device out.
  const key = sha(`${secret}|${pin || ""}`);
  const sign = (exp) => crypto.createHmac("sha256", key).update(`v1.${exp}`).digest("base64url");
  const fails = new Map(); // ip -> { count, until }

  function cookie(req, value, maxAge) {
    return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${isHttps(req) ? "; Secure" : ""}`;
  }

  return {
    required,

    isAuthed(req) {
      if (!required) return true;
      const [exp, sig] = (parseCookies(req.headers.cookie)[COOKIE] || "").split(".");
      if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
      const want = Buffer.from(sign(exp));
      const got = Buffer.from(sig);
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    },

    // Returns { status, body, cookie? }.
    async login(req, attempt) {
      if (!required) return { status: 200, body: { ok: true } };
      const ip = clientIp(req);
      const f = fails.get(ip);
      if (f && f.until > Date.now()) {
        return { status: 429, body: { error: "Too many wrong tries. Wait 15 minutes." } };
      }
      if (crypto.timingSafeEqual(sha(attempt), sha(pin))) {
        fails.delete(ip);
        const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
        return { status: 200, body: { ok: true }, cookie: cookie(req, `${exp}.${sign(exp)}`, SESSION_DAYS * 86400) };
      }
      const count = (f?.count || 0) + 1;
      fails.set(ip, { count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      await new Promise((r) => setTimeout(r, 600));
      return { status: 401, body: { error: "Wrong PIN" } };
    },

    logoutCookie: (req) => cookie(req, "", 0),
  };
}
