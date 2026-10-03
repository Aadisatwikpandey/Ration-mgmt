// Shared by the browser and the server. A change is a list of ops, each setting or
// removing one value at a path, e.g. { p: ["months", "2026-10", "checked", "atta"], v: true }.
// Field-level ops let two phones edit at once without overwriting each other.

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const BANNED = new Set(["__proto__", "prototype", "constructor"]);
const ROOTS = new Set(["settings", "categories", "items", "months", "weeks"]);
const MAX_DEPTH = 6;

export function validOp(op) {
  if (!op || typeof op !== "object" || !Array.isArray(op.p)) return false;
  if (op.p.length < 2 || op.p.length > MAX_DEPTH || !ROOTS.has(op.p[0])) return false;
  if (!op.p.every((s) => typeof s === "string" && SEGMENT.test(s) && !BANNED.has(s))) return false;
  return op.d === 1 || (op.d === undefined && "v" in op && op.v !== undefined);
}

export function applyOps(data, ops) {
  for (const op of ops) {
    if (!validOp(op)) throw new Error("invalid op: " + JSON.stringify(op).slice(0, 200));
    let node = data;
    for (const key of op.p.slice(0, -1)) {
      const next = Object.hasOwn(node, key) ? node[key] : undefined;
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        if (op.d) { node = null; break; }
        node[key] = {};
      }
      node = node[key];
    }
    if (!node) continue;
    const last = op.p[op.p.length - 1];
    if (op.d) delete node[last];
    else node[last] = op.v === null || typeof op.v !== "object" ? op.v : JSON.parse(JSON.stringify(op.v));
  }
  return data;
}

export function newId(prefix = "i") {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
