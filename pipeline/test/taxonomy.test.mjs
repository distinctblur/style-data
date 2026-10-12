import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES, SUBCATEGORIES, ALL_SUBCATEGORIES, SUBCATEGORY_TO_CATEGORY, COLOURS, NEUTRALS, PATTERNS, FABRICS,
  FORMALITY, FORMALITY_LEVELS, SEASONS, WARMTH, FORMULAS, FORMULA_IDS, SILHOUETTES, OCCASIONS,
  garmentSchema, tagSchema, validateTag, DOMAIN, PROMPT_VERSION, TAG_PROMPT, TAG_PROMPT_FASHION_V1,
  FORMULAS_V2, FORMULA_V2_IDS, FORMULA_V2_LINES, describeFormulaV2, tagSchemaV2, validateTagV2, TAG_PROMPT_FASHION_V2, PROMPT_VERSION_V2, VERSIONS,
} from "../taxonomies/fashion.mjs";
import { DOMAINS, DOMAIN_NAMES, getDomain } from "../taxonomies/index.mjs";

const unique = (xs) => new Set(xs).size === xs.length;

function goodTag() {
  return {
    is_outfit: true,
    garments: [
      { category: "outerwear", subcategory: "blazer", colour: "camel", pattern: "solid", fabric: "wool" },
      { category: "bottom", subcategory: "wide-leg-trouser", colour: "cream", pattern: "solid", fabric: "linen" },
      { category: "shoes", subcategory: "loafer", colour: "tan", pattern: "solid", fabric: "leather" },
    ],
    formula: "blazer+wide-leg-trouser+loafer",
    silhouette: "slim-top-wide-bottom",
    formality: 3,
    season: "autumn",
    occasion: "work",
    vibe_keywords: ["tailored", "minimal", "polished"],
    confidence: 0.9,
  };
}

test("every subcategory maps to exactly one category, names unique", () => {
  assert.deepEqual(Object.keys(SUBCATEGORIES), [...CATEGORIES]);
  assert.ok(unique(CATEGORIES));
  assert.ok(unique(ALL_SUBCATEGORIES), "subcategory names must be unique across categories");
  for (const c of CATEGORIES) {
    assert.ok(SUBCATEGORIES[c].length >= 4, `${c} has too few subcategories`);
    for (const s of SUBCATEGORIES[c]) assert.equal(SUBCATEGORY_TO_CATEGORY[s], c);
  }
  assert.equal(Object.keys(SUBCATEGORY_TO_CATEGORY).length, ALL_SUBCATEGORIES.length);
  for (const s of ["one-piece", "bikini", "cover-up", "sarong"]) assert.equal(SUBCATEGORY_TO_CATEGORY[s], "swim");
});

test("vocabularies are unique and sized as briefed", () => {
  for (const [name, xs] of Object.entries({ COLOURS, PATTERNS, FABRICS, SEASONS, WARMTH, SILHOUETTES, OCCASIONS, FORMULA_IDS })) {
    assert.ok(unique(xs), `${name} has duplicates`);
    assert.ok(xs.every((v) => typeof v === "string" && v === v.toLowerCase() && !/\s/.test(v)), `${name} values must be lowercase slugs`);
  }
  assert.ok(COLOURS.length >= 24);
  for (const n of NEUTRALS) assert.ok(COLOURS.includes(n), `neutral ${n} missing from COLOURS`);
  assert.ok(SILHOUETTES.length >= 10);
  assert.deepEqual(FORMALITY_LEVELS, [1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(FORMALITY).map(Number), FORMALITY_LEVELS);
});

test("formulas include the brief's three, 'other', and only known slot names", () => {
  for (const id of ["blazer+wide-leg-trouser+loafer", "midi-skirt+fitted-top", "knit+trouser+loafer", "other"]) {
    assert.ok(FORMULA_IDS.includes(id), `missing formula ${id}`);
  }
  assert.ok(FORMULAS.length >= 15);
  const known = new Set([...CATEGORIES, ...ALL_SUBCATEGORIES]);
  for (const f of FORMULAS) for (const slot of f.slots) assert.ok(known.has(slot), `${f.id}: unknown slot ${slot}`);
});

test("schema enums equal the data", () => {
  const p = garmentSchema.properties;
  assert.deepEqual(p.category.enum, [...CATEGORIES]);
  assert.deepEqual(p.subcategory.enum, [...ALL_SUBCATEGORIES]);
  assert.deepEqual(p.colour.enum, [...COLOURS]);
  assert.deepEqual(p.pattern.enum, [...PATTERNS]);
  assert.deepEqual(p.fabric.enum, [...FABRICS]);
  assert.deepEqual(garmentSchema.required, Object.keys(p));

  const t = tagSchema.properties;
  assert.deepEqual(t.formula.enum, [...FORMULA_IDS]);
  assert.deepEqual(t.silhouette.enum, [...SILHOUETTES]);
  assert.deepEqual(t.season.enum, [...SEASONS]);
  assert.deepEqual(t.occasion.enum, [...OCCASIONS]);
  assert.equal(t.garments.items, garmentSchema);
  assert.deepEqual(t.formality, { ...t.formality, type: "INTEGER", minimum: 1, maximum: 5 });
  assert.deepEqual(tagSchema.required.slice().sort(), Object.keys(t).sort());
  assert.deepEqual(tagSchema.propertyOrdering, Object.keys(t));
  // Gemini schema subset: only upper-case type names.
  const walk = (s) => {
    assert.match(s.type, /^(OBJECT|ARRAY|STRING|NUMBER|INTEGER|BOOLEAN)$/);
    if (s.properties) Object.values(s.properties).forEach(walk);
    if (s.items) walk(s.items);
  };
  walk(tagSchema);
});

test("validateTag accepts a good tag", () => {
  assert.deepEqual(validateTag(goodTag()), { ok: true, errors: [] });
  const minimal = { ...goodTag(), is_outfit: false, garments: [] };
  assert.equal(validateTag(minimal).ok, true);
});

test("validateTag rejects bad enums, ranges and missing fields", () => {
  const cases = [
    ["not an object", null, /not an object/],
    ["missing field", (() => { const t = goodTag(); delete t.formula; return t; })(), /missing field: formula/],
    ["bad colour", (() => { const t = goodTag(); t.garments[0].colour = "neon"; return t; })(), /colour invalid: neon/],
    ["bad subcategory", (() => { const t = goodTag(); t.garments[0].subcategory = "hoodie"; return t; })(), /subcategory invalid: hoodie/],
    ["subcategory/category mismatch", (() => { const t = goodTag(); t.garments[0].category = "shoes"; return t; })(), /does not belong to category 'shoes'/],
    ["bad formula", { ...goodTag(), formula: "jeans+jeans" }, /formula invalid/],
    ["bad silhouette", { ...goodTag(), silhouette: "wavy" }, /silhouette invalid/],
    ["formality out of range", { ...goodTag(), formality: 6 }, /formality must be an integer 1-5/],
    ["formality not integer", { ...goodTag(), formality: 2.5 }, /formality must be an integer 1-5/],
    ["bad season", { ...goodTag(), season: "monsoon" }, /season invalid/],
    ["bad occasion", { ...goodTag(), occasion: "funeral" }, /occasion invalid/],
    ["empty vibes", { ...goodTag(), vibe_keywords: [] }, /vibe_keywords is empty/],
    ["uppercase vibe", { ...goodTag(), vibe_keywords: ["Minimal", "coastal", "tailored"] }, /must be lowercase/],
    ["confidence > 1", { ...goodTag(), confidence: 1.2 }, /confidence must be a number 0-1/],
    ["is_outfit string", { ...goodTag(), is_outfit: "yes" }, /is_outfit must be a boolean/],
    ["garment missing field", (() => { const t = goodTag(); delete t.garments[1].fabric; return t; })(), /garments\[1\] missing field: fabric/],
  ];
  for (const [name, tag, re] of cases) {
    const v = validateTag(tag);
    assert.equal(v.ok, false, `${name} should be rejected`);
    assert.ok(v.errors.some((e) => re.test(e)), `${name}: expected /${re.source}/ in ${JSON.stringify(v.errors)}`);
  }
});

test("fashion module exposes the domain interface and its versioned prompt", () => {
  assert.equal(DOMAIN, "fashion");
  assert.equal(PROMPT_VERSION, "fashion.tag.v1");
  assert.equal(TAG_PROMPT, TAG_PROMPT_FASHION_V1);
  assert.match(TAG_PROMPT, /set is_outfit=false and still tag visible garments/);
  for (const c of COLOURS) assert.ok(TAG_PROMPT.includes(c), `prompt lacks colour ${c}`);
  for (const f of FORMULA_IDS) assert.ok(TAG_PROMPT.includes(f), `prompt lacks formula ${f}`);
});

test("domain registry: every domain exports the same interface; unknown names throw", () => {
  assert.deepEqual(DOMAIN_NAMES, ["fashion", "home"]);
  for (const name of DOMAIN_NAMES) {
    const d = getDomain(name);
    assert.equal(d, DOMAINS[name]);
    assert.equal(d.DOMAIN, name);
    assert.equal(d.PROMPT_VERSION, `${name}.tag.v1`);
    assert.equal(typeof d.TAG_PROMPT, "string");
    assert.ok(d.TAG_PROMPT.length > 500);
    assert.equal(d.tagSchema.type, "OBJECT");
    assert.equal(typeof d.validateTag, "function");
    assert.equal(d.validateTag(null).ok, false);
  }
  assert.throws(() => getDomain("garden"), /unknown domain 'garden' \(known: fashion, home\)/);
  assert.throws(() => getDomain(undefined), /unknown domain/);
});

// --- v2 formulas (docs/formula-v2-proposal.md) ---------------------------------------

test("FORMULAS_V2: ids unique, 14-22 formulas plus 'other', the brief's three kept, slots well-formed over known ids", () => {
  assert.ok(unique(FORMULA_V2_IDS), "v2 ids must be unique");
  assert.ok(FORMULA_V2_IDS.includes("other"));
  assert.equal(FORMULAS_V2.at(-1).id, "other", "'other' is last so list-order tie-breaks never pick it");
  const real = FORMULAS_V2.filter((f) => f.id !== "other");
  assert.ok(real.length >= 14 && real.length <= 22, `expected 14-22 formulas, got ${real.length}`);
  for (const id of ["blazer+wide-leg-trouser+loafer", "midi-skirt+fitted-top", "knit+trouser+loafer", "athleisure"]) {
    assert.ok(FORMULA_V2_IDS.includes(id), `v2 must keep ${id}`);
  }
  const known = new Set([...CATEGORIES, ...ALL_SUBCATEGORIES]);
  for (const f of real) {
    assert.match(f.id, /^[a-z0-9+-]+$/, `${f.id}: id must be a lowercase slug`);
    assert.ok(f.slots.length >= 1 && f.slots.length <= 5, `${f.id}: 1-5 slots`);
    assert.ok(f.slots.some((sl) => sl.required), `${f.id}: at least one required slot`);
    assert.ok(unique(f.slots.map((sl) => sl.name)), `${f.id}: slot names unique`);
    for (const sl of f.slots) {
      assert.equal(typeof sl.name, "string");
      assert.equal(typeof sl.required, "boolean");
      assert.ok(Array.isArray(sl.any) && sl.any.length >= 1, `${f.id}.${sl.name}: any[] non-empty`);
      assert.ok(unique(sl.any), `${f.id}.${sl.name}: duplicate ids`);
      for (const id of sl.any) assert.ok(known.has(id), `${f.id}.${sl.name}: unknown id ${id}`);
    }
  }
  assert.ok(Object.isFrozen(FORMULAS_V2) && Object.isFrozen(FORMULAS_V2[0].slots[0].any));
  // Every v2 formula is readable in one line for the prompt and the proposal.
  assert.equal(FORMULA_V2_LINES.length, FORMULAS_V2.length);
  assert.match(describeFormulaV2(FORMULAS_V2[0]), /^[a-z0-9+-]+ = .+ \(\+ .+\)$/);
  assert.equal(describeFormulaV2(FORMULAS_V2.at(-1)), "other = none of the above");
});

test("v2 schema, prompt and version: enum = v2 ids, prompt names every v2 id and the layering rule, v1 untouched", () => {
  assert.deepEqual(tagSchemaV2.properties.formula.enum, [...FORMULA_V2_IDS]);
  assert.deepEqual(tagSchema.properties.formula.enum, [...FORMULA_IDS], "v1 schema keeps the v1 enum");
  assert.equal(tagSchemaV2.properties.garments.items, garmentSchema);
  const { formula: f2, ...restV2 } = tagSchemaV2.properties;
  const { formula: f1, ...restV1 } = tagSchema.properties;
  assert.deepEqual(restV2, restV1, "v2 differs from v1 only in the formula enum");
  assert.equal(PROMPT_VERSION_V2, "fashion.tag.v2");
  assert.equal(PROMPT_VERSION, "fashion.tag.v1", "the default stays v1 until the review");
  assert.equal(TAG_PROMPT, TAG_PROMPT_FASHION_V1);
  for (const id of FORMULA_V2_IDS) assert.ok(TAG_PROMPT_FASHION_V2.includes(id), `v2 prompt lacks ${id}`);
  for (const line of FORMULA_V2_LINES) assert.ok(TAG_PROMPT_FASHION_V2.includes(line), `v2 prompt lacks slot line ${line}`);
  assert.match(TAG_PROMPT_FASHION_V2, /Layering accessories count toward the formula/);
  assert.match(TAG_PROMPT_FASHION_V2, /set is_outfit=false and still tag visible garments/);
  for (const c of COLOURS) assert.ok(TAG_PROMPT_FASHION_V2.includes(c), `v2 prompt lacks colour ${c}`);
  // v1-only ids are not offered by the v2 prompt's formula list.
  const v2FormulaBlock = TAG_PROMPT_FASHION_V2.slice(TAG_PROMPT_FASHION_V2.indexOf("- formula:"), TAG_PROMPT_FASHION_V2.indexOf("- silhouette:"));
  for (const id of ["jeans+tee+sneaker", "tonal-monochrome", "matching-set"]) assert.ok(!v2FormulaBlock.includes(`${id} =`), `v2 prompt still lists ${id}`);
  assert.deepEqual(Object.keys(VERSIONS), ["v1", "v2"]);
  assert.equal(VERSIONS.v1.TAG_PROMPT, TAG_PROMPT_FASHION_V1);
  assert.equal(VERSIONS.v1.tagSchema, tagSchema);
  assert.equal(VERSIONS.v2.PROMPT_VERSION, PROMPT_VERSION_V2);
  assert.equal(VERSIONS.v2.tagSchema, tagSchemaV2);
  assert.deepEqual(VERSIONS.v2.FORMULA_IDS, FORMULA_V2_IDS);
});

test("validateTag accepts v2 ids only under version v2; validateTagV2 is that shortcut", () => {
  const v2 = { ...goodTag(), formula: "jeans+cardigan+tee" };
  assert.equal(validateTag(v2).ok, false, "a v2 id is not a v1 id");
  assert.deepEqual(validateTag(v2, { version: "v2" }), { ok: true, errors: [] });
  assert.deepEqual(validateTagV2(v2), { ok: true, errors: [] });
  assert.equal(VERSIONS.v2.validateTag(v2).ok, true);
  const v1Only = { ...goodTag(), formula: "jeans+tee+sneaker" };
  assert.equal(validateTag(v1Only).ok, true);
  assert.ok(validateTagV2(v1Only).errors.some((e) => /formula invalid: jeans\+tee\+sneaker/.test(e)));
  assert.equal(validateTagV2(goodTag()).ok, true, "the brief's blazer formula is kept in v2");
  assert.equal(validateTagV2({ ...goodTag(), formula: "other" }).ok, true);
  assert.throws(() => validateTag(goodTag(), { version: "v9" }), /unknown version 'v9'/);
  // Everything else is validated the same way under v2.
  assert.ok(validateTagV2({ ...v2, formality: 7 }).errors.some((e) => /formality/.test(e)));
});
