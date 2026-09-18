// Sending a prompt is the ONE thing pure HTTP cannot do: POST /backend-api/
// f/conversation requires openai-sentinel-proof-token (proof-of-work) and
// openai-sentinel-turnstile-token (Cloudflare Turnstile), both computed by the
// page's obfuscated JS. This does NOT bypass them — it lets the real logged-in
// page mint them by driving the composer, then reads the streamed answer.
//
// Orchestration: `system` prepends instructions (e.g. a selected Claude Code
// skill), each result carries its conversationId so a caller can continue a
// thread (`conversationId` input), and `gizmo` routes to a specific Custom GPT.
import fs from "node:fs";
import path from "node:path";
import { BASE } from "./config.mjs";
import { loadAuth, saveAuth } from "./auth.mjs";
import { openEphemeral } from "./browser.mjs";
import { api, authHeaders } from "./http.mjs";

const now = () => performance.now();
const ASSISTANT = '[data-message-author-role="assistant"]';
// A model turn is either an assistant message or a tool message (image gen and
// other tool output arrive as role="tool").
const TURN = '[data-message-author-role="assistant"], [data-message-author-role="tool"]';
const STOP_BTN = 'button[data-testid="stop-button"]';
const RATE_LIMIT_MODAL = '[data-testid="modal-conversation-history-rate-limit"]';
const LOGGED_OUT = '#modal-no-auth-login, [data-testid="login-button"]';
// Only exists once the composer has text — the fallback for a swallowed Enter.
const SEND_BTN = 'button[data-testid="send-button"], #composer-submit-button';

// The prompt box is #prompt-textarea. Do NOT reach for it with a comma
// selector: a conversation that rendered an answer as a writing block has a
// SECOND contenteditable — the canvas editor — and it comes first in DOM order,
// so `.first()` types the prompt into the canvas and the send never happens.
async function readyComposer(page) {
  const composer = page.locator("#prompt-textarea").first();
  try {
    await composer.waitFor({ state: "visible", timeout: 20000 });
    return composer;
  } catch {
    // Older/alternate layouts: any contenteditable inside the composer form.
    const alt = page.locator('form div[contenteditable="true"]').first();
    await alt.waitFor({ state: "visible", timeout: 10000 });
    return alt;
  }
}

// The conversation id lives in the URL as /c/<id> once a turn starts — but
// while the turn is in flight the SPA parks a PLACEHOLDER there, "WEB:<uuid>".
// The API rejects that with 400 ("Invalid conversation WEB:…") and answers a
// burst of retries with 429, so only a real uuid counts.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function convIdFromUrl(page) {
  const m = /\/c\/([^/?#]+)/.exec(page.url());
  return m && UUID.test(m[1]) ? m[1] : null;
}

// Attach file(s) to the composer.
//
// Two inputs: #upload-files takes anything (accept=null), the photo input only
// image/*. Images go through the photo input because that is what produces an
// image attachment rather than a document.
//
// Completion is a NETWORK fact, not a DOM one. The chip or thumbnail renders
// the instant the file is *selected* (~0.6s) while the bytes are still going up
// — on a 4.7 MB txt, POST /backend-api/files fired at 11.1s and
// process_upload_stream at 12.4s — and no spinner or disabled send button ever
// appears. Submitting on the chip silently drops the attachment, so wait for
// one finished process_upload_stream per file, with the old thumbnail check
// kept only as a fallback for uploads that never stream.
const PHOTO_INPUT = 'input[data-testid="upload-photos-input"], input[type="file"][accept="image/*"]';
const ANY_INPUT = "#upload-files";

async function attachFiles(page, files, { images = false, timeoutMs }) {
  const uploads = [];
  const onResp = (r) => {
    if (/\/backend-api\/files\/process_upload_stream/.test(r.url())) {
      uploads.push(r.finished().catch(() => {}));
    }
  };
  page.on("response", onResp);
  try {
    await page.locator(images ? PHOTO_INPUT : ANY_INPUT).first().setInputFiles(files);
    const deadline = Date.now() + timeoutMs;
    while (uploads.length < files.length && Date.now() < deadline) await page.waitForTimeout(200);
    if (uploads.length >= files.length) {
      await Promise.all(uploads);
      return;
    }
    if (!images) throw new Error(`file upload did not finish (${uploads.length}/${files.length} processed)`);
    // Images: some uploads settle without a process_upload_stream. Fall back to
    // the rendered preview, which at least proves the client accepted them.
    await page.waitForFunction(
      (n) => {
        if (document.querySelector('[role="progressbar"], .animate-spin, svg.animate-spin')) return false;
        return [...document.querySelectorAll("img")].filter((im) => /blob:|oaiusercontent|estuary/.test(im.src)).length >= n;
      },
      files.length,
      { timeout: 30000 },
    );
  } finally {
    page.off("response", onResp);
  }
}

// ── the answer, read from the API rather than the page ──────────────────────
//
// The DOM is a poor source for the text: an answer rendered as a writing block
// carries the canvas title and the follow-up suggestion chips in the same turn,
// and the text keeps rendering after the stop button is gone. GET
// /backend-api/conversation/<id> has the real thing — the message parts plus
// metadata.is_complete — and it is a plain Bearer call, no browser needed.
//
// A writing block arrives fenced, which is presentation, not content:
//   :::writing{variant="standard" id="58322" title="短くした2本目"}
//   夜ごはんを作り終わると、…
//   :::
const WRITING_FENCE = /^:::writing\{[^}]*\}\s*\n([\s\S]*?)\n?:::\s*$/;
function unfence(s) {
  const m = WRITING_FENCE.exec(s.trim());
  return (m ? m[1] : s).trim();
}

// The tip of the conversation: {nodeId, text, images, complete}.
//
// `current_node` is the authoritative tip, so there is no "newest by timestamp"
// guesswork. What finishes a turn depends on what the turn produced:
//   - text            assistant / content_type "text" / metadata.is_complete
//   - generated image tool / "multimodal_text" holding image_asset_pointer parts
//     (image gen leaves no is_complete anywhere — the tool message IS the end,
//     and the trailing assistant turn is an invisible code stub)
// recipient !== "all" means the message is addressed to a tool, i.e. the turn is
// still mid-flight.
export async function apiAnswer(account, convId, via) {
  const d = await api(account, "GET", `/backend-api/conversation/${convId}`, { via });
  const nodeId = d.current_node;
  const map = d.mapping || {};
  const tip = map[nodeId]?.message;
  if (!tip) return { nodeId, text: "", images: [], complete: false };
  const toUser = (m) => (m.recipient || "all") === "all";

  // Images live in a tool message that is NOT the tip: after image gen the tip
  // is an assistant text message with parts [""] — the invisible code stub —
  // carrying is_complete. So walk back from the tip to this turn's user message
  // and collect every asset pointer on the way. (Uploads sit in the user
  // message itself, which is why the walk stops there rather than including it.)
  const images = [];
  for (let id = nodeId, hops = 0; id && hops < 12; hops++) {
    const m = map[id]?.message;
    if (m?.author?.role === "user") break;
    for (const part of m?.content?.parts || []) {
      if (part && typeof part === "object" && part.content_type === "image_asset_pointer") {
        const fid = String(part.asset_pointer || "").replace(/^[a-z]+:\/\//, ""); // sediment://file_… → file_…
        if (fid) images.unshift({ id: fid, mime: part.mime_type || "image/png", width: part.width, height: part.height });
      }
    }
    id = map[id]?.parent;
  }

  let text = "";
  if (tip.author?.role === "assistant" && tip.content?.content_type === "text" && toUser(tip)) {
    text = unfence((tip.content.parts || []).filter((p) => typeof p === "string").join("\n").trim());
  }

  // Done when the tip says so, or when the tip IS the image-bearing tool turn.
  //
  // is_complete is NOT reliable on its own: some finished answers never get it
  // (nor finish_details) — measured 2026-09-13, "8" sat as status
  // finished_successfully + end_turn true with no is_complete, and send waited
  // out its whole 120s timeout on an answer that was done at +2.8s. status and
  // end_turn are on every message; while streaming they read in_progress/null.
  const finished = tip.metadata?.is_complete === true
    || (tip.author?.role === "assistant" && tip.status === "finished_successfully" && tip.end_turn === true)
    || (tip.author?.role === "tool" && toUser(tip) && images.length > 0);
  return { nodeId, text, images, complete: finished && (text.length > 0 || images.length > 0) };
}

// Generated images download over plain HTTP: ask for a signed URL, then fetch it
// WITH the bearer + cookie — the signature alone gives 403.
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
async function downloadAsset(account, fileId, via) {
  const r = await api(account, "GET", `/backend-api/files/${fileId}/download`, { via });
  if (!r.download_url) throw new Error(`no download_url for ${fileId}`);
  const res = await fetch(r.download_url, { headers: await authHeaders(account, { via }) });
  if (!res.ok) throw new Error(`asset ${fileId} → ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), name: r.file_name || fileId };
}

// Send one prompt on an already-open, ready page. Returns {text, images, conversationId, timings}.
async function sendOnPage(page, prompt, { account, via, timeoutMs = 120000, attach = null, docs = null } = {}) {
  const t = {};
  let s = now();
  const composer = await readyComposer(page);
  // Too many history reads — and GET /backend-api/conversation from this CLI
  // counts — and the app lays a modal over the composer. Every click then
  // burns a 30s timeout with a Playwright call log for an error, so say so.
  if (await page.locator(RATE_LIMIT_MODAL).count()) {
    throw Object.assign(
      new Error("ChatGPT is rate-limiting this account (conversation-history modal) — wait a while, or use another account"),
      { code: "RATE_LIMITED" },
    );
  }
  // Saved cookies that no longer hold a web session still load a working
  // composer — logged out. The prompt then goes out as an anonymous chat that
  // never reaches the account (seen 2026-09-13 on an account whose Bearer
  // still worked over HTTP), so refuse rather than answer from the wrong place.
  if (await page.locator(LOGGED_OUT).count()) {
    throw new Error("the ChatGPT page is logged out for this account — run `opengpt login` again");
  }
  await composer.click();
  if (attach?.length) { await attachFiles(page, attach, { images: true, timeoutMs }); t.upload = now() - s; }
  if (docs?.length) { await attachFiles(page, docs, { timeoutMs }); t.upload = now() - s; }
  await composer.click();
  await page.keyboard.insertText(prompt);
  // The composer is React-controlled and occasionally ignores an inserted
  // string when it mounted moments before the click (seen on project pages).
  // Verify the text landed, and retype it as real keystrokes if it did not.
  if (!(await composer.innerText().catch(() => "")).trim()) {
    await composer.click();
    await composer.type(prompt, { delay: 0 });
  }
  t.compose = now() - s;

  // A stop button left over from the previous turn — routine on --same-chat
  // follow-ups, where it outlives the answer — would make the "generation
  // started" gate below pass instantly and hand back the PREVIOUS answer.
  await page
    .waitForFunction((stop) => !document.querySelector(stop), STOP_BTN, { timeout: 15000 })
    .catch(() => {});

  // Baselines captured BEFORE sending: turns, the answer already on screen (so
  // a follow-up cannot return it again), and images already in main (an
  // uploaded attachment counts here so it isn't mistaken for a result).
  const before = await page.locator(TURN).count();
  const prev = await page.evaluate(() => {
    const as = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    for (let i = as.length - 1; i >= 0; i--) {
      const v = as[i].innerText.trim();
      if (v) return { n: as.length, text: v };
    }
    return { n: as.length, text: "" };
  });
  // API-side baseline: remember which node was the tip, so a follow-up cannot
  // hand back the previous answer (which is itself "complete").
  let convId = convIdFromUrl(page);
  // Pre-send tip: a follow-up must not hand back the previous (already-complete)
  // answer. This baseline read shares the conversation rate limit, so retry it a
  // few times — if it stays null on a CONTINUED chat, the API break below would
  // accept the old tip (null !== any nodeId) and return the stale previous
  // answer (seen when rapid testing tripped the read limit).
  const continuing = !!convId;
  let prevNode = null;
  for (let i = 0; continuing && i < 3 && prevNode === null; i++) {
    prevNode = (await apiAnswer(account, convId, via).catch(() => null))?.nodeId ?? null;
    if (prevNode === null) await new Promise((r) => setTimeout(r, 400));
  }
  s = now();

  // This turn's answer stream. Its closing is the moment the answer is done;
  // polling the API alone noticed that up to ~2.4s late (measured: [DONE] at
  // 4.8s, detected at 7.2s). Armed just before Enter so the PREVIOUS turn's
  // stream cannot match — on a warm page it is often still closing ~0.8s into
  // the next send. (/f/conversation/prepare is a different path.)
  let streamClosed = false, streamConv = null, wake = () => {};
  page
    .waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/backend-api/f/conversation",
      { timeout: timeoutMs },
    )
    .then(async (r) => {
      await r.finished();
      // The id is in the stream, for when the URL still holds the WEB: placeholder.
      streamConv = /"conversation_id":\s*"([0-9a-f-]{36})"/.exec(await r.text().catch(() => ""))?.[1] || null;
      streamClosed = true;
      if (process.env.OPENGPT_DEBUG) process.stderr.write(`[dbg] +${Math.round(now() - s)}ms stream closed conv=${streamConv}\n`);
      wake();
    })
    .catch(() => {});
  await page.keyboard.press("Enter");

  // Generation started: the stop button appeared, a new turn rendered, or an
  // image is already present. Image gen doesn't reliably keep an assistant/tool
  // turn in the DOM, so gating on turn-count alone can hang.
  //
  // The Enter is sometimes swallowed — reproducibly on project pages, where the
  // composer mounts late — and the prompt then sits in the box until the whole
  // timeout expires. So wait briefly first, and click the send button before
  // committing to the long wait.
  const started = (ms) =>
    // NOTE: page.waitForFunction takes ONE arg — pass a single object.
    page.waitForFunction(
      ({ n, sel, stop }) =>
        !!document.querySelector(stop) || document.querySelectorAll(sel).length > n,
      { n: before, sel: TURN, stop: STOP_BTN },
      { timeout: ms },
    );
  const grace = Math.min(8000, timeoutMs);
  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    if (attempt > 0) {
      // Re-render can wipe the composer out from under us (long threads under
      // /c/<id> are the usual case), so put the prompt back if it is gone, then
      // prefer the button over another Enter.
      if (!(await composer.innerText().catch(() => "")).trim()) {
        await composer.click();
        await page.keyboard.insertText(prompt);
      }
      const btn = page.locator(SEND_BTN).first();
      if (await btn.count()) await btn.click({ timeout: 5000 }).catch(() => {});
      else await page.keyboard.press("Enter");
    }
    const budget = attempt === 2 ? Math.max(timeoutMs - 2 * grace, 5000) : grace;
    try { await started(budget); sent = true; } catch { /* try again */ }
  }
  if (!sent) throw new Error("generation never started — the prompt was not accepted by the composer");
  t.firstToken = now() - s;

  // Poll for completion. A "result" is a NEW generated image (not in the
  // pre-send baseline, so an uploaded attachment doesn't count) or non-empty
  // assistant text. Finish when generation stopped (stop button gone) with a
  // result, OR when the result is stable for a few polls — the stop button does
  // not reliably disappear for some responses (e.g. image analysis), so relying
  // on it alone hangs. Uses wall-clock, fine in a normal Node process.
  const deadline = Date.now() + timeoutMs;
  let text = "", images = [], lastSig = null, stable = 0;
  let nextApiAt = Date.now() + 6000, apiGap = 1000, closedSeen = false;
  const read = () => page.evaluate(({ prevN }) => {
    const as = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    // When ChatGPT renders an answer as a writing block it appends clickable
    // follow-up suggestions inside the same turn ("もう少し短くする" …). They are
    // UI, not the answer, so drop them before reading the text.
    const body = (el) => {
      let raw;
      const sug = el.querySelector('[data-testid="writing-block-suggested-followups"]');
      if (!sug) raw = el.innerText.trim();
      else {
        const c = el.cloneNode(true);
        c.querySelectorAll('[data-testid="writing-block-suggested-followups"]').forEach((n) => n.remove());
        raw = c.innerText.trim();
      }
      // A reaction affordance ("message_reaction" + 👍/👎) renders inside the turn
      // for a moment while the answer finalizes and otherwise glues onto the
      // front of the text. It is UI, never part of the answer, so drop it.
      return raw.replace(/message_reaction\s*[\u{1F44D}\u{1F44E}]?/gu, "").trim();
    };
    // Read ONLY assistant turns added by THIS send (index >= prevN). Scanning
    // older turns let a follow-up fall back to the previous, already-complete
    // answer while this turn was still empty (thinking) — that read as a stable
    // result and returned the PREVIOUS answer. Reproduced on the warm daemon
    // page, where the reply is fast and this DOM path wins over the API poll.
    let text = "";
    for (let i = as.length - 1; i >= prevN; i--) { const v = body(as[i]); if (v) { text = v; break; } }
    const stop = !!document.querySelector('button[data-testid="stop-button"]');
    return { text, stop };
  }, { prevN: prev.n });

  while (Date.now() < deadline) {
    // Preferred path: ask the API. It reports the finished text and an explicit
    // is_complete, so there is nothing to infer from the page.
    if (!convId) convId = convIdFromUrl(page) || streamConv;
    // The API rate-limits a steady poll (429 — and every warm send adds to the
    // same bucket), so ask it when there is a reason to: right as this turn's
    // stream closes, then backing off 1s → 2s → 4s while the answer commits.
    // While the stream is still open, only a slow fallback poll, for the page
    // that drops its stream while the server finishes the answer anyway.
    if (streamClosed && !closedSeen) { closedSeen = true; nextApiAt = 0; }
    if (convId && Date.now() >= nextApiAt) {
      let err = null;
      const a = await apiAnswer(account, convId, via).catch((e) => { err = e; return null; });
      if (process.env.OPENGPT_DEBUG) {
        process.stderr.write(`[dbg] +${Math.round(now() - s)}ms conv=${convId} node=${a?.nodeId} complete=${a?.complete} imgs=${a?.images?.length}${err ? ` error=${err.message.slice(0, 80)}` : ""}\n`);
      }
      // When the pre-send tip is unknown on a continued chat (baseline read kept
      // failing), nodeId !== null always holds, so the OLD answer would match.
      // Reject it with the pre-send text baseline before accepting completion.
      const stale = continuing && prevNode === null && a?.text && a.text === prev.text;
      if (a?.complete && a.nodeId && a.nodeId !== prevNode && !stale) {
        text = a.text;
        images = a.images;
        break;
      }
      if (err && /→ 429/.test(err.message)) nextApiAt = Date.now() + 8000;
      else if (streamClosed) { nextApiAt = Date.now() + apiGap; apiGap = Math.min(apiGap * 2, 4000); }
      else nextApiAt = Date.now() + 6000;
    }

    const st = await read();
    text = st.text; // already restricted to this send's own turn(s)
    const hasResult = text.length > 0;
    // Always finish on a quiet period, never on the stop button alone: the
    // button disappears before the last of the text renders on multi-item
    // answers (measured — it truncated a 5-post reply mid-sentence). While the
    // button is still up we may be mid-stream on a slow answer, so demand a
    // much longer quiet period there.
    const needed = st.stop ? 8 : 2; // ~12s while generating, ~3s after
    const sig = text;
    if (hasResult && sig === lastSig) { if (++stable >= needed) break; } else stable = 0;
    lastSig = sig;
    // Sleep, but wake the moment the stream closes.
    await new Promise((r) => {
      const tm = setTimeout(r, streamClosed ? 700 : 1500);
      wake = () => { clearTimeout(tm); r(); };
    });
  }
  t.total = now() - s;
  return { text, images, conversationId: convIdFromUrl(page), timings: t };
}

// Where a fresh turn should start. A Custom GPT keeps its /g/<gizmo> context;
// otherwise a new blank chat at /. (The in-app new-chat button sits under the
// sidebar overlay and its click is routinely intercepted, so navigate by URL.)
function freshUrl({ gizmo }) {
  if (!gizmo) return `${BASE}/`;
  // A project (g-p-…) lives at /g/<gid>/project — plain /g/<gid> does not
  // render a usable composer for it. Custom GPTs keep the bare /g/<gizmo>.
  return gizmo.startsWith("g-p-") ? `${BASE}/g/${gizmo}/project` : `${BASE}/g/${gizmo}`;
}

async function gotoAndReady(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await readyComposer(page);
}

// Client-side navigation, for a warm page that is already on chatgpt.com.
// A full goto re-downloads and re-boots the SPA (~1.7s measured); routing
// in-page costs ~50ms. pushState ALONE does not work — the URL changes and the
// old conversation stays rendered — because the router listens for popstate,
// so the event has to be dispatched too (measured: turns 10 → 0).
// Returns false when the page is not somewhere this can work from.
async function softNav(page, url) {
  if (!/^https:\/\/chatgpt\.com/.test(page.url())) return false;
  const target = url.replace(BASE, "") || "/";
  try {
    // Already there — nothing to navigate. Compare by conversation id, not by
    // raw path: inside a project the URL is /g/<gid>/c/<id> while the target is
    // built as /c/<id>, so a string compare misses and softNav would wait out
    // its whole timeout (turns never change) before falling back to a reload.
    const here = new URL(page.url()).pathname;
    const convOf = (u) => (/\/c\/([^/?#]+)/.exec(u) || [])[1] || null;
    const hereConv = convOf(here), wantConv = convOf(target);
    if (wantConv ? hereConv === wantConv : here === target.split("?")[0]) {
      await readyComposer(page);
      return true;
    }
    const before = await page.locator(TURN).count();
    await page.evaluate((t) => {
      window.history.pushState({}, "", t);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    }, target);
    // The route took effect when the old turns are gone (new chat) or replaced.
    await page.waitForFunction(
      ({ sel, n, want }) =>
        location.pathname === want && (document.querySelectorAll(sel).length !== n || n === 0),
      { sel: TURN, n: before, want: target.split("?")[0] },
      { timeout: 8000 },
    );
    await readyComposer(page);
    return true;
  } catch {
    return false;
  }
}

async function navReady(page, url) {
  if (await softNav(page, url)) return;
  await gotoAndReady(page, url);
}

// Batch entry: open the browser once, send every prompt on the warm page.
//   system         prepend instruction text to each prompt (skill content, etc.)
//   conversationId continue an existing thread instead of starting fresh
//   gizmo          route to a specific Custom GPT (gizmo id)
//   sameChat       keep every prompt in one conversation (no nav = fastest)
export async function send({
  account, prompts, headed = false, lean = false, sameChat = false,
  system = null, conversationId = null, gizmo = null, saveDir = null,
  attach = null, docs = null, timeoutMs = 120000, via = "auto",
  // A warm context from the daemon. When given, send() borrows it and leaves
  // it open; otherwise it launches one and closes it on the way out.
  context: borrowed = null,
}) {
  if (typeof prompts === "string") prompts = [prompts];
  const auth = loadAuth(account);
  const timings = { launch: 0, load: 0, perPrompt: [] };
  const frame = (p) => (system ? `${system}\n\n${p}` : p);

  let s = now();
  // Ephemeral context seeded from saved cookies — no persistent profile, so no
  // lock and no conflict with a concurrent run on the same account.
  const context = borrowed || (await openEphemeral(auth, { headed, lean }));
  timings.launch = borrowed ? 0 : now() - s;

  try {
    const page = context.pages()[0] || (await context.newPage());
    s = now();
    // Start on: an existing conversation, a Custom GPT, or a blank chat.
    const start = conversationId ? `${BASE}/c/${conversationId}` : freshUrl({ gizmo });
    // A borrowed page is already on chatgpt.com, so route in-page instead of
    // paying the full SPA boot again.
    if (borrowed) await navReady(page, start);
    else await gotoAndReady(page, start);
    timings.load = now() - s;

    const results = [];
    for (let i = 0; i < prompts.length; i++) {
      if (i > 0 && !sameChat) await navReady(page, freshUrl({ gizmo }));
      const r = await sendOnPage(page, frame(prompts[i]), { account, via, timeoutMs, attach, docs });
      timings.perPrompt.push(r.timings);
      const res = { text: r.text, images: r.images || [], conversationId: r.conversationId };
      // Download generated images through the live context (cookies attached);
      // these URLs 403 with "File stream access denied" without auth.
      if (saveDir && res.images.length) {
        fs.mkdirSync(saveDir, { recursive: true });
        res.savedPaths = [];
        for (let k = 0; k < res.images.length; k++) {
          const im = res.images[k];
          try {
            const { buf } = await downloadAsset(account, im.id, via);
            const p = path.join(saveDir, `${res.conversationId || "img"}-${i}-${k}.${EXT[im.mime] || "png"}`);
            fs.writeFileSync(p, buf);
            res.savedPaths.push(p);
          } catch { /* skip a failed image, keep the rest */ }
        }
      }
      results.push(res);
    }

    // Persist rotated cookies (cf_bm etc.) so the saved auth stays fresh.
    try {
      const state = await context.storageState();
      if (state.cookies?.length) { auth.cookies = state.cookies; saveAuth(account, auth); }
    } catch {}

    return { results, timings };
  } finally {
    if (!borrowed) await context.close().catch(() => {});
  }
}
