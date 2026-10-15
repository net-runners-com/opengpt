# opengpt

Call the ChatGPT web **backend-api** directly from the command line, reusing a
browser profile you have already signed into. Built from the traffic captured
with the `webtrace` skill.

Auth is a first-class feature: `login` once in a real browser, the cookies +
bearer are saved to `auth/<account>.json`, and every later call is plain Node
HTTP — **including `send`**. No browser is launched for subsequent operations
until the long-lived session cookie expires (months).

## Pure HTTP, including the send

Everything the CLI does now runs on `authorization: Bearer <jwt>` + the saved
cookies, straight from Node. The one historical exception — `send` — moved
from a browser-driven composer to a pure-HTTP flow (2026-10-15), after
`webtrace` captured enough of the sentinel protocol to replicate it.

| Command | Endpoint |
| --- | --- |
| `whoami` | `GET /backend-api/me` |
| `plan`   | `GET /backend-api/accounts/check/v4-2023-04-27` |
| `models` | `GET /backend-api/models` |
| `convos` | `GET /backend-api/conversations` |
| `get <id>` | `GET /backend-api/conversation/<id>` |
| `api <M> <path>` | any endpoint |
| `refresh` | `GET /api/auth/session` → new bearer from the session cookie |
| `send`   | `POST /backend-api/f/conversation` (sentinel-gated, see below) |

Verified live against a logged-in free account: all of the above return 200
from Node's `fetch`. If Cloudflare ever challenges the Node client the read
commands auto-fall back to the profile's browser network stack (`--via auto`,
the default); `send` has no such fallback — see the next section for how it
replicates the gate directly.

## How `send` reaches /f/conversation without a browser

The send endpoint is sentinel-gated; the real web client proves itself with
three tokens before posting the turn. Each one was measured in isolation
against this account's gate:

| Challenge | Required by server | Minted by |
| --- | --- | --- |
| `openai-sentinel-chat-requirements-token` | **yes** | 2-step `/sentinel/chat-requirements/prepare` + `/finalize` |
| `openai-sentinel-proof-token` (PoW) | **yes** | Local SHA3-512 nonce search — typically <100 iterations, <1 ms |
| `openai-sentinel-turnstile-token` | advertised required, **not enforced** | — (any string works) |
| `so` observer response (collector/snapshot) | advertised required, **not enforced** | — (omit entirely) |
| `cf_clearance` / `__cf_bm` cookies | **not enforced** on this pool | — (session-token.* is enough) |

Full turn in pure HTTP, five requests:

1. `POST /backend-api/sentinel/chat-requirements/prepare {p: "gAAAAAC"+b64(fp)+"~F"}` → `{prepare_token, proofofwork:{seed,difficulty}, …}`
2. Solve the PoW locally — a 25-element JSON array with the nonce at index 0, hashed as `SHA3-512(seed + base64(JSON(array)))`, winning when the hex prefix is `<=` difficulty.
3. `POST /backend-api/sentinel/chat-requirements/finalize {prepare_token, proofofwork:<solved>, turnstile:"n/a"}` → `{token, expire_after:540}`
4. `POST /backend-api/f/conversation/prepare` (same body as the send) → `{status:"ok", conduit_token}` (conduit cosmetic — never referenced by the real client either)
5. `POST /backend-api/f/conversation` with the three sentinel headers + the message turn → `text/event-stream`

The SSE is `delta_encoding: "v1"` — incremental JSON patches. `send` doesn't
try to rebuild the text from patches; it watches the stream for the
`conversation_id`, then `GET /backend-api/conversation/<id>` returns the clean
final tip (same tip-reading rules as **Reading a turn out of the conversation**
below).

### The message turn body (reverse-engineered 2026-10-15)

The fields the backend actually requires are narrower than the real client's
payload. These keys matter:

```json
{
  "turn_attribution": {"turn_trigger": "composer"},
  "action": "next",
  "is_do_not_remember": false,
  "model": "auto",
  "parent_message_id": "client-created-root",
  "timezone": "Asia/Tokyo",
  "timezone_offset_min": -540,
  "client_contextual_info": {
    "app_name": "chatgpt.com", "app_surface": "codex_browser",
    "has_web_push_capabilities": true, "web_push_notification_permission": "default"
  },
  "local_function_names": ["local.continue_in_work"],
  "messages": [{ … }],
  "supported_encodings": ["v1"],
  "genui_state_snapshots": [],
  "client_prepare_state": "sent"
}
```

Attachments are a two-layer thing — images in `content.parts` as
`image_asset_pointer` entries (`content_type: "multimodal_text"`), every file
regardless of type in `messages[0].metadata.attachments`.

Project / Custom GPT routing is additive: `conversation_mode: {kind:
"gizmo_interaction", gizmo_id}` **plus** a top-level `gizmo_id`. The backend
returns `"Model not found"` without this pair; verified against both
`g-p-...` (projects) and bare `g-...` (public Custom GPTs).

### Reading a turn out of the conversation

`GET /backend-api/conversation/<id>` returns a `mapping` of nodes plus
`current_node`, the tip. That tip is the whole completion signal:

- **text** — tip is `author.role: "assistant"`, `content_type: "text"`, and
  either `metadata.is_complete: true` or `status: "finished_successfully"` with
  `end_turn: true`. `is_complete` alone is not enough: some finished answers
  never get it (nor `finish_details`), and waiting for it ran a 2.8s answer out
  to the full 120s timeout. A `recipient` other than `"all"` means the message
  is addressed to a tool and the turn is still in flight.
- **generated images** — the image lives in a `role: "tool"` /
  `multimodal_text` message which is *not* the tip: after image gen the tip is
  an assistant text message with `parts: [""]`, the invisible code stub, and it
  is the thing carrying `is_complete`. So walk `parent` back from the tip to the
  turn's user message, collecting `image_asset_pointer` parts on the way. (The
  walk stops at the user message because that is where *uploaded* images sit.)
- An asset pointer is `sediment://file_…`; strip the scheme and
  `GET /backend-api/files/<file-id>/download` returns a signed `download_url`
  plus the real `file_name`. The signature is not enough on its own — that URL
  still 403s without the bearer + cookie.

Two traps worth knowing:

- An answer rendered as a writing block arrives fenced —
  `:::writing{variant="standard" title="…"}` … `:::`. That is presentation:
  strip it, or the canvas title ends up glued to the first line.
- Web-search answers embed citation spans in U+E200..U+E202. Strip the span and
  the stray marker characters, or `citeturn0search12` ends up in the text.

### send performance

Local work per send is cheap: PoW typically settles in under 1 ms, the
sentinel round-trip pays two HTTP latencies, and nothing waits on a browser.
Everything else is server-bound — the model generating the answer, same as the
web UI (short answers ~4–7 s, image gen ~1 min). `--time` prints the
breakdown.

```bash
node cli.mjs send --account me "7+7は？" "8+8は？" --same-chat --time
#  14 / 16
#  [timing] p1(sentinel 420ms, firstToken 310ms, stream 4830ms, pow 1 iter / <1ms) · p2(...)
```

### Serializing daemon (optional)

A per-account Unix socket (0600) that fronts `send` so parallel bursts don't
race on the sentinel token mint. One in-flight send at a time per daemon.

```bash
opengpt send --account me --daemon "…"     # start one on demand, reuse after
opengpt daemon --account me status
opengpt daemon --account me stop
opengpt daemon --account me start --idle 0 # run in foreground, never expire
```

The daemon no longer holds a browser (it used to, back when `send` drove the
composer); it costs almost nothing idle and exits after 300s idle by default
(`--idle <sec>`, `0` disables, `OPENGPT_DAEMON_IDLE` sets the default).
`--no-daemon` on a single send bypasses it. A future revision could cache the
chat-requirements-token for its 540s TTL here; right now it just serializes.

## Setup

```bash
npm install            # cloakbrowser + playwright-core (Chromium is shared via ~/.cloakbrowser)
```

cloakbrowser is still a dependency because **login** uses it to run the
interactive sign-in. After that one-time step, nothing else touches a browser
until the login expires (months).

## Usage

```bash
# 1. Log in. Reuse an existing webtrace profile that is already signed in:
node cli.mjs login --profile google --account me
#    A fresh profile → sign in by hand once:
node cli.mjs login --profile mynew --account me --headed --wait 120000

# 2. Call the API (pure HTTP):
node cli.mjs whoami  --account me
node cli.mjs models  --account me
node cli.mjs plan    --account me
node cli.mjs convos  --account me --limit 10
node cli.mjs get     --account me <conversation-id>
node cli.mjs api     --account me GET /backend-api/me --raw

# 3. Refresh the bearer when it expires (it lasts ~days):
node cli.mjs refresh --account me

# 4. Send prompts (pure HTTP). Batch = one sentinel-mint amortized:
node cli.mjs send    --account me "7+8は？" "日本の首都は？" --time
```

`--profile` takes a bare name (resolved against `~/.claude/skills/webtrace/profiles/`)
or a path. Override with `OPENGPT_PROFILE_ROOT` / `OPENGPT_AUTH_DIR`.

### Does not disturb an open browser

`login` is the only command that opens the profile. If the profile is **busy**
(a live browser holds it), login re-mints the bearer over HTTP instead
(`mode: refreshed-over-http`, no browser launched); only a genuine first-time
login needs the profile free once. Everything else — `send`, every read,
`refresh`, the daemon — is pure Node HTTP and never touches the profile at
all. Rotated cookies (cf_bm, etc.) are written back after each `send`.

The persistent-launch path (`login`) refuses to start over a *live* profile
(naming the pid) and auto-cleans a *stale* lock left by a crash.

## Projects

Projects are gizmos with `gizmo_type: "snorlax"`. All of these were already
pure HTTP before the send rewrite:

| Operation | Endpoint |
| --- | --- |
| list | `GET /backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=N` |
| create | `POST /backend-api/projects` `{instructions, name, memory_scope}` |
| show | `GET /backend-api/gizmos/<gid>?include_file_limits=true` (also lists sources) |
| update | `PATCH /backend-api/projects/<gid>` `{name, instructions, emoji, theme[, memory_scope]}` |
| delete | `DELETE /backend-api/gizmos/<gid>` → `{"deleted": true}` |
| chats in it | `GET /backend-api/gizmos/<gid>/conversations?cursor=0` |
| move a chat | `PATCH /backend-api/conversation/<id>` `{gizmo_id}` (`null` moves it out) |
| add a source | 4 steps, see below |

`PATCH /backend-api/projects/<gid>` is a **full replace** of
`name`/`instructions`/`emoji`/`theme` — a partial body 422s — so `project set`
reads the current project first and fills in whatever you did not pass.

### Memory scope

The UI's two settings are one field, `memory_scope`:

| UI | `memory_scope` | `memory_enabled` |
| --- | --- | --- |
| デフォルトメモリ (shared both ways) | `global` | `true` |
| プロジェクト限定メモリ | `project_v2` | `false` |

The web client posts `"unset"` on create and the server resolves it to `global`.
`--memory project` on create works directly — no second call needed.

### Adding a source file

Four requests, exactly as the web client does them:

1. `POST /backend-api/files` `{file_name, file_size, use_case:"agent", gizmo_id,
   mime_type, entry_surface:"project_sources", store_in_library:true, …}`
   → `{upload_url, file_id}` (presigned Azure blob)
2. `PUT <upload_url>` — the bytes, with `x-ms-blob-type: BlockBlob` and
   `x-ms-version: 2020-04-08`. No auth; the URL is presigned.
3. `POST /backend-api/files/process_upload_stream` — JSONL progress events. The
   `library_file_id` you need next arrives as `extra.metadata_object_id`, not as
   a field of its own. `index_for_retrieval` is `true` for text-ish files and
   `false` for images, matching the web client.
4. `POST /backend-api/projects/<gid>/files` `{files:[{file_id, name, size, type,
   last_modified, library_file_id, location:"fs"}]}` — `last_modified` must be an
   **integer** ms epoch; a fractional `mtimeMs` 422s.

### Usage

```bash
opengpt projects --account me [--limit 20]

opengpt project new   --account me "研究ノート" --instructions "1行で答えて" --memory project
opengpt project show  --account me g-p-xxxx
opengpt project set   --account me g-p-xxxx --memory default --instructions "…"
opengpt project files --account me g-p-xxxx
opengpt project add   --account me g-p-xxxx ./notes.md ./data.csv
opengpt project chats --account me g-p-xxxx
opengpt project move  --account me <conversation-id> g-p-xxxx    # in
opengpt project move  --account me <conversation-id> none        # back out
opengpt project rm    --account me g-p-xxxx

# start a new chat inside a project
opengpt send --account me --project g-p-xxxx "source.txt には何と書いてある？"
```

`--instructions-file <path>` reads the project instructions from a file.

### Continuing a chat inside a project

`send` continues the most recently updated chat by default — scoped to the
project when `--project` is given, the account's newest otherwise:

```bash
# separate invocations, same thread. No ids to track.
opengpt send --account me --project g-p-xxxx "さっきの1本目、もう少し短く。"
opengpt send --account me --project g-p-xxxx "じゃあ2本目も同じ長さに。"

# a new topic deserves a new chat
opengpt send --account me --project g-p-xxxx --new "夕方の投稿を1本。"

# several turns in one invocation — one sentinel-mint, one conversation
opengpt send --account me --project g-p-xxxx --same-chat \
  "平日の夜の投稿を3本。" "3本目、地元の店の話に差し替えて。"

# or name the conversation explicitly. --project is not needed: the id is
# enough, and the project's instructions and sources still apply.
opengpt send --account me --conversation 6aa591bf-… "3番だけもう少し短く。"
```

The default used to be a fresh chat per invocation, which left a dozen
near-identical threads in the sidebar after a day of tweaking one set of posts.
`--new` is the opt-out, and it is also what happens automatically when the
project has no chats yet.

`--show-id` prints each conversation id to stderr, `--json` returns it per
result, and `project chats <gid>` lists every conversation in the project.

## Back-and-forth chat (`chat`)

A per-account named-session wrapper around `send` for interactive use — each
session keeps its own ChatGPT conversation on disk, so parallel threads (work,
personal, …) don't collide and a direct exchange never lands in whatever
"most recent" thread `send` would otherwise continue.

```bash
# default session (one shared thread per account)
opengpt chat --account me "今日の予定を3つ"
opengpt chat --account me "最後のやつ、もう少し詳しく"   # continues the same thread

# named sessions — each has its own thread
opengpt chat --account me --session work "週報の下書き"
opengpt chat --account me --session personal "ジムの進捗まとめて"

# reset a session to a fresh thread
opengpt chat --account me --session work --new "新しいお題"

# list every session you have and the thread each one points at
opengpt chat --account me --list

# compact: summarise the session's current thread, start a new one seeded with
# the summary, re-point the session at it. Context kept, growth reset.
opengpt chat --account me --session work --compact
opengpt chat --account me --session work --compact "次はこれ"   # also sends a first message
```

Session state lives in `auth/.chat-<account>[-<session>].json` (`chmod 600`).

The `/openg` slash command in `commands/openg.md` is a thin wrapper over this:
`<message> [--session <name>] [--new]` prints only ChatGPT's reply.

## Accounts

```bash
opengpt accounts            # list every saved account
opengpt accounts --status   # per-account bearer status (fresh / expired / dies in Nd)
```

Each `<account>` names one `auth/<account>.json` blob. First-time setup is one
`opengpt login --profile <name> --account <account> --headed`; after that every
command takes `--account <name>`.

## Driving ChatGPT as a worker (orchestration)

ChatGPT can't host Claude Code skills/MCP — it only runs its own side. The model
is: **Claude Code selects the instructions and passes them into the prompt**;
opengpt is the pipe. `send` has the primitives for that:

```bash
# inject instructions (e.g. a selected skill's text) and get structured output
opengpt send --account me --system "You answer only in haiku." "about summer" --json
#   → { "results": [{ "text": "...", "conversationId": "6a8d..." }], "timings": {...} }

# continue that same thread later (context — incl. the instructions — persists)
opengpt send --account me --conversation 6a8d3f24-... "now autumn"

# read the instructions from a file, and/or route to a specific Custom GPT
opengpt send --account me --system-file ./skill.md --gpt g-xxxx "do the task"
```

- `--system <text>` / `--system-file <path>` — prepend instructions to each prompt.
- `--json` — `[{text, conversationId}]` + timings, for a program to consume.
- `--conversation <id>` — continue an existing thread (verified: the thread keeps
  its earlier instructions and context).
- `--gpt <gizmo-id>` — route to a Custom GPT. Body-only (`conversation_mode:
  {kind: "gizmo_interaction", gizmo_id}`); verified against both `g-p-...`
  (projects) and bare `g-...` (public Custom GPTs).
- `--show-id` — print each reply's conversation id to stderr.

### Image generation

`send` handles image-gen prompts too. Both the result and the download are pure
HTTP: the asset pointers come out of the conversation (see **Reading a turn
out of the conversation** above), `images[]` carries `{id, mime, width, height}`
per image, and `--save-images <dir>` resolves each id through
`/backend-api/files/<id>/download` and fetches it with the bearer + cookie.

```bash
opengpt send --account me "黄色い花の画像を1枚生成して" --save-images ./out
#   [image saved] ./out/<conversation-id>-xxxxxxxxxxxx.png
```

Image generation is gated by the account: some free accounts show "image
creation unavailable", and free accounts have a daily image cap.

### Image input (vision)

`--image <path>` uploads image file(s) with the prompt so ChatGPT can analyze
or edit them. Comma-separate for several. The upload is a 3-step `/backend-api/files`
flow:

1. `POST /backend-api/files` with `use_case: "multimodal"` → `{upload_url, file_id}`
2. `PUT <upload_url>` with `x-ms-blob-type: BlockBlob` + the raw bytes
3. `POST /backend-api/files/process_upload_stream` → NDJSON; wait for
   `file.processing.completed` and read `extra.library_file_name` + `metadata_object_id`

Each image is spliced into `messages[0].content.parts` as
`image_asset_pointer` *before* the prompt text, and also listed in
`metadata.attachments` with its dimensions.

```bash
opengpt send --account me --image ./photo.png "この画像を1文で説明して"
opengpt send --account me --image a.png,b.png "2枚の違いは？"
```

### File attachments (documents)

`--file <path[,...]>` attaches documents — pdf, txt, csv, md, docx, xlsx… — to
the chat message. Same 3-step upload with `use_case: "my_files"` (`index_for_retrieval:
true`, so the doc is RAG-indexed). Docs show up only in
`metadata.attachments`, not in `content.parts`.

```bash
opengpt send --account me --file ./規程.txt "添付の宿泊費上限を数字だけで答えて"
#   9800
opengpt send --account me --file ./big.txt,./code.txt "添付は何ファイル？"
```

Use this for a one-off document in a single chat. For material that several
chats should share, upload it as a project source instead (`project add`) —
see [Projects](#projects).

ChatGPT only *reasons/generates* (plus its own tools like image-gen); it can't run
Claude's Bash/MCP. To have it act on tool output, run the tool in Claude Code and
pass the result into the prompt.

## Error codes

Errors from `send` surface with a `code` property when the CLI's retry logic
or the daemon needs to key off them:

| Code | What happened | What the CLI does |
| --- | --- | --- |
| `AUTH_EXPIRED` | 401 even after re-minting the bearer, or the saved session is dead | retries `send` without `--conversation` once, otherwise exits with a login prompt |
| `RATE_LIMITED` | 429 from `/f/conversation` | surfaces to stderr; the daemon doesn't poison the serializer on this one |

## Testing

```bash
OPENGPT_AUTH_DIR=~/.claude/plugins/data/opengpt-skills-dir/auth \
  node test/test-send.mjs <account>
```

Thirteen cases cover: basic send, continuation, same-chat batches, system
prompt, image/doc attach, project send + continuation + attach, bare Custom
GPT, daemon socket round-trip, 429/401 error-code propagation.

## Files

```
cli.mjs           arg parsing + subcommands
src/config.mjs    paths, base URL, client headers
src/auth.mjs      login / save / load / refresh, cookie serialization, JWT expiry
src/browser.mjs   cloakbrowser persistent-context wrapper — login only now
src/http.mjs      Node HTTP with browser fallback on Cloudflare block
src/send.mjs      pure-HTTP send: sentinel flow + PoW + SSE + attachments + gizmo
src/daemon.mjs    Unix-socket single-flight gate for parallel sends
src/projects.mjs  projects endpoints
test/test-send.mjs 13-case smoke suite
auth/             saved <account>.json (gitignored — contains cookies + bearer)
```

## Security

`auth/<account>.json` holds live session cookies and a bearer token — treat it
like a password. It is gitignored and written `chmod 600`. Only calls the
account you logged in as; it does not create accounts.
