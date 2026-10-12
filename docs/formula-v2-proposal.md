# Proposal — fashion formula list v2 (2026-10-12)

**Status:** proposed, awaiting the owner's prompt/taxonomy review (house rule:
prompt and taxonomy changes get a human review before they ship).
**Scope:** `pipeline/taxonomies/fashion.mjs` (`FORMULAS_V2`, `TAG_PROMPT_FASHION_V2`,
`fashion.tag.v2`), `pipeline/formula-assign.mjs`, `aggregate-fashion.mjs`
(`formula_weights_v2`), `tag.mjs --prompt-version v2`. Nothing v1 changed; the
default prompt is still `fashion.tag.v1` until this is approved.

## 1. Problem

The first live run (ADR-0001, Runs table, "finding") filed **62% of her outfit
pins under `other`** (268 of 432; 58% recency-weighted). The v1 list is a
stylist textbook (blazer + wide-leg trouser + loafer, slip dress + sandal …);
her pins are layered casual: jeans, a knit or cardigan over a tee or collared
shirt, finished with a necklace, scarf, belt or sunglasses. The named-formula
distribution is therefore the least informative part of the profile, and
Atelier's styling engine (which composes outfits by formula) would have nothing
to lean on.

## 2. Method

1. Read every fashion row of `data/tags.jsonl` with `is_outfit: true` and a
   non-null tag (read-only; home rows ignored).
2. Count subcategory presence and co-occurring pairs / triples / quads of
   subcategories per pin (one pin = one vote regardless of garment count).
3. Group pins by **base** (jeans / dress / trouser / skirt / leggings / shorts /
   swim / no visible base) and read off the layers and finishing accessories
   each base is worn with.
4. Write formulas as **base + layer + accessory slots**. A slot is
   `{name, any: [subcategory or category ids], required}`; the id names the
   most common filler of each slot, `any` lists the pieces that count.
5. Assign deterministically with `assignFormula(garments)`
   (`pipeline/formula-assign.mjs`): one garment fills at most one slot; a
   formula is a candidate when all its required slots are filled;
   score = required filled + 0.5 × optional filled; highest score wins, ties go
   to the formula with more slots, then to list order; best score < 1.5 is
   `other`. The matcher runs over the model's `garments[]`, so the v2 numbers
   below come from the **existing v1 tags without any re-tagging**.
6. Iterate the list against the residual (`other`) pins until the residual is
   only looks that genuinely lack a layer or accessory.

## 3. Data (snapshot 2026-10-12 00:06 UTC)

`data/tags.jsonl`: 1,256 rows; fashion tagged **613 of 614** taggable pins
(tagging finished during this work; the one untagged pin is a collage over the
12-garment limit). Outfit pins (`is_outfit: true`): **432** (my-style 425,
swim-look 7); non-outfit 181. Mean 4.9 garments per outfit pin. Silhouette:
layered 35%, relaxed 19%, fitted 14%, volume-top-slim-bottom 13%. Formality:
2 = 51%, 3 = 31%. Occasion: everyday 44%, weekend 13%, work 12%.

### 3.1 Garments present (share of outfit pins containing the piece)

| subcategory | pins | share | | subcategory | pins | share |
|---|---|---|---|---|---|---|
| jeans | 161 | 37.3% | | belt | 63 | 14.6% |
| necklace | 126 | 29.2% | | heel | 62 | 14.4% |
| sunglasses | 122 | 28.2% | | shoulder-bag | 60 | 13.9% |
| t-shirt | 110 | 25.5% | | boot | 57 | 13.2% |
| knit-sweater | 105 | 24.3% | | watch | 56 | 13.0% |
| shirt | 88 | 20.4% | | trouser | 54 | 12.5% |
| cardigan | 78 | 18.1% | | leggings | 47 | 10.9% |
| scarf | 78 | 18.1% | | blazer | 47 | 10.9% |
| bracelet | 68 | 15.7% | | sandal | 44 | 10.2% |
| tote | 67 | 15.5% | | sneaker | 35 | 8.1% |
| tank | 64 | 14.8% | | | | |

Categories: top 85%, bottom 80%, shoes 61%, accessory 55%, jewelry 53%, bag
43%, outerwear 21%, dress 13%, swim 2.5%.

### 3.2 Base garment (first match in this order)

| base | pins | share |
|---|---|---|
| jeans | 161 | 37.3% |
| dress | 56 | 13.0% |
| trouser (trouser / wide-leg / culottes) | 53 | 12.3% |
| skirt (mini 25+, midi 17+, maxi 2+) | 50 | 11.6% |
| leggings | 46 | 10.6% |
| shorts | 33 | 7.6% |
| no visible base (cropped to the top half) | 20 | 4.6% |
| swim | 10 | 2.3% |
| none / other | 3 | 0.7% |

### 3.3 Co-occurring subcategory sets (share of outfit pins containing the whole set)

| pair | pins | share | | triple | pins | share | | quad | pins | share |
|---|---|---|---|---|---|---|---|---|---|---|
| jeans+t-shirt | 57 | 13.2% | | jeans+sunglasses+t-shirt | 19 | 4.4% | | jeans+scarf+sunglasses+tote | 8 | 1.9% |
| jeans+sunglasses | 53 | 12.3% | | jeans+scarf+sunglasses | 18 | 4.2% | | jeans+knit-sweater+necklace+shirt | 8 | 1.9% |
| jeans+necklace | 50 | 11.6% | | jeans+necklace+t-shirt | 18 | 4.2% | | blazer+jeans+necklace+t-shirt | 8 | 1.9% |
| jeans+knit-sweater | 46 | 10.6% | | blazer+jeans+t-shirt | 17 | 3.9% | | belt+jeans+necklace+t-shirt | 8 | 1.9% |
| jeans+scarf | 38 | 8.8% | | jeans+sunglasses+tote | 16 | 3.7% | | boot+leggings+scarf+sunglasses | 7 | 1.6% |
| jeans+shirt | 38 | 8.8% | | jeans+t-shirt+tote | 16 | 3.7% | | blazer+jeans+t-shirt+tote | 7 | 1.6% |
| sunglasses+t-shirt | 36 | 8.3% | | jeans+knit-sweater+shirt | 16 | 3.7% | | jeans+scarf+t-shirt+tote | 7 | 1.6% |
| knit-sweater+shirt | 35 | 8.1% | | belt+jeans+necklace | 16 | 3.7% | | jeans+knit-sweater+shirt+shoulder-bag | 7 | 1.6% |
| jeans+tote | 34 | 7.9% | | jeans+necklace+shirt | 16 | 3.7% | | knit-sweater+necklace+shirt+watch | 7 | 1.6% |
| necklace+shirt | 34 | 7.9% | | jeans+knit-sweater+sunglasses | 15 | 3.5% | | blazer+jeans+scarf+tote | 6 | 1.4% |
| cardigan+t-shirt | 34 | 7.9% | | knit-sweater+necklace+shirt | 15 | 3.5% | | jeans+sunglasses+t-shirt+tote | 6 | 1.4% |
| cardigan+jeans | 32 | 7.4% | | cardigan+jeans+t-shirt | 15 | 3.5% | | jeans+knit-sweater+scarf+sunglasses | 6 | 1.4% |

Reading: no single triple exceeds 4.4%, so formulas cannot be literal top
triples; what repeats is the *structure* — a base, one or two layers from a
small set, and one finishing accessory from a small set. Layers per jeans pin:
two in 61%, one in 27%, three in 9%. The accessory that finishes a look is a
necklace (29%), sunglasses (28%), scarf (18%), belt (15%), bracelet/watch
(16%/13%), which is why the v1 list, which has no accessory slots, could not
name these looks.

## 4. Proposed `FORMULAS_V2` (21 formulas + `other`)

Share = outfit pins assigned by `assignFormula` over the current v1 tags,
n = 432 (by count) and recency-weighted (half-life 730 d; `data/profiles` style,
from `aggregate.mjs --domain fashion` run read-only to a scratch file).
Slots: required first, optional in brackets, `|` = any of.

| # | id | required slots | optional slots | pins | share | weighted |
|---|---|---|---|---|---|---|
| 1 | `jeans+cardigan+tee` | jeans + cardigan + t-shirt\|tank | necklace\|sunglasses\|scarf\|belt; shoes | 23 | 5.3% | 2.8% |
| 2 | `jeans+knit+shirt` | jeans + knit-sweater + shirt\|blouse | necklace\|scarf\|watch\|bracelet\|belt; shoes | 18 | 4.2% | 0.7% |
| 3 | `jeans+knit+scarf` | jeans + knit-sweater\|cardigan + scarf | boot\|ankle-boot; sunglasses | 10 | 2.3% | 0.5% |
| 4 | `jeans+knit+necklace` | jeans + knit-sweater\|cardigan + necklace\|bracelet\|watch | t-shirt\|tank\|shirt\|blouse; shoes | 13 | 3.0% | 2.4% |
| 5 | `jeans+blazer+tee` | jeans + blazer + t-shirt\|tank\|shirt\|blouse | necklace\|sunglasses\|scarf\|belt; shoes | 25 | 5.8% | 4.4% |
| 6 | `jeans+shirt+belt` | jeans + shirt\|blouse + belt\|necklace\|bracelet\|watch | shoes; sunglasses | 19 | 4.4% | 6.4% |
| 7 | `jeans+tee+sunglasses` | jeans + t-shirt\|tank + sunglasses\|scarf\|necklace\|belt\|bracelet\|hat | outerwear; shoes | 22 | 5.1% | 5.7% |
| 8 | `skirt+knit+boot` | mini\|midi\|maxi-skirt + knit-sweater\|cardigan + boot\|ankle-boot | tights; necklace\|belt\|scarf | 13 | 3.0% | 1.1% |
| 9 | `midi-skirt+fitted-top` (brief) | midi-skirt + any top | shoes; belt\|necklace | 11 | 2.5% | 0.3% |
| 10 | `skirt+top+heel` | mini\|midi\|maxi-skirt + any top | heel\|sandal\|flat; necklace\|belt\|bracelet\|sunglasses | 25 | 5.8% | 4.6% |
| 11 | `dress+cardigan` | any dress + cardigan\|denim-jacket\|blazer\|leather-jacket\|trench\|coat | shoes; belt\|necklace\|scarf\|sunglasses | 12 | 2.8% | 0.5% |
| 12 | `dress+boot` | any dress + boot\|ankle-boot | tights; belt\|scarf\|necklace\|sunglasses | 12 | 2.8% | 1.7% |
| 13 | `dress+necklace+sandal` | any dress | necklace\|earrings\|bracelet; sandal\|espadrille\|slide\|heel\|flat\|sneaker; sunglasses\|belt\|hat | 25 | 5.8% | 13.8% |
| 14 | `blazer+wide-leg-trouser+loafer` (brief) | trouser\|wide-leg-trouser\|culottes + blazer | t-shirt\|tank\|shirt\|blouse; loafer\|heel\|flat | 8 | 1.9% | 1.5% |
| 15 | `knit+trouser+loafer` (brief) | trouser\|wide-leg-trouser\|culottes + knit-sweater\|cardigan | shirt\|blouse; necklace\|watch\|belt; loafer\|flat\|heel\|sneaker | 27 | 6.3% | 6.0% |
| 16 | `trouser+shirt+heel` | trouser\|wide-leg-trouser\|culottes + shirt\|blouse\|t-shirt\|tank | heel\|flat\|loafer; necklace\|belt\|sunglasses\|watch | 16 | 3.7% | 3.7% |
| 17 | `leggings+knit+boot` | leggings + any top + boot\|ankle-boot | scarf\|hat\|gloves\|sunglasses | 17 | 3.9% | 1.7% |
| 18 | `athleisure` | leggings\|activewear\|sweatshirt | sweatshirt\|crop-top\|tank\|t-shirt\|knit-sweater\|cardigan; outerwear; sneaker\|heel\|flat\|sandal; sunglasses\|scarf\|hat\|necklace | 36 | 8.3% | 7.0% |
| 19 | `shorts+top+sandal` | shorts + any top | sandal\|sneaker\|espadrille\|slide; sunglasses\|belt\|hat\|necklace | 32 | 7.4% | 10.5% |
| 20 | `swim+cover-up` | one-piece\|bikini\|tankini\|swim-skirt\|rash-guard | cover-up\|kaftan\|sarong; hat\|sunglasses\|necklace\|bracelet\|earrings\|sandal\|slide\|espadrille\|basket | 9 | 2.1% | 8.1% |
| 21 | `knit+shirt+necklace` (no base visible) | knit-sweater\|cardigan + shirt\|blouse | necklace\|watch\|bracelet\|scarf | 5 | 1.2% | 0.2% |
| — | `other` | | | **54** | **12.5%** | **16.2%** |

**Coverage: 87.5% by count, 83.8% recency-weighted** (`formula_v2_coverage` in
the preview profile), against the ≤ 25% residual target. v1 on the same pins:
38% / 42%. Jeans formulas (1–7) together: 30% of outfit pins.

Why by-count and weighted differ so much: the profile's half-life (730 d) over
pins dated 2012 → 2026-08 makes summer 2026 dominate, so dress + sandal, shorts
and swim rise to the top by weight while the jeans + knit looks (older pins)
fall. That is the aggregate's existing behaviour, not something v2 introduces,
but it is worth a glance in the same review: see open question 6.

### 4.1 What is left in `other` (54 pins, hand-tallied)

| residual group | pins | would become |
|---|---|---|
| cropped to the top half, no base, not knit-over-shirt (`t-shirt,necklace`, `blouse,earrings`, `tank,sunglasses`, …) | 17 | stays `other` unless a `tee+necklace` top-half formula is wanted (open question 2) |
| jeans + tee with no accessory and no layer (`tank,jeans`, `t-shirt,jeans`, `denim-jacket,t-shirt,jeans`, …) | 9 | a plain `jeans+tee` (open question 1) |
| jeans + knit/cardigan with no shirt, scarf or jewelry (`knit-sweater,jeans,flat`, …) | 9 | a plain `jeans+knit` (open question 1) |
| dress alone, nothing else visible | 5 | `dress+necklace+sandal` if the threshold drops to 1.0 (open question 3) |
| jeans + shoe only (`jeans,boot`) | 3 | stays `other` |
| jeans + shirt/blouse with no belt or jewelry | 3 | `jeans+shirt+belt` if its accessory became optional |
| misc (lingerie, swimsuit alone, cape + trouser, crop-top + trouser, shorts alone, `other-accessory`) | 8 | stays `other` |

## 5. v1 → v2 mapping

| v1 id | v2 | why |
|---|---|---|
| `blazer+wide-leg-trouser+loafer` | **kept** (#14) | brief §2.3; 8 pins |
| `midi-skirt+fitted-top` | **kept** (#9) | brief §2.3; 11 pins |
| `knit+trouser+loafer` | **kept** (#15), widened to cardigan + optional shirt/necklace | brief §2.3; her most common trouser look (27 pins) |
| `athleisure` | **kept** (#18), widened: leggings + anything not boots | 36 pins; the model's second-most-used v1 id |
| `jeans+tee+sneaker` | **renamed** → `jeans+tee+sunglasses` (#7) | sneaker is rare (8%); the finishing accessory is what repeats |
| `jeans+blazer+heel` | **renamed** → `jeans+blazer+tee` (#5) | heel optional; the tee/shirt under the blazer is the constant |
| `jeans+knit+boot` | **split** → `jeans+knit+shirt`, `jeans+knit+scarf`, `jeans+knit+necklace` (#2–4) | the model used this id for 31 pins; what distinguishes them is the layer/accessory, boots are optional |
| `jeans+shirt+flat` | **renamed** → `jeans+shirt+belt` (#6) | flat optional, belt/jewelry is the finisher |
| `cardigan+skirt+flat` | **absorbed** by `skirt+knit+boot` / `skirt+top+heel` (#8, #10) | |
| `mini-skirt+jacket+boot`, `midi-dress+boot`, `leather-jacket+dress+boot` | **absorbed** by `dress+boot`, `dress+cardigan`, `skirt+knit+boot` | each ≤ 5 pins in v1 |
| `slip-dress+sandal`, `shirt-dress+flat` | **absorbed** by `dress+necklace+sandal` (#13) | slip/shirt dresses are 1–2 pins each |
| `tailored-trouser+shirt+heel` | **renamed** → `trouser+shirt+heel` (#16) | |
| `shorts+shirt+sandal` | **renamed** → `shorts+top+sandal` (#19) | tanks and knits as often as shirts |
| `swimsuit+cover-up+sandal`, `swimsuit-only` | **merged** → `swim+cover-up` (#20) | 10 swim pins in total |
| `trench+jeans+loafer`, `jumpsuit+heel` | **dropped** | 0 pins each; a trench over jeans falls under #7's optional outerwear |
| `matching-set`, `tonal-monochrome` | **dropped from v2** | not expressible as garment slots (they are colour/fabric relations). The model used them for 13 pins (3%). If wanted they belong in a separate `styling` field, not in `formula` (open question 4) |
| new: `jeans+cardigan+tee`, `dress+cardigan`, `leggings+knit+boot`, `skirt+top+heel`, `knit+shirt+necklace` | **added** | the looks v1 had no name for |

## 6. What ships if approved

1. `TAG_PROMPT` / `PROMPT_VERSION` aliases in `fashion.mjs` move to v2 (one
   line each); `tag.mjs` default `--prompt-version` becomes `v2`.
2. Re-tag fashion only: `node pipeline/tag.mjs --domain fashion --prompt-version v2 --only-missing`
   (resume keys on prompt version, so v1 rows stay and nothing collides).
   Estimate: 614 pins × ≈ $0.0064 ≈ **$4** at the measured $0.0061/pin plus the
   longer prompt; needs owner pre-authorisation and a credit top-up check
   (the last run hit HTTP 402).
3. `aggregate.mjs --domain fashion` then reports the model's v2 `formula`
   under `formula_weights` and the deterministic assignment under
   `formula_weights_v2`; the two should agree closely — disagreement is the
   prompt-quality signal for the review.
4. Copy `pipeline/taxonomies/fashion.mjs` to Atelier `packages/shared`
   (must not drift) and note the decision in ADR-0001's log.

Until then nothing changes for callers: v1 exports are byte-identical, the
default prompt is v1, and `formula_weights_v2` is an *additional* field
computed from existing tags.

## 7. Open questions for the owner

1. **Plain two-slot formulas.** Should `jeans+tee` and `jeans+knit` with no
   accessory count as formulas (+18 pins, residual 12.5% → 8.3%)? The matcher's
   1.5 threshold currently says a base + one layer with nothing finishing it is
   not yet "a formula". Atelier's engine would treat them as the starting point
   it adds an accessory to.
2. **Top-half pins.** 17 residual pins are crops with no base visible
   (`t-shirt,necklace`, `blouse,earrings`). Add a `tee+necklace` formula (it
   would describe the necklace-over-tee habit, 29% of pins wear a necklace), or
   leave them as `other` because they say nothing about the bottom half?
3. **Dress alone.** 5 pins are a dress and nothing else tagged. Lower the
   threshold to 1.0 for #13 (dress is the whole look), or keep?
4. **`matching-set` / `tonal-monochrome`.** Drop from `formula` (proposed) and
   add a separate optional `styling` enum later, or keep them in the v2 enum
   even though the slot matcher can never produce them?
5. **Naming.** Ids name the most common filler (`jeans+knit+necklace` also
   accepts a bracelet or watch; `leggings+knit+boot` accepts any top). The v2
   prompt spells every slot out so the model is not misled; is the shorthand
   acceptable for Atelier's UI, or should ids be literal (`jeans+knit+jewelry`)?
6. **Recency weighting.** With a 730-day half-life the weighted profile is a
   summer-2026 profile (dress + sandal 14%, shorts 10%, swim 8%). Keep (it is
   "what she pins now"), lengthen the half-life, or report both?
7. **The three brief formulas** are kept under their v1 ids (#9, #14, #15)
   even though #14 is 1.9% of pins. Confirm that Atelier still wants them
   named for its methodology.

## Reproduce

```sh
node --test 'pipeline/test/*.test.mjs'                       # 137 tests incl. formula-assign, v2 taxonomy, tag --prompt-version
node pipeline/aggregate.mjs --domain fashion --out /tmp/x.json  # formula_weights_v2 + formula_v2_coverage, summary line "formulas v2:"
node pipeline/tag.mjs --mock --domain fashion --prompt-version v2 --limit 3 --out /tmp/mock-v2.jsonl   # keyless v2 records
```
