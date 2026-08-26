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

const now = () => performance.now();
const ASSISTANT = '[data-message-author-role="assistant"]';
// A model turn is either an assistant message or a tool message (image gen and
// other tool output arrive as role="tool").
const TURN = '[data-message-author-role="assistant"], [data-message-author-role="tool"]';
const STOP_BTN = 'button[data-testid="stop-button"]';
// Generated-image sources (oaiusercontent / estuary / files / blob).
const IMG_SRC = /oaiusercontent|blob:|\/backend-api\/|estuary|\/files\//;

async function readyComposer(page) {
  const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 30000 });
  return composer;
}

// The conversation id lives in the URL as /c/<id> once a turn starts.
function convIdFromUrl(page) {
  const m = /\/c\/([^/?#]+)/.exec(page.url());
  return m ? m[1] : null;
}

// Send one prompt on an already-open, ready page. Returns {text, conversationId, timings}.
async function sendOnPage(page, prompt, { timeoutMs = 120000 } = {}) {
  const t = {};
  let s = now();
  const composer = await readyComposer(page);
  await composer.click();
  await page.keyboard.insertText(prompt);
  t.compose = now() - s;

  // Count assistant AND tool turns: image generation lands in a role="tool"
  // message, and the trailing role="assistant" turn is an invisible `code`
  // message ({"skipped_mainline":true}) with no text or img of its own.
  const before = await page.locator(TURN).count();
  s = now();
  await page.keyboard.press("Enter");

  // Generation started: the stop button appeared, a new turn rendered, or an
  // image is already present. Image gen doesn't reliably keep an assistant/tool
  // turn in the DOM, so gating on turn-count alone can hang. NOTE:
  // page.waitForFunction takes ONE arg — pass a single object.
  await page.waitForFunction(
    ({ n, sel, stop, imgRe }) => {
      if (document.querySelector(stop)) return true;
      if (document.querySelectorAll(sel).length > n) return true;
      const re = new RegExp(imgRe);
      return [...document.querySelectorAll("main img")].some((im) => re.test(im.src));
    },
    { n: before, sel: TURN, stop: STOP_BTN, imgRe: IMG_SRC.source },
    { timeout: timeoutMs },
  );
  t.firstToken = now() - s;

  // Done = stop button gone AND a real result exists: a generated image
  // anywhere in main (image-gen puts it in a tool message), or a non-empty
  // assistant text turn. Checking the stop button alone races — it can read as
  // "absent" before generation even starts.
  await page.waitForFunction(
    ({ stop, imgRe }) => {
      if (document.querySelector(stop)) return false;
      const re = new RegExp(imgRe);
      const img = [...document.querySelectorAll("main img")].some((im) => re.test(im.src));
      if (img) return true;
      const as = document.querySelectorAll('[data-message-author-role="assistant"]');
      return [...as].some((el) => el.innerText.trim().length > 0);
    },
    { stop: STOP_BTN, imgRe: IMG_SRC.source },
    { timeout: timeoutMs },
  );
  t.total = now() - s;

  // Prefer the last assistant turn that actually has text; fall back to the
  // generated image URL(s) so image-gen results are not lost.
  const { text, images } = await page.evaluate((imgRe) => {
    const re = new RegExp(imgRe);
    const as = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    let text = "";
    for (let i = as.length - 1; i >= 0; i--) {
      const v = as[i].innerText.trim();
      if (v) { text = v; break; }
    }
    // Image gen references the same asset several times in the DOM — dedupe.
    const images = [...new Set([...document.querySelectorAll("main img")].map((im) => im.src).filter((ssrc) => re.test(ssrc)))];
    return { text, images };
  }, IMG_SRC.source);
  return { text, images, conversationId: convIdFromUrl(page), timings: t };
}

// Where a fresh turn should start. A Custom GPT keeps its /g/<gizmo> context;
// otherwise a new blank chat at /. (The in-app new-chat button sits under the
// sidebar overlay and its click is routinely intercepted, so navigate by URL.)
function freshUrl({ gizmo }) {
  return gizmo ? `${BASE}/g/${gizmo}` : `${BASE}/`;
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
  system = null, conversationId = null, gizmo = null, saveDir = null, timeoutMs = 120000,
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
      const r = await sendOnPage(page, frame(prompts[i]), { timeoutMs });
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
