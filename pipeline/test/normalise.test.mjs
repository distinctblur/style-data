import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BOARDS_FILE,
  DEFAULT_IN_DIR,
  DEFAULT_OUT_PATH,
  KEYS,
  RICH_DESCRIPTION_MAX,
  SCHEMA_VERSION,
  UNKNOWN_DOMAIN,
  clip,
  collect,
  compareOutput,
  dedupe,
  hostnameOf,
  isVideo,
  loadDomains,
  normalisePin,
  parseCli,
  run,
  summarise,
  toColour,
  toIso,
  toLine,
  toLinkDomain,
  toRawExtra,
  toRich,
  toStats,
} from "../normalise.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FIXTURE = path.join(HERE, "fixtures", "pins.sample.jsonl");

const sha = (s) => createHash("sha256").update(s).digest("hex");
const DOMAINS = new Map([["my-style", "fashion"], ["swim-look", "fashion"], ["for-the-home", "home"]]);
const quiet = () => {};

/** Keys of a serialised line: KEYS with `dupe_of` after `is_video` when the record is a dupe. */
function expectedKeys(dupe) {
  const i = KEYS.indexOf("is_video") + 1;
  return dupe ? [...KEYS.slice(0, i), "dupe_of", ...KEYS.slice(i)] : KEYS;
}

/** A realistic gallery-dl board-feed ("grid") sidecar, trimmed to the fields we read. */
function gridSidecar(overrides = {}) {
  return {
    id: "134545107614062497",
    title: "",
    grid_title: "",
    description: "",
    link: null,
    link_domain: null,
    domain: "Uploaded by user",
    dominant_color: "#917863",
    is_video: false,
    videos: null,
    story_pin_data: null,
    width: 2048,
    height: 2048,
    images: { orig: { width: 2048, height: 2048, url: "https://i.pinimg.com/originals/98/cb/27/98cb27.jpg" } },
    url: "https://i.pinimg.com/originals/98/cb/27/98cb27.jpg",
    seo_alt_text: "Linen Set Summer Outfit Ideas, Linen Outfit",
    auto_alt_text: null,
    aggregated_pin_data: { aggregated_stats: { saves: 152, done: 0 } },
    reaction_counts: {},
    repin_count: 3,
    pinner: { username: "megsk8", full_name: "Meghan Hill", id: "1" },
    native_creator: null,
    is_repin: true,
    rich_summary: null,
    board: { name: "My Style", id: "134545176306658103", pin_count: 686 },
    num: 1,
    count: 1,
    ...overrides,
  };
}

/** A per-pin detail sidecar (pass 2), trimmed. */
function detailSidecar(overrides = {}) {
  return {
    id: "134545107614062497",
    created_at: "Sat, 15 Feb 2025 19:40:15 +0000",
    hashtags: [],
    ai_disclosures: [],
    price_value: 0,
    price_currency: "USD",
    rich_metadata: null,
    ...overrides,
  };
}

const PRODUCT_SUMMARY = {
  type_name: "product",
  site_name: "ABLE",
  display_name: "Mamuye Classic Tote",
  display_description: "The tote that started it all.",
  url: "https://www.livefashionable.com/products/mamuye-classic-tote",
  favicon_link: "https://s.pinimg.com/images/default_rich_pin_favicon.png",
  products: [{ name: "Mamuye Classic Tote", purchase_url: null, offer_summary: { price_val: 228, currency: "USD", price: "$228.00", in_stock: true } }],
};

const PRODUCT_METADATA = {
  title: "Mamuye Classic Tote | ABLE",
  description: "Handcrafted leather tote.",
  site_name: "ABLE",
  favicon_images: { orig: "x" },
  products: [
    {
      name: "Mamuye Classic Tote",
      purchase_url: "https://www.livefashionable.com/buy/1",
      offer_summary: { price_val: 228, currency: "USD", price: "$228.00", in_stock: true },
      brand: { name: "able" },
      offers: [],
    },
  ],
};

test("schema v2 field mapping from a grid sidecar plus detail record", () => {
  const sidecar = gridSidecar({
    title: " Linen set ",
    description: "Summer uniform\n",
    link: "https://shop.example.com/linen?x=1",
    dominant_color: "#ABCDEF",
    reaction_counts: { 1: 2, 5: 1 },
    native_creator: { username: "creator1" },
  });
  const detail = detailSidecar({ hashtags: ["#linen"] });
  const pin = normalisePin(sidecar, {
    board: "my-style",
    domain: "fashion",
    imagePath: "/repo/out/pins/my-style/pinterest_134545107614062497.jpg",
    sha256: "ab".repeat(32),
    detail,
  });
  assert.deepEqual(pin, {
    schema_version: 2,
    pin_id: "134545107614062497",
    source: "pinterest",
    board: "my-style",
    domain: "fashion",
    created_at: "2025-02-15T19:40:15.000Z",
    title: "Linen set",
    description: "Summer uniform",
    link: "https://shop.example.com/linen?x=1",
    link_domain: "shop.example.com",
    dominant_color: "#abcdef",
    image_path: "/repo/out/pins/my-style/pinterest_134545107614062497.jpg",
    image_url: "https://i.pinimg.com/originals/98/cb/27/98cb27.jpg",
    image_width: 2048,
    image_height: 2048,
    sha256: "ab".repeat(32),
    is_video: false,
    alt_text: "Linen Set Summer Outfit Ideas, Linen Outfit",
    stats: { saves: 152, repins: 3, reactions: 3 },
    rich: null,
    raw_extra: {
      hashtags: ["#linen"],
      pinner_username: "megsk8",
      native_creator_username: "creator1",
      is_repin: true,
      has_story_pin_data: false,
      ai_disclosures: [],
    },
  });
  assert.deepEqual(Object.keys(pin), KEYS, "keys come out in schema order");
  assert.equal(SCHEMA_VERSION, 2);
});

test("null-safety: empty strings, missing fields, bad colour, bad date, non-object inputs", () => {
  const pin = normalisePin(
    { id: 42, title: "   ", dominant_color: "brown", created_at: "not a date", width: "600" },
    { board: "swim-look", imagePath: "/x/y.jpg", sha256: null },
  );
  assert.equal(pin.pin_id, "42");
  assert.equal(pin.domain, UNKNOWN_DOMAIN, "domain defaults to unknown");
  assert.equal(pin.created_at, null);
  assert.equal(pin.title, null);
  assert.equal(pin.description, null);
  assert.equal(pin.link, null);
  assert.equal(pin.link_domain, null);
  assert.equal(pin.dominant_color, null);
  assert.equal(pin.image_url, null);
  assert.equal(pin.image_width, null, "non-numeric width is null");
  assert.equal(pin.image_height, null);
  assert.equal(pin.sha256, null);
  assert.equal(pin.is_video, false);
  assert.equal(pin.alt_text, null);
  assert.deepEqual(pin.stats, { saves: null, repins: null, reactions: null });
  assert.equal(pin.rich, null);
  assert.deepEqual(pin.raw_extra, {
    hashtags: [],
    pinner_username: null,
    native_creator_username: null,
    is_repin: null,
    has_story_pin_data: false,
    ai_disclosures: [],
  });
  // Completely empty / non-object inputs do not throw.
  assert.equal(normalisePin(null, { board: "my-style", imagePath: "/a", sha256: null }).pin_id, null);
  assert.equal(normalisePin({}, { board: "my-style", imagePath: "/a", sha256: null, detail: "junk" }).board, "my-style");
  assert.equal(normalisePin({}, { board: "b", imagePath: "/a", sha256: null, detail: { id: 7 } }).pin_id, "7", "pin id falls back to detail");
  assert.equal(toIso(undefined), null);
  assert.equal(toIso("2025-02-15T19:40:15Z"), "2025-02-15T19:40:15.000Z");
  assert.equal(toColour("#FFF"), null);
  assert.equal(toColour(" #ffAA00 "), "#ffaa00");
  assert.equal(hostnameOf("not a url"), null);
  assert.equal(hostnameOf("HTTPS://Shop.Example.com:8443/p"), "shop.example.com");
});

test("title falls back to grid_title, description to closeup text, link to tracked_link, alt_text to auto_alt_text", () => {
  const pin = normalisePin(gridSidecar({ grid_title: "Board grid title", seo_alt_text: "", auto_alt_text: "a woman in a linen set" }), {
    board: "my-style",
    imagePath: "/a.jpg",
    sha256: null,
    detail: { closeup_unified_description: "From detail", tracked_link: "https://t.example/1" },
  });
  assert.equal(pin.title, "Board grid title");
  assert.equal(pin.description, "From detail");
  assert.equal(pin.link, "https://t.example/1");
  assert.equal(pin.link_domain, "t.example");
  assert.equal(pin.alt_text, "a woman in a linen set");
  assert.equal(pin.image_width, 2048, "dimensions fall back to images.orig");
});

test("link_domain: link_domain.id, else sidecar domain unless 'Uploaded by user', else hostname of link", () => {
  assert.equal(toLinkDomain({ link_domain: { id: "www.YouTube.com" }, domain: "youtube.com" }, {}, "https://x.example/"), "www.youtube.com");
  assert.equal(toLinkDomain({ link_domain: null, domain: "bhg.com" }, {}, "https://www.bhg.com/a"), "bhg.com");
  assert.equal(toLinkDomain({ link_domain: null, domain: "Uploaded by user" }, {}, "https://www.bhg.com/a"), "www.bhg.com");
  assert.equal(toLinkDomain({ link_domain: null, domain: "Uploaded by user" }, {}, null), null);
  assert.equal(toLinkDomain({}, { link_domain: { id: "etsy.com" } }, null), "etsy.com");
});

test("stats: saves from aggregated_stats, repins from repin_count, reactions summed; nulls when absent", () => {
  assert.deepEqual(toStats(gridSidecar({ reaction_counts: { 1: 4, 2: "x", 3: 1 } }), {}), { saves: 152, repins: 3, reactions: 5 });
  assert.deepEqual(toStats({}, {}), { saves: null, repins: null, reactions: null });
  assert.deepEqual(toStats({ aggregated_pin_data: null, reaction_counts: [] }, { repin_count: 9, reaction_counts: {} }), { saves: null, repins: 9, reactions: 0 });
});

test("rich: built from rich_summary + rich_metadata + price_value; small, no HTML, no favicons", () => {
  const rich = toRich(gridSidecar({ rich_summary: PRODUCT_SUMMARY }), detailSidecar({ rich_metadata: PRODUCT_METADATA, price_value: 228, price_currency: "USD" }));
  assert.deepEqual(rich, {
    type: "product",
    site_name: "ABLE",
    display_name: "Mamuye Classic Tote",
    display_description: "The tote that started it all.",
    price_value: 228,
    price_currency: "USD",
    products: [{ name: "Mamuye Classic Tote", purchase_url: "https://www.livefashionable.com/buy/1", price: 228, currency: "USD", in_stock: true }],
  });
  assert.ok(!JSON.stringify(rich).includes("favicon"));

  // Products fall back to rich_summary when rich_metadata has none; price comes from the product when price_value is 0.
  const fromSummary = toRich(gridSidecar({ rich_summary: PRODUCT_SUMMARY }), detailSidecar());
  assert.equal(fromSummary.price_value, 228);
  assert.equal(fromSummary.price_currency, "USD");
  assert.equal(fromSummary.products[0].purchase_url, null);

  // Article / page metadata only, from the detail side.
  const article = toRich(gridSidecar(), detailSidecar({ rich_metadata: { title: "T", description: "D", site_name: "S", article: { name: "Article name", description: "Article desc" } } }));
  assert.deepEqual(article, { type: "article", site_name: "S", display_name: "T", display_description: "D", price_value: null, price_currency: null, products: [] });

  // type_name wins; empty strings become null; price_value 0 means no price.
  const classifier = toRich(gridSidecar({ rich_summary: { type_name: "classifier data", site_name: "beachsissi", display_name: "", display_description: "", products: [] } }), detailSidecar());
  assert.equal(classifier.type, "classifier data");
  assert.equal(classifier.display_name, null);
  assert.equal(classifier.price_value, null);

  // Detail-level price with no rich blocks still yields a block; nothing at all yields null.
  assert.deepEqual(toRich(gridSidecar(), detailSidecar({ price_value: 40 })), { type: "price", site_name: null, display_name: null, display_description: null, price_value: 40, price_currency: "USD", products: [] });
  assert.equal(toRich(gridSidecar(), detailSidecar()), null);
  assert.equal(toRich({}, {}), null);

  // Long marketing copy is clipped.
  const long = "x".repeat(RICH_DESCRIPTION_MAX + 50);
  const clipped = toRich(gridSidecar({ rich_summary: { type_name: "article", display_description: long } }), {});
  assert.equal([...clipped.display_description].length, RICH_DESCRIPTION_MAX + 1);
  assert.ok(clipped.display_description.endsWith("…"));
  assert.equal(clip("short"), "short");
  assert.equal(clip("   "), null);
});

test("raw_extra keeps only the handful of flat raw keys", () => {
  const extra = toRawExtra(
    gridSidecar({ story_pin_data: { pages: [] }, native_creator: { username: "nc" }, is_repin: false }),
    detailSidecar({ hashtags: ["#a", 7, "#b"], ai_disclosures: ["generated"] }),
  );
  assert.deepEqual(extra, {
    hashtags: ["#a", "#b"],
    pinner_username: "megsk8",
    native_creator_username: "nc",
    is_repin: false,
    has_story_pin_data: true,
    ai_disclosures: ["generated"],
  });
  assert.deepEqual(Object.keys(extra), ["hashtags", "pinner_username", "native_creator_username", "is_repin", "has_story_pin_data", "ai_disclosures"]);
});

test("is_video from is_video flag, videos object, or story video block", () => {
  assert.equal(isVideo(gridSidecar()), false);
  assert.equal(isVideo(gridSidecar({ is_video: true })), true);
  assert.equal(isVideo(gridSidecar({ videos: { video_list: {} } })), true);
  assert.equal(
    isVideo(gridSidecar({ story_pin_data: { pages: [{ blocks: [{ type: "story_pin_video_block" }] }] } })),
    true,
  );
  assert.equal(
    isVideo(gridSidecar({ story_pin_data: { pages: [{ blocks: [{ type: "story_pin_image_block" }] }] } })),
    false,
  );
  assert.equal(isVideo(null), false);
});

test("sha256 dedupe keeps the earliest by created_at and marks later ones with dupe_of", () => {
  const mk = (pin_id, board, created_at, sha256) => ({ pin_id, board, created_at, sha256, is_video: false });
  const out = dedupe([
    mk("b-late", "swim-look", "2024-06-01T00:00:00.000Z", "h1"),
    mk("a-early", "my-style", "2023-01-01T00:00:00.000Z", "h1"),
    mk("c-undated", "my-style", null, "h1"),
    mk("d-unique", "my-style", "2022-01-01T00:00:00.000Z", "h2"),
    mk("e-noimage-1", "my-style", "2021-01-01T00:00:00.000Z", null),
    mk("e-noimage-2", "my-style", "2021-02-01T00:00:00.000Z", null),
  ]);
  const byId = Object.fromEntries(out.map((p) => [p.pin_id, p]));
  assert.equal(byId["a-early"].dupe_of, undefined, "earliest keeps the hash");
  assert.equal(byId["b-late"].dupe_of, "a-early", "dupes are marked across boards");
  assert.equal(byId["c-undated"].dupe_of, "a-early", "undated sorts last so it is a dupe");
  assert.equal(byId["d-unique"].dupe_of, undefined);
  assert.equal(byId["e-noimage-1"].dupe_of, undefined, "null sha256 never dedupes");
  assert.equal(byId["e-noimage-2"].dupe_of, undefined);
  assert.equal(out.length, 6, "nothing is dropped");
});

test("output ordering: board, then created_at ascending with nulls last, then pin_id", () => {
  const mk = (pin_id, board, created_at) => ({ pin_id, board, created_at, sha256: null });
  const out = [
    mk("3", "swim-look", "2020-01-01T00:00:00.000Z"),
    mk("2", "my-style", null),
    mk("1", "my-style", "2021-01-01T00:00:00.000Z"),
    mk("0", "my-style", "2021-01-01T00:00:00.000Z"),
    mk("4", "my-style", "2019-01-01T00:00:00.000Z"),
  ].sort(compareOutput);
  assert.deepEqual(out.map((p) => p.pin_id), ["4", "0", "1", "2", "3"]);
});

test("toLine emits schema keys in order, dupe_of right after is_video, fixed defaults for missing fields", () => {
  const line = JSON.parse(toLine({ pin_id: "1", board: "my-style", sha256: "h", dupe_of: "0", is_video: true }));
  assert.deepEqual(Object.keys(line), expectedKeys(true));
  assert.equal(line.schema_version, 2);
  assert.equal(line.source, "pinterest");
  assert.equal(line.domain, UNKNOWN_DOMAIN);
  assert.equal(line.title, null);
  assert.deepEqual(line.stats, { saves: null, repins: null, reactions: null });
  assert.equal(line.rich, null);
  assert.deepEqual(line.raw_extra, {});
  const plain = JSON.parse(toLine({ pin_id: "1", board: "my-style", domain: "fashion" }));
  assert.equal("dupe_of" in plain, false);
  assert.deepEqual(Object.keys(plain), KEYS);
  assert.equal(plain.is_video, false);
  assert.equal(plain.domain, "fashion");
});

test("loadDomains reads boards.json (real file and a bad one)", () => {
  const real = loadDomains(DEFAULT_BOARDS_FILE, { log: quiet });
  assert.equal(real.get("my-style"), "fashion");
  assert.equal(real.get("for-the-home"), "home");
  const warnings = [];
  const missing = loadDomains(path.join(os.tmpdir(), "does-not-exist-boards.json"), { log: (l) => warnings.push(l) });
  assert.equal(missing.size, 0);
  assert.match(warnings[0], /cannot read/);
});

test("collect + run: walks <in>/<board>/*.json, hashes images, merges detail/, assigns domains, reports missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "style-data-pins-"));
  try {
    const write = (rel, content) => {
      const p = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    };
    const sc = (overrides) => JSON.stringify(gridSidecar(overrides));
    // my-style: two distinct images, one with detail created_at; one pin with two files (num 1 & 2).
    write("my-style/pinterest_1.jpg", "IMAGE-A");
    write("my-style/pinterest_1.jpg.json", sc({ id: "1", rich_summary: PRODUCT_SUMMARY }));
    write("my-style/detail/pinterest_1.jpg.json", JSON.stringify(detailSidecar({ id: "1", created_at: "Mon, 01 Jan 2024 00:00:00 +0000", rich_metadata: PRODUCT_METADATA, hashtags: ["#tote"] })));
    write("my-style/pinterest_2_x.webp", "IMAGE-B");
    write("my-style/pinterest_2_x.webp.json", sc({ id: "2", num: 2, count: 2, created_at: "Tue, 02 Jan 2024 00:00:00 +0000" }));
    write("my-style/pinterest_2.webp", "IMAGE-B1");
    write("my-style/pinterest_2.webp.json", sc({ id: "2", num: 1, count: 2, created_at: "Tue, 02 Jan 2024 00:00:00 +0000" }));
    // swim-look: a byte-identical copy of IMAGE-A (later date -> dupe), and a sidecar with no image.
    write("swim-look/pinterest_3.jpg", "IMAGE-A");
    write("swim-look/pinterest_3.jpg.json", sc({ id: "3", created_at: "Wed, 03 Jan 2024 00:00:00 +0000", is_video: true }));
    write("swim-look/pinterest_4.jpg.json", sc({ id: "4" }));
    write("swim-look/broken.jpg.json", "{not json");
    // an unregistered board directory, and the logs directory that must be ignored
    write("mystery/pinterest_5.jpg", "IMAGE-C");
    write("mystery/pinterest_5.jpg.json", sc({ id: "5" }));
    write("logs/ignored.json", "{}");
    write("logs/my-style.pins.txt", "https://www.pinterest.com/pin/1/\n");

    const warnings = [];
    const { pins, stats } = collect(tmp, { domains: DOMAINS, log: (l) => warnings.push(l) });
    assert.equal(pins.length, 5);
    assert.equal(stats.extraFiles, 1, "second file of pin 2 is skipped");
    assert.equal(stats.missingImages, 1);
    assert.equal(stats.unreadable, 1);
    assert.deepEqual(stats.unknownBoards, ["mystery"]);
    assert.ok(warnings.some((w) => /"mystery" is not registered/.test(w)), "unregistered board warns on stderr");
    const p2 = pins.find((p) => p.pin_id === "2");
    assert.equal(p2.image_path, path.join(tmp, "my-style", "pinterest_2.webp"), "lowest num wins; extension is whatever gallery-dl wrote");
    assert.equal(p2.sha256, sha("IMAGE-B1"));
    assert.equal(p2.domain, "fashion");
    assert.equal(pins.find((p) => p.pin_id === "5").domain, UNKNOWN_DOMAIN);

    const out = path.join(tmp, "out", "pins.jsonl");
    const boardsFile = path.join(tmp, "boards.json");
    fs.writeFileSync(boardsFile, JSON.stringify({ boards: [...DOMAINS].map(([slug, domain]) => ({ slug, url: "https://x/", domain })) }));
    const { summary } = run({ inDir: tmp, outPath: out, boardsFile, log: quiet });
    const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((p) => p.pin_id), ["1", "2", "5", "3", "4"], "sorted by board then created_at");
    assert.equal(lines[0].created_at, "2024-01-01T00:00:00.000Z", "created_at merged from detail/");
    assert.equal(lines[0].sha256, sha("IMAGE-A"));
    assert.equal(lines[0].domain, "fashion");
    assert.equal(lines[0].rich.type, "product");
    assert.equal(lines[0].rich.products[0].purchase_url, "https://www.livefashionable.com/buy/1", "products merged from detail rich_metadata");
    assert.deepEqual(lines[0].raw_extra.hashtags, ["#tote"]);
    assert.equal(lines[3].dupe_of, "1");
    assert.equal(lines[3].is_video, true);
    assert.deepEqual(Object.keys(lines[3]), expectedKeys(true));
    assert.equal(lines[4].sha256, null);
    assert.equal(lines[4].image_path, path.join(tmp, "swim-look", "pinterest_4.jpg"));
    for (const l of lines) {
      assert.equal(l.schema_version, 2);
      assert.equal(l.source, "pinterest");
      assert.deepEqual(Object.keys(l), expectedKeys("dupe_of" in l));
    }
    assert.match(summary, /my-style \(fashion\): 2 pins, 0 dupes, 0 video/);
    assert.match(summary, /; rich 1\/2, with products 1, priced 1/);
    assert.match(summary, /swim-look \(fashion\): 2 pins, 1 dupes, 1 video/);
    assert.match(summary, /mystery \(unknown\): 1 pins/);
    assert.match(summary, /domains: fashion 4, unknown 1/);
    assert.match(summary, /1 missing images, 1 extra files skipped, 1 unreadable sidecars, unregistered boards: mystery/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseCli defaults to out/pins, data/pins.jsonl and boards.json; accepts --key value and --key=value", () => {
  const d = parseCli([]);
  assert.equal(d.in, DEFAULT_IN_DIR);
  assert.equal(d.out, DEFAULT_OUT_PATH);
  assert.equal(d.boards, DEFAULT_BOARDS_FILE);
  assert.equal(DEFAULT_IN_DIR, path.join(ROOT, "out", "pins"));
  assert.equal(DEFAULT_OUT_PATH, path.join(ROOT, "data", "pins.jsonl"));
  const o = parseCli(["--in", "scratch/pins", "--out=x/pins.jsonl", "--boards", "b.json"]);
  assert.equal(o.in, path.resolve("scratch/pins"));
  assert.equal(o.out, path.resolve("x/pins.jsonl"));
  assert.equal(o.boards, path.resolve("b.json"));
  assert.throws(() => parseCli(["--nope"]), /unknown argument --nope/);
  assert.throws(() => parseCli(["--in"]), /--in needs a value/);
});

test("fixture pins.sample.jsonl is 10 real v2 pins in schema order with placeholder image paths", () => {
  const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n");
  assert.equal(lines.length, 10);
  const pins = lines.map((l) => JSON.parse(l));
  const boards = new Set();
  const domains = new Set();
  for (const p of pins) {
    assert.deepEqual(Object.keys(p), expectedKeys("dupe_of" in p));
    assert.equal(p.schema_version, 2);
    assert.equal(p.source, "pinterest");
    assert.match(p.pin_id, /^\d+$/);
    // Any board slug is allowed: `board` is the out/pins sub-directory name, not an enum.
    assert.match(p.board, /^[a-z0-9-]+$/);
    assert.match(p.domain, /^[a-z]+$/);
    boards.add(p.board);
    domains.add(p.domain);
    assert.equal(p.image_path, `test/fixtures/images/${p.pin_id}.jpg`);
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof p.is_video, "boolean");
    if (p.created_at !== null) assert.equal(toIso(p.created_at), p.created_at);
    if (p.dominant_color !== null) assert.match(p.dominant_color, /^#[0-9a-f]{6}$/);
    assert.deepEqual(Object.keys(p.stats), ["saves", "repins", "reactions"]);
    if (p.rich !== null) assert.deepEqual(Object.keys(p.rich), ["type", "site_name", "display_name", "display_description", "price_value", "price_currency", "products"]);
    assert.deepEqual(Object.keys(p.raw_extra), ["hashtags", "pinner_username", "native_creator_username", "is_repin", "has_story_pin_data", "ai_disclosures"]);
  }
  assert.equal(boards.size, 3, "fixture spans all three boards");
  assert.ok(domains.has("fashion") && domains.has("home"));
  assert.ok(pins.some((p) => p.is_video), "fixture has a video pin");
  assert.ok(pins.some((p) => p.rich?.products?.length), "fixture has a pin with rich.products");
  const dupe = pins.find((p) => p.dupe_of);
  assert.ok(dupe && pins.some((p) => p.pin_id === dupe.dupe_of && p.sha256 === dupe.sha256), "fixture has a dupe pair");
  assert.deepEqual([...pins].sort(compareOutput).map((p) => p.pin_id), pins.map((p) => p.pin_id), "fixture is in output order");
  assert.match(summarise(pins), /total: 10 pins, 1 dupes/);
});
