#!/usr/bin/env python3
"""Monthly Ration server for the Mac mini. Python 3.9+ standard library only.

    python3 server.py        (reads settings from .env if present)

Data lives in data/data.json, held in memory and written atomically on every change,
with a dated copy in data/backups/ once a day. Nothing is ever deleted.
"""
import base64
import copy
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import socket
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"


def load_env(path):
    """Minimal .env reader: KEY=VALUE lines, # comments. Real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text("utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


load_env(ROOT / ".env")
DATA_DIR = Path(os.environ.get("DATA_DIR") or ROOT / "data").expanduser().resolve()
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
PIN = os.environ.get("APP_PIN", "")
TRUST_PROXY = bool(os.environ.get("TRUST_PROXY"))
# Extra origins allowed to save, e.g. a Tailscale address that rewrites the Host header.
ALLOWED_ORIGINS = {o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()}

MAX_BODY = 1024 * 1024
MAX_OPS = 500
LONG_POLL_MAX = 25  # seconds a phone may wait for a change before asking again
SESSION_DAYS = 180
MAX_FAILS = 5
LOCK_SECONDS = 15 * 60

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---------- ops (keep in step with public/shared/ops.js) ----------
# A change is a list of ops, each setting or removing one value at a path, e.g.
# {"p": ["months", "2026-10", "checked", "atta"], "v": true}. Field-level ops let two
# phones edit at once without overwriting each other.
SEGMENT = re.compile(r"[A-Za-z0-9_-]{1,64}")
BANNED = {"__proto__", "prototype", "constructor"}
ROOTS = {"settings", "categories", "items", "months", "weeks"}


def valid_op(op):
    if not isinstance(op, dict) or not isinstance(op.get("p"), list):
        return False
    p = op["p"]
    if not 2 <= len(p) <= 6 or p[0] not in ROOTS:
        return False
    if not all(isinstance(s, str) and SEGMENT.fullmatch(s) and s not in BANNED for s in p):
        return False
    if "d" in op:
        return type(op["d"]) is int and op["d"] == 1
    return "v" in op


def apply_ops(data, ops):
    for op in ops:
        node = data
        for key in op["p"][:-1]:
            nxt = node.get(key)
            if not isinstance(nxt, dict):
                if "d" in op:
                    node = None
                    break
                nxt = node[key] = {}
            node = nxt
        if node is None:
            continue
        if "d" in op:
            node.pop(op["p"][-1], None)
        else:
            node[op["p"][-1]] = op["v"]
    return data


def looks_like_data(d):
    return isinstance(d, dict) and all(isinstance(d.get(k), dict) for k in ("settings", "categories", "items", "months"))


# ---------- storage ----------
class Store:
    """data.json kept in memory. One writer at a time; waiting phones are woken on change."""

    def __init__(self, directory):
        self.file = directory / "data.json"
        self.backups = directory / "backups"
        self.cond = threading.Condition()
        self.data = None
        self.body = b""  # compact JSON of self.data, reused for every read
        self.last_backup_day = None

    def init(self):
        self.backups.mkdir(parents=True, exist_ok=True)
        os.chmod(self.file.parent, 0o700)
        if self.file.exists():
            # A damaged file stops the server here instead of being replaced.
            try:
                data = json.loads(self.file.read_text("utf-8"))
            except ValueError as e:
                data = None
                print(f"Can't read {self.file}: {e}", file=sys.stderr)
            if not looks_like_data(data):
                raise SystemExit(f"{self.file} is damaged, so the app won't start (nothing was overwritten).\n"
                                 f"Copy the newest file from {self.backups} over it, then start again.")
        else:
            data = json.loads((ROOT / "defaults.json").read_text("utf-8"))
            data["updatedAt"] = now_iso()
            self._write(self.file, data)
        self._set(data)

    def _set(self, data):
        self.data = data
        self.body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    @staticmethod
    def _write(target, data):
        tmp = target.with_name(f"{target.name}.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)

    def _backup_once_per_day(self):
        day = datetime.now().strftime("%Y-%m-%d")
        if self.last_backup_day == day:
            return
        target = self.backups / f"data-{day}.json"
        if not target.exists():
            self._write(target, self.data)
        self.last_backup_day = day

    def update(self, fn):
        with self.cond:
            self._backup_once_per_day()
            nxt = fn(copy.deepcopy(self.data))  # work on a copy so a failure leaves memory untouched
            nxt["rev"] = int(self.data.get("rev", 0)) + 1
            nxt["updatedAt"] = now_iso()
            self._write(self.file, nxt)
            self._set(nxt)
            self.cond.notify_all()
            return nxt["rev"]

    def snapshot(self, label):
        with self.cond:
            self._write(self.backups / f"{label}-{int(time.time() * 1000)}.json", self.data)

    def read(self, since=None, wait=0):
        """Returns (rev, body). With wait > 0, blocks until rev differs from `since`."""
        with self.cond:
            if wait and since == self.data.get("rev"):
                self.cond.wait_for(lambda: self.data.get("rev") != since, timeout=wait)
            return self.data.get("rev"), self.body


# ---------- auth ----------
def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class Auth:
    """PIN login with a signed, HttpOnly cookie. No PIN configured = open access."""

    def __init__(self, pin, secret):
        self.pin = pin
        self.required = bool(pin)
        # Keyed on the PIN too, so changing the PIN signs every phone out.
        self.key = hashlib.sha256(f"{secret}|{pin}".encode()).digest()
        self.fails = {}
        self.lock = threading.Lock()

    def _sign(self, exp):
        return b64(hmac.new(self.key, f"v1.{exp}".encode(), hashlib.sha256).digest())

    def is_authed(self, cookie_header):
        if not self.required:
            return True
        token = ""
        for part in (cookie_header or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == "rs":
                token = value
        exp, _, sig = token.partition(".")
        if not exp.isdigit() or int(exp) < time.time():
            return False
        return hmac.compare_digest(sig, self._sign(exp))

    def cookie(self, value, max_age, secure):
        return f"rs={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict" + ("; Secure" if secure else "")

    def login(self, ip, attempt, secure):
        """Returns (status, body, cookie or None)."""
        if not self.required:
            return 200, {"ok": True}, None
        with self.lock:
            f = self.fails.get(ip)
            if f and f[1] > time.time():
                return 429, {"error": "Too many wrong tries. Wait 15 minutes."}, None
        if hmac.compare_digest(hashlib.sha256(attempt.encode()).digest(), hashlib.sha256(self.pin.encode()).digest()):
            with self.lock:
                self.fails.pop(ip, None)
            exp = int(time.time()) + SESSION_DAYS * 86400
            return 200, {"ok": True}, self.cookie(f"{exp}.{self._sign(str(exp))}", SESSION_DAYS * 86400, secure)
        with self.lock:
            count = (self.fails.get(ip, (0, 0))[0]) + 1
            self.fails[ip] = (count, time.time() + LOCK_SECONDS if count >= MAX_FAILS else 0)
        time.sleep(0.6)
        return 401, {"error": "Wrong PIN"}, None


# ---------- calendar ----------
RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]


def next_monthly(day, hh, mm, now):
    d = now.replace(day=day, hour=hh, minute=mm, second=0, microsecond=0)
    if d < now:
        y, m = (now.year + 1, 1) if now.month == 12 else (now.year, now.month + 1)
        d = d.replace(year=y, month=m)
    return d


def next_weekly(weekday, hh, mm, now):  # weekday: 0 = Sunday, like JavaScript
    d = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    today = (d.weekday() + 1) % 7
    d += timedelta(days=(weekday - today) % 7)
    return d + timedelta(days=7) if d < now else d


def build_ics(settings, app_url):
    def esc(s):
        return re.sub(r"([\\;,])", r"\\\1", s).replace("\n", "\\n")

    hh, _, mm = str(settings.get("reminderTime") or "10:00").partition(":")
    hh, mm = int(hh or 10), int(mm or 0)
    monthly_day = int(settings.get("monthlyDay") or 1)
    weekly_day = int(settings.get("weeklyDay") or 0)
    now = datetime.now()
    fmt = "%Y%m%dT%H%M%S"  # floating local time: the phone's own time zone applies
    events = [
        ("ration-monthly@ration-app", "🧺 Monthly wholesale ration shopping", next_monthly(monthly_day, hh, mm, now),
         f"FREQ=MONTHLY;BYMONTHDAY={monthly_day}", ["-P1D", "PT0M"]),
        ("ration-weekly@ration-app", "🥬 Weekly veg, milk & fresh shopping", next_weekly(weekly_day, hh, mm, now),
         f"FREQ=WEEKLY;BYDAY={RRULE_DAYS[weekly_day]}", ["PT0M"]),
    ]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ration-app//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"]
    for uid, title, start, rrule, alarms in events:
        lines += ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}", f"DTSTART:{start.strftime(fmt)}",
                  f"DTEND:{(start + timedelta(hours=1)).strftime(fmt)}", f"RRULE:{rrule}",
                  f"SUMMARY:{esc(title)}", f"DESCRIPTION:{esc('Open your list: ' + app_url)}"]
        for trigger in alarms:
            lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{esc(title)}", f"TRIGGER:{trigger}", "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


# ---------- static files ----------
def load_static():
    """public/ is small, so it's read once into memory with an ETag per file."""
    files = {}
    extra = {".webmanifest": "application/manifest+json", ".js": "text/javascript", ".svg": "image/svg+xml"}
    for path in PUBLIC.rglob("*"):
        if path.is_file():
            body = path.read_bytes()
            ctype = extra.get(path.suffix) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith(("json", "+xml")):
                ctype += "; charset=utf-8"
            rel = "/" + path.relative_to(PUBLIC).as_posix()
            files[rel] = (body, ctype, '"' + hashlib.sha1(body).hexdigest()[:16] + '"')
    files["/"] = files["/index.html"]
    return files


# ---------- HTTP ----------
class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive: phones reuse one connection
    server_version = "Ration"
    sys_version = ""
    timeout = LONG_POLL_MAX + 50  # drop idle keep-alive connections

    def log_message(self, fmt, *args):  # quiet: no per-request logging
        pass

    # --- helpers ---
    def send(self, status, body, ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        headers = {"Cache-Control": "no-store", **(headers or {})}  # callers may override caching
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def client_ip(self):
        forwarded = TRUST_PROXY and self.headers.get("X-Forwarded-For")
        return (forwarded or self.client_address[0]).split(",")[0].strip()

    def is_https(self):
        return self.headers.get("X-Forwarded-Proto") == "https"

    def read_json(self):
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            raise ApiError(415, "expected application/json")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BODY:
            raise ApiError(413, "body missing or too large")
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            raise ApiError(400, "invalid json")

    def same_origin(self):
        # Writes must come from this site (the cookie is SameSite=Strict too; this is a second check).
        origin = self.headers.get("Origin")
        if not origin:
            return True
        hosts = {self.headers.get("Host"), self.headers.get("X-Forwarded-Host")}
        return urlsplit(origin).netloc in hosts or origin.rstrip("/") in ALLOWED_ORIGINS

    # --- routing ---
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path.startswith("/api/"):
            return self.api("GET", url)
        f = STATIC.get(url.path)
        if not f:
            return self.send(404, "Not found", "text/plain; charset=utf-8")
        body, ctype, etag = f
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # no-cache = phones keep their copy and revalidate cheaply with the ETag.
        self.send(200, body, ctype, {"ETag": etag, "Cache-Control": "no-cache"})

    def do_POST(self):
        url = urlsplit(self.path)
        if not url.path.startswith("/api/"):
            return self.send(405, {"error": "method not allowed"})
        self.api("POST", url)

    def api(self, method, url):
        route = f"{method} {url.path.rstrip('/')}"
        try:
            if method != "GET" and not self.same_origin():
                raise ApiError(403, "cross-site request blocked")
            if route not in OPEN_ROUTES and not AUTH.is_authed(self.headers.get("Cookie")):
                raise ApiError(401, "PIN required")
            handler = ROUTES.get(route)
            if not handler:
                raise ApiError(404, "not found")
            handler(self, parse_qs(url.query))
        except ApiError as e:
            self.send(e.status, {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001 - report, keep serving
            print(f"{route} failed: {e!r}", file=sys.stderr)
            self.send(500, {"error": "server error"})

    # --- routes ---
    def r_session(self, q):
        self.send(200, {"authRequired": AUTH.required, "authed": AUTH.is_authed(self.headers.get("Cookie")),
                        "where": str(STORE.file)})

    def r_login(self, q):
        pin = str(self.read_json().get("pin") or "")
        status, body, cookie = AUTH.login(self.client_ip(), pin, self.is_https())
        self.send(status, body, headers={"Set-Cookie": cookie} if cookie else None)

    def r_logout(self, q):
        self.send(200, {"ok": True}, headers={"Set-Cookie": AUTH.cookie("", 0, self.is_https())})

    def r_state(self, q):
        # ?rev=N&wait=25 holds the request until something changes (or 25 s pass),
        # so phones hear about edits at once without polling.
        since = q.get("rev", [""])[0]
        since = int(since) if since.isdigit() else None
        wait = q.get("wait", ["0"])[0]
        wait = min(LONG_POLL_MAX, int(wait)) if wait.isdigit() and since is not None else 0
        rev, body = STORE.read(since, wait)
        if rev == since:
            return self.send(200, {"rev": rev, "unchanged": True})
        self.send(200, b'{"rev":%d,"data":' % rev + body + b"}")

    def r_ops(self, q):
        ops = self.read_json().get("ops")
        if not isinstance(ops, list) or not 0 < len(ops) <= MAX_OPS or not all(valid_op(o) for o in ops):
            raise ApiError(400, "invalid ops")
        STORE.update(lambda d: apply_ops(d, ops))
        rev, body = STORE.read()
        self.send(200, b'{"rev":%d,"data":' % rev + body + b"}")

    def r_export(self, q):
        _, body = STORE.read()
        name = f"ration-backup-{datetime.now().strftime('%Y-%m-%d')}.json"
        self.send(200, body, headers={"Content-Disposition": f'attachment; filename="{name}"'})

    def r_import(self, q):
        # Replaces everything with an uploaded backup, after saving a copy of what's there now.
        data = self.read_json().get("data")
        if not looks_like_data(data):
            raise ApiError(400, "that file isn't a ration backup")
        STORE.snapshot("pre-import")
        STORE.update(lambda current: data)
        rev, body = STORE.read()
        self.send(200, b'{"rev":%d,"data":' % rev + body + b"}")

    def r_calendar(self, q):
        proto = "https" if self.is_https() else "http"
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or f"localhost:{PORT}"
        ics = build_ics(STORE.data.get("settings", {}), f"{proto}://{host}/")
        self.send(200, ics, "text/calendar; charset=utf-8",
                  {"Content-Disposition": 'attachment; filename="ration-reminders.ics"'})


ROUTES = {
    "GET /api/session": Handler.r_session,
    "POST /api/login": Handler.r_login,
    "POST /api/logout": Handler.r_logout,
    "GET /api/state": Handler.r_state,
    "POST /api/ops": Handler.r_ops,
    "GET /api/export": Handler.r_export,
    "POST /api/import": Handler.r_import,
    "GET /api/calendar": Handler.r_calendar,
}
OPEN_ROUTES = {"GET /api/session", "POST /api/login", "POST /api/logout"}


def load_secret():
    """Random per-install secret for signing session cookies, kept next to the data."""
    path = DATA_DIR / ".secret"
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    return path.read_text().strip()


def lan_addresses():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent; this just picks the LAN interface
            return [s.getsockname()[0]]
    except OSError:
        return []


if __name__ == "__main__":
    threading.stack_size(512 * 1024)  # small stacks: each open request is one thread
    STORE = Store(DATA_DIR)
    STORE.init()
    AUTH = Auth(PIN, load_secret())
    STATIC = load_static()
    ThreadingHTTPServer.daemon_threads = True
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    name = socket.gethostname()
    if name.endswith(".local"):
        name = name[: -len(".local")]
    print("Ration app running. Open it on your phone:")
    print(f"  http://{name}.local:{PORT}")
    for ip in lan_addresses():
        print(f"  http://{ip}:{PORT}")
    print(f"Data: {STORE.file}  (daily copies in {STORE.backups})")
    if not PIN:
        print("No APP_PIN set: anyone on your Wi-Fi can open it. Set one in .env to lock it.")
    sys.stdout.flush()
    try:
        httpd.serve_forever(poll_interval=5)  # wakes rarely when idle
    except KeyboardInterrupt:
        pass
