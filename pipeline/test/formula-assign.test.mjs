import { test } from "node:test";
import assert from "node:assert/strict";
import { assignFormula, assignAll, matchFormula, MIN_SCORE, OPTIONAL_WEIGHT } from "../formula-assign.mjs";
import { FORMULAS_V2, FORMULA_V2_IDS, SUBCATEGORY_TO_CATEGORY } from "../taxonomies/fashion.mjs";

const g = (...subs) => subs.map((s) => ({ category: SUBCATEGORY_TO_CATEGORY[s], subcategory: s, colour: "black", pattern: "solid", fabric: "unknown" }));

test("hand-written garment lists land on the expected v2 formula", () => {
  const cases = [
    [g("jeans", "cardigan", "t-shirt", "necklace", "flat"), "jeans+cardigan+tee"],
    [g("jeans", "knit-sweater", "shirt", "necklace", "loafer"), "jeans+knit+shirt"],
    [g("jeans", "knit-sweater", "scarf", "boot"), "jeans+knit+scarf"],
    [g("jeans", "knit-sweater", "necklace", "flat"), "jeans+knit+necklace"],
    // cardigan + tee + necklace ties jeans+cardigan+tee and jeans+knit+necklace at 3.5; list order picks the stronger signature.
    [g("jeans", "cardigan", "necklace", "tank"), "jeans+cardigan+tee"],
    [g("jeans", "blazer", "t-shirt", "heel", "tote"), "jeans+blazer+tee"],
    [g("jeans", "shirt", "belt", "sunglasses"), "jeans+shirt+belt"],
    [g("jeans", "t-shirt", "sunglasses", "sandal", "tote"), "jeans+tee+sunglasses"],
    [g("mini-skirt", "knit-sweater", "boot", "tights"), "skirt+knit+boot"],
    [g("midi-skirt", "blouse", "heel", "belt"), "midi-skirt+fitted-top"],
    [g("mini-skirt", "t-shirt", "heel", "necklace"), "skirt+top+heel"],
    [g("mini-dress", "cardigan", "sandal"), "dress+cardigan"],
    [g("midi-dress", "boot", "tights"), "dress+boot"],
    [g("maxi-dress", "necklace", "sandal", "sunglasses"), "dress+necklace+sandal"],
    [g("blazer", "wide-leg-trouser", "loafer", "tank"), "blazer+wide-leg-trouser+loafer"],
    [g("knit-sweater", "trouser", "loafer", "shirt"), "knit+trouser+loafer"],
    [g("trouser", "shirt", "heel", "belt"), "trouser+shirt+heel"],
    [g("leggings", "cardigan", "t-shirt", "boot", "scarf"), "leggings+knit+boot"],
    [g("leggings", "sweatshirt", "sneaker"), "athleisure"],
    [g("shorts", "tank", "sandal", "sunglasses"), "shorts+top+sandal"],
    [g("bikini", "cover-up", "hat"), "swim+cover-up"],
    [g("knit-sweater", "shirt", "necklace", "watch"), "knit+shirt+necklace"],
  ];
  for (const [garments, expected] of cases) {
    const r = assignFormula(garments);
    assert.equal(r.formula, expected, `${garments.map((x) => x.subcategory).join(",")} -> ${r.formula}`);
    assert.deepEqual(r.missing_required, []);
    assert.ok(r.score >= MIN_SCORE);
    assert.ok(r.matched_slots.length >= 1);
  }
});

test("a missing required slot or a score below the threshold is `other`, with the nearest miss explained", () => {
  // jeans + cardigan but nothing underneath: jeans+cardigan+tee needs `under`.
  const r = assignFormula(g("jeans", "cardigan", "tote"));
  assert.equal(r.formula, "other");
  assert.equal(typeof r.nearest, "string");
  assert.ok(r.missing_required.length >= 1, "explains what the nearest formula lacked");
  // A dress alone scores 1 (< MIN_SCORE) for dress+necklace+sandal.
  const d = assignFormula(g("maxi-dress"));
  assert.equal(d.formula, "other");
  assert.equal(d.score, 1);
  // No garments / junk input.
  assert.equal(assignFormula([]).formula, "other");
  assert.equal(assignFormula(null).formula, "other");
  assert.equal(assignFormula([{ category: "other", subcategory: "unknown" }]).formula, "other");
  // The threshold is a parameter: with minScore 1 the lone dress qualifies.
  assert.equal(assignFormula(g("maxi-dress"), FORMULAS_V2, { minScore: 1 }).formula, "dress+necklace+sandal");
});

test("scoring: required 1, optional 0.5; higher score wins, then more slots, then list order", () => {
  const formulas = [
    { id: "a", slots: [{ name: "x", any: ["jeans"], required: true }, { name: "y", any: ["t-shirt"], required: true }] },
    { id: "b", slots: [{ name: "x", any: ["jeans"], required: true }, { name: "y", any: ["t-shirt"], required: true }, { name: "z", any: ["necklace"], required: false }] },
    { id: "c", slots: [{ name: "x", any: ["jeans"], required: true }, { name: "y", any: ["t-shirt"], required: true }, { name: "z", any: ["scarf"], required: false }] },
    { id: "d", slots: [{ name: "x", any: ["jeans"], required: true }, { name: "y", any: ["t-shirt"], required: true }, { name: "z", any: ["necklace"], required: true }] },
    { id: "other", slots: [] },
  ];
  // Only a and the two optionals apply; b wins the tie with a on slot count.
  assert.equal(assignFormula(g("jeans", "t-shirt"), formulas).formula, "b");
  // b and c tie on score and slot count when neither optional is present; list order picks b.
  assert.equal(assignFormula(g("jeans", "t-shirt", "hat"), formulas).formula, "b");
  // c's optional is present: 2.5 beats b's 2.
  assert.equal(assignFormula(g("jeans", "t-shirt", "scarf"), formulas).formula, "c");
  // d's necklace is required: 3 beats b's 2.5.
  const r = assignFormula(g("jeans", "t-shirt", "necklace"), formulas);
  assert.equal(r.formula, "d");
  assert.equal(r.score, 3);
  assert.deepEqual(r.matched_slots, ["x", "y", "z"]);
  assert.equal(matchFormula(formulas[1], g("jeans", "t-shirt", "necklace")).score, 2 + OPTIONAL_WEIGHT);
});

test("one garment fills at most one slot; the matcher finds the assignment that maximises the score", () => {
  const f = { id: "f", slots: [{ name: "any-top", any: ["top"], required: true }, { name: "tee", any: ["t-shirt"], required: true }] };
  // Greedy would give the t-shirt to `any-top` and fail `tee`; the search assigns shirt -> any-top, t-shirt -> tee.
  assert.deepEqual(matchFormula(f, g("t-shirt", "shirt")), { score: 2, matched: ["any-top", "tee"], missingRequired: [] });
  // Only one top: it cannot fill both slots.
  const m = matchFormula(f, g("t-shirt"));
  assert.equal(m.score, 1);
  assert.deepEqual(m.missingRequired.length, 1);
  // Slots accept category ids as well as subcategory ids, and bare subcategory strings as garments.
  assert.equal(matchFormula({ id: "x", slots: [{ name: "s", any: ["shoes"], required: true }] }, ["loafer"]).score, 1);
  assert.equal(matchFormula({ id: "x", slots: [{ name: "s", any: ["shoes"], required: true }] }, [{ subcategory: "loafer" }]).score, 1, "category derived from the subcategory when absent");
});

test("deterministic and order-insensitive over garments; result shape is stable", () => {
  const garments = g("necklace", "jeans", "shirt", "knit-sweater", "flat");
  const a = assignFormula(garments);
  const b = assignFormula([...garments].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(a, assignFormula(garments));
  assert.deepEqual(Object.keys(a), ["formula", "score", "matched_slots", "missing_required"]);
  assert.ok(FORMULA_V2_IDS.includes(a.formula));
  const o = assignFormula([]);
  assert.deepEqual(Object.keys(o), ["formula", "score", "matched_slots", "missing_required", "nearest"]);
});

test("assignAll maps tag rows, skipping rows without a tag, and keeps the model's v1 answer alongside", () => {
  const rows = [
    { pin_id: "a", tag: { formula: "other", garments: g("jeans", "knit-sweater", "shirt") } },
    { pin_id: "b", tag: null },
    { pin_id: "c", tag: { formula: "jeans+tee+sneaker", garments: g("shorts") } },
  ];
  const out = assignAll(rows);
  assert.deepEqual(out.map((r) => [r.pin_id, r.formula_v1, r.formula]), [["a", "other", "jeans+knit+shirt"], ["c", "jeans+tee+sneaker", "other"]]);
  assert.deepEqual(assignAll([]), []);
  assert.deepEqual(assignAll(undefined), []);
});
