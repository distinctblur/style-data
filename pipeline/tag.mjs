#!/usr/bin/env node
// style-data — tag Pinterest pins with the per-domain taxonomy (ADR-0001 #4).
//
//   node pipeline/tag.mjs [--domain fashion|home] [--in data/pins.jsonl] [--out data/tags.jsonl] \
//        [--boards boards.json] [--limit N] [--model gemini-3.6-flash] [--concurrency 4] \
//        [--only-missing] [--mock] [--price-in USD_PER_MTOK] [--price-out USD_PER_MTOK]
//
// DOMAIN ROUTING: each pin's domain is its own `domain` field if present, else
// the `domain` of its `board` in boards.json. With no --domain every pin is
// tagged with its board's domain (one run covers all boards); `--domain X`
// restricts the run to that domain's pins (others are counted as
// `other_domain`) and is also what a pin falls back to when its board is not
// registered. A pin whose domain cannot be resolved is skipped (`unknown_domain`).
//
// One generateContent call per pin: the domain's TAG_PROMPT + the pin image as
// inlineData, structured output via responseMimeType + the domain's
// responseSchema (the pattern proven in studio/src/rerank.ts — never hedge
// between config shapes). Output is one JSON record per pin, appended to --out,
// carrying `domain` and the domain's `prompt_version`; `--only-missing` resumes
// by skipping (pin_id, domain) pairs that already have a successful record.
//
// MOCK MODE: with `--mock`, or when no GEMINI_API_KEY resolves (env, then
// ./.dev.vars), every pin gets a deterministic, schema-valid tag for its domain
// derived from a hash of its pin_id, so the whole pipeline runs keyless.
//
// LIVE SPEND is orchestrator-only and pre-authorised (CLAUDE.md). Every live
// call's usageMetadata is written to the record; pass --price-in/--price-out
// (USD per million tokens) to get cost_usd, otherwise it stays null.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { DOMAINS, DOMAIN_NAMES, getDomain } from "./taxonomies/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export const DEFAULT_DOMAIN = "fashion";
export const DEFAULT_MODEL = "gemini-3.6-flash";
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_BOARDS_PATH = path.join(ROOT, "boards.json");
const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

// Compatibility aliases for the fashion-only era (Atelier's copy of this script).
export const TAG_PROMPT_V1 = DOMAINS.fashion.TAG_PROMPT_FASHION_V1;
export const PROMPT_VERSION = DOMAINS.fashion.PROMPT_VERSION;

// --- API key ------------------------------------------------------------------

/** GEMINI_API_KEY from env, else ./.dev.vars (or STYLE_DATA_DEV_VARS). Null when absent. */
export function resolveApiKey(env = process.env) {
  if (env.GEMINI_API_KEY?.trim()) return env.GEMINI_API_KEY.trim();
  const devVars = env.STYLE_DATA_DEV_VARS ?? path.join(ROOT, ".dev.vars");
  try {
    const m = /^GEMINI_API_KEY=(.*)$/m.exec(fs.readFileSync(devVars, "utf8"));
    const v = m?.[1].replace(/^["']|["']$/g, "").trim();
    return v || null;
  } catch {
    return null;
  }
}

// --- Domain routing -------------------------------------------------------------

/**
 * board slug -> domain name from boards.json. Missing file -> empty map.
 * @param {string} boardsPath
 * @returns {Map<string, string>}
 */
export function loadBoardDomains(boardsPath = DEFAULT_BOARDS_PATH) {
  const out = new Map();
  if (!boardsPath || !fs.existsSync(boardsPath)) return out;
  const cfg = JSON.parse(fs.readFileSync(boardsPath, "utf8"));
  for (const b of cfg.boards ?? []) {
    if (!b?.slug || !b?.domain) continue;
    if (!DOMAINS[b.domain]) throw new Error(`boards.json: board '${b.slug}' has unknown domain '${b.domain}' (known: ${DOMAIN_NAMES.join(", ")})`);
    out.set(b.slug, b.domain);
  }
  return out;
}

/** The domain a pin should be tagged with: its own field, else its board's, else the run's --domain, else null. */
export function pinDomain(pin, boardDomains, fallback = null) {
  return pin.domain ?? boardDomains.get(pin.board) ?? fallback ?? null;
}

// --- Mock tags -------------------------------------------------------------------

const hashOf = (pinId) => createHash("sha256").update(String(pinId)).digest();
const pickFrom = (h) => (xs, i) => xs[h[i % h.length] % xs.length];
function pickDistinct(h, xs, n, seed) {
  const out = [];
  for (let i = 0; out.length < n && i < xs.length; i++) {
    const v = xs[(h[seed] + i * 7) % xs.length];
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

const MOCK_FASHION_VIBES = ["minimal", "coastal", "tailored", "boho", "polished", "sporty", "relaxed", "preppy", "romantic", "edgy", "classic", "tonal"];
const MOCK_HOME_VIBES = ["warm", "layered", "airy", "textured", "cosy", "sculptural", "calm", "organic", "graphic", "moody", "sunlit", "collected"];

function mockFashionTag(pinId) {
  const F = DOMAINS.fashion;
  const h = hashOf(pinId);
  const pick = pickFrom(h);
  const nGarments = 2 + (h[2] % 3);
  const garments = [];
  for (let i = 0; i < nGarments; i++) {
    const category = pick(F.CATEGORIES, 10 + i * 5);
    garments.push({
      category,
      subcategory: pick(F.SUBCATEGORIES[category], 11 + i * 5),
      colour: pick(F.COLOURS, 12 + i * 5),
      pattern: h[13 + i * 5] % 3 === 0 ? pick(F.PATTERNS, 14 + i * 5) : "solid",
      fabric: pick(F.FABRICS, 15 + i * 5),
    });
  }
  const nVibes = F.VIBE_KEYWORDS_MIN + (h[3] % (F.VIBE_KEYWORDS_MAX - F.VIBE_KEYWORDS_MIN + 1));
  return {
    is_outfit: h[0] % 5 !== 0,
    garments,
    formula: pick(F.FORMULA_IDS, 1),
    silhouette: pick(F.SILHOUETTES, 5),
    formality: 1 + (h[6] % 5),
    season: pick(F.SEASONS, 7),
    occasion: pick(F.OCCASIONS, 8),
    vibe_keywords: pickDistinct(h, MOCK_FASHION_VIBES, nVibes, 4),
    confidence: Math.round((0.6 + (h[9] / 255) * 0.4) * 100) / 100,
  };
}

function mockHomeTag(pinId) {
  const H = DOMAINS.home;
  const h = hashOf(pinId);
  const pick = pickFrom(h);
  const nItems = 2 + (h[2] % 4);
  const items = [];
  for (let i = 0; i < nItems; i++) {
    items.push({
      type: pick(H.ITEM_TYPES, 10 + i * 4),
      material: pick(H.MATERIALS, 11 + i * 4),
      colour: pick(H.COLOURS, 12 + i * 4),
      style: pick(H.STYLES, 13 + i * 4),
    });
  }
  const nStyles = H.STYLES_MIN + (h[3] % (H.STYLES_MAX - H.STYLES_MIN + 1));
  const nVibes = H.VIBE_KEYWORDS_MIN + (h[5] % (H.VIBE_KEYWORDS_MAX - H.VIBE_KEYWORDS_MIN + 1));
  return {
    is_interior: h[0] % 5 !== 0,
    room: pick(H.ROOMS, 1),
    items,
    styles: pickDistinct(h, H.STYLES, nStyles, 6),
    palette_mood: pick(H.PALETTE_MOODS, 7),
    era: pick(H.ERAS, 8),
    vibe_keywords: pickDistinct(h, MOCK_HOME_VIBES, nVibes, 4),
    confidence: Math.round((0.6 + (h[9] / 255) * 0.4) * 100) / 100,
  };
}

const MOCKS = { fashion: mockFashionTag, home: mockHomeTag };

/**
 * Deterministic, schema-valid tag for the domain, derived from sha256(pin_id).
 * @param {string} pinId
 * @param {string} [domain="fashion"]
 */
export function mockTag(pinId, domain = DEFAULT_DOMAIN) {
  getDomain(domain); // throws for unknown
  const fn = MOCKS[domain];
  if (!fn) throw new Error(`no mock tag generator for domain '${domain}'`);
  return fn(pinId);
}

// --- Gemini call ----------------------------------------------------------------

/** generateContent body: the domain's prompt + the image, structured output via the domain's responseSchema. */
export function buildRequestBody(image, domain = DEFAULT_DOMAIN) {
  const d = getDomain(domain);
  return {
    contents: [{ role: "user", parts: [{ text: d.TAG_PROMPT }, { inlineData: { mimeType: image.mimeType, data: image.data } }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: d.tagSchema },
  };
}

function responseText(json) {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();
}

const retryable = (status) => status === 429 || status >= 500;

/**
 * One generateContent call with one retry on 429/5xx/network error.
 * Returns {ok, status, json|null, error|null, attempts}; never throws.
 */
export async function callGemini({ fetchImpl, apiKey, model, image, domain = DEFAULT_DOMAIN, backoffMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify(buildRequestBody(image, domain));
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return { ok: true, status: res.status, json: JSON.parse(text), error: null, attempts: attempt };
        } catch (err) {
          return { ok: false, status: res.status, json: null, error: `response body not JSON: ${String(err)}`, attempts: attempt };
        }
      }
      last = { ok: false, status: res.status, json: null, error: `upstream ${res.status}: ${text.slice(0, 600)}`, attempts: attempt };
      if (!retryable(res.status)) return last;
    } catch (err) {
      last = { ok: false, status: 0, json: null, error: `request failed: ${String(err)}`, attempts: attempt };
    }
    if (attempt === 1) await sleep(backoffMs * (1 + Math.random()));
  }
  return last;
}

export function costUsd(usage, priceIn, priceOut) {
  if (!usage || priceIn == null || priceOut == null) return null;
  const inTok = usage.promptTokenCount ?? 0;
  // Thinking tokens are billed at the output rate.
  const outTok = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return (inTok * priceIn + outTok * priceOut) / 1e6;
}

// --- Pipeline -----------------------------------------------------------------------

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* ignore torn line (append-only file) */ }
  }
  return out;
}

const tagKey = (pinId, domain) => `${domain}\u0000${pinId}`;

/** (pin_id, domain) keys that already have a successful (tag != null) record in the output file. */
export function taggedKeys(outPath) {
  return new Set(readJsonl(outPath).filter((r) => r.tag != null && r.domain).map((r) => tagKey(r.pin_id, r.domain)));
}

/** @deprecated fashion-era helper: pin_ids with any successful record, regardless of domain. */
export function taggedIds(outPath) {
  return new Set(readJsonl(outPath).filter((r) => r.tag != null).map((r) => r.pin_id));
}

function loadImage(pin) {
  const p = pin.image_path;
  if (!p || !fs.existsSync(p)) return { skip: "missing_image" };
  const mimeType = MIME_BY_EXT[path.extname(p).toLowerCase()];
  if (!mimeType) return { skip: "unsupported_type" };
  const size = fs.statSync(p).size;
  if (size > MAX_IMAGE_BYTES) return { skip: "too_large", size };
  return { mimeType, data: fs.readFileSync(p).toString("base64"), size };
}

async function runPool(items, n, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

/**
 * Tag every eligible pin in `inPath`, appending one record per pin to `outPath`.
 * @param {object} opts
 * @param {string} opts.inPath            pins.jsonl
 * @param {string} opts.outPath           tags.jsonl (append-only)
 * @param {string|null} [opts.domain]     restrict to this domain (and fall back to it for unregistered boards); null = every pin with its board's domain
 * @param {string} [opts.boardsPath]      boards.json for board -> domain routing
 * @param {number} [opts.limit]           max pins to attempt this run (after skips)
 * @param {string} [opts.model]
 * @param {number} [opts.concurrency]
 * @param {boolean} [opts.onlyMissing]    skip (pin_id, domain) pairs that already have a successful record
 * @param {boolean} [opts.mock]           force mock mode
 * @param {string|null} [opts.apiKey]     resolved key; null -> mock mode
 * @param {number|null} [opts.priceIn]    USD per million input tokens
 * @param {number|null} [opts.priceOut]   USD per million output tokens
 * @param {number} [opts.backoffMs]
 * @param {(msg:string)=>void} [opts.log] stderr logger
 * @param {object} [deps]                 { fetchImpl, sleep } — injectable for tests
 */
export async function tagPins(opts, deps = {}) {
  const {
    inPath, outPath, domain = null, boardsPath = DEFAULT_BOARDS_PATH, limit = Infinity, model = DEFAULT_MODEL,
    concurrency = 4, onlyMissing = false, priceIn = null, priceOut = null, backoffMs = 2000, log = (m) => console.error(m),
  } = opts;
  if (domain != null) getDomain(domain); // fail fast on a typo
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep;
  const apiKey = opts.apiKey === undefined ? resolveApiKey() : opts.apiKey;
  const mock = Boolean(opts.mock) || !apiKey;
  const modelLabel = mock ? "mock" : model;

  const boardDomains = loadBoardDomains(boardsPath);
  const pins = readJsonl(inPath);
  const done = onlyMissing ? taggedKeys(outPath) : new Set();
  const summary = {
    mode: mock ? "mock" : "live", model: modelLabel, domain, tagged: 0, failed: 0, skipped: 0,
    skippedBy: {}, byDomain: {}, promptTokens: 0, outputTokens: 0, totalTokens: 0,
    costUsd: priceIn != null && priceOut != null ? 0 : null, records: [],
  };
  const skip = (pin, reason, extra = "", loud = true) => {
    summary.skipped++;
    summary.skippedBy[reason] = (summary.skippedBy[reason] ?? 0) + 1;
    if (loud) log(`skip ${pin.pin_id} ${reason}${extra}`);
  };

  const todo = [];
  for (const pin of pins) {
    if (pin.is_video) { skip(pin, "video"); continue; }
    if (pin.dupe_of) { skip(pin, "dupe", ` of ${pin.dupe_of}`); continue; }
    const d = pinDomain(pin, boardDomains, domain);
    if (!d) { skip(pin, "unknown_domain", ` (board '${pin.board}' not in ${boardsPath}; pass --domain)`); continue; }
    if (!DOMAINS[d]) { skip(pin, "unknown_domain", ` (pin domain '${d}' not registered)`); continue; }
    if (domain != null && d !== domain) { skip(pin, "other_domain", "", false); continue; }
    if (done.has(tagKey(pin.pin_id, d))) { skip(pin, "already_tagged"); continue; }
    if (todo.length >= limit) break;
    todo.push({ pin, domain: d });
  }
  if (summary.skippedBy.other_domain) log(`skip ${summary.skippedBy.other_domain} pins of other domains (--domain ${domain})`);
  const todoByDomain = {};
  for (const t of todo) todoByDomain[t.domain] = (todoByDomain[t.domain] ?? 0) + 1;
  log(`${mock ? "mock mode" : `live mode (${model})`}: ${todo.length} pins to tag (${Object.entries(todoByDomain).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}), concurrency ${mock ? 1 : concurrency}`);

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const emit = (rec) => {
    fs.appendFileSync(outPath, JSON.stringify(rec) + "\n");
    summary.records.push(rec);
  };

  await runPool(todo, mock ? 1 : concurrency, async ({ pin, domain: d }) => {
    const t0 = Date.now();
    const D = getDomain(d);
    const image = loadImage(pin);
    if (image.skip) { skip(pin, image.skip, image.size ? ` (${(image.size / 1e6).toFixed(1)} MB > 4 MB)` : ""); return; }

    const rec = { pin_id: pin.pin_id, board: pin.board, domain: d, model: modelLabel, prompt_version: D.PROMPT_VERSION, tag: null, error: null, usage: null, cost_usd: null, ms: 0 };
    if (mock) {
      rec.tag = mockTag(pin.pin_id, d);
    } else {
      const r = await callGemini({ fetchImpl, apiKey, model, image, domain: d, backoffMs, sleep });
      if (!r.ok) {
        rec.error = r.error;
      } else {
        rec.usage = r.json.usageMetadata ?? null;
        rec.cost_usd = costUsd(rec.usage, priceIn, priceOut);
        const text = responseText(r.json);
        if (!text) {
          rec.error = `empty response (finishReason=${r.json.candidates?.[0]?.finishReason ?? "none"}, blockReason=${r.json.promptFeedback?.blockReason ?? "none"})`;
        } else {
          let parsed;
          try { parsed = JSON.parse(text); } catch (err) { rec.error = `parse: ${String(err)}; text=${text.slice(0, 200)}`; }
          if (parsed !== undefined) {
            const v = D.validateTag(parsed);
            if (v.ok) rec.tag = parsed;
            else rec.error = `validation: ${v.errors.join("; ")}`;
          }
        }
      }
    }
    rec.ms = Date.now() - t0;
    if (rec.usage) {
      summary.promptTokens += rec.usage.promptTokenCount ?? 0;
      summary.outputTokens += (rec.usage.candidatesTokenCount ?? 0) + (rec.usage.thoughtsTokenCount ?? 0);
      summary.totalTokens += rec.usage.totalTokenCount ?? 0;
    }
    if (rec.cost_usd != null && summary.costUsd != null) summary.costUsd += rec.cost_usd;
    const bd = (summary.byDomain[d] ??= { tagged: 0, failed: 0 });
    if (rec.tag) { summary.tagged++; bd.tagged++; }
    else { summary.failed++; bd.failed++; log(`fail ${pin.pin_id} (${d}): ${rec.error}`); }
    emit(rec);
  });

  return summary;
}

export function formatSummary(s) {
  const perDomain = Object.entries(s.byDomain ?? {}).map(([k, v]) => `${k} ${v.tagged}/${v.tagged + v.failed}`).join(", ");
  const lines = [
    `--- tag.mjs summary (${s.mode === "live" ? `live, ${s.model}` : "mock"}${s.domain ? `, --domain ${s.domain}` : ""}) ---`,
    `tagged ${s.tagged}  failed ${s.failed}  skipped ${s.skipped}${s.skipped ? ` (${Object.entries(s.skippedBy).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}${perDomain ? `  by domain: ${perDomain}` : ""}`,
    `tokens: prompt ${s.promptTokens}  output ${s.outputTokens}  total ${s.totalTokens}`,
    `cost: ${s.costUsd == null ? "unknown (pass --price-in/--price-out USD per Mtok)" : `$${s.costUsd.toFixed(4)}`}`,
  ];
  return lines.join("\n");
}

// --- CLI ------------------------------------------------------------------------------

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      domain: { type: "string" },
      boards: { type: "string", default: DEFAULT_BOARDS_PATH },
      in: { type: "string", default: path.join(ROOT, "data", "pins.jsonl") },
      out: { type: "string", default: path.join(ROOT, "data", "tags.jsonl") },
      limit: { type: "string" },
      model: { type: "string", default: DEFAULT_MODEL },
      concurrency: { type: "string", default: "4" },
      "only-missing": { type: "boolean", default: false },
      mock: { type: "boolean", default: false },
      "price-in": { type: "string" },
      "price-out": { type: "string" },
    },
  });
  const num = (v, name) => {
    if (v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
    return n;
  };
  if (values.domain !== undefined && !DOMAINS[values.domain]) {
    throw new Error(`--domain must be one of: ${DOMAIN_NAMES.join(", ")} (got '${values.domain}')`);
  }
  return {
    domain: values.domain ?? null,
    boardsPath: values.boards,
    inPath: values.in,
    outPath: values.out,
    limit: num(values.limit, "limit") ?? Infinity,
    model: values.model,
    concurrency: Math.max(1, num(values.concurrency, "concurrency") ?? 4),
    onlyMissing: values["only-missing"],
    mock: values.mock,
    priceIn: num(values["price-in"], "price-in"),
    priceOut: num(values["price-out"], "price-out"),
  };
}

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!fs.existsSync(opts.inPath)) {
    console.error(`input not found: ${opts.inPath}`);
    process.exit(1);
  }
  const summary = await tagPins(opts);
  console.error(formatSummary(summary));
  process.exit(summary.failed > 0 && summary.tagged === 0 ? 2 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
