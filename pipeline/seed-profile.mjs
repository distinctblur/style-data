#!/usr/bin/env node
// style-data — turn the fashion taste profile into a draft STANDING STYLE
// PROFILE for Atelier (its D10 seed; ADR-0001 #5: produced here, consumed there).
// Fashion-specific by design; the home profile has no draft step.
//
//   node pipeline/seed-profile.mjs \
//     [--profile data/profiles/fashion.taste-profile.json] [--out data/profiles/fashion.profile-draft.md] \
//     [--model claude-opus-5-5] [--effort high] [--max-tokens 8000] \
//     [--price-in 4 --price-out 20] [--mock] [--dry-run]
//
// One Claude Messages API call (raw fetch, no SDK) that writes the draft TO
// her, in the second person, as hypotheses she corrects — brief §6: nothing
// merges into `profiles` without her review. The reply is markdown followed
// by a fenced ```json parsed_constraints_json block matching
// `profiles.parsed_constraints_json` (brief §5). The draft file carries both.
//
// Keyless: with no ANTHROPIC_API_KEY in the environment and no key in this
// repo's .dev.vars (or $STYLE_DATA_DEV_VARS), or with --mock, the same six
// sections are generated deterministically in code from the profile JSON.
// --dry-run prints the request body size and a token estimate and exits
// without calling anything, so the orchestrator can pre-authorise spend.
//
// Live calls are orchestrator-only (CLAUDE.md). This script never retries.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..");

export const DEFAULT_PROFILE = "data/profiles/fashion.taste-profile.json";
export const DEFAULT_OUT = "data/profiles/fashion.profile-draft.md";
export const DEFAULT_MODEL = "claude-opus-5-5"; // Atelier docs/cost-model.md §3
export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2023-06-01";
// Server-side refusal fallback, "default" scalar form (routes by category).
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const SECTIONS = [
  "What I think you reach for",
  "Your palette",
  "Formality and occasions",
  "Swim",
  "Things I never see — are these no-gos or just unpinned?",
  "Correct me",
];

export const SEED_PROMPT_V1 = `You are drafting a standing style profile for one person from a statistical summary of her Pinterest boards. You are writing TO her, in the second person, and every sentence is a hypothesis for her to confirm or correct — not a verdict. She will edit this before anything is saved.

Input: a JSON "taste profile". It has \`overall\` plus one entry per board under \`boards\` (the boards are "my-style" and "swim-look"). Every list is sorted by \`weight\`, a recency-weighted share between 0 and 1 (newer pins count more); \`count\` is the raw number of pins behind it. \`palette\` is already split into neutrals / secondary / accent; \`absences\` lists conventional things that appear at most once. \`coverage\` says how many pins were used and the date range.

Write markdown with exactly these six H2 headings, in this order, with these exact texts:

## What I think you reach for
## Your palette
## Formality and occasions
## Swim
## Things I never see — are these no-gos or just unpinned?
## Correct me

Content rules:
- "What I think you reach for": the top outfit formulas and silhouettes, from \`overall\` and the "my-style" board. Three to five short sentences.
- "Your palette": neutral base, then secondary colours, then accents, each with the counts and shares behind them. Mention the neutral share as a plain percentage.
- "Formality and occasions": the formality band (1 = beach/loungewear, 5 = black tie) and the occasions and seasons that dominate.
- "Swim": only what the "swim-look" board shows. If that board is missing or has fewer than 3 pins, say so in one sentence and nothing else.
- "Things I never see — are these no-gos or just unpinned?": one bullet per item in \`overall.absences\`, phrased as a question to her. Do not guess the answer.
- "Correct me": a checklist of 6 to 10 lines, each starting with "- [ ] ", that she can tick: one per major claim above, phrased so that ticking means "yes, that's right". End the list with "- [ ] Something I missed: ____".

Tone: warm, brief, plain words. No fashion jargon — if a word needs a glossary, pick a plainer one. No flattery, no exclamation marks. Every claim cites the share or count behind it in parentheses, like "(7 of 12 pins, 61%)". Use only numbers that are in the JSON; never invent a pin, a colour or a count. Where the data is thin (a share under 10% or a count under 3), say that it is thin. Aim for 350 to 550 words of markdown before the JSON block.

After the markdown, output one fenced code block whose opening fence is exactly:
\`\`\`json parsed_constraints_json
and whose body is a single JSON object with exactly these keys:
{
  "preferred_formulas": [string],   // top formulas, most frequent first, at most 5
  "silhouettes": [string],          // top silhouettes, at most 4
  "palette": { "neutrals": [string], "secondary": [string], "accent": [string] },
  "formality_band": [min, max],     // integers 1-5 covering the levels that hold most of the weight
  "avoid_candidates": [string],     // the absences, verbatim labels, UNCONFIRMED — she decides
  "notes": string                   // one or two sentences on what the data cannot tell you
}
Use the exact strings from the profile JSON for formulas, silhouettes and colours. Nothing after the closing fence.`;

// ---------------------------------------------------------------------------
// Key lookup: env, then this repo's .dev.vars (gitignored; see .dev.vars.example)

export function findApiKey({ env = process.env, devVarsPath } = {}) {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY.trim();
  const p = devVarsPath ?? env.STYLE_DATA_DEV_VARS ?? path.join(ROOT, ".dev.vars");
  try {
    const raw = fs.readFileSync(p, "utf8");
    const m = /^ANTHROPIC_API_KEY=(.*)$/m.exec(raw);
    if (m) return m[1].replace(/^["']|["']$/g, "").trim() || null;
  } catch {
    /* no dev vars: keyless mode */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request / response

export function buildRequest(profile, { model = DEFAULT_MODEL, effort = "high", maxTokens = 8000 } = {}) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: SEED_PROMPT_V1,
    messages: [
      {
        role: "user",
        content:
          "Here is the taste profile. Write the draft standing style profile, then the parsed_constraints_json block.\n\n" +
          JSON.stringify(profile),
      },
    ],
    // claude-opus-5-5: thinking is always on (adaptive); effort is the depth
    // control and defaults to medium, so set it explicitly.
    output_config: { effort },
    fallbacks: "default",
  };
  return {
    url: API_URL,
    headers: {
      "content-type": "application/json",
      "anthropic-version": API_VERSION,
      "anthropic-beta": FALLBACK_BETA,
    },
    body,
  };
}

// Rough, no tokenizer available offline: ~3.6 chars per token for mixed
// English + JSON on the Opus 4.7+ tokenizer. Good enough to size a budget.
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 3.6);
}

export function parseResponseText(text) {
  const src = String(text ?? "");
  const labelled = /```json[ \t]+parsed_constraints_json[ \t]*\r?\n([\s\S]*?)```/.exec(src);
  let m = labelled;
  if (!m) {
    // Fallback: the last ```json block in the reply.
    const all = [...src.matchAll(/```json[^\n]*\r?\n([\s\S]*?)```/g)];
    m = all.length ? all[all.length - 1] : null;
  }
  if (!m) throw new Error("no parsed_constraints_json block in the model reply");
  let constraints;
  try {
    constraints = JSON.parse(m[1]);
  } catch (e) {
    throw new Error("parsed_constraints_json is not valid JSON: " + e.message);
  }
  const markdown = src.slice(0, m.index).trim();
  if (!markdown) throw new Error("model reply has no markdown before the JSON block");
  return { markdown, constraints };
}

export function textOf(message) {
  return (message?.content ?? [])
    .filter((b) => b && b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function costOf(usage, priceIn, priceOut) {
  if (!usage || priceIn == null || priceOut == null) return null;
  const inTok = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return Math.round(((inTok * priceIn + (usage.output_tokens ?? 0) * priceOut) / 1e6) * 1e6) / 1e6;
}

async function callClaude(profile, { model, effort, maxTokens, apiKey, fetchImpl }) {
  const req = buildRequest(profile, { model, effort, maxTokens });
  const t0 = Date.now();
  const res = await fetchImpl(req.url, {
    method: "POST",
    headers: { ...req.headers, "x-api-key": apiKey },
    body: JSON.stringify(req.body),
  });
  const ms = Date.now() - t0;
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Messages API returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`);
  }
  if (!res.ok || json.type === "error") {
    const err = json.error ?? {};
    throw new Error(`Messages API HTTP ${res.status} ${err.type ?? ""}: ${err.message ?? raw.slice(0, 300)}`);
  }
  if (json.stop_reason === "refusal") {
    throw new Error(`model declined (refusal${json.stop_details?.category ? ", " + json.stop_details.category : ""})`);
  }
  if (json.stop_reason === "max_tokens") {
    throw new Error(`reply truncated at max_tokens=${maxTokens}; raise --max-tokens`);
  }
  return { message: json, ms };
}

// ---------------------------------------------------------------------------
// Mock draft: deterministic, same six sections, no network.

const pct = (w) => `${Math.round((w ?? 0) * 100)}%`;
const cite = (row, total) => `(${row.count} of ${total} pins, ${pct(row.weight)})`;
const names = (rows, key, n = Infinity) => rows.slice(0, n).map((r) => r[key]);

export function mockConstraints(profile) {
  const o = profile.overall ?? {};
  const hist = o.formality_histogram ?? {};
  const held = ["1", "2", "3", "4", "5"].filter((l) => (hist[l]?.weight ?? 0) >= 0.1).map(Number);
  const band = held.length ? [Math.min(...held), Math.max(...held)] : [1, 5];
  return {
    preferred_formulas: names(o.formula_weights ?? [], "formula", 5),
    silhouettes: names(o.silhouettes ?? [], "silhouette", 4),
    palette: {
      neutrals: names(o.palette?.neutrals ?? [], "colour"),
      secondary: names(o.palette?.secondary ?? [], "colour"),
      accent: names(o.palette?.accent ?? [], "colour"),
    },
    formality_band: band,
    avoid_candidates: [...(o.absences ?? [])],
    notes:
      "Mock draft generated without a model. Shares are recency-weighted; absences are unconfirmed questions, not rules.",
  };
}

export function mockDraft(profile) {
  const o = profile.overall ?? {};
  const c = profile.coverage ?? {};
  const total = o.pins_used ?? c.used ?? 0;
  const swim = profile.boards?.["swim-look"];
  const L = [];

  L.push(`# Draft standing style profile`);
  L.push(``);
  L.push(
    `*Mock draft, written in code from ${total} pins (${c.date_min ?? "?"} to ${c.date_max ?? "?"}). Everything below is a guess for you to correct.*`,
  );
  L.push(``);
  L.push(`## ${SECTIONS[0]}`);
  const fw = o.formula_weights ?? [];
  if (fw.length) {
    L.push(`I think your default outfit is ${fw[0].formula} ${cite(fw[0], total)}.`);
    if (fw[1]) L.push(`After that comes ${fw[1].formula} ${cite(fw[1], total)}${fw[2] ? `, then ${fw[2].formula} ${cite(fw[2], total)}` : ""}.`);
  } else {
    L.push(`There were not enough tagged pins to see a pattern in outfit formulas.`);
  }
  const sil = o.silhouettes ?? [];
  if (sil.length) L.push(`The shape you pin most is "${sil[0].silhouette}" ${cite(sil[0], total)}${sil[1] ? `, with "${sil[1].silhouette}" next ${cite(sil[1], total)}` : ""}.`);
  L.push(``);
  L.push(`## ${SECTIONS[1]}`);
  const p = o.palette ?? { neutrals: [], secondary: [], accent: [] };
  L.push(`Your base is neutral: ${p.neutrals.length ? p.neutrals.map((r) => `${r.colour} ${cite(r, total)}`).join(", ") : "none seen"} — together ${pct(p.neutral_share)} of the garments you pin.`);
  L.push(`For depth you seem to add ${p.secondary.length ? p.secondary.map((r) => `${r.colour} ${cite(r, total)}`).join(" and ") : "nothing yet"}.`);
  L.push(`Accents I can see: ${p.accent.length ? p.accent.map((r) => `${r.colour} ${cite(r, total)}`).join(", ") : "none above the floor"}.`);
  L.push(``);
  L.push(`## ${SECTIONS[2]}`);
  const hist = o.formality_histogram ?? {};
  const fmean = o.formality_mean == null ? "?" : o.formality_mean.toFixed(1);
  L.push(`Formality sits around ${fmean} on a 1 to 5 scale (1 = beach, 5 = black tie): ${["1", "2", "3", "4", "5"].map((l) => `level ${l} ${pct(hist[l]?.weight)}`).join(", ")}.`);
  const occ = o.occasions ?? [];
  const sea = o.seasons ?? [];
  L.push(`Occasions: ${occ.length ? occ.slice(0, 3).map((r) => `${r.occasion} ${cite(r, total)}`).join(", ") : "none tagged"}. Seasons: ${sea.length ? sea.slice(0, 3).map((r) => `${r.season} ${cite(r, total)}`).join(", ") : "none tagged"}.`);
  L.push(``);
  L.push(`## ${SECTIONS[3]}`);
  if (!swim || (swim.pins_used ?? 0) < 3) {
    L.push(`The swim-look board has ${swim?.pins_used ?? 0} usable pins, so I will not guess here.`);
  } else {
    const sf = swim.formula_weights ?? [];
    const sp = swim.palette ?? { neutrals: [], secondary: [], accent: [] };
    L.push(`On the beach you pin ${sf[0] ? `${sf[0].formula} ${cite(sf[0], swim.pins_used)}` : "no clear formula"}${sf[1] ? ` and ${sf[1].formula} ${cite(sf[1], swim.pins_used)}` : ""}.`);
    L.push(`Swim colours: ${[...sp.neutrals, ...sp.secondary, ...sp.accent].slice(0, 4).map((r) => `${r.colour} ${cite(r, swim.pins_used)}`).join(", ") || "none tagged"}.`);
  }
  L.push(``);
  L.push(`## ${SECTIONS[4]}`);
  const abs = o.absences ?? [];
  if (abs.length) for (const a of abs) L.push(`- ${a} — is that a no-go, or just not something you pin?`);
  else L.push(`- Nothing on the conventional list is missing from your boards.`);
  L.push(``);
  L.push(`## ${SECTIONS[5]}`);
  if (fw[0]) L.push(`- [ ] ${fw[0].formula} really is my default`);
  if (sil[0]) L.push(`- [ ] "${sil[0].silhouette}" is the shape I want more of`);
  L.push(`- [ ] My neutrals are ${p.neutrals.slice(0, 3).map((r) => r.colour).join(", ") || "(none listed)"}`);
  L.push(`- [ ] ${p.secondary.map((r) => r.colour).join(" and ") || "(no secondary colour)"} as secondary colours feels right`);
  L.push(`- [ ] Formality around ${fmean} is right for most days`);
  if (occ[0]) L.push(`- [ ] "${occ[0].occasion}" is the occasion I most need help with`);
  L.push(`- [ ] The swim section matches what I actually wear`);
  L.push(`- [ ] The "never see" list is mostly things I do not want`);
  L.push(`- [ ] Something I missed: ____`);

  return { markdown: L.join("\n"), constraints: mockConstraints(profile) };
}

// ---------------------------------------------------------------------------
// Orchestration

export function renderDraft({ markdown, constraints }) {
  return `${markdown.trim()}\n\n\`\`\`json parsed_constraints_json\n${JSON.stringify(constraints, null, 2)}\n\`\`\`\n`;
}

/**
 * @returns {Promise<{mode:"mock"|"live", model:string, markdown:string, constraints:object, usage:object|null, cost_usd:number|null, ms:number}>}
 */
export async function seedProfile(
  profile,
  { model = DEFAULT_MODEL, effort = "high", maxTokens = 8000, mock = false, apiKey, env = process.env, fetchImpl = globalThis.fetch, priceIn = null, priceOut = null, log = console.error } = {},
) {
  const key = mock ? null : (apiKey ?? findApiKey({ env }));
  if (mock || !key) {
    if (!mock) log("seed-profile: no ANTHROPIC_API_KEY (env or .dev.vars); using mock draft");
    const t0 = Date.now();
    const { markdown, constraints } = mockDraft(profile);
    return { mode: "mock", model: "mock", markdown, constraints, usage: null, cost_usd: null, ms: Date.now() - t0 };
  }
  const { message, ms } = await callClaude(profile, { model, effort, maxTokens, apiKey: key, fetchImpl });
  const { markdown, constraints } = parseResponseText(textOf(message));
  const usage = message.usage ?? null;
  const cost_usd = costOf(usage, priceIn, priceOut);
  log(
    JSON.stringify({
      event: "seed-profile",
      model: message.model ?? model,
      effort,
      stop_reason: message.stop_reason,
      usage,
      cost_usd,
      ms,
    }),
  );
  return { mode: "live", model: message.model ?? model, markdown, constraints, usage, cost_usd, ms };
}

export function parseArgs(argv) {
  const args = { profile: DEFAULT_PROFILE, out: DEFAULT_OUT, model: DEFAULT_MODEL, effort: "high", maxTokens: 8000, mock: false, dryRun: false, priceIn: null, priceOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--profile") args.profile = next();
    else if (a === "--out") args.out = next();
    else if (a === "--model") args.model = next();
    else if (a === "--effort") args.effort = next();
    else if (a === "--max-tokens") args.maxTokens = Number(next());
    else if (a === "--price-in") args.priceIn = Number(next());
    else if (a === "--price-out") args.priceOut = Number(next());
    else if (a === "--mock") args.mock = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const usage = `usage: node pipeline/seed-profile.mjs [--profile ${DEFAULT_PROFILE}] [--out ${DEFAULT_OUT}] [--model claude-opus-5-5] [--effort high] [--max-tokens 8000] [--price-in $/MTok --price-out $/MTok] [--mock] [--dry-run]`;
  if (args.help || !args.profile || !args.out) {
    console.error(usage);
    return 2;
  }
  if (!fs.existsSync(args.profile)) {
    console.error(`seed-profile: missing profile ${args.profile} (run pipeline/aggregate.mjs --domain fashion first)`);
    console.error(usage);
    return 2;
  }
  const profile = JSON.parse(fs.readFileSync(args.profile, "utf8"));
  if (args.dryRun) {
    const req = buildRequest(profile, { model: args.model, effort: args.effort, maxTokens: args.maxTokens });
    const body = JSON.stringify(req.body);
    const est = estimateTokens(req.body.system) + estimateTokens(req.body.messages[0].content);
    console.error(
      JSON.stringify({
        event: "seed-profile-dry-run",
        model: args.model,
        effort: args.effort,
        max_tokens: args.maxTokens,
        body_bytes: body.length,
        est_input_tokens: est,
        est_output_tokens: "1200-2500 (plus thinking, billed as output)",
        api_key_found: Boolean(findApiKey()),
      }),
    );
    return 0;
  }
  const result = await seedProfile(profile, {
    model: args.model,
    effort: args.effort,
    maxTokens: args.maxTokens,
    mock: args.mock,
    priceIn: args.priceIn,
    priceOut: args.priceOut,
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, renderDraft(result));
  console.error(`seed-profile: ${result.mode} (${result.model}) in ${result.ms} ms → ${args.out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error("seed-profile failed: " + (e?.message ?? e));
      console.error(e);
      process.exitCode = 1;
    },
  );
}
