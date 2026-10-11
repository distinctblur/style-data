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

_pending_
