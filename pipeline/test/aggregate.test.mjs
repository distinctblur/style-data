import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { aggregate, parseJsonl, nearestHue, NEUTRALS, summaryLines } from "../aggregate.mjs";
import { combinations } from "../aggregate-fashion.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, "..", "aggregate.mjs");
const FIXTURE = path.join(DIR, "fixtures", "tags.sample.jsonl");

// Inline pins fixture: p03 has no date; p05 (untagged) has no colour;
// p08 is four years older than the newest pin (p01).
export const PINS = [
  { pin_id: "p01", board: "my-style", created_at: "2026-09-20T10:00:00Z", dominant_color: "#111111" },
  { pin_id: "p02", board: "my-style", created_at: "2026-08-01T10:00:00Z", dominant_color: "#1b2a4a" },
  { pin_id: "p03", board: "my-style", created_at: null, dominant_color: "#c8a76b" },
  { pin_id: "p04", board: "my-style", created_at: "2026-03-10T10:00:00Z", dominant_color: "#2b2b2b" },
  { pin_id: "p05", board: "my-style", created_at: "2026-02-01T10:00:00Z", dominant_color: null },
  { pin_id: "p06", board: "my-style", created_at: "2025-11-01T10:00:00Z", dominant_color: "#d02020" },
  { pin_id: "p07", board: "my-style", created_at: "2025-06-15T10:00:00Z", dominant_color: "#7a1f2e" },
  { pin_id: "p08", board: "my-style", created_at: "2022-01-10T10:00:00Z", dominant_color: "#4a6fa5" },
  { pin_id: "p09", board: "swim-look", created_at: "2026-07-01T10:00:00Z", dominant_color: "#f0e6c8" },
  { pin_id: "p10", board: "swim-look", created_at: "2026-06-01T10:00:00Z", dominant_color: "#6b6b2a" },
  { pin_id: "p11", board: "swim-look", created_at: "2025-07-01T10:00:00Z", dominant_color: "#1f8a8a" },
  { pin_id: "p12", board: "swim-look", created_at: "2025-07-02T10:00:00Z", dominant_color: "#e8752a" },
];

const TAGS = parseJsonl(fs.readFileSync(FIXTURE, "utf8"));
const run = (opts = {}) => aggregate({ tags: TAGS, pins: PINS, ...opts });

const sumW = (rows) => rows.reduce((a, r) => a + r.weight, 0);
const approx = (a, b, eps = 2e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

test("fixture shape: 12 lines, both boards, one null tag, one low-confidence, slug enums", () => {
  assert.equal(TAGS.length, 12);
  assert.ok(TAGS.every((t) => t.domain === "fashion"));
  // Values are the tagger's slug enums, not human-spaced labels.
  for (const t of TAGS) {
    if (!t.tag) continue;
    assert.doesNotMatch(t.tag.formula, /\s/, `formula not a slug: ${t.tag.formula}`);
    for (const g of t.tag.garments) assert.doesNotMatch(g.subcategory, /\s/, `subcategory not a slug: ${g.subcategory}`);
  }
  assert.deepEqual([...new Set(TAGS.map((t) => t.board))].sort(), ["my-style", "swim-look"]);
  assert.equal(TAGS.filter((t) => t.tag === null).length, 1);
  assert.equal(TAGS.filter((t) => t.tag && t.tag.confidence < 0.5).length, 1);
  assert.equal(PINS.filter((p) => p.created_at === null).length, 1);
});

test("coverage: null tag, low confidence and non-outfit pins are excluded", () => {
  const p = run();
  assert.equal(p.coverage.pins_total, 12);
  assert.equal(p.coverage.tagged, 11);
  assert.equal(p.coverage.below_confidence, 1);
  assert.equal(p.coverage.not_outfit, 1);
  assert.equal(p.coverage.used, 9);
  assert.equal(p.coverage.undated, 1);
  assert.equal(p.coverage.date_min, "2022-01-10");
  assert.equal(p.coverage.date_max, "2026-09-20");
  assert.equal(p.coverage.half_life_days, 730);
  assert.deepEqual(p.coverage.boards, ["my-style", "swim-look"]);
  assert.equal(p.boards["my-style"].pins_used, 6);
  assert.equal(p.boards["swim-look"].pins_used, 3);
  // The low-confidence pin's garments must not leak into the palette.
  assert.ok(!p.overall.palette.accent.some((c) => c.colour === "red"));
});

test("weights are normalised: each distribution sums to 1", () => {
  const p = run();
  for (const scope of [p.overall, p.boards["my-style"], p.boards["swim-look"]]) {
    approx(sumW(scope.formula_weights), 1);
    approx(sumW(scope.silhouettes), 1);
    approx(sumW(scope.seasons), 1);
    approx(sumW(scope.occasions), 1);
    approx(sumW(scope.garment_mix), 1);
    approx(sumW(Object.values(scope.formality_histogram)), 1);
    // neutral + secondary + accent <= 1 (accent floor may drop a sliver)
    assert.ok(scope.palette.neutral_share + scope.palette.secondary_share + scope.palette.accent_share <= 1 + 1e-3);
  }
  for (const r of p.overall.formula_weights) assert.ok(r.weight >= 0 && r.weight <= 1 && Number.isInteger(r.count));
});

test("recency weighting favours newer pins at equal counts", () => {
  const p = run();
  const byF = Object.fromEntries(p.overall.formula_weights.map((r) => [r.formula, r]));
  const newest = byF["slip-dress+sandal"]; // p01, 2026-09-20
  const oldest = byF["jeans+tee+sneaker"]; // p08, 2022-01-10
  assert.equal(newest.count, 1);
  assert.equal(oldest.count, 1);
  assert.ok(newest.weight > oldest.weight, `${newest.weight} should exceed ${oldest.weight}`);
  // ~4.7 years at a 2-year half-life: oldest should be well under a quarter of newest.
  assert.ok(oldest.weight / newest.weight < 0.25);
  // A long half-life flattens the difference.
  const flat = run({ halfLifeDays: 100000 });
  const byFlat = Object.fromEntries(flat.overall.formula_weights.map((r) => [r.formula, r]));
  // 0.5^(1715/100000) ≈ 0.988, so the two shares land within ~0.0015 of each other.
  approx(byFlat["slip-dress+sandal"].weight, byFlat["jeans+tee+sneaker"].weight, 2e-3);
});

test("pins with no date get the median weight of dated pins", () => {
  const mk = (id, formula) => ({
    pin_id: id,
    board: "b",
    tag: { is_outfit: true, garments: [], formula, silhouette: "s", formality: 3, season: "x", occasion: "y", vibe_keywords: [], confidence: 1 },
  });
  const tags = [mk("a", "fa"), mk("b", "fb"), mk("c", "fc")];
  const pins = [
    { pin_id: "a", board: "b", created_at: "2026-01-01T00:00:00Z" }, // weight 1
    { pin_id: "b", board: "b", created_at: "2022-01-01T00:00:00Z" }, // ~4y at 2y half-life -> ~0.25
    { pin_id: "c", board: "b", created_at: null }, // median of {1, 0.25} = 0.625
  ];
  const p = aggregate({ tags, pins, halfLifeDays: 730 });
  const byF = Object.fromEntries(p.overall.formula_weights.map((r) => [r.formula, r.weight]));
  const wb = Math.pow(0.5, 1461 / 730);
  const med = (1 + wb) / 2;
  const total = 1 + wb + med;
  approx(byF.fa, 1 / total, 1e-3);
  approx(byF.fb, wb / total, 1e-3);
  approx(byF.fc, med / total, 1e-3);
  assert.equal(p.coverage.undated, 1);
});

test("palette split: neutrals in `neutrals`, nothing neutral in secondary/accent", () => {
  const p = run();
  const pal = p.overall.palette;
  const neutralNames = pal.neutrals.map((c) => c.colour);
  for (const n of ["black", "white", "cream", "navy", "camel"]) assert.ok(neutralNames.includes(n), `missing neutral ${n}`);
  for (const c of pal.neutrals) assert.ok(NEUTRALS.has(c.colour));
  for (const c of [...pal.secondary, ...pal.accent]) assert.ok(!NEUTRALS.has(c.colour), `${c.colour} is a neutral`);
  assert.ok(pal.secondary.length <= 2);
  assert.equal(pal.secondary[0].colour, "olive");
  assert.ok(pal.neutral_share > 0.6, "brief §2.3: neutrals should be the base layer");
  // Sorted desc.
  for (let i = 1; i < pal.neutrals.length; i++) assert.ok(pal.neutrals[i - 1].weight >= pal.neutrals[i].weight);
});

test("dominant colours bucket hex to named hues, top 8", () => {
  assert.equal(nearestHue("#000000"), "black");
  assert.equal(nearestHue("#1b2a4a"), "navy");
  assert.equal(nearestHue("#ffffff"), "white");
  assert.equal(nearestHue("not a colour"), null);
  assert.equal(nearestHue(null), null);
  const p = run();
  assert.ok(p.overall.dominant_colors.length <= 8);
  assert.ok(p.overall.dominant_colors.length > 0);
  for (const d of p.overall.dominant_colors) assert.match(d.hex, /^#[0-9a-f]{6}$/);
  assert.equal(p.overall.dominant_colors[0].hue, "navy");
});

test("absences list items that appear at most once, phrased as observations", () => {
  const p = run();
  const abs = p.overall.absences;
  assert.ok(abs.includes("never pins: jumpsuit"), abs.join("\n"));
  assert.ok(abs.includes("never pins: shorts"));
  // The cropped top only occurs on the low-confidence pin, which is dropped.
  assert.ok(abs.includes("never pins: cropped tops"));
  assert.ok(abs.includes("pins only once: burgundy"));
  // Things that appear 2+ times are not listed.
  assert.ok(!abs.some((a) => a.endsWith(": black")));
  for (const a of abs) assert.match(a, /^(never pins|pins only once): /);
});

test("garment_combos_top: emergent pairs/triples of subcategories among outfit pins, weighted and capped", () => {
  const p = run();
  const { pairs, triples } = p.overall.garment_combos_top;
  assert.ok(pairs.length > 0 && pairs.length <= 15);
  assert.ok(triples.length <= 15);
  for (const row of pairs) {
    assert.equal(row.combo.split("+").length, 2);
    assert.deepEqual(row.combo.split("+"), [...row.combo.split("+")].sort(), "combo keys are sorted");
    assert.ok(row.weight > 0 && row.count >= 1);
  }
  for (const row of triples) assert.equal(row.combo.split("+").length, 3);
  // The fixture's repeated blazer + wide-leg trouser + loafer looks must surface as a triple.
  assert.ok(triples.some((r) => r.combo === "blazer+loafer+wide-leg-trouser"), JSON.stringify(triples.slice(0, 3)));
  // Sorted by weight desc; weights are shares of outfit-pin weight, so a pair
  // present in every outfit pin would be 1 and none can exceed 1.
  for (let i = 1; i < pairs.length; i++) assert.ok(pairs[i - 1].weight >= pairs[i].weight);
  for (const row of pairs) assert.ok(row.weight <= 1);
  assert.deepEqual(combinations(["a", "b", "c"], 2), [["a", "b"], ["a", "c"], ["b", "c"]]);
  assert.deepEqual(combinations(["a"], 2), []);
});

test("top-N lists are capped and extra fields present", () => {
  const p = run();
  assert.ok(p.overall.subcategory_top.length <= 15);
  assert.ok(p.overall.vibe_keywords_top.length <= 20);
  assert.equal(p.overall.vibe_keywords_top[0].keyword, "minimal");
  assert.ok(p.overall.formality_mean > 1 && p.overall.formality_mean < 5);
  assert.deepEqual(Object.keys(p.overall.formality_histogram), ["1", "2", "3", "4", "5"]);
  assert.equal(p.boards["swim-look"].formality_histogram["1"].count, 3);
});

test("deterministic: same output across runs and input orderings, 4 dp", () => {
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const reversed = aggregate({ tags: [...TAGS].reverse(), pins: [...PINS].reverse() });
  assert.deepEqual(reversed, a);
  const walk = (v) => {
    if (typeof v === "number") assert.equal(v, Math.round(v * 1e4) / 1e4, `not 4 dp: ${v}`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(a);
  assert.deepEqual(Object.keys(a), ["version", "domain", "coverage", "overall", "boards"]);
  assert.equal(a.domain, "fashion");
});

test("min-confidence threshold is respected", () => {
  const strict = run({ minConfidence: 0.9 });
  assert.ok(strict.coverage.used < run().coverage.used);
  assert.ok(strict.coverage.below_confidence > 1);
  const loose = run({ minConfidence: 0 });
  assert.equal(loose.coverage.below_confidence, 0);
  assert.ok(loose.overall.palette.accent.some((c) => c.colour === "red") || loose.overall.palette.secondary.some((c) => c.colour === "red"));
});

test("summary is 16 lines", () => {
  assert.equal(summaryLines(run()).length, 16);
});

test("CLI writes the profile and prints a summary to stderr", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "style-data-agg-"));
  const pinsPath = path.join(tmp, "pins.jsonl");
  const outPath = path.join(tmp, "nested", "taste-profile.json");
  fs.writeFileSync(pinsPath, PINS.map((p) => JSON.stringify(p)).join("\n") + "\n");
  let stderr = "";
  try {
    execFileSync(process.execPath, [SCRIPT, "--tags", FIXTURE, "--pins", pinsPath, "--out", outPath, "--half-life-days", "365"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    assert.fail(`CLI failed: ${e.stderr}`);
  }
  const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(written.coverage.half_life_days, 365);
  assert.deepEqual(written, aggregate({ tags: TAGS, pins: PINS, halfLifeDays: 365 }));
  // Summary goes to stderr; capture by re-running with stderr redirected.
  stderr = execFileSync("sh", ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} --tags ${JSON.stringify(FIXTURE)} --pins ${JSON.stringify(pinsPath)} --out ${JSON.stringify(outPath)} 2>&1 1>/dev/null`]).toString();
  const lines = stderr.trim().split("\n");
  assert.ok(lines.length >= 15, `expected >=15 summary lines, got ${lines.length}`);
  assert.match(lines[0], /taste profile/);
  // Usage errors exit 2: --help, a missing input file, an unknown domain exits 1.
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--help"], { stdio: "ignore" }), (e) => e.status === 2);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--tags", path.join(tmp, "nope.jsonl"), "--pins", pinsPath, "--out", outPath], { stdio: "ignore" }), (e) => e.status === 2);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--domain", "garden", "--tags", FIXTURE, "--pins", pinsPath, "--out", outPath], { stdio: "ignore" }), (e) => e.status === 1);
});

test("rows without a domain fall back to boards.json; foreign-domain rows are excluded", () => {
  const noDomain = TAGS.map(({ domain, ...rest }) => rest);
  assert.deepEqual(aggregate({ tags: noDomain, pins: PINS }), run());
  // A home row mixed into the fashion export never reaches the fashion profile.
  const homeRow = { pin_id: "h99", board: "for-the-home", tag: { is_interior: true, room: "kitchen", items: [], styles: [], vibe_keywords: [], confidence: 1 } };
  const mixed = aggregate({ tags: [...TAGS, homeRow], pins: [...PINS, { pin_id: "h99", board: "for-the-home", created_at: "2026-09-01T00:00:00Z" }] });
  assert.deepEqual(mixed, run());
  assert.equal(mixed.coverage.pins_total, 12);
});
