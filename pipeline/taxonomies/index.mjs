// style-data domain registry — one module per domain (ADR-0001 #3/#4), each
// exporting the same interface:
//   DOMAIN          "fashion" | "home" | ...
//   PROMPT_VERSION  e.g. "fashion.tag.v1" (written on every tag record)
//   TAG_PROMPT      the current versioned prompt (TAG_PROMPT_<DOMAIN>_V<n>)
//   tagSchema       Gemini responseSchema
//   validateTag(obj) -> {ok, errors[]}
// plus the domain's vocabulary arrays. `boards.json` maps each board to one of
// these domain names.

import * as fashion from "./fashion.mjs";
import * as home from "./home.mjs";

export const DOMAINS = Object.freeze({ fashion, home });
export const DOMAIN_NAMES = Object.freeze(Object.keys(DOMAINS));

/**
 * Look up a domain module by name.
 * @param {string} name
 * @throws {Error} when the domain is not registered
 */
export function getDomain(name) {
  const d = DOMAINS[name];
  if (!d) throw new Error(`unknown domain '${name}' (known: ${DOMAIN_NAMES.join(", ")}); register it in pipeline/taxonomies/index.mjs and boards.json`);
  return d;
}
