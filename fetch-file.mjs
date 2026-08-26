// fetch-file.mjs <account> <file_id> <out_path>
// Resolves a generated file's signed URL via /backend-api/files/<id>/download,
// then streams it with the account's bearer + cookies.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [account, fileId, outPath] = process.argv.slice(2);
if (!account || !fileId || !outPath) {
  console.error("usage: node fetch-file.mjs <account> <file_id> <out_path>");
  process.exit(1);
}
const authDir = process.env.OPENGPT_AUTH_DIR || join(dirname(fileURLToPath(import.meta.url)), "auth");
const auth = JSON.parse(readFileSync(join(authDir, `${account}.json`), "utf8"));
const cookieHeader = auth.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const headers = {
  authorization: `Bearer ${auth.accessToken}`,
  cookie: cookieHeader,
  "user-agent": auth.userAgent || "Mozilla/5.0",
  referer: "https://chatgpt.com/",
};

const meta = await (await fetch(`https://chatgpt.com/backend-api/files/${fileId}/download`, { headers })).json();
if (!meta.download_url) { console.error("no download_url:", JSON.stringify(meta)); process.exit(1); }
const res = await fetch(meta.download_url, { headers });
if (!res.ok) { console.error("download failed:", res.status, await res.text()); process.exit(1); }
writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
console.log(`saved ${outPath} (${meta.file_name}, ${meta.file_size_bytes} bytes)`);
