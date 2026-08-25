// Paths and shared constants.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const HOME = os.homedir();

// project root (this file is <root>/src/config.mjs)
const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Where saved auth blobs live: <root>/auth/<account>.json
export const AUTH_DIR = process.env.OPENGPT_AUTH_DIR || path.join(PKG_ROOT, "auth");

// The webtrace plugin already keeps logged-in cloakbrowser profiles here.
// `login --profile <name>` resolves a bare name against this dir.
export const PROFILE_ROOT = process.env.OPENGPT_PROFILE_ROOT
  || path.join(HOME, ".claude/skills/webtrace/profiles");

export const BASE = "https://chatgpt.com";

// The oai-* headers the web client sends. Values are cosmetic for the
// Bearer-only endpoints but keep requests looking like the real client.
export const CLIENT_HEADERS = {
  "oai-language": "ja-JP",
  "accept": "*/*",
  "accept-language": "ja,en-US;q=0.9,en;q=0.8",
};

export function ensureAuthDir() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

export function resolveProfile(p) {
  if (!p) return null;
  if (p.includes("/") || fs.existsSync(p)) return path.resolve(p);
  return path.join(PROFILE_ROOT, p);
}
