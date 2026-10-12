# ADR-0001 — A household style-data repo (2026-10-11)

**Status:** accepted (owner, 2026-10-11)
**Context:** Atelier (`~/Developer/atelier`) started mining Meghan's public
Pinterest boards as the seed for its standing style profile
(Atelier ADR-0003). Mid-build the owner observed that the same data serves
purchase recommendations, gift ideas and home/furniture inspiration, and asked
for it to be stored generally enough for other projects.

## Decisions

| # | Topic | Decision | Consequence |
|---|---|---|---|
| 1 | Home | **Separate private repo** `distinctblur/style-data`, created before Atelier's first commit of the pipeline. Atelier consumes a copy of `data/profiles/fashion.taste-profile.json`; it does not own the pipeline. | Atelier's `scripts/pinterest/` and `docs/inspo/` move here as `pipeline/` and `data/`. |
| 2 | Images | **Kept long-term in the private R2 bucket `style-data`** (Russe account, created 2026-10-11), key `pins/<board>/<pin_id>.<ext>`, never public, deletable on request. Supersedes Atelier ADR-0003 #8 ("images are scratch"). | Enables visual-similarity use ("find something like this"). Upload script has a dry-run mode. |
| 3 | Boards and domains | Any number of boards, registered in `boards.json` with a `domain` (`fashion`, `home`, …). Records carry `board`, `domain`, `source` (`pinterest` today; `instagram`, `atelier-wear-log`, … later) and `schema_version`. | Third board `for-the-home` (interiors) added on day one. |
| 4 | Tagging | One tagger, **per-domain taxonomy and prompt** (`pipeline/taxonomies/<domain>.mjs`). Fashion: garments, formulas, palette, formality. Home: room, item type, style, materials, palette. Rich-pin product data (brand, price, product title, source domain) is preserved verbatim from the sidecar in `raw_extra`. | The pin `link` plus product data is what purchase recommendations need. |
| 5 | Profiles | Per-domain aggregates (`data/profiles/<domain>.taste-profile.json`) are the reusable output. Project-specific drafts (Atelier's "correct me" standing profile) are produced here too but consumed there. | Consumers never re-derive from raw pins. |
| 6 | Retention | Metadata, tags and profiles kept while the household uses the data; images in R2 deletable on request. Nothing here is served publicly. | Private repo, private bucket. |
| 7 | Spend | Live Gemini/Claude calls are orchestrator-only, pre-authorised, logged with `usageMetadata`. | Actuals recorded below per run. |

## Pipeline

```
node pipeline/extract.mjs   [--board slug] → out/pins/<board>/   (gallery-dl, cookie from .dev.vars)
node pipeline/normalise.mjs                → data/pins.jsonl      (all boards, schema v2)
node pipeline/upload-images.mjs [--dry-run]→ R2 style-data        (wrangler, idempotent)
node pipeline/tag.mjs --domain fashion|home → data/tags.jsonl     (Gemini vision per pin, mock without key)
node pipeline/aggregate.mjs --domain …     → data/profiles/<domain>.taste-profile.json
node pipeline/seed-profile.mjs             → data/profiles/fashion.profile-draft.md (Claude, mock without key)
```

## Runs

| Date | Step | Result |
|---|---|---|
| 2026-10-11 | extract (3 boards) | 963 pins (my-style 619, swim-look 8, for-the-home 336); 9 sha256 dupes, 6 video, 0 missing images. Public boards fetched **unauthenticated**; the cookie route was never needed. Pinterest's own pin counts (686/9/364) include deleted pins. Details: `docs/extraction-notes-2026-10-11.md`. |
| 2026-10-11 | normalise v2 | 963 rows; rich-pin data on 434 (products 37, priced 51); `purchase_url` null throughout, `link` is the product pointer. |
| 2026-10-11 | upload-images | see `data/images.jsonl` (954 objects, 111 MB). |
| 2026-10-11 | tag (live, `gemini-3.6-flash`, $0.75/$3.75 per MTok) | Owner approved a $10 cap; 5-pin pilot $0.03 → projected $5.72. Run tagged **635** (home 330/330, fashion 305/614) for **$3.83**, 99.8% at confidence ≥ 0.6, then **306 calls failed with HTTP 402: the Gemini project's prepaid credits were depleted** (not the cap). 3 validation failures (model put `cardigan` under `outerwear`; taxonomy has it under `top`). Owner topped up credits; resumed with `--only-missing`: +308 tagged for $1.92. **Final: 943 of 944 taggable pins tagged (fashion 613/614, home 330/330), $5.75 total.** The one remaining pin (134545107589975070) is a collage that always exceeds the 12-garment limit; left untagged. |
| 2026-10-11 | aggregate home | `data/profiles/home.taste-profile.json`: 249 interiors used of 330 tagged; warm-neutral, transitional/traditional/boho, brown/white/beige 80% neutral, dark and light wood. |
| 2026-10-12 | aggregate fashion | `data/profiles/fashion.taste-profile.json`: 432 outfit pins used of 613 tagged; v1 formula `other` 58%, **v2 matcher coverage 84% weighted / 87.5% by count** (`docs/formula-v2-proposal.md`, awaiting owner review before the prompt flips to v2). Caveat: the 730-day half-life makes the weighted view a summer-2026 profile (dress+sandal, shorts, swim) while by count jeans-layered looks dominate; both numbers are in the JSON and the draft says so. |
| 2026-10-12 | seed-profile (live, `claude-opus-5-5`, effort high) | First attempt truncated at 8k output tokens (thinking counts as output); rerun with 16k: 13,954 in / 7,547 out (5,644 thinking), **$0.21**. Output `data/profiles/fashion.profile-draft.md`, copied to Atelier `docs/inspo/`. Total live spend this project: **$5.96** of the $10 cap. |
| 2026-10-12 | formula v2 review + re-tag | Owner answered the seven open questions (`docs/formula-v2-proposal.md` §8): plain jeans+tee / jeans+knit added, cropped tops assume a jeans base, dress alone stays `other`, matching-set/tonal dropped from formula, shorthand ids kept, half-life lengthened to 1095 days (moved to California in 2016; cold-weather pins should fade), brief trio kept. Prompt default flipped to `fashion.tag.v2`; **re-tagged 602 of 614 fashion pins for $4.14** (12 validation failures keep their v1 tag). Model-side `other` fell from 58% to 17%; slot-matcher coverage 94%. Profile rebuilt (`tag_versions`: v2 602, v1 11) and draft regenerated ($0.23). **Total live spend: $10.34.** |
| 2026-10-12 | survey | Meghan completed the 13-screen style quiz (claude.ai artifact, answers in `data/profiles/fashion.survey-2026-10-12.json`). Confirms the jeans-layered uniform (jeans + cardigan/knit + tee/necklace, sporty day clothes), relaxed/layered shapes, neutral base incl. denim and brown, both metals. **Contradicts the recency-weighted view**: she did not pick the dress + sandals or shorts looks (shorts: rarely), so the summer-2026 skew is seasonal pinning, not a shift in uniform. New facts the pins could not give: always cold; pockets, machine-washable, regular-bra, nothing itchy; heels only for a dinner out; under 5 minutes to dress; a load of laundry most days; never prints, logos, sequins, ruffles, turtlenecks, mini skirts, matching sets, dry-clean; happily wool, blazers, trench, wide-leg, maxi, jumpsuits, sleeveless, statement jewellery; wants tomorrow's outfit picked the night before and to use more of what she owns. |
| 2026-10-11 | finding | 67% of fashion outfit pins map to formula `other`: the brief §2.3 stylist formulas do not describe her look (layered jeans + cardigan/knit + tee + necklace/scarf/sunglasses). Added `garment_combos_top` (emergent co-occurring garment sets) to the fashion aggregate so the profile does not depend on the named-formula list; a `formula.v2` list derived from those combos is the follow-up, gated by the human prompt review. |
