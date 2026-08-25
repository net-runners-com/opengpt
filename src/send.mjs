// Sending a prompt is the ONE thing pure HTTP cannot do: POST /backend-api/
// f/conversation requires openai-sentinel-proof-token (proof-of-work) and
// openai-sentinel-turnstile-token (Cloudflare Turnstile), both computed by the
// page's obfuscated JS. This does NOT bypass them — it lets the real logged-in
// page mint them by driving the composer, then reads the streamed answer.
//
// Orchestration: `system` prepends instructions (e.g. a selected Claude Code
// skill), each result carries its conversationId so a caller can continue a
// thread (`conversationId` input), and `gizmo` routes to a specific Custom GPT.
import { BASE } from "./config.mjs";
import { loadAuth, saveAuth } from "./auth.mjs";
import { openEphemeral } from "./browser.mjs";

const now = () => performance.now();
const ASSISTANT = '[data-message-author-role="assistant"]';
const STOP_BTN = 'button[data-testid="stop-button"]';

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

  const before = await page.locator(ASSISTANT).count();
  s = now();
  await page.keyboard.press("Enter");

  // first assistant turn appears. NOTE: page.waitForFunction takes ONE arg —
  // pass a single object, never positional args.
  await page.waitForFunction(
    ({ n, sel }) => document.querySelectorAll(sel).length > n,
    { n: before, sel: ASSISTANT },
    { timeout: timeoutMs },
  );
  t.firstToken = now() - s;

  // Done = stop button gone AND the last assistant turn actually has content
  // (text, or an image for image-gen). Checking the stop button alone races:
  // it can be read as "absent" before generation even starts.
  await page.waitForFunction(
    ({ sel, stop }) => {
      if (document.querySelector(stop)) return false;
      const els = document.querySelectorAll(sel);
      const last = els[els.length - 1];
      if (!last) return false;
      return last.innerText.trim().length > 0 || !!last.querySelector("img");
    },
    { sel: ASSISTANT, stop: STOP_BTN },
    { timeout: timeoutMs },
  );
  t.total = now() - s;

  const text = await page.locator(ASSISTANT).last().innerText().catch(() => "");
  return { text: text.trim(), conversationId: convIdFromUrl(page), timings: t };
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
  system = null, conversationId = null, gizmo = null, timeoutMs = 120000,
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
      results.push({ text: r.text, conversationId: r.conversationId });
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
