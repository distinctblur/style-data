import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { aggregate, parseJsonl, nearestHue, NEUTRALS, summaryLines, DEFAULT_HALF_LIFE_DAYS, parseArgs, selectTagRows } from "../aggregate.mjs";
import { combinations } from "../aggregate-fashion.mjs";
import { assignFormula, impliedBase } from "../formula-assign.mjs";
import { FORMULA_V2_IDS } from "../taxonomies/fashion.mjs";

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
  assert.equal(p.coverage.half_life_days, 1095, "default half-life is three years (owner decision 2026-10-12)");
  assert.equal(DEFAULT_HALF_LIFE_DAYS, 1095);
  assert.equal(parseArgs([]).halfLifeDays, 1095, "CLI default");
  assert.equal(parseArgs(["--half-life-days", "730"]).halfLifeDays, 730, "still overridable");
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
  // 1715 days at the default 3-year half-life: 0.5^(1715/1095) ≈ 0.34 of newest.
  approx(oldest.weight / newest.weight, Math.pow(0.5, 1715 / 1095), 2e-3);
  assert.ok(oldest.weight / newest.weight < 0.5);
  // The old 2-year half-life, passed explicitly, is steeper: well under a quarter.
  const steep = run({ halfLifeDays: 730 });
  const bySteep = Object.fromEntries(steep.overall.formula_weights.map((r) => [r.formula, r]));
  assert.ok(bySteep["jeans+tee+sneaker"].weight / bySteep["slip-dress+sandal"].weight < 0.25);
  assert.equal(steep.coverage.half_life_days, 730);
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

test("summary is 17 lines and names both formula lists", () => {
  const lines = summaryLines(run());
  assert.equal(lines.length, 17);
  assert.match(lines[4], /^formulas: /);
  assert.match(lines[5], /^formulas v2: .*\(coverage \d+%\)$/);
});

test("formula_weights_v2: assigned from garments, sums to 1, coverage = 1 - other share, per board and overall", () => {
  const p = run();
  for (const scope of [p.overall, p.boards["my-style"], p.boards["swim-look"]]) {
    approx(sumW(scope.formula_weights_v2), 1);
    assert.ok(scope.formula_v2_coverage >= 0 && scope.formula_v2_coverage <= 1);
    const other = scope.formula_weights_v2.find((r) => r.formula === "other")?.weight ?? 0;
    approx(scope.formula_v2_coverage, 1 - other, 1e-3);
    for (const r of scope.formula_weights_v2) {
      assert.ok(FORMULA_V2_IDS.includes(r.formula), `unknown v2 formula ${r.formula}`);
      assert.ok(Number.isInteger(r.count) && r.count >= 1);
    }
    assert.equal(scope.formula_weights_v2.reduce((a, r) => a + r.count, 0), scope.pins_used);
  }
  // The model's v1 answer is untouched next to it.
  assert.ok(p.overall.formula_weights.some((r) => r.formula === "slip-dress+sandal"));
  const keys = Object.keys(p.overall);
  assert.deepEqual(keys.slice(keys.indexOf("formula_weights"), keys.indexOf("formula_weights") + 3), ["formula_weights", "formula_weights_v2", "formula_v2_coverage"]);
  // Counts agree with assignFormula over the used fixture pins (same garments, same matcher).
  const expect = {};
  for (const t of TAGS) {
    if (!t.tag || t.tag.confidence < 0.5 || t.tag.is_outfit === false) continue;
    const f = assignFormula(t.tag.garments).formula;
    expect[f] = (expect[f] ?? 0) + 1;
  }
  assert.deepEqual(Object.fromEntries(p.overall.formula_weights_v2.map((r) => [r.formula, r.count])), expect);
  // The fixture's repeated blazer + wide-leg trouser + loafer looks keep their brief formula under v2.
  assert.ok(p.overall.formula_weights_v2.some((r) => r.formula === "blazer+wide-leg-trouser+loafer"));
});

test("every weighted list carries the raw count next to the share, so a draft can cite both", () => {
  const p = run();
  const isRow = (r) => Number.isInteger(r.count) && r.count >= 1 && typeof r.weight === "number" && r.weight >= 0 && r.weight <= 1;
  for (const scope of [p.overall, p.boards["my-style"], p.boards["swim-look"]]) {
    const lists = [
      scope.formula_weights, scope.formula_weights_v2, scope.silhouettes, scope.seasons, scope.occasions,
      scope.garment_mix, scope.subcategory_top, scope.vibe_keywords_top, scope.dominant_colors,
      scope.palette.neutrals, scope.palette.secondary, scope.palette.accent,
      scope.garment_combos_top.pairs, scope.garment_combos_top.triples,
    ];
    for (const list of lists) {
      assert.ok(Array.isArray(list));
      for (const r of list) assert.ok(isRow(r), JSON.stringify(r));
    }
    for (const lvl of ["1", "2", "3", "4", "5"]) {
      const h = scope.formality_histogram[lvl];
      assert.ok(Number.isInteger(h.count) && typeof h.weight === "number", JSON.stringify(h));
    }
  }
  // A once-popular, now-old formula shows the disagreement the seed prompt is told to read: count high, share low.
  const old = p.overall.formula_weights.find((r) => r.formula === "jeans+tee+sneaker");
  assert.equal(old.count, 1);
  assert.ok(old.weight < 1 / p.overall.pins_used, "an old pin's share is below its count share");
});

test("coverage.assumed_base_count: used pins the matcher treated as a top-half crop (implied jeans)", () => {
  const p = run();
  const used = TAGS.filter((t) => t.tag && t.tag.confidence >= 0.5 && t.tag.is_outfit !== false);
  assert.equal(p.coverage.assumed_base_count, used.filter((t) => impliedBase(t.tag.garments) !== null).length);
  assert.ok(Number.isInteger(p.coverage.assumed_base_count));
  const keys = Object.keys(p.coverage);
  assert.equal(keys[keys.indexOf("outfit_share") + 1], "assumed_base_count", "sits right after outfit_share");
  // Two crops among three pins: counted in coverage, assigned whole-look formulas in formula_weights_v2.
  const mk = (id, garments, extra = {}) => ({
    pin_id: id, board: "b",
    tag: { is_outfit: true, garments, formula: "other", silhouette: "s", formality: 2, season: "x", occasion: "y", vibe_keywords: ["a"], confidence: 1, ...extra },
  });
  const gm = (...subs) => subs.map((s) => ({ category: { "t-shirt": "top", necklace: "jewelry", jeans: "bottom", "knit-sweater": "top", shirt: "top" }[s], subcategory: s, colour: "black", pattern: "solid", fabric: "unknown" }));
  const tags = [mk("crop1", gm("t-shirt", "necklace")), mk("crop2", gm("knit-sweater", "shirt")), mk("full", gm("jeans", "t-shirt")), mk("skip", gm("t-shirt"), { is_outfit: false })];
  const pins = tags.map((t) => ({ pin_id: t.pin_id, board: "b", created_at: "2026-01-01T00:00:00Z" }));
  const q = aggregate({ tags, pins });
  assert.equal(q.coverage.used, 3);
  assert.equal(q.coverage.assumed_base_count, 2, "the non-outfit crop is not counted");
  assert.deepEqual(Object.fromEntries(q.overall.formula_weights_v2.map((r) => [r.formula, r.count])), { "jeans+tee+sunglasses": 1, "jeans+knit+shirt": 1, "jeans+tee": 1 });
  assert.equal(q.overall.formula_v2_coverage, 1);
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
  assert.match(lines[2], /half-life 1095d/, "the summary names the default half-life");
  assert.equal(JSON.parse(fs.readFileSync(outPath, "utf8")).coverage.half_life_days, 1095, "no flag -> the 1095-day default is written");
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

test("selectTagRows: one row per pin, preferring the current prompt version, else the last success, else the last failure", () => {
  const t = (pin_id, prompt_version, tag, domain = "fashion") => ({ pin_id, domain, prompt_version, tag });
  const good = { is_outfit: true, garments: [], formula: "other", silhouette: "s", formality: 2, season: "x", occasion: "y", vibe_keywords: ["a"], confidence: 1 };
  const rows = [
    t("a", "fashion.tag.v1", good),
    t("a", "fashion.tag.v2", { ...good, formula: "jeans+tee" }),
    t("b", "fashion.tag.v2", null),           // v2 failed …
    t("b", "fashion.tag.v1", good),           // … keep the v1 success
    t("c", "fashion.tag.v1", null),
    t("c", "fashion.tag.v1", null),           // all failed: keep one failure row
    t("d", "fashion.tag.v1", good),
    t("d", "fashion.tag.v2", good),
    t("d", "fashion.tag.v2", null),           // a later v2 failure must not displace the v2 success
    t("h", "home.tag.v1", good, "home"),
  ];
  const sel = selectTagRows(rows, { preferVersion: "fashion.tag.v2" });
  const by = Object.fromEntries(sel.map((r) => [`${r.pin_id}/${r.domain}`, r]));
  assert.equal(sel.length, 5);
  assert.equal(by["a/fashion"].tag.formula, "jeans+tee");
  assert.equal(by["b/fashion"].prompt_version, "fashion.tag.v1");
  assert.equal(by["c/fashion"].tag, null);
  assert.equal(by["d/fashion"].prompt_version, "fashion.tag.v2");
  assert.ok(by["d/fashion"].tag);
  assert.equal(by["h/home"].prompt_version, "home.tag.v1");
  // Through the aggregate: a pin tagged twice is counted once, and the version mix is reported.
  const pins = [{ pin_id: "a", board: "b", domain: "fashion", created_at: "2026-01-01T00:00:00Z" }, { pin_id: "d", board: "b", domain: "fashion", created_at: "2026-01-02T00:00:00Z" }];
  const p = aggregate({ tags: rows.filter((r) => ["a", "d"].includes(r.pin_id)), pins });
  assert.equal(p.coverage.tagged, 2);
  assert.equal(p.coverage.used, 2);
  assert.deepEqual(p.coverage.tag_versions, { "fashion.tag.v2": 2 });
});
