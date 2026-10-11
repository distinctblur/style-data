import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOMAIN, PROMPT_VERSION, TAG_PROMPT, TAG_PROMPT_HOME_V1,
  ROOMS, ITEM_TYPES, MATERIALS, COLOURS, NEUTRALS, STYLES, PALETTE_MOODS, ERAS,
  STYLES_MIN, STYLES_MAX, VIBE_KEYWORDS_MIN, VIBE_KEYWORDS_MAX, MAX_ITEMS,
  itemSchema, tagSchema, validateTag,
} from "../taxonomies/home.mjs";

const unique = (xs) => new Set(xs).size === xs.length;

function goodTag() {
  return {
    is_interior: true,
    room: "living",
    items: [
      { type: "sofa", material: "boucle", colour: "cream", style: "contemporary" },
      { type: "coffee-table", material: "oak", colour: "light-blue", style: "scandinavian" },
      { type: "rug", material: "jute", colour: "sand", style: "coastal" },
      { type: "pendant-light", material: "brass", colour: "warm-white", style: "mid-century" },
    ],
    styles: ["scandinavian", "coastal"],
    palette_mood: "warm-neutral",
    era: "contemporary",
    vibe_keywords: ["airy", "textured", "calm"],
    confidence: 0.85,
  };
}

test("home domain identity and versioned prompt", () => {
  assert.equal(DOMAIN, "home");
  assert.equal(PROMPT_VERSION, "home.tag.v1");
  assert.equal(TAG_PROMPT, TAG_PROMPT_HOME_V1);
});

test("vocabularies are unique lowercase slugs, sized as briefed, with the required sentinels", () => {
  for (const [name, xs] of Object.entries({ ROOMS, ITEM_TYPES, MATERIALS, COLOURS, STYLES, PALETTE_MOODS, ERAS })) {
    assert.ok(unique(xs), `${name} has duplicates`);
    assert.ok(xs.every((v) => typeof v === "string" && v === v.toLowerCase() && !/\s/.test(v)), `${name} values must be lowercase slugs`);
  }
  assert.ok(ROOMS.length >= 14 && ROOMS.includes("other"));
  for (const r of ["living", "kitchen", "dining", "bedroom", "kids-bedroom", "nursery", "bathroom", "entry", "office", "laundry", "outdoor-patio", "garden", "hallway"]) {
    assert.ok(ROOMS.includes(r), `room ${r} missing`);
  }
  assert.ok(ITEM_TYPES.length >= 40 && ITEM_TYPES.includes("other"));
  for (const t of ["sofa", "armchair", "coffee-table", "bed", "rug", "pendant-light", "kitchen-island", "backsplash", "bathtub", "vanity", "tile", "flooring", "wallpaper", "paint", "fireplace"]) {
    assert.ok(ITEM_TYPES.includes(t), `item type ${t} missing`);
  }
  assert.ok(MATERIALS.length >= 18 && MATERIALS.includes("unknown"));
  for (const m of ["oak", "walnut", "rattan", "cane", "linen", "boucle", "marble", "terrazzo", "brass", "black-metal", "concrete"]) {
    assert.ok(MATERIALS.includes(m), `material ${m} missing`);
  }
  assert.ok(COLOURS.length >= 20 && COLOURS.includes("multi"));
  for (const n of NEUTRALS) assert.ok(COLOURS.includes(n), `neutral ${n} missing from COLOURS`);
  assert.ok(STYLES.length >= 16 && STYLES.includes("other"));
  for (const s of ["scandinavian", "mid-century", "japandi", "minimalist", "modern-farmhouse", "boho", "industrial", "art-deco", "mediterranean", "french-country", "eclectic", "contemporary"]) {
    assert.ok(STYLES.includes(s), `style ${s} missing`);
  }
  assert.deepEqual(PALETTE_MOODS, ["warm-neutral", "cool-neutral", "dark-moody", "bright-airy", "earthy", "colourful", "monochrome"]);
  assert.deepEqual(ERAS, ["contemporary", "vintage", "antique", "mixed", "unknown"]);
  assert.ok(STYLES_MIN >= 1 && STYLES_MAX >= STYLES_MIN);
  assert.ok(VIBE_KEYWORDS_MIN >= 1 && VIBE_KEYWORDS_MAX >= VIBE_KEYWORDS_MIN);
  assert.ok(MAX_ITEMS >= 10);
});

test("schema enums equal the data and the tag keys are the aggregate contract", () => {
  const p = itemSchema.properties;
  assert.deepEqual(p.type.enum, [...ITEM_TYPES]);
  assert.deepEqual(p.material.enum, [...MATERIALS]);
  assert.deepEqual(p.colour.enum, [...COLOURS]);
  assert.deepEqual(p.style.enum, [...STYLES]);
  assert.deepEqual(itemSchema.required, Object.keys(p));
  assert.deepEqual(itemSchema.propertyOrdering, Object.keys(p));

  const t = tagSchema.properties;
  assert.deepEqual(Object.keys(t), ["is_interior", "room", "items", "styles", "palette_mood", "era", "vibe_keywords", "confidence"]);
  assert.equal(t.is_interior.type, "BOOLEAN");
  assert.deepEqual(t.room.enum, [...ROOMS]);
  assert.equal(t.items.items, itemSchema);
  assert.deepEqual(t.styles.items.enum, [...STYLES]);
  assert.deepEqual(t.palette_mood.enum, [...PALETTE_MOODS]);
  assert.deepEqual(t.era.enum, [...ERAS]);
  assert.equal(t.vibe_keywords.items.type, "STRING");
  assert.deepEqual(t.confidence, { ...t.confidence, type: "NUMBER", minimum: 0, maximum: 1 });
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

test("TAG_PROMPT_HOME_V1 lists every enum and the non-interior rule", () => {
  assert.match(TAG_PROMPT, /set is_interior=false and still tag visible items/);
  assert.match(TAG_PROMPT, /interior stylist/);
  assert.match(TAG_PROMPT, /prefer 'unknown' over a guess/);
  for (const [name, xs] of Object.entries({ ROOMS, ITEM_TYPES, MATERIALS, COLOURS, STYLES, PALETTE_MOODS, ERAS })) {
    for (const v of xs) assert.ok(TAG_PROMPT.includes(v), `prompt lacks ${name} value ${v}`);
  }
  assert.ok(TAG_PROMPT.includes(`${STYLES_MIN}-${STYLES_MAX} labels`));
  assert.ok(TAG_PROMPT.includes(`${VIBE_KEYWORDS_MIN}-${VIBE_KEYWORDS_MAX} short lowercase words`));
});

test("validateTag accepts a good tag, a non-interior tag with no items, and one style over the target", () => {
  assert.deepEqual(validateTag(goodTag()), { ok: true, errors: [] });
  const product = { ...goodTag(), is_interior: false, room: "other", items: [goodTag().items[0]] };
  assert.equal(validateTag(product).ok, true);
  const empty = { ...goodTag(), is_interior: false, items: [] };
  assert.equal(validateTag(empty).ok, true);
  const four = { ...goodTag(), styles: ["scandinavian", "coastal", "japandi", "minimalist"] };
  assert.equal(validateTag(four).ok, true, "one over STYLES_MAX is tolerated");
});

test("validateTag rejects bad enums, ranges, shapes and missing fields", () => {
  const cases = [
    ["not an object", null, /not an object/],
    ["array", [], /not an object/],
    ["missing field", (() => { const t = goodTag(); delete t.palette_mood; return t; })(), /missing field: palette_mood/],
    ["is_interior string", { ...goodTag(), is_interior: "yes" }, /is_interior must be a boolean/],
    ["bad room", { ...goodTag(), room: "attic" }, /room invalid: attic/],
    ["items not array", { ...goodTag(), items: {} }, /items must be an array/],
    ["too many items", { ...goodTag(), items: Array.from({ length: MAX_ITEMS + 1 }, () => goodTag().items[0]) }, /items has more than/],
    ["item not object", { ...goodTag(), items: ["sofa"] }, /items\[0\] is not an object/],
    ["item missing field", (() => { const t = goodTag(); delete t.items[1].material; return t; })(), /items\[1\] missing field: material/],
    ["bad item type", (() => { const t = goodTag(); t.items[0].type = "hammock"; return t; })(), /items\[0\]\.type invalid: hammock/],
    ["bad material", (() => { const t = goodTag(); t.items[0].material = "plastic"; return t; })(), /items\[0\]\.material invalid: plastic/],
    ["bad colour", (() => { const t = goodTag(); t.items[2].colour = "neon"; return t; })(), /items\[2\]\.colour invalid: neon/],
    ["bad item style", (() => { const t = goodTag(); t.items[0].style = "gothic"; return t; })(), /items\[0\]\.style invalid: gothic/],
    ["styles not array", { ...goodTag(), styles: "coastal" }, /styles must be an array/],
    ["empty styles", { ...goodTag(), styles: [] }, /styles is empty/],
    ["too many styles", { ...goodTag(), styles: ["scandinavian", "coastal", "japandi", "minimalist", "boho"] }, /styles has more than/],
    ["bad style", { ...goodTag(), styles: ["gothic"] }, /styles\[0\] invalid: gothic/],
    ["duplicate styles", { ...goodTag(), styles: ["coastal", "coastal"] }, /styles has duplicates/],
    ["bad palette_mood", { ...goodTag(), palette_mood: "loud" }, /palette_mood invalid: loud/],
    ["bad era", { ...goodTag(), era: "futuristic" }, /era invalid: futuristic/],
    ["empty vibes", { ...goodTag(), vibe_keywords: [] }, /vibe_keywords is empty/],
    ["uppercase vibe", { ...goodTag(), vibe_keywords: ["Airy", "calm", "warm"] }, /must be lowercase/],
    ["blank vibe", { ...goodTag(), vibe_keywords: ["airy", " "] }, /must be a non-empty string/],
    ["confidence > 1", { ...goodTag(), confidence: 1.2 }, /confidence must be a number 0-1/],
    ["confidence NaN", { ...goodTag(), confidence: NaN }, /confidence must be a number 0-1/],
  ];
  for (const [name, tag, re] of cases) {
    const v = validateTag(tag);
    assert.equal(v.ok, false, `${name} should be rejected`);
    assert.ok(v.errors.some((e) => re.test(e)), `${name}: expected /${re.source}/ in ${JSON.stringify(v.errors)}`);
  }
});
