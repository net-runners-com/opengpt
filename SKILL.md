---
name: opengpt
description: Drive a logged-in ChatGPT account from the command line — send prompts and read replies, manage Projects (instructions, sources, project-only memory), attach images and documents, generate and download images, and call any chatgpt.com backend-api endpoint. Use when the user wants to ask ChatGPT something from the terminal, run a persona or instruction set through ChatGPT, batch-generate posts or copy, continue an existing ChatGPT conversation, organise chats into Projects, upload files as project sources, or read their ChatGPT history. Reuses a browser profile they have already signed into; everything but sending runs over plain HTTP.
---

# opengpt

Calls the ChatGPT web **backend-api** as the logged-in user. `login` once, then
cookies + bearer live in `auth/<account>.json` and every later call is plain
Node HTTP — except sending a prompt, which needs the browser.

Repo: `~/.superset/projects/opengpt` (this directory; `~/.claude/skills/opengpt`
is a symlink to it). Auth lives in
`~/.claude/plugins/data/opengpt-skills-dir/auth`, so set
`OPENGPT_AUTH_DIR` when invoking from elsewhere:

```bash
export OPENGPT_AUTH_DIR=~/.claude/plugins/data/opengpt-skills-dir/auth
node ~/.claude/skills/opengpt/cli.mjs <command> --account me …
```

`node cli.mjs help` is the authoritative command list. Accounts currently saved:
`me`, `google`, `jgjkgj`, `hiropilot`, `acct4` — `accounts` lists them.

## The one thing to understand first

`POST /backend-api/f/conversation` requires three tokens the page computes in
obfuscated JS (`openai-sentinel-proof-token`, `openai-sentinel-turnstile-token`,
`x-conduit-token`). A Turnstile token cannot be minted from Node, so **`send` is
the only command that launches a browser** — it drives the real logged-in page
so the page mints them itself. Everything else, including reading the answer
back and downloading generated images, is plain HTTP.

Do not try to replace this with a pure-HTTP reimplementation. Public PoW solvers
exist and still work; the Turnstile stage is the one that does not, and replaying
page-minted tokens from Node returns `403 Unusual activity has been detected from
your device` (TLS fingerprint). This is settled — see README "What does NOT work
over pure HTTP".

## Common tasks

```bash
# ask something
node cli.mjs send --account me "…"

# run a persona / instruction set (prepends to each prompt)
node cli.mjs send --account me --system-file ./persona.md "…" --json

# attach files
node cli.mjs send --account me --file ./spec.pdf,./data.csv "この2つの差分は？"
node cli.mjs send --account me --image ./photo.png "この画像を1文で説明して"

# generate an image and save it
node cli.mjs send --account me "黄色い花の画像を1枚" --save-images ./out

# read-only, no browser
node cli.mjs convos --account me --limit 10
node cli.mjs get    --account me <conversation-id>
node cli.mjs api    --account me GET /backend-api/me
```

### Conversations

`send` **continues the most recently updated chat by default** — scoped to the
project when `--project` is given. `--new` starts a fresh one; `--conversation
<id>` targets a specific thread; `--same-chat` keeps several prompts in one
conversation within a single invocation. `--show-id` prints ids to stderr,
`--json` returns them per result.

### Projects

Projects are gizmos of type `snorlax`; all of this is pure HTTP.

```bash
node cli.mjs projects --account me
node cli.mjs project new   --account me "経理" --instructions-file ./shijisho.md --memory project
node cli.mjs project add   --account me g-p-xxxx ./規程.pdf        # sources (RAG)
node cli.mjs project set   --account me g-p-xxxx --memory default
node cli.mjs project move  --account me <conversation-id> g-p-xxxx # none = move out
node cli.mjs send --account me --project g-p-xxxx "…"
```

- `--memory project` = プロジェクト限定メモリ (`memory_scope: project_v2`),
  `--memory default` = デフォルトメモリ (`global`). This isolates *memory*; it
  is not how instructions are supplied.
- Instructions cap at **8000 characters**. Longer material belongs in sources,
  which are retrieved rather than always present.

### Speed

Each `send` pays browser launch (~1.5s) + SPA boot (~3.2s). Two ways around it:

- `--same-chat` with several prompts — one browser for the batch.
- `--daemon` — starts a warm daemon on demand, navigation drops to ~30ms. It
  holds ~570MB while alive; it exits after 300s idle, or `daemon stop`. (The old
  "webtrace can't launch while the daemon runs" claim is wrong on the free v146
  binary — measured two cloakbrowser sessions, and the daemon alongside a
  webtrace persistent-profile browser, running fine at once.)

## Gotchas that cost real debugging time

- The composer is `#prompt-textarea` **by id**. A thread that rendered an answer
  as a writing block has a second `contenteditable` (the canvas) earlier in DOM
  order, and a comma selector with `.first()` types into the canvas instead.
- Mid-turn the URL holds a placeholder `WEB:<uuid>`; the API answers `400` for
  it and `429` if polled. Only accept a real uuid.
- Writing-block answers arrive fenced as `:::writing{…}` … `:::` — strip it or
  the canvas title is glued to the first line.
- `PATCH /backend-api/projects/<gid>` is a full replace of
  name/instructions/emoji/theme; a partial body 422s.
- Attachment completion is a network fact (a finished `process_upload_stream`
  per file), not a DOM one — the chip renders on selection while bytes are still
  uploading.

`OPENGPT_DEBUG=1` prints per-poll conversation state during a send.

## Scope

This acts as the account the user logged in as. It does not create accounts, and
it does not defeat the bot challenge — the real client solves it.
