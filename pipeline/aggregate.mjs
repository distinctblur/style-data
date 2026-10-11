#!/usr/bin/env node
// style-data — aggregate pin tags into one taste profile per domain (ADR-0001 #5).
//
//   node pipeline/aggregate.mjs [--domain fashion|home] \
//     [--tags data/tags.jsonl] [--pins data/pins.jsonl] \
//     [--out data/profiles/<domain>.taste-profile.json] \
//     [--half-life-days 730] [--min-confidence 0.5] [--boards boards.json]
//
// Without --domain, every domain present in tags.jsonl is aggregated and one
// file is written per domain; `<domain>` in --out is replaced by the domain
// name (it is required when more than one domain is written).
//
// Joins tags.jsonl (one line per pin, from tag.mjs) with pins.jsonl (pin dates,
// boards, dominant colours) on pin_id. A row's domain is its own `domain`, else
// the pin's, else its board's entry in boards.json; rows that resolve to no
// domain at all are given the benefit of the doubt and included. Drops
// `tag: null`, tags below the confidence threshold and pins the domain's
// summariser calls unusable (non-outfit, non-interior). Every surviving pin
// gets a recency weight
//   w = 0.5 ^ (age_days / half_life_days)
// where age is measured from the newest dated pin of the domain; pins with no
// date get the median weight of the dated pins. Everything is reported per
// board and overall. Output is deterministic: fixed key order, arrays sorted by
// weight desc then key asc, numbers rounded to 4 dp. No network, no deps.
//
// Domain summarisers live in aggregate-fashion.mjs and aggregate-home.mjs;
// this file holds the shared machinery and the CLI. Tag strings are opaque
// here; only each domain's neutral set and "absence" candidate lists carry
// vocabulary, and they match loosely.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { aggregateFashion, summaryLines as fashionSummaryLines } from "./aggregate-fashion.mjs";
import { aggregateHome, summaryLinesHome } from "./aggregate-home.mjs";

// Fashion symbols re-exported for consumers that predate the split.
export {
  aggregate,
  NEUTRALS,
  HUES,
  ACCENT_FLOOR,
  SECONDARY_COUNT,
  ABSENCE_CANDIDATES,
  hexToRgb,
  nearestHue,
  summaryLines,
} from "./aggregate-fashion.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(DIR, "..");

export const VERSION = "aggregate-v2";
export const DEFAULT_TAGS = "data/tags.jsonl";
export const DEFAULT_PINS = "data/pins.jsonl";
export const DEFAULT_OUT = "data/profiles/<domain>.taste-profile.json";
export const DEFAULT_BOARDS = "boards.json";
export const DOMAIN_NAMES = Object.freeze(["fashion", "home"]);

/** Domain name -> { aggregate(opts), summary(profile) }. A function, not a
 * table, so the module cycle with the domain files never reads a binding
 * before it is initialised. */
export function domainRunner(domain) {
  switch (domain) {
    case "fashion":
      return { aggregate: aggregateFashion, summary: fashionSummaryLines };
    case "home":
      return { aggregate: aggregateHome, summary: summaryLinesHome };
    default:
      throw new Error(`unknown domain: ${domain} (expected one of ${DOMAIN_NAMES.join(", ")})`);
  }
}

// ---------------------------------------------------------------------------
// Helpers

export function parseJsonl(text) {
  const out = [];
  for (const [i, line] of String(text).split(/\r?\n/).entries()) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (e) {
      throw new Error(`bad JSONL on line ${i + 1}: ${e.message}`);
    }
  }
  return out;
}

export const r4 = (n) => Math.round(n * 1e4) / 1e4;

export function norm(s) {
  return String(s ?? "").toLowerCase().trim();
}
export function tokens(s) {
  return norm(s).split(/[^a-z0-9]+/).filter(Boolean);
}
/** Every token of `pattern` appears in `value` (case/punctuation-insensitive). */
export function looseMatch(pattern, value) {
  const want = tokens(pattern);
  const have = new Set(tokens(value));
  return want.length > 0 && want.every((t) => have.has(t));
}

export function median(nums) {
  if (!nums.length) return 1;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Weighted counter: key -> {weight, count}. */
export class Counter {
  constructor() {
    this.map = new Map();
  }
  add(key, w, n = 1) {
    const k = norm(key);
    if (!k) return;
    const cur = this.map.get(k) ?? { weight: 0, count: 0 };
    cur.weight += w;
    cur.count += n;
    this.map.set(k, cur);
  }
  total() {
    let t = 0;
    for (const v of this.map.values()) t += v.weight;
    return t;
  }
  /**
   * Normalised to the counter's own total (or to `denominator` when given, e.g.
   * total pin weight so a row reads as "share of pins"), sorted desc by weight
   * then key.
   */
  rows(keyName = "key", limit = Infinity, denominator = null) {
    const total = denominator ?? (this.total() || 1);
    return [...this.map.entries()]
      .map(([k, v]) => ({ [keyName]: k, weight: r4(v.weight / total), count: v.count }))
      .sort((a, b) => b.weight - a.weight || a[keyName].localeCompare(b[keyName]))
      .slice(0, limit);
  }
}

/**
 * Split a sorted colour distribution into neutrals / secondary / accent
 * (brief §2.3 scheme, shared by every domain).
 * @param {{colour:string,weight:number,count:number}[]} colourRows
 * @param {Set<string>} neutrals
 */
export function splitPalette(colourRows, neutrals, { secondaryCount = 2, accentFloor = 0.02 } = {}) {
  const neutralRows = colourRows.filter((c) => neutrals.has(c.colour));
  const nonNeutral = colourRows.filter((c) => !neutrals.has(c.colour));
  const secondary = nonNeutral.slice(0, secondaryCount);
  const accent = nonNeutral.slice(secondaryCount).filter((c) => c.weight >= accentFloor);
  const sum = (xs) => r4(xs.reduce((a, c) => a + c.weight, 0));
  return {
    neutrals: neutralRows,
    secondary,
    accent,
    neutral_share: sum(neutralRows),
    secondary_share: sum(secondary),
    accent_share: sum(accent),
  };
}

/**
 * Conventional things that appear at most once, as neutral observations.
 * `groups` is [[candidates, values], ...] where candidates are {label, match[]}.
 */
export function scanAbsences(groups) {
  const out = [];
  for (const [list, values] of groups) {
    for (const cand of list) {
      let n = 0;
      for (const v of values) if (cand.match.some((p) => looseMatch(p, v))) n++;
      if (n === 0) out.push(`never pins: ${cand.label}`);
      else if (n === 1) out.push(`pins only once: ${cand.label}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boards and domains

/** @returns {Map<string,string>} board slug -> domain, from boards.json. */
export function loadBoardDomains(file = path.join(ROOT, DEFAULT_BOARDS)) {
  const m = new Map();
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return m; // no registry: every board is domain-less and falls through
  }
  for (const b of json.boards ?? []) if (b?.slug && b?.domain) m.set(norm(b.slug), norm(b.domain));
  return m;
}

let cachedBoardDomains = null;
export function defaultBoardDomains() {
  if (!cachedBoardDomains) cachedBoardDomains = loadBoardDomains();
  return cachedBoardDomains;
}

/** Domain of a tag/pin row: own `domain`, else the joined pin's, else its board's. */
export function resolveDomain(row, pin, boardDomains) {
  const own = norm(row?.domain);
  if (own) return own;
  const pinDomain = norm(pin?.domain);
  if (pinDomain) return pinDomain;
  const board = norm(row?.board || pin?.board);
  return (board && boardDomains.get(board)) || null;
}

/** Domains present in a tags export (rows that resolve to none are ignored). */
export function domainsIn(tags, pins = [], boardDomains = defaultBoardDomains()) {
  const pinById = new Map();
  for (const p of pins) if (p && p.pin_id != null) pinById.set(String(p.pin_id), p);
  const found = new Set();
  for (const row of tags) {
    const d = resolveDomain(row, pinById.get(String(row?.pin_id)), boardDomains);
    if (d) found.add(d);
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Core: select, weight, summarise per board and overall

/**
 * Build one domain's profile envelope: {version, domain, coverage, overall, boards}.
 * @param {object} opts
 * @param {string} opts.domain
 * @param {object[]} opts.tags   parsed tags.jsonl rows
 * @param {object[]} opts.pins   parsed pins.jsonl rows
 * @param {number} [opts.halfLifeDays=730]
 * @param {number} [opts.minConfidence=0.5]
 * @param {Map<string,string>} [opts.boardDomains]
 * @param {(tag:object)=>boolean} opts.usable        false drops the pin (non-outfit, non-interior)
 * @param {string} opts.excludedKey                   coverage key for pins `usable` dropped
 * @param {string} opts.shareKey                      coverage key for used / (tagged - below_confidence)
 * @param {(rows:object[])=>object} opts.summarise    per-scope summary
 */
export function buildProfile({
  domain,
  tags,
  pins,
  halfLifeDays = 730,
  minConfidence = 0.5,
  boardDomains = defaultBoardDomains(),
  usable,
  excludedKey,
  shareKey,
  summarise,
}) {
  const pinById = new Map();
  for (const p of pins) {
    if (!p || p.pin_id == null) continue;
    const d = resolveDomain(p, null, boardDomains);
    if (d === null || d === domain) pinById.set(String(p.pin_id), p);
  }

  // Newest dated pin of the domain is the recency anchor.
  let newest = null;
  for (const p of pinById.values()) {
    const t = Date.parse(p.created_at ?? "");
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }

  let tagged = 0;
  let belowConfidence = 0;
  let excluded = 0;
  let unjoined = 0;
  const kept = [];
  for (const row of tags) {
    if (!row || !row.tag || typeof row.tag !== "object") continue;
    const pin = pinById.get(String(row.pin_id));
    const d = resolveDomain(row, pin, boardDomains);
    if (d !== null && d !== domain) continue;
    tagged++;
    const conf = Number(row.tag.confidence ?? 0);
    if (conf < minConfidence) {
      belowConfidence++;
      continue;
    }
    if (!usable(row.tag)) {
      excluded++;
      continue;
    }
    if (!pin) unjoined++;
    const board = norm(row.board || pin?.board || "unknown");
    const t = Date.parse(pin?.created_at ?? "");
    const date = Number.isFinite(t) ? t : null;
    kept.push({ pin_id: String(row.pin_id), board, tag: row.tag, date, dominant: pin?.dominant_color ?? null });
  }

  // Recency weights.
  const dated = kept.filter((k) => k.date !== null);
  for (const k of dated) {
    const ageDays = Math.max(0, (newest - k.date) / 86_400_000);
    k.weight = Math.pow(0.5, ageDays / halfLifeDays);
  }
  const med = median(dated.map((k) => k.weight));
  for (const k of kept) if (k.date === null) k.weight = med;

  const boards = [...new Set(kept.map((k) => k.board))].sort();
  const byBoard = {};
  for (const b of boards) byBoard[b] = summarise(kept.filter((k) => k.board === b));

  const dates = dated.map((k) => k.date).sort((a, b) => a - b);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

  return {
    version: VERSION,
    domain,
    coverage: {
      pins_total: pinById.size,
      tagged,
      below_confidence: belowConfidence,
      [excludedKey]: excluded,
      unjoined,
      used: kept.length,
      [shareKey]: r4(tagged - belowConfidence > 0 ? kept.length / (tagged - belowConfidence) : 0),
      date_min: dates.length ? iso(dates[0]) : null,
      date_max: dates.length ? iso(dates[dates.length - 1]) : null,
      undated: kept.length - dated.length,
      half_life_days: halfLifeDays,
      min_confidence: minConfidence,
      boards,
    },
    overall: summarise(kept),
    boards: byBoard,
  };
}

// ---------------------------------------------------------------------------
// CLI

export function parseArgs(argv) {
  const args = { tags: DEFAULT_TAGS, pins: DEFAULT_PINS, out: DEFAULT_OUT, boards: null, domain: null, halfLifeDays: 730, minConfidence: 0.5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--tags") args.tags = next();
    else if (a === "--pins") args.pins = next();
    else if (a === "--out") args.out = next();
    else if (a === "--boards") args.boards = next();
    else if (a === "--domain") args.domain = norm(next());
    else if (a === "--half-life-days") args.halfLifeDays = Number(next());
    else if (a === "--min-confidence") args.minConfidence = Number(next());
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.domain && !DOMAIN_NAMES.includes(args.domain)) throw new Error(`unknown domain: ${args.domain}`);
  return args;
}

const USAGE = `usage: node pipeline/aggregate.mjs [--domain ${DOMAIN_NAMES.join("|")}] [--tags ${DEFAULT_TAGS}] [--pins ${DEFAULT_PINS}] [--out ${DEFAULT_OUT}] [--half-life-days 730] [--min-confidence 0.5] [--boards ${DEFAULT_BOARDS}]`;

/** Resolve --out for one domain; `<domain>` is substituted. */
export function outPathFor(template, domain) {
  return template.replaceAll("<domain>", domain);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.error(USAGE);
    return 2;
  }
  for (const f of [args.tags, args.pins]) {
    if (!fs.existsSync(f)) {
      console.error(`aggregate: missing input ${f}`);
      console.error(USAGE);
      return 2;
    }
  }
  const boardDomains = args.boards ? loadBoardDomains(args.boards) : defaultBoardDomains();
  const tags = parseJsonl(fs.readFileSync(args.tags, "utf8"));
  const pins = parseJsonl(fs.readFileSync(args.pins, "utf8"));

  let domains = args.domain ? [args.domain] : domainsIn(tags, pins, boardDomains).filter((d) => DOMAIN_NAMES.includes(d));
  if (!domains.length) domains = ["fashion"]; // domain-less legacy export
  if (domains.length > 1 && !args.out.includes("<domain>")) {
    console.error(`aggregate: ${domains.length} domains found (${domains.join(", ")}) but --out has no <domain> placeholder; pass --domain or a template`);
    return 2;
  }

  for (const domain of domains) {
    const { aggregate: run, summary } = domainRunner(domain);
    const profile = run({ tags, pins, halfLifeDays: args.halfLifeDays, minConfidence: args.minConfidence, boardDomains });
    const out = outPathFor(args.out, domain);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(profile, null, 2) + "\n");
    for (const l of summary(profile)) console.error(l);
    console.error(`wrote ${out}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error("aggregate failed: " + (e?.message ?? e));
    console.error(e);
    process.exitCode = 1;
  }
}
