import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { aggregateHome, HOME_NEUTRALS, summaryLinesHome, ABSENCE_CANDIDATES } from "../aggregate-home.mjs";
import { aggregate as aggregateFashion, parseJsonl, domainsIn, VERSION } from "../aggregate.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, "..", "aggregate.mjs");
const FIXTURE = path.join(DIR, "fixtures", "tags-home.sample.jsonl");
const FASHION_FIXTURE = path.join(DIR, "fixtures", "tags.sample.jsonl");

// Inline pins fixture: h03 has no date; h09 is four years older than the
// newest pin (h01). Schema v2 rows carry `domain`; h08 deliberately omits it
// so the boards.json fallback is exercised.
export const PINS = [
  { schema_version: 2, pin_id: "h01", source: "pinterest", board: "for-the-home", domain: "home", created_at: "2026-09-25T10:00:00Z", dominant_color: "#e9e2d6" },
  { schema_version: 2, pin_id: "h02", source: "pinterest", board: "for-the-home", domain: "home", created_at: "2026-08-10T10:00:00Z", dominant_color: "#f4f1ea" },
  { schema_version: 2, pin_id: "h03", source: "pinterest", board: "for-the-home", domain: "home", created_at: null, dominant_color: "#b7bfae" },
  { schema_version: 2, pin_id: "h04", source: "pinterest", board: "for-the-home", domain: "home", created_at: "2026-05-02T10:00:00Z", dominant_color: "#d9c7a8" },
  { schema_version: 2, pin_id: "h05", source: "pinterest", board: "for-the-home", domain: "home", created_at: "2026-04-01T10:00:00Z", dominant_color: null },
  { schema_version: 2, pin_id: "h06", source: "pinterest", board: "for-the-home", domain: "home", created_at: "2026-02-14T10:00:00Z", dominant_color: "#5a1f2b" },
  { schema_version: 2, pin_id: "h07", source: "pinterest", board: "for-the-home", domain: "home", created_at: "2025-07-20T10:00:00Z", dominant_color: "#c86a3a" },
  { schema_version: 2, pin_id: "h08", source: "pinterest", board: "for-the-home", created_at: "2025-11-11T10:00:00Z", dominant_color: "#cdb89a" },
  { schema_version: 2, pin_id: "h09", source: "pinterest", board: "for-the-home", domain: "home", created_at: "2022-09-25T10:00:00Z", dominant_color: "#3b3b3b" },
  { schema_version: 2, pin_id: "h10", source: "pinterest", board: "for-the-home", domain: "home", created_at: "2026-06-30T10:00:00Z", dominant_color: "#e5e0d5" },
];

// Fashion pins for the multi-domain CLI test (same as aggregate.test.mjs).
const FASHION_PINS = [
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
const FASHION_TAGS = parseJsonl(fs.readFileSync(FASHION_FIXTURE, "utf8"));
const run = (opts = {}) => aggregateHome({ tags: TAGS, pins: PINS, ...opts });

const sumW = (rows) => rows.reduce((a, r) => a + r.weight, 0);
const approx = (a, b, eps = 2e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

const HOME_KEYS = [
  "pins_used",
  "weight_total",
  "rooms",
  "item_types_top",
  "materials",
  "styles",
  "palette",
  "palette_mood",
  "era",
  "vibe_keywords_top",
  "item_colour_by_type",
  "absences",
];

test("home fixture shape: 10 lines, one board, one null tag, one low-confidence, one exterior", () => {
  assert.equal(TAGS.length, 10);
  assert.ok(TAGS.every((t) => t.board === "for-the-home" && t.domain === "home"));
  assert.equal(TAGS.filter((t) => t.tag === null).length, 1);
  assert.equal(TAGS.filter((t) => t.tag && t.tag.confidence < 0.5).length, 1);
  assert.equal(TAGS.filter((t) => t.tag && t.tag.is_interior === false).length, 1);
  assert.equal(PINS.filter((p) => p.created_at === null).length, 1);
  for (const t of TAGS) {
    if (!t.tag) continue;
    assert.deepEqual(Object.keys(t.tag), ["is_interior", "room", "items", "styles", "palette_mood", "era", "vibe_keywords", "confidence"]);
    for (const it of t.tag.items) assert.deepEqual(Object.keys(it), ["type", "material", "colour", "style"]);
  }
});

test("envelope and key order: {version, domain, coverage, overall, boards}", () => {
  const p = run();
  assert.deepEqual(Object.keys(p), ["version", "domain", "coverage", "overall", "boards"]);
  assert.equal(p.version, VERSION);
  assert.equal(p.domain, "home");
  assert.deepEqual(Object.keys(p.overall), HOME_KEYS);
  assert.deepEqual(Object.keys(p.boards["for-the-home"]), HOME_KEYS);
  assert.deepEqual(Object.keys(p.coverage), [
    "pins_total",
    "tagged",
    "tag_versions",
    "below_confidence",
    "not_interior",
    "unjoined",
    "used",
    "interior_share",
    "date_min",
    "date_max",
    "undated",
    "half_life_days",
    "min_confidence",
    "boards",
  ]);
});

test("coverage: null tag, low confidence and exterior pins are excluded; interior_share", () => {
  const p = run();
  assert.equal(p.coverage.pins_total, 10);
  assert.equal(p.coverage.tagged, 9);
  assert.equal(p.coverage.below_confidence, 1);
  assert.equal(p.coverage.not_interior, 1);
  assert.equal(p.coverage.unjoined, 0);
  assert.equal(p.coverage.used, 7);
  assert.equal(p.coverage.interior_share, 0.875); // 7 of the 8 confident tags
  assert.equal(p.coverage.undated, 1);
  assert.equal(p.coverage.date_min, "2022-09-25");
  assert.equal(p.coverage.date_max, "2026-09-25");
  assert.deepEqual(p.coverage.boards, ["for-the-home"]);
  assert.equal(p.boards["for-the-home"].pins_used, 7);
  // The exterior pin's room and the low-confidence pin's items never leak in.
  assert.ok(!p.overall.rooms.some((r) => r.room === "outdoor"));
  assert.ok(!p.overall.materials.some((m) => m.material === "velvet"));
  assert.ok(!p.overall.palette.accent.some((c) => c.colour === "burgundy"));
});

test("weights are normalised: each distribution sums to 1", () => {
  const p = run();
  for (const scope of [p.overall, p.boards["for-the-home"]]) {
    approx(sumW(scope.rooms), 1);
    // item_types_top is capped at 20 (the fixture has 26 types), so its weights
    // are shares of all items and sum to < 1; the full distribution is in
    // item_colour_by_type's source counter.
    assert.ok(sumW(scope.item_types_top) <= 1 + 1e-3);
    approx(sumW(scope.materials), 1);
    approx(sumW(scope.styles), 1);
    approx(sumW(scope.palette_mood), 1);
    approx(sumW(scope.era), 1);
    approx(sumW(scope.vibe_keywords_top), 1);
    assert.ok(scope.palette.neutral_share + scope.palette.secondary_share + scope.palette.accent_share <= 1 + 1e-3);
    for (const r of scope.rooms) assert.ok(r.weight >= 0 && r.weight <= 1 && Number.isInteger(r.count));
  }
  assert.equal(p.overall.rooms[0].room, "living-room");
  assert.equal(p.overall.rooms[0].count, 2);
});

test("recency weighting favours newer pins at equal counts", () => {
  const p = run();
  const byRoom = Object.fromEntries(p.overall.rooms.map((r) => [r.room, r]));
  const newer = byRoom.kitchen; // h02, 2026-08-10
  const older = byRoom["home-office"]; // h09, 2022-09-25
  assert.equal(newer.count, 1);
  assert.equal(older.count, 1);
  assert.ok(newer.weight > older.weight);
  // 1415 days at the default 3-year half-life: 0.5^(1415/1095) ≈ 0.41.
  assert.equal(p.coverage.half_life_days, 1095, "home shares the 1095-day default");
  approx(older.weight / newer.weight, Math.pow(0.5, 1415 / 1095), 2e-3);
  // The old 2-year half-life, passed explicitly, is steeper.
  const steep = run({ halfLifeDays: 730 });
  const bySteep = Object.fromEntries(steep.overall.rooms.map((r) => [r.room, r]));
  assert.ok(bySteep["home-office"].weight / bySteep.kitchen.weight < 0.3);
  const flat = run({ halfLifeDays: 100000 });
  const byFlat = Object.fromEntries(flat.overall.rooms.map((r) => [r.room, r]));
  approx(byFlat.kitchen.weight, byFlat["home-office"].weight, 2e-3);
});

test("palette split: home neutrals in `neutrals`, nothing neutral in secondary/accent", () => {
  for (const n of ["white", "warm-white", "cream", "beige", "sand", "greige", "taupe", "grey", "charcoal", "black", "brown"]) {
    assert.ok(HOME_NEUTRALS.has(n), `missing home neutral ${n}`);
  }
  const p = run();
  const pal = p.overall.palette;
  const neutralNames = pal.neutrals.map((c) => c.colour);
  for (const n of ["brown", "cream", "beige", "white", "greige", "sand", "charcoal"]) assert.ok(neutralNames.includes(n), `missing neutral ${n}`);
  for (const c of pal.neutrals) assert.ok(HOME_NEUTRALS.has(c.colour));
  for (const c of [...pal.secondary, ...pal.accent]) assert.ok(!HOME_NEUTRALS.has(c.colour), `${c.colour} is a neutral`);
  assert.ok(pal.secondary.length <= 2);
  assert.deepEqual(pal.secondary.map((c) => c.colour).sort(), ["gold", "sage"]);
  assert.ok(pal.neutral_share > 0.6, "neutrals should be the base layer");
  for (let i = 1; i < pal.neutrals.length; i++) assert.ok(pal.neutrals[i - 1].weight >= pal.neutrals[i].weight);
  assert.deepEqual(Object.keys(pal), ["neutrals", "secondary", "accent", "neutral_share", "secondary_share", "accent_share"]);
});

test("item_colour_by_type: top 10 types × top 3 colours, sorted", () => {
  const p = run();
  const ict = p.overall.item_colour_by_type;
  assert.ok(ict.length > 0 && ict.length <= 10);
  assert.deepEqual(ict.map((r) => r.type), p.overall.item_types_top.slice(0, 10).map((r) => r.type));
  for (const row of ict) {
    assert.deepEqual(Object.keys(row), ["type", "weight", "colours"]);
    assert.ok(row.colours.length >= 1 && row.colours.length <= 3);
    approx(sumW(row.colours), 1, 2e-3 * row.colours.length);
    for (let i = 1; i < row.colours.length; i++) assert.ok(row.colours[i - 1].weight >= row.colours[i].weight);
  }
  const sofa = ict.find((r) => r.type === "sofa");
  assert.ok(sofa, "sofa should be a top item type");
  assert.deepEqual(sofa.colours.map((c) => c.colour).sort(), ["cream", "greige"]);
  const rug = ict.find((r) => r.type === "rug");
  assert.equal(rug.colours.length, 3); // beige, sand, sage
});

test("absences list conventional rooms/items/materials/styles seen at most once", () => {
  const p = run();
  const abs = p.overall.absences;
  assert.ok(abs.includes("never pins: nursery / kids room"), abs.join("\n"));
  assert.ok(abs.includes("never pins: entryway / hallway"));
  // The exterior pin is excluded, so outdoor never appears.
  assert.ok(abs.includes("never pins: outdoor / garden"));
  // Velvet and maximalist only occur on the low-confidence pin, which is dropped.
  assert.ok(abs.includes("never pins: velvet"));
  assert.ok(abs.includes("never pins: maximalist"));
  assert.ok(abs.includes("pins only once: kitchen"));
  assert.ok(abs.includes("pins only once: marble"));
  assert.ok(abs.includes("pins only once: leather"));
  // Things that appear 2+ times are not listed.
  assert.ok(!abs.some((a) => a.endsWith(": living room")));
  assert.ok(!abs.some((a) => a.endsWith(": light wood / oak")));
  assert.ok(!abs.some((a) => a.endsWith(": japandi")));
  assert.ok(!abs.some((a) => a.endsWith(": rug")));
  for (const a of abs) assert.match(a, /^(never pins|pins only once): /);
  const labels = new Set(Object.values(ABSENCE_CANDIDATES).flat().map((c) => c.label));
  for (const a of abs) assert.ok(labels.has(a.replace(/^(never pins|pins only once): /, "")), a);
});

test("top-N caps, mood/era/vibes present, item-level style folded into styles", () => {
  const p = run();
  assert.equal(p.overall.item_types_top.length, 20); // 26 distinct types in the fixture, capped
  assert.ok(p.overall.vibe_keywords_top.length <= 20);
  assert.equal(p.overall.vibe_keywords_top[0].keyword, "calm");
  assert.equal(p.overall.palette_mood[0].mood, "warm-neutral");
  assert.equal(p.overall.era[0].era, "contemporary");
  const styleNames = p.overall.styles.map((s) => s.style);
  assert.ok(styleNames.includes("japandi"));
  assert.ok(styleNames.includes("industrial"), "item-level style (h02 pendant) should count");
  assert.ok(!styleNames.includes("maximalist"));
  // Empty item material/style (h09 plant) is skipped, not counted as "".
  assert.ok(!p.overall.materials.some((m) => m.material === ""));
  assert.ok(!styleNames.includes(""));
});

test("deterministic: same output across runs and input orderings, 4 dp", () => {
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const reversed = aggregateHome({ tags: [...TAGS].reverse(), pins: [...PINS].reverse() });
  assert.deepEqual(reversed, a);
  const walk = (v) => {
    if (typeof v === "number") assert.equal(v, Math.round(v * 1e4) / 1e4, `not 4 dp: ${v}`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(a);
});

test("min-confidence threshold is respected", () => {
  const strict = run({ minConfidence: 0.9 });
  assert.ok(strict.coverage.used < run().coverage.used);
  assert.ok(strict.coverage.below_confidence > 1);
  const loose = run({ minConfidence: 0 });
  assert.equal(loose.coverage.below_confidence, 0);
  assert.ok(loose.overall.materials.some((m) => m.material === "velvet"));
});

test("domain isolation: fashion rows never enter the home profile and vice versa", () => {
  const tags = [...FASHION_TAGS, ...TAGS];
  const pins = [...FASHION_PINS, ...PINS];
  assert.deepEqual(domainsIn(tags, pins), ["fashion", "home"]);
  const home = aggregateHome({ tags, pins });
  assert.deepEqual(home, run());
  assert.equal(home.coverage.pins_total, 10);
  const fashion = aggregateFashion({ tags, pins });
  assert.deepEqual(fashion, aggregateFashion({ tags: FASHION_TAGS, pins: FASHION_PINS }));
  assert.equal(fashion.coverage.pins_total, 12);
  // Tag rows with no domain fall back to the board's entry in boards.json.
  const noDomain = TAGS.map(({ domain, ...rest }) => rest);
  const noDomainPins = PINS.map(({ domain, ...rest }) => rest);
  assert.deepEqual(aggregateHome({ tags: noDomain, pins: noDomainPins }), run());
});

test("summary is 13 lines", () => {
  const lines = summaryLinesHome(run());
  assert.equal(lines.length, 13);
  assert.match(lines[0], /home taste profile/);
  assert.match(lines[1], /interior share 88%/);
});

test("CLI: default run writes one profile per domain; --domain home writes one", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "style-data-agg-home-"));
  const tagsPath = path.join(tmp, "tags.jsonl");
  const pinsPath = path.join(tmp, "pins.jsonl");
  const outTpl = path.join(tmp, "profiles", "<domain>.taste-profile.json");
  fs.writeFileSync(tagsPath, [...FASHION_TAGS, ...TAGS].map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(pinsPath, [...FASHION_PINS, ...PINS].map((p) => JSON.stringify(p)).join("\n") + "\n");

  const exec = (args) =>
    execFileSync("sh", ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} ${args.map((a) => JSON.stringify(a)).join(" ")} 2>&1 1>/dev/null`]).toString();

  // Multi-domain default: two files, both summaries on stderr.
  const err = exec(["--tags", tagsPath, "--pins", pinsPath, "--out", outTpl, "--half-life-days", "365"]);
  const fashionOut = path.join(tmp, "profiles", "fashion.taste-profile.json");
  const homeOut = path.join(tmp, "profiles", "home.taste-profile.json");
  assert.ok(fs.existsSync(fashionOut) && fs.existsSync(homeOut));
  assert.deepEqual(fs.readdirSync(path.join(tmp, "profiles")).sort(), ["fashion.taste-profile.json", "home.taste-profile.json"]);
  const writtenHome = JSON.parse(fs.readFileSync(homeOut, "utf8"));
  const writtenFashion = JSON.parse(fs.readFileSync(fashionOut, "utf8"));
  assert.deepEqual(writtenHome, aggregateHome({ tags: TAGS, pins: PINS, halfLifeDays: 365 }));
  assert.deepEqual(writtenFashion, aggregateFashion({ tags: FASHION_TAGS, pins: FASHION_PINS, halfLifeDays: 365 }));
  assert.match(err, /fashion taste profile/);
  assert.match(err, /home taste profile/);
  assert.match(err, /wrote .*fashion\.taste-profile\.json/);
  assert.match(err, /wrote .*home\.taste-profile\.json/);

  // --domain home: exactly one file.
  const only = path.join(tmp, "only", "home.json");
  exec(["--domain", "home", "--tags", tagsPath, "--pins", pinsPath, "--out", only]);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "only")), ["home.json"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(only, "utf8")), run());

  // Two domains but a literal --out with no <domain> placeholder is a usage error.
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, "--tags", tagsPath, "--pins", pinsPath, "--out", path.join(tmp, "x.json")], { stdio: "ignore" }),
    (e) => e.status === 2,
  );
  assert.ok(!fs.existsSync(path.join(tmp, "x.json")));
});
