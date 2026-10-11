#!/usr/bin/env node
// style-data — download every pin of the registered Pinterest boards with gallery-dl.
//
//   node pipeline/extract.mjs [--board slug ...] [--range 1-5] [--dry-run]
//                             [--until-complete] [--max-attempts 6] [--stall 2]
//                             [--skip-detail | --detail-only]
//
// Reads boards.json, resolves the Pinterest session cookie (PINTEREST_SESS from
// the environment, else `.dev.vars` at the repo root), and runs two passes per
// board, sequentially, with inherited stdio so gallery-dl's own progress is visible:
//
//   pass 1 (board feed → images + grid sidecars):
//     uvx gallery-dl --write-metadata -o stories=false -o videos=false [--range …]
//         [--cookies out/pins/.cookies.txt] -D out/pins/<slug> <board url>
//   pass 2 (per-pin PinResource → detail sidecars only; has created_at, rich_metadata, …):
//     uvx gallery-dl --no-download --write-metadata --sleep-request 0.5
//         [--cookies …] -D out/pins/<slug>/detail -i out/pins/logs/<slug>.pins.txt
//     where the list file holds https://www.pinterest.com/pin/<id>/ for every pin id
//     found in pass 1's sidecars that has no detail sidecar yet (nothing pending → skipped).
//
// The unauthenticated board feed is flaky (roughly one run in two stops after the
// first page of 24 pins or returns nothing). `--until-complete` re-runs pass 1
// while the sidecar count grows: it stops when the count reaches the board's
// `pin_count` (read from any sidecar's `board.pin_count`), after `--stall`
// consecutive attempts without growth (default 2: the observed 24 → 24 → 336
// sequence needs one tolerated stall), or after `--max-attempts`. gallery-dl
// skips files it already has, so every retry is cheap.
//
// `--dry-run` prints each argv (both passes) with the cookie value masked and
// runs nothing; this is the keyless / no-network path. Without a cookie the
// boards are fetched unauthenticated (they are public). The cookie value is
// never logged: it travels in a 0600 jar inside out/pins (removed after the run)
// and `maskArgv` is applied to everything printed.
//
// Exit code: 0 when every board succeeded, 1 otherwise.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const DEFAULT_BOARDS_FILE = path.join(ROOT, "boards.json");
export const DEFAULT_OUT_DIR = path.join(ROOT, "out", "pins");
export const COOKIE_NAME = "_pinterest_sess";
export const MASK = "***";
export const DEFAULT_MAX_ATTEMPTS = 6;
export const DEFAULT_STALL = 2;
export const DETAIL_SLEEP = "0.5";
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const SIDECAR_ID = /^pinterest_(\d+)(?:[._].*)?\.json$/;
const DETAIL_ID = /^pinterest_(\d+)(?:[._].*)?\.json$/;

// --- Config -------------------------------------------------------------------------

/** Parse boards.json; throws when the shape is wrong. */
export function loadBoards(file = DEFAULT_BOARDS_FILE) {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(cfg.boards) || cfg.boards.length === 0) throw new Error(`${file}: "boards" must be a non-empty array`);
  for (const b of cfg.boards) {
    if (!b.slug || !b.url || !b.domain) throw new Error(`${file}: every board needs slug, url and domain (got ${JSON.stringify(b)})`);
  }
  return cfg.boards;
}

/** Keep the boards whose slug is listed; unknown slugs are an error. Empty list = all. */
export function selectBoards(boards, slugs = []) {
  if (!slugs.length) return boards;
  const known = new Set(boards.map((b) => b.slug));
  const unknown = slugs.filter((s) => !known.has(s));
  if (unknown.length) throw new Error(`unknown board(s): ${unknown.join(", ")} (known: ${[...known].join(", ")})`);
  return boards.filter((b) => slugs.includes(b.slug));
}

/** PINTEREST_SESS from env, else `.dev.vars` at the repo root. Null when absent or empty. */
export function resolveCookie(env = process.env, devVarsPath = path.join(ROOT, ".dev.vars")) {
  if (env.PINTEREST_SESS?.trim()) return env.PINTEREST_SESS.trim();
  try {
    const m = /^PINTEREST_SESS=(.*)$/m.exec(fs.readFileSync(devVarsPath, "utf8"));
    const v = m?.[1].replace(/^["']|["']$/g, "").trim();
    return v || null;
  } catch {
    return null;
  }
}

// --- Argv -------------------------------------------------------------------------

/**
 * Build the pass-1 gallery-dl invocation for one board (board feed → images + sidecars).
 * @returns {{ command: string, args: string[], outDir: string }}
 */
export function buildArgv(board, { cookieFile = null, range = null, outDir = DEFAULT_OUT_DIR } = {}) {
  const dir = path.join(outDir, board.slug);
  const args = ["gallery-dl", "--write-metadata", "-o", "stories=false", "-o", "videos=false"];
  if (range) args.push("--range", range);
  // The cookie travels in a 0600 jar file, never on the command line (visible in `ps`).
  if (cookieFile) args.push("--cookies", cookieFile);
  args.push("-D", dir, board.url);
  return { command: "uvx", args, outDir: dir };
}

/** Where pass 2 writes its sidecars for a board. */
export function detailDir(board, outDir = DEFAULT_OUT_DIR) {
  return path.join(outDir, board.slug, "detail");
}

/** The pin-URL list file pass 2 reads (`-i`), kept out of the board directory so normalise ignores it. */
export function pinListPath(board, outDir = DEFAULT_OUT_DIR) {
  return path.join(outDir, "logs", `${board.slug}.pins.txt`);
}

export function pinUrl(pinId) {
  return `https://www.pinterest.com/pin/${pinId}/`;
}

/**
 * Build the pass-2 gallery-dl invocation for one board (per-pin PinResource → detail sidecars, no images).
 * @returns {{ command: string, args: string[], outDir: string, listFile: string }}
 */
export function buildDetailArgv(board, { cookieFile = null, outDir = DEFAULT_OUT_DIR } = {}) {
  const dir = detailDir(board, outDir);
  const listFile = pinListPath(board, outDir);
  const args = ["gallery-dl", "--no-download", "--write-metadata", "--sleep-request", DETAIL_SLEEP];
  if (cookieFile) args.push("--cookies", cookieFile);
  args.push("-D", dir, "-i", listFile);
  return { command: "uvx", args, outDir: dir, listFile };
}

/**
 * Write a Netscape-format cookie jar holding only the Pinterest session cookie,
 * mode 0600, inside outDir (gitignored). Returns the path; caller removes it.
 */
export function writeCookieJar(cookie, outDir = DEFAULT_OUT_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, ".cookies.txt");
  const expires = Math.floor(Date.now() / 1000) + 7 * 86400;
  const line = ["\.pinterest.com", "TRUE", "/", "TRUE", String(expires), COOKIE_NAME, cookie].join("\t");
  fs.writeFileSync(file, `# Netscape HTTP Cookie File\n${line}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Copy of argv safe to print: the session cookie value is replaced by MASK. */
export function maskArgv(args) {
  const re = new RegExp(`("${COOKIE_NAME}"\\s*:\\s*")[^"]*(")`);
  return args.map((a) => (a.startsWith("cookies=") ? a.replace(re, `$1${MASK}$2`) : a));
}

/** Shell-ish rendering for logs (already masked by the caller). */
export function formatCommand(command, args) {
  const q = (s) => (/[^A-Za-z0-9_\-./:=@]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s);
  return [command, ...args].map(q).join(" ");
}

// --- Sidecar inspection ------------------------------------------------------------

/** Default runner: spawn with inherited stdio, resolve with the exit code. */
export function spawnRunner(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/** Count images and `.json` sidecars directly under `dir` (0/0 when it does not exist). */
export function countFiles(dir) {
  let images = 0;
  let sidecars = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { images, sidecars }; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.endsWith(".json")) sidecars++;
    else if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) images++;
  }
  return { images, sidecars };
}

function sidecarFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * Pin ids present in a directory of gallery-dl sidecars: the sidecar's `id`
 * field when it parses, else the `pinterest_<id>` file-name stem. Sorted, unique.
 * Sidecars are downloaded data: parsed as JSON only, never executed.
 */
export function listPinIds(dir, pattern = SIDECAR_ID) {
  const ids = new Set();
  for (const name of sidecarFiles(dir)) {
    let id = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (parsed && typeof parsed === "object" && parsed.id != null && /^\d+$/.test(String(parsed.id))) id = String(parsed.id);
    } catch { /* fall back to the file name */ }
    if (id === null) id = pattern.exec(name)?.[1] ?? null;
    if (id !== null) ids.add(id);
  }
  return [...ids].sort();
}

/** The board's own `pin_count` as reported inside any pass-1 sidecar (`board.pin_count`), or null. */
export function readPinCount(dir) {
  for (const name of sidecarFiles(dir)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      const n = parsed?.board?.pin_count;
      if (Number.isInteger(n) && n >= 0) return n;
    } catch { /* try the next one */ }
  }
  return null;
}

/** Pin ids from pass 1 that have no detail sidecar yet. */
export function pendingDetailIds(boardDir, detailDirPath) {
  const have = new Set(listPinIds(detailDirPath, DETAIL_ID));
  return listPinIds(boardDir).filter((id) => !have.has(id));
}

// --- Run ---------------------------------------------------------------------------

/**
 * Run pass 1 for one board, optionally repeating while the sidecar count grows.
 * Returns the last exit code plus the attempt log. `run(command, args)` resolves with an exit code.
 */
export async function runBoardFeed(board, { command, args, dir, run, log, untilComplete = false, maxAttempts = DEFAULT_MAX_ATTEMPTS, stall = DEFAULT_STALL }) {
  const attempts = [];
  let code = null;
  let previous = countFiles(dir).sidecars;
  let stalled = 0;
  const limit = untilComplete ? Math.max(1, maxAttempts) : 1;
  for (let attempt = 1; attempt <= limit; attempt++) {
    try {
      code = await run(command, args);
    } catch (err) {
      console.error(`extract ${board.slug}: ${err?.message ?? err}`);
      code = 1;
    }
    const sidecars = countFiles(dir).sidecars;
    const pinCount = readPinCount(dir);
    attempts.push({ attempt, code, sidecars, pinCount });
    if (!untilComplete) break;
    let stop = null;
    if (pinCount !== null && sidecars >= pinCount) stop = `reached board pin_count ${pinCount}`;
    else if (sidecars > previous) stalled = 0;
    else if (++stalled >= stall) stop = `no growth for ${stalled} attempt${stalled === 1 ? "" : "s"} (${sidecars} sidecars${pinCount !== null ? ` of ${pinCount}` : ""})`;
    log(`${board.slug}: attempt ${attempt}/${limit} exit ${code}, ${sidecars} sidecars${pinCount !== null ? ` (board pin_count ${pinCount})` : ""}${stop ? ` — stop: ${stop}` : ""}`);
    previous = sidecars;
    if (stop) break;
    if (attempt === limit) log(`${board.slug}: giving up after ${limit} attempts (${sidecars} sidecars)`);
  }
  return { code, attempts };
}

/**
 * Run both passes for each board in order. `run(command, args)` must resolve with an exit code.
 * @returns {Promise<{boards: Array<{slug: string, code: number|null, detailCode: number|null, attempts: number, images: number, sidecars: number, detail: number, pending: number}>, failed: number, dryRun: boolean}>}
 */
export async function extractBoards(boards, {
  cookie = null, range = null, outDir = DEFAULT_OUT_DIR, dryRun = false, run = spawnRunner, log = console.error,
  untilComplete = false, maxAttempts = DEFAULT_MAX_ATTEMPTS, stall = DEFAULT_STALL, skipDetail = false, detailOnly = false,
} = {}) {
  const summary = { boards: [], failed: 0, dryRun };
  log(cookie ? `cookie: ${COOKIE_NAME} resolved (value not shown)` : `cookie: none — fetching boards unauthenticated`);
  const cookieFile = cookie && !dryRun ? writeCookieJar(cookie, outDir) : cookie ? path.join(outDir, ".cookies.txt") : null;
  try {
    for (const board of boards) {
      const row = { slug: board.slug, code: null, detailCode: null, attempts: 0, images: 0, sidecars: 0, detail: 0, pending: 0 };
      const { command, args, outDir: dir } = buildArgv(board, { cookieFile, range, outDir });
      const detail = buildDetailArgv(board, { cookieFile, outDir });

      // Pass 1: board feed.
      if (!detailOnly) {
        log(`${dryRun ? "[dry-run] " : ""}${board.slug}: ${formatCommand(command, maskArgv(args))}${untilComplete ? ` (until complete, max ${maxAttempts} attempts, stall ${stall})` : ""}`);
        if (!dryRun) {
          fs.mkdirSync(dir, { recursive: true });
          const r = await runBoardFeed(board, { command, args, dir, run, log, untilComplete, maxAttempts, stall });
          row.code = r.code;
          row.attempts = r.attempts.length;
          if (r.code !== 0) summary.failed++;
        }
      }

      // Pass 2: per-pin detail for every id from pass 1 that has no detail sidecar yet.
      if (!skipDetail) {
        const pending = pendingDetailIds(dir, detail.outDir);
        row.pending = pending.length;
        log(`${dryRun ? "[dry-run detail] " : ""}${board.slug}: ${formatCommand(detail.command, maskArgv(detail.args))} (${pending.length} pin${pending.length === 1 ? "" : "s"} pending)`);
        if (!dryRun && pending.length) {
          fs.mkdirSync(detail.outDir, { recursive: true });
          fs.mkdirSync(path.dirname(detail.listFile), { recursive: true });
          fs.writeFileSync(detail.listFile, pending.map(pinUrl).join("\n") + "\n");
          try {
            row.detailCode = await run(detail.command, detail.args);
          } catch (err) {
            console.error(`extract ${board.slug} detail: ${err?.message ?? err}`);
            row.detailCode = 1;
          }
          if (row.detailCode !== 0 && row.code === 0) summary.failed++;
          const still = pendingDetailIds(dir, detail.outDir).length;
          if (still) log(`${board.slug}: ${still} pin${still === 1 ? "" : "s"} still without detail sidecar (re-run to retry)`);
        }
      }

      Object.assign(row, countFiles(dir), { detail: countFiles(detail.outDir).sidecars });
      summary.boards.push(row);
    }
  } finally {
    if (cookieFile && !dryRun) fs.rmSync(cookieFile, { force: true });
  }
  return summary;
}

export function formatSummary(s) {
  const lines = [`--- extract.mjs summary${s.dryRun ? " (dry-run, nothing ran)" : ""} ---`];
  for (const b of s.boards) {
    const feed = s.dryRun ? "planned" : b.code === null ? "skipped" : b.code === 0 ? "ok" : `FAILED (exit ${b.code})`;
    const det = s.dryRun ? "" : b.detailCode === null ? "" : b.detailCode === 0 ? "  detail ok" : `  detail FAILED (exit ${b.detailCode})`;
    const attempts = !s.dryRun && b.attempts > 1 ? `  attempts ${b.attempts}` : "";
    lines.push(`${b.slug.padEnd(14)} ${feed.padEnd(16)} images ${b.images}  sidecars ${b.sidecars}  detail ${b.detail}${det}${attempts}`);
  }
  if (!s.dryRun) lines.push(`boards failed: ${s.failed} / ${s.boards.length}`);
  return lines.join("\n");
}

// --- CLI ---------------------------------------------------------------------------

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      board: { type: "string", multiple: true, default: [] },
      range: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      boards: { type: "string", default: DEFAULT_BOARDS_FILE },
      out: { type: "string", default: DEFAULT_OUT_DIR },
      "until-complete": { type: "boolean", default: false },
      "max-attempts": { type: "string", default: String(DEFAULT_MAX_ATTEMPTS) },
      stall: { type: "string", default: String(DEFAULT_STALL) },
      "skip-detail": { type: "boolean", default: false },
      "detail-only": { type: "boolean", default: false },
    },
  });
  if (values.range !== undefined && !/^\d+(-\d*)?$/.test(values.range)) throw new Error("--range must look like 1-5 (gallery-dl syntax)");
  const maxAttempts = Number(values["max-attempts"]);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("--max-attempts must be a positive integer");
  const stall = Number(values.stall);
  if (!Number.isInteger(stall) || stall < 1) throw new Error("--stall must be a positive integer");
  if (values["skip-detail"] && values["detail-only"]) throw new Error("--skip-detail and --detail-only are mutually exclusive");
  return {
    slugs: values.board,
    range: values.range ?? null,
    dryRun: values["dry-run"],
    boardsFile: values.boards,
    outDir: values.out,
    untilComplete: values["until-complete"],
    maxAttempts,
    stall,
    skipDetail: values["skip-detail"],
    detailOnly: values["detail-only"],
  };
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const boards = selectBoards(loadBoards(opts.boardsFile), opts.slugs);
  const cookie = resolveCookie();
  const summary = await extractBoards(boards, {
    cookie, range: opts.range, outDir: opts.outDir, dryRun: opts.dryRun,
    untilComplete: opts.untilComplete, maxAttempts: opts.maxAttempts, stall: opts.stall,
    skipDetail: opts.skipDetail, detailOnly: opts.detailOnly,
  });
  console.error(formatSummary(summary));
  process.exit(summary.failed > 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
