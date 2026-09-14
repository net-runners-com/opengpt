// Pure-Node HTTP layer for the Bearer-only backend-api endpoints.
// Falls back to the browser profile's network stack when Cloudflare blocks
// the Node client (TLS/JA3 fingerprint), so the same call works either way.
import { BASE, CLIENT_HEADERS } from "./config.mjs";
import { cookieHeader, isExpired, refresh, loadAuth } from "./auth.mjs";
import { openEphemeral } from "./browser.mjs";

// Auth headers for a hand-rolled fetch (binary downloads, streaming endpoints)
// where api() below is the wrong shape. Refreshes an expired bearer first.
export async function authHeaders(account, { via = "auto", extra } = {}) {
  let auth = loadAuth(account);
  if (isExpired(auth)) {
    await refresh(account, { via: via === "node" ? "node" : "auto" });
    auth = loadAuth(account);
  }
  return headersFor(auth, extra);
}

function headersFor(auth, extra = {}) {
  return {
    ...CLIENT_HEADERS,
    authorization: `Bearer ${auth.accessToken}`,
    cookie: cookieHeader(auth),
    "user-agent": auth.userAgent || "Mozilla/5.0",
    ...extra,
  };
}

// Cloudflare block detection: an HTML challenge page, or a non-JSON 403.
//
// A JSON 403/429 is the API itself refusing — {"detail":"Too many requests"},
// "Unusual activity" — and a browser retry gets the same answer. Treating 429
// as a block launched a whole second browser per rate-limited poll (measured
// 2026-09-13: 15 launches in one daemon run, every one still 429).
function looksBlocked(status, body) {
  if (typeof body === "string" && /Just a moment|cf-chl|challenge-platform|Attention Required/i.test(body)) return true;
  if (status === 403 && typeof body === "string" && !/^\s*[{[]/.test(body)) return true;
  return false;
}

async function nodeRequest(auth, method, path, { json, headers } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: headersFor(auth, { ...(json ? { "content-type": "application/json" } : {}), ...headers }),
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await r.text();
  return { status: r.status, text, blocked: looksBlocked(r.status, text) };
}

async function browserRequest(auth, method, path, { json, headers } = {}) {
  const context = await openEphemeral(auth, {});
  try {
    const opts = { method, headers: headersFor(auth, headers), timeout: 60000 };
    if (json) { opts.data = json; }
    // .fetch() rather than .get()/.post() so PATCH and DELETE fall back too.
    const res = await context.request.fetch(`${BASE}${path}`, opts);
    return { status: res.status(), text: await res.text(), blocked: false };
  } finally {
    await context.close().catch(() => {});
  }
}

// Main entry: ensure a fresh token, run the request, auto-fallback to browser.
export async function api(account, method, path, { json, headers, via = "auto", raw = false } = {}) {
  let auth = loadAuth(account);
  if (isExpired(auth)) {
    await refresh(account, { via: via === "node" ? "node" : "auto" });
    auth = loadAuth(account);
  }
  let res;
  if (via === "browser") {
    res = await browserRequest(auth, method, path, { json, headers });
  } else {
    res = await nodeRequest(auth, method, path, { json, headers });
    if (res.blocked && via === "auto") {
      if (process.env.OPENGPT_DEBUG) process.stderr.write(`[dbg] ${method} ${path} → ${res.status} over node; launching a browser to retry\n`);
      res = await browserRequest(auth, method, path, { json, headers });
    }
  }
  if (res.status >= 400) {
    const snippet = res.text.slice(0, 300);
    throw new Error(`${method} ${path} → ${res.status}${res.blocked ? " (blocked)" : ""}: ${snippet}`);
  }
  if (raw) return res.text;
  try { return JSON.parse(res.text); } catch { return res.text; }
}
