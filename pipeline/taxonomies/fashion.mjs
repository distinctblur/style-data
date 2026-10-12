// style-data fashion taxonomy — the vocabulary, Gemini response schema, prompt and
// validator for `fashion` pins (ADR-0001 #4: one tagger, per-domain taxonomy).
// Atelier's `packages/shared` taxonomy is a verbatim copy of this file and must
// not drift from it (style-data CLAUDE.md). Brief §5: "Taxonomy fixed in code so
// Gemini tagging output is schema-validated — no free-text tag drift."
//
// Plain data only, no imports, no runtime deps. Every domain module exports the
// same interface (see ./index.mjs):
//   DOMAIN, PROMPT_VERSION, TAG_PROMPT (= TAG_PROMPT_FASHION_V1 here),
//   tagSchema — the vocabularies in Gemini `responseSchema` (OpenAPI-subset)
//   form, derived from the data so they cannot drift,
//   validateTag(obj) -> {ok, errors[]} — enum/shape enforcement without a
//   schema library,
// plus the vocabularies themselves (CATEGORIES, SUBCATEGORIES, COLOURS, ...).

// --- Garments ---------------------------------------------------------------

export const CATEGORIES = Object.freeze([
  "top", "bottom", "dress", "outerwear", "shoes", "bag", "jewelry", "swim", "accessory", "other",
]);

/** category -> subcategories. Every subcategory name is unique across categories. */
export const SUBCATEGORIES = Object.freeze({
  top: ["t-shirt", "tank", "blouse", "shirt", "knit-sweater", "cardigan", "sweatshirt", "bodysuit", "crop-top", "vest"],
  bottom: ["jeans", "trouser", "wide-leg-trouser", "shorts", "mini-skirt", "midi-skirt", "maxi-skirt", "leggings", "culottes"],
  dress: ["mini-dress", "midi-dress", "maxi-dress", "slip-dress", "shirt-dress", "wrap-dress", "knit-dress", "jumpsuit", "romper"],
  outerwear: ["blazer", "coat", "trench", "leather-jacket", "denim-jacket", "puffer", "bomber", "utility-jacket", "cape", "gilet"],
  shoes: ["loafer", "sneaker", "heel", "flat", "boot", "ankle-boot", "sandal", "mule", "slide", "espadrille"],
  bag: ["tote", "shoulder-bag", "crossbody", "clutch", "bucket-bag", "mini-bag", "backpack", "basket"],
  jewelry: ["necklace", "earrings", "bracelet", "ring", "watch", "brooch", "anklet"],
  swim: ["one-piece", "bikini", "tankini", "cover-up", "sarong", "kaftan", "swim-skirt", "rash-guard"],
  accessory: ["belt", "scarf", "hat", "sunglasses", "hair-accessory", "gloves", "tights", "other-accessory"],
  other: ["lingerie", "activewear", "sleepwear", "unknown"],
});

/** Flat list of every subcategory, in category order. */
export const ALL_SUBCATEGORIES = Object.freeze(CATEGORIES.flatMap((c) => SUBCATEGORIES[c]));

/** subcategory -> category reverse map. */
export const SUBCATEGORY_TO_CATEGORY = Object.freeze(
  Object.fromEntries(CATEGORIES.flatMap((c) => SUBCATEGORIES[c].map((s) => [s, c]))),
);

// --- Colour -----------------------------------------------------------------

/** Named colours incl. neutrals; `multi` for genuinely multi-coloured pieces. */
export const COLOURS = Object.freeze([
  "black", "white", "cream", "beige", "camel", "tan", "brown", "grey", "charcoal",
  "navy", "blue", "light-blue", "denim", "teal", "green", "olive", "sage",
  "yellow", "mustard", "orange", "rust", "red", "burgundy",
  "pink", "blush", "lavender", "purple", "gold", "silver", "multi",
]);

/** Brief §2.3 colour architecture: these count as base neutrals. */
export const NEUTRALS = Object.freeze([
  "black", "white", "cream", "beige", "camel", "tan", "brown", "grey", "charcoal", "navy", "denim",
]);

export const PATTERNS = Object.freeze([
  "solid", "stripe", "check", "plaid", "floral", "animal", "polka-dot", "geometric",
  "abstract", "colour-block", "logo", "textured", "other",
]);

export const FABRICS = Object.freeze([
  "cotton", "linen", "denim", "silk", "satin", "wool", "cashmere", "knit", "leather", "suede",
  "lace", "sheer", "jersey", "velvet", "tweed", "crochet", "sequin", "synthetic", "unknown",
]);

// --- Context ----------------------------------------------------------------

/** Formality 1–5 with one-line anchors (brief §5). */
export const FORMALITY = Object.freeze({
  1: "beach, lounge or gym: swimwear, sweats, activewear",
  2: "casual: jeans, tee, sneakers, everyday knits",
  3: "smart casual: elevated separates, loafers, a blazer over denim",
  4: "polished / business: tailoring, dresses, heels, dinner out",
  5: "formal / evening: cocktail, black tie, occasion dressing",
});
export const FORMALITY_LEVELS = Object.freeze([1, 2, 3, 4, 5]);

export const SEASONS = Object.freeze(["spring", "summer", "autumn", "winter", "all-season"]);

/** Warmth of a garment (brief §5 `warmth`). Not part of the pin tag; here so the wardrobe tagger shares it. */
export const WARMTH = Object.freeze(["light", "mid", "warm", "heavy"]);

/**
 * Named outfit formulas (brief §2.3). The first three are the brief's own
 * examples. `slots` are the categories/subcategories the formula fills, for the
 * styling engine; `id` is the enum value the tagger emits.
 */
export const FORMULAS = Object.freeze([
  { id: "blazer+wide-leg-trouser+loafer", slots: ["blazer", "wide-leg-trouser", "loafer"] },
  { id: "midi-skirt+fitted-top", slots: ["midi-skirt", "top"] },
  { id: "knit+trouser+loafer", slots: ["knit-sweater", "trouser", "loafer"] },
  { id: "jeans+tee+sneaker", slots: ["jeans", "t-shirt", "sneaker"] },
  { id: "jeans+blazer+heel", slots: ["jeans", "blazer", "heel"] },
  { id: "jeans+knit+boot", slots: ["jeans", "knit-sweater", "boot"] },
  { id: "jeans+shirt+flat", slots: ["jeans", "shirt", "flat"] },
  { id: "trench+jeans+loafer", slots: ["trench", "jeans", "loafer"] },
  { id: "leather-jacket+dress+boot", slots: ["leather-jacket", "dress", "boot"] },
  { id: "slip-dress+sandal", slots: ["slip-dress", "sandal"] },
  { id: "midi-dress+boot", slots: ["midi-dress", "boot"] },
  { id: "shirt-dress+flat", slots: ["shirt-dress", "flat"] },
  { id: "mini-skirt+jacket+boot", slots: ["mini-skirt", "outerwear", "boot"] },
  { id: "tailored-trouser+shirt+heel", slots: ["trouser", "shirt", "heel"] },
  { id: "cardigan+skirt+flat", slots: ["cardigan", "bottom", "flat"] },
  { id: "jumpsuit+heel", slots: ["jumpsuit", "heel"] },
  { id: "shorts+shirt+sandal", slots: ["shorts", "shirt", "sandal"] },
  { id: "matching-set", slots: ["top", "bottom"] },
  { id: "tonal-monochrome", slots: [] },
  { id: "athleisure", slots: ["leggings", "sweatshirt", "sneaker"] },
  { id: "swimsuit+cover-up+sandal", slots: ["swim", "cover-up", "sandal"] },
  { id: "swimsuit-only", slots: ["swim"] },
  { id: "other", slots: [] },
]);
export const FORMULA_IDS = Object.freeze(FORMULAS.map((f) => f.id));

/**
 * v2 formulas (proposal: docs/formula-v2-proposal.md, pending human review).
 * Derived from the garment sets that co-occur in her outfit pins: a base
 * (jeans / skirt / dress / trouser / leggings / shorts / swim), the layer(s)
 * over it, and the accessory that finishes it. Each slot is
 * `{name, any: [subcategory or category ids], required}`; `assignFormula`
 * (pipeline/formula-assign.mjs) fills slots from a tag's garments[] so the
 * profile does not depend on the model's single formula guess. The brief's
 * three stylist formulas are kept under their v1 ids even though they are rare
 * in her pins, because Atelier's methodology names them. List order is the
 * tie-break, so the signature looks come first.
 */
const slot = (name, any, required = true) => ({ name, any: Object.freeze([...any]), required });
const req = (name, ...any) => slot(name, any, true);
const opt = (name, ...any) => slot(name, any, false);
const BASE_SKIRT = ["mini-skirt", "midi-skirt", "maxi-skirt"];
const BASE_TROUSER = ["trouser", "wide-leg-trouser", "culottes"];
const BOOTS = ["boot", "ankle-boot"];
const TEE = ["t-shirt", "tank"];
const COLLAR = ["shirt", "blouse"];

export const FORMULAS_V2 = Object.freeze([
  // --- jeans: the base in 39% of her outfit pins -------------------------------
  { id: "jeans+cardigan+tee", slots: [req("base", "jeans"), req("layer", "cardigan"), req("under", ...TEE), opt("accessory", "necklace", "sunglasses", "scarf", "belt"), opt("shoe", "shoes")] },
  { id: "jeans+knit+shirt", slots: [req("base", "jeans"), req("layer", "knit-sweater"), req("under", ...COLLAR), opt("accessory", "necklace", "scarf", "watch", "bracelet", "belt"), opt("shoe", "shoes")] },
  { id: "jeans+knit+scarf", slots: [req("base", "jeans"), req("layer", "knit-sweater", "cardigan"), req("accessory", "scarf"), opt("shoe", ...BOOTS), opt("eyewear", "sunglasses")] },
  { id: "jeans+knit+necklace", slots: [req("base", "jeans"), req("layer", "knit-sweater", "cardigan"), req("jewelry", "necklace", "bracelet", "watch"), opt("under", ...TEE, ...COLLAR), opt("shoe", "shoes")] },
  { id: "jeans+blazer+tee", slots: [req("base", "jeans"), req("layer", "blazer"), req("under", ...TEE, ...COLLAR), opt("accessory", "necklace", "sunglasses", "scarf", "belt"), opt("shoe", "shoes")] },
  { id: "jeans+shirt+belt", slots: [req("base", "jeans"), req("top", ...COLLAR), req("accessory", "belt", "necklace", "bracelet", "watch"), opt("shoe", "shoes"), opt("eyewear", "sunglasses")] },
  { id: "jeans+tee+sunglasses", slots: [req("base", "jeans"), req("top", ...TEE), req("accessory", "sunglasses", "scarf", "necklace", "belt", "bracelet", "hat"), opt("layer", "outerwear"), opt("shoe", "shoes")] },
  // --- skirt ----------------------------------------------------------------------
  { id: "skirt+knit+boot", slots: [req("base", ...BASE_SKIRT), req("top", "knit-sweater", "cardigan"), req("shoe", ...BOOTS), opt("legs", "tights"), opt("accessory", "necklace", "belt", "scarf")] },
  { id: "midi-skirt+fitted-top", slots: [req("base", "midi-skirt"), req("top", "top"), opt("shoe", "shoes"), opt("accessory", "belt", "necklace")] },
  { id: "skirt+top+heel", slots: [req("base", ...BASE_SKIRT), req("top", "top"), opt("shoe", "heel", "sandal", "flat"), opt("accessory", "necklace", "belt", "bracelet", "sunglasses")] },
  // --- dress ----------------------------------------------------------------------
  { id: "dress+cardigan", slots: [req("base", "dress"), req("layer", "cardigan", "denim-jacket", "blazer", "leather-jacket", "trench", "coat"), opt("shoe", "shoes"), opt("accessory", "belt", "necklace", "scarf", "sunglasses")] },
  { id: "dress+boot", slots: [req("base", "dress"), req("shoe", ...BOOTS), opt("legs", "tights"), opt("accessory", "belt", "scarf", "necklace", "sunglasses")] },
  { id: "dress+necklace+sandal", slots: [req("base", "dress"), opt("jewelry", "necklace", "earrings", "bracelet"), opt("shoe", "sandal", "espadrille", "slide", "heel", "flat", "sneaker"), opt("accessory", "sunglasses", "belt", "hat")] },
  // --- trouser (incl. the brief's two tailoring formulas) -------------------------
  { id: "blazer+wide-leg-trouser+loafer", slots: [req("base", ...BASE_TROUSER), req("layer", "blazer"), opt("under", ...TEE, ...COLLAR), opt("shoe", "loafer", "heel", "flat")] },
  { id: "knit+trouser+loafer", slots: [req("base", ...BASE_TROUSER), req("top", "knit-sweater", "cardigan"), opt("under", ...COLLAR), opt("accessory", "necklace", "watch", "belt"), opt("shoe", "loafer", "flat", "heel", "sneaker")] },
  { id: "trouser+shirt+heel", slots: [req("base", ...BASE_TROUSER), req("top", ...COLLAR, ...TEE), opt("shoe", "heel", "flat", "loafer"), opt("accessory", "necklace", "belt", "sunglasses", "watch")] },
  // --- leggings -------------------------------------------------------------------
  { id: "leggings+knit+boot", slots: [req("base", "leggings"), req("top", "top"), req("shoe", ...BOOTS), opt("accessory", "scarf", "hat", "gloves", "sunglasses")] },
  { id: "athleisure", slots: [req("base", "leggings", "activewear", "sweatshirt"), opt("top", "sweatshirt", "crop-top", "tank", "t-shirt", "knit-sweater", "cardigan"), opt("layer", "outerwear"), opt("shoe", "sneaker", "heel", "flat", "sandal"), opt("accessory", "sunglasses", "scarf", "hat", "necklace")] },
  // --- shorts / swim ----------------------------------------------------------------
  { id: "shorts+top+sandal", slots: [req("base", "shorts"), req("top", "top"), opt("shoe", "sandal", "sneaker", "espadrille", "slide"), opt("accessory", "sunglasses", "belt", "hat", "necklace")] },
  { id: "swim+cover-up", slots: [req("base", "one-piece", "bikini", "tankini", "swim-skirt", "rash-guard"), opt("cover", "cover-up", "kaftan", "sarong"), opt("accessory", "hat", "sunglasses", "necklace", "bracelet", "earrings", "sandal", "slide", "espadrille", "basket")] },
  // --- no visible base (pin cropped to the top half): her signature collar-under-knit
  { id: "knit+shirt+necklace", slots: [req("layer", "knit-sweater", "cardigan"), req("under", ...COLLAR), opt("accessory", "necklace", "watch", "bracelet", "scarf")] },
  { id: "other", slots: [] },
]);
export const FORMULA_V2_IDS = Object.freeze(FORMULAS_V2.map((f) => f.id));

/** One line per v2 formula: `id = required slots (+ optional slots)`, each slot as its accepted ids joined by '|'. */
export function describeFormulaV2(f) {
  const show = (xs) => xs.map((sl) => sl.any.join("|")).join(" + ");
  const required = f.slots.filter((sl) => sl.required);
  const optional = f.slots.filter((sl) => !sl.required);
  if (!f.slots.length) return `${f.id} = none of the above`;
  return `${f.id} = ${show(required) || "any"}${optional.length ? ` (+ ${show(optional)})` : ""}`;
}
export const FORMULA_V2_LINES = Object.freeze(FORMULAS_V2.map(describeFormulaV2));

export const SILHOUETTES = Object.freeze([
  "column", "a-line", "fit-and-flare", "fitted", "relaxed", "oversized",
  "slim-top-wide-bottom", "volume-top-slim-bottom", "layered", "straight", "other",
]);

export const OCCASIONS = Object.freeze([
  "everyday", "work", "weekend", "brunch", "date-night", "evening", "party", "wedding-guest",
  "travel", "beach", "vacation", "gym", "errands", "other",
]);

export const VIBE_KEYWORDS_MIN = 3;
export const VIBE_KEYWORDS_MAX = 6;
export const MAX_GARMENTS = 12;

// --- Gemini responseSchema ----------------------------------------------------
// OpenAPI-subset form accepted by generationConfig.responseSchema. Enums are
// built from the arrays above so the schema cannot drift from the data.

const str = (values, description) => ({ type: "STRING", enum: [...values], description });

export const garmentSchema = Object.freeze({
  type: "OBJECT",
  properties: {
    category: str(CATEGORIES, "Garment category."),
    subcategory: str(ALL_SUBCATEGORIES, "Subcategory; must belong to the chosen category."),
    colour: str(COLOURS, "Dominant colour of this garment."),
    pattern: str(PATTERNS, "Pattern; 'solid' when plain."),
    fabric: str(FABRICS, "Best-guess fabric; 'unknown' if it cannot be read from the image."),
  },
  required: ["category", "subcategory", "colour", "pattern", "fabric"],
  propertyOrdering: ["category", "subcategory", "colour", "pattern", "fabric"],
});

/** The tag responseSchema with the given formula enum; v1 and v2 differ only there. */
export function buildTagSchema(formulaIds) {
  return Object.freeze({
  type: "OBJECT",
  properties: {
    is_outfit: {
      type: "BOOLEAN",
      description: "true when a person is wearing a look; false for product shots, flat-lays, text, quotes, scenery.",
    },
    garments: {
      type: "ARRAY",
      description: "Every clearly visible garment or accessory, one entry each.",
      items: garmentSchema,
    },
    formula: str(formulaIds, "Closest named outfit formula, or 'other'."),
    silhouette: str(SILHOUETTES, "Overall silhouette of the look."),
    formality: {
      type: "INTEGER",
      minimum: 1,
      maximum: 5,
      description: Object.entries(FORMALITY).map(([k, v]) => `${k} = ${v}`).join("; "),
    },
    season: str(SEASONS, "Season the look is dressed for."),
    occasion: str(OCCASIONS, "Occasion the look is dressed for."),
    vibe_keywords: {
      type: "ARRAY",
      description: `${VIBE_KEYWORDS_MIN}-${VIBE_KEYWORDS_MAX} short lowercase style words (e.g. "minimal", "coastal", "polished").`,
      items: { type: "STRING" },
    },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1, description: "Your confidence in this tag, 0-1." },
  },
  required: ["is_outfit", "garments", "formula", "silhouette", "formality", "season", "occasion", "vibe_keywords", "confidence"],
  propertyOrdering: ["is_outfit", "garments", "formula", "silhouette", "formality", "season", "occasion", "vibe_keywords", "confidence"],
  });
}
export const tagSchema = buildTagSchema(FORMULA_IDS);
export const tagSchemaV2 = buildTagSchema(FORMULA_V2_IDS);

// --- Validation ---------------------------------------------------------------

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const inEnum = (list, v) => list.includes(v);

const FORMULA_IDS_BY_VERSION = Object.freeze({ v1: FORMULA_IDS, v2: FORMULA_V2_IDS });

/**
 * Validate a tag object against the taxonomy.
 * @param {object} tag
 * @param {{version?: "v1"|"v2"}} [opts]  which formula enum applies (default v1)
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTag(tag, { version = "v1" } = {}) {
  const formulaIds = FORMULA_IDS_BY_VERSION[version];
  if (!formulaIds) throw new Error(`validateTag: unknown version '${version}' (known: ${Object.keys(FORMULA_IDS_BY_VERSION).join(", ")})`);
  const errors = [];
  if (!isObj(tag)) return { ok: false, errors: ["tag is not an object"] };

  for (const key of tagSchema.required) {
    if (!(key in tag)) errors.push(`missing field: ${key}`);
  }
  if (errors.length) return { ok: false, errors };

  if (typeof tag.is_outfit !== "boolean") errors.push("is_outfit must be a boolean");

  if (!Array.isArray(tag.garments)) {
    errors.push("garments must be an array");
  } else {
    if (tag.garments.length > MAX_GARMENTS) errors.push(`garments has more than ${MAX_GARMENTS} entries`);
    tag.garments.forEach((g, i) => {
      const at = `garments[${i}]`;
      if (!isObj(g)) { errors.push(`${at} is not an object`); return; }
      for (const key of garmentSchema.required) {
        if (!(key in g)) errors.push(`${at} missing field: ${key}`);
      }
      if ("category" in g && !inEnum(CATEGORIES, g.category)) errors.push(`${at}.category invalid: ${g.category}`);
      if ("subcategory" in g && !inEnum(ALL_SUBCATEGORIES, g.subcategory)) {
        errors.push(`${at}.subcategory invalid: ${g.subcategory}`);
      } else if ("subcategory" in g && "category" in g && SUBCATEGORY_TO_CATEGORY[g.subcategory] !== g.category) {
        errors.push(`${at}.subcategory '${g.subcategory}' does not belong to category '${g.category}'`);
      }
      if ("colour" in g && !inEnum(COLOURS, g.colour)) errors.push(`${at}.colour invalid: ${g.colour}`);
      if ("pattern" in g && !inEnum(PATTERNS, g.pattern)) errors.push(`${at}.pattern invalid: ${g.pattern}`);
      if ("fabric" in g && !inEnum(FABRICS, g.fabric)) errors.push(`${at}.fabric invalid: ${g.fabric}`);
    });
  }

  if (!inEnum(formulaIds, tag.formula)) errors.push(`formula invalid: ${tag.formula}`);
  if (!inEnum(SILHOUETTES, tag.silhouette)) errors.push(`silhouette invalid: ${tag.silhouette}`);
  if (!Number.isInteger(tag.formality) || tag.formality < 1 || tag.formality > 5) {
    errors.push(`formality must be an integer 1-5, got ${tag.formality}`);
  }
  if (!inEnum(SEASONS, tag.season)) errors.push(`season invalid: ${tag.season}`);
  if (!inEnum(OCCASIONS, tag.occasion)) errors.push(`occasion invalid: ${tag.occasion}`);

  if (!Array.isArray(tag.vibe_keywords)) {
    errors.push("vibe_keywords must be an array");
  } else {
    // Count is a soft target set in the prompt; a 2- or 7-word answer is still a
    // usable tag. Only an empty list or non-lowercase junk is rejected.
    if (tag.vibe_keywords.length === 0) errors.push("vibe_keywords is empty");
    if (tag.vibe_keywords.length > VIBE_KEYWORDS_MAX + 2) errors.push(`vibe_keywords has more than ${VIBE_KEYWORDS_MAX + 2} entries`);
    tag.vibe_keywords.forEach((k, i) => {
      if (typeof k !== "string" || k.trim().length === 0) errors.push(`vibe_keywords[${i}] must be a non-empty string`);
      else if (k !== k.toLowerCase()) errors.push(`vibe_keywords[${i}] must be lowercase: ${k}`);
    });
  }

  if (typeof tag.confidence !== "number" || Number.isNaN(tag.confidence) || tag.confidence < 0 || tag.confidence > 1) {
    errors.push(`confidence must be a number 0-1, got ${tag.confidence}`);
  }

  return { ok: errors.length === 0, errors };
}

/** validateTag against the v2 formula enum. */
export const validateTagV2 = (tag) => validateTag(tag, { version: "v2" });

// --- Prompt (reviewable constant; bump PROMPT_VERSION when it changes) ---------

export const DOMAIN = "fashion";
export const PROMPT_VERSION = "fashion.tag.v1";

const list = (xs) => xs.join(", ");

/**
 * The tag prompt with a given formula vocabulary. `formulaText` is what follows
 * "- formula:" in the value list; `formulaRule` is the formula bullet under
 * Rules. v1 passes the plain id list; v2 passes one line per formula with its
 * slots and tells the model that layering accessories count.
 */
function buildTagPrompt({ formulaText, formulaRule }) {
  return `You are a careful, experienced personal stylist. You are reading ONE Pinterest fashion pin to build a client's taste profile. Study the image closely before answering: what is worn, how each piece is cut, how the pieces relate to each other, and the overall mood.

Return ONE JSON object matching the response schema. Use ONLY these values:
- category: ${list(CATEGORIES)}
- subcategory (must belong to its category): ${CATEGORIES.map((c) => `${c}: ${list(SUBCATEGORIES[c])}`).join("; ")}
- colour: ${list(COLOURS)}
- pattern: ${list(PATTERNS)}
- fabric: ${list(FABRICS)}
- formula: ${formulaText}
- silhouette: ${list(SILHOUETTES)}
- formality (integer): ${Object.entries(FORMALITY).map(([k, v]) => `${k} = ${v}`).join("; ")}
- season: ${list(SEASONS)}
- occasion: ${list(OCCASIONS)}

Rules:
- is_outfit: true only when a person is wearing a look (full or partial body, face not required). If no person is wearing an outfit — a product shot, flat-lay, text, quote, mood image, interior or scenery — set is_outfit=false and still tag visible garments.
- garments: one entry per clearly visible garment or accessory. Give its dominant colour; use pattern 'solid' when plain and fabric 'unknown' when it cannot be read from the image. Do not invent pieces that are cropped out or hidden.
- formula: ${formulaRule}
- silhouette, formality, season, occasion: your read of the look as a whole, not of a single piece.
- vibe_keywords: ${VIBE_KEYWORDS_MIN}-${VIBE_KEYWORDS_MAX} short lowercase words a stylist would use (for example "minimal", "coastal", "tailored", "boho", "polished", "sporty").
- confidence: 0-1; lower it for tight crops, dark or heavily edited images, or ambiguous pieces.
Prefer the specific value over the generic one, and prefer 'unknown' fabric over a guess.`;
}

export const TAG_PROMPT_FASHION_V1 = buildTagPrompt({
  formulaText: list(FORMULA_IDS),
  formulaRule: "the closest named outfit formula to the look; 'other' when none fits well. For a non-outfit image choose the formula the pieces most suggest, or 'other'.",
});

/**
 * v2 prompt (pending human review, docs/formula-v2-proposal.md): the v1 text
 * with the v2 formula list spelled out as base + layer + accessory slots, and
 * the rule that layering accessories count toward the formula.
 */
export const TAG_PROMPT_FASHION_V2 = buildTagPrompt({
  formulaText: `one id from this list; each is a base + layer + accessory (required slots, then optional ones in brackets; '|' separates the pieces that can fill a slot):\n${FORMULA_V2_LINES.map((l) => `    ${l}`).join("\n")}`,
  formulaRule: "the formula whose required slots the look fills, preferring the one that fills the most slots. Layering accessories count toward the formula: a necklace, scarf, belt, sunglasses, watch or bracelet worn with the base and layer fills that formula's accessory slot, so a knit over a collared shirt with a necklace is 'jeans+knit+shirt' (jeans visible) or 'knit+shirt+necklace' (cropped), not 'other'. Use 'other' only when no formula's required slots are filled. For a non-outfit image choose the formula the pieces most suggest, or 'other'.",
});
export const PROMPT_VERSION_V2 = "fashion.tag.v2";

/** Domain-interface alias: the current prompt for this domain (v1 until the v2 review). */
export const TAG_PROMPT = TAG_PROMPT_FASHION_V1;

/**
 * Selectable prompt versions for tag.mjs `--prompt-version`. Each entry is a
 * complete tagging contract; the domain-level exports above are `v1`.
 */
export const VERSIONS = Object.freeze({
  v1: Object.freeze({ PROMPT_VERSION, TAG_PROMPT: TAG_PROMPT_FASHION_V1, tagSchema, validateTag, FORMULA_IDS }),
  v2: Object.freeze({ PROMPT_VERSION: PROMPT_VERSION_V2, TAG_PROMPT: TAG_PROMPT_FASHION_V2, tagSchema: tagSchemaV2, validateTag: validateTagV2, FORMULA_IDS: FORMULA_V2_IDS }),
});
