// Projects (gizmo_type "snorlax"): create / list / update / delete, move a
// conversation into one, and upload source files.
//
// Everything here is Bearer-only — no sentinel tokens, no browser. Captured
// with the webtrace skill; see README "Projects" for the endpoint table.
import fs from "node:fs";
import path from "node:path";
import { api } from "./http.mjs";
import { BASE, CLIENT_HEADERS } from "./config.mjs";
import { cookieHeader, isExpired, refresh, loadAuth } from "./auth.mjs";

// The UI's two memory settings map onto memory_scope. "unset" is what the web
// client posts on create; the server resolves it to "global".
export const MEMORY_SCOPES = {
  default: "global",   // project can read/write the global memory, and vice versa
  project: "project_v2", // project keeps its own memory, invisible outside
  unset: "unset",
};

function scope(v) {
  if (!v) return undefined;
  const s = MEMORY_SCOPES[v] || v;
  if (!["global", "project_v2", "unset"].includes(s)) {
    throw new Error(`unknown --memory: ${v} (use default|project)`);
  }
  return s;
}

const MIME = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
  ".html": "text/html", ".js": "text/javascript", ".py": "text/x-python",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listProjects(account, { limit = 20, via } = {}) {
  const r = await api(
    account, "GET",
    `/backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=${limit}`,
    { via },
  );
  return (r.items || []).map((it) => {
    const g = it.gizmo?.gizmo || it.gizmo || {};
    return {
      id: g.id,
      name: g.display?.name,
      instructions: g.instructions || "",
      memory_scope: g.memory_scope,
      memory_enabled: g.memory_enabled,
      updated_at: g.updated_at,
      num_interactions: g.num_interactions,
    };
  });
}

export async function getProject(account, gid, { via } = {}) {
  return api(account, "GET", `/backend-api/gizmos/${gid}?include_file_limits=true`, { via });
}

export async function createProject(account, { name, instructions = "", memory, via } = {}) {
  if (!name) throw new Error("project name is required");
  const body = { instructions, name, memory_scope: scope(memory) || "unset" };
  const r = await api(account, "POST", "/backend-api/projects", { json: body, via });
  return r.resource?.gizmo || r;
}

// PATCH is a full replace of name/instructions/emoji/theme — the server 422s on
// a partial body — so unspecified fields are read back from the project first.
export async function updateProject(account, gid, { name, instructions, memory, emoji, theme, via } = {}) {
  const cur = (await getProject(account, gid, { via })).gizmo || {};
  const body = {
    name: name ?? cur.display?.name ?? "",
    instructions: instructions ?? cur.instructions ?? "",
    emoji: emoji ?? cur.display?.emoji ?? null,
    theme: theme ?? cur.display?.theme ?? null,
  };
  const s = scope(memory);
  if (s) body.memory_scope = s;
  const r = await api(account, "PATCH", `/backend-api/projects/${gid}`, { json: body, via });
  return r.resource?.gizmo || r;
}

export async function deleteProject(account, gid, { via } = {}) {
  return api(account, "DELETE", `/backend-api/gizmos/${gid}`, { via });
}

export async function listProjectChats(account, gid, { cursor = 0, via } = {}) {
  return api(account, "GET", `/backend-api/gizmos/${gid}/conversations?cursor=${cursor}`, { via });
}

// Moving a chat into a project (or out of one, with gizmo_id null).
export async function moveConversation(account, conversationId, gid, { via } = {}) {
  return api(account, "PATCH", `/backend-api/conversation/${conversationId}`,
    { json: { gizmo_id: gid || null }, via });
}

export async function listProjectFiles(account, gid, { via } = {}) {
  const r = await getProject(account, gid, { via });
  return (r.files || []).map((f) => ({
    id: f.id, file_id: f.file_id, name: f.name, type: f.type, size: f.size,
    created_at: f.created_at,
  }));
}

// ── source upload ───────────────────────────────────────────────────────────
// Three steps, exactly as the web client does it:
//   1. POST /backend-api/files            → presigned Azure blob upload_url + file_id
//   2. PUT  <upload_url>                  → the bytes (no auth; presigned)
//   3. POST /backend-api/files/process_upload_stream → JSONL progress; the
//      terminal event carries extra.metadata_object_id = the library_file_id
//   4. POST /backend-api/projects/<gid>/files → attach it as a project source

async function authHeaders(account) {
  let auth = loadAuth(account);
  if (isExpired(auth)) {
    await refresh(account, { via: "auto" });
    auth = loadAuth(account);
  }
  return {
    ...CLIENT_HEADERS,
    authorization: `Bearer ${auth.accessToken}`,
    cookie: cookieHeader(auth),
    "user-agent": auth.userAgent || "Mozilla/5.0",
  };
}

async function uploadOne(account, gid, filePath, { via } = {}) {
  const abs = path.resolve(filePath);
  const buf = fs.readFileSync(abs);
  const stat = fs.statSync(abs);
  const name = path.basename(abs);
  const mime = mimeFor(abs);
  const tzOffset = -new Date().getTimezoneOffset();

  const start = await api(account, "POST", "/backend-api/files", {
    via,
    json: {
      file_name: name,
      file_size: stat.size,
      use_case: "agent",
      gizmo_id: gid,
      timezone_offset_min: tzOffset,
      reset_rate_limits: false,
      supports_direct_azure_multipart: true,
      mime_type: mime,
      entry_surface: "project_sources",
      client_resolved_mime_type: mime,
      mime_resolution_source: "filename_extension",
      store_in_library: true,
    },
  });
  if (!start.upload_url) throw new Error(`no upload_url for ${name}: ${JSON.stringify(start).slice(0, 200)}`);

  const put = await fetch(start.upload_url, {
    method: "PUT",
    headers: { "content-type": mime, "x-ms-blob-type": "BlockBlob", "x-ms-version": "2020-04-08" },
    body: buf,
  });
  if (!put.ok) throw new Error(`blob PUT ${put.status} for ${name}`);

  // Images are not retrieval-indexed by the web client; text-ish files are.
  const indexForRetrieval = !mime.startsWith("image/");
  const res = await fetch(`${BASE}/backend-api/files/process_upload_stream`, {
    method: "POST",
    headers: { ...(await authHeaders(account)), "content-type": "application/json" },
    body: JSON.stringify({
      file_id: start.file_id,
      use_case: "agent",
      gizmo_id: gid,
      index_for_retrieval: indexForRetrieval,
      file_name: name,
      entry_surface: "project_sources",
      metadata: {
        store_in_library: true,
        is_temporary_chat: false,
        is_project_thread: true,
        library_file_info: { gizmo_id: gid, is_project: true, should_upload_to_project: true },
      },
    }),
  });
  const stream = await res.text();
  if (!res.ok) throw new Error(`process_upload_stream ${res.status}: ${stream.slice(0, 200)}`);

  let libraryFileId = null;
  for (const line of stream.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.extra?.metadata_object_id) libraryFileId = ev.extra.metadata_object_id;
    } catch { /* partial line */ }
  }

  return {
    file_id: start.file_id,
    name,
    size: stat.size,
    type: mime,
    last_modified: Math.round(stat.mtimeMs), // ms epoch; the API rejects a fractional part
    library_file_id: libraryFileId,
    location: "fs",
  };
}

export async function addProjectFiles(account, gid, filePaths, { via } = {}) {
  const files = [];
  for (const p of filePaths) files.push(await uploadOne(account, gid, p, { via }));
  const r = await api(account, "POST", `/backend-api/projects/${gid}/files`, { json: { files }, via });
  return { attached: files.map((f) => ({ name: f.name, file_id: f.file_id })), resource: r.resource?.gizmo?.id };
}
