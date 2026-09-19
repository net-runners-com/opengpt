// Pure-Node HTTP layer for the Bearer-only backend-api endpoints.
// Falls back to the browser profile's network stack when Cloudflare blocks
// the Node client (TLS/JA3 fingerprint), so the same call works either way.
import { BASE, CLIENT_HEADERS } from "./config.mjs";
import { cookieHeader, isExpired, refresh, loadAuth, authExpiredError } from "./auth.mjs";
import { openEphemeral } from "./browser.mjs";

// Auth headers for a hand-rolled fetch (binary downloads, streaming endpoints)
// where api() below is the wrong shape. Refreshes an expired bearer first.
export async function authHeaders(account, { via = "auto", extra } = {}) {
  return headersFor(await ensureAuth(account, { via }), extra);
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

// Make sure the saved bearer is live, re-minting it when it is past its expiry.
// Throws AUTH_EXPIRED when it cannot be re-minted, so a caller finds out now
// rather than after a browser launch and a timeout.
export async function ensureAuth(account, { via = "auto" } = {}) {
  let auth = loadAuth(account);
  if (!isExpired(auth)) return auth;
  try {
    await refresh(account, { via: via === "node" ? "node" : "auto" });
  } catch (e) {
    throw authExpiredError(account, `refresh failed: ${e.message}`);
  }
  auth = loadAuth(account);
  if (isExpired(auth)) throw authExpiredError(account, "refresh returned an already-expired bearer");
  return auth;
}

// Main entry: ensure a fresh token, run the request, auto-fallback to browser.
export async function api(account, method, path, { json, headers, via = "auto", raw = false } = {}) {
  let auth = await ensureAuth(account, { via });
  const run = async () => {
    if (via === "browser") return browserRequest(auth, method, path, { json, headers });
    let r = await nodeRequest(auth, method, path, { json, headers });
    if (r.blocked && via === "auto") {
      if (process.env.OPENGPT_DEBUG) process.stderr.write(`[dbg] ${method} ${path} → ${r.status} over node; launching a browser to retry\n`);
      r = await browserRequest(auth, method, path, { json, headers });
    }
    return r;
  };
  let res = await run();
  // 401 on a bearer that looked unexpired (revoked, or signed out elsewhere):
  // re-mint once and retry; a second 401 means the session itself is gone.
  if (res.status === 401) {
    try {
      await refresh(account, { via: via === "node" ? "node" : "auto" });
    } catch (e) {
      throw authExpiredError(account, `401 from ${path}, refresh failed: ${e.message}`);
    }
    auth = loadAuth(account);
    res = await run();
    if (res.status === 401) throw authExpiredError(account, `401 from ${path} even after refresh: ${res.text.slice(0, 120)}`);
  }
  if (res.status >= 400) {
    const snippet = res.text.slice(0, 300);
    throw new Error(`${method} ${path} → ${res.status}${res.blocked ? " (blocked)" : ""}: ${snippet}`);
  }
  if (raw) return res.text;
  try { return JSON.parse(res.text); } catch { return res.text; }
}
