import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { aggregate, parseJsonl } from "../aggregate.mjs";
import {
  SEED_PROMPT_V1,
  SECTIONS,
  DEFAULT_MODEL,
  API_VERSION,
  FALLBACK_BETA,
  buildRequest,
  parseResponseText,
  mockDraft,
  mockConstraints,
  renderDraft,
  seedProfile,
  costOf,
  findApiKey,
  estimateTokens,
} from "../seed-profile.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// Same inline pins fixture as aggregate.test.mjs (kept separate so importing
// it does not re-register that file's tests here).
const PINS = [
  { pin_id: "p01", board: "my-style", created_at: "2026-09-20T10:00:00Z", dominant_color: "#111111" },
  { pin_id: "p02", board: "my-style", created_at: "2026-08-01T10:00:00Z", dominant_color: "#1b2a4a" },
  { pin_id: "p03", board: "my-style", created_at: null, dominant_color: "#c8a76b" },
  { pin_id: "p04", board: "my-style", created_at: "2026-03-10T10:00:00Z", dominant_color: "#2b2b2b" },
  { pin_id: "p05", board: "my-style", created_at: "2026-02-01T10:00:00Z", dominant_color: null },
  { pin_id: "p06", board: "my-style", created_at: "2025-11-01T10:00:00Z", dominant_color: "#d02020" },
  { pin_id: "p07", board: "my-style", created_at: "2025-06-15T10:00:00Z", dominant_color: "#7a1f2e" },
  { pin_id: "p08", board: "my-style", created_at: "2022-01-10T10:00:00Z", dominant_color: "#4a6fa5" },
  { pin_id: "p09", board: "swim-look", created_at: "2026-07-01T10:00:00Z", dominant_color: "#f0e6c8" },
  { pin_id: "p10", board: "swim-look", created_at: "2026-06-01T10:00:00Z", dominant_color: "#6b6b2a" },
  { pin_id: "p11", board: "swim-look", created_at: "2025-07-01T10:00:00Z", dominant_color: "#1f8a8a" },
  { pin_id: "p12", board: "swim-look", created_at: "2025-07-02T10:00:00Z", dominant_color: "#e8752a" },
];
const SCRIPT = path.join(DIR, "..", "seed-profile.mjs");
const FIXTURE = path.join(DIR, "fixtures", "tags.sample.jsonl");

const PROFILE = aggregate({ tags: parseJsonl(fs.readFileSync(FIXTURE, "utf8")), pins: PINS });
const NO_KEY_ENV = { STYLE_DATA_DEV_VARS: "/nonexistent/.dev.vars" };
const CONSTRAINT_KEYS = ["preferred_formulas", "silhouettes", "palette", "formality_band", "avoid_candidates", "notes"];

const headingsIn = (md) => SECTIONS.filter((s) => md.includes(`## ${s}`));

function cannedReply(markdown, constraints) {
  return `${markdown}\n\n\`\`\`json parsed_constraints_json\n${JSON.stringify(constraints)}\n\`\`\``;
}
const LIVE_MD = SECTIONS.map((s) => `## ${s}\nYou seem to like black (7 of 9 pins, 34%).`).join("\n\n");
const LIVE_CONSTRAINTS = {
  preferred_formulas: ["blazer+wide-leg-trouser+loafer"],
  silhouettes: ["slim-top-wide-bottom"],
  palette: { neutrals: ["black", "white"], secondary: ["olive"], accent: [] },
  formality_band: [3, 4],
  avoid_candidates: ["never pins: jumpsuit"],
  notes: "Thin data.",
};
function cannedMessage(overrides = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: cannedReply(LIVE_MD, LIVE_CONSTRAINTS) },
    ],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 4000, output_tokens: 1500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...overrides,
  };
}
function fakeFetch(message, { status = 200, onRequest } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (onRequest) onRequest(url, init);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(message) };
  };
  impl.calls = calls;
  return impl;
}

test("SEED_PROMPT_V1 names all six sections and the JSON block", () => {
  for (const s of SECTIONS) assert.ok(SEED_PROMPT_V1.includes(`## ${s}`), `prompt missing ${s}`);
  assert.ok(SEED_PROMPT_V1.includes("parsed_constraints_json"));
  for (const k of CONSTRAINT_KEYS) assert.ok(SEED_PROMPT_V1.includes(`"${k}"`), `prompt missing key ${k}`);
  assert.ok(SEED_PROMPT_V1.includes("second person"));
  // Owner decision 2026-10-12 (formula-v2-proposal §8, recency): the draft reads count and share together.
  assert.ok(SEED_PROMPT_V1.includes("Where a share and its raw count disagree (a large count with a small share), say that it was a bigger interest in the past."));
  assert.ok(SEED_PROMPT_V1.includes("`count` is the raw number of pins behind it."), "the count sentence that precedes it is unchanged");
});

test("mock draft has all six headings, checklist boxes and a parsable JSON block", () => {
  const { markdown, constraints } = mockDraft(PROFILE);
  assert.deepEqual(headingsIn(markdown), SECTIONS);
  assert.ok((markdown.match(/^- \[ \] /gm) ?? []).length >= 6);
  assert.ok(markdown.includes("Something I missed"));
  assert.ok(/\(\d+ of \d+ pins, \d+%\)/.test(markdown), "claims cite their share");
  assert.ok(markdown.includes("never pins: jumpsuit"));
  assert.ok(!/!/.test(markdown.replace(/!\[/g, "")), "no exclamation marks");

  const rendered = renderDraft({ markdown, constraints });
  const back = parseResponseText(rendered);
  assert.deepEqual(back.constraints, constraints);
  assert.deepEqual(Object.keys(back.constraints), CONSTRAINT_KEYS);
  assert.equal(back.constraints.preferred_formulas[0], "blazer+wide-leg-trouser+loafer");
  assert.ok(back.constraints.palette.neutrals.includes("black"));
  assert.deepEqual(back.constraints.formality_band, [1, 4]);
  assert.ok(back.constraints.avoid_candidates.includes("never pins: jumpsuit"));
  // Deterministic.
  assert.deepEqual(mockDraft(PROFILE), mockDraft(JSON.parse(JSON.stringify(PROFILE))));
});

test("mock handles a missing swim board and an empty profile without throwing", () => {
  const noSwim = { ...PROFILE, boards: { "my-style": PROFILE.boards["my-style"] } };
  const { markdown } = mockDraft(noSwim);
  assert.deepEqual(headingsIn(markdown), SECTIONS);
  assert.match(markdown, /swim-look board has 0 usable pins/);
  const empty = mockDraft({ overall: {}, coverage: {}, boards: {} });
  assert.deepEqual(headingsIn(empty.markdown), SECTIONS);
  assert.deepEqual(mockConstraints({ overall: {} }).formality_band, [1, 5]);
});

test("buildRequest: current Messages shape for claude-opus-5-5", () => {
  const req = buildRequest(PROFILE, { effort: "high" });
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["anthropic-version"], API_VERSION);
  assert.equal(req.headers["anthropic-beta"], FALLBACK_BETA);
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.system, SEED_PROMPT_V1);
  assert.deepEqual(req.body.output_config, { effort: "high" });
  assert.equal(req.body.fallbacks, "default");
  assert.equal(req.body.messages.length, 1);
  assert.equal(req.body.messages[0].role, "user");
  assert.ok(req.body.messages[0].content.includes('"formula_weights"'));
  assert.ok(!("thinking" in req.body), "thinking is adaptive by default on Opus 5.5; budget_tokens would 400");
  assert.ok(!("temperature" in req.body));
  assert.ok(estimateTokens(req.body.system) > 400);
});

test("live path: fake fetchImpl response is parsed into markdown + JSON, usage and cost logged", async () => {
  const logs = [];
  const fetchImpl = fakeFetch(cannedMessage(), {
    onRequest: (url, init) => {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["x-api-key"], "sk-test");
      assert.equal(init.headers["anthropic-version"], API_VERSION);
      assert.equal(init.headers["anthropic-beta"], FALLBACK_BETA);
      const body = JSON.parse(init.body);
      assert.equal(body.model, DEFAULT_MODEL);
      assert.equal(body.max_tokens, 8000);
    },
  });
  const r = await seedProfile(PROFILE, { apiKey: "sk-test", fetchImpl, priceIn: 4, priceOut: 20, log: (l) => logs.push(l) });
  assert.equal(r.mode, "live");
  assert.equal(r.model, DEFAULT_MODEL);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(headingsIn(r.markdown), SECTIONS);
  assert.ok(!r.markdown.includes("```"));
  assert.deepEqual(r.constraints, LIVE_CONSTRAINTS);
  assert.deepEqual(r.usage, { input_tokens: 4000, output_tokens: 1500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  assert.equal(r.cost_usd, 0.046); // 4000*4/1e6 + 1500*20/1e6
  assert.equal(logs.length, 1);
  const logged = JSON.parse(logs[0]);
  assert.equal(logged.event, "seed-profile");
  assert.equal(logged.usage.output_tokens, 1500);
  assert.equal(logged.cost_usd, 0.046);
  // Without prices, cost is null.
  const r2 = await seedProfile(PROFILE, { apiKey: "sk-test", fetchImpl: fakeFetch(cannedMessage()), log: () => {} });
  assert.equal(r2.cost_usd, null);
});

test("costOf: null without prices, counts cache tokens as input", () => {
  assert.equal(costOf({ input_tokens: 10 }, null, 20), null);
  assert.equal(costOf(null, 4, 20), null);
  assert.equal(costOf({ input_tokens: 1000, cache_read_input_tokens: 1000, output_tokens: 100 }, 4, 20), 0.01);
});

test("missing key falls back to mock without calling fetch", async () => {
  const logs = [];
  const fetchImpl = async () => assert.fail("fetch must not be called in mock mode");
  const r = await seedProfile(PROFILE, { env: NO_KEY_ENV, fetchImpl, log: (l) => logs.push(l) });
  assert.equal(r.mode, "mock");
  assert.deepEqual(headingsIn(r.markdown), SECTIONS);
  assert.deepEqual(Object.keys(r.constraints), CONSTRAINT_KEYS);
  assert.equal(r.usage, null);
  assert.ok(logs.some((l) => /no ANTHROPIC_API_KEY/.test(l)));
  // Explicit --mock also skips fetch even with a key.
  const r2 = await seedProfile(PROFILE, { mock: true, apiKey: "sk-test", fetchImpl, log: () => {} });
  assert.equal(r2.mode, "mock");
  assert.equal(findApiKey({ env: NO_KEY_ENV }), null);
  assert.equal(findApiKey({ env: { ANTHROPIC_API_KEY: " sk-env " } }), "sk-env");
});

test("findApiKey reads the repo .dev.vars pattern", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "style-data-devvars-"));
  const p = path.join(tmp, ".dev.vars");
  fs.writeFileSync(p, 'GEMINI_API_KEY=abc\nANTHROPIC_API_KEY="sk-file"\n');
  assert.equal(findApiKey({ env: {}, devVarsPath: p }), "sk-file");
  assert.equal(findApiKey({ env: { STYLE_DATA_DEV_VARS: p } }), "sk-file");
});

test("live path errors: HTTP error, refusal, truncation, malformed reply", async () => {
  await assert.rejects(
    seedProfile(PROFILE, { apiKey: "k", fetchImpl: fakeFetch({ type: "error", error: { type: "authentication_error", message: "bad key" } }, { status: 401 }), log: () => {} }),
    /HTTP 401 authentication_error: bad key/,
  );
  await assert.rejects(
    seedProfile(PROFILE, { apiKey: "k", fetchImpl: fakeFetch(cannedMessage({ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" } })), log: () => {} }),
    /declined \(refusal, general_harms\)/,
  );
  await assert.rejects(
    seedProfile(PROFILE, { apiKey: "k", fetchImpl: fakeFetch(cannedMessage({ stop_reason: "max_tokens" })), log: () => {} }),
    /truncated at max_tokens/,
  );
  await assert.rejects(
    seedProfile(PROFILE, { apiKey: "k", fetchImpl: fakeFetch(cannedMessage({ content: [{ type: "text", text: "## Just prose, no block" }] })), log: () => {} }),
    /no parsed_constraints_json block/,
  );
});

test("parseResponseText tolerates an unlabelled trailing ```json block", () => {
  const r = parseResponseText(`${LIVE_MD}\n\n\`\`\`json\n${JSON.stringify(LIVE_CONSTRAINTS)}\n\`\`\`\n`);
  assert.deepEqual(r.constraints, LIVE_CONSTRAINTS);
  assert.deepEqual(headingsIn(r.markdown), SECTIONS);
  assert.throws(() => parseResponseText("```json parsed_constraints_json\n{not json}\n```"), /not valid JSON/);
});

test("CLI --mock writes the draft; --dry-run makes no call and reports token estimate", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "style-data-seed-"));
  const profilePath = path.join(tmp, "taste-profile.json");
  const outPath = path.join(tmp, "out", "profile-draft.md");
  fs.writeFileSync(profilePath, JSON.stringify(PROFILE));
  const env = { ...process.env, ANTHROPIC_API_KEY: "", STYLE_DATA_DEV_VARS: "/nonexistent/.dev.vars" };
  execFileSync(process.execPath, [SCRIPT, "--profile", profilePath, "--out", outPath, "--mock"], { env, stdio: ["ignore", "ignore", "pipe"] });
  const md = fs.readFileSync(outPath, "utf8");
  assert.deepEqual(headingsIn(md), SECTIONS);
  assert.deepEqual(parseResponseText(md).constraints, mockConstraints(PROFILE));

  // Keyless without --mock also falls back to mock.
  const out2 = path.join(tmp, "keyless.md");
  const err = execFileSync("sh", ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} --profile ${JSON.stringify(profilePath)} --out ${JSON.stringify(out2)} 2>&1`], { env }).toString();
  assert.match(err, /using mock draft/);
  assert.deepEqual(headingsIn(fs.readFileSync(out2, "utf8")), SECTIONS);

  const dry = execFileSync("sh", ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} --profile ${JSON.stringify(profilePath)} --out ${JSON.stringify(path.join(tmp, "never.md"))} --dry-run 2>&1`], { env }).toString();
  const info = JSON.parse(dry.trim());
  assert.equal(info.event, "seed-profile-dry-run");
  assert.equal(info.model, DEFAULT_MODEL);
  assert.ok(info.est_input_tokens > 1000);
  assert.equal(info.api_key_found, false);
  assert.ok(!fs.existsSync(path.join(tmp, "never.md")));
  // Usage errors exit 2: --help, and a default/explicit profile path that does not exist.
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--help"], { env, stdio: "ignore" }), (e) => e.status === 2);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--profile", path.join(tmp, "nope.json"), "--out", out2, "--mock"], { env, stdio: "ignore" }), (e) => e.status === 2);
});
