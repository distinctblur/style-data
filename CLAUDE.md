# style-data — house conventions for agents

Private household dataset: what Meghan pins (and later: saves, wears, buys),
normalised once and reusable by any household project. Consumers today:
Atelier (`~/Developer/atelier`, wardrobe stylist) reads the fashion taste
profile. Intended later: purchase recommendations, gift ideas, home/furniture
inspiration. **This repo owns the data and the taxonomies; consumers copy
outputs, they never write here.**

**Read first:** `README.md` (layout, pipeline, schemas) → `docs/adr/` (newest wins).

## Conventions
- Branches `eng/distinctblur/<description>`; conventional commits
  `type: description`; author `lucas@russe.org` (repo-local).
- One root test command: `node --test 'pipeline/test/*.test.mjs'`. Node 24, ESM
  `.mjs`, no npm dependencies. Typecheck not applicable (plain JS); keep JSDoc
  on exported functions.
- Keyless mock mode: every external call (Pinterest, Gemini, Claude, R2) has a
  deterministic mock path; the whole pipeline runs with an empty `.dev.vars`.
- Live API spend is orchestrator-only, pre-authorised, and logged with
  `usageMetadata` in the records each script writes.
- Never commit secrets or pin images. `.dev.vars` and `out/` are gitignored;
  images live in the private R2 bucket `style-data` (Russe account).
- Data files under `data/` are committed (metadata, tags, profiles). They are
  about a real person: private repo only, never mirror elsewhere.
- Schemas are versioned (`schema_version` on every record). Add fields, never
  repurpose them; bump the version when a consumer could misread old rows.
- Taxonomies are per domain (`pipeline/taxonomies/<domain>.mjs`) and are the
  contract with consumers; Atelier's `packages/shared` taxonomy is a copy of
  `fashion.mjs` and must not drift from it.
- Update docs as you go: decisions in `docs/adr/` (dated), one-line pointer in
  the log below. Absolute dates only.

## Decisions log
- 2026-10-11: repo created from Atelier's `scripts/pinterest/` work; owner
  decisions (separate repo, R2 image retention, multi-board/multi-domain schema)
  in `docs/adr/0001-style-data-repo.md`.
