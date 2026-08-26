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
the logged-in profile's real page (which mints all three itself) and reads the
streamed reply. It is the one command that needs a browser. This does not defeat
the challenge — the real client solves it; we read the answer.

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

`send` handles image-gen prompts too. The result arrives in a `role="tool"`
message (the trailing `assistant` turn is an invisible code stub), so `send`
detects completion via the rendered image, returns the asset URL(s) in
`images[]`, and with `--save-images <dir>` downloads them through the live
browser context — the URLs 403 with "File stream access denied" without the
bearer + cookies. Verified: terminates in ~35s and saves one PNG per image.

```bash
opengpt send --account me "黄色い花の画像を1枚生成して" --save-images ./out
#   [image saved] ./out/<conversation-id>-0-0.png
```

Image generation is gated by the account: some free accounts show "image
creation unavailable", and free accounts have a daily image cap.

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
