import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES, SUBCATEGORIES, ALL_SUBCATEGORIES, SUBCATEGORY_TO_CATEGORY, COLOURS, NEUTRALS, PATTERNS, FABRICS,
  FORMALITY, FORMALITY_LEVELS, SEASONS, WARMTH, FORMULAS, FORMULA_IDS, SILHOUETTES, OCCASIONS,
  garmentSchema, tagSchema, validateTag, DOMAIN, PROMPT_VERSION, TAG_PROMPT, TAG_PROMPT_FASHION_V1,
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
