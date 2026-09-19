// Auth as a feature: log in once via a browser profile, persist the cookies +
// bearer, and reuse them for pure-HTTP API calls afterwards.
import fs from "node:fs";
import path from "node:path";
import { AUTH_DIR, BASE, ensureAuthDir, resolveProfile } from "./config.mjs";
import { withContext, profileBusy } from "./browser.mjs";

const authPath = (account) => path.join(AUTH_DIR, `${account}.json`);

export function loadAuth(account) {
  const p = authPath(account);
  if (!fs.existsSync(p)) throw new Error(`no saved auth for "${account}". Run: gptcli login --profile <name> --account ${account}`);
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
    if (waitMs > 0) {
      // Give a human time to complete an interactive sign-in in a headed window.
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(waitMs);
    }
    const { status, session, cookies, ua } = await readSessionInBrowser(context);
    if (!session || !session.accessToken) {
      throw new Error(
        `not logged in on profile "${profile}" (/api/auth/session status ${status}). ` +
        `Re-run with --headed --wait 120000 and sign in manually.`
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
    if (r.ok) {
      const s = await r.json().catch(() => ({}));
      if (s.accessToken) {
        auth.accessToken = s.accessToken;
        auth.accessTokenExpires = s.expires ? Math.floor(new Date(s.expires).getTime() / 1000) : auth.accessTokenExpires;
        auth.user = s.user || auth.user;
        auth.savedAt = new Date().toISOString();
        saveAuth(account, auth);
        return { via: "node", expires: s.expires };
      }
    }
    if (via === "node") throw new Error(`refresh via node failed (status ${r.status}); Cloudflare likely blocked it. Try --via browser.`);
  }
  // browser fallback re-runs login against the saved profile
  const out = await login({ profile: auth.profile, account, headed: false });
  return { via: "browser", expires: out.expires };
}
