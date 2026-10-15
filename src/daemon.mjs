// A local daemon that fronts `send` over a Unix socket. Historically this
// held a warm browser so composer-driven sends skipped SPA boot; the pure-HTTP
// rewrite dropped the browser altogether (2026-10-15), so the daemon is now
// just a per-account single-flight gate — one send at a time, no overlap on
// the sentinel token mint — plus a place to add short-lived caches later.
//
// Still a Unix socket, 0600: a live authenticated ChatGPT session behind
// localhost:NNNN would be usable by anything on the machine.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { send } from "./send.mjs";

// Unix socket paths are capped near 104 bytes on macOS, so keep this short and
// out of the deep plugin-data path.
export function socketPath(account) {
  return path.join(os.tmpdir(), `opengpt-${account}.sock`);
}

// Idle life. The pure-HTTP daemon costs almost nothing idle, but keeping the
// socket indefinitely is still worse than letting it expire — surprise
// permissions on a shared machine, etc. 0 disables.
export const DEFAULT_IDLE_MS = Number(process.env.OPENGPT_DAEMON_IDLE || 300) * 1000;

function connect(account) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath(account));
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

// True when a daemon is actually accepting connections. A socket file left by
// a crash is not enough — it is removed so the next start can bind.
export async function isRunning(account) {
  if (!fs.existsSync(socketPath(account))) return false;
  try {
    const sock = await connect(account);
    sock.end();
    return true;
  } catch {
    fs.rmSync(socketPath(account), { force: true });
    return false;
  }
}

// One request, one newline-delimited JSON round trip.
export async function request(account, payload, { timeoutMs = 300000 } = {}) {
  const sock = await connect(account);
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (fn, v) => { clearTimeout(timer); sock.end(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error("daemon request timed out")), timeoutMs);
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); }
      catch (e) { return done(reject, new Error(`bad daemon reply: ${e.message}`)); }
      if (msg.ok) done(resolve, msg.result);
      else done(reject, Object.assign(new Error(msg.error || "daemon error"), { code: msg.code }));
    });
    sock.on("error", (e) => done(reject, e));
    sock.write(JSON.stringify(payload) + "\n");
  });
}

// Start a daemon in the background and wait for it to accept connections.
// Used by `send` so a burst of prompts shares one single-flight gate — and
// the idle timeout gives the socket back when the burst ends.
export async function ensure(account, { idleMs = DEFAULT_IDLE_MS, waitMs = 60000 } = {}) {
  if (await isRunning(account)) return { started: false };
  const { spawn } = await import("node:child_process");
  const cli = new URL("../cli.mjs", import.meta.url).pathname;
  const args = [cli, "daemon", "--account", account, "start", "--idle", String(Math.round(idleMs / 1000))];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (await isRunning(account)) return { started: true, pid: child.pid };
  }
  throw new Error("daemon did not come up in time");
}

export async function stop(account) {
  if (!(await isRunning(account))) return { stopped: false, reason: "not running" };
  try { await request(account, { op: "stop" }, { timeoutMs: 10000 }); } catch { /* it went away */ }
  fs.rmSync(socketPath(account), { force: true });
  return { stopped: true };
}

export async function status(account) {
  if (!(await isRunning(account))) return { running: false, socket: socketPath(account) };
  return { running: true, socket: socketPath(account), ...(await request(account, { op: "status" })) };
}

// Run the daemon. Resolves when it shuts down.
export async function serve(account, { idleMs = DEFAULT_IDLE_MS } = {}) {
  const sockPath = socketPath(account);
  if (await isRunning(account)) throw new Error(`a daemon is already running for "${account}"`);
  fs.rmSync(sockPath, { force: true });

  const started = Date.now();
  let served = 0;
  let busy = false;
  let idleTimer = null;

  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", async (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);

      let req;
      try { req = JSON.parse(line); }
      catch (e) { return sock.end(JSON.stringify({ ok: false, error: `bad request: ${e.message}` }) + "\n"); }

      if (req.op === "stop") {
        sock.end(JSON.stringify({ ok: true, result: { stopping: true } }) + "\n");
        return shutdown();
      }
      if (req.op === "status") {
        return sock.end(JSON.stringify({
          ok: true,
          result: { account, pid: process.pid, served, busy, uptimeSec: Math.round((Date.now() - started) / 1000) },
        }) + "\n");
      }
      if (req.op !== "send") {
        return sock.end(JSON.stringify({ ok: false, error: `unknown op: ${req.op}` }) + "\n");
      }
      if (busy) {
        return sock.end(JSON.stringify({ ok: false, error: "daemon busy — one send at a time" }) + "\n");
      }

      busy = true;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        // The pure-HTTP send is self-contained; the daemon is just a
        // single-flight gate so parallel bursts don't race on the sentinel
        // mint. Any `context` the caller passes is ignored.
        const result = await send({ ...req.args, account });
        served++;
        sock.end(JSON.stringify({ ok: true, result }) + "\n");
      } catch (e) {
        sock.end(JSON.stringify({ ok: false, error: e.message, code: e.code }) + "\n");
      } finally {
        busy = false;
        armIdle();
      }
    });
    sock.on("error", () => {});
  });

  function armIdle() {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!busy) shutdown(); }, idleMs);
    idleTimer.unref();
  }

  let shuttingDown = null;
  function shutdown() {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      if (idleTimer) clearTimeout(idleTimer);
      server.close();
      fs.rmSync(sockPath, { force: true });
    })();
    return shuttingDown;
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });
  fs.chmodSync(sockPath, 0o600);
  armIdle();

  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown().then(() => process.exit(0)));

  return { socket: sockPath, pid: process.pid, wait: () => shuttingDown || new Promise(() => {}) };
}
