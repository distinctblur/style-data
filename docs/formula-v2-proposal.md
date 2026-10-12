# Proposal — fashion formula list v2 (2026-10-12)

**Status:** decided. The owner answered the seven open questions (§7) on
2026-10-12; the answers and the changes they produced are in **§8**, and the
figures in §4 are refreshed against the updated matcher. `fashion.tag.v2` is
now the fashion default (`TAG_PROMPT`, `PROMPT_VERSION`, `tagSchema`,
`validateTag` in `fashion.mjs`; `tag.mjs` without `--prompt-version`; mock
mode). v1 is untouched and still selectable with `--prompt-version v1`.
**Scope:** `pipeline/taxonomies/fashion.mjs` (`FORMULAS_V2`, `TAG_PROMPT_FASHION_V2`,
`fashion.tag.v2`), `pipeline/formula-assign.mjs`, `aggregate.mjs` /
`aggregate-fashion.mjs` (`formula_weights_v2`, `coverage.assumed_base_count`,
the 1095-day half-life), `tag.mjs`, `seed-profile.mjs` (one prompt sentence).
Sections 1–7 are the proposal as reviewed, with the §4 numbers updated.

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

## 4. `FORMULAS_V2` as decided (22 formulas + `other`)

Share = outfit pins assigned by `assignFormula` over the existing v1 tags
(no re-tagging yet), n = 432, by count and recency-weighted at the **new
default half-life of 1095 d** (§8 decision 6), from `aggregate.mjs --domain
fashion` run read-only to a scratch file on 2026-10-12 after the decisions
were applied. Slots: required first, optional in brackets, `|` = any of.
Rows 8–9 are the plain pairs added by decision 1; the former "no base visible"
formula is gone because decision 2 implies a jeans base for top-half crops.

| # | id | required slots | optional slots | pins | share | weighted |
|---|---|---|---|---|---|---|
| 1 | `jeans+cardigan+tee` | jeans + cardigan + t-shirt\|tank | necklace\|sunglasses\|scarf\|belt; shoes | 23 | 5.3% | 3.6% |
| 2 | `jeans+knit+shirt` | jeans + knit-sweater + shirt\|blouse | necklace\|scarf\|watch\|bracelet\|belt; shoes | 21 | 4.9% | 1.8% |
| 3 | `jeans+knit+scarf` | jeans + knit-sweater\|cardigan + scarf | boot\|ankle-boot; sunglasses | 11 | 2.5% | 1.0% |
| 4 | `jeans+knit+necklace` | jeans + knit-sweater\|cardigan + necklace\|bracelet\|watch | t-shirt\|tank\|shirt\|blouse; shoes | 13 | 3.0% | 2.5% |
| 5 | `jeans+blazer+tee` | jeans + blazer + t-shirt\|tank\|shirt\|blouse | necklace\|sunglasses\|scarf\|belt; shoes | 26 | 6.0% | 5.2% |
| 6 | `jeans+shirt+belt` | jeans + shirt\|blouse + belt\|necklace\|bracelet\|watch | shoes; sunglasses | 20 | 4.6% | 5.9% |
| 7 | `jeans+tee+sunglasses` | jeans + t-shirt\|tank + sunglasses\|scarf\|necklace\|belt\|bracelet\|hat | outerwear; shoes | 28 | 6.5% | 6.6% |
| 8 | `jeans+tee` (new, decision 1) | jeans + t-shirt\|tank | outerwear; shoes | 11 | 2.5% | 4.2% |
| 9 | `jeans+knit` (new, decision 1) | jeans + knit-sweater\|cardigan | t-shirt\|tank\|shirt\|blouse; shoes | 12 | 2.8% | 2.9% |
| 10 | `skirt+knit+boot` | mini\|midi\|maxi-skirt + knit-sweater\|cardigan + boot\|ankle-boot | tights; necklace\|belt\|scarf | 13 | 3.0% | 1.7% |
| 11 | `midi-skirt+fitted-top` (brief) | midi-skirt + any top | shoes; belt\|necklace | 11 | 2.5% | 0.8% |
| 12 | `skirt+top+heel` | mini\|midi\|maxi-skirt + any top | heel\|sandal\|flat; necklace\|belt\|bracelet\|sunglasses | 26 | 6.0% | 4.8% |
| 13 | `dress+cardigan` | any dress + cardigan\|denim-jacket\|blazer\|leather-jacket\|trench\|coat | shoes; belt\|necklace\|scarf\|sunglasses | 12 | 2.8% | 1.1% |
| 14 | `dress+boot` | any dress + boot\|ankle-boot | tights; belt\|scarf\|necklace\|sunglasses | 12 | 2.8% | 2.0% |
| 15 | `dress+necklace+sandal` | any dress | necklace\|earrings\|bracelet; sandal\|espadrille\|slide\|heel\|flat\|sneaker; sunglasses\|belt\|hat | 25 | 5.8% | 11.2% |
| 16 | `blazer+wide-leg-trouser+loafer` (brief) | trouser\|wide-leg-trouser\|culottes + blazer | t-shirt\|tank\|shirt\|blouse; loafer\|heel\|flat | 8 | 1.9% | 1.6% |
| 17 | `knit+trouser+loafer` (brief) | trouser\|wide-leg-trouser\|culottes + knit-sweater\|cardigan | shirt\|blouse; necklace\|watch\|belt; loafer\|flat\|heel\|sneaker | 27 | 6.3% | 6.2% |
| 18 | `trouser+shirt+heel` | trouser\|wide-leg-trouser\|culottes + shirt\|blouse\|t-shirt\|tank | heel\|flat\|loafer; necklace\|belt\|sunglasses\|watch | 16 | 3.7% | 4.3% |
| 19 | `leggings+knit+boot` | leggings + any top + boot\|ankle-boot | scarf\|hat\|gloves\|sunglasses | 17 | 3.9% | 2.4% |
| 20 | `athleisure` | leggings\|activewear\|sweatshirt | sweatshirt\|crop-top\|tank\|t-shirt\|knit-sweater\|cardigan; outerwear; sneaker\|heel\|flat\|sandal; sunglasses\|scarf\|hat\|necklace | 36 | 8.3% | 8.0% |
| 21 | `shorts+top+sandal` | shorts + any top | sandal\|sneaker\|espadrille\|slide; sunglasses\|belt\|hat\|necklace | 32 | 7.4% | 9.7% |
| 22 | `swim+cover-up` | one-piece\|bikini\|tankini\|swim-skirt\|rash-guard | cover-up\|kaftan\|sarong; hat\|sunglasses\|necklace\|bracelet\|earrings\|sandal\|slide\|espadrille\|basket | 9 | 2.1% | 6.0% |
| — | `other` | | | **23** | **5.3%** | **6.8%** |

**Coverage: 94.7% by count, 93.2% recency-weighted** (`formula_v2_coverage`
in the scratch profile), against the ≤ 25% residual target; before the
decisions it was 87.5% / 83.8% (54 residual pins). v1 on the same pins:
38% / 42%. Jeans formulas (1–9) together: 38% of outfit pins. **20 pins**
(`coverage.assumed_base_count`) were matched with the implied jeans base of
decision 2; they account for most of the rise in rows 2, 5–7 and 12.

Why by-count and weighted still differ: the half-life over pins dated
2012 → 2026-08 makes recent summers dominate, so dress + sandal, shorts and
swim rise by weight while the jeans + knit looks (older pins) fall. At 1095 d
the gap is narrower than it was at 730 d (dress + sandal 11.2% weighted
against 13.8% before; `jeans+knit+shirt` 1.8% against 0.7%), which is the
"lengthen a bit" of decision 6. Every weighted row also carries its raw
`count`, and the seed prompt now reads the two together (§8).

### 4.1 What is left in `other` (23 pins, tallied by nearest miss)

| residual group | pins | why it stays |
|---|---|---|
| dress alone, nothing else visible | 5 | decision 3: the threshold stays at 1.5 |
| top-half crop whose only finisher is earrings or a hair accessory (`blouse,earrings`, `earrings,hair-accessory,shirt`) | 4 | jeans is implied, but no jeans formula takes earrings as its accessory; a necklace would have made it `jeans+shirt+belt` |
| jeans + shoe / bag / vest only, no top or layer (`boot,jeans`, `jeans,sandal`, `crossbody,jeans,slide,vest`) | 4 | nothing on top to pair the jeans with |
| jeans + shirt/blouse with outerwear or a bag but no belt or jewelry | 3 | `jeans+shirt+belt` if its accessory became optional (not asked for) |
| outerwear-led with no top visible (`coat,scarf`, `cape,gloves,sunglasses,trouser`) | 2 | no `top` garment, so no base is implied |
| misc (crop-top + trouser + sneaker, shorts alone, bikini alone, lingerie, `other-accessory`) | 5 | genuinely not a formula |

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
| `matching-set`, `tonal-monochrome` | **dropped from v2** (confirmed, decision 4) | not expressible as garment slots (they are colour/fabric relations). The model used them for 13 pins (3%). A separate optional `styling` field is their future home, not `formula` |
| new: `jeans+cardigan+tee`, `dress+cardigan`, `leggings+knit+boot`, `skirt+top+heel`, `jeans+tee`, `jeans+knit` | **added** | the looks v1 had no name for; the two plain pairs by decision 1 |
| proposed `knit+shirt+necklace` (no base visible) | **not shipped** | superseded by decision 2: a top-half crop is matched with an implied jeans base, so its 5 pins land on `jeans+knit+shirt` |

## 6. What ships

Done on 2026-10-12 (this change set; see §8 for the per-decision detail):

1. `TAG_PROMPT` / `PROMPT_VERSION` / `tagSchema` / `validateTag` in
   `fashion.mjs` are the v2 contract (`DEFAULT_VERSION = "v2"`); the v1
   contract is byte-identical under `TAG_PROMPT_FASHION_V1`,
   `PROMPT_VERSION_V1`, `tagSchemaV1`, `validateTagV1` and `VERSIONS.v1`.
   `tag.mjs` without `--prompt-version` runs each domain at its own default
   (fashion v2, home v1); mock mode is v2 by default; `--prompt-version v1`
   still works.

Still to do, orchestrator-only:

2. Re-tag fashion only: `node pipeline/tag.mjs --domain fashion --only-missing`
   (now v2 by default; resume keys on prompt version, so the 926 existing
   `fashion.tag.v1` rows are *not* done for the v2 run and nothing collides;
   a row with no `prompt_version` counts as v1).
   Estimate: 614 pins × ≈ $0.0064 ≈ **$4** at the measured $0.0061/pin plus the
   longer prompt; needs owner pre-authorisation and a credit top-up check
   (the last run hit HTTP 402).
3. `aggregate.mjs --domain fashion` then reports the model's v2 `formula`
   under `formula_weights` and the deterministic assignment under
   `formula_weights_v2`; the two should agree closely — disagreement is the
   prompt-quality signal. Until the re-tag, `formula_weights` is still the v1
   answer and `formula_weights_v2` is the field to read.
4. Copy `pipeline/taxonomies/fashion.mjs` to Atelier `packages/shared`
   (must not drift) and note the decision in ADR-0001's log.

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

(Question numbering above refers to the table as proposed; the decided table
in §4 renumbers after the two plain pairs were inserted as rows 8–9.)

## 8. Decisions (owner, 2026-10-12)

Each answer, and the change made for it. Tests cover every item
(`pipeline/test/formula-assign.test.mjs`, `taxonomy.test.mjs`,
`aggregate.test.mjs`, `aggregate-home.test.mjs`, `tag.test.mjs`,
`seed-profile.test.mjs`).

1. **Plain pairs — yes.** `jeans+tee` (jeans + t-shirt|tank, optional
   outerwear and shoes) and `jeans+knit` (jeans + knit-sweater|cardigan,
   optional tee/collar underneath and shoes) are formulas. They have four slots
   each against five for every three-slot jeans formula, so the existing
   tie-break (higher score, then more slots, then list order) always sends a
   pin with an accessory to the richer formula; a test pins the exact tie
   case (`jeans, cardigan, scarf, blouse, sneaker` scores 3.0 for both
   `jeans+knit+scarf` and `jeans+knit` and goes to the former). +23 pins
   named (11 + 12).
2. **Top-half crops — no `tee+necklace` formula; assume jeans.** When a pin
   has at least one `top` garment and no bottom / dress / swim garment at all,
   `assignFormula` adds an implied `jeans` garment and matches whole-look
   formulas; the result carries `assumed_base: "jeans"` (null otherwise), and
   `assignFormula(…, { assumeBase: false })` switches it off. Owner: "95%
   chance in real life it's denim". The v2 prompt gained the sentence
   *"If the bottom half is cropped out, assume jeans when choosing the
   formula."* and no longer mentions a cropped formula. `aggregate.mjs`
   coverage gained `assumed_base_count` (fashion only): **20** of 432 used
   pins. Consequence, flagged: the proposed `knit+shirt+necklace` (no base
   visible) formula became unreachable (any pin it could match now gets jeans
   implied and lands on `jeans+knit+shirt` / `jeans+knit+necklace` /
   `jeans+knit`), so it was removed rather than left as a dead enum value.
3. **Dress alone — keep the threshold.** A dress with no second piece scores
   1.0 (< 1.5) and stays `other`; 5 pins. Test added; `minScore` remains a
   parameter.
4. **`matching-set` / `tonal-monochrome` — dropped from v2, confirmed.**
   Tests assert they are absent from `FORMULAS_V2`, `tagSchemaV2`'s enum and
   the v2 prompt, and present in v1. A code comment in `fashion.mjs` names a
   separate optional `styling` field as their future home. v1 untouched.
5. **Naming — keep the shorthand ids.** No change.
6. **Recency — keep, lengthen to 3 years.** Owner moved from Illinois to
   California in 2016, so cold-weather pins should fade, but 730 d made the
   profile a single-summer one. `DEFAULT_HALF_LIFE_DAYS = 1095` in
   `aggregate.mjs` (both domains, CLI default, usage text, README);
   `--half-life-days` still overrides. Every weighted list already carries its
   raw `count` (now asserted for every list and scope). `SEED_PROMPT_V1`
   gained exactly one sentence: *"Where a share and its raw count disagree (a
   large count with a small share), say that it was a bigger interest in the
   past."* Nothing else in that prompt changed, and its version id is unchanged.
7. **Brief trio — keep all three under their v1 ids.** No change.

**Default flipped to v2** (not one of the seven, but gated on this review):
the fashion module's domain-interface aliases now resolve to v2
(`DEFAULT_VERSION = "v2"`), `tag.mjs` runs each domain at its own default
when `--prompt-version` is omitted (fashion v2, home v1), mock mode is v2 by
default, and v1 stays selectable. `--only-missing` keys on
(pin_id, domain, prompt_version), so the existing `fashion.tag.v1` rows are
not treated as done for a v2 run; a legacy row with no `prompt_version` is
keyed as v1, never as the current default (both tested).

Figures in this section and §4: `node pipeline/aggregate.mjs --domain fashion`
run read-only to a scratch file on 2026-10-12, half-life 1095 d, over the
existing v1 tags (613 tagged, 432 outfit pins).

## Reproduce

```sh
node --test 'pipeline/test/*.test.mjs'                       # 144 tests incl. the §8 decisions, v2 default, half-life
node pipeline/aggregate.mjs --domain fashion --out /tmp/x.json  # formula_weights_v2 + formula_v2_coverage + coverage.assumed_base_count, half-life 1095 d
node pipeline/tag.mjs --mock --domain fashion --limit 3 --out /tmp/mock-v2.jsonl   # keyless records, fashion.tag.v2 by default
node pipeline/tag.mjs --mock --domain fashion --prompt-version v1 --limit 3 --out /tmp/mock-v1.jsonl   # v1 still selectable
```
