// Vercel entry: the same API as the Mac mini, storing data in a private Vercel Blob store.
// Every file in api/ re-exports this handler.
import { createApi } from "./api.js";
import { makeAuth } from "./auth.js";
import { blobStore } from "./store-blob.js";

const pin = process.env.APP_PIN || "";
const secret = process.env.SESSION_SECRET || "";

// A public site must be locked, so refuse to serve data until it's configured safely.
const setupError =
  !pin ? "Set APP_PIN in the Vercel project's environment variables, then redeploy."
  : pin.length < 8 ? "APP_PIN must be at least 8 characters on a public site."
  : secret.length < 32 ? "Set SESSION_SECRET (32+ random characters) in the Vercel environment variables."
  : undefined;

let ready = null;
function getApi() {
  ready ??= (async () => {
    const store = blobStore();
    if (!setupError) await store.init();
    // Poll and save less often than on the Mac mini to stay well inside the free Blob limits.
    return createApi({ store, auth: makeAuth({ pin, secret }), pollMs: 60000, saveDelayMs: 2500, setupError });
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

export default async function handler(req, res) {
  try {
    const api = await getApi();
    return api(req, res);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "storage unavailable" }));
  }
}
