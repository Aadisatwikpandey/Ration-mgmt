// Vercel storage: the same JSON kept in a *private* Vercel Blob store (reads need auth),
// with a dated copy per day under ration/backups/. This code never calls del().
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { defaultData, looksLikeData } from "./defaults.js";

const DATA_PATH = "ration/data.json";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ || "Asia/Kolkata" });

async function read() {
  let result;
  try {
    // useCache:false reads from origin so we always see the latest write.
    result = await get(DATA_PATH, { access: "private", useCache: false });
  } catch (e) {
    if (e?.name === "BlobNotFoundError") return null;
    throw e;
  }
  if (!result || result.statusCode !== 200) return null;
  const data = JSON.parse(await new Response(result.stream).text());
  if (!looksLikeData(data)) throw new Error("stored blob is not ration data; refusing to overwrite it");
  return { data, etag: result.blob.etag };
}

const save = (pathname, data, opts = {}) =>
  put(pathname, JSON.stringify(data), {
    access: "private",
    addRandomSuffix: false,
    contentType: "application/json",
    ...opts,
  });

export function blobStore() {
  return {
    kind: "blob",
    where: `Vercel Blob (private): ${DATA_PATH}`,

    async init() {
      if (await read()) return;
      try {
        // No allowOverwrite: if another instance created it first, this throws and we keep theirs.
        await save(DATA_PATH, { ...defaultData(), updatedAt: new Date().toISOString() });
      } catch (e) {
        if (!(await read())) throw e;
      }
    },

    async get() {
      return (await read())?.data ?? null;
    },

    async update(fn) {
      for (let attempt = 0; attempt < 10; attempt++) {
        // Random backoff so simultaneous saves spread out instead of retrying in lockstep.
        if (attempt) await new Promise((r) => setTimeout(r, Math.random() * 60 * 2 ** Math.min(attempt, 5)));
        const current = await read();
        if (!current) throw new Error("data blob missing");
        const day = today();
        if (current.data.lastBackupDay !== day) {
          try {
            await save(`ration/backups/data-${day}.json`, current.data);
          } catch {
            // Already backed up today by another request; fine.
          }
        }
        const next = fn(structuredClone(current.data));
        next.rev = (current.data.rev || 0) + 1;
        next.updatedAt = new Date().toISOString();
        next.lastBackupDay = day;
        try {
          // ifMatch: only succeeds if nobody else wrote since we read. Otherwise retry on fresh data.
          await save(DATA_PATH, next, { allowOverwrite: true, ifMatch: current.etag });
          return next;
        } catch (e) {
          if (!(e instanceof BlobPreconditionFailedError)) throw e;
        }
      }
      // 503 tells the page to keep the edit and retry; nothing is lost.
      throw Object.assign(new Error("busy saving, will retry"), { status: 503 });
    },

    async snapshot(label) {
      const current = await read();
      if (current) await save(`ration/backups/${label}-${Date.now()}.json`, current.data);
    },
  };
}
