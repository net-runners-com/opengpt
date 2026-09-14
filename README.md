# opengpt

Call the ChatGPT web **backend-api** directly from the command line, reusing a
browser profile you have already signed into. Built from the traffic captured
with the `webtrace` skill.

Auth is a first-class feature: `login` once, the cookies + bearer are saved to
`auth/<account>.json`, and every later call is plain Node HTTP — no browser.

## What works over pure HTTP (Bearer + cookies)

| Command | Endpoint |
| --- | --- |
| `whoami` | `GET /backend-api/me` |
| `plan`   | `GET /backend-api/accounts/check/v4-2023-04-27` |
| `models` | `GET /backend-api/models` |
| `convos` | `GET /backend-api/conversations` |
| `get <id>` | `GET /backend-api/conversation/<id>` |
| `api <M> <path>` | any endpoint |
| `refresh` | `GET /api/auth/session` → new bearer from the session cookie |

Verified live against a logged-in account: all of the above return 200 from
Node's `fetch` — Cloudflare does not challenge authenticated XHR that carries a
valid bearer. If it ever does, every read command auto-falls back to the
profile's browser network stack (`--via auto`, the default).

## What does NOT work over pure HTTP

`send` (POST `/backend-api/f/conversation`). The send endpoint requires three
tokens the page computes in obfuscated JS:

- `openai-sentinel-proof-token` — a proof-of-work answer
- `openai-sentinel-turnstile-token` — a **Cloudflare Turnstile** token
- `x-conduit-token`

A Turnstile token cannot be minted from Node. So `send` drives the composer in
the logged-in profile's real page (which mints all three itself). It is the one
command that needs a browser. This does not defeat the challenge — the real
client solves it; we read the answer.

Pure-code PoW solvers exist and still work
([leetanshaj/openai-sentinel](https://github.com/leetanshaj/openai-sentinel),
[lanqian528/chat2api](https://github.com/lanqian528/chat2api)), but the Turnstile
stage is the one that no longer completes outside a browser, so a browser in the
loop is the state of the art for this shape of tool — the same conclusion
[Octo-Lex/ChatGPT-Web2API](https://github.com/Octo-Lex/ChatGPT-Web2API) reaches.
What is worth minimising is how much of the browser we depend on.

### What the browser is actually for

Submitting the prompt, and nothing else. Everything the turn *produces* comes
back over plain HTTP:

| | how |
| --- | --- |
| put the prompt in and submit it | **DOM** — `#prompt-textarea`, then Enter, falling back to the send button |
| know the turn started | **DOM** — stop button, or the turn count going up |
| know the turn finished | **network** wakes it — this turn's `POST /backend-api/f/conversation` stream closing; **API** confirms — the conversation tip |
| the answer text | **API** — `GET /backend-api/conversation/<id>` |
| generated images | **API** — `image_asset_pointer` parts |
| download those images | **API** — `GET /backend-api/files/<file-id>/download` |
| know an attachment finished uploading | **network** — a finished `process_upload_stream` per file |
| pick which file input to use | **DOM** — `#upload-files` vs the photo input |

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

- While a turn is in flight the SPA parks a **placeholder id** in the URL,
  `WEB:<uuid>`. The API answers that with `400 Invalid conversation`, and a
  1.5s poll on it earns a `429`. Only accept a real uuid.
- Conversation reads share one rate limit with the page's own sidebar history.
  Poll `GET /backend-api/conversation/<id>` steadily across a burst of sends and
  the page puts a `modal-conversation-history-rate-limit` over the composer,
  which stays up for 15+ minutes. So `send` reads the tip once when the
  turn's stream closes (1s → 2s → 4s back-off if it isn't committed yet), and
  polls only every 6s while the stream is still open.
- An answer rendered as a writing block arrives fenced —
  `:::writing{variant="standard" title="…"}` … `:::`. That is presentation:
  strip it, or the canvas title ends up glued to the first line.

### send performance (measured, logged-in `google` profile, headless)

The dominant fixed cost is **browser launch (~1.1 s) + page load (~1.4 s)**,
paid once per `send`. Batching several prompts into one `send` amortizes it.
Two batch modes:

| | between prompts | 2nd prompt → first token | when to use |
| --- | --- | --- | --- |
| default | fresh chat via `goto /` (~1.4 s) | ~0.55 s | independent prompts |
| `--same-chat` | nothing (one conversation) | **~0.06 s** | follow-ups / shared context |

Per-prompt generation (Enter → done) is server-bound: ~4–7 s for a short answer,
identical to the web UI. `--time` prints the breakdown.

```bash
node cli.mjs send --account me "7+7は？" "8+8は？" --same-chat --time
#  14 / 16
#  [timing] launch 1181ms · load 1162ms · p1(first 573ms, done 4993ms) · p2(first 60ms, done 5371ms)
```

`--lean` blocks images/fonts/ads. It saves bandwidth/CPU on long batches but
does **not** cut latency: `send` waits for `domcontentloaded` + the composer,
and blocked assets load after that anyway, so it's off by default. The
challenge widget host (`challenges.cloudflare.com`) and all app/API hosts are
never blocked.

### Warm daemon (optional)

`send` pays browser launch + SPA boot every time — measured 1.5s + 3.2s. A
daemon holds one warm page so navigation happens in-page instead:

```bash
opengpt send --account me --daemon "…"     # starts one on demand, reuses it after
opengpt daemon --account me status
opengpt daemon --account me stop
opengpt daemon --account me start --idle 0 # run it in the foreground, never expire
```

| | cold | via daemon |
| --- | --- | --- |
| browser launch | ~1500ms | **0ms** |
| navigation | 1650–3200ms | **3–35ms** |
| generation | 4.5–8s | unchanged (server-bound) |

Everything left is the model generating, so this is the floor.

**It exits after 300s idle** (`--idle <sec>`, `0` disables,
`OPENGPT_DAEMON_IDLE` sets the default). That matters: while it runs it holds
~570MB and the single free cloakbrowser session, so **webtrace cannot launch**.
Letting it expire gives both back (measured: 573MB → 0MB once the timer fired).
`--no-daemon` on a single send bypasses it.

Measure this with `footprint -p <pid>`, not by summing `ps -o rss` across the
Chromium processes — RSS counts shared pages once per process, which overstated
the total by ~35% (885MB summed vs 573MB real).

Where it goes, and what does *not* move it:

| | phys_footprint |
| --- | --- |
| browser process with no page | ~460MB |
| + chatgpt.com loaded | ~573MB |
| `--lean` (blocks images/fonts/ads) | 564MB vs 561MB — **no effect** |
| page dropped to `about:blank` | ~400MB, and waking costs 3.4s |

`--lean` is kept for bandwidth, not memory. Hibernating the page to
`about:blank` frees about a third but keeps the session seat and makes waking
as expensive as a cold start, so exiting outright wins on every axis.

Two details worth knowing if you touch this code:

- The page is reused across sends, so it accumulates state — a writing block
  leaves a second `contenteditable` behind, long threads re-mount the composer.
  It force-reloads every 20 sends (`OPENGPT_DAEMON_RESET_AFTER`) and after any
  error.
- In-page routing needs `pushState` **plus** a dispatched `popstate` event —
  `pushState` alone changes the URL and leaves the old conversation rendered,
  because the router listens for the event (verified: turns 10 → 0 only with
  it). Navigating to the conversation you are already in is a no-op, compared
  by conversation id: inside a project the URL is `/g/<gid>/c/<id>` while the
  target is built as `/c/<id>`, and a string compare there cost 11s per send.
- It listens on a Unix socket (0600), not a TCP port — a live authenticated
  session behind `localhost:NNNN` would be usable by anything on the machine.

### Runs in parallel with an open browser — never disturbs it

You can keep a browser open on the profile and use every command at the same
time. Nothing here ever hijacks or closes that browser.

- `send`, all reads, and `refresh` never open the persistent profile at all —
  they use a throwaway (non-persistent) context seeded with the cookies in
  `auth/<account>.json` (or plain Node HTTP). No `userDataDir` → no Chromium
  `SingletonLock`, no stale-lock cleanup, no conflict with your open browser.
  Rotated cookies (cf_bm, etc.) are written back after each `send`.
- `login` is the only command that would open the profile. If the profile is
  **busy** (a live browser holds it), login does not fight for it: with saved
  auth it re-mints the bearer over HTTP (`mode: refreshed-over-http`, no browser
  launched); only a genuine first-time login needs the profile free once.
- The persistent-launch path refuses to start over a *live* profile (naming the
  pid) and auto-cleans a *stale* lock left by a crash.

Hard limit worth knowing: the **free cloakbrowser binary allows one concurrent
session**, so two `send`s can't truly run at the same instant — run them
sequentially (lock-free, no cleanup needed). A Pro license lifts the cap.
cloakbrowser also encrypts its own cookie store with a key that isn't the
standard macOS keychain entry, so cookies can't be harvested from a live profile
without a browser — which is why first-time `login` needs the profile free once.

## Setup

```bash
npm install            # cloakbrowser + playwright-core (Chromium is shared via ~/.cloakbrowser)
```

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

# 4. Send prompts (browser-assisted, see note above). Batch = one warm browser:
node cli.mjs send    --account me "7+8は？" "日本の首都は？" --time
```

`--profile` takes a bare name (resolved against `~/.claude/skills/webtrace/profiles/`)
or a path. Override with `OPENGPT_PROFILE_ROOT` / `OPENGPT_AUTH_DIR`.

## Projects

Projects are gizmos with `gizmo_type: "snorlax"`. Everything below runs over
**pure HTTP** — the endpoints take only `authorization` + `cookie`, no sentinel
proof-of-work and no Turnstile, so no browser is launched. Captured with the
`webtrace` skill and verified live end-to-end.

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

# start a new chat inside a project (browser path, same as --gpt)
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

# several turns in one invocation — one browser, one conversation
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
- `--gpt <gizmo-id>` — route to a Custom GPT (navigates to `/g/<id>`; best-effort).
- `--show-id` — print each reply's conversation id to stderr.

### Image generation

`send` handles image-gen prompts too. Both the result and the download are pure
HTTP now: the asset pointers come out of the conversation (see **Reading a turn
out of the conversation** above), `images[]` carries `{id, mime, width, height}`
per image, and `--save-images <dir>` resolves each id through
`/backend-api/files/<id>/download` and fetches it with the bearer + cookie. No
browser is involved past the submit. Measured: 77s for one image end to end.

```bash
opengpt send --account me "黄色い花の画像を1枚生成して" --save-images ./out
#   [image saved] ./out/<conversation-id>-0-0.png
```

Image generation is gated by the account: some free accounts show "image
creation unavailable", and free accounts have a daily image cap.

### Image input (vision)

`--image <path>` uploads image file(s) with the prompt so ChatGPT can analyze
or edit them. Comma-separate for several. The upload target is the composer's
photo input; `send` waits for the upload to finish before submitting. Verified:
a photo + "describe this" returns the description (uploaded images are excluded
from the result so they aren't mistaken for a generated one).

```bash
opengpt send --account me --image ./photo.png "この画像を1文で説明して"
opengpt send --account me --image a.png,b.png "2枚の違いは？"
```

### File attachments (documents)

`--file <path[,...]>` attaches documents — pdf, txt, csv, md, docx, xlsx… — to
the chat message. It uses the composer's unrestricted file input
(`#upload-files`); `--image` stays on the photo input, and the two can be
combined.

```bash
opengpt send --account me --file ./規程.txt "添付の宿泊費上限を数字だけで答えて"
#   9800
opengpt send --account me --file ./big.txt,./code.txt "添付は何ファイル？"
```

Waiting for the upload here is **not** a DOM check. The file chip renders the
moment the file is selected (~0.6 s) while the bytes are still uploading, and
no spinner or disabled send button ever appears — on a 4.7 MB txt the chip was
up at 0.6 s but `POST /backend-api/files` only fired at 11.1 s and
`process_upload_stream` at 12.4 s. Submitting on the chip would silently drop
the attachment, so `send` instead waits for one **finished**
`process_upload_stream` response per file.

Use this for a one-off document in a single chat. For material that several
chats should share, upload it as a project source instead (`project add`) —
see [Projects](#projects).

Completion is detected by result stability, not only the stop button — some
responses (image analysis in particular) leave the stop button in the DOM after
the answer is complete.

ChatGPT only *reasons/generates* (plus its own tools like image-gen); it can't run
Claude's Bash/MCP. To have it act on tool output, run the tool in Claude Code and
pass the result into the prompt.

## Files

```
cli.mjs          arg parsing + subcommands
src/config.mjs   paths, base URL, client headers
src/browser.mjs  cloakbrowser persistent-context wrapper
src/auth.mjs     login / save / load / refresh, cookie serialization
src/http.mjs     Node HTTP with browser fallback on Cloudflare block
src/send.mjs     browser-assisted prompt send
auth/            saved <account>.json (gitignored — contains cookies + bearer)
```

## Security

`auth/<account>.json` holds live session cookies and a bearer token — treat it
like a password. It is gitignored and written `chmod 600`. Only calls the
account you logged in as; it does not create accounts.
