// Thin cloakbrowser wrapper. Historically this backed `send` by driving the
// composer; the pure-HTTP rewrite dropped that path (2026-10-15), so the
// browser is now used for exactly two things:
//   1. login            — interactive sign-in into a persistent profile, to
//                         produce the cookie jar and bearer the HTTP flow
//                         replays from (see auth.mjs: login / refresh).
//   2. http.mjs fallback — a non-persistent context seeded with saved cookies,
//                         used when the Node fetch client hits a Cloudflare
//                         challenge and we need the browser's TLS stack. In
//                         practice this almost never fires on this account's
//                         current pool, but it's the last-resort escape hatch.
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

// Persistent profile — login's cookie jar and bearer source. Headed is only
// meaningful here (login's --headed shows a window the user can sign in in).
export async function openContext(profileDir, { headed = false } = {}) {
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

// Non-persistent context seeded with saved cookies — no userDataDir, no lock,
// many can run at once for the same account. Used by http.mjs when Cloudflare
// blocks pure Node and we need the browser's TLS stack for one request.
export async function openEphemeral(auth, { headed = false } = {}) {
  const context = await launchContext({
    headless: !headed,
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    launchOptions: { handleSIGINT: false, handleSIGTERM: false },
    contextOptions: { storageState: { cookies: auth.cookies || [], origins: [] } },
  });
  return context;
}
