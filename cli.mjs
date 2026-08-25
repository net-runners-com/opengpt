#!/usr/bin/env node
// opengpt — call the ChatGPT web backend-api directly, reusing a logged-in
// browser profile for auth. See README.md.
import { login, refresh, loadAuth, listAccounts } from "./src/auth.mjs";
import { api } from "./src/http.mjs";
import { send } from "./src/send.mjs";

function parse(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[k] = true;
      else { opts[k] = next; i++; }
    } else args.push(a);
  }
  return { args, opts };
}

const HELP = `opengpt — ChatGPT backend-api client

  opengpt login   --profile <name|dir> --account <name> [--headed --wait <ms>]
       Log in via a cloakbrowser profile, save cookies + bearer to auth/<name>.json.
       A fresh profile needs: --headed --wait 120000  (sign in by hand once).

  opengpt refresh --account <name> [--via auto|node|browser]
       Mint a fresh bearer from the saved session cookie.

  opengpt accounts                       list saved accounts
  opengpt whoami   --account <name>      /backend-api/me
  opengpt models   --account <name>      /backend-api/models
  opengpt plan     --account <name>      /backend-api/accounts/check/v4-2023-04-27
  opengpt convos   --account <name> [--limit N] [--offset N]
  opengpt get      --account <name> <conversation-id>
  opengpt api      --account <name> <METHOD> <path> [--json '<body>']   raw call

  opengpt send     --account <name> "<p1>" ["<p2>" ...] [--same-chat --headed --lean --time]
       Sends one or more prompts. Multiple prompts share ONE warm browser, so
       launch + page-load are paid once. Default starts a fresh chat per prompt;
       --same-chat keeps them in one conversation (fastest, shared context).
       NOTE: this is the one command that must use the browser —
       /f/conversation is gated by Cloudflare Turnstile + a proof-of-work token
       that cannot be produced from Node. --lean blocks images/fonts/ads
       (bandwidth, not latency). --time prints a per-stage breakdown.

Global:  --via auto|node|browser   (read commands; default auto)
         --raw                      print raw response text
Env:     OPENGPT_AUTH_DIR, OPENGPT_PROFILE_ROOT`;

function out(v) {
  if (typeof v === "string") process.stdout.write(v.endsWith("\n") ? v : v + "\n");
  else process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

async function main() {
  const { args, opts } = parse(process.argv.slice(2));
  const cmd = args[0];
  const account = opts.account;
  const via = opts.via || "auto";
  const need = () => { if (!account) throw new Error("--account is required"); };

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      out(HELP); return;

    case "accounts":
      out(listAccounts()); return;

    case "login": {
      if (!opts.profile) throw new Error("--profile is required");
      need();
      const r = await login({
        profile: opts.profile,
        account,
        headed: !!opts.headed,
        waitMs: opts.wait ? Number(opts.wait) : 0,
      });
      out({
        saved: r.path,
        mode: r.viaRefresh ? "refreshed-over-http (profile busy — no browser opened)" : "browser-login",
        user: r.user && { email: r.user.email, name: r.user.name },
        expires: r.expires,
      });
      return;
    }

    case "refresh": {
      need();
      const r = await refresh(account, { via });
      out({ refreshed: true, ...r });
      return;
    }

    case "whoami": need(); out(await api(account, "GET", "/backend-api/me", { via, raw: opts.raw })); return;
    case "models": need(); out(await api(account, "GET", "/backend-api/models", { via, raw: opts.raw })); return;
    case "plan":   need(); out(await api(account, "GET", "/backend-api/accounts/check/v4-2023-04-27", { via, raw: opts.raw })); return;

    case "convos": {
      need();
      const limit = opts.limit || 20, offset = opts.offset || 0;
      out(await api(account, "GET", `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`, { via, raw: opts.raw }));
      return;
    }

    case "get": {
      need();
      const id = args[1];
      if (!id) throw new Error("usage: opengpt get --account <name> <conversation-id>");
      out(await api(account, "GET", `/backend-api/conversation/${id}`, { via, raw: opts.raw }));
      return;
    }

    case "api": {
      need();
      const method = (args[1] || "GET").toUpperCase();
      const path = args[2];
      if (!path) throw new Error("usage: opengpt api --account <name> <METHOD> <path> [--json '<body>']");
      const json = opts.json && opts.json !== true ? JSON.parse(opts.json) : undefined;
      out(await api(account, method, path, { via, json, raw: opts.raw }));
      return;
    }

    case "send": {
      need();
      const prompts = args.slice(1);
      if (!prompts.length) throw new Error('usage: opengpt send --account <name> "<prompt>" ["<prompt2>" ...]');
      const r = await send({
        account,
        prompts,
        headed: !!opts.headed,
        lean: !!opts.lean,         // --lean blocks images/fonts/ads (saves bandwidth,
        sameChat: !!opts["same-chat"], // not latency: we gate on domcontentloaded)
      });
      r.results.forEach((text, i) => {
        if (r.results.length > 1) process.stdout.write(`\n=== [${i + 1}] ===\n`);
        out(text || "(no text captured)");
      });
      if (opts.time) {
        const t = r.timings;
        const ms = (v) => `${Math.round(v)}ms`;
        process.stderr.write(
          `\n[timing] launch ${ms(t.launch)} · load ${ms(t.load)} · ` +
          t.perPrompt.map((p, i) => `p${i + 1}(first ${ms(p.firstToken)}, done ${ms(p.total)})`).join(" · ") + "\n"
        );
      }
      return;
    }

    default:
      throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
