// style-data home taxonomy — the vocabulary, Gemini response schema, prompt and
// validator for `home` pins: interiors, furniture and finishes (ADR-0001 #4).
// Same shape of module as ./fashion.mjs; see ./index.mjs for the interface.
//
// Tag shape (the contract with pipeline/aggregate.mjs; keep these keys):
//   { is_interior, room, items: [{type, material, colour, style}], styles,
//     palette_mood, era, vibe_keywords, confidence }
//
// Plain data only, no imports, no runtime deps.

export const DOMAIN = "home";
export const PROMPT_VERSION = "home.tag.v1";

// --- Rooms --------------------------------------------------------------------

export const ROOMS = Object.freeze([
  "living", "kitchen", "dining", "bedroom", "kids-bedroom", "nursery", "bathroom", "entry",
  "office", "laundry", "outdoor-patio", "garden", "hallway", "other",
]);

// --- Items --------------------------------------------------------------------

/** Furniture, fixtures, finishes and decorative objects. */
export const ITEM_TYPES = Object.freeze([
  // seating and tables
  "sofa", "armchair", "ottoman", "bench", "coffee-table", "side-table", "dining-table", "dining-chair", "bar-stool",
  // bedroom and storage
  "bed", "bedding", "nightstand", "dresser", "wardrobe", "bookshelf", "shelving", "console", "cabinet", "desk",
  // soft furnishings and lighting
  "rug", "curtain", "cushion", "throw", "pendant-light", "chandelier", "floor-lamp", "table-lamp", "sconce",
  // decor
  "mirror", "art", "plant", "vase",
  // kitchen and bath
  "kitchen-island", "countertop", "backsplash", "range", "sink", "faucet", "bathtub", "shower", "vanity",
  // surfaces and architecture
  "tile", "flooring", "wallpaper", "paint", "fireplace", "window", "door", "stairs",
  "other",
]);

/** Dominant material of a piece or finish; `unknown` when it cannot be read from the image. */
export const MATERIALS = Object.freeze([
  "oak", "walnut", "light-wood", "dark-wood", "painted-wood", "rattan", "cane",
  "linen", "cotton", "wool", "boucle", "velvet", "leather", "jute",
  "marble", "stone", "terrazzo", "concrete", "ceramic", "glass",
  "brass", "black-metal", "chrome", "unknown",
]);

/** Interior colour vocabulary (same shape as the fashion list, tuned for rooms). */
export const COLOURS = Object.freeze([
  "white", "warm-white", "cream", "beige", "sand", "greige", "taupe", "grey", "charcoal", "black", "brown",
  "terracotta", "rust", "olive", "sage", "forest", "navy", "blue", "light-blue", "blush", "mustard", "multi",
]);

/** Base neutrals for palette analysis (consumers may group on these). */
export const NEUTRALS = Object.freeze([
  "white", "warm-white", "cream", "beige", "sand", "greige", "taupe", "grey", "charcoal", "black", "brown",
]);

// --- Look -----------------------------------------------------------------------

/** Named interior styles; used both per item and for the 1-3 overall labels. */
export const STYLES = Object.freeze([
  "scandinavian", "mid-century", "japandi", "minimalist", "modern-farmhouse", "traditional", "transitional",
  "coastal", "boho", "industrial", "art-deco", "mediterranean", "french-country", "eclectic", "contemporary", "other",
]);

export const PALETTE_MOODS = Object.freeze([
  "warm-neutral", "cool-neutral", "dark-moody", "bright-airy", "earthy", "colourful", "monochrome",
]);

export const ERAS = Object.freeze(["contemporary", "vintage", "antique", "mixed", "unknown"]);

export const STYLES_MIN = 1;
export const STYLES_MAX = 3;
export const VIBE_KEYWORDS_MIN = 3;
export const VIBE_KEYWORDS_MAX = 6;
export const MAX_ITEMS = 16;

// --- Gemini responseSchema ----------------------------------------------------
// OpenAPI-subset form accepted by generationConfig.responseSchema. Enums are
// built from the arrays above so the schema cannot drift from the data.

const str = (values, description) => ({ type: "STRING", enum: [...values], description });

export const itemSchema = Object.freeze({
  type: "OBJECT",
  properties: {
    type: str(ITEM_TYPES, "What the piece, fixture or finish is."),
    material: str(MATERIALS, "Dominant material; 'unknown' if it cannot be read from the image."),
    colour: str(COLOURS, "Dominant colour of this piece."),
    style: str(STYLES, "Style this piece reads as; 'other' when none fits."),
  },
  required: ["type", "material", "colour", "style"],
  propertyOrdering: ["type", "material", "colour", "style"],
});

export const tagSchema = Object.freeze({
  type: "OBJECT",
  properties: {
    is_interior: {
      type: "BOOLEAN",
      description: "true when a real room or space is shown; false for product shots, text, quotes, moodboards, floor plans, swatches.",
    },
    room: str(ROOMS, "The space shown; 'other' when not one of the listed rooms or no room is shown."),
    items: {
      type: "ARRAY",
      description: "Every clearly visible furniture piece, fixture, finish or decorative object, one entry each, most prominent first.",
      items: itemSchema,
    },
    styles: {
      type: "ARRAY",
      description: `${STYLES_MIN}-${STYLES_MAX} overall style labels for the whole image, most dominant first.`,
      items: str(STYLES, "Interior style label."),
    },
    palette_mood: str(PALETTE_MOODS, "Overall colour feeling of the image."),
    era: str(ERAS, "Whether the pieces read as contemporary, vintage, antique or a deliberate mix; 'unknown' when it cannot be told."),
    vibe_keywords: {
      type: "ARRAY",
      description: `${VIBE_KEYWORDS_MIN}-${VIBE_KEYWORDS_MAX} short lowercase style words (e.g. "warm", "layered", "airy").`,
      items: { type: "STRING" },
    },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1, description: "Your confidence in this tag, 0-1." },
  },
  required: ["is_interior", "room", "items", "styles", "palette_mood", "era", "vibe_keywords", "confidence"],
  propertyOrdering: ["is_interior", "room", "items", "styles", "palette_mood", "era", "vibe_keywords", "confidence"],
});

// --- Validation ---------------------------------------------------------------

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const inEnum = (list, v) => list.includes(v);

/**
 * Validate a home tag object against the taxonomy.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTag(tag) {
  const errors = [];
  if (!isObj(tag)) return { ok: false, errors: ["tag is not an object"] };

  for (const key of tagSchema.required) {
    if (!(key in tag)) errors.push(`missing field: ${key}`);
  }
  if (errors.length) return { ok: false, errors };

  if (typeof tag.is_interior !== "boolean") errors.push("is_interior must be a boolean");
  if (!inEnum(ROOMS, tag.room)) errors.push(`room invalid: ${tag.room}`);

  if (!Array.isArray(tag.items)) {
    errors.push("items must be an array");
  } else {
    if (tag.items.length > MAX_ITEMS) errors.push(`items has more than ${MAX_ITEMS} entries`);
    tag.items.forEach((it, i) => {
      const at = `items[${i}]`;
      if (!isObj(it)) { errors.push(`${at} is not an object`); return; }
      for (const key of itemSchema.required) {
        if (!(key in it)) errors.push(`${at} missing field: ${key}`);
      }
      if ("type" in it && !inEnum(ITEM_TYPES, it.type)) errors.push(`${at}.type invalid: ${it.type}`);
      if ("material" in it && !inEnum(MATERIALS, it.material)) errors.push(`${at}.material invalid: ${it.material}`);
      if ("colour" in it && !inEnum(COLOURS, it.colour)) errors.push(`${at}.colour invalid: ${it.colour}`);
      if ("style" in it && !inEnum(STYLES, it.style)) errors.push(`${at}.style invalid: ${it.style}`);
    });
  }

  if (!Array.isArray(tag.styles)) {
    errors.push("styles must be an array");
  } else {
    // Count is a soft target set in the prompt; one extra label is still usable.
    if (tag.styles.length < STYLES_MIN) errors.push("styles is empty");
    if (tag.styles.length > STYLES_MAX + 1) errors.push(`styles has more than ${STYLES_MAX + 1} entries`);
    tag.styles.forEach((s, i) => { if (!inEnum(STYLES, s)) errors.push(`styles[${i}] invalid: ${s}`); });
    if (new Set(tag.styles).size !== tag.styles.length) errors.push("styles has duplicates");
  }

  if (!inEnum(PALETTE_MOODS, tag.palette_mood)) errors.push(`palette_mood invalid: ${tag.palette_mood}`);
  if (!inEnum(ERAS, tag.era)) errors.push(`era invalid: ${tag.era}`);

  if (!Array.isArray(tag.vibe_keywords)) {
    errors.push("vibe_keywords must be an array");
  } else {
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

const list = (xs) => xs.join(", ");
export const TAG_PROMPT_HOME_V1 = `You are a careful, experienced interior stylist. You are reading ONE Pinterest pin about interiors, furniture or finishes to build a client's taste profile for their home. Study the image closely before answering: what kind of space it is, which pieces and finishes are visible, what they are made of, how they sit together, and the overall mood.

Return ONE JSON object matching the response schema. Use ONLY these values:
- room: ${list(ROOMS)}
- items[].type: ${list(ITEM_TYPES)}
- items[].material: ${list(MATERIALS)}
- items[].colour: ${list(COLOURS)}
- items[].style and styles: ${list(STYLES)}
- palette_mood: ${list(PALETTE_MOODS)}
- era: ${list(ERAS)}

Rules:
- is_interior: true only when a real room or space is shown (a photographed or rendered interior, or an outdoor living area). If no real room is shown — a single product on a plain background, a text or quote image, a moodboard collage, a floor plan or a material swatch — set is_interior=false and still tag visible items.
- room: the space shown; 'other' when it is not one of the listed rooms or no room is shown.
- items: one entry per clearly visible furniture piece, fixture, finish or decorative object, most prominent first. Give each its dominant material and colour and the style it reads as; use material 'unknown' when it cannot be read from the image. Do not invent pieces that are cropped out or hidden.
- styles: ${STYLES_MIN}-${STYLES_MAX} labels for the look of the whole image, most dominant first; 'other' when none fits well.
- palette_mood: the overall colour feeling of the image, not of a single piece.
- era: whether the pieces read as contemporary, vintage (roughly twentieth-century second-hand), antique (pre-1900 or in that manner) or a deliberate mix; 'unknown' when it cannot be told.
- vibe_keywords: ${VIBE_KEYWORDS_MIN}-${VIBE_KEYWORDS_MAX} short lowercase words an interior stylist would use (for example "warm", "layered", "airy", "textured", "cosy", "sculptural").
- confidence: 0-1; lower it for tight crops, dark or heavily edited images, renders that are hard to read, or ambiguous pieces.
Prefer the specific value over the generic one, and prefer 'unknown' over a guess.`;

/** Domain-interface alias: the current prompt for this domain. */
export const TAG_PROMPT = TAG_PROMPT_HOME_V1;
