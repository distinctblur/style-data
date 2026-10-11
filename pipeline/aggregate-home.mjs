// style-data — home (interiors) domain summariser for aggregate.mjs.
//
// Home tag shape (pipeline/taxonomies/home.mjs, strings treated as opaque here):
//   { is_interior, room, items: [{type, material, colour, style}], styles: [],
//     palette_mood, era, vibe_keywords: [], confidence }
//
// Used set: tag non-null, confidence >= threshold, is_interior !== false.
// Emits rooms, item_types_top, materials, styles, palette (neutrals /
// secondary / accent, same scheme as fashion), palette_mood, era,
// vibe_keywords_top, item_colour_by_type and absences. Item-level counters
// (types, materials, colours) split each pin's weight across its items so a
// pin listing eight pieces does not outvote one listing two; pin-level lists
// (styles, vibe keywords) likewise split across their entries.

import { Counter, buildProfile, r4, splitPalette, scanAbsences } from "./aggregate.mjs";

/** Neutral colours for the home palette split (ADR-0001 #4). */
export const HOME_NEUTRALS = new Set([
  "white", "warm-white", "cream", "beige", "sand", "greige", "taupe", "grey", "charcoal", "black", "brown",
  // spelling variants for hand-written fixtures and legacy tags
  "off-white", "ivory", "gray",
]);

export const ACCENT_FLOOR = 0.02;
export const SECONDARY_COUNT = 2;
export const ITEM_TYPES_TOP = 20;
export const VIBES_TOP = 20;
export const COLOUR_BY_TYPE_TYPES = 10;
export const COLOUR_BY_TYPE_COLOURS = 3;

// Conventional interiors vocabulary for `absences`: {label, match[]}, matched
// loosely (every token of a pattern must appear in the tag string). Prompts
// for the intake conversation, not conclusions.
export const ABSENCE_CANDIDATES = {
  rooms: [
    { label: "living room", match: ["living", "lounge", "sitting room"] },
    { label: "bedroom", match: ["bedroom", "bed room"] },
    { label: "kitchen", match: ["kitchen"] },
    { label: "bathroom", match: ["bathroom", "bath", "ensuite", "powder room"] },
    { label: "dining room", match: ["dining"] },
    { label: "home office / study", match: ["office", "study", "workspace"] },
    { label: "entryway / hallway", match: ["entry", "entryway", "hallway", "hall", "mudroom", "foyer"] },
    { label: "nursery / kids room", match: ["nursery", "kids", "child", "playroom"] },
    { label: "outdoor / garden", match: ["outdoor", "garden", "patio", "terrace", "balcony"] },
  ],
  items: [
    { label: "sofa", match: ["sofa", "couch", "sectional"] },
    { label: "armchair", match: ["armchair", "accent chair", "lounge chair"] },
    { label: "rug", match: ["rug", "carpet"] },
    { label: "curtains / drapes", match: ["curtain", "drape", "blind"] },
    { label: "pendant / chandelier", match: ["pendant", "chandelier"] },
    { label: "floor lamp", match: ["floor lamp"] },
    { label: "bookshelf / shelving", match: ["bookshelf", "bookcase", "shelving", "shelf"] },
    { label: "plants", match: ["plant", "tree", "greenery"] },
    { label: "artwork / wall art", match: ["art", "artwork", "painting", "print", "poster"] },
    { label: "mirror", match: ["mirror"] },
    { label: "bed / headboard", match: ["bed", "headboard"] },
    { label: "dining table", match: ["dining table", "table dining"] },
    { label: "coffee table", match: ["coffee table"] },
    { label: "fireplace", match: ["fireplace", "mantel", "stove"] },
  ],
  materials: [
    { label: "velvet", match: ["velvet"] },
    { label: "marble", match: ["marble"] },
    { label: "rattan / cane", match: ["rattan", "cane", "wicker"] },
    { label: "brass / gold metal", match: ["brass", "gold"] },
    { label: "leather", match: ["leather"] },
    { label: "linen", match: ["linen"] },
    { label: "glass", match: ["glass"] },
    { label: "concrete", match: ["concrete"] },
    { label: "dark wood / walnut", match: ["walnut", "dark wood", "mahogany"] },
    { label: "light wood / oak", match: ["oak", "ash", "light wood", "birch"] },
    { label: "tile", match: ["tile", "zellige", "terrazzo"] },
  ],
  styles: [
    { label: "mid-century", match: ["mid century", "midcentury"] },
    { label: "scandinavian", match: ["scandi", "scandinavian", "nordic"] },
    { label: "japandi", match: ["japandi"] },
    { label: "industrial", match: ["industrial", "loft"] },
    { label: "farmhouse / rustic", match: ["farmhouse", "rustic", "country"] },
    { label: "bohemian", match: ["boho", "bohemian"] },
    { label: "traditional / classic", match: ["traditional", "classic"] },
    { label: "art deco", match: ["deco"] },
    { label: "coastal", match: ["coastal", "beach", "nautical"] },
    { label: "maximalist", match: ["maximalist", "eclectic"] },
    { label: "minimalist", match: ["minimal", "minimalist"] },
  ],
};

/**
 * Home taste profile: {version, domain:"home", coverage, overall, boards}.
 * @param {object} opts
 * @param {object[]} opts.tags   parsed tags.jsonl rows
 * @param {object[]} opts.pins   parsed pins.jsonl rows
 * @param {number} [opts.halfLifeDays=730]
 * @param {number} [opts.minConfidence=0.5]
 * @param {Map<string,string>} [opts.boardDomains]  board slug -> domain (default: boards.json)
 */
export function aggregateHome({ tags, pins, halfLifeDays = 730, minConfidence = 0.5, boardDomains } = {}) {
  return buildProfile({
    domain: "home",
    tags,
    pins,
    halfLifeDays,
    minConfidence,
    boardDomains,
    usable: (tag) => tag.is_interior !== false,
    excludedKey: "not_interior",
    shareKey: "interior_share",
    summarise,
  });
}

function summarise(rows) {
  const rooms = new Counter();
  const types = new Counter();
  const materials = new Counter();
  const styles = new Counter();
  const colours = new Counter();
  const moods = new Counter();
  const eras = new Counter();
  const vibes = new Counter();
  const coloursByType = new Map(); // type -> Counter of colours
  let totalWeight = 0;

  // Raw (unweighted) appearances for `absences`.
  const seen = { rooms: [], items: [], materials: [], styles: [] };

  for (const r of rows) {
    const w = r.weight;
    const t = r.tag;
    totalWeight += w;
    rooms.add(t.room, w);
    moods.add(t.palette_mood, w);
    eras.add(t.era, w);
    seen.rooms.push(String(t.room ?? ""));

    const list = (xs) => (Array.isArray(xs) ? xs.filter((x) => x != null && String(x).trim()) : []);
    const styleList = list(t.styles);
    for (const s of styleList) {
      styles.add(s, w / styleList.length);
      seen.styles.push(String(s));
    }
    const vibeList = list(t.vibe_keywords);
    for (const v of vibeList) vibes.add(v, w / vibeList.length);

    const items = Array.isArray(t.items) ? t.items.filter((i) => i && typeof i === "object") : [];
    const iw = items.length ? w / items.length : 0;
    for (const it of items) {
      types.add(it.type, iw);
      materials.add(it.material, iw);
      colours.add(it.colour, iw);
      if (it.style) {
        // Item-level style is folded into the same distribution as the pin's styles.
        styles.add(it.style, iw);
        seen.styles.push(String(it.style));
      }
      const typeKey = String(it.type ?? "").toLowerCase().trim();
      if (typeKey) {
        if (!coloursByType.has(typeKey)) coloursByType.set(typeKey, new Counter());
        coloursByType.get(typeKey).add(it.colour, iw);
      }
      seen.items.push(`${it.type ?? ""}`);
      seen.materials.push(`${it.material ?? ""}`);
    }
  }

  const typeRows = types.rows("type");
  const itemColourByType = typeRows.slice(0, COLOUR_BY_TYPE_TYPES).map((tr) => ({
    type: tr.type,
    weight: tr.weight,
    colours: (coloursByType.get(tr.type)?.rows("colour", COLOUR_BY_TYPE_COLOURS) ?? []),
  }));

  return {
    pins_used: rows.length,
    weight_total: r4(totalWeight),
    rooms: rooms.rows("room"),
    item_types_top: typeRows.slice(0, ITEM_TYPES_TOP),
    materials: materials.rows("material"),
    styles: styles.rows("style"),
    palette: splitPalette(colours.rows("colour"), HOME_NEUTRALS, { secondaryCount: SECONDARY_COUNT, accentFloor: ACCENT_FLOOR }),
    palette_mood: moods.rows("mood"),
    era: eras.rows("era"),
    vibe_keywords_top: vibes.rows("keyword", VIBES_TOP),
    item_colour_by_type: itemColourByType,
    absences: scanAbsences([
      [ABSENCE_CANDIDATES.rooms, seen.rooms],
      [ABSENCE_CANDIDATES.items, seen.items],
      [ABSENCE_CANDIDATES.materials, seen.materials],
      [ABSENCE_CANDIDATES.styles, seen.styles],
    ]),
  };
}

export function summaryLinesHome(profile) {
  const o = profile.overall;
  const c = profile.coverage;
  const top = (rows, key, n = 3) =>
    rows.slice(0, n).map((r) => `${r[key]} ${(r.weight * 100).toFixed(0)}%`).join(", ") || "—";
  return [
    `home taste profile (${profile.version})`,
    `pins ${c.pins_total}, tagged ${c.tagged}, used ${c.used} (interior share ${(c.interior_share * 100).toFixed(0)}%), ${c.undated} undated`,
    `dates ${c.date_min ?? "?"} → ${c.date_max ?? "?"}, half-life ${c.half_life_days}d, min confidence ${c.min_confidence}`,
    `boards: ${c.boards.map((b) => `${b} (${profile.boards[b].pins_used})`).join(", ") || "—"}`,
    `rooms: ${top(o.rooms, "room", 4)}`,
    `items: ${top(o.item_types_top, "type", 5)}`,
    `materials: ${top(o.materials, "material", 4)}`,
    `styles: ${top(o.styles, "style", 4)}`,
    `neutrals ${(o.palette.neutral_share * 100).toFixed(0)}%: ${top(o.palette.neutrals, "colour")}`,
    `secondary: ${top(o.palette.secondary, "colour")}; accent: ${top(o.palette.accent, "colour", 4)}`,
    `mood: ${top(o.palette_mood, "mood")}; era: ${top(o.era, "era")}`,
    `vibes: ${top(o.vibe_keywords_top, "keyword", 5)}`,
    `absences (${o.absences.length}): ${o.absences.slice(0, 4).join("; ")}${o.absences.length > 4 ? "; …" : ""}`,
  ];
}
