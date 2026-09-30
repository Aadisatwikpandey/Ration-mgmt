// Mac mini storage: one JSON file plus a dated copy per day in backups/. Nothing is ever deleted.
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { defaultData, looksLikeData } from "./defaults.js";

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time

export function fileStore(dir) {
  const file = path.join(dir, "data.json");
  const backupDir = path.join(dir, "backups");
  let lastBackupDay = null;
  let queue = Promise.resolve();

  // One read-modify-write at a time, so concurrent requests can't interleave.
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function read() {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    // A damaged file throws here instead of being replaced, so it can still be recovered by hand.
    const data = JSON.parse(text);
    if (!looksLikeData(data)) throw new Error(`${file} is not ration data; refusing to overwrite it`);
    return data;
  }

  async function write(target, data) {
    const tmp = `${target}.${process.pid}.tmp`;
    const fh = await fs.open(tmp, "w", 0o600);
    try {
      await fh.writeFile(JSON.stringify(data, null, 1));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, target);
  }

  async function backupOncePerDay() {
    const day = today();
    if (lastBackupDay === day) return;
    try {
      await fs.copyFile(file, path.join(backupDir, `data-${day}.json`), constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    lastBackupDay = day;
  }

  return {
    kind: "file",
    where: file,

    async init() {
      await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
      if (!(await read())) await write(file, { ...defaultData(), updatedAt: new Date().toISOString() });
    },

    get: () => serial(read),

    // fn receives the current data and returns the new data.
    update: (fn) => serial(async () => {
      const current = await read();
      if (!current) throw new Error("data file missing");
      await backupOncePerDay();
      const next = fn(structuredClone(current));
      next.rev = (current.rev || 0) + 1;
      next.updatedAt = new Date().toISOString();
      await write(file, next);
      return next;
    }),

    // Keeps a named copy of the current data, e.g. before an import replaces it.
    snapshot: (label) => serial(async () => {
      const current = await read();
      if (current) await write(path.join(backupDir, `${label}-${Date.now()}.json`), current);
    }),
  };
}
