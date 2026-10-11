#!/usr/bin/env node
// style-data — normalise gallery-dl Pinterest sidecars into data/pins.jsonl (schema v2).
//
//   node pipeline/normalise.mjs [--in out/pins] [--out data/pins.jsonl] [--boards boards.json]
//
// Input layout (produced by pipeline/extract.mjs, two passes):
//   <in>/<board-slug>/pinterest_<id>.<ext>             the downloaded image (scratch, gitignored)
//   <in>/<board-slug>/pinterest_<id>.<ext>.json        board-feed ("grid") sidecar, pass 1
//   <in>/<board-slug>/detail/pinterest_<id>.<ext>.json per-pin PinResource sidecar, pass 2
//                                                      (has created_at, rich_metadata, hashtags, …)
//   <in>/logs/                                         ignored
//
// `domain` comes from boards.json (slug → domain); an unregistered directory is
// still normalised, with domain "unknown" and a warning on stderr.
//
// Link-rot caveat: `rich.*` (and `link_domain`) describe the linked page as
// Pinterest crawled it *now*, not what was pinned. A 2011 home-decor link can
// resolve to an unrelated page today, so for old pins prefer `description`,
// `title`, `alt_text` and the image itself over `rich.*`.
//
// No network calls. Pure file walking + hashing. Exported functions are unit
// tested in test/normalise.test.mjs; the CLI entry point is at the bottom.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const DEFAULT_IN_DIR = path.join(ROOT, "out", "pins");
export const DEFAULT_OUT_PATH = path.join(ROOT, "data", "pins.jsonl");
export const DEFAULT_BOARDS_FILE = path.join(ROOT, "boards.json");

export const SCHEMA_VERSION = 2;
export const SOURCE = "pinterest";
export const UNKNOWN_DOMAIN = "unknown";

/** Output keys, in the exact order they must appear on every line (`dupe_of` goes after `is_video`, only when set). */
export const KEYS = [
  "schema_version",
  "pin_id",
  "source",
  "board",
  "domain",
  "created_at",
  "title",
  "description",
  "link",
  "link_domain",
  "dominant_color",
  "image_path",
  "image_url",
  "image_width",
  "image_height",
  "sha256",
  "is_video",
  // "dupe_of" (optional) is emitted here
  "alt_text",
  "stats",
  "rich",
  "raw_extra",
];

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const UPLOADED_BY_USER = /^uploaded by user$/i;
/** `rich.display_description` is capped here (marketing copy runs to 7 KB); the full text stays in the sidecar. */
export const RICH_DESCRIPTION_MAX = 500;

function str(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function firstStr(...values) {
  for (const v of values) {
    const s = str(v);
    if (s !== null) return s;
  }
  return null;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Positive finite number, else null (Pinterest uses 0 for "no price"). */
function positiveNum(value) {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

function bool(value) {
  return typeof value === "boolean" ? value : null;
}

/** Trim + cap a string at `max` characters (code points), appending "…" when cut. */
export function clip(value, max = RICH_DESCRIPTION_MAX) {
  const s = str(value);
  if (s === null) return null;
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join("").trimEnd() + "…";
}

function obj(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Pinterest returns RFC 2822 ("Sat, 15 Feb 2025 19:40:15 +0000"); emit ISO-8601 or null. */
export function toIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function toColour(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return HEX_COLOUR.test(v) ? v : null;
}

function storyHasVideo(story) {
  if (!story || typeof story !== "object" || !Array.isArray(story.pages)) return false;
  for (const page of story.pages) {
    for (const block of page?.blocks ?? []) {
      if (block?.type === "story_pin_video_block" || (block && "video" in block)) return true;
    }
  }
  return false;
}

export function isVideo(sidecar) {
  if (!sidecar || typeof sidecar !== "object") return false;
  if (sidecar.is_video === true) return true;
  if (sidecar.videos && typeof sidecar.videos === "object") return true;
  return storyHasVideo(sidecar.story_pin_data);
}

export function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

/** Hostname of a URL (lower-case, no port), or null. */
export function hostnameOf(url) {
  const s = str(url);
  if (!s) return null;
  try {
    return new URL(s).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The domain of the pin's outbound link: sidecar `link_domain.id`, else the
 * sidecar's `domain` string unless it is Pinterest's "Uploaded by user"
 * placeholder, else the hostname of `link`. Null for uploads with no link.
 */
export function toLinkDomain(s, d, link) {
  const explicit = firstStr(obj(s.link_domain)?.id, obj(d.link_domain)?.id, s.link_domain, d.link_domain);
  if (explicit) return explicit.toLowerCase();
  const fromDomain = firstStr(s.domain, d.domain);
  if (fromDomain && !UPLOADED_BY_USER.test(fromDomain)) return fromDomain.toLowerCase();
  return hostnameOf(link);
}

/** `{saves, repins, reactions}` from the grid sidecar (detail as fallback); nulls when absent. */
export function toStats(s, d) {
  const saves = num(obj(obj(s.aggregated_pin_data)?.aggregated_stats)?.saves) ?? num(obj(obj(d.aggregated_pin_data)?.aggregated_stats)?.saves);
  const repins = num(s.repin_count) ?? num(d.repin_count);
  const counts = obj(s.reaction_counts) ?? obj(d.reaction_counts);
  let reactions = null;
  if (counts) {
    reactions = 0;
    for (const v of Object.values(counts)) reactions += num(v) ?? 0;
  }
  return { saves, repins, reactions };
}

function toProduct(p) {
  const o = obj(p);
  if (!o) return null;
  const offer = obj(o.offer_summary) ?? {};
  return {
    name: str(o.name),
    purchase_url: str(o.purchase_url),
    price: positiveNum(offer.price_val),
    currency: str(offer.currency),
    in_stock: bool(offer.in_stock),
  };
}

/**
 * Compact rich-pin block from `rich_summary` (grid) + `rich_metadata` (detail)
 * + detail-level `price_value`/`price_currency`. Null when the pin has no rich
 * data at all. No HTML, no favicons, no nested provider blobs. See the
 * link-rot caveat in the header: this describes the linked page as crawled now.
 */
export function toRich(s, d) {
  const summary = obj(s.rich_summary) ?? obj(d.rich_summary);
  const meta = obj(d.rich_metadata) ?? obj(s.rich_metadata);
  const priceValue = positiveNum(d.price_value) ?? positiveNum(s.price_value);
  if (!summary && !meta && priceValue === null) return null;
  const rawProducts = Array.isArray(meta?.products) && meta.products.length ? meta.products : Array.isArray(summary?.products) ? summary.products : [];
  const products = rawProducts.map(toProduct).filter(Boolean);
  const type =
    firstStr(summary?.type_name) ??
    (products.length ? "product" : obj(meta?.article) ? "article" : meta || summary ? "page" : "price");
  const firstPriced = products.find((p) => p.price !== null);
  return {
    type,
    site_name: firstStr(summary?.site_name, meta?.site_name),
    display_name: firstStr(summary?.display_name, meta?.title, obj(meta?.article)?.name),
    display_description: clip(firstStr(summary?.display_description, meta?.description, obj(meta?.article)?.description)),
    price_value: priceValue ?? firstPriced?.price ?? null,
    price_currency: priceValue !== null ? firstStr(d.price_currency, s.price_currency) : firstPriced?.currency ?? null,
    products,
  };
}

/** The handful of raw keys worth keeping verbatim for future projects. Flat, no blobs. */
export function toRawExtra(s, d) {
  const hashtags = Array.isArray(d.hashtags) ? d.hashtags : Array.isArray(s.hashtags) ? s.hashtags : [];
  const ai = Array.isArray(d.ai_disclosures) ? d.ai_disclosures : Array.isArray(s.ai_disclosures) ? s.ai_disclosures : [];
  return {
    hashtags: hashtags.filter((h) => typeof h === "string"),
    pinner_username: firstStr(obj(s.pinner)?.username, obj(d.pinner)?.username),
    native_creator_username: firstStr(obj(s.native_creator)?.username, obj(d.native_creator)?.username),
    is_repin: bool(s.is_repin) ?? bool(d.is_repin),
    has_story_pin_data: Boolean(obj(s.story_pin_data) ?? obj(d.story_pin_data)),
    ai_disclosures: ai.filter((a) => typeof a === "string" || obj(a)),
  };
}

/**
 * Map one gallery-dl grid sidecar (plus optional per-pin detail sidecar) to a
 * schema v2 record. `imagePath` is the absolute path of the local image;
 * `sha256` is null when the image is missing; `domain` is the board's domain
 * from boards.json ("unknown" when unregistered).
 */
export function normalisePin(sidecar, { board, domain = UNKNOWN_DOMAIN, imagePath, sha256, detail = null }) {
  const s = sidecar && typeof sidecar === "object" ? sidecar : {};
  const d = detail && typeof detail === "object" ? detail : {};
  const pinId = firstStr(s.id, d.id) ?? (s.id != null ? String(s.id) : d.id != null ? String(d.id) : null);
  const link = firstStr(s.link, d.link, d.tracked_link);
  return {
    schema_version: SCHEMA_VERSION,
    pin_id: pinId,
    source: SOURCE,
    board,
    domain,
    created_at: toIso(s.created_at) ?? toIso(d.created_at),
    // Deliberately not `seo_title`: that is Pinterest keyword padding, not the pin's title.
    title: firstStr(s.title, s.grid_title, d.title, d.grid_title),
    description: firstStr(
      s.description,
      s.closeup_unified_description,
      s.closeup_description,
      d.description,
      d.closeup_unified_description,
      d.closeup_description,
    ),
    link,
    link_domain: toLinkDomain(s, d, link),
    dominant_color: toColour(s.dominant_color) ?? toColour(d.dominant_color),
    image_path: imagePath,
    image_url: firstStr(s.url, s.images?.orig?.url, d.images?.orig?.url),
    image_width: num(s.width) ?? num(s.images?.orig?.width) ?? num(d.width) ?? num(d.images?.orig?.width),
    image_height: num(s.height) ?? num(s.images?.orig?.height) ?? num(d.height) ?? num(d.images?.orig?.height),
    sha256: sha256 ?? null,
    is_video: isVideo(s) || isVideo(d),
    alt_text: firstStr(s.seo_alt_text, d.seo_alt_text) ?? firstStr(s.auto_alt_text, d.auto_alt_text),
    stats: toStats(s, d),
    rich: toRich(s, d),
    raw_extra: toRawExtra(s, d),
  };
}

/** Sort key: created_at ascending, unknown dates last, then pin_id for stability. */
export function compareByCreated(a, b) {
  if (a.created_at !== b.created_at) {
    if (a.created_at === null) return 1;
    if (b.created_at === null) return -1;
    return a.created_at < b.created_at ? -1 : 1;
  }
  return String(a.pin_id).localeCompare(String(b.pin_id));
}

/** Final output order: board, then created_at ascending (nulls last), then pin_id. */
export function compareOutput(a, b) {
  if (a.board !== b.board) return a.board < b.board ? -1 : 1;
  return compareByCreated(a, b);
}

/**
 * De-duplicate by sha256 across all boards. The earliest pin (by created_at
 * ascending, then pin_id) keeps the hash; later ones get `dupe_of` set to the
 * keeper's pin_id. Records with no sha256 (missing image) are never deduped.
 * Returns a new array in output order.
 */
export function dedupe(pins) {
  const ordered = [...pins].sort(compareByCreated);
  const keeperByHash = new Map();
  for (const pin of ordered) {
    if (!pin.sha256) continue;
    const keeper = keeperByHash.get(pin.sha256);
    if (keeper === undefined) {
      keeperByHash.set(pin.sha256, pin.pin_id);
      delete pin.dupe_of;
    } else {
      pin.dupe_of = keeper;
    }
  }
  return ordered.sort(compareOutput);
}

/** Serialise one record with keys in schema order; `dupe_of` right after `is_video` when present. */
export function toLine(pin) {
  const out = {};
  for (const k of KEYS) {
    if (k === "schema_version") out[k] = SCHEMA_VERSION;
    else if (k === "source") out[k] = pin.source ?? SOURCE;
    else if (k === "domain") out[k] = pin.domain ?? UNKNOWN_DOMAIN;
    else if (k === "is_video") out[k] = pin.is_video === true;
    else if (k === "stats") out[k] = pin.stats ?? { saves: null, repins: null, reactions: null };
    else if (k === "raw_extra") out[k] = pin.raw_extra ?? {};
    else out[k] = pin[k] === undefined ? null : pin[k];
    if (k === "is_video" && pin.dupe_of !== undefined) out.dupe_of = pin.dupe_of;
  }
  return JSON.stringify(out);
}

function readJson(filePath, log) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    log(`skip unreadable sidecar ${filePath}: ${err.message}`);
    return null;
  }
}

function listSidecars(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** slug → domain from boards.json. Missing/unreadable file → empty map (every board becomes "unknown"). */
export function loadDomains(boardsFile = DEFAULT_BOARDS_FILE, { log = console.error } = {}) {
  const domains = new Map();
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(boardsFile, "utf8"));
  } catch (err) {
    log(`warning: cannot read ${boardsFile} (${err.message}); every board gets domain "${UNKNOWN_DOMAIN}"`);
    return domains;
  }
  for (const b of Array.isArray(cfg?.boards) ? cfg.boards : []) {
    if (str(b?.slug) && str(b?.domain)) domains.set(b.slug.trim(), b.domain.trim());
  }
  return domains;
}

/**
 * Walk <inDir>/<board>/*.json and build normalised records (not yet deduped).
 * One record per pin id per board; when gallery-dl wrote several files for the
 * same pin (carousel/story pages) the lowest `num` wins and the rest are counted.
 * `domains` maps board slug → domain; unregistered boards get "unknown" + a warning.
 */
export function collect(inDir, { domains = new Map(), log = console.error } = {}) {
  const boards = fs
    .readdirSync(inDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_") && e.name !== "logs")
    .map((e) => e.name)
    .sort();

  const pins = [];
  const stats = { extraFiles: 0, missingImages: 0, unreadable: 0, noId: 0, unknownBoards: [] };

  for (const board of boards) {
    const boardDir = path.join(inDir, board);
    let domain = domains.get(board);
    if (!domain) {
      domain = UNKNOWN_DOMAIN;
      stats.unknownBoards.push(board);
      log(`warning: board directory "${board}" is not registered in boards.json; domain set to "${UNKNOWN_DOMAIN}"`);
    }
    const details = new Map();
    for (const f of listSidecars(path.join(boardDir, "detail"))) {
      const d = readJson(f, log);
      if (d && d.id != null) details.set(String(d.id), d);
    }

    const byPin = new Map();
    for (const sidecarPath of listSidecars(boardDir)) {
      const sidecar = readJson(sidecarPath, log);
      if (!sidecar) {
        stats.unreadable += 1;
        continue;
      }
      if (sidecar.id == null) {
        stats.noId += 1;
        log(`skip sidecar without pin id: ${sidecarPath}`);
        continue;
      }
      const id = String(sidecar.id);
      const num = Number.isFinite(sidecar.num) ? sidecar.num : 1;
      const existing = byPin.get(id);
      if (existing && existing.num <= num) {
        stats.extraFiles += 1;
        continue;
      }
      if (existing) stats.extraFiles += 1;
      byPin.set(id, { sidecar, sidecarPath, num });
    }

    for (const { sidecar, sidecarPath } of byPin.values()) {
      const imagePath = path.resolve(sidecarPath.replace(/\.json$/, ""));
      let sha256 = null;
      if (fs.existsSync(imagePath)) {
        sha256 = sha256File(imagePath);
      } else {
        stats.missingImages += 1;
      }
      pins.push(
        normalisePin(sidecar, {
          board,
          domain,
          imagePath,
          sha256,
          detail: details.get(String(sidecar.id)) ?? null,
        }),
      );
    }
  }
  return { pins, stats };
}

export function summarise(pins, stats = {}) {
  const perBoard = new Map();
  const perDomain = new Map();
  for (const p of pins) {
    const dom = p.domain ?? UNKNOWN_DOMAIN;
    const b = perBoard.get(p.board) ?? { domain: dom, pins: 0, dupes: 0, videos: 0, min: null, max: null, undated: 0, rich: 0, products: 0, priced: 0 };
    b.pins += 1;
    if (p.dupe_of !== undefined) b.dupes += 1;
    if (p.is_video) b.videos += 1;
    if (p.rich) b.rich += 1;
    if (p.rich?.products?.length) b.products += 1;
    if (p.rich && p.rich.price_value !== null && p.rich.price_value !== undefined) b.priced += 1;
    if (p.created_at === null) b.undated += 1;
    else {
      if (b.min === null || p.created_at < b.min) b.min = p.created_at;
      if (b.max === null || p.created_at > b.max) b.max = p.created_at;
    }
    perBoard.set(p.board, b);
    perDomain.set(dom, (perDomain.get(dom) ?? 0) + 1);
  }
  const lines = [];
  for (const [board, b] of perBoard) {
    lines.push(
      `${board} (${b.domain}): ${b.pins} pins, ${b.dupes} dupes, ${b.videos} video, ` +
        `created_at ${b.min ?? "?"} .. ${b.max ?? "?"}` +
        (b.undated ? ` (${b.undated} undated)` : "") +
        `; rich ${b.rich}/${b.pins}, with products ${b.products}, priced ${b.priced}`,
    );
  }
  lines.push(`domains: ${[...perDomain].map(([d, n]) => `${d} ${n}`).join(", ") || "none"}`);
  const total = pins.length;
  const dupes = pins.filter((p) => p.dupe_of !== undefined).length;
  const videos = pins.filter((p) => p.is_video).length;
  const rich = pins.filter((p) => p.rich).length;
  lines.push(
    `total: ${total} pins, ${dupes} dupes (sha256), ${videos} video, ${rich} rich, ` +
      `${stats.missingImages ?? 0} missing images, ${stats.extraFiles ?? 0} extra files skipped, ` +
      `${stats.unreadable ?? 0} unreadable sidecars` +
      (stats.unknownBoards?.length ? `, unregistered boards: ${stats.unknownBoards.join(", ")}` : ""),
  );
  return lines.join("\n");
}

/**
 * Collect, dedupe, write `outPath` (schema v2 JSONL) and return the records plus the stderr summary.
 * @param {{inDir?: string, outPath?: string, boardsFile?: string, log?: (line: string) => void}} opts
 */
export function run({ inDir = DEFAULT_IN_DIR, outPath = DEFAULT_OUT_PATH, boardsFile = DEFAULT_BOARDS_FILE, log = console.error } = {}) {
  const domains = loadDomains(boardsFile, { log });
  const { pins, stats } = collect(inDir, { domains, log });
  const deduped = dedupe(pins);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, deduped.map(toLine).join("\n") + (deduped.length ? "\n" : ""));
  const summary = summarise(deduped, stats);
  return { pins: deduped, stats, summary };
}

const USAGE = "usage: node pipeline/normalise.mjs [--in out/pins] [--out data/pins.jsonl] [--boards boards.json]";

/** `--in`, `--out`, `--boards` (also `--key=value`), all defaulting to the repo paths; resolved to absolute paths. */
export function parseCli(argv) {
  const args = { in: DEFAULT_IN_DIR, out: DEFAULT_OUT_PATH, boards: DEFAULT_BOARDS_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = eq === -1 ? a : a.slice(0, eq);
    const value = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    if (key === "--in") args.in = value();
    else if (key === "--out") args.out = value();
    else if (key === "--boards") args.boards = value();
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  for (const k of ["in", "out", "boards"]) {
    if (!args[k]) throw new Error(`--${k} needs a value\n${USAGE}`);
    args[k] = path.resolve(args[k]);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseCli(process.argv.slice(2));
    const { summary } = run({ inDir: args.in, outPath: args.out, boardsFile: args.boards });
    console.error(summary);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
