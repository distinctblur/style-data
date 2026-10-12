import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TAG_PROMPT_V1, PROMPT_VERSION, MAX_IMAGE_BYTES, DEFAULT_BOARDS_PATH, mockTag, tagPins, callGemini, costUsd, parseCli, formatSummary,
  readJsonl, buildRequestBody, loadBoardDomains, pinDomain, taggedKeys, resolveVersion, defaultPromptVersion, legacyPromptVersion,
} from "../tag.mjs";
import {
  validateTag, validateTagV1, validateTagV2, CATEGORIES, FORMULA_IDS, FORMULA_V2_IDS, COLOURS, PROMPT_VERSION as FASHION_PROMPT_VERSION,
  TAG_PROMPT_FASHION_V1, TAG_PROMPT_FASHION_V2, tagSchemaV1, tagSchemaV2, VERSIONS,
} from "../taxonomies/fashion.mjs";
import * as home from "../taxonomies/home.mjs";
import { getDomain } from "../taxonomies/index.mjs";

let dir;
let boardsPath;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "style-data-tag-"));
  boardsPath = writeBoards();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const quiet = () => {};

/** Temp boards.json mirroring the repo's shape: two fashion boards, one home board. */
function writeBoards(boards = [
  { slug: "my-style", url: "https://www.pinterest.com/x/my-style/", domain: "fashion" },
  { slug: "swim-look", url: "https://www.pinterest.com/x/swim-look/", domain: "fashion" },
  { slug: "for-the-home", url: "https://www.pinterest.com/x/for-the-home/", domain: "home" },
], name = "boards.json") {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({ version: 1, owner: "test", boards }, null, 2));
  return p;
}

function writeImage(name, bytes = 1024) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}
function pin(id, extra = {}) {
  return { pin_id: id, board: "my-style", created_at: "2026-01-01T00:00:00Z", title: `pin ${id}`, description: "", link: "", dominant_color: "#000000", image_path: writeImage(`${id}.jpg`), image_url: "", sha256: "x", is_video: false, ...extra };
}
function writePins(pins, name = "pins.jsonl") {
  const p = path.join(dir, name);
  fs.writeFileSync(p, pins.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}
function geminiResponse(tagObj, usage = { promptTokenCount: 900, candidatesTokenCount: 150, thoughtsTokenCount: 50, totalTokenCount: 1100 }) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(tagObj) }] }, finishReason: "STOP" }], usageMetadata: usage };
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const noSleep = async () => {};

test("TAG_PROMPT_V1 names the taxonomy enums and the non-outfit rule", () => {
  assert.equal(TAG_PROMPT_V1, TAG_PROMPT_FASHION_V1, "tag.mjs re-exports the fashion prompt for compatibility");
  assert.match(TAG_PROMPT_V1, /set is_outfit=false and still tag visible garments/);
  for (const c of CATEGORIES) assert.ok(TAG_PROMPT_V1.includes(c), `prompt lacks category ${c}`);
  for (const f of FORMULA_IDS) assert.ok(TAG_PROMPT_V1.includes(f), `prompt lacks formula ${f}`);
  for (const c of COLOURS) assert.ok(TAG_PROMPT_V1.includes(c), `prompt lacks colour ${c}`);
  assert.ok(TAG_PROMPT_V1.includes("one-piece"));
  assert.equal(PROMPT_VERSION, "fashion.tag.v2", "tag.mjs's PROMPT_VERSION alias follows the fashion default (v2 since 2026-10-12)");
  assert.equal(PROMPT_VERSION, FASHION_PROMPT_VERSION);
  assert.equal(getDomain("home").PROMPT_VERSION, "home.tag.v1");
});

test("mockTag is deterministic, schema-valid and varied", () => {
  const ids = Array.from({ length: 60 }, (_, i) => `pin-${i}`);
  const formulas = new Set();
  const colours = new Set();
  for (const id of ids) {
    const t = mockTag(id);
    assert.deepEqual(mockTag(id), t, "must be deterministic");
    const v = validateTag(t);
    assert.ok(v.ok, `${id}: ${v.errors.join("; ")}`);
    formulas.add(t.formula);
    t.garments.forEach((g) => colours.add(g.colour));
  }
  assert.ok(formulas.size >= 6, `expected varied formulas, got ${formulas.size}`);
  assert.ok(colours.size >= 8, `expected varied colours, got ${colours.size}`);
  assert.notDeepEqual(mockTag("a"), mockTag("b"));
});

test("mock run tags 3 pins, skips a video and a dupe, writes valid records", async () => {
  const pins = [pin("p1"), pin("p2"), pin("v1", { is_video: true }), pin("p3"), pin("d1", { dupe_of: "p1" })];
  const inPath = writePins(pins);
  const outPath = path.join(dir, "out", "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, mock: true, log: quiet });
  assert.equal(s.mode, "mock");
  assert.equal(s.tagged, 3);
  assert.equal(s.failed, 0);
  assert.equal(s.skipped, 2);
  assert.deepEqual(s.skippedBy, { video: 1, dupe: 1 });
  assert.equal(s.costUsd, null);
  const recs = readJsonl(outPath);
  assert.deepEqual(recs.map((r) => r.pin_id), ["p1", "p2", "p3"]);
  for (const r of recs) {
    assert.deepEqual(Object.keys(r), ["pin_id", "board", "domain", "model", "prompt_version", "tag", "error", "usage", "cost_usd", "ms"]);
    assert.equal(r.board, "my-style");
    assert.equal(r.domain, "fashion", "domain derived from boards.json");
    assert.equal(r.model, "mock");
    assert.equal(r.prompt_version, "fashion.tag.v2", "mock mode is v2 by default for fashion");
    assert.ok(validateTagV2(r.tag).ok);
    assert.equal(r.error, null);
    assert.equal(r.usage, null);
    assert.equal(r.cost_usd, null);
    assert.equal(typeof r.ms, "number");
    assert.ok(validateTag(r.tag).ok);
    assert.deepEqual(r.tag, mockTag(r.pin_id));
  }
});

test("keyless and no --mock falls back to mock mode (apiKey null)", async () => {
  const inPath = writePins([pin("p1")]);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, apiKey: null, log: quiet }, { fetchImpl: () => { throw new Error("network must not be touched"); } });
  assert.equal(s.mode, "mock");
  assert.equal(s.tagged, 1);
});

test("--only-missing resumes: appends only untagged pins, retries failed ones", async () => {
  const p1 = pin("p1"), p2 = pin("p2"), p3 = pin("p3");
  const inPath = writePins([p1, p2, p3]);
  const outPath = path.join(dir, "tags.jsonl");
  const first = await tagPins({ inPath, outPath, boardsPath, mock: true, log: quiet });
  assert.equal(first.tagged, 3);
  // Simulate an earlier failure for p2 and a new pin p4.
  fs.appendFileSync(outPath, JSON.stringify({ pin_id: "p2", board: "my-style", domain: "fashion", model: "gemini-3.6-flash", prompt_version: "fashion.tag.v2", tag: null, error: "upstream 503", usage: null, cost_usd: null, ms: 1 }) + "\n");
  writePins([p1, p2, p3, pin("p4")]);
  const second = await tagPins({ inPath, outPath, boardsPath, mock: true, onlyMissing: true, log: quiet });
  assert.equal(second.tagged, 1, "p2 already has a success record; only p4 is new");
  assert.deepEqual(second.skippedBy, { already_tagged: 3 });
  assert.deepEqual(second.records.map((r) => r.pin_id), ["p4"]);
  assert.equal(readJsonl(outPath).length, 5, "append-only: nothing rewritten");
  const third = await tagPins({ inPath, outPath, boardsPath, mock: true, log: quiet });
  assert.equal(third.tagged, 4, "without --only-missing everything is re-tagged");
});

test("--limit caps attempted pins after skips", async () => {
  const inPath = writePins([pin("v", { is_video: true }), pin("a"), pin("b"), pin("c")]);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, mock: true, limit: 2, log: quiet });
  assert.equal(s.tagged, 2);
  assert.deepEqual(s.records.map((r) => r.pin_id), ["a", "b"]);
});

test("images over 4 MB, missing files and unsupported types are skipped with no record", async () => {
  const big = pin("big", { image_path: writeImage("big-full.jpg", MAX_IMAGE_BYTES + 1) });
  const gone = pin("gone", { image_path: path.join(dir, "nope.jpg") });
  const gif = pin("gif", { image_path: writeImage("g.gif") });
  const inPath = writePins([big, gone, gif, pin("ok")]);
  const outPath = path.join(dir, "tags.jsonl");
  const logs = [];
  const s = await tagPins({ inPath, outPath, boardsPath, mock: true, log: (m) => logs.push(m) });
  assert.equal(s.tagged, 1);
  assert.equal(s.skipped, 3);
  assert.deepEqual(s.skippedBy, { too_large: 1, missing_image: 1, unsupported_type: 1 });
  assert.deepEqual(readJsonl(outPath).map((r) => r.pin_id), ["ok"]);
  assert.ok(logs.some((l) => /skip big too_large .*> 4 MB/.test(l)), logs.join("\n"));
});

test("live path: fake fetch sees the structured-output request and a valid reply is recorded with usage + cost", async () => {
  const good = mockTag("seed");
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonRes(200, geminiResponse(good)); };
  const inPath = writePins([pin("p1")]);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, apiKey: "test-key", model: "gemini-3.6-flash", priceIn: 1, priceOut: 3, log: quiet }, { fetchImpl, sleep: noSleep });
  assert.equal(s.mode, "live");
  assert.equal(s.tagged, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseSchema.type, "OBJECT");
  assert.ok(!("responseFormat" in body.generationConfig), "never hedge between config shapes");
  assert.equal(body.contents[0].parts[0].text, TAG_PROMPT_FASHION_V2, "a default fashion run sends the v2 prompt");
  assert.deepEqual(body.generationConfig.responseSchema, tagSchemaV2);
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, "image/jpeg");
  assert.equal(body.contents[0].parts[1].inlineData.data, Buffer.alloc(1024, 1).toString("base64"));
  const [rec] = s.records;
  assert.equal(rec.model, "gemini-3.6-flash");
  assert.deepEqual(rec.tag, good);
  assert.equal(rec.usage.promptTokenCount, 900);
  // (900 * 1 + (150 + 50) * 3) / 1e6 — thinking tokens billed at the output rate
  assert.ok(Math.abs(rec.cost_usd - 0.0015) < 1e-9, String(rec.cost_usd));
  assert.ok(Math.abs(s.costUsd - 0.0015) < 1e-9);
  assert.equal(s.promptTokens, 900);
  assert.equal(s.outputTokens, 200);
  assert.equal(s.totalTokens, 1100);
  assert.match(formatSummary(s), /tagged 1  failed 0  skipped 0/);
  assert.match(formatSummary(s), /\$0\.0015/);
});

test("parse failure and validation failure yield tag:null with an error, run continues", async () => {
  const replies = {
    p1: jsonRes(200, { candidates: [{ content: { parts: [{ text: "not json at all" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }),
    p2: jsonRes(200, geminiResponse({ ...mockTag("x"), formula: "jeans+jeans" })),
    p3: jsonRes(200, geminiResponse(mockTag("fine"))),
    p4: jsonRes(200, { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }], promptFeedback: { blockReason: "OTHER" } }),
  };
  const fetchImpl = async (_url, init) => {
    const img = JSON.parse(init.body).contents[0].parts[1].inlineData.data;
    const id = Buffer.from(img, "base64")[0]; // first byte encodes the pin
    return replies[`p${id}`];
  };
  const mk = (n) => pin(`p${n}`, { image_path: (() => { const p = path.join(dir, `p${n}.png`); fs.writeFileSync(p, Buffer.from([n, 0, 0])); return p; })() });
  const inPath = writePins([mk(1), mk(2), mk(3), mk(4)]);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, apiKey: "k", concurrency: 2, log: quiet }, { fetchImpl, sleep: noSleep });
  assert.equal(s.tagged, 1);
  assert.equal(s.failed, 3);
  const byId = Object.fromEntries(readJsonl(outPath).map((r) => [r.pin_id, r]));
  assert.equal(byId.p1.tag, null);
  assert.match(byId.p1.error, /^parse: /);
  assert.equal(byId.p1.usage.promptTokenCount, 10, "usage is kept even when parsing fails");
  assert.equal(byId.p2.tag, null);
  assert.match(byId.p2.error, /^validation: formula invalid: jeans\+jeans/);
  assert.ok(validateTag(byId.p3.tag).ok);
  assert.equal(byId.p4.tag, null);
  assert.match(byId.p4.error, /empty response \(finishReason=SAFETY, blockReason=OTHER\)/);
  assert.equal(s.promptTokens, 10 + 900 + 900, "usage counted for p1 (parse fail), p2 (validation fail), p3; p4 had none");
});

test("callGemini retries once on 429/5xx with backoff and gives up after the second failure", async () => {
  const image = { mimeType: "image/jpeg", data: "AAAA" };
  let n = 0;
  const flaky = async () => (++n === 1 ? jsonRes(429, "slow down") : jsonRes(200, geminiResponse(mockTag("r"))));
  const slept = [];
  const r = await callGemini({ fetchImpl: flaky, apiKey: "k", model: "m", image, backoffMs: 100, sleep: async (ms) => slept.push(ms) });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 100 && slept[0] <= 200);

  let m = 0;
  const dead = async () => { m++; return jsonRes(503, "unavailable"); };
  const r2 = await callGemini({ fetchImpl: dead, apiKey: "k", model: "m", image, backoffMs: 1, sleep: noSleep });
  assert.equal(r2.ok, false);
  assert.equal(m, 2);
  assert.match(r2.error, /upstream 503/);

  let k = 0;
  const bad = async () => { k++; return jsonRes(400, "bad request"); };
  const r3 = await callGemini({ fetchImpl: bad, apiKey: "k", model: "m", image, backoffMs: 1, sleep: noSleep });
  assert.equal(r3.ok, false);
  assert.equal(k, 1, "4xx other than 429 is not retried");

  let t = 0;
  const thrower = async () => { t++; throw new Error("ECONNRESET"); };
  const r4 = await callGemini({ fetchImpl: thrower, apiKey: "k", model: "m", image, backoffMs: 1, sleep: noSleep });
  assert.equal(r4.ok, false);
  assert.equal(t, 2);
  assert.match(r4.error, /request failed: Error: ECONNRESET/);
});

test("costUsd and parseCli", () => {
  assert.equal(costUsd(null, 1, 1), null);
  assert.equal(costUsd({ promptTokenCount: 1e6 }, null, 2), null);
  assert.equal(costUsd({ promptTokenCount: 1e6, candidatesTokenCount: 1e6 }, 0.5, 3), 3.5);
  assert.equal(costUsd({ promptTokenCount: 0, candidatesTokenCount: 1e6, thoughtsTokenCount: 1e6 }, 0.5, 3), 6);

  const o = parseCli(["--domain", "home", "--boards", "b.json", "--in", "a.jsonl", "--out", "b.jsonl", "--limit", "5", "--concurrency", "2", "--only-missing", "--mock", "--price-in", "0.5", "--price-out", "3"]);
  assert.deepEqual(o, { domain: "home", boardsPath: "b.json", inPath: "a.jsonl", outPath: "b.jsonl", limit: 5, model: "gemini-3.6-flash", concurrency: 2, onlyMissing: true, mock: true, priceIn: 0.5, priceOut: 3, promptVersion: null });
  const d = parseCli([]);
  assert.equal(d.domain, null, "no --domain: every pin is tagged with its board's domain");
  assert.equal(d.boardsPath, DEFAULT_BOARDS_PATH);
  assert.match(d.boardsPath, /\/boards\.json$/);
  assert.equal(d.limit, Infinity);
  assert.equal(d.priceIn, null);
  assert.equal(d.concurrency, 4);
  assert.match(d.inPath, /\/data\/pins\.jsonl$/);
  assert.match(d.outPath, /\/data\/tags\.jsonl$/);
  assert.throws(() => parseCli(["--limit", "x"]), /--limit must be a non-negative number/);
  assert.throws(() => parseCli(["--domain", "garden"]), /--domain must be one of: fashion, home/);

  const body = buildRequestBody({ mimeType: "image/png", data: "QUJD" });
  assert.deepEqual(Object.keys(body.generationConfig), ["responseMimeType", "responseSchema"]);
  assert.equal(body.contents[0].parts[0].text, TAG_PROMPT_FASHION_V2, "default domain is fashion, at its default version v2");
  const homeBody = buildRequestBody({ mimeType: "image/png", data: "QUJD" }, "home");
  assert.equal(homeBody.contents[0].parts[0].text, home.TAG_PROMPT_HOME_V1);
  assert.equal(homeBody.generationConfig.responseSchema, home.tagSchema);
  assert.throws(() => buildRequestBody({ mimeType: "image/png", data: "QUJD" }, "garden"), /unknown domain 'garden'/);
});

// --- Domains -----------------------------------------------------------------------

test("loadBoardDomains and pinDomain route by boards.json, pin.domain wins, --domain is the fallback", () => {
  const map = loadBoardDomains(boardsPath);
  assert.deepEqual([...map], [["my-style", "fashion"], ["swim-look", "fashion"], ["for-the-home", "home"]]);
  assert.equal(pinDomain({ pin_id: "a", board: "for-the-home" }, map), "home");
  assert.equal(pinDomain({ pin_id: "a", board: "swim-look" }, map), "fashion");
  assert.equal(pinDomain({ pin_id: "a", board: "my-style", domain: "home" }, map), "home", "an explicit pin.domain wins over the board");
  assert.equal(pinDomain({ pin_id: "a", board: "mystery" }, map), null);
  assert.equal(pinDomain({ pin_id: "a", board: "mystery" }, map, "home"), "home");
  assert.deepEqual([...loadBoardDomains(path.join(dir, "missing.json"))], [], "missing boards.json -> empty map");
  const bad = writeBoards([{ slug: "x", url: "u", domain: "garden" }], "bad.json");
  assert.throws(() => loadBoardDomains(bad), /board 'x' has unknown domain 'garden'/);
});

test("mockTag is domain-aware: home tags are deterministic, valid for the home taxonomy and varied", () => {
  const rooms = new Set();
  const styles = new Set();
  for (let i = 0; i < 60; i++) {
    const id = `home-${i}`;
    const t = mockTag(id, "home");
    assert.deepEqual(mockTag(id, "home"), t, "must be deterministic");
    const v = home.validateTag(t);
    assert.ok(v.ok, `${id}: ${v.errors.join("; ")}`);
    assert.deepEqual(Object.keys(t), ["is_interior", "room", "items", "styles", "palette_mood", "era", "vibe_keywords", "confidence"]);
    rooms.add(t.room);
    t.styles.forEach((s) => styles.add(s));
  }
  assert.ok(rooms.size >= 6, `expected varied rooms, got ${rooms.size}`);
  assert.ok(styles.size >= 8, `expected varied styles, got ${styles.size}`);
  assert.notDeepEqual(mockTag("a", "home"), mockTag("a", "fashion"), "same pin, different domain, different shape");
  assert.deepEqual(mockTag("a"), mockTag("a", "fashion"), "default domain stays fashion");
  assert.throws(() => mockTag("a", "garden"), /unknown domain 'garden'/);
});

test("no --domain: every pin is tagged with its board's domain; records carry domain + per-domain prompt_version", async () => {
  const pins = [pin("f1"), pin("h1", { board: "for-the-home" }), pin("s1", { board: "swim-look" }), pin("x1", { board: "not-registered" })];
  const inPath = writePins(pins);
  const outPath = path.join(dir, "tags.jsonl");
  const logs = [];
  const s = await tagPins({ inPath, outPath, boardsPath, mock: true, log: (m) => logs.push(m) });
  assert.equal(s.domain, null);
  assert.equal(s.tagged, 3);
  assert.deepEqual(s.skippedBy, { unknown_domain: 1 });
  assert.ok(logs.some((l) => /skip x1 unknown_domain .*not-registered.*pass --domain/.test(l)), logs.join("\n"));
  assert.deepEqual(s.byDomain, { fashion: { tagged: 2, failed: 0 }, home: { tagged: 1, failed: 0 } });
  const byId = Object.fromEntries(readJsonl(outPath).map((r) => [r.pin_id, r]));
  assert.equal(byId.f1.domain, "fashion");
  assert.equal(byId.f1.prompt_version, "fashion.tag.v2", "each domain runs at its own default: fashion v2");
  assert.ok(validateTag(byId.f1.tag).ok);
  assert.ok(validateTagV2(byId.f1.tag).ok);
  assert.equal(byId.s1.domain, "fashion");
  assert.equal(byId.h1.domain, "home");
  assert.equal(byId.h1.board, "for-the-home");
  assert.equal(byId.h1.prompt_version, "home.tag.v1");
  assert.ok(home.validateTag(byId.h1.tag).ok);
  assert.deepEqual(byId.h1.tag, mockTag("h1", "home"));
  assert.ok(!validateTag(byId.h1.tag).ok, "a home tag is not a fashion tag");
  assert.match(formatSummary(s), /by domain: fashion 2\/2, home 1\/1/);
});

test("--domain filters to that domain's pins and is the fallback for unregistered boards", async () => {
  const pins = [pin("f1"), pin("h1", { board: "for-the-home" }), pin("h2", { board: "for-the-home" }), pin("x1", { board: "not-registered" })];
  const inPath = writePins(pins);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, domain: "home", mock: true, log: quiet });
  assert.equal(s.domain, "home");
  assert.equal(s.tagged, 3, "h1, h2 and the unregistered x1 under the explicit domain");
  assert.deepEqual(s.skippedBy, { other_domain: 1 });
  const recs = readJsonl(outPath);
  assert.deepEqual(recs.map((r) => r.pin_id), ["h1", "h2", "x1"]);
  for (const r of recs) {
    assert.equal(r.domain, "home");
    assert.equal(r.prompt_version, "home.tag.v1");
    assert.ok(home.validateTag(r.tag).ok);
  }
  assert.match(formatSummary(s), /--domain home/);
  await assert.rejects(() => tagPins({ inPath, outPath, boardsPath, domain: "garden", mock: true, log: quiet }), /unknown domain 'garden'/);
});

test("pin.domain overrides the board mapping and a pin carrying an unregistered domain is skipped", async () => {
  const inPath = writePins([pin("a", { domain: "home" }), pin("b", { domain: "garden" })]);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, mock: true, log: quiet });
  assert.equal(s.tagged, 1);
  assert.deepEqual(s.skippedBy, { unknown_domain: 1 });
  const [rec] = readJsonl(outPath);
  assert.equal(rec.pin_id, "a");
  assert.equal(rec.domain, "home");
  assert.equal(rec.board, "my-style");
});

test("--only-missing keys on (pin_id, domain): the same pin can be tagged once per domain", async () => {
  const inPath = writePins([pin("p1"), pin("h1", { board: "for-the-home" })]);
  const outPath = path.join(dir, "tags.jsonl");
  const first = await tagPins({ inPath, outPath, boardsPath, mock: true, log: quiet });
  assert.equal(first.tagged, 2);
  assert.deepEqual([...taggedKeys(outPath)].sort(), ["fashion\u0000fashion.tag.v2\u0000p1", "home\u0000home.tag.v1\u0000h1"]);
  // Re-tag p1 under the other domain: its fashion record does not count as done for home.
  writePins([pin("p1", { domain: "home" }), pin("h1", { board: "for-the-home" })]);
  const second = await tagPins({ inPath, outPath, boardsPath, mock: true, onlyMissing: true, log: quiet });
  assert.equal(second.tagged, 1);
  assert.deepEqual(second.records.map((r) => [r.pin_id, r.domain]), [["p1", "home"]]);
  assert.deepEqual(second.skippedBy, { already_tagged: 1 });
  // A legacy record without `domain` never satisfies --only-missing.
  fs.appendFileSync(outPath, JSON.stringify({ pin_id: "legacy", board: "my-style", model: "mock", prompt_version: "tag.v1", tag: mockTag("legacy"), error: null, usage: null, cost_usd: null, ms: 1 }) + "\n");
  writePins([pin("legacy")]);
  const third = await tagPins({ inPath, outPath, boardsPath, mock: true, onlyMissing: true, log: quiet });
  assert.equal(third.tagged, 1);
});

test("live path for a home pin sends the home prompt + schema and validates with the home taxonomy", async () => {
  const good = mockTag("seed", "home");
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonRes(200, geminiResponse(good)); };
  const inPath = writePins([pin("h1", { board: "for-the-home" })]);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, apiKey: "test-key", log: quiet }, { fetchImpl, sleep: noSleep });
  assert.equal(s.mode, "live");
  assert.equal(s.tagged, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.contents[0].parts[0].text, home.TAG_PROMPT_HOME_V1);
  assert.deepEqual(body.generationConfig.responseSchema, home.tagSchema);
  const [rec] = s.records;
  assert.equal(rec.domain, "home");
  assert.equal(rec.prompt_version, "home.tag.v1");
  assert.deepEqual(rec.tag, good);

  // A fashion-shaped reply for a home pin fails home validation.
  const wrong = async () => jsonRes(200, geminiResponse(mockTag("seed", "fashion")));
  const s2 = await tagPins({ inPath, outPath, boardsPath, apiKey: "test-key", log: quiet }, { fetchImpl: wrong, sleep: noSleep });
  assert.equal(s2.failed, 1);
  assert.match(s2.records[0].error, /^validation: missing field: is_interior/);
});

// --- Prompt versions ---------------------------------------------------------------

test("resolveVersion: each domain's default is its module-level contract (fashion v2, home v1); v1 stays selectable; unknown versions throw", () => {
  assert.equal(defaultPromptVersion("fashion"), "v2");
  assert.equal(defaultPromptVersion("home"), "v1");
  assert.throws(() => defaultPromptVersion("garden"), /unknown domain 'garden'/);
  const def = resolveVersion("fashion");
  assert.equal(def.PROMPT_VERSION, "fashion.tag.v2");
  assert.equal(def.TAG_PROMPT, TAG_PROMPT_FASHION_V2);
  assert.equal(def, VERSIONS.v2);
  assert.equal(resolveVersion("fashion", null), VERSIONS.v2, "null means the domain's default");
  const v1 = resolveVersion("fashion", "v1");
  assert.equal(v1.PROMPT_VERSION, "fashion.tag.v1");
  assert.equal(v1.TAG_PROMPT, TAG_PROMPT_FASHION_V1);
  assert.equal(v1.tagSchema, tagSchemaV1);
  assert.equal(v1.validateTag, validateTagV1);
  assert.deepEqual(v1.FORMULA_IDS, FORMULA_IDS);
  assert.equal(v1, VERSIONS.v1);
  const v2 = resolveVersion("fashion", "v2");
  assert.equal(v2.PROMPT_VERSION, "fashion.tag.v2");
  assert.equal(v2.TAG_PROMPT, TAG_PROMPT_FASHION_V2);
  assert.equal(v2.tagSchema, tagSchemaV2);
  assert.deepEqual(v2.FORMULA_IDS, FORMULA_V2_IDS);
  const h = resolveVersion("home");
  assert.equal(h.PROMPT_VERSION, "home.tag.v1");
  assert.equal(h.TAG_PROMPT, home.TAG_PROMPT_HOME_V1);
  assert.deepEqual(resolveVersion("home", "v1"), h);
  assert.throws(() => resolveVersion("home", "v2"), /domain 'home' has no prompt version 'v2' \(known: v1\)/);
  assert.throws(() => resolveVersion("fashion", "v3"), /domain 'fashion' has no prompt version 'v3' \(known: v1, v2\)/);
  assert.throws(() => resolveVersion("garden", "v1"), /unknown domain 'garden'/);
  // Rows without a prompt_version predate versioning: they are v1, never the current default.
  assert.equal(legacyPromptVersion("fashion"), "fashion.tag.v1");
  assert.equal(legacyPromptVersion("home"), "home.tag.v1");
  assert.equal(legacyPromptVersion("garden"), null);
});

test("parseCli --prompt-version: no flag means each domain's default; v1 and v2 selectable; validated against the domain when one is given", () => {
  assert.equal(parseCli([]).promptVersion, null, "null -> resolved per domain at run time (fashion v2, home v1)");
  assert.equal(parseCli(["--domain", "fashion"]).promptVersion, null);
  assert.equal(parseCli(["--domain", "fashion", "--prompt-version", "v1"]).promptVersion, "v1", "v1 stays selectable");
  assert.equal(parseCli(["--domain", "fashion", "--prompt-version", "v2"]).promptVersion, "v2");
  assert.equal(parseCli(["--domain", "home", "--prompt-version", "v1"]).promptVersion, "v1");
  assert.equal(parseCli(["--prompt-version", "v2"]).promptVersion, "v2", "no --domain: checked per pin at run time");
  assert.throws(() => parseCli(["--domain", "home", "--prompt-version", "v2"]), /domain 'home' has no prompt version 'v2'/);
  assert.throws(() => parseCli(["--prompt-version", "latest"]), /--prompt-version must look like v1 or v2/);
});

test("mock mode under v2 draws formulas from the v2 enum and validates against the v2 schema", () => {
  const ids = Array.from({ length: 60 }, (_, i) => `pin-${i}`);
  const formulas = new Set();
  for (const id of ids) {
    const t = mockTag(id, "fashion", "v2");
    assert.deepEqual(mockTag(id, "fashion", "v2"), t, "deterministic");
    assert.ok(validateTagV2(t).ok, validateTagV2(t).errors.join("; "));
    assert.ok(FORMULA_V2_IDS.includes(t.formula));
    formulas.add(t.formula);
    // Same pin, same garments under both versions; only the formula enum differs.
    assert.deepEqual(t.garments, mockTag(id).garments);
  }
  assert.ok(formulas.size >= 6, `expected varied v2 formulas, got ${formulas.size}`);
  assert.deepEqual(mockTag("a", "fashion", "v2"), mockTag("a"), "v2 is the mock default for fashion");
  assert.deepEqual(mockTag("a", "fashion", null), mockTag("a"));
  // v1 stays selectable and differs from the default only in the formula enum it draws from.
  const v1 = mockTag("a", "fashion", "v1");
  assert.ok(validateTagV1(v1).ok);
  assert.ok(FORMULA_IDS.includes(v1.formula));
  assert.deepEqual({ ...v1, formula: null }, { ...mockTag("a"), formula: null });
  assert.throws(() => mockTag("a", "home", "v2"), /domain 'home' has no prompt version 'v2'/);
});

test("--prompt-version v2: records carry fashion.tag.v2, mock tags are v2-valid, summary names the version", async () => {
  const inPath = writePins([pin("p1"), pin("p2")]);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", mock: true, promptVersion: "v2", log: quiet });
  assert.equal(s.tagged, 2);
  assert.equal(s.promptVersion, "v2");
  for (const r of readJsonl(outPath)) {
    assert.equal(r.prompt_version, "fashion.tag.v2");
    assert.equal(r.domain, "fashion");
    assert.ok(validateTagV2(r.tag).ok);
    assert.deepEqual(r.tag, mockTag(r.pin_id, "fashion", "v2"));
  }
  assert.match(formatSummary(s), /--prompt-version v2/);
  assert.doesNotMatch(formatSummary(await tagPins({ inPath, outPath: path.join(dir, "t1.jsonl"), boardsPath, domain: "fashion", mock: true, log: quiet })), /--prompt-version/);
  // A v2 run that meets a home pin fails fast rather than silently tagging it with v1.
  const mixed = writePins([pin("f1"), pin("h1", { board: "for-the-home" })], "mixed.jsonl");
  await assert.rejects(() => tagPins({ inPath: mixed, outPath, boardsPath, mock: true, promptVersion: "v2", log: quiet }), /domain 'home' has no prompt version 'v2'/);
  await assert.rejects(() => tagPins({ inPath, outPath, boardsPath, domain: "home", mock: true, promptVersion: "v2", log: quiet }), /domain 'home' has no prompt version 'v2'/);
});

test("live path under v2 sends the v2 prompt + schema and validates with the v2 enum", async () => {
  const good = mockTag("seed", "fashion", "v2");
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonRes(200, geminiResponse(good)); };
  const inPath = writePins([pin("p1")]);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", apiKey: "test-key", promptVersion: "v2", log: quiet }, { fetchImpl, sleep: noSleep });
  assert.equal(s.mode, "live");
  assert.equal(s.tagged, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.contents[0].parts[0].text, TAG_PROMPT_FASHION_V2);
  assert.deepEqual(body.generationConfig.responseSchema, tagSchemaV2);
  assert.deepEqual(body.generationConfig.responseSchema.properties.formula.enum, [...FORMULA_V2_IDS]);
  const [rec] = s.records;
  assert.equal(rec.prompt_version, "fashion.tag.v2");
  assert.deepEqual(rec.tag, good);
  // A v1-only formula in the reply fails v2 validation.
  const stale = async () => jsonRes(200, geminiResponse({ ...good, formula: "jeans+tee+sneaker" }));
  const s2 = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", apiKey: "test-key", promptVersion: "v2", log: quiet }, { fetchImpl: stale, sleep: noSleep });
  assert.equal(s2.failed, 1);
  assert.match(s2.records[0].error, /^validation: formula invalid: jeans\+tee\+sneaker/);
  // The default request is the v2 one; v1 is still buildable on request.
  const defBody = buildRequestBody({ mimeType: "image/png", data: "QUJD" }, "fashion");
  assert.equal(defBody.contents[0].parts[0].text, TAG_PROMPT_FASHION_V2);
  assert.deepEqual(defBody.generationConfig.responseSchema, tagSchemaV2);
  const v1Body = buildRequestBody({ mimeType: "image/png", data: "QUJD" }, "fashion", "v1");
  assert.equal(v1Body.contents[0].parts[0].text, TAG_PROMPT_FASHION_V1);
  assert.deepEqual(v1Body.generationConfig.responseSchema, tagSchemaV1);
  assert.deepEqual(v1Body.generationConfig.responseSchema.properties.formula.enum, [...FORMULA_IDS]);
});

test("--prompt-version v1 stays selectable end to end: records carry fashion.tag.v1 and validate against the v1 enum", async () => {
  const inPath = writePins([pin("p1")]);
  const outPath = path.join(dir, "tags.jsonl");
  const s = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", mock: true, promptVersion: "v1", log: quiet });
  assert.equal(s.tagged, 1);
  const [rec] = readJsonl(outPath);
  assert.equal(rec.prompt_version, "fashion.tag.v1");
  assert.ok(validateTagV1(rec.tag).ok);
  assert.deepEqual(rec.tag, mockTag("p1", "fashion", "v1"));
  assert.match(formatSummary(s), /--prompt-version v1/, "an explicit version is named even when it is not the default");
  const good = mockTag("seed", "fashion", "v1");
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonRes(200, geminiResponse(good)); };
  const live = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", apiKey: "test-key", promptVersion: "v1", log: quiet }, { fetchImpl, sleep: noSleep });
  assert.equal(live.tagged, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.contents[0].parts[0].text, TAG_PROMPT_FASHION_V1);
  assert.deepEqual(body.generationConfig.responseSchema, tagSchemaV1);
  assert.equal(live.records[0].prompt_version, "fashion.tag.v1");
});

test("--only-missing keys on (pin_id, domain, prompt_version): existing fashion.tag.v1 rows are NOT done for a default (v2) run", async () => {
  const inPath = writePins([pin("p1"), pin("p2")]);
  const outPath = path.join(dir, "tags.jsonl");
  // The first live run's shape: rows tagged under v1.
  const v1 = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", mock: true, promptVersion: "v1", log: quiet });
  assert.equal(v1.tagged, 2);
  assert.deepEqual(v1.records.map((r) => r.prompt_version), ["fashion.tag.v1", "fashion.tag.v1"]);
  // Resuming v1 skips both; a default run (now v2) tags both again; resuming the default then skips both.
  const v1Again = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", mock: true, onlyMissing: true, promptVersion: "v1", log: quiet });
  assert.deepEqual([v1Again.tagged, v1Again.skippedBy], [0, { already_tagged: 2 }]);
  const v2 = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", mock: true, onlyMissing: true, log: quiet });
  assert.equal(v2.tagged, 2, "v1 rows do not count as done for the v2 default");
  assert.deepEqual(v2.records.map((r) => r.prompt_version), ["fashion.tag.v2", "fashion.tag.v2"]);
  const v2Again = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", mock: true, onlyMissing: true, log: quiet });
  assert.deepEqual([v2Again.tagged, v2Again.skippedBy], [0, { already_tagged: 2 }]);
  const v2Explicit = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", mock: true, onlyMissing: true, promptVersion: "v2", log: quiet });
  assert.deepEqual([v2Explicit.tagged, v2Explicit.skippedBy], [0, { already_tagged: 2 }], "explicit v2 and the default are the same key");
  assert.deepEqual([...taggedKeys(outPath)].sort(), [
    "fashion\u0000fashion.tag.v1\u0000p1", "fashion\u0000fashion.tag.v1\u0000p2",
    "fashion\u0000fashion.tag.v2\u0000p1", "fashion\u0000fashion.tag.v2\u0000p2",
  ]);
  assert.equal(readJsonl(outPath).length, 4, "append-only: v1 rows kept next to v2 rows");
  // A row with a domain but no prompt_version (pre-versioning shape) counts as v1, never as today's default.
  fs.appendFileSync(outPath, JSON.stringify({ pin_id: "p3", board: "my-style", domain: "fashion", model: "mock", tag: mockTag("p3", "fashion", "v1"), error: null, usage: null, cost_usd: null, ms: 1 }) + "\n");
  assert.ok(taggedKeys(outPath).has("fashion\u0000fashion.tag.v1\u0000p3"));
  assert.ok(!taggedKeys(outPath).has("fashion\u0000fashion.tag.v2\u0000p3"));
  writePins([pin("p3")]);
  const legacy = await tagPins({ inPath, outPath, boardsPath, domain: "fashion", mock: true, onlyMissing: true, log: quiet });
  assert.equal(legacy.tagged, 1, "a default (v2) resume re-tags the version-less row");
  assert.equal(legacy.records[0].prompt_version, "fashion.tag.v2");
});
