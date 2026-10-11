import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadBoards, selectBoards, resolveCookie, buildArgv, maskArgv, formatCommand, countFiles, extractBoards, formatSummary, parseCli, COOKIE_NAME, MASK, writeCookieJar } from "../extract.mjs";

const SECRET = "SUPER-SECRET-COOKIE-VALUE-42";
const BOARDS = [
  { slug: "my-style", url: "https://www.pinterest.com/megsk8/my-style/", domain: "fashion" },
  { slug: "swim-look", url: "https://www.pinterest.com/megsk8/swim-look/", domain: "fashion" },
  { slug: "for-the-home", url: "https://www.pinterest.com/megsk8/for-the-home/", domain: "home" },
];

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "style-data-extract-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Fake runner: records calls, returns the code for the board url (default 0). */
function fakeRun(codes = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    const url = args[args.length - 1];
    return codes[url] ?? 0;
  };
  return { run, calls };
}
function collectLog() {
  const lines = [];
  return { log: (l) => lines.push(String(l)), lines };
}

test("loadBoards reads the real boards.json and rejects bad shapes", () => {
  const boards = loadBoards();
  assert.ok(boards.length >= 3);
  for (const b of boards) { assert.ok(b.slug && b.url && b.domain); }
  const bad = path.join(dir, "boards.json");
  fs.writeFileSync(bad, JSON.stringify({ boards: [{ slug: "x" }] }));
  assert.throws(() => loadBoards(bad), /slug, url and domain/);
  fs.writeFileSync(bad, JSON.stringify({ boards: [] }));
  assert.throws(() => loadBoards(bad), /non-empty/);
});

test("selectBoards filters by slug, keeps order, rejects unknown slugs", () => {
  assert.deepEqual(selectBoards(BOARDS, []).map((b) => b.slug), ["my-style", "swim-look", "for-the-home"]);
  assert.deepEqual(selectBoards(BOARDS, ["for-the-home", "my-style"]).map((b) => b.slug), ["my-style", "for-the-home"]);
  assert.throws(() => selectBoards(BOARDS, ["nope"]), /unknown board\(s\): nope/);
});

test("resolveCookie prefers env, falls back to .dev.vars, null when absent", () => {
  const devVars = path.join(dir, ".dev.vars");
  assert.equal(resolveCookie({}, devVars), null);
  fs.writeFileSync(devVars, "GEMINI_API_KEY=\nPINTEREST_SESS=\n");
  assert.equal(resolveCookie({}, devVars), null);
  fs.writeFileSync(devVars, `GEMINI_API_KEY=g\nPINTEREST_SESS="${SECRET}"\n`);
  assert.equal(resolveCookie({}, devVars), SECRET);
  assert.equal(resolveCookie({ PINTEREST_SESS: "from-env" }, devVars), "from-env");
});

test("buildArgv: uvx gallery-dl with metadata, one-image-per-pin options, cookie, range, -D out/pins/<slug>", () => {
  const { command, args, outDir } = buildArgv(BOARDS[0], { cookieFile: "/tmp/out/.cookies.txt", range: "1-5", outDir: "/tmp/out" });
  assert.equal(command, "uvx");
  assert.equal(args[0], "gallery-dl");
  assert.ok(args.includes("--write-metadata"));
  assert.ok(args.includes("stories=false") && args.includes("videos=false"));
  assert.equal(args[args.indexOf("--range") + 1], "1-5");
  assert.equal(args[args.indexOf("-D") + 1], "/tmp/out/my-style");
  assert.equal(outDir, "/tmp/out/my-style");
  assert.equal(args[args.length - 1], BOARDS[0].url);
  assert.equal(args[args.indexOf("--cookies") + 1], "/tmp/out/.cookies.txt");
  assert.ok(!args.join(" ").includes(SECRET), "the cookie value never appears in argv");
});

test("writeCookieJar writes a 0600 Netscape jar holding only the session cookie", () => {
  const out = path.join(dir, "jar");
  const file = writeCookieJar(SECRET, out);
  assert.equal(file, path.join(out, ".cookies.txt"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const body = fs.readFileSync(file, "utf8");
  assert.match(body, /^# Netscape HTTP Cookie File\n/);
  const fields = body.trim().split("\n")[1].split("\t");
  assert.equal(fields[0], ".pinterest.com");
  assert.equal(fields[5], COOKIE_NAME);
  assert.equal(fields[6], SECRET);
});

test("buildArgv without cookie or range omits both options", () => {
  const { args } = buildArgv(BOARDS[1], { outDir: "/tmp/out" });
  assert.ok(!args.includes("--cookies"));
  assert.ok(!args.includes("--range"));
  assert.equal(args[args.indexOf("-D") + 1], "/tmp/out/swim-look");
});

test("maskArgv still redacts a legacy inline cookie option and leaves everything else intact", () => {
  const args = ["gallery-dl", "-o", `cookies={"${COOKIE_NAME}":"${SECRET}"}`, "-D", "/tmp/out/my-style"];
  const masked = maskArgv(args);
  assert.equal(masked.length, args.length);
  assert.ok(!masked.join(" ").includes(SECRET));
  assert.ok(masked.includes(`cookies={"${COOKIE_NAME}":"${MASK}"}`));
  const rendered = formatCommand("uvx", masked);
  assert.ok(!rendered.includes(SECRET));
});

test("--dry-run prints masked argv for every board and runs nothing", async () => {
  const { run, calls } = fakeRun();
  const { log, lines } = collectLog();
  const s = await extractBoards(BOARDS, { cookie: SECRET, range: "1-5", outDir: path.join(dir, "out"), dryRun: true, run, log });
  assert.equal(calls.length, 0);
  assert.equal(s.failed, 0);
  assert.deepEqual(s.boards.map((b) => b.code), [null, null, null]);
  assert.ok(!fs.existsSync(path.join(dir, "out")), "dry-run creates no directories");
  const all = lines.join("\n") + formatSummary(s);
  assert.ok(!all.includes(SECRET), "cookie must never be printed");
  assert.equal(lines.filter((l) => l.startsWith("[dry-run]")).length, 3);
  assert.match(all, /nothing ran/);
  for (const b of BOARDS) assert.ok(all.includes(`-D ${path.join(dir, "out", b.slug)} ${b.url}`));
});

test("boards filter: only selected boards run, sequentially, with inherited args", async () => {
  const { run, calls } = fakeRun();
  const { log } = collectLog();
  const boards = selectBoards(BOARDS, ["swim-look"]);
  const s = await extractBoards(boards, { cookie: SECRET, outDir: path.join(dir, "out"), run, log });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "uvx");
  assert.equal(calls[0].args[calls[0].args.length - 1], BOARDS[1].url);
  const jar = calls[0].args[calls[0].args.indexOf("--cookies") + 1];
  assert.equal(jar, path.join(dir, "out", ".cookies.txt"), "the real spawn gets a jar path, not the value");
  assert.ok(!calls[0].args.join(" ").includes(SECRET));
  assert.ok(!fs.existsSync(jar), "the jar is removed after the run");
  assert.ok(fs.existsSync(path.join(dir, "out", "swim-look")), "output directory is created before the run");
  assert.deepEqual(s.boards.map((b) => [b.slug, b.code]), [["swim-look", 0]]);
});

test("a failing board is reported, the rest still run, and the summary counts files per board", async () => {
  const out = path.join(dir, "out");
  const { log } = collectLog();
  const run = async (_c, args) => {
    const d = args[args.indexOf("-D") + 1];
    if (d.endsWith("swim-look")) return 3;
    fs.writeFileSync(path.join(d, "pinterest_1.jpg"), "x");
    fs.writeFileSync(path.join(d, "pinterest_1.jpg.json"), "{}");
    fs.writeFileSync(path.join(d, "pinterest_2.png"), "x");
    fs.writeFileSync(path.join(d, "pinterest_2.png.json"), "{}");
    return 0;
  };
  const s = await extractBoards(BOARDS, { outDir: out, run, log });
  assert.equal(s.failed, 1);
  assert.deepEqual(s.boards.map((b) => [b.slug, b.code, b.images, b.sidecars]), [["my-style", 0, 2, 2], ["swim-look", 3, 0, 0], ["for-the-home", 0, 2, 2]]);
  const text = formatSummary(s);
  assert.match(text, /swim-look\s+FAILED \(exit 3\)/);
  assert.match(text, /my-style\s+ok\s+images 2  sidecars 2/);
  assert.match(text, /boards failed: 1 \/ 3/);
});

test("a runner that throws (e.g. uvx missing) counts as a failure", async () => {
  const { log } = collectLog();
  const run = async () => { throw new Error("spawn uvx ENOENT"); };
  const s = await extractBoards([BOARDS[0]], { outDir: path.join(dir, "out"), run, log });
  assert.equal(s.failed, 1);
  assert.equal(s.boards[0].code, 1);
});

test("countFiles ignores subdirectories and non-image files", () => {
  fs.mkdirSync(path.join(dir, "detail"));
  fs.writeFileSync(path.join(dir, "a.jpg"), "x");
  fs.writeFileSync(path.join(dir, "a.jpg.json"), "{}");
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  assert.deepEqual(countFiles(dir), { images: 1, sidecars: 1 });
  assert.deepEqual(countFiles(path.join(dir, "missing")), { images: 0, sidecars: 0 });
});

test("parseCli: repeatable --board, --range validation, --dry-run", () => {
  const o = parseCli(["--board", "my-style", "--board", "swim-look", "--range", "1-5", "--dry-run"]);
  assert.deepEqual(o.slugs, ["my-style", "swim-look"]);
  assert.equal(o.range, "1-5");
  assert.equal(o.dryRun, true);
  assert.deepEqual(parseCli([]).slugs, []);
  assert.equal(parseCli([]).range, null);
  assert.throws(() => parseCli(["--range", "abc"]), /--range/);
});

// --- Pass 2 (per-pin detail) and --until-complete -----------------------------------

import {
  buildDetailArgv, detailDir, pinListPath, pinUrl, listPinIds, readPinCount, pendingDetailIds, runBoardFeed,
  DEFAULT_MAX_ATTEMPTS, DEFAULT_STALL, DETAIL_SLEEP,
} from "../extract.mjs";

/** Write a pass-1 sidecar (plus an image) for `id` into `boardDir`. */
function writeGrid(boardDir, id, { pinCount = null, ext = "jpg" } = {}) {
  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(path.join(boardDir, `pinterest_${id}.${ext}`), "img");
  fs.writeFileSync(path.join(boardDir, `pinterest_${id}.${ext}.json`), JSON.stringify({ id, board: pinCount === null ? {} : { pin_count: pinCount } }));
}

/** Fake gallery-dl: pass 1 writes `feed[attempt]` ids per attempt; pass 2 writes a detail sidecar per URL in the -i list. */
function fakeGalleryDl({ feed = [], pinCount = null, detailCode = 0, feedCode = 0 } = {}) {
  const calls = [];
  let attempt = 0;
  const run = async (command, args) => {
    const dir = args[args.indexOf("-D") + 1];
    if (args.includes("--no-download")) {
      const list = fs.readFileSync(args[args.indexOf("-i") + 1], "utf8").trim().split("\n");
      calls.push({ pass: 2, dir, list });
      if (detailCode === 0) for (const url of list) {
        const id = /\/pin\/(\d+)\//.exec(url)[1];
        fs.writeFileSync(path.join(dir, `pinterest_${id}.jpg.json`), JSON.stringify({ id, created_at: "Mon, 01 Jan 2024 00:00:00 +0000" }));
      }
      return detailCode;
    }
    calls.push({ pass: 1, dir, attempt: ++attempt });
    for (const id of feed[attempt - 1] ?? []) writeGrid(dir, id, { pinCount });
    return feedCode;
  };
  return { run, calls };
}

test("buildDetailArgv: metadata-only PinResource fetch into <slug>/detail from the pin list in logs/", () => {
  const board = BOARDS[2];
  const { command, args, outDir, listFile } = buildDetailArgv(board, { cookieFile: "/tmp/out/.cookies.txt", outDir: "/tmp/out" });
  assert.equal(command, "uvx");
  assert.deepEqual(args.slice(0, 5), ["gallery-dl", "--no-download", "--write-metadata", "--sleep-request", DETAIL_SLEEP]);
  assert.equal(DETAIL_SLEEP, "0.5");
  assert.equal(args[args.indexOf("--cookies") + 1], "/tmp/out/.cookies.txt");
  assert.equal(args[args.indexOf("-D") + 1], "/tmp/out/for-the-home/detail");
  assert.equal(outDir, detailDir(board, "/tmp/out"));
  assert.equal(args[args.indexOf("-i") + 1], "/tmp/out/logs/for-the-home.pins.txt");
  assert.equal(listFile, pinListPath(board, "/tmp/out"));
  assert.ok(!args.includes("stories=false"), "pass 2 does not carry the pass-1 image options");
  assert.ok(!buildDetailArgv(board, { outDir: "/tmp/out" }).args.includes("--cookies"));
  assert.equal(pinUrl("134545107587394950"), "https://www.pinterest.com/pin/134545107587394950/");
});

test("listPinIds / readPinCount / pendingDetailIds read ids from sidecars (JSON id, else file name) and board.pin_count", () => {
  const boardDir = path.join(dir, "my-style");
  writeGrid(boardDir, "3", { pinCount: 686, ext: "png" });
  writeGrid(boardDir, "1", { pinCount: 686 });
  fs.writeFileSync(path.join(boardDir, "pinterest_2_x.jpg.json"), "{not json");
  fs.writeFileSync(path.join(boardDir, "pinterest_2.jpg.json"), JSON.stringify({ id: "2" }));
  fs.writeFileSync(path.join(boardDir, "notes.txt"), "ignored");
  assert.deepEqual(listPinIds(boardDir), ["1", "2", "3"]);
  assert.equal(readPinCount(boardDir), 686);
  assert.equal(readPinCount(path.join(dir, "missing")), null);
  assert.deepEqual(listPinIds(path.join(dir, "missing")), []);
  const det = path.join(boardDir, "detail");
  fs.mkdirSync(det);
  fs.writeFileSync(path.join(det, "pinterest_2.jpg.json"), JSON.stringify({ id: "2" }));
  assert.deepEqual(pendingDetailIds(boardDir, det), ["1", "3"]);
  assert.deepEqual(pendingDetailIds(boardDir, path.join(dir, "nope")), ["1", "2", "3"]);
});

test("--dry-run also prints the pass-2 argv for every board, with pending counts, and runs nothing", async () => {
  const { run, calls } = fakeRun();
  const { log, lines } = collectLog();
  const out = path.join(dir, "out");
  writeGrid(path.join(out, "swim-look"), "9");
  const s = await extractBoards(BOARDS, { cookie: SECRET, outDir: out, dryRun: true, untilComplete: true, run, log });
  assert.equal(calls.length, 0);
  const detail = lines.filter((l) => l.startsWith("[dry-run detail]"));
  assert.equal(detail.length, 3);
  assert.ok(!lines.join("\n").includes(SECRET));
  assert.match(detail[0], /my-style: uvx gallery-dl --no-download --write-metadata --sleep-request 0.5 --cookies .* -D .*my-style\/detail -i .*logs\/my-style\.pins\.txt \(0 pins pending\)/);
  assert.match(detail[1], /swim-look: .*\(1 pin pending\)/);
  assert.ok(lines.some((l) => l.startsWith("[dry-run] my-style:") && /until complete, max 6 attempts, stall 2/.test(l)));
  assert.ok(!fs.existsSync(pinListPath(BOARDS[1], out)), "dry-run writes no pin list");
  assert.ok(!fs.existsSync(detailDir(BOARDS[1], out)), "dry-run creates no detail directory");
  assert.deepEqual(s.boards.map((b) => [b.code, b.detailCode, b.pending]), [[null, null, 0], [null, null, 1], [null, null, 0]]);
  assert.match(formatSummary(s), /swim-look\s+planned\s+images 1  sidecars 1  detail 0/);
});

test("pass 2 runs after pass 1 for the ids found in the sidecars, skips ids that already have detail, and is skipped when nothing is pending", async () => {
  const out = path.join(dir, "out");
  const { log, lines } = collectLog();
  const fake = fakeGalleryDl({ feed: [["11", "12", "13"]], pinCount: 3 });
  const s = await extractBoards([BOARDS[0]], { cookie: SECRET, outDir: out, run: fake.run, log });
  assert.deepEqual(fake.calls.map((c) => c.pass), [1, 2], "pass 1 then pass 2");
  assert.deepEqual(fake.calls[1].list, ["11", "12", "13"].map(pinUrl));
  assert.equal(fs.readFileSync(pinListPath(BOARDS[0], out), "utf8"), ["11", "12", "13"].map(pinUrl).join("\n") + "\n");
  assert.equal(fake.calls[1].dir, detailDir(BOARDS[0], out));
  assert.deepEqual(s.boards.map((b) => [b.slug, b.code, b.detailCode, b.attempts, b.images, b.sidecars, b.detail, b.pending]), [["my-style", 0, 0, 1, 3, 3, 3, 3]]);
  assert.equal(s.failed, 0);
  assert.ok(!fs.existsSync(path.join(out, ".cookies.txt")), "jar removed after both passes");
  assert.match(formatSummary(s), /my-style\s+ok\s+images 3  sidecars 3  detail 3  detail ok/);
  assert.ok(!lines.join("\n").includes(SECRET));

  // Second run: one new pin arrives; only that one is fetched in pass 2.
  const again = fakeGalleryDl({ feed: [["14"]], pinCount: 4 });
  const s2 = await extractBoards([BOARDS[0]], { outDir: out, run: again.run, log });
  assert.deepEqual(again.calls[1].list, [pinUrl("14")]);
  assert.equal(s2.boards[0].detail, 4);

  // Third run: nothing new, so pass 2 is skipped entirely.
  const none = fakeGalleryDl({ feed: [[]] });
  const s3 = await extractBoards([BOARDS[0]], { outDir: out, run: none.run, log });
  assert.deepEqual(none.calls.map((c) => c.pass), [1]);
  assert.equal(s3.boards[0].detailCode, null);
  assert.equal(s3.boards[0].pending, 0);
  assert.match(formatSummary(s3), /my-style\s+ok\s+images 4  sidecars 4  detail 4\n/);
});

test("--skip-detail runs pass 1 only; --detail-only runs pass 2 only (from the sidecars already on disk)", async () => {
  const out = path.join(dir, "out");
  const { log } = collectLog();
  const first = fakeGalleryDl({ feed: [["21", "22"]] });
  const s1 = await extractBoards([BOARDS[1]], { outDir: out, run: first.run, log, skipDetail: true });
  assert.deepEqual(first.calls.map((c) => c.pass), [1]);
  assert.deepEqual([s1.boards[0].sidecars, s1.boards[0].detail, s1.boards[0].detailCode], [2, 0, null]);
  const second = fakeGalleryDl({});
  const s2 = await extractBoards([BOARDS[1]], { outDir: out, run: second.run, log, detailOnly: true });
  assert.deepEqual(second.calls.map((c) => c.pass), [2]);
  assert.deepEqual(second.calls[0].list, ["21", "22"].map(pinUrl));
  assert.deepEqual([s2.boards[0].code, s2.boards[0].detailCode, s2.boards[0].detail], [null, 0, 2]);
  assert.match(formatSummary(s2), /swim-look\s+skipped\s+images 2  sidecars 2  detail 2  detail ok/);
});

test("a failing or throwing pass 2 is reported and counts the board as failed", async () => {
  const out = path.join(dir, "out");
  const { log, lines } = collectLog();
  const fake = fakeGalleryDl({ feed: [["31"]], detailCode: 2 });
  const s = await extractBoards([BOARDS[0]], { outDir: out, run: fake.run, log });
  assert.equal(s.failed, 1);
  assert.deepEqual([s.boards[0].code, s.boards[0].detailCode, s.boards[0].detail], [0, 2, 0]);
  assert.match(formatSummary(s), /my-style\s+ok\s+images 1  sidecars 1  detail 0  detail FAILED \(exit 2\)/);
  assert.ok(lines.some((l) => /1 pin still without detail sidecar/.test(l)));
  writeGrid(path.join(out, "swim-look"), "32");
  const run = async (_c, args) => { if (args.includes("--no-download")) throw new Error("spawn uvx ENOENT"); return 0; };
  const t = await extractBoards([BOARDS[1]], { outDir: out, run, log });
  assert.equal(t.failed, 1);
  assert.equal(t.boards[0].detailCode, 1);
});

test("--until-complete re-runs pass 1 while sidecars grow, tolerating `stall` flat attempts, and stops at board.pin_count", async () => {
  const out = path.join(dir, "out");
  const { log, lines } = collectLog();
  // Observed Pinterest hiccup: 24 -> 24 -> full. Here: 2 -> 2 -> 5 (= pin_count).
  const fake = fakeGalleryDl({ feed: [["1", "2"], [], ["3", "4", "5"], ["6"]], pinCount: 5 });
  const s = await extractBoards([BOARDS[2]], { outDir: out, run: fake.run, log, untilComplete: true, skipDetail: true });
  assert.deepEqual(fake.calls.map((c) => c.attempt), [1, 2, 3], "stops once pin_count is reached; attempt 4 never runs");
  assert.deepEqual([s.boards[0].attempts, s.boards[0].sidecars, s.boards[0].code], [3, 5, 0]);
  assert.match(lines.find((l) => /attempt 3\/6/.test(l)), /5 sidecars \(board pin_count 5\) — stop: reached board pin_count 5/);
  assert.match(formatSummary(s), /for-the-home\s+ok\s+images 5  sidecars 5  detail 0  attempts 3/);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 6);
  assert.equal(DEFAULT_STALL, 2);
});

test("--until-complete stops after `stall` attempts without growth, after --max-attempts, and not at all without the flag", async () => {
  const { log, lines } = collectLog();
  const board = BOARDS[0];
  const opts = (fake, extra) => ({ command: "uvx", args: ["gallery-dl", "-D", path.join(dir, extra.name), board.url], dir: path.join(dir, extra.name), run: fake.run, log, ...extra });

  // stall 1: the first flat attempt ends the loop (the strict "stops growing" rule).
  let fake = fakeGalleryDl({ feed: [["1"], [], ["2"]] });
  fs.mkdirSync(path.join(dir, "a"));
  let r = await runBoardFeed(board, opts(fake, { name: "a", untilComplete: true, stall: 1 }));
  assert.deepEqual(r.attempts.map((a) => a.sidecars), [1, 1]);
  assert.match(lines.at(-1), /stop: no growth for 1 attempt \(1 sidecars\)/);

  // stall 2 (default): one flat attempt is tolerated, two in a row stop it.
  fake = fakeGalleryDl({ feed: [["1"], [], ["2"], [], []] });
  fs.mkdirSync(path.join(dir, "b"));
  r = await runBoardFeed(board, opts(fake, { name: "b", untilComplete: true }));
  assert.deepEqual(r.attempts.map((a) => a.sidecars), [1, 1, 2, 2, 2]);
  assert.match(lines.at(-1), /stop: no growth for 2 attempts/);

  // max attempts caps a feed that keeps growing but never reaches pin_count.
  fake = fakeGalleryDl({ feed: [["1"], ["2"], ["3"], ["4"]], pinCount: 100 });
  fs.mkdirSync(path.join(dir, "c"));
  r = await runBoardFeed(board, opts(fake, { name: "c", untilComplete: true, maxAttempts: 3 }));
  assert.equal(r.attempts.length, 3);
  assert.match(lines.at(-1), /giving up after 3 attempts \(3 sidecars\)/);

  // without --until-complete: exactly one attempt, whatever happens.
  fake = fakeGalleryDl({ feed: [[], ["1"]] });
  fs.mkdirSync(path.join(dir, "d"));
  r = await runBoardFeed(board, opts(fake, { name: "d" }));
  assert.equal(r.attempts.length, 1);

  // a feed that returns nothing at all gives up after `stall` attempts with exit code preserved.
  fake = fakeGalleryDl({ feed: [], feedCode: 4 });
  fs.mkdirSync(path.join(dir, "e"));
  r = await runBoardFeed(board, opts(fake, { name: "e", untilComplete: true }));
  assert.deepEqual([r.attempts.length, r.code], [2, 4]);
});

test("parseCli: --until-complete, --max-attempts, --stall, --skip-detail / --detail-only", () => {
  const d = parseCli([]);
  assert.deepEqual([d.untilComplete, d.maxAttempts, d.stall, d.skipDetail, d.detailOnly], [false, 6, 2, false, false]);
  const o = parseCli(["--until-complete", "--max-attempts", "9", "--stall", "1", "--skip-detail"]);
  assert.deepEqual([o.untilComplete, o.maxAttempts, o.stall, o.skipDetail], [true, 9, 1, true]);
  assert.equal(parseCli(["--detail-only"]).detailOnly, true);
  assert.throws(() => parseCli(["--max-attempts", "0"]), /--max-attempts/);
  assert.throws(() => parseCli(["--stall", "x"]), /--stall/);
  assert.throws(() => parseCli(["--skip-detail", "--detail-only"]), /mutually exclusive/);
});
