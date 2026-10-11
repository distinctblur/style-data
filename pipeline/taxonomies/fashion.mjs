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

export const tagSchema = Object.freeze({
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
    formula: str(FORMULA_IDS, "Closest named outfit formula, or 'other'."),
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

// --- Validation ---------------------------------------------------------------

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const inEnum = (list, v) => list.includes(v);

/**
 * Validate a tag object against the taxonomy.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTag(tag) {
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

  if (!inEnum(FORMULA_IDS, tag.formula)) errors.push(`formula invalid: ${tag.formula}`);
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

// --- Prompt (reviewable constant; bump PROMPT_VERSION when it changes) ---------

export const DOMAIN = "fashion";
export const PROMPT_VERSION = "fashion.tag.v1";

const list = (xs) => xs.join(", ");
export const TAG_PROMPT_FASHION_V1 = `You are a careful, experienced personal stylist. You are reading ONE Pinterest fashion pin to build a client's taste profile. Study the image closely before answering: what is worn, how each piece is cut, how the pieces relate to each other, and the overall mood.

Return ONE JSON object matching the response schema. Use ONLY these values:
- category: ${list(CATEGORIES)}
- subcategory (must belong to its category): ${CATEGORIES.map((c) => `${c}: ${list(SUBCATEGORIES[c])}`).join("; ")}
- colour: ${list(COLOURS)}
- pattern: ${list(PATTERNS)}
- fabric: ${list(FABRICS)}
- formula: ${list(FORMULA_IDS)}
- silhouette: ${list(SILHOUETTES)}
- formality (integer): ${Object.entries(FORMALITY).map(([k, v]) => `${k} = ${v}`).join("; ")}
- season: ${list(SEASONS)}
- occasion: ${list(OCCASIONS)}

Rules:
- is_outfit: true only when a person is wearing a look (full or partial body, face not required). If no person is wearing an outfit — a product shot, flat-lay, text, quote, mood image, interior or scenery — set is_outfit=false and still tag visible garments.
- garments: one entry per clearly visible garment or accessory. Give its dominant colour; use pattern 'solid' when plain and fabric 'unknown' when it cannot be read from the image. Do not invent pieces that are cropped out or hidden.
- formula: the closest named outfit formula to the look; 'other' when none fits well. For a non-outfit image choose the formula the pieces most suggest, or 'other'.
- silhouette, formality, season, occasion: your read of the look as a whole, not of a single piece.
- vibe_keywords: ${VIBE_KEYWORDS_MIN}-${VIBE_KEYWORDS_MAX} short lowercase words a stylist would use (for example "minimal", "coastal", "tailored", "boho", "polished", "sporty").
- confidence: 0-1; lower it for tight crops, dark or heavily edited images, or ambiguous pieces.
Prefer the specific value over the generic one, and prefer 'unknown' fabric over a guess.`;

/** Domain-interface alias: the current prompt for this domain. */
export const TAG_PROMPT = TAG_PROMPT_FASHION_V1;
