#!/usr/bin/env node
// opengpt — call the ChatGPT web backend-api directly, reusing a logged-in
// browser profile for auth. See README.md.
import { readFileSync } from "node:fs";
import { login, refresh, loadAuth, listAccounts } from "./src/auth.mjs";
import { api } from "./src/http.mjs";
import { send } from "./src/send.mjs";
import {
  listProjects, getProject, createProject, updateProject, deleteProject,
  listProjectChats, listProjectFiles, moveConversation, addProjectFiles,
  latestConversation,
} from "./src/projects.mjs";

// Flags that never take a value. Without this list `--same-chat "prompt"`
// swallows the prompt as the flag's value and it is never sent. Per-command,
// because --json is a boolean on `send` (structured output) but carries the
// request body on `api`.
const COMMON_BOOLEANS = ["headed", "lean", "same-chat", "show-id", "time", "raw", "help", "continue"];
const BOOLEAN_FLAGS = {
  send: new Set([...COMMON_BOOLEANS, "json"]),
  _default: new Set(COMMON_BOOLEANS),
};

function parse(argv) {
  const bools = BOOLEAN_FLAGS[argv[0]] || BOOLEAN_FLAGS._default;
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (bools.has(k) || next === undefined || next.startsWith("--")) opts[k] = true;
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

  opengpt projects --account <name> [--limit N]        list projects
  opengpt project  --account <name> <sub> ...          projects (gizmo_type snorlax)
       new "<name>" [--instructions <t>|--instructions-file <p>] [--memory default|project]
       show   <gid>                      full project resource (incl. sources)
       set    <gid> [--name <t>] [--instructions <t>] [--memory default|project]
       rm     <gid>                      delete the project
       files  <gid>                      list its sources
       add    <gid> <file> [<file>...]   upload source file(s)
       chats  <gid>                      conversations inside it
       move   <conversation-id> <gid|none>   move a chat in (or out with none)
       --memory default = shared with global memory · project = project-only memory

  opengpt send     --account <name> "<p1>" ["<p2>" ...]
       Sends one or more prompts. Multiple prompts share ONE warm browser.
       Default starts a fresh chat per prompt; --same-chat keeps one conversation.
       Orchestration flags (for driving ChatGPT as a worker):
         --system "<text>"      prepend instructions to each prompt
         --system-file <path>   ...read the instructions from a file (e.g. a skill)
         --conversation <id>    continue an existing thread instead of a new chat
         --continue             ...or just continue the most recent one
                                (scoped to --project when given)
         --gpt <gizmo-id>       route to a specific Custom GPT
         --project <g-p-id>     start the chat inside a project
         --json                 structured output: [{text, images, conversationId}] + timings
         --show-id              print each reply's conversation id (stderr)
         --save-images <dir>    download generated images (image-gen results) to <dir>
         --image <path[,...]>   upload image file(s) with the prompt (vision / edit)
         --file <path[,...]>    attach document(s) to the chat (pdf/txt/csv/docx/…)
       Also: --same-chat --headed --lean --time. NOTE: send must use the browser —
       /f/conversation is gated by Cloudflare Turnstile + proof-of-work.

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

    case "projects": {
      need();
      out(await listProjects(account, { limit: opts.limit || 20, via }));
      return;
    }

    case "project": {
      need();
      const sub = args[1];
      const str = (k) => (opts[k] && opts[k] !== true ? opts[k] : undefined);
      const instructions = opts["instructions-file"] && opts["instructions-file"] !== true
        ? readFileSync(opts["instructions-file"], "utf8")
        : str("instructions");
      switch (sub) {
        case "new": {
          const name = args[2] || str("name");
          const g = await createProject(account, { name, instructions: instructions ?? "", memory: str("memory"), via });
          out({ id: g.id, name: g.display?.name, memory_scope: g.memory_scope, memory_enabled: g.memory_enabled });
          return;
        }
        case "show":  out(await getProject(account, args[2], { via })); return;
        case "set": {
          const g = await updateProject(account, args[2], { name: str("name"), instructions, memory: str("memory"), via });
          out({ id: g.id, name: g.display?.name, instructions: g.instructions, memory_scope: g.memory_scope, memory_enabled: g.memory_enabled });
          return;
        }
        case "rm":    out(await deleteProject(account, args[2], { via })); return;
        case "files": out(await listProjectFiles(account, args[2], { via })); return;
        case "chats": out(await listProjectChats(account, args[2], { via })); return;
        case "add": {
          const files = args.slice(3);
          if (!files.length) throw new Error("usage: opengpt project add --account <n> <gid> <file> [<file>...]");
          out(await addProjectFiles(account, args[2], files, { via }));
          return;
        }
        case "move": {
          const conv = args[2], target = args[3];
          if (!conv || !target) throw new Error("usage: opengpt project move --account <n> <conversation-id> <gid|none>");
          out(await moveConversation(account, conv, target === "none" ? null : target, { via }));
          return;
        }
        default:
          throw new Error(`unknown project subcommand: ${sub}\n\n${HELP}`);
      }
    }

    case "send": {
      need();
      const prompts = args.slice(1);
      if (!prompts.length) throw new Error('usage: opengpt send --account <name> "<prompt>" ["<prompt2>" ...]');
      const system = opts["system-file"] && opts["system-file"] !== true
        ? readFileSync(opts["system-file"], "utf8")
        : (opts.system && opts.system !== true ? opts.system : null);
      const gizmo = (opts.gpt && opts.gpt !== true ? opts.gpt : null)
        || (opts.project && opts.project !== true ? opts.project : null);
      let conversationId = opts.conversation && opts.conversation !== true ? opts.conversation : null;
      // --continue: pick up the most recent chat instead of starting yet
      // another one. Scoped to the project when --project is given.
      if (!conversationId && opts.continue) {
        conversationId = await latestConversation(account, gizmo, { via });
      }
      const r = await send({
        account,
        prompts,
        headed: !!opts.headed,
        lean: !!opts.lean,             // blocks images/fonts/ads (bandwidth, not latency)
        sameChat: !!opts["same-chat"],
        system,                        // prepend instructions (e.g. a skill's text)
        conversationId,
        via,                           // how the answer is read back over HTTP
        // --project is the same navigation as --gpt: /g/<id> resolves a
        // project (g-p-…) as well as a Custom GPT.
        gizmo,
        saveDir: opts["save-images"] && opts["save-images"] !== true ? opts["save-images"] : null,
        attach: opts.image && opts.image !== true ? opts.image.split(",").map((s) => s.trim()) : null, // upload image(s)
        docs: opts.file && opts.file !== true ? opts.file.split(",").map((s) => s.trim()) : null, // upload document(s)
        timeoutMs: opts.timeout && opts.timeout !== true ? Number(opts.timeout) : 120000, // image-gen/vision needs more
      });
      if (opts.json) {
        // structured output for orchestration (Claude Code drives this)
        out({ results: r.results, timings: r.timings });
      } else {
        r.results.forEach((res, i) => {
          if (r.results.length > 1) process.stdout.write(`\n=== [${i + 1}] ===\n`);
          if (res.text) out(res.text);
          else if (res.savedPaths?.length) out(res.savedPaths.map((p) => `[image saved] ${p}`).join("\n"));
          else if (res.images?.length) out(res.images.map((u) => `[image] ${u}`).join("\n"));
          else out("(no text captured)");
          if (opts["show-id"] && res.conversationId) process.stderr.write(`[conversation ${res.conversationId}]\n`);
        });
      }
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
