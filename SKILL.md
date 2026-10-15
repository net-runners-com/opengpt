---
name: opengpt
description: Drive a logged-in ChatGPT account from the command line — send prompts and read replies, manage Projects (instructions, sources, project-only memory), attach images and documents, generate and download images, and call any chatgpt.com backend-api endpoint. Use when the user wants to ask ChatGPT something from the terminal, run a persona or instruction set through ChatGPT, batch-generate posts or copy, continue an existing ChatGPT conversation, organise chats into Projects, upload files as project sources, or read their ChatGPT history. Reuses a browser profile they have already signed into once; everything after login runs over plain HTTP.
---

# opengpt

Calls the ChatGPT web **backend-api** as the logged-in user. `login` once in a
real browser, then cookies + bearer live in `auth/<account>.json` and **every**
later call — including `send` — is plain Node HTTP. No browser is launched for
later operations until the long-lived session cookie expires (months).

Repo: `~/.superset/projects/opengpt` (this directory; `~/.claude/skills/opengpt`
is a mirror). Auth lives in
`~/.claude/plugins/data/opengpt-skills-dir/auth`, so set
`OPENGPT_AUTH_DIR` when invoking from elsewhere:

```bash
export OPENGPT_AUTH_DIR=~/.claude/plugins/data/opengpt-skills-dir/auth
node ~/.claude/skills/opengpt/cli.mjs <command> --account me …
```

`node cli.mjs help` is the authoritative command list. Accounts currently saved:
`me`, `google`, `jgjkgj`, `hiropilot`, `acct4` — `accounts` lists them.

## The one thing to understand first

`send` moved to pure HTTP in 2026-10. The gate on `POST /backend-api/f/conversation`
is a 5-request sentinel flow: `/sentinel/chat-requirements/prepare` returns a
PoW challenge + a `prepare_token`; the client solves the PoW locally (SHA3-512
nonce search, typically <100 iterations, under 1 ms); `/finalize` returns the
`chat-requirements-token`; `/f/conversation/prepare` primes the route; then
`POST /f/conversation` with the three sentinel headers streams the SSE answer.

Measured on this account's gate: the Turnstile and "so" observer tokens are
*advertised* required but **not enforced** — any string works for turnstile,
omitting "so" works. The cf_clearance cookie is not required either.
`src/send.mjs` is the whole picture — read it before editing.

## Common tasks

```bash
# ask something
node cli.mjs send --account me "…"

# run a persona / instruction set (prepends to each prompt)
node cli.mjs send --account me --system-file ./persona.md "…" --json

# attach files (uploads via /backend-api/files → PUT Azure blob → process_upload_stream)
node cli.mjs send --account me --file ./spec.pdf,./data.csv "この2つの差分は？"
node cli.mjs send --account me --image ./photo.png "この画像を1文で説明して"

# generate an image and save it
node cli.mjs send --account me "黄色い花の画像を1枚" --save-images ./out

# read-only
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

### Projects and Custom GPTs

Projects are gizmos of type `snorlax`; all project management is pure HTTP.

```bash
node cli.mjs projects --account me
node cli.mjs project new   --account me "経理" --instructions-file ./shijisho.md --memory project
node cli.mjs project add   --account me g-p-xxxx ./規程.pdf        # sources (RAG)
node cli.mjs project set   --account me g-p-xxxx --memory default
node cli.mjs project move  --account me <conversation-id> g-p-xxxx # none = move out
node cli.mjs send --account me --project g-p-xxxx "…"
node cli.mjs send --account me --gpt    g-xxxx    "…"              # bare Custom GPT
```

Routing to a project *or* a bare Custom GPT is body-only:
`conversation_mode: {kind: "gizmo_interaction", gizmo_id}` plus a top-level
`gizmo_id`. Verified against both `g-p-...` (projects) and bare `g-...`
(public GPTs).

- `--memory project` = プロジェクト限定メモリ (`memory_scope: project_v2`),
  `--memory default` = デフォルトメモリ (`global`). This isolates *memory*; it
  is not how instructions are supplied.
- Instructions cap at **8000 characters**. Longer material belongs in sources,
  which are retrieved rather than always present.

### Daemon (optional)

A per-account Unix socket (0600) that serializes `send`s so parallel bursts
don't race on the sentinel token mint. `--daemon` starts one on demand; it
exits after 300s idle. Costs almost nothing — no browser, no page.

```bash
opengpt send --account me --daemon "…"
opengpt daemon --account me status
opengpt daemon --account me stop
```

### Testing

```bash
node test/test-send.mjs me
```

13 cases: basic send, continuation, same-chat batches, system prompt,
image/doc attach, project send + continuation + attach, bare Custom GPT,
daemon round-trip, 429 → `RATE_LIMITED`, 401 → `AUTH_EXPIRED`.

## Gotchas that cost real debugging time

- The message turn body shape matters: `turn_attribution.turn_trigger: "composer"`,
  `is_do_not_remember: false`, `parent_message_id: "client-created-root"` (for a
  new chat), `local_function_names: ["local.continue_in_work"]`,
  `genui_state_snapshots: []`, `client_prepare_state: "sent"`,
  `supported_encodings: ["v1"]`. Miss any one and the backend returns
  `"Model not found"` (not a validation error — the model router silently
  rejects).
- Writing-block answers arrive fenced as `:::writing{…}` … `:::` — strip it or
  the canvas title is glued to the first line.
- Web-search answers embed citation spans in U+E200..U+E202; strip the span and
  the stray marker characters or `citeturn0search12` ends up in the text.
- Attachments in the turn body: images go into *both* `content.parts` (as
  `image_asset_pointer` with `content_type: "multimodal_text"`) *and*
  `metadata.attachments`. Docs go only in `metadata.attachments`.
- The bearer (JWT) dies after ~10 days while the saved session lasts ~90, so
  expiry is judged from the JWT's own `exp`. `send` re-mints a dead bearer
  up front and stops with `AUTH_EXPIRED` if it cannot; `accounts --status`
  shows each account's bearer expiry offline.
- `PATCH /backend-api/projects/<gid>` is a full replace of
  name/instructions/emoji/theme; a partial body 422s.
- 429 from `/f/conversation` surfaces as `err.code = "RATE_LIMITED"`; 401 that
  survives one refresh is `err.code = "AUTH_EXPIRED"`.

`OPENGPT_DEBUG=1` prints http.mjs debug lines.

## Scope

This acts as the account the user logged in as. It does not create accounts.
