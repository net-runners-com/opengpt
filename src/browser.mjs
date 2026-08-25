// Thin cloakbrowser wrapper. The browser is used for exactly two things:
//   1. login  — as a cookie jar + Cloudflare-passing TLS stack to mint auth
//   2. send   — to obtain the sentinel / turnstile tokens the page computes
// Everything else is plain Node HTTP.
import { launchPersistentContext, launchContext } from "cloakbrowser";
import fs from "node:fs";
import path from "node:path";

// A persistent profile in use writes SingletonLock -> <hostname>-<pid>.
// Returns {busy, pid}: busy=true when a live browser holds the profile.
export function profileBusy(profileDir) {
  const lock = path.join(profileDir, "SingletonLock");
  let target;
  try { target = fs.readlinkSync(lock); } catch { return { busy: false }; } // no lock
  const pid = Number(target.split("-").pop());
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); alive = true; } // no throw → alive
    catch (e) { alive = e.code === "EPERM"; }    // EPERM = alive (not ours); ESRCH = dead
  }
  return { busy: alive, pid };
}

// Guard the persistent-launch path: never hijack a LIVE profile (that would
// close the browser the user has open); clean a stale lock and proceed.
function assertProfileFree(profileDir) {
  const { busy, pid } = profileBusy(profileDir);
  if (busy) {
    throw new Error(
      `profile "${path.basename(profileDir)}" is open in another browser (pid ${pid}). ` +
      `Refusing to launch so your session isn't disturbed — close that browser first.`
    );
  }
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.rmSync(path.join(profileDir, f), { force: true }); } catch {}
  }
}

// Hosts that must NEVER be blocked: the app, its APIs, and — critically — the
// Cloudflare challenge widget that mints the turnstile token. Blocking any of
// these breaks the legitimate token flow.
const KEEP_HOST = /(^|\.)(chatgpt\.com|openai\.com|oaistatic\.com|oaiusercontent\.com|cloudflare\.com|challenges\.cloudflare\.com)$/;

// Pure telemetry / ads seen in the traces — safe to drop, never functional.
const DROP_HOST = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googleadservices\.com|google\.com\/(ads|pagead)|linkedin\.com|ads\.linkedin\.com|bing\.com|bat\.bing\.com|tiktok\.com|analytics\.tiktok\.com|sentry\.io|segment\.(io|com))$/;

// Resource types that never affect the send flow — images, media, fonts.
const DROP_TYPE = new Set(["image", "media", "font"]);

// Cut the ~30MB / ~1800-request cold load down to app JS + API + challenge.
export async function blockAssets(context) {
  await context.route("**/*", (route) => {
    const req = route.request();
    let host = "";
    try { host = new URL(req.url()).hostname; } catch {}
    if (KEEP_HOST.test(host)) return route.continue();
    if (DROP_HOST.test(host) || DROP_TYPE.has(req.resourceType())) return route.abort();
    return route.continue();
  });
}

export async function openContext(profileDir, { headed = false, lean = false } = {}) {
  if (!profileDir) throw new Error("a --profile is required for browser operations");
  assertProfileFree(profileDir);
  const context = await launchPersistentContext({
    userDataDir: profileDir,
    headless: !headed,
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    // Do not let Playwright's SIGINT handler kill us mid-flush.
    launchOptions: { handleSIGINT: false, handleSIGTERM: false },
  });
  if (lean) await blockAssets(context);
  return context;
}

export async function withContext(profileDir, opts, fn) {
  const context = await openContext(profileDir, opts);
  try {
    return await fn(context);
  } finally {
    await context.close().catch(() => {});
  }
}

// Non-persistent context seeded with saved cookies. There is NO userDataDir, so
// there is NO profile SingletonLock — many of these can run at once, even for
// the same account. Used for send and the HTTP browser-fallback; `login` still
// needs the persistent profile to do the interactive sign-in.
export async function openEphemeral(auth, { headed = false, lean = false } = {}) {
  const context = await launchContext({
    headless: !headed,
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    launchOptions: { handleSIGINT: false, handleSIGTERM: false },
    contextOptions: { storageState: { cookies: auth.cookies || [], origins: [] } },
  });
  if (lean) await blockAssets(context);
  return context;
}
