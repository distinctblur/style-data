// style-data — deterministic outfit-formula assignment from a pin's garments.
//
// The first live fashion tagging run filed 65% of outfit pins under formula
// `other`: the v1 FORMULAS (stylist-textbook triples such as
// blazer+wide-leg-trouser+loafer) do not describe her layered-casual look. The
// v2 formulas (`FORMULAS_V2` in ./taxonomies/fashion.mjs, proposal in
// docs/formula-v2-proposal.md) are base + layer + accessory slots derived from
// the garment sets that actually co-occur in her pins, and this module assigns
// them from the tagged `garments[]` alone, so the profile no longer depends on
// the model's single `formula` guess.
//
// Matching: a slot `{name, any: [subcategory or category ids], required}` is
// filled by one garment whose subcategory or category is in `any`; a garment
// fills at most one slot. A formula is a candidate when every required slot is
// filled. score = required slots filled + 0.5 × optional slots filled. The
// winner is the candidate with the highest score, ties broken by the formula
// with more slots (more specific), then by list order. A best score below
// `minScore` (default MIN_SCORE = 1.5, i.e. "two things that belong together")
// is `other`. Pure functions, no I/O.

import { FORMULAS_V2, SUBCATEGORY_TO_CATEGORY } from "./taxonomies/fashion.mjs";

export const MIN_SCORE = 1.5;
export const OPTIONAL_WEIGHT = 0.5;

/** Normalise one garment (object or bare subcategory string) to {category, subcategory}. */
function normGarment(g) {
  if (typeof g === "string") return { subcategory: g, category: SUBCATEGORY_TO_CATEGORY[g] ?? null };
  if (!g || typeof g !== "object") return { subcategory: null, category: null };
  const subcategory = g.subcategory ?? null;
  const category = g.category ?? (subcategory ? SUBCATEGORY_TO_CATEGORY[subcategory] : null) ?? null;
  return { subcategory, category };
}

const slotAccepts = (slot, g) => slot.any.includes(g.subcategory) || slot.any.includes(g.category);

/**
 * Best assignment of garments to one formula's slots (one garment per slot).
 * Exhaustive over the candidate garments of each slot; slots are few and
 * candidates per slot are fewer, so this is cheap.
 * @returns {{score:number, matched:string[], missingRequired:string[]}}
 */
export function matchFormula(formula, garments) {
  const gs = garments.map(normGarment);
  const slots = formula.slots ?? [];
  const candidates = slots.map((s) => gs.map((g, i) => (slotAccepts(s, g) ? i : -1)).filter((i) => i >= 0));
  let best = { score: -1, matched: [] };
  const used = new Set();
  const matched = [];
  const walk = (si, score) => {
    if (si === slots.length) {
      if (score > best.score) best = { score, matched: matched.slice() };
      return;
    }
    const slot = slots[si];
    for (const gi of candidates[si]) {
      if (used.has(gi)) continue;
      used.add(gi);
      matched.push(slot.name);
      walk(si + 1, score + (slot.required ? 1 : OPTIONAL_WEIGHT));
      matched.pop();
      used.delete(gi);
    }
    walk(si + 1, score); // leave this slot empty
  };
  walk(0, 0);
  const missingRequired = slots.filter((s) => s.required && !best.matched.includes(s.name)).map((s) => s.name);
  return { score: best.score, matched: best.matched, missingRequired };
}

/**
 * Assign the best-fitting formula to a garment list.
 * @param {Array<{category?:string, subcategory?:string}|string>} garments  a tag's garments[] (or bare subcategory ids)
 * @param {Array<{id:string, slots:Array<{name:string, any:string[], required:boolean}>}>} [formulas=FORMULAS_V2]
 * @param {{minScore?:number}} [opts]
 * @returns {{formula:string, score:number, matched_slots:string[], missing_required:string[]}}
 *   For `other`, `score`/`matched_slots`/`missing_required` describe the nearest
 *   miss (the highest-scoring formula that was not a candidate), so a residual
 *   can be read as "would be X if it had Y".
 */
export function assignFormula(garments, formulas = FORMULAS_V2, { minScore = MIN_SCORE } = {}) {
  const gs = Array.isArray(garments) ? garments : [];
  let winner = null;
  let nearest = null;
  formulas.forEach((f, order) => {
    if (f.id === "other" || !(f.slots?.length)) return;
    const m = matchFormula(f, gs);
    const row = { formula: f.id, score: m.score, matched_slots: m.matched, missing_required: m.missingRequired, slots: f.slots.length, order };
    if (m.missingRequired.length === 0 && m.score >= minScore) {
      if (!winner || row.score > winner.score || (row.score === winner.score && (row.slots > winner.slots || (row.slots === winner.slots && row.order < winner.order)))) winner = row;
    } else if (!nearest || row.score > nearest.score || (row.score === nearest.score && row.order < nearest.order)) {
      nearest = row;
    }
  });
  if (winner) return { formula: winner.formula, score: winner.score, matched_slots: winner.matched_slots, missing_required: [] };
  return {
    formula: "other",
    score: nearest ? nearest.score : 0,
    matched_slots: nearest ? nearest.matched_slots : [],
    missing_required: nearest ? nearest.missing_required : [],
    nearest: nearest ? nearest.formula : null,
  };
}

/**
 * Convenience: assign a formula to every tag row that has a tag.
 * @param {Array<{pin_id:string, tag:object|null}>} tagRows  tags.jsonl rows
 * @param {object} [opts]  passed to assignFormula ({formulas, minScore})
 * @returns {Array<{pin_id:string, formula_v1:string|null, formula:string, score:number, matched_slots:string[], missing_required:string[]}>}
 */
export function assignAll(tagRows, { formulas = FORMULAS_V2, minScore = MIN_SCORE } = {}) {
  const out = [];
  for (const r of tagRows ?? []) {
    if (!r?.tag || typeof r.tag !== "object") continue;
    const a = assignFormula(r.tag.garments, formulas, { minScore });
    out.push({ pin_id: r.pin_id, formula_v1: r.tag.formula ?? null, ...a });
  }
  return out;
}
