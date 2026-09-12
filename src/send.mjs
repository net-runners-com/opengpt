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
import { api } from "./http.mjs";

const now = () => performance.now();
const ASSISTANT = '[data-message-author-role="assistant"]';
// A model turn is either an assistant message or a tool message (image gen and
// other tool output arrive as role="tool").
const TURN = '[data-message-author-role="assistant"], [data-message-author-role="tool"]';
const STOP_BTN = 'button[data-testid="stop-button"]';
// Only exists once the composer has text — the fallback for a swallowed Enter.
const SEND_BTN = 'button[data-testid="send-button"], #composer-submit-button';
// Generated-image sources (oaiusercontent / estuary / files / blob).
const IMG_SRC = /oaiusercontent|blob:|\/backend-api\/|estuary|\/files\//;

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

// The conversation id lives in the URL as /c/<id> once a turn starts.
function convIdFromUrl(page) {
  const m = /\/c\/([^/?#]+)/.exec(page.url());
  return m ? m[1] : null;
}

// Upload image file(s) into the composer and wait for the upload to finish.
async function attachImages(page, files, timeoutMs) {
  const input = page.locator('input[data-testid="upload-photos-input"], input[type="file"][accept="image/*"]').first();
  await input.setInputFiles(files);
  // Done when a preview thumbnail (blob:/oaiusercontent) is present and no
  // spinner remains — sending before this silently drops the attachment.
  await page.waitForFunction(
    (n) => {
      const spin = document.querySelector('[role="progressbar"], .animate-spin, svg.animate-spin');
      if (spin) return false;
      const previews = [...document.querySelectorAll("img")].filter((im) => /blob:|oaiusercontent|estuary/.test(im.src));
      return previews.length >= n;
    },
    files.length,
    { timeout: timeoutMs },
  );
}

// Upload document(s) — pdf/txt/csv/docx/… — into the composer.
//
// #upload-files is the composer's unrestricted file input (accept=null); the
// photo input above only takes image/*. The file chip renders the instant the
// file is *selected* (measured: ~0.6s) while the bytes are still going up
// (measured on a 4.7 MB txt: POST /backend-api/files at 11.1s,
// process_upload_stream at 12.4s), and neither a spinner nor a disabled send
// button ever appears — so the DOM cannot tell "selected" from "uploaded".
// Wait on the network instead: one finished process_upload_stream per file.
async function attachDocs(page, files, timeoutMs) {
  const uploads = [];
  const onResp = (r) => {
    if (/\/backend-api\/files\/process_upload_stream/.test(r.url())) {
      uploads.push(r.finished().catch(() => {}));
    }
  };
  page.on("response", onResp);
  try {
    await page.locator("#upload-files").first().setInputFiles(files);
    const deadline = Date.now() + timeoutMs;
    while (uploads.length < files.length && Date.now() < deadline) await page.waitForTimeout(200);
    if (uploads.length < files.length) {
      throw new Error(`file upload did not finish (${uploads.length}/${files.length} processed)`);
    }
    await Promise.all(uploads);
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

// The newest assistant text message in a conversation, with its completion flag.
async function apiAnswer(account, convId, via) {
  const d = await api(account, "GET", `/backend-api/conversation/${convId}`, { via });
  let best = null;
  for (const node of Object.values(d.mapping || {})) {
    const m = node.message;
    if (!m || m.author?.role !== "assistant" || m.content?.content_type !== "text") continue;
    const t = (m.content.parts || []).filter((p) => typeof p === "string").join("\n").trim();
    if (!t) continue;
    if (!best || (m.create_time || 0) > (best.t || 0)) {
      best = { t: m.create_time || 0, text: t, complete: m.metadata?.is_complete === true };
    }
  }
  return best && { text: unfence(best.text), complete: best.complete };
}

// Count generated-image srcs currently in main (the pre-send baseline lets us
// tell an uploaded image apart from a freshly generated one).
async function mainImageSrcs(page) {
  return page.evaluate((imgRe) => {
    const re = new RegExp(imgRe);
    return [...new Set([...document.querySelectorAll("main img")].map((im) => im.src).filter((ssrc) => re.test(ssrc)))];
  }, IMG_SRC.source);
}

// Send one prompt on an already-open, ready page. Returns {text, images, conversationId, timings}.
async function sendOnPage(page, prompt, { account, via, timeoutMs = 120000, attach = null, docs = null } = {}) {
  const t = {};
  let s = now();
  const composer = await readyComposer(page);
  await composer.click();
  if (attach?.length) { await attachImages(page, attach, timeoutMs); t.upload = now() - s; }
  if (docs?.length) { await attachDocs(page, docs, timeoutMs); t.upload = now() - s; }
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
  const imgBase = await mainImageSrcs(page);
  // API-side baseline too, so a follow-up cannot return the previous answer.
  let convId = convIdFromUrl(page);
  const prevApi = convId ? (await apiAnswer(account, convId, via).catch(() => null))?.text ?? null : null;
  s = now();
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
      ({ n, sel, stop, imgRe }) => {
        if (document.querySelector(stop)) return true;
        if (document.querySelectorAll(sel).length > n) return true;
        const re = new RegExp(imgRe);
        return [...document.querySelectorAll("main img")].some((im) => re.test(im.src));
      },
      { n: before, sel: TURN, stop: STOP_BTN, imgRe: IMG_SRC.source },
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
  const read = () => page.evaluate(({ imgRe, base, prevN, prevText }) => {
    const re = new RegExp(imgRe);
    const baseSet = new Set(base);
    const as = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    // When ChatGPT renders an answer as a writing block it appends clickable
    // follow-up suggestions inside the same turn ("もう少し短くする" …). They are
    // UI, not the answer, so drop them before reading the text.
    const body = (el) => {
      const sug = el.querySelector('[data-testid="writing-block-suggested-followups"]');
      if (!sug) return el.innerText.trim();
      const c = el.cloneNode(true);
      c.querySelectorAll('[data-testid="writing-block-suggested-followups"]').forEach((n) => n.remove());
      return c.innerText.trim();
    };
    let text = "";
    for (let i = as.length - 1; i >= 0; i--) { const v = body(as[i]); if (v) { text = v; break; } }
    const images = [...new Set([...document.querySelectorAll("main img")].map((im) => im.src).filter((ssrc) => re.test(ssrc) && !baseSet.has(ssrc)))];
    const stop = !!document.querySelector('button[data-testid="stop-button"]');
    // On a follow-up the previous answer is still the last assistant turn until
    // the new one renders — don't mistake it for this turn's result.
    const fresh = as.length > prevN || (!!text && text !== prevText);
    return { text, images, stop, fresh };
  }, { imgRe: IMG_SRC.source, base: imgBase, prevN: prev.n, prevText: prev.text });

  while (Date.now() < deadline) {
    // Preferred path: ask the API. It reports the finished text and an explicit
    // is_complete, so there is nothing to infer from the page.
    if (!convId) convId = convIdFromUrl(page);
    if (convId) {
      const a = await apiAnswer(account, convId, via).catch(() => null);
      if (a?.complete && a.text && a.text !== prevApi) {
        text = a.text;
        images = (await read()).images;
        break;
      }
    }

    const st = await read();
    text = st.fresh ? st.text : "";
    images = st.images;
    const hasResult = text.length > 0 || images.length > 0;
    // Always finish on a quiet period, never on the stop button alone: the
    // button disappears before the last of the text renders on multi-item
    // answers (measured — it truncated a 5-post reply mid-sentence). While the
    // button is still up we may be mid-stream on a slow answer, so demand a
    // much longer quiet period there.
    const needed = st.stop ? 8 : 2; // ~12s while generating, ~3s after
    const sig = text + "|" + images.join(",");
    if (hasResult && sig === lastSig) { if (++stable >= needed) break; } else stable = 0;
    lastSig = sig;
    await page.waitForTimeout(1500);
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

// Batch entry: open the browser once, send every prompt on the warm page.
//   system         prepend instruction text to each prompt (skill content, etc.)
//   conversationId continue an existing thread instead of starting fresh
//   gizmo          route to a specific Custom GPT (gizmo id)
//   sameChat       keep every prompt in one conversation (no nav = fastest)
export async function send({
  account, prompts, headed = false, lean = false, sameChat = false,
  system = null, conversationId = null, gizmo = null, saveDir = null,
  attach = null, docs = null, timeoutMs = 120000, via = "auto",
}) {
  if (typeof prompts === "string") prompts = [prompts];
  const auth = loadAuth(account);
  const timings = { launch: 0, load: 0, perPrompt: [] };
  const frame = (p) => (system ? `${system}\n\n${p}` : p);

  let s = now();
  // Ephemeral context seeded from saved cookies — no persistent profile, so no
  // lock and no conflict with a concurrent run on the same account.
  const context = await openEphemeral(auth, { headed, lean });
  timings.launch = now() - s;

  try {
    const page = context.pages()[0] || (await context.newPage());
    s = now();
    // Start on: an existing conversation, a Custom GPT, or a blank chat.
    const start = conversationId ? `${BASE}/c/${conversationId}` : freshUrl({ gizmo });
    await gotoAndReady(page, start);
    timings.load = now() - s;

    const results = [];
    for (let i = 0; i < prompts.length; i++) {
      if (i > 0 && !sameChat) await gotoAndReady(page, freshUrl({ gizmo }));
      const r = await sendOnPage(page, frame(prompts[i]), { account, via, timeoutMs, attach, docs });
      timings.perPrompt.push(r.timings);
      const res = { text: r.text, images: r.images || [], conversationId: r.conversationId };
      // Download generated images through the live context (cookies attached);
      // these URLs 403 with "File stream access denied" without auth.
      if (saveDir && res.images.length) {
        fs.mkdirSync(saveDir, { recursive: true });
        res.savedPaths = [];
        for (let k = 0; k < res.images.length; k++) {
          try {
            const resp = await context.request.get(res.images[k], { timeout: 60000 });
            if (resp.ok()) {
              const p = path.join(saveDir, `${res.conversationId || "img"}-${i}-${k}.png`);
              fs.writeFileSync(p, await resp.body());
              res.savedPaths.push(p);
            }
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
    await context.close().catch(() => {});
  }
}
