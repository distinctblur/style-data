# Pinterest extraction notes (2026-10-11)

How the three registered boards were pulled into `out/pins/` and normalised
into `data/pins.jsonl` (schema v2), what the Pinterest data looks like, and
which auth route was used. Decisions live in
[`adr/0001-style-data-repo.md`](adr/0001-style-data-repo.md); this file is the
operational record.

Boards (owner `megsk8`, all `privacy: public` in the board metadata; registered
in `boards.json` with their domain):

| slug | domain | pins reported by Pinterest (`board.pin_count`) | pins the feed exposes |
|---|---|---|---|
| `my-style` | fashion | 686 | 619 |
| `swim-look` | fashion | 9 | 8 |
| `for-the-home` | home | 364 | 336 |

Result of the 2026-10-11 run (`normalise.mjs` summary, re-run in this repo):

```
for-the-home (home): 336 pins, 2 dupes, 1 video, created_at 2011-12-19T20:20:24.000Z .. 2026-07-17T20:25:40.000Z; rich 150/336, with products 4, priced 13
my-style (fashion): 619 pins, 6 dupes, 5 video, created_at 2012-03-09T18:23:18.000Z .. 2026-08-17T00:37:16.000Z; rich 284/619, with products 33, priced 38
swim-look (fashion): 8 pins, 1 dupes, 0 video, created_at 2024-03-04T04:13:41.000Z .. 2024-03-19T01:08:11.000Z; rich 0/8, with products 0, priced 0
domains: home 336, fashion 627
total: 963 pins, 9 dupes (sha256), 6 video, 434 rich, 0 missing images, 0 extra files skipped, 0 unreadable sidecars
```

Every pin is dated (the detail pass supplies `created_at`), every pin has its
image. The 963 images are 890 `.jpg`, 59 `.png`, 11 `.webp`, 3 `.gif`; a count
of "949 images" is what `*.jpg` + `*.png` gives and simply misses the 14
`.webp`/`.gif` files. The gap between `pin_count` and what the feed returns is
Pinterest-side (deleted/unavailable pins are still counted): the
authenticated and unauthenticated feeds returned the identical set, so nothing
is hidden behind login.

## Layout in this repo

```
out/pins/<slug>/pinterest_<id>.<ext>             image (gitignored; long-term copy in R2)
out/pins/<slug>/pinterest_<id>.<ext>.json        pass-1 "grid" sidecar (BoardFeedResource, react_grid_pin field set)
out/pins/<slug>/detail/pinterest_<id>.<ext>.json pass-2 sidecar (PinResource; created_at, rich_metadata, hashtags, …)
out/pins/logs/<slug>.pins.txt                    the pin-URL list pass 2 reads (-i); plus the raw gallery-dl logs
out/pins/.cookies.txt                            0600 cookie jar, written for a run and removed after (unused so far)
data/pins.jsonl                                  normalised output, schema v2, committed
```

`out/` is downloaded, untrusted data: it is read and hashed, never executed
from. `normalise.mjs` ignores `out/pins/logs/` and any dot/underscore
directory, and treats every other sub-directory as a board slug.

## Tooling

- `uvx gallery-dl` (v1.32.16, cached by uv). No npm dependencies.
- Node 24, ESM `.mjs`, `node --test 'pipeline/test/*.test.mjs'` (the glob;
  Node 24 does not accept a directory).
- `pipeline/extract.mjs` wraps gallery-dl; its runner is injectable so the
  tests never spawn anything.

## Auth: which route worked

1. **Unauthenticated worked and is what produced the data.** Pinterest's
   `BoardFeedResource` and `PinResource` endpoints answered `200` with no
   cookies at all. The catch is that the unauthenticated board feed is flaky:
   roughly one run in two stops after the first page (24 pins) or returns zero
   pins. gallery-dl skips files it already has, so the fix is to re-run until
   the sidecar count stops growing; `extract.mjs --until-complete` automates
   that (below).
2. `--cookies-from-browser chrome|safari` was tried once for comparison (same
   619 pins) and then **withdrawn**: the owner does not want the keychain
   read. Do not use it.
3. **Session-cookie route: wired, not exercised.** `extract.mjs` resolves
   `PINTEREST_SESS` (environment, else `.dev.vars`), writes it to a 0600
   Netscape jar at `out/pins/.cookies.txt` for the run, passes
   `--cookies <jar>` to both passes and deletes the jar afterwards. The value
   never appears in argv (visible in `ps`), in logs (`maskArgv`) or in git.
   With the key empty, both passes run unauthenticated. No run on 2026-10-11
   used the cookie.

## Pipeline as it is now

### Pass 1 + pass 2: `pipeline/extract.mjs`

```sh
node pipeline/extract.mjs --dry-run --until-complete   # print both passes' argv (cookie masked), run nothing
node pipeline/extract.mjs --until-complete             # all boards in boards.json, sequentially
node pipeline/extract.mjs --board swim-look --range 1-5 --skip-detail
node pipeline/extract.mjs --detail-only                # pass 2 only, from the sidecars already on disk
```

Per board, in order:

1. **Board feed → images + grid sidecars**

   ```sh
   uvx gallery-dl --write-metadata -o stories=false -o videos=false [--range …] \
       [--cookies out/pins/.cookies.txt] -D out/pins/<slug> https://www.pinterest.com/megsk8/<slug>/
   ```

   `-o stories=false -o videos=false` make story ("idea") pins and video pins
   resolve to `images.orig` (the cover/poster image) instead of HLS video via
   yt-dlp, so every pin yields exactly one image and one sidecar. The sidecar
   still carries `is_video`, `videos` and `story_pin_data`, so `is_video` is
   derived correctly. Re-run without those two flags (and with yt-dlp on the
   path, e.g. `uvx --with yt-dlp gallery-dl`) if the videos or the extra story
   pages are ever wanted.

   With `--until-complete` this pass is repeated while the sidecar count
   grows: it stops when the count reaches the board's own `pin_count` (read
   from any sidecar's `board.pin_count`), after `--stall` consecutive attempts
   without growth (default 2, because the observed sequences were my-style
   24 → 619, for-the-home 24 → 24 → 336, swim-look 8 on every attempt), or
   after `--max-attempts` (default 6). Each attempt is logged with its exit
   code and sidecar count.

2. **Per-pin detail → `detail/` sidecars (metadata only).** The grid sidecar
   has **no `created_at`** (and no `rich_metadata`, `hashtags`, …); the
   per-pin `PinResource` does. The pin ids found in the pass-1 sidecars that
   have no detail sidecar yet are written as
   `https://www.pinterest.com/pin/<id>/` lines to `out/pins/logs/<slug>.pins.txt`
   and fetched with

   ```sh
   uvx gallery-dl --no-download --write-metadata --sleep-request 0.5 \
       [--cookies out/pins/.cookies.txt] -D out/pins/<slug>/detail -i out/pins/logs/<slug>.pins.txt
   ```

   Nothing pending → the pass is skipped. A pin still without a detail sidecar
   after the pass is reported; re-running retries only those.

Exit code 0 when every board's passes succeeded. The summary lists per board:
images, sidecars, detail sidecars, attempts, and per-pass status.

### Normalise: `pipeline/normalise.mjs`

```sh
node pipeline/normalise.mjs                       # --in out/pins --out data/pins.jsonl --boards boards.json
```

No network. Walks `<in>/<slug>/*.json`, merges `<in>/<slug>/detail/*.json` by
pin id, hashes each image (sha256), assigns `domain` from `boards.json`
(unregistered directory → `"unknown"` plus a stderr warning), de-duplicates by
sha256 across boards (earliest `created_at` keeps the hash, later ones get
`dupe_of`; nothing is dropped), sorts by board then `created_at` ascending
(undated last) then `pin_id`, and writes one JSON object per line. The stderr
summary has per-board counts (pins, dupes, video, date range, rich-data
coverage, products, priced), per-domain totals, and missing/extra/unreadable
file counts.

### Tests

```sh
node --test pipeline/test/normalise.test.mjs pipeline/test/extract.test.mjs
node --test 'pipeline/test/*.test.mjs'          # the one root command
```

The fixture `pipeline/test/fixtures/pins.sample.jsonl` is ten real v2 rows
from `data/pins.jsonl` (all three boards, the swim-look dupe pair, a video
pin, the earliest and latest pins, a pin with `rich.products`, a price-only
pin, an article) with `image_path` rewritten to
`test/fixtures/images/<pin_id>.jpg`; those image files intentionally do not
exist in the repo.

## `data/pins.jsonl` schema (schema_version 2)

One JSON object per line, keys in exactly this order, `null` when unknown.
Fields are added, never repurposed; the version bumps when a consumer could
misread old rows.

| key | type | source |
|---|---|---|
| `schema_version` | `2` | |
| `pin_id` | string | sidecar `id` |
| `source` | `"pinterest"` | constant today; later `instagram`, `atelier-wear-log`, … |
| `board` | string | `out/pins/<slug>` directory name = `boards.json` slug; not an enum |
| `domain` | string | `boards.json` domain for the slug (`fashion`, `home`, …); `"unknown"` when unregistered |
| `created_at` | ISO-8601 \| null | detail `created_at` (RFC 2822 → ISO); the grid sidecar has none |
| `title` | string \| null | `title`, else `grid_title`; empty → null. Never `seo_title` (keyword padding) |
| `description` | string \| null | `description`, else `closeup_unified_description` / `closeup_description` |
| `link` | string \| null | `link`, else detail `tracked_link` (product pages for purchase use) |
| `link_domain` | string \| null | `link_domain.id`, else sidecar `domain` unless "Uploaded by user", else hostname of `link`; lower-case |
| `dominant_color` | `#rrggbb` \| null | `dominant_color`, validated, lower-cased |
| `image_path` | string | absolute path of the local image under `out/pins/…` (valid on the machine that ran extract) |
| `image_url` | string \| null | `url` (= `images.orig.url`) |
| `image_width`, `image_height` | integer \| null | `width` / `height` (else `images.orig`) |
| `sha256` | hex \| null | of the local image; null only when the image is missing |
| `is_video` | boolean | `is_video`, or `videos` present, or a story video block |
| `dupe_of` | string, **only on dupes**, emitted right after `is_video` | pin_id of the earliest pin with the same sha256 |
| `alt_text` | string \| null | `seo_alt_text` ?? `auto_alt_text` (Pinterest's keyword string / auto caption) |
| `stats` | `{saves, repins, reactions}` (integers \| null) | `aggregated_pin_data.aggregated_stats.saves`, `repin_count`, sum of `reaction_counts` |
| `rich` | null \| object | see below; null when the pin has no rich data at all |
| `raw_extra` | object | `{hashtags: string[], pinner_username, native_creator_username, is_repin: boolean \| null, has_story_pin_data: boolean, ai_disclosures: []}` |

`rich` (compact rich-pin block from grid `rich_summary` + detail
`rich_metadata` + detail `price_value`/`price_currency`; no HTML, no favicons,
no provider blobs):

| key | type | source |
|---|---|---|
| `type` | string | `rich_summary.type_name` (`classifier data`, `article`, `product`, `main body text`, `movie`, …); derived `product` / `article` / `page` when only `rich_metadata` exists; `price` when only a detail price exists |
| `site_name` | string \| null | `rich_summary.site_name` ?? `rich_metadata.site_name` |
| `display_name` | string \| null | `rich_summary.display_name` ?? `rich_metadata.title` ?? `rich_metadata.article.name` |
| `display_description` | string \| null | same fallback chain on descriptions, **clipped to 500 characters** (`…`); the full text stays in the sidecar |
| `price_value` | number \| null | detail `price_value` when > 0 (Pinterest writes 0 for "none"), else the first product's price |
| `price_currency` | string \| null | detail `price_currency` when a price is set, else the first product's currency |
| `products` | array | `[{name, purchase_url, price, currency, in_stock}]` from `rich_metadata.products` (else `rich_summary.products`); `price` = `offer_summary.price_val`, `in_stock` = `offer_summary.in_stock` |

Coverage on 2026-10-11: rich 434/963 (my-style 284, for-the-home 150,
swim-look 0); 37 pins with products (33 fashion, 4 home); 51 priced.
`purchase_url` is null on every product so far.

**Link-rot caveat.** `rich.*` and `link_domain` describe the linked page *as
Pinterest crawled it now*, not what was pinned: a 2011 home-decor link
resolves today to an unrelated gambling page (`rich.type` "main body text",
`site_name` "DEWATOGEL"). For pins older than a few years prefer
`description`, `title`, `alt_text` and the image itself over `rich.*`.

Example row:

```json
{"schema_version":2,"pin_id":"134545107587394950","source":"pinterest","board":"for-the-home","domain":"home","created_at":"2011-12-19T20:20:24.000Z","title":"Electronics, Cars, Fashion, Collectibles & More | eBay","description":"bubbles","link":"http://svpply.com/item/110760/Tub_Caddy_made_of_Reclaimed_Oak","link_domain":"svpply.com","dominant_color":null,"image_path":"/Users/…/style-data/out/pins/for-the-home/pinterest_134545107587394950.jpg","image_url":"https://i.pinimg.com/originals/c2/83/84/c283840e34d03111a99425a3e48576a2.jpg","image_width":570,"image_height":570,"sha256":"7a26a566…","is_video":false,"alt_text":"two pictures of a bathtub in the snow with candles on it and an open magazine","stats":{"saves":33,"repins":2,"reactions":0},"rich":{"type":"classifier data","site_name":"eBay","display_name":"Electronics, Cars, Fashion, Collectibles & More | eBay","display_description":"Buy & sell electronics, …","price_value":null,"price_currency":null,"products":[]},"raw_extra":{"hashtags":[],"pinner_username":"megsk8","native_creator_username":null,"is_repin":true,"has_story_pin_data":false,"ai_disclosures":[]}}
```

## Raw-key inventory (what the sidecars hold beyond the schema)

Not in the schema but available in `out/pins` if wanted later:

- Grid sidecar (pass 1, every pin): `seo_alt_text` / `auto_alt_text`
  (`auto_alt_text` is populated on 97 % of home pins vs 7 % of fashion pins),
  `images` (170x … orig variants), `image_crop`,
  `aggregated_pin_data.aggregated_stats.saves`, `reaction_counts`,
  `repin_count`, `pinner` / `native_creator` (username, full name, id),
  `domain` (string: source site or "Uploaded by user"), `link_domain`
  (`{id}` on 302 pins), `is_repin` (786 true / 177 false), `rich_summary`
  (376 pins), `product_pin_data` / `product_metadata` (null on every pin),
  `story_pin_data` (4 pins; page/block structure of idea pins), `videos`,
  `board.*` (name, id, `pin_count`, `section_count`, `board_order_modified_at`).
- Detail sidecar (pass 2) adds: `created_at`, `section` (null: none of the
  boards has sections, `section_count: 0`), `pinned_to_board`, `hashtags`
  (44 pins), `description_html`, `closeup_*`, `seo_title` / `seo_description`,
  `pin_additional_note`, `closeup_user_note`, `rich_summary` (again, and
  populated on 45 pins where the grid copy is null, mostly `article`),
  `rich_metadata` (377 pins: article/product/recipe rich pins),
  `origin_pinner`, `via_pinner`, `share_count`, `comment_count`,
  `price_value` / `price_currency` (15 pins > 0, all USD), `content_sensitivity`,
  `ai_disclosures` (empty on every pin), `captions_urls` / `duration` /
  `thumbnail` (one video pin).
- **Rich pins / product data (home vs fashion).** Product and article data
  lives in `rich_summary` and `rich_metadata`, not in `product_*`.
  `rich_summary.type_name` on for-the-home: `classifier data` 92, `article`
  28, `product` 4. Raw keys: `rich_summary{type_name, url, site_name,
  display_name, display_description, products[], favicon_link,
  aggregate_rating}`; `rich_metadata{title, description, url, canonical_url,
  site_name, locale, link_status, article{...}, products[{name, id, item_id,
  purchase_url, offer_summary{price, price_val, currency, in_stock,
  availability}, offers, price_history_summary, variant_set, shipping_info,
  additional_images, brand}], has_price_drop, aggregate_rating}`. Field
  coverage is otherwise the same for home and fashion pins. Source `domain`
  differs as expected (home: houzz.com, bhg.com, etsy.com, marthastewart.com,
  parachutehome.com…; fashion: "Uploaded by user", etsy.com, polyvore.com…).

## Never commit

- Images, and anything under `out/`. `data/pins.jsonl` holds metadata only;
  `image_path` points at `out/pins` on the machine that ran extract.
- `out/pins/.cookies.txt` (session cookie jar) and `.dev.vars` (holds
  `PINTEREST_SESS`) are gitignored; `.dev.vars.example` documents the key name
  only.
