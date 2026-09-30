import { applyOps, newId } from "./shared/ops.js";
import { WEEKDAYS, icsDate, reminderEvents } from "./shared/schedule.js";

const CACHE_KEY = "ration-v2";
const UI_KEY = "ration-ui";
const DEFAULT_START = "2026-10";
const SAVE_DELAY_MS = 400; // batch quick taps into one save
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FB = {
  more: { label: "Ran out early", short: "↑ ran out", icon: "↑" },
  ok: { label: "Just right", short: "✓ right", icon: "✓" },
  less: { label: "Left over", short: "↓ left over", icon: "↓" },
};
// Kinds of purchase. Wholesale and top-up have item lines; the rest are a single amount.
const KINDS = {
  wholesale: "Wholesale trip",
  topup: "Top-up",
  fresh: "Weekly veg & fresh",
  milk: "Milk",
  meat: "Chicken & eggs",
  other: "Other",
};
const QUICK_KINDS = ["fresh", "milk", "meat", "other"];

// ---------- small helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const money = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const byOrder = (a, b) => (a[1].order ?? 0) - (b[1].order ?? 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (key) => { const [y, m, d = 1] = key.split("-").map(Number); return new Date(y, m - 1, d); };
const shiftMonth = (key, n) => { const d = parseDay(key); return monthKey(new Date(d.getFullYear(), d.getMonth() + n, 1)); };
function weekKey(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // weeks start Monday
  return dateKey(x);
}
const shiftWeek = (key, n) => { const d = parseDay(key); d.setDate(d.getDate() + 7 * n); return dateKey(d); };
const monthLabel = (key, opts = { month: "long", year: "numeric" }) => parseDay(key).toLocaleDateString("en-IN", opts);
const weekLabel = (key) => "Week of " + parseDay(key).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const dayLabel = (key) => (key ? parseDay(key).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "");

// Tracking begins at settings.startMonth; nothing before it is shown.
const startMonth = () => view?.settings.startMonth || DEFAULT_START;
const firstWeek = () => weekKey(parseDay(startMonth()));
const clampMonth = (k) => (k < startMonth() ? startMonth() : k);
const clampWeek = (k) => (k < firstWeek() ? firstWeek() : k);
const homeMonth = () => clampMonth(monthKey());
const homeWeek = () => clampWeek(weekKey());

// ---------- quantities ----------
function roundQty(v, unit) {
  if (v <= 0) return 0;
  if (unit === "pcs") return Math.max(1, Math.round(v));
  if (v < 100) return Math.max(25, Math.round(v / 25) * 25);
  if (v < 1000) return Math.round(v / 50) * 50;
  if (v < 2000) return Math.round(v / 250) * 250;
  return Math.round(v / 500) * 500;
}
function fmtQty(v, unit) {
  if (!v) return "—";
  if (unit === "pcs") return `${v} pcs`;
  const big = unit === "ml" ? "L" : "kg";
  return v >= 1000 ? `${+(v / 1000).toFixed(2)} ${big}` : `${v} ${unit}`;
}
// "2 kg" -> {qty: 2000, unit: "g"}; "25–50 g" -> {text}; "" -> {}. A bare number keeps the item's unit.
function parseQty(str, currentUnit = "g") {
  const s = String(str || "").trim();
  if (!s) return {};
  const m = s.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(kgs?|g|gms?|grams?|l|ltrs?|litres?|liters?|ml|pcs?|pieces?|nos?)?$/);
  if (!m) return { text: s };
  const n = parseFloat(m[1]);
  let u = m[2];
  if (!u) u = currentUnit === "pcs" ? "pcs" : n < 50 ? (currentUnit === "ml" ? "l" : "kg") : currentUnit;
  if (u.startsWith("kg")) return { qty: Math.round(n * 1000), unit: "g" };
  if (u === "ml") return { qty: Math.round(n), unit: "ml" };
  if (u.startsWith("l")) return { qty: Math.round(n * 1000), unit: "ml" };
  if (u.startsWith("g")) return { qty: Math.round(n), unit: "g" };
  return { qty: Math.round(n), unit: "pcs" };
}
const people = () => view.settings.people || 3;
const basePeople = () => view.settings.basePeople || 3;
const scaled = (it, qty = it.qty) => (people() === basePeople() ? qty : roundQty((qty * people()) / basePeople(), it.unit));
const qtyText = (it) => (it.qty != null ? fmtQty(scaled(it), it.unit) : it.text || "");
const toStored = (qty) => Math.round((qty * basePeople()) / people());

// Next month's quantity for an item that ran out or was left over. When the item was
// topped up, the amount actually bought extra is added; otherwise it moves about 25%.
function suggestion(it, fb, tops = []) {
  if (it.qty == null || (fb !== "more" && fb !== "less")) return null;
  if (fb === "more" && tops.length) {
    const extra = sum(tops.map((l) => {
      const q = parseQty(l.qty, it.unit);
      return q.qty != null && q.unit === (it.unit || "g") ? q.qty : 0;
    }));
    if (extra > 0) {
      const to = roundQty(it.qty + toStored(extra), it.unit);
      if (to > it.qty) return to;
    }
  }
  const step = it.unit === "pcs" ? 1 : it.qty <= 100 ? 25 : 50;
  let to = roundQty(it.qty * (fb === "more" ? 1.25 : 0.75), it.unit);
  if (fb === "more" && to <= it.qty) to = it.qty + step;
  if (fb === "less" && to >= it.qty) to = Math.max(step, it.qty - step);
  return to === it.qty ? null : to;
}

// ---------- state ----------
let session = null;
let server = null; // { rev, data } as last confirmed by the server
let pending = []; // ops not yet saved to the server
let view = null; // server data + pending ops, what the UI shows
let pushing = false;
let saveTimer = null;
let polling = false;
let syncState = "loading";

const ui = { tab: "list", mode: "monthly", month: monthKey(), week: weekKey(), closed: {} };
try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY)) || {}, { month: monthKey(), week: weekKey() }); } catch {}
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify({ tab: ui.tab, mode: ui.mode, closed: ui.closed })); } catch {} };

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c?.server?.data) { server = c.server; pending = c.pending || []; recompute(); }
  } catch {}
}
const saveCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ server, pending })); } catch {} };

function recompute() {
  view = structuredClone(server.data);
  try {
    applyOps(view, pending);
  } catch {
    pending = [];
    view = structuredClone(server.data);
  }
  view.months ??= {};
  view.weeks ??= {};
}

const M = (key = ui.month) => view.months[key] || {};
const W = (key = ui.week) => view.weeks[key] || {};
const catsOf = (freq) => Object.entries(view.categories).filter(([, c]) => (c.freq || "monthly") === freq).sort(byOrder);
const itemsIn = (cat) => Object.entries(view.items).filter(([, i]) => i.cat === cat && !i.archived).sort(byOrder);
const monthlyItems = () => catsOf("monthly").flatMap(([cid]) => itemsIn(cid));
const activeItems = () => Object.entries(view.items).filter(([, i]) => !i.archived);
const nextOrder = () => 1 + Math.max(0, ...Object.values(view.items).map((i) => i.order ?? 0));
const findItemByName = (name) => activeItems().find(([, i]) => i.name.trim().toLowerCase() === name.trim().toLowerCase())?.[0];

// ---------- purchases ----------
const purchases = (key = ui.month) => Object.entries(M(key).purchases || {});
const lineTotal = (p) => sum(Object.values(p.lines || {}).map((l) => l.amount));
const purchaseTotal = (p) => (p.total != null ? Number(p.total) : lineTotal(p));
const monthSpend = (key) => sum(purchases(key).map(([, p]) => purchaseTotal(p)));
function trip(key = ui.month) {
  const found = purchases(key).find(([, p]) => p.kind === "wholesale");
  return found ? { id: found[0], p: found[1] } : null;
}
// Top-up lines for list items this month, grouped by item id.
function topupsByItem(key = ui.month) {
  const out = {};
  for (const [, p] of purchases(key)) {
    if (p.kind !== "topup") continue;
    for (const l of Object.values(p.lines || {})) if (l.item && view.items[l.item]) (out[l.item] ||= []).push(l);
  }
  return out;
}
// Every line this month for one item, with the purchase it came from.
function linesForItem(id, key = ui.month) {
  const out = [];
  for (const [pid, p] of purchases(key)) for (const l of Object.values(p.lines || {})) if (l.item === id) out.push({ pid, p, l });
  return out;
}
// Explicit review mark wins; a top-up of a list item counts as "ran out" unless marked otherwise.
const effectiveFb = (id, m, tops) => m.feedback?.[id] || (tops[id] ? "more" : undefined);

// ---------- server sync ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

function setSync(s) {
  syncState = s;
  const el = $("#sync");
  const busy = s === "ok" && pending.length > 0;
  el.className = "sync " + (busy ? "busy" : s);
  $("#syncText").textContent =
    busy ? "Saving…" : { ok: "Saved", offline: "Offline · saved on phone", locked: "Locked", loading: "Loading…" }[s] || s;
}

// Every edit goes through here: show it instantly, save it shortly after.
function change(ops, { rerender = true } = {}) {
  pending.push(...ops);
  applyOps(view, ops);
  saveCache();
  if (rerender) render();
  setSync(syncState);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(push, SAVE_DELAY_MS);
}

async function push() {
  saveTimer = null;
  if (pushing || !pending.length || !server) return;
  pushing = true;
  const batch = pending.slice();
  try {
    const r = await api("POST", "api/ops", { ops: batch });
    pending = pending.slice(batch.length);
    if (!acceptServer(r)) recompute();
    saveCache();
    setSync("ok");
    renderIfIdle();
  } catch (e) {
    if (e.status === 401) {
      setSync("locked");
      showLogin();
    } else if (e.status === 400) {
      pending = pending.slice(batch.length);
      recompute();
      saveCache();
      render();
      toast("A change couldn't be saved and was undone.");
      setSync("ok");
    } else {
      setSync("offline");
      saveTimer = setTimeout(push, 10000);
    }
  } finally {
    pushing = false;
    if (pending.length && !saveTimer && syncState === "ok") saveTimer = setTimeout(push, 400);
  }
}

// The server is the source of truth: take any revision that differs from ours. (It can go
// down, e.g. after a backup is restored by hand. A briefly stale answer heals on the next check.)
function acceptServer(r) {
  if (r.unchanged || r.rev === server?.rev) return false;
  server = { rev: r.rev, data: r.data };
  recompute();
  saveCache();
  return true;
}

async function pull() {
  if (pushing || saveTimer) return;
  if (pending.length) return push();
  try {
    if (acceptServer(await api("GET", `api/state?rev=${server?.rev ?? ""}`))) renderIfIdle();
    setSync("ok");
  } catch (e) {
    setSync(e.status === 401 ? "locked" : "offline");
    if (e.status === 401) showLogin();
  }
}

// While the app is on screen, keep one request waiting at the server; it answers the
// moment the other phone saves something (or after 25 s). No polling, no wasted wake-ups.
async function watch() {
  if (polling) return;
  polling = true;
  let quick = 0;
  try {
    while (document.visibilityState === "visible") {
      if (pushing || saveTimer || pending.length) {
        if (pending.length && !pushing && !saveTimer) push();
        await sleep(1000);
        continue;
      }
      const started = Date.now();
      try {
        const r = await api("GET", `api/state?rev=${server?.rev ?? ""}&wait=25`);
        setSync("ok");
        if (acceptServer(r)) renderIfIdle();
        // Safety brake: answers that keep coming back instantly mean something is off; slow down.
        quick = Date.now() - started < 500 ? quick + 1 : 0;
        if (quick >= 3) await sleep(5000);
      } catch (e) {
        setSync(e.status === 401 ? "locked" : "offline");
        if (e.status === 401) { showLogin(); break; }
        await sleep(10000);
      }
    }
  } finally {
    polling = false;
  }
}

function startPolling() {
  watch();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && server) watch();
  syncWakeLock();
});

// ---------- rendering ----------
function typingInMain() {
  const el = document.activeElement;
  return !!el && $("#view").contains(el) && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio", "file"].includes(el.type)));
}
const renderIfIdle = () => { if (!typingInMain() && !$("#sheet").open) render(); };

function render() {
  if (!view) return;
  ui.month = clampMonth(ui.month);
  ui.week = clampWeek(ui.week);
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === ui.tab ? "page" : "false"));
  const main = $("#view");
  main.innerHTML = { list: renderList, spend: renderSpend, review: renderReview, settings: renderSettings }[ui.tab]();
  // Widths are set here rather than in inline styles, which the page's security policy blocks.
  main.querySelectorAll("[data-w]").forEach((el) => (el.style.width = `${el.dataset.w}%`));
  syncWakeLock();
}

// Keep the screen on while a wholesale trip is open on the List tab (HTTPS only).
let wakeLock = null;
async function syncWakeLock() {
  const want = !!view && ui.tab === "list" && ui.mode === "monthly" && !!trip()?.p.open && document.visibilityState === "visible";
  if (want && !wakeLock && navigator.wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } catch {}
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function switcher(kind) {
  const isMonth = kind === "month";
  const key = isMonth ? ui.month : ui.week;
  const home = isMonth ? homeMonth() : homeWeek();
  const atStart = key === (isMonth ? startMonth() : firstWeek());
  const beforeStart = isMonth ? monthKey() < startMonth() : weekKey() < firstWeek();
  const sub = key === home ? (beforeStart ? `first ${kind}` : `this ${kind}`) : `<button type="button" class="link" data-act="${kind}-now">Go to ${beforeStart ? "first" : "this"} ${kind}</button>`;
  return `<div class="switcher">
    <button type="button" data-act="${kind}" data-delta="-1" aria-label="Previous ${kind}" ${atStart ? "disabled" : ""}>‹</button>
    <div class="label">${esc(isMonth ? monthLabel(key) : weekLabel(key))}<small>${sub}</small></div>
    <button type="button" data-act="${kind}" data-delta="1" aria-label="Next ${kind}">›</button>
  </div>`;
}

function peopleStepper() {
  return `<div class="stepper"><button type="button" data-act="people" data-delta="-1" aria-label="Fewer people">−</button>
    <output>${people()}</output><button type="button" data-act="people" data-delta="1" aria-label="More people">+</button></div>`;
}

function tripCard() {
  const t = trip();
  if (!t) {
    return `<section class="card trip-card no-print"><div class="row between">
      <div><b>🛒 Going to the wholesale market?</b><div class="muted">Start a trip to note prices as you tick items.</div></div>
      <button type="button" class="btn primary" data-act="trip-start">Start trip</button></div></section>`;
  }
  if (t.p.open) {
    return `<section class="card trip-card open no-print"><div class="row between">
      <div><b>🛒 Wholesale trip</b><div class="muted">Started ${esc(dayLabel(t.p.date))} · <span id="tripTotal">${money(lineTotal(t.p))}</span> priced</div></div>
      <button type="button" class="btn primary" data-act="trip-finish">Finish</button></div>
      <p class="muted">Tick items and type what you paid for each. Prices are optional: you can just enter the bill total when you finish.</p></section>`;
  }
  return `<section class="card trip-card no-print"><div class="row between">
    <div><b>✓ Wholesale trip done</b><div class="muted">${esc(dayLabel(t.p.date))}${t.p.shop ? ` · ${esc(t.p.shop)}` : ""} · <b>${money(purchaseTotal(t.p))}</b></div></div>
    <button type="button" class="btn" data-act="trip-finish">Edit</button></div></section>`;
}

function renderList() {
  const monthly = ui.mode === "monthly";
  const scope = monthly ? M() : W();
  const checked = scope.checked || {};
  const t = monthly ? trip() : null;
  const tops = monthly ? topupsByItem() : {};
  let total = 0;
  let done = 0;
  const sections = catsOf(monthly ? "monthly" : "weekly").map(([cid, c]) => {
    const rows = itemsIn(cid);
    const cDone = rows.filter(([id]) => checked[id]).length;
    total += rows.length;
    done += cDone;
    return `<details class="cat" data-cat="${esc(cid)}" ${ui.closed[cid] ? "" : "open"}>
      <summary>${esc(c.title)}<span class="count${cDone === rows.length && rows.length ? " full" : ""}">${cDone}/${rows.length}</span></summary>
      <ul class="items">${rows.map(([id, it]) => itemRow(id, it, !!checked[id], monthly, t, tops)).join("")}</ul>
      <button type="button" class="link add-in" data-act="add-item" data-cat="${esc(cid)}">+ Add item to list</button>
    </details>`;
  });
  const pct = total ? Math.round((done / total) * 100) : 0;
  const weekMonth = clampMonth(ui.week.slice(0, 7));
  const freshSpend = sum(purchases(weekMonth).filter(([, p]) => QUICK_KINDS.includes(p.kind)).map(([, p]) => purchaseTotal(p)));
  return `
    <div class="seg no-print" role="group" aria-label="List type">
      <button type="button" data-act="mode" data-mode="monthly" aria-pressed="${monthly}">Monthly wholesale</button>
      <button type="button" data-act="mode" data-mode="weekly" aria-pressed="${!monthly}">Weekly fresh</button>
    </div>
    ${switcher(monthly ? "month" : "week")}
    ${monthly ? tripCard() : ""}
    <div class="progress"><div class="bar"><span data-w="${pct}"></span></div>
      <div class="row between"><small>${done === total && total ? `All ${total} picked 🎉` : `${done} of ${total} picked`}</small>
      ${monthly ? `<div class="row no-print"><small>For</small>${peopleStepper()}<small>people</small></div>` : ""}</div>
    </div>
    ${t?.p.open ? `<form id="tripForm" autocomplete="off">${sections.join("")}</form>` : sections.join("")}
    ${monthly
      ? `<section class="card no-print"><div class="row between">
          <div><b>Bought more later?</b><div class="muted">Extra rice, atta or anything else during the month.</div></div>
          <button type="button" class="btn" data-act="topup">+ Top-up</button></div></section>`
      : `<section class="card no-print"><div class="row between">
          <div><b>Fresh spend in ${esc(monthLabel(weekMonth, { month: "long" }))}</b>
          <div class="muted">${money(freshSpend)} so far on veg, milk, chicken…</div></div>
          <button type="button" class="btn" data-act="quick" data-month="${weekMonth}">+ Log spend</button></div></section>`}
    <div class="wrap-row no-print card">
      <button type="button" class="btn" data-act="share">📤 Share what's left</button>
      <span class="muted">Tap ⋯ on an item to change it, see what you paid, or mark it ran out / left over.</span>
    </div>`;
}

function itemRow(id, it, isChecked, monthly, t, tops) {
  const note = it.note ? `<span class="note">${esc(it.note)}</span>` : "";
  const box = `<input type="checkbox" data-check="${esc(id)}" data-scope="${monthly ? "month" : "week"}" ${isChecked ? "checked" : ""}>`;
  // During an open wholesale trip each row gets a price box instead of the ⋯ menu.
  if (monthly && t?.p.open) {
    const line = t.p.lines?.[id];
    return `<li class="item trip${isChecked ? " done" : ""}">
      <label class="tick">${box}<span class="name"><span class="nm">${esc(it.name)}</span><span class="note">${esc(qtyText(it))}${it.note ? ` · ${esc(it.note)}` : ""}</span></span></label>
      <input class="price" type="number" min="0" step="any" inputmode="decimal" placeholder="₹" enterkeyhint="next" data-price="${esc(id)}" value="${esc(line?.amount ?? "")}" aria-label="Price paid for ${esc(it.name)}">
    </li>`;
  }
  const spent = monthly ? sum(linesForItem(id).map((x) => x.l.amount)) : 0;
  const fb = monthly ? effectiveFb(id, M(), tops) : null;
  const fbText = fb === "more" && !M().feedback?.[id] ? "↑ topped up" : fb && fb !== "ok" ? FB[fb].short : "";
  return `<li class="item${isChecked ? " done" : ""}">
    <label class="tick">${box}<span class="name"><span class="nm">${esc(it.name)}</span>${note}</span></label>
    <span class="qty">${esc(qtyText(it))}${spent ? `<small>${money(spent)}</small>` : ""}${fbText ? `<small class="${fb}">${fbText}</small>` : ""}</span>
    <button type="button" class="more-btn" data-act="item" data-id="${esc(id)}" aria-label="Edit ${esc(it.name)}">⋯</button>
  </li>`;
}

function purchaseSummary(p) {
  const n = Object.keys(p.lines || {}).length;
  const bits = [dayLabel(p.date)];
  if (p.shop) bits.push(p.shop);
  if (p.kind === "wholesale") bits.push(p.open ? "in progress" : n ? `${plural(n, "item")} priced` : "bill total only");
  else if (n) bits.push(plural(n, "item"));
  return bits.filter(Boolean).join(" · ");
}

function renderSpend() {
  const list = purchases().sort((a, b) => (b[1].date || "").localeCompare(a[1].date || ""));
  const total = sum(list.map(([, p]) => purchaseTotal(p)));
  const byKind = {};
  for (const [, p] of list) byKind[p.kind] = (byKind[p.kind] || 0) + purchaseTotal(p);
  const t = trip();
  const s = view.settings;
  const lo = Math.round(((s.budgetLow || 5500) * people()) / basePeople() / 100) * 100;
  const hi = Math.round(((s.budgetHigh || 7000) * people()) / basePeople() / 100) * 100;

  // What went where, per item, across the wholesale trip and top-ups.
  const agg = {};
  for (const [, p] of list) {
    for (const l of Object.values(p.lines || {})) {
      const onList = l.item && view.items[l.item];
      const key = onList ? l.item : `x:${String(l.name).toLowerCase()}`;
      const a = (agg[key] ||= { name: onList ? view.items[l.item].name : l.name, amount: 0, qtys: [], topup: false, extra: !onList });
      a.amount += Number(l.amount) || 0;
      if (l.qty) a.qtys.push(l.qty);
      if (p.kind === "topup") a.topup = true;
    }
  }
  const byItem = Object.values(agg).filter((a) => a.amount > 0).sort((a, b) => b.amount - a.amount);
  const unitemised = t && t.p.total != null ? Math.max(0, Number(t.p.total) - lineTotal(t.p)) : 0;

  const end = ui.month > homeMonth() ? ui.month : homeMonth();
  const months = [];
  for (let k = end; k >= startMonth() && months.length < 12; k = shiftMonth(k, -1)) months.push(k);
  const hist = months.map((k) => ({ k, t: monthSpend(k) })).filter((h) => h.t > 0 || h.k === ui.month);
  const max = Math.max(1, ...hist.map((h) => h.t));
  const withData = hist.filter((h) => h.t > 0);
  const avg = withData.length ? sum(withData.map((h) => h.t)) / withData.length : 0;

  return `
    ${switcher("month")}
    <section class="card">
      <div class="muted">Spent for ${esc(monthLabel(ui.month, { month: "long" }))}</div>
      <div class="big-num">${money(total)}</div>
      <div class="muted">${Object.entries(byKind).map(([k, v]) => `${esc(KINDS[k] || k)} ${money(v)}`).join(" · ") || "Nothing logged yet."}</div>
      <div class="muted">Ballpark for ${people()} people, groceries only: ${money(lo)}–${money(hi)}</div>
      <div class="add-grid">
        <button type="button" class="btn primary" data-act="trip-go">🛒 ${!t ? "Start wholesale trip" : t.p.open ? "Continue wholesale trip" : "Edit wholesale trip"}</button>
        <button type="button" class="btn" data-act="topup">+ Top-up (extra rice, atta…)</button>
        <button type="button" class="btn" data-act="quick">+ Veg, milk or other spend</button>
      </div>
    </section>

    ${list.length ? `<section class="card"><h2>Purchases</h2><ul class="list-plain">
      ${list.map(([id, p]) => `<li><div><div>${esc(KINDS[p.kind] || p.kind)}</div><div class="muted">${esc(purchaseSummary(p))}</div></div>
        <div class="row"><span class="amt">${money(purchaseTotal(p))}</span><button type="button" class="more-btn" data-act="purchase" data-id="${esc(id)}" aria-label="Edit purchase">⋯</button></div></li>`).join("")}
    </ul></section>` : ""}

    ${byItem.length ? `<section class="card"><h2>Spent by item</h2><ul class="list-plain">
      ${byItem.map((a) => `<li><div>${esc(a.name)}${a.topup ? ` <span class="tag">top-up</span>` : ""}${a.extra ? ` <span class="tag">not on list</span>` : ""}
        ${a.qtys.length ? `<div class="muted">${esc(a.qtys.join(" + "))}</div>` : ""}</div><span class="amt">${money(a.amount)}</span></li>`).join("")}
      ${unitemised ? `<li><div class="muted">Rest of the wholesale bill (not priced per item)</div><span class="amt">${money(unitemised)}</span></li>` : ""}
    </ul></section>` : ""}

    <section class="card"><h2>Monthly history</h2>
      ${withData.length ? `<p class="muted">Average over ${plural(withData.length, "month")}: <b>${money(avg)}</b></p>` : `<p class="muted">Each month's total shows up here once you log spends.</p>`}
      <div class="hist">${hist.map((h) => `
        <button type="button" data-act="goto-month" data-month="${h.k}" class="${h.k === ui.month ? "cur" : ""}">${esc(monthLabel(h.k, { month: "short", year: "2-digit" }))}</button>
        <div class="track"><span data-w="${Math.round((h.t / max) * 100)}"></span></div>
        <div class="amt">${h.t ? money(h.t) : "—"}</div>`).join("")}
      </div>
    </section>`;
}

function renderReview() {
  const m = M();
  const tops = topupsByItem();
  const applied = m.applied || {};
  const changes = monthlyItems()
    .map(([id, it]) => {
      const fb = effectiveFb(id, m, tops);
      return { id, it, fb, tops: tops[id] || [], done: applied[id], to: applied[id] ? null : suggestion(it, fb, tops[id]) };
    })
    .filter((c) => c.fb === "more" || c.fb === "less");
  const more = changes.filter((c) => c.fb === "more");
  const less = changes.filter((c) => c.fb === "less");

  // Things bought this month that aren't on the list.
  const extras = [];
  for (const [pid, p] of purchases()) {
    for (const l of Object.values(p.lines || {})) if (!l.item || !view.items[l.item]) extras.push({ pid, p, l });
  }
  const onList = new Set(activeItems().map(([, i]) => i.name.trim().toLowerCase()));
  // Extras bought in 2+ different months that still aren't on the list.
  const seen = {};
  for (const mo of Object.values(view.months)) {
    const names = new Set();
    for (const p of Object.values(mo.purchases || {})) for (const l of Object.values(p.lines || {})) if (!l.item && l.name) names.add(String(l.name).trim());
    for (const n of names) seen[n.toLowerCase()] = { name: n, count: (seen[n.toLowerCase()]?.count || 0) + 1 };
  }
  const frequent = Object.values(seen).filter((x) => x.count >= 2 && !onList.has(x.name.toLowerCase()));

  const changeLine = (c) => {
    const why = c.tops.length && !m.feedback?.[c.id] ? `<div class="muted">topped up ${esc(c.tops.map((l) => l.qty || "?").join(" + "))}</div>` : "";
    return c.done
      ? `<li><div>${esc(c.it.name)} <span class="tag">applied</span>${why}</div><span class="amt">${esc(fmtQty(scaled(c.it, c.done.from), c.it.unit))} → ${esc(fmtQty(scaled(c.it, c.done.to), c.it.unit))}</span></li>`
      : `<li><div>${esc(c.it.name)}${why}</div><span class="amt">${esc(qtyText(c.it))}${c.to ? ` → ${esc(fmtQty(scaled(c.it, c.to), c.it.unit))}` : ""}</span></li>`;
  };

  return `
    ${switcher("month")}
    <section class="card">
      <h2>How did ${esc(monthLabel(ui.month, { month: "long" }))} go?</h2>
      <p class="muted">Items you topped up count as "needed more". Mark anything else that ran out or was left over below, then apply the changes to next month's list.</p>
      ${more.length ? `<h3>↑ Needed more (${more.length})</h3><ul class="list-plain">${more.map(changeLine).join("")}</ul>` : ""}
      ${less.length ? `<h3>↓ Not needed as much (${less.length})</h3><ul class="list-plain">${less.map(changeLine).join("")}</ul>` : ""}
      ${!changes.length ? `<p class="muted">Nothing marked yet.</p>` : ""}
      ${m.appliedAt ? `<p class="muted">Applied to the list on ${esc(new Date(m.appliedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" }))}.</p>` : ""}
      <div class="sheet-actions"><button type="button" class="btn primary" data-act="apply" ${changes.some((c) => c.to) ? "" : "disabled"}>Apply to list…</button></div>
    </section>

    <section class="card">
      <h2>Bought extra (not on the list)</h2>
      ${extras.length ? `<ul class="list-plain">${extras.map(({ p, l }) => `<li><div>${esc(l.name)}${l.qty ? ` <span class="muted">· ${esc(l.qty)}</span>` : ""}
          <div class="muted">${esc(KINDS[p.kind])} · ${esc(dayLabel(p.date))}</div></div>
        <div class="row"><span class="amt">${l.amount ? money(l.amount) : ""}</span>${onList.has(String(l.name).trim().toLowerCase()) ? `<span class="tag">on list</span>` : `<button type="button" class="btn small" data-act="adopt" data-name="${esc(l.name)}" data-qty="${esc(l.qty || "")}">+ List</button>`}</div></li>`).join("")}</ul>`
        : `<p class="muted">Nothing yet. Anything you add in a top-up that isn't on the list shows up here.</p>`}
      ${frequent.length ? `<p class="muted">You keep buying these. Add them to the list?</p><div class="wrap-row">${frequent.map((f) => `<button type="button" class="chip" data-act="adopt" data-name="${esc(f.name)}">+ ${esc(f.name)}</button>`).join("")}</div>` : ""}
      <div class="sheet-actions"><button type="button" class="btn" data-act="topup">+ Log a top-up</button></div>
    </section>

    <section class="card">
      <h2>Notes</h2>
      <textarea data-notes aria-label="Notes for ${esc(monthLabel(ui.month))}" placeholder="e.g. Guests came for a week. Try a different oil brand.">${esc(m.notes || "")}</textarea>
    </section>

    ${catsOf("monthly").map(([cid, c]) => {
      const rows = itemsIn(cid);
      const marked = rows.filter(([id]) => effectiveFb(id, m, tops)).length;
      return `<details class="cat" data-cat="review-${esc(cid)}" ${ui.closed["review-" + cid] ? "" : "open"}>
        <summary>${esc(c.title)}<span class="count">${marked}/${rows.length} marked</span></summary>
        <ul class="items">${rows.map(([id, it]) => {
          const fb = effectiveFb(id, m, tops);
          return `<li class="review">
          <span class="name"><span class="nm">${esc(it.name)}</span><span class="note">${esc(qtyText(it))}${tops[id] && !m.feedback?.[id] ? " · topped up" : ""}</span></span>
          <div class="seg" role="group" aria-label="${esc(it.name)}">
            ${["more", "ok", "less"].map((v) => `<button type="button" class="${v}" data-act="fb" data-id="${esc(id)}" data-v="${v}" aria-pressed="${fb === v}" title="${FB[v].label}" aria-label="${FB[v].label}">${FB[v].icon}</button>`).join("")}
          </div></li>`;
        }).join("")}</ul>
      </details>`;
    }).join("")}`;
}

function gcalLink(ev) {
  const end = new Date(ev.start.getTime() + 60 * 60 * 1000);
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title,
    dates: `${icsDate(ev.start)}/${icsDate(end)}`,
    recur: `RRULE:${ev.rrule}`,
    details: `Open your list: ${location.origin}/`,
    ctz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

function renderSettings() {
  const s = view.settings;
  const [monthly, weekly] = reminderEvents(s);
  const when = (d) => d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  const archived = Object.entries(view.items).filter(([, i]) => i.archived).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return `
    <section class="card">
      <h2>Household</h2>
      <div class="row between"><span>People eating</span>${peopleStepper()}</div>
      <p class="muted">Monthly quantities scale with this. They were set for ${basePeople()} people.</p>
      <p class="muted">Tracking started in <b>${esc(monthLabel(startMonth()))}</b>.</p>
    </section>

    <section class="card">
      <h2>Shopping reminders</h2>
      <p class="muted">Reminders live in your phone's calendar, so they ring even when this app is closed.</p>
      <div class="settings-grid">
        <label>Monthly wholesale on day
          <select data-setting="monthlyDay" data-num>${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${s.monthlyDay == i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select>
        </label>
        <label>Weekly shopping on
          <select data-setting="weeklyDay" data-num>${WEEKDAYS.map((d, i) => `<option value="${i}" ${s.weeklyDay == i ? "selected" : ""}>${d}</option>`).join("")}</select>
        </label>
        <label>At
          <input type="time" data-setting="reminderTime" value="${esc(s.reminderTime || "10:00")}">
        </label>
      </div>
      <p class="muted">Next monthly: <b>${esc(when(monthly.start))}</b><br>Next weekly: <b>${esc(when(weekly.start))}</b></p>
      <div class="fields">
        <a class="btn primary" href="${esc(gcalLink(monthly))}" target="_blank" rel="noopener">📅 Add monthly reminder to Google Calendar</a>
        <a class="btn primary" href="${esc(gcalLink(weekly))}" target="_blank" rel="noopener">📅 Add weekly reminder to Google Calendar</a>
        <a class="btn" href="api/calendar" download>Download both as .ics (Samsung, Outlook, Apple)</a>
      </div>
      <p class="muted">If you change the day or time, delete the old events in your calendar and add them again.</p>
    </section>

    <section class="card">
      <h2>Your data</h2>
      <p class="muted">Saved on the Mac mini: <code>${esc(session?.where || "")}</code>.
        A dated copy is kept every day and nothing is ever deleted. Past months stay in history.</p>
      <div class="wrap-row">
        <a class="btn" href="api/export" download>⬇️ Download backup</a>
        <label class="btn">⬆️ Restore from backup<input type="file" id="importFile" accept="application/json,.json" hidden></label>
      </div>
      ${archived.length ? `<h3>Removed items</h3><ul class="list-plain">${archived.map(([id, it]) => `<li><span>${esc(it.name)}</span><button type="button" class="btn small" data-act="restore" data-id="${esc(id)}">Put back</button></li>`).join("")}</ul>` : ""}
    </section>

    <section class="card">
      <h2>Security</h2>
      ${session?.authRequired
        ? `<p class="muted">Locked with a PIN. This phone stays signed in for 180 days.</p><button type="button" class="btn" data-act="logout">Sign out on this phone</button>`
        : `<p class="muted">No PIN set, so anyone on your Wi-Fi can open this. Add <code>APP_PIN=…</code> to <code>.env</code> on the Mac mini and restart to lock it.</p>`}
    </section>`;
}

// ---------- sheets (dialogs) ----------
let sheetSubmit = null;
// Sheets add a history entry so the phone's back button closes the sheet, not the app.
let ignorePop = false;
let afterPop = null;
let closingFromPop = false;

function openSheet({ title, body, submit = "Save", onSubmit, extra = [] }) {
  $("#sheetTitle").textContent = title;
  $("#sheetBody").innerHTML = body;
  const more = $("#sheetExtra");
  more.innerHTML = "";
  more.hidden = !extra.length;
  for (const b of extra) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `btn ${b.cls || ""}`;
    el.textContent = b.label;
    el.onclick = () => { if (b.onClick() !== false) closeSheet(); };
    more.append(el);
  }
  $("#sheetSubmit").textContent = submit;
  sheetSubmit = onSubmit;
  $("#sheetScroll").scrollTop = 0;
  if (!$("#sheet").open) {
    $("#sheet").showModal();
    history.pushState({ ...(history.state || {}), sheet: true }, "");
  }
}
function closeSheet() {
  if ($("#sheet").open) $("#sheet").close();
  render();
}
// Opens another sheet once the current one (and its history entry) is gone.
const thenOpen = (fn) => () => { afterPop = fn; };

$("#sheet").addEventListener("close", () => {
  sheetSubmit = null;
  if (!closingFromPop && history.state?.sheet) {
    ignorePop = true;
    history.back();
  } else if (afterPop) {
    const fn = afterPop;
    afterPop = null;
    setTimeout(fn);
  }
  closingFromPop = false;
});
$("#sheetCancel").addEventListener("click", closeSheet);
// Tapping the dimmed area outside the sheet closes it.
$("#sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSheet(); });

window.addEventListener("popstate", (e) => {
  if (ignorePop) {
    ignorePop = false;
    if (afterPop) { const fn = afterPop; afterPop = null; fn(); }
    return;
  }
  if ($("#sheet").open) {
    closingFromPop = true;
    $("#sheet").close();
    render();
    return;
  }
  const tab = e.state?.tab;
  if (tab && tab !== ui.tab) { ui.tab = tab; saveUi(); render(); window.scrollTo(0, 0); }
});

const catOptions = (selected) =>
  Object.entries(view.categories).sort(byOrder)
    .map(([id, c]) => `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(c.title)}${c.freq === "weekly" ? " (weekly)" : ""}</option>`).join("");
const dateField = (value) => `<label>Date<input name="date" type="date" required value="${esc(value || dateKey())}"></label>`;
const shopField = (value) => `<label>Shop <span class="hint">optional</span><input name="shop" maxlength="60" value="${esc(value || "")}"></label>`;

function openItem(id, defaultCat) {
  const isNew = !id;
  const it = isNew ? { name: "", cat: defaultCat || "extras" } : view.items[id];
  const monthly = (view.categories[it.cat]?.freq || "monthly") === "monthly";
  const m = M();
  const shownQty = qtyText(it);
  const fbNow = m.feedback?.[id] || "";
  const bought = isNew ? [] : linesForItem(id);
  openSheet({
    title: isNew ? "Add item" : it.name,
    submit: isNew ? "Add" : "Save",
    body: `
      ${bought.length ? `<fieldset><legend>Bought for ${esc(monthLabel(ui.month))}</legend><ul class="list-plain">
        ${bought.map(({ p, l }) => `<li><span>${esc(KINDS[p.kind])} · ${esc(dayLabel(p.date))}${l.qty ? ` · ${esc(l.qty)}` : ""}</span><span class="amt">${l.amount != null ? money(l.amount) : "—"}</span></li>`).join("")}
      </ul></fieldset>` : ""}
      <label>Name<input name="name" required maxlength="60" value="${esc(it.name)}"></label>
      <label>List<select name="cat">${catOptions(it.cat)}</select></label>
      <label>Quantity <span class="hint">e.g. 2 kg, 500 g, 1 L, 6 pcs, or any text. ${people() !== basePeople() ? `For ${people()} people.` : ""}</span>
        <input name="qty" maxlength="30" value="${esc(shownQty)}" autocomplete="off"></label>
      <label>Note <span class="hint">optional, e.g. brand</span><input name="note" maxlength="60" value="${esc(it.note || "")}"></label>
      ${!isNew && monthly ? `<fieldset><legend>How was it in ${esc(monthLabel(ui.month, { month: "long" }))}?</legend>
        <div class="seg" role="radiogroup" aria-label="How much was needed">
          ${["more", "ok", "less"].map((v) => `<label><input type="radio" name="fb" value="${v}" ${fbNow === v ? "checked" : ""}><span>${FB[v].label}</span></label>`).join("")}
        </div>
        ${fbNow ? `<label class="check"><input type="checkbox" name="fbClear" value="1"> Clear this mark</label>` : ""}
      </fieldset>` : ""}`,
    extra: isNew ? [] : [
      ...(monthly ? [{ label: "Bought more…", onClick: thenOpen(() => openTopup(null, id)) }] : []),
      {
        label: "Remove",
        cls: "danger",
        onClick: () => {
          if (!confirm(`Remove "${it.name}" from the list? You can put it back from Settings.`)) return false;
          change([{ p: ["items", id, "archived"], v: true }]);
        },
      },
    ],
    onSubmit: (f) => {
      const name = f.name.trim();
      if (!name) return false;
      const itemId = id || newId("i");
      const ops = [];
      if (isNew) ops.push({ p: ["items", itemId], v: { name, cat: f.cat, order: nextOrder() } });
      else {
        if (name !== it.name) ops.push({ p: ["items", itemId, "name"], v: name });
        if (f.cat !== it.cat) ops.push({ p: ["items", itemId, "cat"], v: f.cat });
      }
      const note = f.note.trim();
      if (note) ops.push({ p: ["items", itemId, "note"], v: note });
      else if (it.note) ops.push({ p: ["items", itemId, "note"], d: 1 });
      if (isNew || f.qty.trim() !== shownQty) {
        const q = parseQty(f.qty, it.unit);
        if (q.qty != null) {
          ops.push({ p: ["items", itemId, "qty"], v: toStored(q.qty) }, { p: ["items", itemId, "unit"], v: q.unit });
          if (!isNew) ops.push({ p: ["items", itemId, "text"], d: 1 });
        } else {
          if (!isNew) ops.push({ p: ["items", itemId, "qty"], d: 1 }, { p: ["items", itemId, "unit"], d: 1 });
          if (q.text) ops.push({ p: ["items", itemId, "text"], v: q.text });
          else if (!isNew) ops.push({ p: ["items", itemId, "text"], d: 1 });
        }
      }
      if (!isNew && monthly) {
        if (f.fbClear) ops.push({ p: ["months", ui.month, "feedback", itemId], d: 1 });
        else if (f.fb && f.fb !== fbNow) ops.push({ p: ["months", ui.month, "feedback", itemId], v: f.fb });
      }
      if (ops.length) change(ops);
    },
  });
}

function startTrip() {
  const pid = newId("p");
  change([{ p: ["months", ui.month, "purchases", pid], v: { kind: "wholesale", date: dateKey(), open: true } }]);
  toast("Trip started. Tick items and type prices as you go.");
}

// Finish (or edit) the month's wholesale trip: bill total, date, shop.
function openTrip() {
  const t = trip();
  if (!t) return;
  const m = M();
  const ids = monthlyItems().map(([id]) => id);
  const ticked = ids.filter((id) => m.checked?.[id]).length;
  const nLines = Object.keys(t.p.lines || {}).length;
  const priced = lineTotal(t.p);
  const path = ["months", ui.month, "purchases", t.id];
  openSheet({
    title: t.p.open ? "Finish wholesale trip" : "Wholesale trip",
    submit: t.p.open ? "Finish trip" : "Save",
    body: `
      <p class="muted">Ticked ${ticked} of ${ids.length} items. ${nLines ? `Priced ${plural(nLines, "item")}: <b>${money(priced)}</b>.` : "No item prices entered."}</p>
      <label>Bill total (₹) <span class="hint">${nLines ? `leave empty to use the item prices (${money(priced)})` : "what you paid altogether"}</span>
        <input name="total" type="number" min="0" step="any" inputmode="decimal" value="${esc(t.p.total ?? "")}" ${nLines ? "" : "required"}></label>
      ${dateField(t.p.date)}
      ${shopField(t.p.shop)}`,
    extra: [
      ...(t.p.open ? [] : [{ label: "Edit item prices", onClick: () => { change([{ p: [...path, "open"], v: true }]); ui.tab = "list"; ui.mode = "monthly"; saveUi(); } }]),
      {
        label: "Delete trip",
        cls: "danger",
        onClick: () => {
          if (!confirm("Delete this wholesale trip and its prices? Your ticks stay.")) return false;
          change([{ p: path, d: 1 }]);
        },
      },
    ],
    onSubmit: (f) => {
      const ops = [
        { p: [...path, "date"], v: f.date },
        f.total === "" ? { p: [...path, "total"], d: 1 } : { p: [...path, "total"], v: Number(f.total) },
        f.shop.trim() ? { p: [...path, "shop"], v: f.shop.trim() } : { p: [...path, "shop"], d: 1 },
        { p: [...path, "open"], d: 1 },
      ];
      change(ops);
      toast(`Wholesale trip saved: ${money(f.total === "" ? priced : Number(f.total))}.`);
    },
  });
}

function lineRow(l = {}) {
  return `<div class="line-row">
    <input name="lname" list="itemNames" placeholder="Item" maxlength="60" value="${esc(l.name || "")}" aria-label="Item" autocomplete="off">
    <input name="lqty" placeholder="Qty" maxlength="20" value="${esc(l.qty || "")}" aria-label="Quantity" autocomplete="off">
    <input name="lamt" type="number" min="0" step="any" inputmode="decimal" placeholder="₹" value="${esc(l.amount ?? "")}" aria-label="Amount">
    <button type="button" class="icon-btn" data-line-del aria-label="Remove this line">✕</button>
  </div>`;
}
function updateLinesTotal() {
  const el = $("#linesTotal");
  if (el) el.textContent = money(sum([...document.querySelectorAll('#sheet input[name="lamt"]')].map((i) => i.value)));
}

// A top-up: one or more items bought during the month, outside the wholesale trip.
function openTopup(pid, presetItem) {
  const p = pid ? M().purchases[pid] : { kind: "topup", date: dateKey() };
  const lines = Object.values(p.lines || {});
  if (!lines.length) lines.push(presetItem ? { name: view.items[presetItem].name } : {});
  openSheet({
    title: pid ? "Edit top-up" : "Top-up purchase",
    submit: pid ? "Save" : "Add",
    body: `
      <p class="muted">Bought extra rice, atta or anything else this month? Add each item and what it cost. Items from your list count as "needed more" in Review.</p>
      ${dateField(p.date)}
      ${shopField(p.shop)}
      <div class="lines-head"><span>Item</span><span>Qty</span><span>₹</span><span></span></div>
      <div id="lines">${lines.map(lineRow).join("")}</div>
      <button type="button" class="link" data-line-add>+ Add another item</button>
      <div class="row between"><span class="muted">Total</span><b id="linesTotal">${money(lineTotal(p))}</b></div>
      <datalist id="itemNames">${activeItems().sort(byOrder).map(([, i]) => `<option value="${esc(i.name)}"></option>`).join("")}</datalist>`,
    extra: pid ? [{
      label: "Delete",
      cls: "danger",
      onClick: () => {
        if (!confirm("Delete this top-up?")) return false;
        change([{ p: ["months", ui.month, "purchases", pid], d: 1 }]);
      },
    }] : [],
    onSubmit: (f, fd) => {
      const names = fd.getAll("lname");
      const qtys = fd.getAll("lqty");
      const amts = fd.getAll("lamt");
      const out = {};
      names.forEach((raw, i) => {
        const name = String(raw).trim();
        if (!name) return;
        const itemId = findItemByName(name);
        const line = { name: itemId ? view.items[itemId].name : name };
        if (itemId) line.item = itemId;
        if (String(qtys[i]).trim()) line.qty = String(qtys[i]).trim();
        if (amts[i] !== "" && Number(amts[i]) >= 0) line.amount = Number(amts[i]);
        out[newId("l")] = line;
      });
      if (!Object.keys(out).length) { toast("Add at least one item."); return false; }
      const purchase = { kind: "topup", date: f.date, lines: out };
      if (f.shop.trim()) purchase.shop = f.shop.trim();
      change([{ p: ["months", ui.month, "purchases", pid || newId("p")], v: purchase }]);
      toast(`Top-up saved: ${money(lineTotal(purchase))}.`);
    },
  });
}

// A single-amount spend: weekly veg, milk, chicken, other.
function openQuick(pid, month = ui.month) {
  const p = pid ? M(month).purchases[pid] : { kind: "fresh", date: dateKey() };
  openSheet({
    title: pid ? "Edit spend" : "Log a spend",
    submit: pid ? "Save" : "Add",
    body: `
      <label>Amount (₹)<input name="total" type="number" min="0" step="any" inputmode="decimal" required value="${esc(p.total ?? "")}"></label>
      <label>For<select name="kind">${QUICK_KINDS.map((k) => `<option value="${k}" ${p.kind === k ? "selected" : ""}>${esc(KINDS[k])}</option>`).join("")}</select></label>
      ${dateField(p.date)}
      <label>Note <span class="hint">optional, e.g. shop name</span><input name="shop" maxlength="60" value="${esc(p.shop || "")}"></label>`,
    extra: pid ? [{
      label: "Delete",
      cls: "danger",
      onClick: () => {
        if (!confirm("Delete this spend?")) return false;
        change([{ p: ["months", month, "purchases", pid], d: 1 }]);
      },
    }] : [],
    onSubmit: (f) => {
      const total = Number(f.total);
      if (!(total >= 0)) return false;
      const purchase = { kind: f.kind, date: f.date, total };
      if (f.shop.trim()) purchase.shop = f.shop.trim();
      change([{ p: ["months", month, "purchases", pid || newId("p")], v: purchase }]);
      if (month !== ui.month) toast(`Saved under ${monthLabel(month)}.`);
    },
  });
}

function openPurchase(pid) {
  const p = M().purchases?.[pid];
  if (!p) return;
  if (p.kind === "wholesale") openTrip();
  else if (p.kind === "topup") openTopup(pid);
  else openQuick(pid);
}

function openApply() {
  const m = M();
  const tops = topupsByItem();
  // Items already applied this month are skipped, so applying twice can't compound the change.
  const changes = monthlyItems()
    .filter(([id]) => !m.applied?.[id])
    .map(([id, it]) => ({ id, it, to: suggestion(it, effectiveFb(id, m, tops), tops[id]) }))
    .filter((c) => c.to);
  openSheet({
    title: "Update next month's list",
    submit: "Apply",
    body: `<p class="muted">Topped-up items go up by the amount you bought extra. Other items that ran out go up about 25%, and leftovers go down about 25%. Untick anything you want to keep as it is.</p>
      <ul class="changes">${changes.map((c) => `<li><label><input type="checkbox" name="apply" value="${esc(c.id)}" checked>
        <span>${esc(c.it.name)}: ${esc(qtyText(c.it))} → <b>${esc(fmtQty(scaled(c.it, c.to), c.it.unit))}</b></span></label></li>`).join("")}</ul>`,
    onSubmit: (f, fd) => {
      const picked = new Set(fd.getAll("apply"));
      const chosen = changes.filter((c) => picked.has(c.id));
      if (!chosen.length) return;
      const ops = chosen.flatMap((c) => [
        { p: ["items", c.id, "qty"], v: c.to },
        { p: ["months", ui.month, "applied", c.id], v: { from: c.it.qty, to: c.to } },
      ]);
      ops.push({ p: ["months", ui.month, "appliedAt"], v: new Date().toISOString() });
      change(ops);
      toast(`Updated ${plural(chosen.length, "item")}.`);
    },
  });
}

$("#sheetForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!e.target.reportValidity()) return;
  const fd = new FormData(e.target);
  if (sheetSubmit?.(Object.fromEntries(fd), fd) !== false) closeSheet();
});
// Top-up line rows: add, remove, running total.
$("#sheetBody").addEventListener("click", (e) => {
  if (e.target.closest("[data-line-add]")) {
    $("#lines").insertAdjacentHTML("beforeend", lineRow());
    $("#lines").lastElementChild.querySelector("input").focus();
  } else if (e.target.closest("[data-line-del]")) {
    const rows = $("#lines").children;
    if (rows.length > 1) e.target.closest(".line-row").remove();
    else rows[0].querySelectorAll("input").forEach((i) => (i.value = ""));
    updateLinesTotal();
  }
});
$("#sheetBody").addEventListener("input", (e) => { if (e.target.name === "lamt") updateLinesTotal(); });

// ---------- events ----------
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act],[data-tab]");
  if (!el || el.closest("#sheet")) return;
  if (el.dataset.tab) {
    if (el.dataset.tab === ui.tab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    ui.tab = el.dataset.tab;
    history.pushState({ tab: ui.tab }, "");
    saveUi();
    render();
    window.scrollTo(0, 0);
    return;
  }
  const { act, id } = el.dataset;
  const delta = Number(el.dataset.delta);
  switch (act) {
    case "mode": ui.mode = el.dataset.mode; saveUi(); render(); break;
    case "month": ui.month = clampMonth(shiftMonth(ui.month, delta)); render(); break;
    case "month-now": ui.month = homeMonth(); render(); break;
    case "week": ui.week = clampWeek(shiftWeek(ui.week, delta)); render(); break;
    case "week-now": ui.week = homeWeek(); render(); break;
    case "goto-month": ui.month = el.dataset.month; render(); break;
    case "people": change([{ p: ["settings", "people"], v: Math.min(20, Math.max(1, people() + delta)) }]); break;
    case "item": openItem(id); break;
    case "add-item": openItem(null, el.dataset.cat); break;
    case "trip-start": startTrip(); break;
    case "trip-finish": openTrip(); break;
    case "trip-go": {
      const t = trip();
      if (t && !t.p.open) { openTrip(); break; }
      if (!t) startTrip();
      ui.tab = "list";
      ui.mode = "monthly";
      saveUi();
      render();
      window.scrollTo(0, 0);
      break;
    }
    case "topup": openTopup(null); break;
    case "quick": openQuick(null, el.dataset.month || ui.month); break;
    case "purchase": openPurchase(id); break;
    case "apply": openApply(); break;
    case "fb": {
      const cur = M().feedback?.[id];
      const path = ["months", ui.month, "feedback", id];
      change([cur === el.dataset.v ? { p: path, d: 1 } : { p: path, v: el.dataset.v }]);
      break;
    }
    case "adopt": {
      const item = { name: el.dataset.name, cat: "extras", order: nextOrder() };
      const q = parseQty(el.dataset.qty || "");
      if (q.qty != null) Object.assign(item, { qty: toStored(q.qty), unit: q.unit });
      change([{ p: ["items", newId("i")], v: item }]);
      toast(`Added ${el.dataset.name} to Extras & household.`);
      break;
    }
    case "restore": change([{ p: ["items", id, "archived"], d: 1 }]); break;
    case "share": shareList(); break;
    case "logout": logout(); break;
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.closest("#sheet")) return;
  if (t.dataset.check) {
    if (t.checked) navigator.vibrate?.(10);
    const path = [...(t.dataset.scope === "week" ? ["weeks", ui.week] : ["months", ui.month]), "checked", t.dataset.check];
    change([t.checked ? { p: path, v: true } : { p: path, d: 1 }]);
  } else if (t.dataset.price) {
    savePrice(t);
  } else if (t.dataset.setting) {
    const v = "num" in t.dataset ? Number(t.value) : t.value;
    if (v !== "") change([{ p: ["settings", t.dataset.setting], v }]);
  } else if (t.id === "importFile" && t.files[0]) {
    importBackup(t.files[0]);
    t.value = "";
  }
});

// Price typed during a wholesale trip. Entering a price also ticks the item.
// The row is patched in place, so moving to the next price box keeps the keyboard open.
function savePrice(input) {
  const t = trip();
  if (!t) return;
  const id = input.dataset.price;
  const it = view.items[id];
  const path = ["months", ui.month, "purchases", t.id, "lines", id];
  const v = input.value === "" ? null : Number(input.value);
  const ops = [v == null || !(v >= 0) ? { p: path, d: 1 } : { p: path, v: { item: id, name: it.name, qty: qtyText(it), amount: v } }];
  const li = input.closest("li");
  if (v != null && !M().checked?.[id]) {
    ops.push({ p: ["months", ui.month, "checked", id], v: true });
    li.classList.add("done");
    li.querySelector('input[type="checkbox"]').checked = true;
  }
  change(ops, { rerender: false });
  const total = $("#tripTotal");
  if (total) total.textContent = money(lineTotal(trip().p));
}

// Enter on a price box moves to the next one instead of submitting.
document.addEventListener("submit", (e) => { if (e.target.id === "tripForm") e.preventDefault(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.dataset?.price) return;
  e.preventDefault();
  const boxes = [...document.querySelectorAll("input[data-price]")];
  const next = boxes[boxes.indexOf(e.target) + 1];
  if (next) next.focus(); else e.target.blur();
});
// Once you leave the price column, refresh counts and totals that were patched in place.
document.addEventListener("focusout", (e) => {
  if (e.target.dataset?.price) setTimeout(() => { if (!typingInMain() && !$("#sheet").open) render(); });
});

let notesTimer;
document.addEventListener("input", (e) => {
  if (!e.target.matches("[data-notes]")) return;
  const value = e.target.value;
  const month = ui.month;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => change([{ p: ["months", month, "notes"], v: value }], { rerender: false }), 600);
});

// <details> toggle events don't bubble, so listen in the capture phase.
document.addEventListener("toggle", (e) => {
  if (e.target.matches?.("details.cat")) { ui.closed[e.target.dataset.cat] = !e.target.open; saveUi(); }
}, true);

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast("That file isn't valid JSON.");
  }
  const when = data.updatedAt ? new Date(data.updatedAt).toLocaleString("en-IN") : "unknown date";
  if (!confirm(`Replace everything with this backup (saved ${when})? A copy of the current data is kept first.`)) return;
  try {
    const r = await api("POST", "api/import", { data });
    server = { rev: r.rev, data: r.data };
    pending = [];
    recompute();
    saveCache();
    render();
    toast("Backup restored.");
  } catch (e) {
    toast(`Restore failed: ${e.message}`);
  }
}

async function logout() {
  await api("POST", "api/logout").catch(() => {});
  try { localStorage.removeItem(CACHE_KEY); } catch {}
  location.reload();
}

// The items not yet ticked, as plain text for WhatsApp or anywhere else.
function listText() {
  const monthly = ui.mode === "monthly";
  const checked = (monthly ? M() : W()).checked || {};
  const lines = [`🧺 ${monthly ? monthLabel(ui.month) + " ration" : weekLabel(ui.week) + " fresh"} list`];
  for (const [cid, c] of catsOf(monthly ? "monthly" : "weekly")) {
    const left = itemsIn(cid).filter(([id]) => !checked[id]);
    if (!left.length) continue;
    lines.push("", `*${c.title}*`);
    for (const [, it] of left) lines.push(`• ${it.name}${qtyText(it) ? ` – ${qtyText(it)}` : ""}`);
  }
  if (lines.length === 1) lines.push("", "All picked ✅");
  return lines.join("\n");
}

async function shareList() {
  const text = listText();
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return toast("List copied. Paste it in WhatsApp."); } catch {}
  }
  // Plain-HTTP pages can't use the share sheet or clipboard API, so copy the old way.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.className = "offscreen";
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  toast(ok ? "List copied. Paste it in WhatsApp." : "Couldn't copy the list.");
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- login & start ----------
function showLogin() {
  $("#login").hidden = false;
  $("#pin").focus();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginErr").textContent = "";
  try {
    await api("POST", "api/login", { pin: $("#pin").value });
    $("#pin").value = "";
    $("#login").hidden = true;
    session = await api("GET", "api/session");
    await loadFromServer();
  } catch (err) {
    $("#loginErr").textContent = err.message || "Couldn't sign in";
  }
});

function showFatal(msg) {
  $("#fatalMsg").textContent = msg;
  $("#fatal").hidden = false;
}

async function loadFromServer() {
  if (pending.length) await push();
  await pull();
  if (!server) return showFatal("Couldn't load your list from the server.");
  render();
  openShortcut();
  startPolling();
}

// Home-screen shortcuts (long-press the app icon) open with ?go=topup or ?go=spend.
function openShortcut() {
  const go = new URLSearchParams(location.search).get("go");
  if (!go) return;
  history.replaceState({ tab: ui.tab }, "", location.pathname);
  if (go === "spend") { ui.tab = "spend"; render(); }
  if (go === "topup") { ui.tab = "list"; ui.mode = "monthly"; render(); openTopup(null); }
}

async function boot() {
  history.replaceState({ tab: ui.tab }, "");
  // Lets the app open with no signal (e.g. at the market). Browsers allow this on HTTPS only.
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
  loadCache();
  if (view) render();
  try {
    session = await api("GET", "api/session");
  } catch {
    setSync("offline");
    if (!view) showFatal("Can't reach the Mac mini. Are you on the home Wi-Fi (or Tailscale)?");
    return startPolling();
  }
  if (session.setupError) return showFatal(session.setupError);
  if (session.authRequired && !session.authed) return showLogin();
  await loadFromServer();
}

boot();
