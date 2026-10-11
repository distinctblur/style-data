#!/usr/bin/env node
// style-data — upload pin images to the private R2 bucket (ADR-0001 #2).
//
//   node pipeline/upload-images.mjs [--pins data/pins.jsonl] [--manifest data/images.jsonl]
//        [--bucket style-data] [--concurrency 2] [--dry-run] [--limit N]
//
// For every pins.jsonl row that has a local image and no `dupe_of`, compute the
// key `pins/<board>/<pin_id>.<ext>` and run
//
//   wrangler r2 object put <bucket>/<key> --file <image> --content-type <mime> --remote
//
// then append one line to the manifest (append-only; rows are never rewritten).
// Re-runs are idempotent: a pin whose (pin_id, sha256) is already in the manifest
// is skipped, so a changed image is uploaded again under the same key. One retry
// per failed upload. `--dry-run` lists what would be uploaded and the byte total
// and runs nothing (this is the keyless / no-network path).
//
// wrangler is not a dependency of this repo: set WRANGLER to its path, otherwise
// the studio repo's copy (../studio/node_modules/.bin/wrangler) is used.
//
// Exit code: 0 when nothing failed, 1 otherwise.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const SCHEMA_VERSION = 1;
export const DEFAULT_BUCKET = "style-data";
export const DEFAULT_PINS = path.join(ROOT, "data", "pins.jsonl");
export const DEFAULT_MANIFEST = path.join(ROOT, "data", "images.jsonl");
export const DEFAULT_WRANGLER = path.join(ROOT, "..", "studio", "node_modules", ".bin", "wrangler");
export const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

// --- Files -------------------------------------------------------------------------

/** Parse a JSONL file; missing file → []. Blank lines are ignored. */
export function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const rows = [];
  text.split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    try { rows.push(JSON.parse(l)); } catch { throw new Error(`${file}:${i + 1}: invalid JSON`); }
  });
  return rows;
}

/** Set of "pin_id\tsha256" for every manifest row, the idempotency key. */
export function manifestKeys(rows) {
  return new Set(rows.map((r) => `${r.pin_id}\t${r.sha256}`));
}

export function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// --- Key scheme ------------------------------------------------------------------------

/** `pins/<board>/<pin_id>.<ext>`; the extension is the local file's, lower-cased. */
export function r2Key(pin) {
  const ext = path.extname(pin.image_path ?? "").toLowerCase();
  if (!ext) throw new Error(`pin ${pin.pin_id}: image_path has no extension`);
  if (/[/\\]/.test(`${pin.board}${pin.pin_id}`)) throw new Error(`pin ${pin.pin_id}: board/pin_id must not contain path separators`);
  return `pins/${pin.board}/${pin.pin_id}${ext}`;
}

export function contentType(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

// --- Plan ------------------------------------------------------------------------------

/**
 * Decide what to do with each pin row.
 * @returns {{ todo: object[], skippedExisting: number, missing: number, dupes: number, bytes: number }}
 */
export function planUploads(pins, manifestRows, { limit = Infinity } = {}) {
  const have = manifestKeys(manifestRows);
  const plan = { todo: [], skippedExisting: 0, missing: 0, dupes: 0, bytes: 0 };
  for (const pin of pins) {
    if (pin.dupe_of) { plan.dupes++; continue; }
    if (!pin.image_path || !fs.existsSync(pin.image_path)) { plan.missing++; continue; }
    const sha256 = pin.sha256 ?? sha256File(pin.image_path);
    if (have.has(`${pin.pin_id}\t${sha256}`)) { plan.skippedExisting++; continue; }
    if (plan.todo.length >= limit) continue;
    const bytes = fs.statSync(pin.image_path).size;
    plan.todo.push({ pin_id: pin.pin_id, board: pin.board, r2_key: r2Key(pin), sha256, bytes, content_type: contentType(pin.image_path), image_path: pin.image_path });
    plan.bytes += bytes;
  }
  return plan;
}

// --- Upload ---------------------------------------------------------------------------

export function wranglerArgs(bucket, item) {
  return ["r2", "object", "put", `${bucket}/${item.r2_key}`, "--file", item.image_path, "--content-type", item.content_type, "--remote"];
}

/** Default runner: spawn wrangler, capture output, resolve with { code, output }. */
export function spawnRunner(args, { wrangler = process.env.WRANGLER || DEFAULT_WRANGLER } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrangler, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/** Upload one item, retrying once. `run(args)` resolves with { code, output } or throws. */
export async function uploadOne(item, { bucket, run, retries = 1 }) {
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { code, output = "" } = await run(wranglerArgs(bucket, item));
      if (code === 0) return { ok: true, attempts: attempt + 1 };
      last = `exit ${code}${output.trim() ? `: ${output.trim().split("\n").pop()}` : ""}`;
    } catch (err) {
      last = err?.message ?? String(err);
    }
  }
  return { ok: false, attempts: retries + 1, error: last };
}

/**
 * Upload every planned item with a small worker pool; successful ones are appended to the manifest immediately.
 * @returns {Promise<{uploaded: number, failed: number, bytes: number, skippedExisting: number, missing: number, dupes: number, dryRun: boolean, failures: Array<{pin_id: string, error: string}>}>}
 */
export async function uploadImages({ pinsPath = DEFAULT_PINS, manifestPath = DEFAULT_MANIFEST, bucket = DEFAULT_BUCKET, concurrency = 2, dryRun = false, limit = Infinity, run = spawnRunner, now = () => new Date(), log = console.error } = {}) {
  const pins = readJsonl(pinsPath);
  const plan = planUploads(pins, readJsonl(manifestPath), { limit });
  const summary = { uploaded: 0, failed: 0, bytes: 0, skippedExisting: plan.skippedExisting, missing: plan.missing, dupes: plan.dupes, planned: plan.todo.length, plannedBytes: plan.bytes, dryRun, failures: [] };

  if (dryRun) {
    for (const it of plan.todo) log(`[dry-run] ${bucket}/${it.r2_key}  ${it.bytes} bytes  ${it.content_type}`);
    return summary;
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const queue = [...plan.todo];
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      const res = await uploadOne(it, { bucket, run });
      if (res.ok) {
        const row = { schema_version: SCHEMA_VERSION, pin_id: it.pin_id, board: it.board, r2_key: it.r2_key, sha256: it.sha256, bytes: it.bytes, content_type: it.content_type, uploaded_at: now().toISOString() };
        fs.appendFileSync(manifestPath, JSON.stringify(row) + "\n");
        summary.uploaded++;
        summary.bytes += it.bytes;
        if (res.attempts > 1) log(`retried ${it.r2_key} (ok on attempt ${res.attempts})`);
      } else {
        summary.failed++;
        summary.failures.push({ pin_id: it.pin_id, error: res.error });
        console.error(`upload failed ${it.r2_key}: ${res.error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return summary;
}

export function formatSummary(s) {
  const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  const lines = [`--- upload-images.mjs summary${s.dryRun ? " (dry-run, nothing ran)" : ""} ---`];
  if (s.dryRun) lines.push(`would upload ${s.planned}  (${s.plannedBytes} bytes, ${mb(s.plannedBytes)})`);
  else lines.push(`uploaded ${s.uploaded}  failed ${s.failed}  bytes ${s.bytes} (${mb(s.bytes)})`);
  lines.push(`skipped-existing ${s.skippedExisting}  dupes ${s.dupes}  missing ${s.missing}`);
  return lines.join("\n");
}

// --- CLI -------------------------------------------------------------------------------

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pins: { type: "string", default: DEFAULT_PINS },
      manifest: { type: "string", default: DEFAULT_MANIFEST },
      bucket: { type: "string", default: DEFAULT_BUCKET },
      concurrency: { type: "string", default: "2" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });
  const num = (v, name) => {
    if (v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
    return n;
  };
  return {
    pinsPath: values.pins,
    manifestPath: values.manifest,
    bucket: values.bucket,
    concurrency: Math.max(1, num(values.concurrency, "concurrency") ?? 2),
    dryRun: values["dry-run"],
    limit: num(values.limit, "limit") ?? Infinity,
  };
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (!fs.existsSync(opts.pinsPath)) {
    console.error(`pins file not found: ${opts.pinsPath} (run pipeline/normalise.mjs first)`);
    process.exit(1);
  }
  if (!opts.dryRun && !process.env.WRANGLER && !fs.existsSync(DEFAULT_WRANGLER)) {
    console.error(`wrangler not found at ${DEFAULT_WRANGLER}; set WRANGLER=/path/to/wrangler`);
    process.exit(1);
  }
  const summary = await uploadImages(opts);
  console.error(formatSummary(summary));
  process.exit(summary.failed > 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
