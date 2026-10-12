# style-data

Private household dataset of what Meghan pins (later: saves, wears, buys),
normalised once and reusable by any household project. This repo owns the raw
metadata, the per-domain taxonomies and the aggregated taste profiles;
consumers copy the outputs and never write here. Decisions:
[`docs/adr/0001-style-data-repo.md`](docs/adr/0001-style-data-repo.md).

Everything here is about a real person: private repo, private R2 bucket,
nothing served publicly, images deletable on request.

## Layout

| path | what |
|---|---|
| `boards.json` | Registered Pinterest boards: `slug`, `url`, `domain` (`fashion`, `home`, …). Add a board here; nothing else needs to change. |
| `pipeline/` | The scripts, in pipeline order below. Node 24, ESM `.mjs`, no npm dependencies. |
| `pipeline/taxonomies/<domain>.mjs` | Per-domain tag vocabulary; the contract with consumers (Atelier's `packages/shared` taxonomy is a copy of `fashion.mjs`). |
| `pipeline/test/` | `node --test` suites, one per script, all offline. |
| `data/` | Committed outputs: `pins.jsonl`, `tags.jsonl`, `images.jsonl`, `profiles/<domain>.taste-profile.json`. Metadata only, never images. |
| `out/` | Gitignored scratch: downloaded images and gallery-dl sidecars (`out/pins/<board>/`). |
| `docs/adr/` | Dated decision records, newest wins. |

## Setup

```sh
cp .dev.vars.example .dev.vars   # gitignored; leave a key empty to run that step in mock mode
```

`.dev.vars` keys:

- `PINTEREST_SESS` — the `_pinterest_sess` cookie of a logged-in Pinterest
  session. In Safari: open pinterest.com while logged in, then
  **Develop > Show Web Inspector > Storage > Cookies > pinterest.com** and copy
  the value of `_pinterest_sess`. Without it the public boards are fetched
  unauthenticated, which works but is flaky (the feed sometimes stops after
  the first page; just re-run, gallery-dl skips files it already has).
  The value is never printed and never committed; `extract.mjs --dry-run`
  masks it.
- `GEMINI_API_KEY` — tagging (`tag.mjs`). Empty → deterministic mock tags.
- `ANTHROPIC_API_KEY` — profile draft (`seed-profile.mjs`). Empty → mock draft.

Tools outside this repo:

- `uv` / `uvx` (Homebrew) — runs `gallery-dl` 1.32.16 without installing it.
- `wrangler` 4.x — not a dependency here; `upload-images.mjs` uses
  `../studio/node_modules/.bin/wrangler` by default, override with
  `WRANGLER=/path/to/wrangler`. Needs a Cloudflare login that can write the
  `style-data` bucket (Russe account).

## Pipeline

Run from the repo root, in this order. Every step writes a summary to stderr
and exits non-zero on failure.

```sh
# 1. Download every pin of every board in boards.json (images + JSON sidecars), two passes
node pipeline/extract.mjs --until-complete      # all boards; repeats pass 1 while the flaky feed still grows, then pass 2
node pipeline/extract.mjs --board swim-look     # one or more boards
node pipeline/extract.mjs --dry-run --until-complete  # print both passes' masked argv, run nothing
#    pass 1 → out/pins/<slug>/pinterest_<id>.<ext> + .json sidecars (board feed; no created_at)
#      uvx gallery-dl --write-metadata -o stories=false -o videos=false [--range …]
#        [--cookies out/pins/.cookies.txt] -D out/pins/<slug> <board url>
#    pass 2 → out/pins/<slug>/detail/*.json (per-pin detail: created_at, rich metadata, price)
#      uvx gallery-dl --no-download --write-metadata --sleep-request 0.5 -D out/pins/<slug>/detail
#        -i out/pins/logs/<slug>.pins.txt
#    (stories/videos=false makes every pin yield exactly one cover image; public boards need no cookie)

# 2. Normalise the sidecars into one metadata file (no network)
node pipeline/normalise.mjs                     # → data/pins.jsonl (schema v2)

# 3. Upload the images to the private R2 bucket (idempotent, append-only manifest)
node pipeline/upload-images.mjs --dry-run       # list keys + byte total, run nothing
node pipeline/upload-images.mjs [--limit 20] [--concurrency 2]
#    → R2 style-data/pins/<board>/<pin_id>.<ext>, manifest data/images.jsonl
#    each object: wrangler r2 object put style-data/<key> --file <path> --content-type <mime> --remote

# 4. Tag each pin with its domain's taxonomy (Gemini vision; mock without key)
node pipeline/tag.mjs --domain fashion          # fashion.tag.v2 by default; --prompt-version v1 still selectable
node pipeline/tag.mjs --domain home             # → data/tags.jsonl (home.tag.v1)

# 5. Aggregate tags into the per-domain profile (recency half-life 1095 days; --half-life-days N to override)
node pipeline/aggregate.mjs --domain fashion    # → data/profiles/fashion.taste-profile.json

# 6. Draft the Atelier standing profile for her to correct (Claude; mock without key)
node pipeline/seed-profile.mjs                  # → data/profiles/fashion.profile-draft.md

# Tests (the one root test command)
node --test 'pipeline/test/*.test.mjs'
```

Every script prints its full option list with `--help`; defaults are the paths
above. `tag.mjs` and `aggregate.mjs` with no `--domain` process every domain in
one run. `docs/extraction-notes-2026-10-11.md` records how the first download
went (auth findings, retry behaviour, raw sidecar keys).

## Schemas

All files are JSONL (one JSON object per line) unless stated, `null` when
unknown, and carry `schema_version`. Fields are added, never repurposed.

### `data/pins.jsonl` (schema_version 2) — from `normalise.mjs`

Keys in exactly this order, `null` when unknown.

| key | type | notes |
|---|---|---|
| `schema_version` | 2 | |
| `pin_id` | string | Pinterest pin id |
| `source` | `"pinterest"` | later: `instagram`, `atelier-wear-log`, … |
| `board` | string | board slug = `out/pins/<slug>` directory = `boards.json` slug |
| `domain` | string | the board's domain from `boards.json` (`fashion`, `home`); `"unknown"` for an unregistered directory (warned on stderr) |
| `created_at` | ISO-8601 \| null | from the pass-2 detail sidecar (the board feed has none) |
| `title`, `description`, `link` | string \| null | `link` is the pin's outbound URL (product pages for purchase use); `title` never uses `seo_title` |
| `link_domain` | string \| null | `link_domain.id`, else source `domain` (unless "Uploaded by user"), else hostname of `link`; lower-case |
| `dominant_color` | `#rrggbb` \| null | |
| `image_path` | string | absolute local path under `out/pins/…` (scratch; valid on the machine that ran extract) |
| `image_url` | string \| null | original Pinterest image URL |
| `image_width`, `image_height` | integer \| null | pixels |
| `sha256` | hex \| null | of the local image; null only when the image is missing |
| `is_video` | boolean | |
| `dupe_of` | string, only on dupes (right after `is_video`) | pin_id of the earliest pin with the same `sha256` |
| `alt_text` | string \| null | `seo_alt_text` ?? `auto_alt_text` |
| `stats` | `{saves, repins, reactions}` | integers or null |
| `rich` | object \| null | `{type, site_name, display_name, display_description (≤500 chars), price_value, price_currency, products: [{name, purchase_url, price, currency, in_stock}]}` from `rich_summary` + `rich_metadata` + detail price. Describes the linked page **as crawled now** (link rot: prefer `description`/`alt_text`/the image for old pins) |
| `raw_extra` | object | `{hashtags: string[], pinner_username, native_creator_username, is_repin, has_story_pin_data: boolean, ai_disclosures: []}` — the only raw keys kept verbatim |

### `data/images.jsonl` (schema_version 1) — from `upload-images.mjs`

Append-only manifest of what is in R2. One row per successful upload; a pin
appears again only if its `sha256` changed.

```json
{"schema_version":1,"pin_id":"…","board":"my-style","r2_key":"pins/my-style/<pin_id>.jpg","sha256":"…","bytes":123456,"content_type":"image/jpeg","uploaded_at":"2026-10-11T12:00:00.000Z"}
```

### `data/tags.jsonl` — from `tag.mjs`

```json
{"pin_id":"…","board":"my-style","domain":"fashion","model":"gemini-…|mock","prompt_version":"tag.v1","tag":{…}|null,"error":null|"…","usage":{…}|null,"cost_usd":0.0|null,"ms":123}
```

`tag` follows the domain's taxonomy (`pipeline/taxonomies/<domain>.mjs`);
`usage` is the provider's `usageMetadata` for live calls.

### `data/profiles/<domain>.taste-profile.json` — from `aggregate.mjs`

One JSON document per domain: weighted distributions of the taxonomy values
(recency-weighted, low-confidence tags dropped) plus the pin counts behind
them. Shape is owned by `aggregate.mjs`; see its header. Project-specific
drafts (Atelier's `fashion.profile-draft.md`) live next to it.

## Rules

- **Mock mode.** With an empty `.dev.vars` the whole pipeline still runs end
  to end: `extract --dry-run` and `upload-images --dry-run` do no network;
  `tag` and `seed-profile` produce deterministic fixture output without keys.
  Tests never touch the network, gallery-dl or wrangler (runners are injected).
- **Spend.** Live Gemini/Claude calls and R2 uploads are orchestrator-only and
  pre-authorised. Every live call writes its `usageMetadata` into the record;
  actuals are logged per run in the ADR.
- **Secrets and images.** `.dev.vars`, `out/` and `.cookies.txt` are
  gitignored. Images live only in `out/` (scratch) and the private R2 bucket
  `style-data`; never in git, never mirrored.
- **Downloaded files are untrusted data.** Nothing is executed from `out/`.

## Consumers

- **Atelier** (`~/Developer/atelier`) copies
  `data/profiles/fashion.taste-profile.json` (and reads the corrected standing
  profile derived from `fashion.profile-draft.md`). It keeps its own copy of
  `pipeline/taxonomies/fashion.mjs` which must not drift.
- Intended later: purchase recommendations (pin `link` + `raw_extra` product
  data), gift ideas, home/furniture inspiration (`home` domain), and
  visual-similarity search over the R2 images.
