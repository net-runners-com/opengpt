// Auth as a feature: log in once via a browser profile, persist the cookies +
// bearer, and reuse them for pure-HTTP API calls afterwards.
import fs from "node:fs";
import path from "node:path";
import { AUTH_DIR, BASE, ensureAuthDir, resolveProfile } from "./config.mjs";
import { withContext, profileBusy } from "./browser.mjs";

const authPath = (account) => path.join(AUTH_DIR, `${account}.json`);

export function loadAuth(account) {
  const p = authPath(account);
  if (!fs.existsSync(p)) throw new Error(`no saved auth for "${account}". Run: opengpt login --profile <name> --account ${account}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveAuth(account, data) {
  ensureAuthDir();
  fs.writeFileSync(authPath(account), JSON.stringify(data, null, 2));
  try { fs.chmodSync(authPath(account), 0o600); } catch {}
  return authPath(account);
}

export function listAccounts() {
  if (!fs.existsSync(AUTH_DIR)) return [];
  return fs.readdirSync(AUTH_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}

// Serialize cookies for a Cookie: header, scoped to chatgpt.com.
export function cookieHeader(auth) {
  return (auth.cookies || [])
    .filter((c) => /(^|\.)chatgpt\.com$/.test(c.domain) || c.domain === "chatgpt.com")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

// When the bearer actually dies (unix seconds). The bearer is a JWT and its own
// `exp` is what the API enforces. `accessTokenExpires` is the `expires` from
// /api/auth/session — the SESSION's end (~90 days), not the bearer's (~10
// days): measured 2026-09-19, session 2026-12-18 vs jwt exp 2026-09-29.
// Trusting only the session date let a dead bearer through, every conversation
// read 401'd token_expired, and send sat out its whole 600s timeout.
export function tokenExpiry(auth) {
  let jwt = null;
  try {
    jwt = JSON.parse(Buffer.from(String(auth.accessToken).split(".")[1], "base64url").toString()).exp || null;
  } catch {}
  const session = auth.accessTokenExpires || null;
  return jwt && session ? Math.min(jwt, session) : jwt || session;
}

export function isExpired(auth, skewSec = 120) {
  const exp = tokenExpiry(auth);
  if (!exp) return true;
  return Date.now() / 1000 >= exp - skewSec;
}

// The bearer is dead and could not be re-minted — every API read will 401, so
// callers should stop instead of polling to their timeout.
export function authExpiredError(account, why) {
  return Object.assign(
    new Error(`auth expired for "${account}" (${why}) — run \`opengpt refresh --account ${account}\`, or \`opengpt login\` if that fails`),
    { code: "AUTH_EXPIRED" },
  );
}

// Ask the page context for /api/auth/session — the browser attaches the
// session-token cookie and Cloudflare lets it through. Returns the parsed
// session ({accessToken, expires, user}) plus the full cookie set + UA.
async function readSessionInBrowser(context) {
  const page = context.pages()[0] || (await context.newPage());
  // A navigation to the app primes Cloudflare (cf cookies) before the XHR.
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  const res = await context.request.get(`${BASE}/api/auth/session`, {
    headers: { accept: "application/json" },
  });
  const status = res.status();
  let session = null;
  try { session = await res.json(); } catch {}
  const cookies = await context.cookies();
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => null);
  return { status, session, cookies, ua };
}

export async function login({ profile, account, headed = false, waitMs = 0 }) {
  const profileDir = resolveProfile(profile);

  // Parallel-friendly: if the profile is open in another browser, don't fight
  // for it. If we already have saved cookies, re-mint the bearer over HTTP (no
  // browser, no disruption). Only a genuine first-time login needs the profile.
  if (profileBusy(profileDir).busy) {
    if (fs.existsSync(authPath(account))) {
      const r = await refresh(account, { via: "node" }).catch((e) => ({ error: e.message }));
      if (!r?.error) {
        const a = loadAuth(account);
        return { path: authPath(account), user: a.user, expires: r.expires, viaRefresh: true };
      }
      throw new Error(
        `profile "${profile}" is open in another browser and refreshing over HTTP failed (${r.error}). ` +
        `Close that browser once to re-login, or run \`opengpt refresh\`.`
      );
    }
    throw new Error(
      `profile "${profile}" is open in another browser and there is no saved auth yet. ` +
      `First-time login needs the profile free once — close that browser and rerun.`
    );
  }

  return withContext(profileDir, { headed }, async (context) => {
    // Headed login = interactive sign-in: default to a generous 10-minute
    // window and watch the browser so we can exit the moment the user is
    // either done (live bearer appears) or gives up (window closed). Headless
    // login = "the cookies on disk are already good" and finishes on the
    // first poll — no window to close, no reason to wait longer than the
    // caller asked.
    const effectiveWait = waitMs || (headed ? 600000 : 0);
    let closed = false;
    context.on("close", () => { closed = true; });
    if (effectiveWait > 0) {
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
      if (headed) process.stderr.write(`[login] sign in in the browser window — this will exit as soon as you're in (or when you close the window)\n`);
      const deadline = Date.now() + effectiveWait;
      while (!closed && Date.now() < deadline) {
        const r = await context.request.get(`${BASE}/api/auth/session`, { headers: { accept: "application/json" } }).catch(() => null);
        const s = r?.ok() ? await r.json().catch(() => null) : null;
        if (s?.accessToken && !isExpired({ accessToken: s.accessToken }, 0)) break;
        // Avoid page.waitForTimeout here — a Playwright timer survives a
        // context close with an "Target page, context or browser has been
        // closed" rejection, which would race the close listener.
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    // The context is already gone if `closed` fired — reading session via it
    // would just throw. Try anyway and let the error path below name it.
    const { status, session, cookies, ua } = closed
      ? { status: 0, session: null, cookies: [], ua: null }
      : await readSessionInBrowser(context);
    if (closed && (!session?.accessToken || isExpired({ accessToken: session.accessToken }, 0))) {
      throw new Error(`login cancelled — the window was closed on "${profile}" before a session was captured`);
    }
    if (!session || !session.accessToken || isExpired({ accessToken: session.accessToken }, 0)) {
      throw new Error(
        `not logged in on profile "${profile}" (/api/auth/session status ${status}` +
        `${session?.accessToken ? ", returned an already-expired bearer" : ""}). ` +
        `Re-run with --headed and sign in manually.`
      );
    }
    const auth = {
      account,
      profile: profileDir,
      user: session.user || null,
      accessToken: session.accessToken,
      accessTokenExpires: session.expires ? Math.floor(new Date(session.expires).getTime() / 1000) : null,
      userAgent: ua,
      cookies,
      savedAt: new Date().toISOString(),
    };
    const p = saveAuth(account, auth);
    return { path: p, user: auth.user, expires: session.expires };
  });
}

// Refresh the bearer from saved cookies. Tries pure HTTP first; if Cloudflare
// blocks the Node client, falls back to the browser profile.
export async function refresh(account, { via = "auto" } = {}) {
  const auth = loadAuth(account);
  if (via !== "browser") {
    const r = await fetch(`${BASE}/api/auth/session`, {
      headers: {
        accept: "application/json",
        cookie: cookieHeader(auth),
        "user-agent": auth.userAgent || "Mozilla/5.0",
      },
    });
    // A stale session cookie still answers 200 — with the OLD bearer it last
    // minted, long dead (measured 2026-09-19: four accounts handed back JWTs
    // issued 2026-08-25, exp 2026-09-04, next to a fresh session `expires`).
    // Saving that reported success while every later call 401'd, so a bearer
    // is only accepted when its own exp is still ahead.
    let stale = false;
    if (r.ok) {
      const s = await r.json().catch(() => ({}));
      if (s.accessToken && isExpired({ accessToken: s.accessToken }, 0)) stale = true;
      else if (s.accessToken) {
        auth.accessToken = s.accessToken;
        auth.accessTokenExpires = s.expires ? Math.floor(new Date(s.expires).getTime() / 1000) : auth.accessTokenExpires;
        auth.user = s.user || auth.user;
        auth.savedAt = new Date().toISOString();
        saveAuth(account, auth);
        return { via: "node", expires: new Date(tokenExpiry(auth) * 1000).toISOString() };
      }
    }
    if (via === "node") {
      throw new Error(stale
        ? "refresh via node got back an already-expired bearer (the saved session cookie is stale). Try --via browser, or log in again."
        : `refresh via node failed (status ${r.status}); Cloudflare likely blocked it. Try --via browser.`);
    }
  }
  // browser fallback re-runs login against the saved profile
  const out = await login({ profile: auth.profile, account, headed: false });
  return { via: "browser", expires: out.expires };
}
