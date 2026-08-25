// Sending a prompt is the ONE thing pure HTTP cannot do: POST /backend-api/
// f/conversation requires openai-sentinel-proof-token (proof-of-work) and
// openai-sentinel-turnstile-token (Cloudflare Turnstile), both computed by the
// page's obfuscated JS. This does NOT bypass them — it lets the real logged-in
// page mint them by driving the composer, then reads the streamed answer.
//
// Performance: the expensive parts are browser cold-start and the chatgpt.com
// cold load. Both are amortized when several prompts share one warm page
// (batch mode), and the load is trimmed by blocking images/fonts/media/ads.
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

// Send one prompt on an already-open, ready page. Returns {text, timings}.
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
  return { text: text.trim(), timings: t };
}

// Start a fresh conversation. The in-app "new chat" control sits under the
// sidebar overlay and its click is routinely intercepted, so navigate by URL —
// a domcontentloaded reload (~1.5s) is reliable and still far cheaper than a
// browser launch. This is skipped entirely in --same-chat mode.
async function newChat(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await readyComposer(page);
}

// Batch entry: open the browser once, send every prompt on the warm page.
// sameChat=true keeps every prompt in one conversation (no nav = fastest, but
// prompts share context).
export async function send({ account, prompts, headed = false, lean = false, sameChat = false, timeoutMs = 120000 }) {
  if (typeof prompts === "string") prompts = [prompts];
  const auth = loadAuth(account);
  const timings = { launch: 0, load: 0, perPrompt: [] };

  let s = now();
  // Ephemeral context seeded from saved cookies — no persistent profile, so no
  // lock and no conflict with a concurrent run on the same account.
  const context = await openEphemeral(auth, { headed, lean });
  timings.launch = now() - s;

  try {
    const page = context.pages()[0] || (await context.newPage());
    s = now();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await readyComposer(page);
    timings.load = now() - s;

    const results = [];
    for (let i = 0; i < prompts.length; i++) {
      if (i > 0 && !sameChat) await newChat(page);
      const r = await sendOnPage(page, prompts[i], { timeoutMs });
      timings.perPrompt.push(r.timings);
      results.push(r.text);
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
