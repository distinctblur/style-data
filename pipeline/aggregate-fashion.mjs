// style-data — fashion domain summariser for aggregate.mjs (Atelier D10 seed input).
//
// Used set: tag non-null, confidence >= threshold, is_outfit !== false. Emits
// formula_weights, silhouettes, formality histogram/mean, seasons, occasions,
// palette (neutrals / secondary / accent), dominant_colors (pins' dominant hex
// bucketed to named hues), garment_mix, subcategory_top, vibe_keywords_top and
// absences. Tag strings are opaque; the neutral set comes from the fashion
// taxonomy and the absence candidates below match loosely.

import { NEUTRALS as TAXONOMY_NEUTRALS } from "./taxonomies/fashion.mjs";
import { Counter, buildProfile, r4, splitPalette, scanAbsences } from "./aggregate.mjs";

// Brief §2.3: base neutrals are the 60–70% layer. The taxonomy is the single
// source of truth; the extra spellings only matter for hand-written fixtures
// and legacy tags, never for tag.mjs output.
export const NEUTRALS = new Set([...TAXONOMY_NEUTRALS, "ivory", "gray"]);

// Non-neutral colours below this normalised share are dropped from `accent`
// so a single stray garment does not become "an accent colour".
export const ACCENT_FLOOR = 0.02;
export const SECONDARY_COUNT = 2; // brief §2.3: 1–2 secondary colours

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

// ~16 named hues for bucketing pins' dominant_color by RGB distance.
export const HUES = [
  { hue: "black", hex: "#000000" },
  { hue: "white", hex: "#ffffff" },
  { hue: "grey", hex: "#808080" },
  { hue: "cream", hex: "#f5ecd7" },
  { hue: "beige", hex: "#d2b48c" },
  { hue: "brown", hex: "#6b4423" },
  { hue: "red", hex: "#c0282d" },
  { hue: "orange", hex: "#e8752a" },
  { hue: "yellow", hex: "#e9c43a" },
  { hue: "olive", hex: "#6b6b2a" },
  { hue: "green", hex: "#2e7d4f" },
  { hue: "teal", hex: "#1f8a8a" },
  { hue: "blue", hex: "#2f6fd6" },
  { hue: "navy", hex: "#1b2a4a" },
  { hue: "purple", hex: "#6f3f9e" },
  { hue: "pink", hex: "#e39ab6" },
].map((h) => ({ ...h, rgb: hexToRgb(h.hex) }));

export function nearestHue(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  let best = null;
  let bestD = Infinity;
  for (const h of HUES) {
    const d = (rgb[0] - h.rgb[0]) ** 2 + (rgb[1] - h.rgb[1]) ** 2 + (rgb[2] - h.rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best.hue;
}

// Conventional lists for `absences`. Each entry is {label, match[]}: the label
// is what gets printed; `match` are token sets matched loosely (case- and
// punctuation-insensitive, every token of the pattern must appear in the tag
// string). These are prompts for the intake interview, not conclusions.
export const ABSENCE_CANDIDATES = {
  formulas: [
    { label: "blazer + trouser", match: ["blazer trouser", "blazer pant", "suit"] },
    { label: "dress-based looks", match: ["dress"] },
    { label: "skirt + top", match: ["skirt"] },
    { label: "knit + jean", match: ["knit jean", "sweater jean", "knit denim"] },
    { label: "jumpsuit", match: ["jumpsuit"] },
    { label: "athleisure / sporty", match: ["athleisure", "sport", "active"] },
    { label: "tonal / monochrome dressing", match: ["tonal", "monochrome", "mono"] },
    { label: "coat-led layering", match: ["coat", "trench", "layer"] },
  ],
  categories: [
    { label: "cropped tops", match: ["crop", "cropped"] },
    { label: "shorts", match: ["short"] },
    { label: "mini skirts", match: ["mini skirt", "mini"] },
    { label: "sneakers / trainers", match: ["sneaker", "trainer"] },
    { label: "heels", match: ["heel", "pump", "stiletto"] },
    { label: "hats", match: ["hat", "cap", "beanie"] },
    { label: "leather pieces", match: ["leather"] },
    { label: "bold prints", match: ["animal", "floral", "leopard", "print", "graphic"] },
    { label: "jewellery / statement accessories", match: ["jewel", "necklace", "earring", "statement"] },
  ],
  colours: [
    { label: "red", match: ["red", "scarlet", "cherry"] },
    { label: "pink", match: ["pink", "blush", "rose"] },
    { label: "orange", match: ["orange", "rust", "terracotta"] },
    { label: "yellow", match: ["yellow", "mustard"] },
    { label: "green", match: ["green", "olive", "sage", "khaki"] },
    { label: "blue (non-navy)", match: ["blue", "cobalt", "sky"] },
    { label: "purple", match: ["purple", "lilac", "lavender", "plum"] },
    { label: "burgundy", match: ["burgundy", "wine", "oxblood", "maroon"] },
    { label: "metallics", match: ["gold", "silver", "metallic"] },
    { label: "bright white", match: ["white"] },
    { label: "black", match: ["black"] },
  ],
};

// ---------------------------------------------------------------------------

/**
 * Fashion taste profile: {version, domain:"fashion", coverage, overall, boards}.
 * @param {object} opts
 * @param {object[]} opts.tags   parsed tags.jsonl rows
 * @param {object[]} opts.pins   parsed pins.jsonl rows
 * @param {number} [opts.halfLifeDays=730]
 * @param {number} [opts.minConfidence=0.5]
 * @param {Map<string,string>} [opts.boardDomains]  board slug -> domain (default: boards.json)
 */
export function aggregateFashion({ tags, pins, halfLifeDays = 730, minConfidence = 0.5, boardDomains } = {}) {
  return buildProfile({
    domain: "fashion",
    tags,
    pins,
    halfLifeDays,
    minConfidence,
    boardDomains,
    usable: (tag) => tag.is_outfit !== false,
    excludedKey: "not_outfit",
    shareKey: "outfit_share",
    summarise,
  });
}

/** Back-compat name: `aggregate` has always meant the fashion profile. */
export const aggregate = aggregateFashion;

function summarise(rows) {
  const formulas = new Counter();
  const silhouettes = new Counter();
  const formality = new Counter();
  const seasons = new Counter();
  const occasions = new Counter();
  const colours = new Counter();
  const categories = new Counter();
  const subcategories = new Counter();
  const vibes = new Counter();
  const dominant = new Counter();
  const dominantHex = new Map();

  let fWeightSum = 0;
  let fWeighted = 0;
  let totalWeight = 0;

  // Raw (unweighted) appearance counts for `absences`.
  const seen = { formulas: [], garments: [], colours: [] };

  for (const r of rows) {
    const w = r.weight;
    const t = r.tag;
    totalWeight += w;
    formulas.add(t.formula, w);
    silhouettes.add(t.silhouette, w);
    seasons.add(t.season, w);
    occasions.add(t.occasion, w);
    const f = Number(t.formality);
    if (Number.isFinite(f) && f >= 1 && f <= 5) {
      formality.add(String(Math.round(f)), w);
      fWeightSum += w;
      fWeighted += w * f;
    }
    for (const v of t.vibe_keywords ?? []) vibes.add(v, w);
    const garments = Array.isArray(t.garments) ? t.garments : [];
    // Each pin contributes one unit of its weight to the garment-level
    // counters, split across its garments, so a pin with six pieces does not
    // outvote one with two.
    const gw = garments.length ? w / garments.length : 0;
    for (const g of garments) {
      colours.add(g.colour, gw);
      categories.add(g.category, gw);
      subcategories.add(g.subcategory || g.category, gw);
      seen.garments.push(`${g.category ?? ""} ${g.subcategory ?? ""} ${g.pattern ?? ""} ${g.fabric ?? ""}`);
      seen.colours.push(String(g.colour ?? ""));
    }
    seen.formulas.push(String(t.formula ?? ""));
    const hue = nearestHue(r.dominant);
    if (hue) {
      dominant.add(hue, w);
      if (!dominantHex.has(hue)) dominantHex.set(hue, HUES.find((h) => h.hue === hue).hex);
    }
  }

  const hist = {};
  const fTotal = formality.total() || 1;
  for (const lvl of ["1", "2", "3", "4", "5"]) {
    const v = formality.map.get(lvl) ?? { weight: 0, count: 0 };
    hist[lvl] = { weight: r4(v.weight / fTotal), count: v.count };
  }

  return {
    pins_used: rows.length,
    weight_total: r4(totalWeight),
    formula_weights: formulas.rows("formula"),
    silhouettes: silhouettes.rows("silhouette"),
    formality_histogram: hist,
    formality_mean: fWeightSum ? r4(fWeighted / fWeightSum) : null,
    seasons: seasons.rows("season"),
    occasions: occasions.rows("occasion"),
    palette: splitPalette(colours.rows("colour"), NEUTRALS, { secondaryCount: SECONDARY_COUNT, accentFloor: ACCENT_FLOOR }),
    dominant_colors: dominant.rows("hue", 8).map((d) => ({ hue: d.hue, hex: dominantHex.get(d.hue), weight: d.weight, count: d.count })),
    garment_mix: categories.rows("category"),
    subcategory_top: subcategories.rows("subcategory", 15),
    vibe_keywords_top: vibes.rows("keyword", 20),
    absences: scanAbsences([
      [ABSENCE_CANDIDATES.formulas, seen.formulas],
      [ABSENCE_CANDIDATES.categories, seen.garments],
      [ABSENCE_CANDIDATES.colours, seen.colours],
    ]),
  };
}

export function summaryLines(profile) {
  const o = profile.overall;
  const c = profile.coverage;
  const top = (rows, key, n = 3) =>
    rows.slice(0, n).map((r) => `${r[key]} ${(r.weight * 100).toFixed(0)}%`).join(", ") || "—";
  return [
    `fashion taste profile (${profile.version})`,
    `pins ${c.pins_total}, tagged ${c.tagged}, used ${c.used} (outfit share ${(c.outfit_share * 100).toFixed(0)}%), ${c.undated} undated`,
    `dates ${c.date_min ?? "?"} → ${c.date_max ?? "?"}, half-life ${c.half_life_days}d, min confidence ${c.min_confidence}`,
    `boards: ${c.boards.map((b) => `${b} (${profile.boards[b].pins_used})`).join(", ") || "—"}`,
    `formulas: ${top(o.formula_weights, "formula")}`,
    `silhouettes: ${top(o.silhouettes, "silhouette")}`,
    `formality mean ${o.formality_mean ?? "—"}; histogram ${["1", "2", "3", "4", "5"].map((l) => `${l}:${(o.formality_histogram[l].weight * 100).toFixed(0)}%`).join(" ")}`,
    `seasons: ${top(o.seasons, "season")}`,
    `occasions: ${top(o.occasions, "occasion")}`,
    `neutrals ${(o.palette.neutral_share * 100).toFixed(0)}%: ${top(o.palette.neutrals, "colour")}`,
    `secondary: ${top(o.palette.secondary, "colour")}; accent: ${top(o.palette.accent, "colour", 4)}`,
    `dominant pin colours: ${top(o.dominant_colors, "hue", 4)}`,
    `garment mix: ${top(o.garment_mix, "category", 4)}`,
    `vibes: ${top(o.vibe_keywords_top, "keyword", 5)}`,
    `absences (${o.absences.length}): ${o.absences.slice(0, 4).join("; ")}${o.absences.length > 4 ? "; …" : ""}`,
  ];
}
