import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  readJsonl, manifestKeys, r2Key, contentType, planUploads, wranglerArgs, uploadOne, uploadImages, formatSummary, parseCli, SCHEMA_VERSION,
} from "../upload-images.mjs";

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "style-data-upload-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const quiet = () => {};
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function writeImage(name, bytes = 100, fill = 1) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, fill));
  return p;
}
function pin(id, extra = {}) {
  const image_path = extra.image_path ?? writeImage(`${id}.jpg`);
  const sha256 = extra.sha256 === undefined ? (fs.existsSync(image_path) ? sha(fs.readFileSync(image_path)) : null) : extra.sha256;
  return { schema_version: 2, pin_id: id, source: "pinterest", board: "my-style", domain: "fashion", created_at: null, title: null, description: null, link: null, dominant_color: null, image_url: null, is_video: false, raw_extra: {}, ...extra, image_path, sha256 };
}
function writePins(pins) {
  const p = path.join(dir, "pins.jsonl");
  fs.writeFileSync(p, pins.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}
/** Fake wrangler: records argv; `codes` maps r2 key → array of exit codes per attempt. */
function fakeRunner(codes = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const key = args[3].split("/").slice(1).join("/");
    const q = codes[key];
    const code = q && q.length ? q.shift() : 0;
    return { code, output: code === 0 ? "Upload complete." : "X [ERROR] boom" };
  };
  return { run, calls };
}
const fixedNow = () => new Date("2026-10-11T12:00:00.000Z");

test("r2Key follows pins/<board>/<pin_id>.<ext> with a lower-cased extension", () => {
  assert.equal(r2Key({ pin_id: "123", board: "my-style", image_path: "/x/pinterest_123.JPG" }), "pins/my-style/123.jpg");
  assert.equal(r2Key({ pin_id: "9", board: "for-the-home", image_path: "/x/a.png" }), "pins/for-the-home/9.png");
  assert.throws(() => r2Key({ pin_id: "1", board: "b", image_path: "/x/noext" }), /no extension/);
  assert.throws(() => r2Key({ pin_id: "../1", board: "b", image_path: "/x/a.jpg" }), /path separators/);
});

test("contentType maps known image extensions, octet-stream otherwise", () => {
  assert.equal(contentType("/a/b.jpg"), "image/jpeg");
  assert.equal(contentType("/a/b.JPEG"), "image/jpeg");
  assert.equal(contentType("/a/b.webp"), "image/webp");
  assert.equal(contentType("/a/b.bin"), "application/octet-stream");
});

test("wranglerArgs builds the documented put command", () => {
  const args = wranglerArgs("style-data", { r2_key: "pins/my-style/1.jpg", image_path: "/img/1.jpg", content_type: "image/jpeg" });
  assert.deepEqual(args, ["r2", "object", "put", "style-data/pins/my-style/1.jpg", "--file", "/img/1.jpg", "--content-type", "image/jpeg", "--remote"]);
});

test("planUploads: skips dupes and missing images, honours the manifest and --limit, sums bytes", () => {
  const pins = [
    pin("1", { image_path: writeImage("1.jpg", 10) }),
    pin("2", { image_path: writeImage("2.png", 20), board: "for-the-home" }),
    pin("3", { dupe_of: "1" }),
    pin("4", { image_path: path.join(dir, "missing.jpg") }),
    pin("5", { image_path: writeImage("5.jpg", 50), sha256: null }),
  ];
  const manifest = [{ pin_id: "1", sha256: pins[0].sha256 }];
  const plan = planUploads(pins, manifest);
  assert.deepEqual(plan.todo.map((t) => t.r2_key), ["pins/for-the-home/2.png", "pins/my-style/5.jpg"]);
  assert.equal(plan.todo[1].sha256, sha(Buffer.alloc(50, 1)), "null sha256 is computed from the file");
  assert.equal(plan.skippedExisting, 1);
  assert.equal(plan.dupes, 1);
  assert.equal(plan.missing, 1);
  assert.equal(plan.bytes, 70);
  const limited = planUploads(pins, manifest, { limit: 1 });
  assert.deepEqual(limited.todo.map((t) => t.pin_id), ["2"]);
  assert.equal(limited.bytes, 20);
});

test("manifest idempotency: a changed image (new sha256) is uploaded again under the same key", () => {
  const p = pin("1", { image_path: writeImage("1.jpg", 10, 1) });
  assert.equal(planUploads([p], [{ pin_id: "1", sha256: p.sha256 }]).todo.length, 0);
  assert.equal(planUploads([p], [{ pin_id: "1", sha256: "different" }]).todo.length, 1);
  assert.equal(manifestKeys([{ pin_id: "a", sha256: "s" }]).has("a\ts"), true);
});

test("--dry-run lists uploads with the byte total and runs nothing", async () => {
  const pinsPath = writePins([pin("1", { image_path: writeImage("1.jpg", 10) }), pin("2", { image_path: writeImage("2.jpg", 15) }), pin("3", { dupe_of: "1" })]);
  const manifestPath = path.join(dir, "images.jsonl");
  const { run, calls } = fakeRunner();
  const lines = [];
  const s = await uploadImages({ pinsPath, manifestPath, dryRun: true, run, log: (l) => lines.push(l) });
  assert.equal(calls.length, 0);
  assert.ok(!fs.existsSync(manifestPath), "dry-run writes no manifest");
  assert.equal(s.planned, 2);
  assert.equal(s.plannedBytes, 25);
  assert.equal(s.dupes, 1);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[dry-run\] style-data\/pins\/my-style\/1\.jpg  10 bytes  image\/jpeg$/);
  const text = formatSummary(s);
  assert.match(text, /dry-run, nothing ran/);
  assert.match(text, /would upload 2  \(25 bytes/);
});

test("uploads append to the manifest and a re-run uploads nothing", async () => {
  const pins = [pin("1", { image_path: writeImage("1.jpg", 10) }), pin("2", { image_path: writeImage("2.png", 20), board: "swim-look" }), pin("3", { dupe_of: "1" })];
  const pinsPath = writePins(pins);
  const manifestPath = path.join(dir, "sub", "images.jsonl");
  const { run, calls } = fakeRunner();
  const s = await uploadImages({ pinsPath, manifestPath, bucket: "style-data", run, now: fixedNow, log: quiet });
  assert.equal(s.uploaded, 2);
  assert.equal(s.failed, 0);
  assert.equal(s.bytes, 30);
  assert.equal(s.dupes, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((a) => a[3]).sort(), ["style-data/pins/my-style/1.jpg", "style-data/pins/swim-look/2.png"]);
  assert.ok(calls.every((a) => a.includes("--remote") && a.includes("--content-type")));

  const rows = readJsonl(manifestPath);
  assert.equal(rows.length, 2);
  const r1 = rows.find((r) => r.pin_id === "1");
  assert.deepEqual(Object.keys(r1), ["schema_version", "pin_id", "board", "r2_key", "sha256", "bytes", "content_type", "uploaded_at"]);
  assert.deepEqual(r1, { schema_version: SCHEMA_VERSION, pin_id: "1", board: "my-style", r2_key: "pins/my-style/1.jpg", sha256: pins[0].sha256, bytes: 10, content_type: "image/jpeg", uploaded_at: "2026-10-11T12:00:00.000Z" });

  const again = await uploadImages({ pinsPath, manifestPath, run, now: fixedNow, log: quiet });
  assert.equal(again.uploaded, 0);
  assert.equal(again.skippedExisting, 2);
  assert.equal(calls.length, 2, "no wrangler calls on the second run");
  assert.equal(readJsonl(manifestPath).length, 2, "manifest is not rewritten or duplicated");
  assert.match(formatSummary(again), /uploaded 0  failed 0  bytes 0/);
  assert.match(formatSummary(again), /skipped-existing 2  dupes 1  missing 0/);
});

test("retry: one failure then success is uploaded; two failures are reported and not written", async () => {
  const pinsPath = writePins([pin("1", { image_path: writeImage("1.jpg", 10) }), pin("2", { image_path: writeImage("2.jpg", 10) })]);
  const manifestPath = path.join(dir, "images.jsonl");
  const { run, calls } = fakeRunner({ "pins/my-style/1.jpg": [1, 0], "pins/my-style/2.jpg": [1, 1] });
  const s = await uploadImages({ pinsPath, manifestPath, concurrency: 1, run, now: fixedNow, log: quiet });
  assert.equal(s.uploaded, 1);
  assert.equal(s.failed, 1);
  assert.equal(calls.length, 4, "each item tried exactly twice");
  assert.deepEqual(s.failures.map((f) => f.pin_id), ["2"]);
  assert.match(s.failures[0].error, /exit 1: X \[ERROR\] boom/);
  assert.deepEqual(readJsonl(manifestPath).map((r) => r.pin_id), ["1"]);
});

test("uploadOne treats a thrown runner error as a failed attempt and retries once", async () => {
  let n = 0;
  const run = async () => { n++; if (n === 1) throw new Error("spawn ENOENT"); return { code: 0 }; };
  const r = await uploadOne({ r2_key: "pins/b/1.jpg", image_path: "/x/1.jpg", content_type: "image/jpeg" }, { bucket: "style-data", run });
  assert.deepEqual(r, { ok: true, attempts: 2 });
  const r2 = await uploadOne({ r2_key: "pins/b/1.jpg", image_path: "/x/1.jpg", content_type: "image/jpeg" }, { bucket: "style-data", run: async () => { throw new Error("ENOENT"); } });
  assert.equal(r2.ok, false);
  assert.equal(r2.attempts, 2);
  assert.match(r2.error, /ENOENT/);
});

test("--limit caps the uploads of one run and --concurrency bounds parallel wrangler calls", async () => {
  const pinsPath = writePins(Array.from({ length: 6 }, (_, i) => pin(String(i), { image_path: writeImage(`${i}.jpg`, 1) })));
  const manifestPath = path.join(dir, "images.jsonl");
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { code: 0 };
  };
  const s = await uploadImages({ pinsPath, manifestPath, limit: 4, concurrency: 2, run, log: quiet });
  assert.equal(s.uploaded, 4);
  assert.equal(maxInFlight, 2);
  assert.equal(readJsonl(manifestPath).length, 4);
});

test("readJsonl: missing file is empty, invalid lines name their line number", () => {
  assert.deepEqual(readJsonl(path.join(dir, "nope.jsonl")), []);
  const p = path.join(dir, "bad.jsonl");
  fs.writeFileSync(p, '{"a":1}\n\nnot json\n');
  assert.throws(() => readJsonl(p), /bad\.jsonl:3: invalid JSON/);
});

test("parseCli defaults and validation", () => {
  const d = parseCli([]);
  assert.equal(d.bucket, "style-data");
  assert.equal(d.concurrency, 2);
  assert.equal(d.limit, Infinity);
  assert.equal(d.dryRun, false);
  assert.ok(d.pinsPath.endsWith(path.join("data", "pins.jsonl")));
  assert.ok(d.manifestPath.endsWith(path.join("data", "images.jsonl")));
  const o = parseCli(["--pins", "p.jsonl", "--manifest", "m.jsonl", "--bucket", "b", "--concurrency", "3", "--dry-run", "--limit", "7"]);
  assert.deepEqual(o, { pinsPath: "p.jsonl", manifestPath: "m.jsonl", bucket: "b", concurrency: 3, dryRun: true, limit: 7 });
  assert.throws(() => parseCli(["--limit", "x"]), /--limit/);
  assert.throws(() => parseCli(["--concurrency", "1.5"]), /--concurrency/);
});
