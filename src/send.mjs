// Send a prompt to ChatGPT purely over HTTP — no browser.
//
// How a real client turn fires (reverse-engineered from webtrace 2026-10-15):
//   1. POST /backend-api/sentinel/chat-requirements/prepare {p:"gAAAAAC"+b64(fp)+"~F"}
//                                → {prepare_token, proofofwork:{seed,difficulty}, …}
//   2. solve PoW locally         → proof-token (gAAAAAB + b64(cfg) + ~S)
//   3. POST /backend-api/sentinel/chat-requirements/finalize
//        {prepare_token, proofofwork:<proof-token>, turnstile:"<anything>"}
//                                → {token (chat-requirements-token), expire_after:540}
//   4. POST /backend-api/f/conversation/prepare  (same body as the send below)
//                                → {status:"ok", conduit_token}  (conduit is cosmetic)
//   5. POST /backend-api/f/conversation  (sentinel headers + body)
//                                → text/event-stream delta patches
//
// Enforcement, measured:
//   * PoW:        enforced. Must solve `seed`/`difficulty` from step 1.
//   * Turnstile:  advertised required, NOT enforced. Any string works.
//   * `so`:       advertised required, NOT enforced. Omit entirely.
//   * CF cookies: NOT enforced on free accounts. Session-token.* is enough.
//
// SSE delta_encoding v1 is incremental JSON patches. We don't rebuild from
// patches — we just watch for `conversation_id` and `is_complete`, then GET
// /backend-api/conversation/<id> for the clean final text + any image parts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BASE } from "./config.mjs";
import { loadAuth, saveAuth, cookieHeader, authExpiredError } from "./auth.mjs";
import { api, authHeaders, ensureAuth } from "./http.mjs";
import { refresh as refreshAuth } from "./auth.mjs";

const now = () => performance.now();
const uuid = () => crypto.randomUUID();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

// ── 1. Proof-of-work ─────────────────────────────────────────────────────────
//
// 25-element config array; element 0 is the nonce the solver iterates. The
// server hashes seed + base64(JSON(array)) with SHA3-512 and compares the hex
// prefix to the difficulty string. Lower-or-equal wins. Difficulty "07a120"
// typically settles in <100 iterations because `3424.5` and the ms timestamp
// at index 17 vary with the browser's performance.now; here we vary only the
// nonce and let the one-shot timestamps do the rest.
function proofConfig(nonce, { ua, sid, dateStr, tsMs, perfMs = 3424.5 }) {
  return [
    nonce,
    dateStr,
    4294967296,
    53,
    ua,
    "https://chatgpt.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload",
    "35feeb1b19497fee44ca7964f47ec8f571d87a70",
    "ja", "ja,en-US,en",
    2,
    "cookieEnabled−true",
    "location",
    "onsecuritypolicyviolation",
    perfMs,
    sid,
    "",
    8,
    tsMs,
    0, 0, 0, 0, 0, 0, 0,
  ];
}

function solvePow({ seed, difficulty }, ctx, maxIter = 2_000_000) {
  const t0 = Date.now();
  for (let n = 0; n < maxIter; n++) {
    const buf = b64(proofConfig(n, ctx));
    const h = crypto.createHash("sha3-512").update(seed + buf).digest("hex");
    if (h.slice(0, difficulty.length) <= difficulty) {
      return { token: "gAAAAAB" + buf + "~S", iterations: n, ms: Date.now() - t0 };
    }
  }
  throw new Error(`PoW: no solution in ${maxIter} iterations (difficulty=${difficulty})`);
}

// The "p" field posted to /prepare is NOT PoW — it's a client-side fingerprint
// snapshot the server reads before deciding what to challenge. Shape mirrors
// the real client; most values are decorative. We signal "no PoW yet" with the
// gAAAAAC prefix and ~F suffix.
function prepareFingerprint({ ua, sid, dateStr, tsMs }) {
  const arr = [
    2340, dateStr, 4294967296, 1, ua,
    null,
    "35feeb1b19497fee44ca7964f47ec8f571d87a70",
    "ja", "ja,en-US,en",
    0.5,
    "vibrate−function vibrate() { [native code] }",
    "location",
    "structuredClone",
    1672.4,
    sid, "",
    8, tsMs,
    0, 0, 0, 0, 0, 0, 0,
  ];
  return "gAAAAAC" + b64(arr) + "~F";
}

// ── 2. Shared request plumbing ───────────────────────────────────────────────

// Everything the real client echoes on each turn. Only `authorization`, cookie
// and the sentinel-* headers actually gate the call; the rest keeps our shape
// looking like a real browser so a future tightening doesn't catch us flat.
function baseHeaders(auth, accountId) {
  return {
    accept: "*/*",
    "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    cookie: cookieHeader(auth),
    "oai-did": "7216aa40-4372-4128-a699-6e8f1276fccb",
    "oai-echo-logs": "",
    "oai-language": "ja-JP",
    origin: BASE,
    originator: "Codex Browser",
    priority: "u=1, i",
    referer: `${BASE}/`,
    "sec-ch-ua": '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": auth.userAgent || "Mozilla/5.0",
    "x-oai-mcp-form-version": "2",
    "x-openai-codex-window-type": "browser",
    "x-openai-web-frontend": "codex_webview",
    "x-openai-web-sse-compression": "gzip",
  };
}

// /backend-api/accounts/check gives the chatgpt-account-id — the request lands
// at the right pool thanks to this header. We cache onto the auth blob so we
// only pay the round-trip once per session; the id doesn't rotate.
async function resolveAccountId(account, auth) {
  if (auth._accountId) return auth._accountId;
  const r = await api(account, "GET", "/backend-api/accounts/check/v4-2023-04-27", { via: "node" });
  const id = Object.keys(r?.accounts || {})[0];
  if (!id) throw new Error("could not resolve chatgpt-account-id");
  auth._accountId = id;
  saveAuth(account, auth);
  return id;
}

// Mint a chat-requirements token the backend will accept on /f/conversation.
// Returns {chatRequirementsToken, proofToken} — a disposable pair, good for a
// handful of seconds; the server lets a token age up to 540s (expire_after).
async function mintSentinelTokens(headers, ua) {
  const sid = uuid();
  const dateStr = new Date().toString();
  const tsMs = Date.now() + 0.7;
  const prepRes = await fetch(`${BASE}/backend-api/sentinel/chat-requirements/prepare`, {
    method: "POST", headers,
    body: JSON.stringify({ p: prepareFingerprint({ ua, sid, dateStr, tsMs }) }),
  });
  if (!prepRes.ok) throw new Error(`sentinel/prepare → ${prepRes.status}: ${(await prepRes.text()).slice(0, 240)}`);
  const prep = await prepRes.json();
  const proof = solvePow(prep.proofofwork, { ua, sid, dateStr, tsMs });
  const finRes = await fetch(`${BASE}/backend-api/sentinel/chat-requirements/finalize`, {
    method: "POST", headers,
    body: JSON.stringify({
      prepare_token: prep.prepare_token,
      proofofwork: proof.token,
      turnstile: "n/a",
    }),
  });
  if (!finRes.ok) throw new Error(`sentinel/finalize → ${finRes.status}: ${(await finRes.text()).slice(0, 240)}`);
  const fin = await finRes.json();
  return { chatRequirementsToken: fin.token, proofToken: proof.token, powMs: proof.ms, powIter: proof.iterations };
}

// ── 3. Reading the finished turn ─────────────────────────────────────────────
//
// `apiAnswer` is pure HTTP. Exported for scripting (read a finished turn's
// text + images outside of send). The send flow itself calls it internally
// twice per turn: once to resolve `parent_message_id` for continuations, and
// once at the end to pick up the clean final text.

// Writing-block answers come fenced; this is presentation, not content.
const WRITING_FENCE = /^:::writing\{[^}]*\}\s*\n([\s\S]*?)\n?:::\s*$/;
function unfence(s) { const m = WRITING_FENCE.exec(s.trim()); return (m ? m[1] : s).trim(); }
// Web-search answers embed citation spans in U+E200..E202. Strip them.
function stripCitations(s) {
  const hadCite = /[-]/.test(s);
  let t = s.replace(/[\s\S]*?/g, "").replace(/[-]/g, "");
  if (hadCite) {
    const m = t.match(/\n{2,}\s*([^\n]{3,20})\s*$/);
    if (m && /^[A-Za-z0-9]+$/.test(m[1]) && /[0-9]/.test(m[1]) && /[a-z]/.test(m[1]) && /[A-Z]/.test(m[1])) {
      t = t.slice(0, m.index);
    }
  }
  return t.trim();
}

export async function apiAnswer(account, convId, via) {
  const d = await api(account, "GET", `/backend-api/conversation/${convId}`, { via });
  const nodeId = d.current_node;
  const map = d.mapping || {};
  const tip = map[nodeId]?.message;
  if (!tip) return { nodeId, text: "", images: [], complete: false };
  const toUser = (m) => (m.recipient || "all") === "all";

  // Images live in a tool message that is NOT the tip (image gen's tip is an
  // invisible assistant code stub). Walk back to this turn's user message and
  // pick up every asset pointer along the way.
  const images = [];
  for (let id = nodeId, hops = 0; id && hops < 12; hops++) {
    const m = map[id]?.message;
    if (m?.author?.role === "user") break;
    for (const part of m?.content?.parts || []) {
      if (part && typeof part === "object" && part.content_type === "image_asset_pointer") {
        const fid = String(part.asset_pointer || "").replace(/^[a-z]+:\/\//, "");
        if (fid) images.unshift({ id: fid, mime: part.mime_type || "image/png", width: part.width, height: part.height });
      }
    }
    id = map[id]?.parent;
  }

  let text = "";
  if (tip.author?.role === "assistant" && tip.content?.content_type === "text" && toUser(tip)) {
    text = stripCitations(unfence((tip.content.parts || []).filter((p) => typeof p === "string").join("\n").trim()));
  }

  // Done when the tip says so, or when the tip IS the image-bearing tool turn.
  // `is_complete` is not reliable alone (measured 2026-09-13 — some answers
  // finish with status finished_successfully + end_turn and never set it).
  const finished = tip.metadata?.is_complete === true
    || (tip.author?.role === "assistant" && tip.status === "finished_successfully" && tip.end_turn === true)
    || (tip.author?.role === "tool" && toUser(tip) && images.length > 0);
  return { nodeId, text, images, complete: finished && (text.length > 0 || images.length > 0) };
}

// ── Scrub C2PA / EXIF / other provenance metadata from a downloaded image ───
//
// ChatGPT ships generated PNGs with a `caBX` chunk — a ~24 KB C2PA JUMBF
// manifest marking the image as AI-generated. JPEGs carry the same manifest in
// an APP11 marker; WebPs in EXIF/XMP/ICCP chunks. Everything we save goes
// through this scrubber by default so a reposted image doesn't trip
// AI-provenance checks downstream. Caller can opt out with `keepMetadata`.
//
// Approach is a hard whitelist per format: keep only the chunks the decoder
// needs for pixels, drop everything else. iCCP (color profile) can and does
// hide C2PA data too, so iCCP is dropped — the tiny color-accuracy cost is
// acceptable in the "I want this image clean" workflow.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "pHYs", "gAMA", "cHRM", "sRGB"]);
function stripPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return buf;
  const out = [PNG_MAGIC];
  let i = 8;
  while (i < buf.length - 4) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const chunk = buf.subarray(i, i + 12 + len);
    if (PNG_KEEP.has(type)) out.push(chunk);
    i += 12 + len;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}
function stripJpeg(buf) {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const out = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); break; }           // EOI
    if (m === 0xda) { out.push(buf.subarray(i)); break; }                     // SOS → copy entropy payload through EOI
    if (m >= 0xd0 && m <= 0xd7) { out.push(buf.subarray(i, i + 2)); i += 2; continue; } // RSTn (no length)
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    // Drop every application-defined and comment segment — APP0-APP15 and COM
    // are where EXIF, XMP, JUMBF/C2PA and provenance tags live.
    const drop = (m >= 0xe0 && m <= 0xef) || m === 0xfe;
    if (!drop) out.push(seg);
    i += 2 + len;
  }
  return Buffer.concat(out);
}
const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);
function stripWebp(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return buf;
  const chunks = [];
  let i = 12;
  while (i < buf.length - 8) {
    const type = buf.toString("ascii", i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const padded = len + (len & 1);
    if (WEBP_KEEP.has(type)) chunks.push(buf.subarray(i, i + 8 + padded));
    i += 8 + padded;
  }
  // VP8X flags: bit 3 = ICCP, bit 4 = ALPHA (keep), bit 5 = EXIF, bit 6 = XMP,
  // bit 7 (0x80) reserved. Clear ICC/EXIF/XMP since we dropped those chunks.
  for (const c of chunks) {
    if (c.toString("ascii", 0, 4) === "VP8X") c[8] &= ~0b01101000;
  }
  const body = Buffer.concat(chunks);
  const out = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(4 + body.length, 4);
  out.write("WEBP", 8, "ascii");
  body.copy(out, 12);
  return out;
}
export function stripMetadata(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return stripPng(buf);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return stripJpeg(buf);
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return stripWebp(buf);
  return buf;
}

// Pixel-level scrubbing: on top of metadata stripping, perturb the actual
// pixels so an invisible statistical watermark (SynthID-style) and an
// AI-origin classifier have less to lock onto. Two cheap transforms, both
// imperceptible: light gaussian noise and a JPEG re-encode. Keeps the output
// as PNG unless the caller asks for JPEG (jpegQuality != null).
//
// Light tuning: amp=2 on 8-bit channels moves most pixels by ±1 which is
// invisible to the eye but destroys exact bit-level embedded signals;
// jpeg q=92 preserves perceptual quality while re-quantizing the frequency
// domain, which eats fragile frequency-domain watermarks.
export async function scrubPixels(buf, { amp = 2, jpegQuality = null, format = "png" } = {}) {
  const sharp = (await import("sharp")).default;
  // Decode once; add noise to the raw RGB(A) buffer; re-encode.
  const img = sharp(buf, { failOn: "none" });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  if (amp > 0) {
    const chans = info.channels;
    // Box-Muller for a cheap gaussian; alpha channel left alone so edges
    // around transparent regions stay crisp.
    for (let i = 0; i < data.length; i += chans) {
      for (let c = 0; c < Math.min(3, chans); c++) {
        const u1 = Math.random() || 1e-9;
        const u2 = Math.random();
        const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const v = data[i + c] + Math.round(g * amp);
        data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  const re = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
  if (format === "jpeg" || jpegQuality != null) {
    return { buf: await re.jpeg({ quality: jpegQuality ?? 92, mozjpeg: true }).toBuffer(), ext: "jpg" };
  }
  // PNG re-encode. Compression 9 to not inflate the file.
  return { buf: await re.png({ compressionLevel: 9 }).toBuffer(), ext: "png" };
}

// Generated images download over plain HTTP: ask for a signed URL, then fetch
// WITH bearer + cookie. The signature alone 403s.
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
async function downloadAsset(account, fileId, via) {
  const r = await api(account, "GET", `/backend-api/files/${fileId}/download`, { via });
  if (!r.download_url) throw new Error(`no download_url for ${fileId}`);
  const res = await fetch(r.download_url, { headers: await authHeaders(account, { via }) });
  if (!res.ok) throw new Error(`asset ${fileId} → ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), name: r.file_name || fileId };
}

// ── Uploading a file to the account ──────────────────────────────────────────
//
// Three-step flow (reverse-engineered 2026-10-15):
//   1. POST /backend-api/files            → {upload_url, file_id}
//   2. PUT  <upload_url> + raw bytes       (Azure Blob; x-ms-blob-type required)
//   3. POST /backend-api/files/process_upload_stream
//                                          → NDJSON stream, final event:
//                                            file.processing.completed with
//                                            {library_file_id, library_file_name}
// The returned metadata is what the message turn needs under both
// `content.parts` (as asset_pointer for images) and `metadata.attachments`
// (for every file, regardless of type).
const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json",
  csv: "text/csv", html: "text/html", xml: "application/xml", yml: "application/x-yaml",
  yaml: "application/x-yaml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function mimeOf(filePath) {
  const ext = (path.extname(filePath).replace(/^\./, "") || "").toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

// Enough of PNG/JPEG/WebP/GIF to read width×height without a dependency. The
// server appears to be lenient when these are off, but a correct pair avoids a
// "please re-upload" when the client-side preview is rendered later.
function imageDimensions(buf, mime) {
  try {
    if (mime === "image/png" && buf.length >= 24 && buf.toString("ascii", 1, 4) === "PNG") {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      // Scan for SOFn marker (0xFFC0..0xFFCF, except 0xC4/0xC8/0xCC).
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        i += 2 + len;
      }
    }
    if (mime === "image/webp" && buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF") {
      // VP8X extended format: dimensions at offset 24, 24-bit little-endian minus 1.
      if (buf.toString("ascii", 12, 16) === "VP8X") {
        return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
                 height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
      }
    }
  } catch { /* fall through */ }
  return null;
}

// Return {id, libraryId, name, mime, size, width?, height?}.
// useCase: "multimodal" for images, "my_files" for documents.
async function uploadFile(account, auth, filePath, { useCase, via }) {
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const mime = mimeOf(filePath);
  const isImage = useCase === "multimodal";
  const dims = isImage ? imageDimensions(buf, mime) : null;
  // Step 1: request an upload slot.
  const slot = await api(account, "POST", "/backend-api/files", {
    via,
    json: {
      entry_surface: "chat_composer",
      file_name: name,
      file_size: buf.length,
      client_resolved_mime_type: mime,
      mime_resolution_source: "filename_extension",
      mime_type: mime,
      reset_rate_limits: false,
      supports_direct_azure_multipart: true,
      timezone_offset_min: new Date().getTimezoneOffset(),
      use_case: useCase,
      store_in_library: true,
      library_persistence_mode: "opportunistic",
    },
  });
  if (!slot?.upload_url || !slot?.file_id) throw new Error(`files/alloc: ${JSON.stringify(slot).slice(0, 200)}`);
  // Step 2: PUT bytes to Azure Blob (bearer NOT attached — the sig in the URL is the auth).
  const putRes = await fetch(slot.upload_url, {
    method: "PUT",
    headers: {
      "content-type": mime,
      "x-ms-blob-content-type": mime,
      "x-ms-blob-type": "BlockBlob",
      "x-ms-version": "2020-04-08",
    },
    body: buf,
  });
  if (!putRes.ok) throw new Error(`PUT upload → ${putRes.status}: ${(await putRes.text()).slice(0, 160)}`);
  // Step 3: kick server-side processing and wait for `file.processing.completed`.
  const procRes = await fetch(`${BASE}/backend-api/files/process_upload_stream`, {
    method: "POST",
    headers: await authHeaders(account, { via, extra: { "content-type": "application/json" } }),
    body: JSON.stringify({
      entry_surface: "chat_composer",
      file_id: slot.file_id,
      file_name: name,
      index_for_retrieval: !isImage,          // docs get RAG indexing
      library_persistence_mode: "opportunistic",
      metadata: { store_in_library: true, is_project_thread: false },
      mime_type: mime,
      use_case: useCase,
    }),
  });
  if (!procRes.ok) throw new Error(`process_upload_stream → ${procRes.status}: ${(await procRes.text()).slice(0, 200)}`);
  const text = await procRes.text();  // NDJSON — a few short lines, read-once is fine.
  let libraryId = null, serverName = name, serverMime = mime;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.extra?.metadata_object_id) libraryId = ev.extra.metadata_object_id;
      if (ev.extra?.library_file_name) serverName = ev.extra.library_file_name;
      if (ev.extra?.mime_type) serverMime = ev.extra.mime_type;
    } catch { /* ignore partial frames */ }
  }
  return {
    id: slot.file_id,
    libraryId,
    name: serverName,
    mime: serverMime,
    size: buf.length,
    ...(dims || {}),
  };
}

// ── 4. The send itself ───────────────────────────────────────────────────────

// Walk the SSE stream looking for the conversation_id and the end-of-turn.
// We never try to reconstruct text from the deltas — the final GET of
// /backend-api/conversation/<id> is cleaner and matches apiAnswer's shape.
async function readSendStream(res, timeoutMs) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let convId = null;
  let doneSignal = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !doneSignal) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    while (true) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '"v1"') continue;
      // The last data line is literally `[DONE]`. Everything before it is JSON.
      if (payload === "[DONE]") { doneSignal = true; break; }
      try {
        const j = JSON.parse(payload);
        if (!convId) {
          // conversation_id turns up on the first `add` patch's message.metadata
          // or on the top-level `v` of a resume_conversation_token event.
          convId = j?.v?.conversation_id || j?.conversation_id || convId;
          if (!convId && j?.v?.message?.metadata?.conversation_id) convId = j.v.message.metadata.conversation_id;
        }
      } catch { /* some SSE lines are plain strings */ }
    }
  }
  return { convId, closedCleanly: doneSignal };
}

// Build the message turn the way the webtrace capture shows the real client.
// `attachments` is a list of {id, libraryId, name, mime, size, width?, height?}
// — images go into content.parts as asset_pointers, every file goes into
// metadata.attachments.
//
// `model`:    override the default "auto" with any slug the account exposes
//             (see `/backend-api/models`). Unknown slugs 404 "Model not found".
// `hints`:    extra entries for `system_hints` — "reason" enables the model's
//             reasoning path (verified via webtrace 2026-10-20). "search" is
//             best-effort; the backend accepts it but whether real web search
//             fires depends on the account's search_tool feature flag.
function buildTurn(prompt, { parentId, gizmoId = null, attachments = [], model = "auto", hints = [], tools = [] }) {
  const images = attachments.filter(a => /^image\//.test(a.mime));
  const parts = [
    ...images.map(a => ({
      asset_pointer: `sediment://${a.id}`,
      content_type: "image_asset_pointer",
      height: a.height || 1,
      size_bytes: a.size,
      width: a.width || 1,
    })),
    prompt,
  ];
  const content = images.length
    ? { content_type: "multimodal_text", parts }
    : { content_type: "text", parts: [prompt] };
  const metadata = attachments.length
    ? { attachments: attachments.map(a => ({
        ...(a.height ? { height: a.height } : {}),
        id: a.id,
        library_file_id: a.libraryId,
        mime_type: a.mime,
        name: a.name,
        size: a.size,
        ...(a.width ? { width: a.width } : {}),
      })) }
    : {};
  const body = {
    turn_attribution: { turn_trigger: "composer" },
    action: "next",
    is_do_not_remember: false,
    model,
    parent_message_id: parentId || "client-created-root",
    timezone: "Asia/Tokyo",
    timezone_offset_min: new Date().getTimezoneOffset(),
    client_contextual_info: {
      app_name: "chatgpt.com",
      app_surface: "codex_browser",
      has_web_push_capabilities: true,
      web_push_notification_permission: "default",
    },
    local_function_names: ["local.continue_in_work"],
    messages: [{
      author: { metadata: {}, name: null, role: "user" },
      channel: null,
      content,
      create_time: Date.now() / 1000,
      end_turn: null,
      id: uuid(),
      metadata,
      recipient: "all",
      status: "finished_successfully",
      update_time: null,
      weight: 1,
    }],
    supported_encodings: ["v1"],
    system_hints: hints,
    genui_state_snapshots: [],
    client_prepare_state: "sent",
  };
  if (tools.length) body.tools = tools;
  // Project / Custom GPT routing — the pool differs enough that the backend
  // returns "Model not found" without these two keys.
  if (gizmoId) {
    body.conversation_mode = { kind: "gizmo_interaction", gizmo_id: gizmoId };
    body.gizmo_id = gizmoId;
  }
  return body;
}

// Resolve the "parent" node of an existing conversation so the follow-up chains
// correctly. Null convId → "client-created-root" (what the real client sends
// on a new chat).
async function parentFor(account, convId, via) {
  if (!convId) return null;
  const a = await apiAnswer(account, convId, via).catch(() => null);
  return a?.nodeId || null;
}

async function sendOne(account, auth, accountId, prompt, { convId, timeoutMs, via, gizmoId, attachments, model, hints, tools }) {
  const t = {};
  let s = now();
  const parentId = await parentFor(account, convId, via);
  const headers = baseHeaders(auth, accountId);
  const { chatRequirementsToken, proofToken, powMs, powIter } = await mintSentinelTokens(headers, auth.userAgent);
  t.sentinel = now() - s;

  s = now();
  const body = buildTurn(prompt, { parentId, gizmoId, attachments, model, hints, tools });
  if (convId) body.conversation_id = convId;
  const sendHeaders = {
    ...headers,
    "openai-sentinel-chat-requirements-token": chatRequirementsToken,
    "openai-sentinel-proof-token": proofToken,
    "openai-sentinel-turnstile-token": "n/a",
    "x-oai-turn-trace-id": uuid(),
  };

  // /prepare primes the backend's conversation route. The real client always
  // fires it; measured 2026-10-15 the SEND alone works too, but prepare is
  // cheap and keeps us closer to the real traffic shape.
  await fetch(`${BASE}/backend-api/f/conversation/prepare`, {
    method: "POST", headers: sendHeaders, body: JSON.stringify(body),
  }).catch(() => {});
  t.prepare = now() - s;

  s = now();
  // 401 from the stream endpoint means the bearer died mid-flight. Try once
  // to re-mint it via /api/auth/session (pure HTTP), then replay this send.
  // A second 401 is a terminal AUTH_EXPIRED — the CLI's retry branch keys off
  // this exact code so make sure it survives all the way out.
  let res = await fetch(`${BASE}/backend-api/f/conversation`, {
    method: "POST", headers: sendHeaders, body: JSON.stringify(body),
  });
  if (res.status === 401) {
    try { await refreshAuth(account, { via: via === "node" ? "node" : "auto" }); }
    catch (e) { throw authExpiredError(account, `401 from /f/conversation, refresh failed: ${e.message}`); }
    const auth2 = loadAuth(account);
    const retryHeaders = { ...sendHeaders, authorization: `Bearer ${auth2.accessToken}`, cookie: cookieHeader(auth2) };
    res = await fetch(`${BASE}/backend-api/f/conversation`, {
      method: "POST", headers: retryHeaders, body: JSON.stringify(body),
    });
    if (res.status === 401) throw authExpiredError(account, `401 from /f/conversation after refresh`);
  }
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 400);
    const err = new Error(`/f/conversation → ${res.status}: ${errBody}`);
    err.status = res.status;
    // 429 is the backend saying "too many requests" — the CLI's rate-limit
    // branch keys off this code, so tag it explicitly.
    if (res.status === 429) err.code = "RATE_LIMITED";
    throw err;
  }
  t.firstToken = now() - s;

  // Walk the SSE stream just enough to learn the conversation id and detect
  // end-of-turn; the authoritative final text comes from the follow-up GET.
  const { convId: streamConv } = await readSendStream(res, timeoutMs);
  const conversationId = streamConv || convId || null;
  t.stream = now() - s;

  // Pull the clean final text + any images from the API, same as apiAnswer
  // does for continuations.
  let text = "", images = [];
  if (conversationId) {
    const a = await apiAnswer(account, conversationId, via).catch(() => null);
    if (a) { text = a.text || ""; images = a.images || []; }
  }
  t.total = now() - s + t.sentinel + t.prepare;
  t.powMs = powMs; t.powIter = powIter;
  return { text, images, conversationId, timings: t };
}

// ── 5. Public API ────────────────────────────────────────────────────────────

// Batched entry: pure HTTP, no browser.
//
// Attachments:
//   attach - array of image paths (uploaded with use_case="multimodal")
//   docs   - array of document paths (uploaded with use_case="my_files")
//   Uploads happen once up-front; the same ids are reused across sameChat
//   prompts so a batched follow-up re-sees the files without re-uploading.
//
// `via` is here only for apiAnswer / downloadAsset: those read endpoints
// still have the "node → browser on CF challenge" fallback in http.mjs.
export async function send({
  account, prompts, system = null, conversationId = null,
  sameChat = false, timeoutMs = 120000, via = "auto", saveDir = null,
  attach = null, docs = null, gizmo = null,
  // keepMetadata: default false — scrub C2PA/EXIF/JUMBF from downloaded
  // images on the way to disk. Opt in to retain the AI-provenance tag.
  keepMetadata = false,
  // scrub: on top of metadata strip, perturb pixels + re-encode to break
  // invisible watermarks / classifier signatures. Opt-in because it alters
  // the actual image (minor perceptual change, acceptable for most reposts).
  // Accepts true | {amp?, jpegQuality?} for finer control.
  scrub = false,
  // model: override the default "auto" slug for this turn (e.g. "gpt-6", "gpt-5-6-mini").
  model = "auto",
  // reasoning: send system_hints: ["reason"] — the "思考" chip equivalent.
  reasoning = false,
  // search: best-effort web-search enable. Appends system_hints: ["search"]
  // and tools: [{type:"web_search"}]. Backend accepts both without complaint;
  // whether real search actually fires depends on the account's search_tool
  // feature flag — not verified across tiers.
  search = false,
  // imageSize: when generating an image, nudge the model to a specific
  // dimension via a prompt suffix. The web client itself relies on the model
  // interpreting natural language, so this is the honest implementation.
  imageSize = null,
}) {
  if (typeof prompts === "string") prompts = [prompts];

  await ensureAuth(account, { via });
  const auth = loadAuth(account);
  const accountId = await resolveAccountId(account, auth);

  // Upload up front — same uploads are reused across every prompt in the batch.
  const attachments = [];
  for (const p of attach || []) attachments.push(await uploadFile(account, auth, p, { useCase: "multimodal", via }));
  for (const p of docs || []) attachments.push(await uploadFile(account, auth, p, { useCase: "my_files", via }));

  const timings = { perPrompt: [], uploads: attachments.length };
  const hints = reasoning ? ["reason"] : (search ? ["search"] : []);
  const tools = search ? [{ type: "web_search" }] : [];
  const sizeSuffix = imageSize ? `\n\n(画像サイズは ${imageSize} ピクセルで生成してください。)` : "";
  const frame = (p) => (system ? `${system}\n\n${p}` : p) + sizeSuffix;
  let convCursor = conversationId;
  const results = [];
  for (let i = 0; i < prompts.length; i++) {
    // Attachments are a feature of the first turn; follow-ups inside the same
    // thread should NOT re-paste them.
    const turnAttachments = i === 0 ? attachments : [];
    const r = await sendOne(account, auth, accountId, frame(prompts[i]), {
      convId: convCursor, timeoutMs, via,
      gizmoId: gizmo || null,
      attachments: turnAttachments,
      model, hints, tools,
    });
    timings.perPrompt.push(r.timings);
    const res = { text: r.text, images: r.images || [], conversationId: r.conversationId };
    if (sameChat && res.conversationId) convCursor = res.conversationId;
    // Download generated images while the bearer is live.
    if (saveDir && res.images.length) {
      fs.mkdirSync(saveDir, { recursive: true });
      res.savedPaths = [];
      for (const im of res.images) {
        try {
          const { buf } = await downloadAsset(account, im.id, via);
          let out = keepMetadata ? buf : stripMetadata(buf);
          let ext = EXT[im.mime] || "png";
          if (scrub) {
            const opts = typeof scrub === "object" && scrub ? scrub : {};
            const r = await scrubPixels(out, opts);
            out = r.buf; ext = r.ext;
          }
          const p = path.join(saveDir, `${res.conversationId || "img"}-${im.id.replace(/^file_0*/, "").slice(0, 12)}.${ext}`);
          fs.writeFileSync(p, out);
          res.savedPaths.push(p);
        } catch { /* skip a failed image, keep the rest */ }
      }
    }
    results.push(res);
  }
  return { results, timings };
}
