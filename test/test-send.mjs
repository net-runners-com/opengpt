// Smoke test for the pure-HTTP send: new chat, continuation, sameChat batch,
// system prompt. Fails fast with a clear line on the first bad result.
//
//   OPENGPT_AUTH_DIR=~/.claude/plugins/data/opengpt-skills-dir/auth \
//     node test/test-send.mjs me
//
// Exit code 0 means every case passed. Any failure prints the broken case and
// exits non-zero.
import { send } from "../src/send.mjs";

const account = process.argv[2] || "me";
process.env.OPENGPT_AUTH_DIR =
  process.env.OPENGPT_AUTH_DIR ||
  `${process.env.HOME}/.claude/plugins/data/opengpt-skills-dir/auth`;

const ok = (msg) => console.log("  PASS", msg);
const bad = (msg) => { console.error("  FAIL", msg); process.exitCode = 1; };
const trim = (s) => (s || "").trim().replace(/\s+/g, " ").slice(0, 120);

async function case1_newChat() {
  console.log("=== case 1: new chat, single prompt");
  const t0 = Date.now();
  const r = await send({ account, prompts: "Reply with the single word: pong" });
  const el = Date.now() - t0;
  console.log("  elapsed:", el, "ms   convId:", r.results[0].conversationId);
  console.log("  reply:", trim(r.results[0].text));
  if (!r.results[0].text) return bad("no text returned");
  if (!r.results[0].conversationId) return bad("no conversationId returned");
  // Lenient — model obedience varies, but "pong" should appear somewhere.
  if (!/pong/i.test(r.results[0].text)) bad(`expected "pong" in reply, got: ${r.results[0].text.slice(0, 80)}`);
  else ok("reply contains 'pong'");
  return r.results[0].conversationId;
}

async function case2_continuation(convId) {
  console.log("=== case 2: continuation (same conversation)");
  const r = await send({
    account, conversationId: convId,
    prompts: "In one word, what did I ask you to reply with before?",
  });
  console.log("  convId:", r.results[0].conversationId);
  console.log("  reply:", trim(r.results[0].text));
  if (r.results[0].conversationId !== convId) bad(`convId drifted: ${convId} → ${r.results[0].conversationId}`);
  else ok("continuation stayed in the same thread");
  if (!/pong/i.test(r.results[0].text)) bad("model did not recall 'pong' from previous turn");
  else ok("model remembered previous turn");
}

async function case3_sameChatBatch() {
  console.log("=== case 3: --same-chat with 2 prompts");
  const r = await send({
    account, sameChat: true,
    prompts: [
      "Pick a number from 1 to 9 and reply with only that digit. Remember it.",
      "What number did you pick? Reply with only the digit.",
    ],
  });
  console.log("  reply 1:", trim(r.results[0].text), " conv:", r.results[0].conversationId);
  console.log("  reply 2:", trim(r.results[1].text), " conv:", r.results[1].conversationId);
  if (r.results[0].conversationId !== r.results[1].conversationId) {
    return bad("sameChat split into two threads");
  }
  ok("both prompts shared one conversation");
  const d1 = (r.results[0].text.match(/\d/) || [])[0];
  const d2 = (r.results[1].text.match(/\d/) || [])[0];
  if (!d1 || !d2) bad(`could not read digits (got "${r.results[0].text}" and "${r.results[1].text}")`);
  else if (d1 !== d2) bad(`model did not remember the digit (${d1} ≠ ${d2})`);
  else ok(`model remembered the digit (${d1})`);
}

async function case4_systemPrompt() {
  console.log("=== case 4: system prompt prepend");
  const r = await send({
    account,
    system: "You are a parrot. Reply with the single word: squawk.",
    prompts: "Hello.",
  });
  console.log("  reply:", trim(r.results[0].text));
  if (!/squawk/i.test(r.results[0].text)) bad("system prompt did not influence the reply");
  else ok("system prompt took effect");
}

async function case5_attachDoc() {
  console.log("=== case 5: attach a text document");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const docPath = path.join("/tmp", `opengpt-test-doc-${Date.now()}.txt`);
  fs.writeFileSync(docPath, "The secret word is BANANA. Keep it safe.\n");
  const r = await send({
    account, docs: [docPath],
    prompts: "What is the secret word in the attached file? Reply with only that single word.",
  });
  fs.unlinkSync(docPath);
  console.log("  reply:", trim(r.results[0].text));
  if (!/banana/i.test(r.results[0].text)) bad(`model did not read the doc; got: ${r.results[0].text.slice(0, 120)}`);
  else ok("model read the attached doc");
}

async function case6_attachImage() {
  console.log("=== case 6: attach an image (vision)");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const zlib = await import("node:zlib");
  // Build a 32x32 solid-red PNG from scratch so the test owns no fixture file.
  // Each row = 1 filter byte + 32*(R,G,B). zlib-deflate once.
  const W = 32, H = 32;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(W * 3).fill(0).map(() => 0),
    Buffer.from(Array.from({length: W}, () => [0xff, 0x00, 0x00]).flat())]);
  // Easier: build each full row explicitly.
  const rawRows = Buffer.concat(Array.from({length: H}, () =>
    Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({length: W}, () => [0xff, 0x00, 0x00]).flat())])));
  const idat = zlib.deflateSync(rawRows);
  const crc32 = (buf) => zlib.crc32(buf);  // Node 22+
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  // 10..12 = compression / filter / interlace (all 0)
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
  const imgPath = path.join("/tmp", `opengpt-test-img-${Date.now()}.png`);
  fs.writeFileSync(imgPath, png);
  const r = await send({
    account, attach: [imgPath],
    prompts: "What single color is the attached image? Reply with only the color name.",
  });
  fs.unlinkSync(imgPath);
  console.log("  reply:", trim(r.results[0].text));
  if (!/red|赤/i.test(r.results[0].text)) bad(`model did not describe the image; got: ${r.results[0].text.slice(0, 120)}`);
  else ok("model recognised the image");
}

async function case7_project() {
  console.log("=== case 7: project (gizmo_interaction) routing");
  const PROJECT = "g-p-6ac4dee2980c8191b80fc02cad2b65e5";
  const r = await send({
    account, gizmo: PROJECT,
    prompts: "Reply with just: OK",
  });
  console.log("  reply:", trim(r.results[0].text), " conv:", r.results[0].conversationId);
  if (!r.results[0].text) bad("no reply from project");
  else ok("project replied");
  // Verify the conversation landed inside the project: list a few recent
  // project conversations and expect our convId somewhere near the top.
  const { api } = await import("../src/http.mjs");
  const list = await api(account, "GET", `/backend-api/gizmos/${PROJECT}/conversations?limit=5`, { via: "auto" }).catch(() => null);
  const ids = (list?.items || []).map(x => x.id || x.conversation_id);
  if (ids.includes(r.results[0].conversationId)) ok("conversation attached to the project");
  else bad(`conv ${r.results[0].conversationId} not in project's recent list (${ids.slice(0, 3).join(",")})`);
  return r.results[0].conversationId;
}

async function case8_projectContinuation(projectConvId) {
  console.log("=== case 8: continue a project conversation");
  const PROJECT = "g-p-6ac4dee2980c8191b80fc02cad2b65e5";
  // Follow-up on the SAME convId — passing gizmo as well, to prove it is at
  // least harmless alongside conversationId; a real client doesn't strip it.
  const r = await send({
    account, gizmo: PROJECT, conversationId: projectConvId,
    prompts: "Earlier I asked you to reply with 'OK'. Reply with that same word again.",
  });
  console.log("  reply:", trim(r.results[0].text), " conv:", r.results[0].conversationId);
  if (r.results[0].conversationId !== projectConvId) bad(`project convId drifted: ${projectConvId} → ${r.results[0].conversationId}`);
  else ok("stayed in the same project conversation");
  if (!/ok/i.test(r.results[0].text)) bad("model did not recall the prior turn in the project");
  else ok("project continuation remembered prior turn");
}

async function case9bis_bareCustomGpt() {
  console.log("=== case 9b: bare Custom GPT (g-...)");
  // "Math Question Solver" — a public Custom GPT with deterministic output.
  const GPT = "g-cKy9ylXVX";
  const r = await send({
    account, gizmo: GPT,
    prompts: "What is 7 times 6? Reply with only the number.",
  });
  console.log("  reply:", trim(r.results[0].text), " conv:", r.results[0].conversationId);
  if (!r.results[0].text) bad("no reply from Custom GPT");
  else if (!/42/.test(r.results[0].text)) bad(`bare Custom GPT reply unexpected: ${r.results[0].text.slice(0, 120)}`);
  else ok("bare Custom GPT answered correctly");
  // Verify the convo attached to that GPT, same way we did for projects.
  const { api } = await import("../src/http.mjs");
  const list = await api(account, "GET", `/backend-api/gizmos/${GPT}/conversations?limit=5`, { via: "auto" }).catch(() => null);
  const ids = (list?.items || []).map(x => x.id || x.conversation_id);
  if (ids.includes(r.results[0].conversationId)) ok("conversation attached to the Custom GPT");
  else bad(`conv ${r.results[0].conversationId} not in GPT's recent list (${ids.slice(0, 3).join(",")})`);
}

async function case9_projectAttach() {
  console.log("=== case 9: attach a doc inside a project");
  const PROJECT = "g-p-6ac4dee2980c8191b80fc02cad2b65e5";
  const fs = await import("node:fs");
  const path = await import("node:path");
  const docPath = path.join("/tmp", `opengpt-test-proj-doc-${Date.now()}.txt`);
  fs.writeFileSync(docPath, "The project's secret phrase is PINEAPPLE.\n");
  const r = await send({
    account, gizmo: PROJECT, docs: [docPath],
    prompts: "What is the secret phrase in the attached file? Reply with only that one word.",
  });
  fs.unlinkSync(docPath);
  console.log("  reply:", trim(r.results[0].text), " conv:", r.results[0].conversationId);
  if (!/pineapple/i.test(r.results[0].text)) bad(`model did not read the doc inside the project; got: ${r.results[0].text.slice(0, 120)}`);
  else ok("project+attach worked");
}

async function case10_daemonSend() {
  console.log("=== case 10: send via daemon socket");
  const daemon = await import("../src/daemon.mjs");
  // Clean slate first.
  await daemon.stop(account).catch(() => {});
  const ensureRes = await daemon.ensure(account, { waitMs: 30000 }).catch((e) => ({ error: e.message }));
  if (ensureRes.error) return bad(`daemon ensure failed: ${ensureRes.error}`);
  ok("daemon started");
  try {
    const r = await daemon.request(account, { op: "send", args: { prompts: "Reply with exactly: daemon-ok" } }, { timeoutMs: 60000 });
    console.log("  reply:", trim(r.results?.[0]?.text));
    if (/daemon-ok/i.test(r.results?.[0]?.text || "")) ok("daemon round-trip send works");
    else bad(`daemon send returned unexpected: ${JSON.stringify(r).slice(0, 160)}`);
  } finally {
    await daemon.stop(account).catch(() => {});
  }
}

async function case11_rateLimitShape() {
  console.log("=== case 11: rate-limit error carries code: RATE_LIMITED");
  // We can't *trigger* a 429 reliably, so monkey-patch global fetch for one
  // call to prove the handling path tags the error correctly.
  const { send } = await import("../src/send.mjs");
  const realFetch = globalThis.fetch;
  let seenConversation = false;
  globalThis.fetch = async (url, init) => {
    if (typeof url === "string" && url.endsWith("/backend-api/f/conversation")) {
      seenConversation = true;
      return new Response(JSON.stringify({ detail: "Too many requests" }), {
        status: 429, headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, init);
  };
  try {
    await send({ account, prompts: "ping" });
    bad("send did not throw on simulated 429");
  } catch (e) {
    if (!seenConversation) bad("test harness did not reach /f/conversation");
    else if (e.code !== "RATE_LIMITED") bad(`error code was ${JSON.stringify(e.code)}, expected RATE_LIMITED`);
    else ok("429 surfaced as RATE_LIMITED");
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function case12bis_stripMetadata() {
  console.log("=== case 12b: stripMetadata removes C2PA/EXIF/APPx");
  const { stripMetadata } = await import("../src/send.mjs");
  const zlib = await import("node:zlib");

  // Build a tiny valid PNG and splice a caBX (C2PA) chunk + an iTXt chunk
  // between IHDR and IDAT, mirroring what ChatGPT actually ships.
  const W = 2, H = 2;
  const raw = Buffer.concat(Array.from({ length: H }, () =>
    Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: W }, () => [0xff, 0, 0]).flat())])));
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("caBX", Buffer.from("JUMBF-C2PA-manifest-placeholder-" + "x".repeat(200))),
    chunk("iTXt", Buffer.from("Software\0\0\0\0\0ChatGPT")),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const stripped = stripMetadata(png);
  console.log("  before:", png.length, "bytes · after:", stripped.length, "bytes");
  if (stripped.includes(Buffer.from("caBX"))) bad("caBX chunk survived strip");
  else ok("caBX stripped");
  if (stripped.includes(Buffer.from("iTXt"))) bad("iTXt chunk survived strip");
  else ok("iTXt stripped");
  if (stripped.length >= png.length) bad(`stripped size ${stripped.length} not < original ${png.length}`);
  // Must still be a valid PNG: magic + IHDR + IDAT + IEND present.
  for (const t of ["IHDR", "IDAT", "IEND"]) {
    if (!stripped.includes(Buffer.from(t))) bad(`stripped PNG missing ${t}`);
  }
  ok("stripped PNG keeps IHDR/IDAT/IEND");

  // JPEG: hand-rolled minimal SOI + APP1(EXIF) + SOS...EOI, verify APP1 is gone.
  const jpg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1, 0x00, 0x08]), Buffer.from("ExifXX"),
    Buffer.from([0xff, 0xeb, 0x00, 0x08]), Buffer.from("JUMBFX"),  // APP11 — C2PA
    Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from([0x00, 0x00]),  // bare SOS; EOI next
    Buffer.from([0xff, 0xd9]),
  ]);
  const jpgOut = stripMetadata(jpg);
  console.log("  jpeg before:", jpg.length, "after:", jpgOut.length);
  if (jpgOut.includes(Buffer.from("Exif"))) bad("APP1/EXIF survived JPEG strip");
  else ok("APP1/EXIF stripped from JPEG");
  if (jpgOut.includes(Buffer.from("JUMBF"))) bad("APP11/JUMBF survived JPEG strip");
  else ok("APP11/JUMBF stripped from JPEG");
}

async function case12_authExpiredShape() {
  console.log("=== case 12: 401 fallback carries code: AUTH_EXPIRED");
  const { send } = await import("../src/send.mjs");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof url === "string" && url.endsWith("/backend-api/f/conversation")) {
      return new Response(JSON.stringify({ detail: "Could not validate credentials" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, init);
  };
  try {
    await send({ account, prompts: "ping" });
    bad("send did not throw on simulated 401");
  } catch (e) {
    if (e.code !== "AUTH_EXPIRED") bad(`error code was ${JSON.stringify(e.code)}, expected AUTH_EXPIRED`);
    else ok("401 surfaced as AUTH_EXPIRED");
  } finally {
    globalThis.fetch = realFetch;
  }
}

const run = async () => {
  const convId = await case1_newChat();
  if (process.exitCode) return;
  await case2_continuation(convId);
  await case3_sameChatBatch();
  await case4_systemPrompt();
  await case5_attachDoc();
  await case6_attachImage();
  const projConv = await case7_project();
  if (projConv) await case8_projectContinuation(projConv);
  await case9_projectAttach();
  await case9bis_bareCustomGpt();
  await case10_daemonSend();
  await case11_rateLimitShape();
  await case12bis_stripMetadata();
  await case12_authExpiredShape();
  console.log(process.exitCode ? "\nFAILED" : "\nALL PASSED");
};

run().catch((e) => { console.error("fatal:", e.message, "\n", e.stack); process.exit(2); });
