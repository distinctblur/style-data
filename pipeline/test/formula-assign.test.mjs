import { test } from "node:test";
import assert from "node:assert/strict";
import { assignFormula, assignAll, matchFormula, impliedBase, MIN_SCORE, OPTIONAL_WEIGHT, ASSUMED_BASE, BASE_CATEGORIES } from "../formula-assign.mjs";
import { FORMULAS_V2, FORMULA_V2_IDS, SUBCATEGORY_TO_CATEGORY } from "../taxonomies/fashion.mjs";

const byId = Object.fromEntries(FORMULAS_V2.map((f) => [f.id, f]));

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
    // Plain pairs (§8 decision 1): base + one layer, nothing finishing it.
    [g("jeans", "t-shirt"), "jeans+tee"],
    [g("jeans", "tank", "sneaker"), "jeans+tee"],
    [g("jeans", "knit-sweater", "flat"), "jeans+knit"],
    [g("jeans", "cardigan"), "jeans+knit"],
    // A tee under a knit with no accessory is still the plain knit pair.
    [g("jeans", "knit-sweater", "t-shirt", "sneaker"), "jeans+knit"],
  ];
  for (const [garments, expected] of cases) {
    const r = assignFormula(garments);
    assert.equal(r.formula, expected, `${garments.map((x) => x.subcategory).join(",")} -> ${r.formula}`);
    assert.deepEqual(r.missing_required, []);
    assert.ok(r.score >= MIN_SCORE);
    assert.ok(r.matched_slots.length >= 1);
    assert.equal(r.assumed_base, null, "a visible base is never assumed");
  }
});

test("plain pairs (decision 1): a pin with an accessory still prefers the richer three-slot formula", () => {
  // Nothing finishing the look: the pair, at exactly its two required slots.
  const plain = assignFormula(g("jeans", "t-shirt"));
  assert.deepEqual([plain.formula, plain.score, plain.matched_slots], ["jeans+tee", 2, ["base", "top"]]);
  // Each accessory in jeans+tee+sunglasses's slot lifts the look out of the pair.
  for (const acc of ["sunglasses", "scarf", "necklace", "belt", "bracelet", "hat"]) {
    const r = assignFormula(g("jeans", "t-shirt", acc));
    assert.equal(r.formula, "jeans+tee+sunglasses", `jeans,t-shirt,${acc} -> ${r.formula}`);
    assert.equal(r.score, 3);
  }
  // Same for the knit pair: jewelry / scarf / a collared shirt each name a richer formula.
  assert.equal(assignFormula(g("jeans", "knit-sweater", "necklace")).formula, "jeans+knit+necklace");
  assert.equal(assignFormula(g("jeans", "cardigan", "watch")).formula, "jeans+knit+necklace");
  assert.equal(assignFormula(g("jeans", "knit-sweater", "scarf")).formula, "jeans+knit+scarf");
  assert.equal(assignFormula(g("jeans", "knit-sweater", "shirt")).formula, "jeans+knit+shirt");
  assert.equal(assignFormula(g("jeans", "cardigan", "tank")).formula, "jeans+cardigan+tee");
  // The pair's optionals (outerwear, shoes) do not let it outscore a richer formula.
  assert.equal(assignFormula(g("jeans", "t-shirt", "denim-jacket", "sneaker")).formula, "jeans+tee", "layer + shoe but no accessory stays the pair");
  assert.equal(assignFormula(g("jeans", "t-shirt", "denim-jacket", "sneaker", "sunglasses")).formula, "jeans+tee+sunglasses");
  // Exact tie on score (3.0 each: the scarf formula gets no optional since sneakers are not boots,
  // the pair gets both of its optionals from the blouse and the sneaker): more slots wins.
  const tie = g("jeans", "cardigan", "scarf", "blouse", "sneaker");
  assert.equal(matchFormula(byId["jeans+knit+scarf"], tie).score, 3);
  assert.equal(matchFormula(byId["jeans+knit"], tie).score, 3);
  for (const id of ["jeans+cardigan+tee", "jeans+knit+shirt", "jeans+knit+necklace", "jeans+shirt+belt", "jeans+tee+sunglasses", "jeans+blazer+tee"]) {
    assert.ok(matchFormula(byId[id], tie).missingRequired.length > 0, `${id} is not a candidate for the tie case`);
  }
  assert.ok(byId["jeans+knit+scarf"].slots.length > byId["jeans+knit"].slots.length);
  assert.equal(assignFormula(tie).formula, "jeans+knit+scarf");
  // Every three-slot jeans formula has more slots than either pair, so no tie can go to a pair.
  for (const id of ["jeans+cardigan+tee", "jeans+knit+shirt", "jeans+knit+scarf", "jeans+knit+necklace", "jeans+blazer+tee", "jeans+shirt+belt", "jeans+tee+sunglasses"]) {
    for (const pair of ["jeans+tee", "jeans+knit"]) assert.ok(byId[id].slots.length > byId[pair].slots.length, `${id} vs ${pair}`);
  }
});

test("top-half crops (decision 2): a top with no bottom / dress / swim gets an implied jeans base, reported as assumed_base", () => {
  assert.equal(ASSUMED_BASE, "jeans");
  assert.deepEqual(BASE_CATEGORIES, ["bottom", "dress", "swim"]);
  // impliedBase on its own.
  assert.equal(impliedBase(g("t-shirt", "necklace")), "jeans");
  assert.equal(impliedBase(["knit-sweater", "shirt"]), "jeans", "bare subcategory strings");
  assert.equal(impliedBase(g("blazer", "tank", "sunglasses")), "jeans", "outerwear is not a base");
  assert.equal(impliedBase(g("t-shirt", "shorts")), null, "a bottom is visible");
  assert.equal(impliedBase(g("knit-sweater", "mini-skirt")), null);
  assert.equal(impliedBase(g("maxi-dress")), null, "a dress is its own base");
  assert.equal(impliedBase(g("t-shirt", "midi-dress")), null);
  assert.equal(impliedBase(g("bikini", "t-shirt")), null, "swim is a base");
  assert.equal(impliedBase(g("necklace", "sunglasses")), null, "no top, nothing to hang jeans under");
  assert.equal(impliedBase(g("activewear")), null, "category other is not a top");
  assert.equal(impliedBase([]), null);
  assert.equal(impliedBase(null), null);
  assert.equal(impliedBase([{ category: "top" }]), "jeans", "category alone is enough");
  // The residual crops from the proposal (§4.1) now match whole-look formulas.
  const cases = [
    [g("t-shirt", "necklace"), "jeans+tee+sunglasses"],
    [g("tank", "sunglasses"), "jeans+tee+sunglasses"],
    [g("knit-sweater", "shirt", "necklace", "watch"), "jeans+knit+shirt"],
    [g("cardigan", "shirt"), "jeans+knit"],
    [g("t-shirt"), "jeans+tee"],
    [g("blazer", "tank", "necklace"), "jeans+blazer+tee"],
    [g("shirt", "belt"), "jeans+shirt+belt"],
  ];
  for (const [garments, expected] of cases) {
    const r = assignFormula(garments);
    assert.equal(r.formula, expected, `${garments.map((x) => x.subcategory).join(",")} -> ${r.formula}`);
    assert.equal(r.assumed_base, "jeans");
    assert.ok(r.matched_slots.includes("base"), "the implied jeans filled the base slot");
  }
  // The assumption is reported even when the look still ends up `other`.
  const o = assignFormula(g("blouse", "earrings"));
  assert.equal(o.formula, "other");
  assert.equal(o.assumed_base, "jeans");
  // And it can be switched off: the same crop is then `other` with no base.
  const off = assignFormula(g("knit-sweater", "shirt", "necklace"), FORMULAS_V2, { assumeBase: false });
  assert.equal(off.formula, "other");
  assert.equal(off.assumed_base, null);
  // Pins with a visible base, a dress, swim or no top carry assumed_base: null.
  for (const gs of [g("jeans", "t-shirt"), g("maxi-dress"), g("bikini", "hat"), g("necklace"), g("midi-dress", "t-shirt", "boot")]) {
    assert.equal(assignFormula(gs).assumed_base, null, gs.map((x) => x.subcategory).join(","));
  }
  // assignAll carries it per row.
  const rows = assignAll([{ pin_id: "crop", tag: { formula: "other", garments: g("t-shirt", "necklace") } }, { pin_id: "full", tag: { formula: "other", garments: g("jeans", "t-shirt") } }]);
  assert.deepEqual(rows.map((r) => [r.pin_id, r.formula, r.assumed_base]), [["crop", "jeans+tee+sunglasses", "jeans"], ["full", "jeans+tee", null]]);
  assert.equal(assignAll(rows.map((r) => ({ pin_id: r.pin_id, tag: { garments: g("t-shirt") } })), { assumeBase: false })[0].formula, "other");
});

test("dress alone (decision 3): the threshold stays, a dress with no second piece is `other`", () => {
  for (const dress of ["mini-dress", "midi-dress", "maxi-dress", "slip-dress", "shirt-dress", "wrap-dress", "knit-dress"]) {
    const r = assignFormula(g(dress));
    assert.equal(r.formula, "other", `${dress} alone -> ${r.formula}`);
    assert.equal(r.score, 1, "scores the dress base only, below MIN_SCORE");
    assert.match(r.nearest, /^dress\+/, "the nearest miss is a dress formula (all three score 1; list order picks dress+cardigan)");
    assert.equal(r.assumed_base, null, "a dress is a base; nothing is implied under it");
  }
  // One more piece is enough: necklace, sandal or sunglasses each fill an optional slot.
  assert.equal(assignFormula(g("maxi-dress", "necklace")).formula, "dress+necklace+sandal");
  assert.equal(assignFormula(g("slip-dress", "sandal")).formula, "dress+necklace+sandal");
  assert.equal(assignFormula(g("midi-dress", "sunglasses")).score, MIN_SCORE);
  // A dress with a tote only is still alone as far as the formula is concerned.
  assert.equal(assignFormula(g("midi-dress", "tote")).formula, "other");
});

test("a missing required slot or a score below the threshold is `other`, with the nearest miss explained", () => {
  // jeans + blazer but nothing underneath: jeans+blazer+tee needs `under`.
  const r = assignFormula(g("jeans", "blazer", "tote"));
  assert.equal(r.formula, "other");
  assert.equal(r.nearest, "jeans+blazer+tee");
  assert.deepEqual(r.missing_required, ["under"], "explains what the nearest formula lacked");
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
  assert.deepEqual(Object.keys(a), ["formula", "score", "matched_slots", "missing_required", "assumed_base"]);
  assert.ok(FORMULA_V2_IDS.includes(a.formula));
  const o = assignFormula([]);
  assert.deepEqual(Object.keys(o), ["formula", "score", "matched_slots", "missing_required", "nearest", "assumed_base"]);
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
