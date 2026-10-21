// Builds Plateful's offline nutrition data from free public sources:
//   - USDA FoodData Central Foundation Foods + SR Legacy  -> foods.json (searchable generic foods)
//   - USDA FoodData Central Branded Foods                  -> barcode shards
//   - Open Food Facts nightly CSV export                   -> more barcode shards
// Output goes to .data-cache/out (kept between Netlify builds by plugins/data-cache)
// and is reused until it is older than DATA_MAX_AGE_DAYS.
//
// Run directly: node scripts/build-data.mjs

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createGunzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { readDelimited, columns } from "./lib/csv.mjs";
import { downloadToFile, openStream, openZip, log } from "./lib/io.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIR = join(ROOT, ".data-cache");
const OUT = join(CACHE_DIR, "out");
const META = join(CACHE_DIR, "meta.json");
const TMP = join(tmpdir(), "plateful-dl");

const env = (k, d) => (process.env[k] ?? "").trim() || d;
const flag = (k) => /^(1|true|yes)$/i.test(env(k, ""));

// Known-good fallbacks (April 2026 releases), used if the USDA download page can't be read.
const FALLBACK = {
  foundation: "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip",
  sr: "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip",
  branded: "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_branded_food_csv_2026-04-30.zip",
};
const OFF_DEFAULT = "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz";

// ---------- shared helpers (the app uses the same key + shard rules) ----------
export function canonCode(code) {
  const d = String(code || "").replace(/\D/g, "").replace(/^0+/, "");
  return d.length >= 6 && d.length <= 14 ? d : null;
}
const mem = () => Math.round(process.memoryUsage().heapUsed / 1048576) + " MB heap";
export const shardOf = (key) => key.padStart(4, "0").slice(-4, -1);
const r1 = (n) => Math.round(n * 10) / 10;
// Strings cut from a CSV chunk keep the whole chunk alive in V8 (sliced strings), which made the
// Branded import hold the entire ingredients file in memory. Store standalone copies instead.
const own = (s) => (s ? Buffer.from(String(s), "utf8").toString("utf8") : "");
const num = (s) => { if (s === undefined || s === null || s === "") return NaN; return parseFloat(s); };
function tidy(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s)) {
    s = s.toLowerCase().replace(/(^|[\s\-\/(&,])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }
  return own(s.slice(0, 90));
}
function fmtAmount(a) {
  const n = parseFloat(a);
  if (!isFinite(n) || n <= 0) return "";
  const fr = { 0.25: "1/4", 0.5: "1/2", 0.75: "3/4", 0.33: "1/3", 0.333: "1/3", 0.67: "2/3", 0.667: "2/3" };
  return fr[n] || String(r1(n));
}

// ---------- source discovery ----------
async function discoverUsda() {
  const urls = {
    foundation: env("USDA_FOUNDATION_URL"),
    sr: env("USDA_SR_URL"),
    branded: env("USDA_BRANDED_URL"),
  };
  if (urls.foundation && urls.sr && urls.branded) return urls;
  try {
    const res = await fetch("https://fdc.nal.usda.gov/download-datasets", { headers: { "User-Agent": "Plateful build" } });
    const html = await res.text();
    const re = /fdc-datasets\/(FoodData_Central_(foundation_food|sr_legacy_food|branded_food)_csv_(\d{4}-\d{2}(?:-\d{2})?)\.zip)/g;
    const best = {};
    for (const m of html.matchAll(re)) {
      const kind = { foundation_food: "foundation", sr_legacy_food: "sr", branded_food: "branded" }[m[2]];
      if (!best[kind] || m[3] > best[kind].date) best[kind] = { date: m[3], url: "https://fdc.nal.usda.gov/fdc-datasets/" + m[1] };
    }
    for (const k of Object.keys(FALLBACK)) urls[k] = urls[k] || best[k]?.url || FALLBACK[k];
    log("USDA releases:", Object.entries(urls).map(([k, v]) => `${k}=${v.split("/").pop()}`).join(" "));
  } catch (e) {
    log(`could not read USDA download page (${e.message}); using known April 2026 releases`);
    for (const k of Object.keys(FALLBACK)) urls[k] = urls[k] || FALLBACK[k];
  }
  return urls;
}

// ---------- USDA generic foods (Foundation + SR Legacy) ----------
const N = { kcal: [1008, 2047, 2048], p: [1003], c: [1005, 1050], f: [1004, 1085], kj: [1062] };
const WANT = new Set(Object.values(N).flat());

async function genericFoods(zipPath, dataType, srcTag) {
  const zip = await openZip(zipPath);
  try {
    const foods = new Map(); // fdc_id -> {name, nut:{}, portions:[]}
    let h = null;
    await readDelimited(await zip.stream("food.csv"), (r, hd) => {
      h ||= columns(hd, ["fdc_id", "data_type", "description"], "food.csv");
      if (r[h.data_type] !== dataType) return;
      foods.set(r[h.fdc_id], { name: tidy(r[h.description]), nut: new Map(), portions: [] });
    });
    h = null;
    await readDelimited(await zip.stream("food_nutrient.csv"), (r, hd) => {
      h ||= columns(hd, ["fdc_id", "nutrient_id", "amount"], "food_nutrient.csv");
      const f = foods.get(r[h.fdc_id]);
      if (!f) return;
      const id = +r[h.nutrient_id];
      if (WANT.has(id)) f.nut.set(id, num(r[h.amount]));
    });
    const units = new Map();
    if (zip.has("measure_unit.csv")) {
      h = null;
      await readDelimited(await zip.stream("measure_unit.csv"), (r, hd) => {
        h ||= columns(hd, ["id", "name"], "measure_unit.csv");
        units.set(r[h.id], r[h.name]);
      });
    }
    if (zip.has("food_portion.csv")) {
      h = null;
      await readDelimited(await zip.stream("food_portion.csv"), (r, hd) => {
        h ||= columns(hd, ["fdc_id", "amount", "measure_unit_id", "portion_description?", "modifier?", "gram_weight"], "food_portion.csv");
        const f = foods.get(r[h.fdc_id]);
        if (!f) return;
        const g = num(r[h.gram_weight]);
        if (!(g > 0)) return;
        let label = h.portion_description >= 0 ? r[h.portion_description].trim() : "";
        if (!label || /quantity not specified/i.test(label)) {
          const unit = units.get(r[h.measure_unit_id]) || "";
          const mod = h.modifier >= 0 ? r[h.modifier].trim() : "";
          label = [fmtAmount(r[h.amount]), unit === "undetermined" ? "" : unit, /^\d+$/.test(mod) ? "" : mod].filter(Boolean).join(" ");
        }
        label = own(label.replace(/\s+/g, " ").slice(0, 40));
        if (label && f.portions.length < 6 && !f.portions.some((p) => p[0] === label)) f.portions.push([label, r1(g)]);
      });
    }
    const out = [];
    for (const f of foods.values()) {
      const pick = (ids) => { for (const id of ids) if (isFinite(f.nut.get(id))) return f.nut.get(id); return NaN; };
      let kcal = pick(N.kcal);
      if (!isFinite(kcal) && isFinite(f.nut.get(1062))) kcal = f.nut.get(1062) / 4.184;
      if (!isFinite(kcal) || !f.name) continue;
      const p = pick(N.p), c = pick(N.c), fat = pick(N.f);
      out.push([f.name, r1(kcal), r1(p || 0), r1(c || 0), r1(fat || 0), f.portions, srcTag]);
    }
    return out;
  } finally {
    zip.close();
  }
}

// ---------- USDA branded foods -> barcodes ----------
async function brandedBarcodes(zipPath, put) {
  const zip = await openZip(zipPath);
  try {
    const byKey = new Map(); // gtin key -> row info (latest fdc_id wins)
    let h = null;
    await readDelimited(await zip.stream("branded_food.csv"), (r, hd) => {
      h ||= columns(hd, ["fdc_id", "brand_owner?", "brand_name?", "gtin_upc", "serving_size?", "serving_size_unit?", "household_serving_fulltext?", "discontinued_date?"], "branded_food.csv");
      if (h.discontinued_date >= 0 && r[h.discontinued_date]) return;
      const key = canonCode(r[h.gtin_upc]);
      if (!key) return;
      const fdc = +r[h.fdc_id];
      const prev = byKey.get(key);
      if (prev && prev.fdc > fdc) return;
      byKey.set(key, {
        fdc,
        brand: tidy((h.brand_name >= 0 && r[h.brand_name]) || (h.brand_owner >= 0 ? r[h.brand_owner] : "")),
        ss: h.serving_size >= 0 ? num(r[h.serving_size]) : NaN,
        su: h.serving_size_unit >= 0 ? own(r[h.serving_size_unit].trim().toLowerCase()) : "",
        hh: h.household_serving_fulltext >= 0 ? own(r[h.household_serving_fulltext].trim().slice(0, 30)) : "",
      });
    });
    log(`branded: ${byKey.size} barcodes (${mem()})`);
    const wanted = new Map();
    for (const [key, v] of byKey) {
      v.key = key;
      wanted.set(String(v.fdc), v);
    }
    h = null;
    await readDelimited(await zip.stream("food.csv"), (r, hd) => {
      h ||= columns(hd, ["fdc_id", "description"], "food.csv");
      const v = wanted.get(r[h.fdc_id]);
      if (v) v.name = tidy(r[h.description]);
    });
    log(`branded: names read (${mem()})`);
    h = null;
    // Fixed slots, not an object keyed by nutrient id: V8 stores {1008: x} as a ~1,000-slot array.
    const SLOT = new Map([[1008, 0], [1003, 1], [1004, 2], [1005, 3], [1062, 4]]);
    await readDelimited(await zip.stream("food_nutrient.csv"), (r, hd) => {
      h ||= columns(hd, ["fdc_id", "nutrient_id", "amount"], "food_nutrient.csv");
      const v = wanted.get(r[h.fdc_id]);
      if (!v) return;
      const id = +r[h.nutrient_id];
      const slot = SLOT.get(id);
      if (slot !== undefined) (v.n ||= [NaN, NaN, NaN, NaN, NaN])[slot] = num(r[h.amount]);
    });
    log(`branded: nutrients read (${mem()})`);
    let n = 0;
    for (const v of wanted.values()) {
      if (!v.name || !v.n) continue;
      const [nk, np, nf, nc, nkj] = v.n;
      let kcal = nk;
      if (!isFinite(kcal) && isFinite(nkj)) kcal = nkj / 4.184;
      if (!isFinite(kcal)) continue;
      // USDA branded values are per 100 g / 100 ml; convert to the label serving when we can.
      const perUnit = ["g", "grm", "gm", "ml", "mlt"].includes(v.su) && v.ss > 0;
      const factor = perUnit ? v.ss / 100 : 1;
      const unitLabel = v.su === "grm" || v.su === "gm" ? "g" : v.su === "mlt" ? "ml" : v.su;
      const serving = perUnit ? (v.hh && !/^\s*$/.test(v.hh) ? `${v.hh} (${r1(v.ss)} ${unitLabel})` : `${r1(v.ss)} ${unitLabel}`) : "100 g";
      put(v.key, [v.name, v.brand, serving.slice(0, 40), r1(kcal * factor), r1((np || 0) * factor), r1((nc || 0) * factor), r1((nf || 0) * factor), "u"]);
      n++;
    }
    return n;
  } finally {
    zip.close();
  }
}

// ---------- Open Food Facts -> barcodes ----------
async function offBarcodes(src, put, has, countries, budgetMs) {
  const started = Date.now();
  const raw = await openStream(src);
  const stream = /\.gz($|\?)/.test(src) ? raw.pipe(createGunzip()) : raw;
  const want = countries === "all" ? null : countries.split(",").map((s) => s.trim()).filter(Boolean);
  let h = null, n = 0, seen = 0, partial = false;
  await readDelimited(
    stream,
    (r, hd) => {
      h ||= columns(hd, ["code", "product_name", "brands?", "countries_tags?", "serving_size?", "serving_quantity?", "energy-kcal_100g?", "energy_100g?", "proteins_100g", "carbohydrates_100g", "fat_100g"], "Open Food Facts CSV");
      if ((++seen & 0xffff) === 0 && Date.now() - started > budgetMs) { partial = true; return false; }
      if (want) {
        const ct = h.countries_tags >= 0 ? r[h.countries_tags] : "";
        if (!want.some((c) => ct.includes(c))) return;
      }
      const key = canonCode(r[h.code]);
      if (!key || has(key)) return;
      const name = tidy(r[h.product_name]);
      if (!name) return;
      let kcal = h["energy-kcal_100g"] >= 0 ? num(r[h["energy-kcal_100g"]]) : NaN;
      if (!isFinite(kcal) && h.energy_100g >= 0) kcal = num(r[h.energy_100g]) / 4.184;
      const p = num(r[h.proteins_100g]), c = num(r[h.carbohydrates_100g]), f = num(r[h.fat_100g]);
      if (![kcal, p, c, f].every(isFinite)) return;
      if (kcal < 0 || kcal > 950 || p < 0 || c < 0 || f < 0 || p > 100 || c > 100 || f > 100) return;
      const est = 4 * p + 4 * c + 9 * f;
      if (Math.abs(est - kcal) > Math.max(60, kcal * 0.5)) return; // label doesn't add up
      const sq = h.serving_quantity >= 0 ? num(r[h.serving_quantity]) : NaN;
      const ok = sq > 0 && sq < 2000;
      const factor = ok ? sq / 100 : 1;
      const sl = h.serving_size >= 0 ? r[h.serving_size].trim() : "";
      const brand = h.brands >= 0 ? tidy(r[h.brands].split(",")[0]) : "";
      put(key, [name, brand, ok ? (sl || `${r1(sq)} g`).slice(0, 40) : "100 g", r1(kcal * factor), r1(p * factor), r1(c * factor), r1(f * factor), "o"]);
      n++;
    },
    { delimiter: "\t", quoted: false }
  );
  log(`Open Food Facts: scanned ${seen} rows in ${Math.round((Date.now() - started) / 1000)}s, kept ${n}${partial ? " (stopped at time budget)" : ""}`);
  return { n, partial };
}

// ---------- main ----------
export function readMeta() {
  try { return JSON.parse(readFileSync(META, "utf8")); } catch { return null; }
}

export async function buildData() {
  const maxAgeDays = +env("DATA_MAX_AGE_DAYS", "25");
  const meta = readMeta();
  const fresh = meta && existsSync(join(OUT, "foods.json")) && Date.now() - Date.parse(meta.builtAt) < maxAgeDays * 864e5;
  if (fresh && !flag("FORCE_DATA_REBUILD")) {
    log(`reusing cached data ${meta.version} (built ${meta.builtAt}); set FORCE_DATA_REBUILD=1 to rebuild now`);
    return { dir: OUT, meta };
  }
  try {
    return { dir: OUT, meta: await rebuild() };
  } catch (e) {
    if (meta && existsSync(join(OUT, "foods.json"))) {
      log(`WARNING: data rebuild failed (${e.message}); keeping previous data ${meta.version}`);
      return { dir: OUT, meta };
    }
    throw e;
  }
}

async function rebuild() {
  const t0 = Date.now();
  mkdirSync(TMP, { recursive: true });
  const usda = await discoverUsda();
  const counts = { foods: 0, usdaBarcodes: 0, offBarcodes: 0 };
  const notes = [];

  // 1. Generic foods
  const fz = await downloadToFile(usda.foundation, join(TMP, "foundation.zip"));
  const foundation = await genericFoods(fz, "foundation_food", "f");
  const sz = await downloadToFile(usda.sr, join(TMP, "sr.zip"));
  const sr = await genericFoods(sz, "sr_legacy_food", "s");
  const seenNames = new Set(foundation.map((f) => f[0].toLowerCase()));
  const foods = [...foundation, ...sr.filter((f) => !seenNames.has(f[0].toLowerCase()))];
  counts.foods = foods.length;
  log(`generic foods: ${foundation.length} Foundation + ${sr.length} SR Legacy -> ${foods.length}`);
  // Real releases have ~9,000 foods; far fewer means the file format changed.
  if (foods.length < +env("MIN_FOODS", "1000")) throw new Error(`Only ${foods.length} generic foods parsed; the USDA file format may have changed.`);

  // 2. Barcodes
  const shards = new Map();
  const put = (key, val) => {
    key = own(key);
    val = val.map((x) => (typeof x === "string" ? own(x) : x));
    const s = shardOf(key);
    let m = shards.get(s);
    if (!m) shards.set(s, (m = new Map()));
    m.set(key, val);
  };
  const has = (key) => shards.get(shardOf(key))?.has(key) || false;

  if (!flag("SKIP_BRANDED")) {
    try {
      const bz = await downloadToFile(usda.branded, join(TMP, "branded.zip"));
      counts.usdaBarcodes = await brandedBarcodes(bz, put);
      if (bz.startsWith(TMP)) unlinkSync(bz);
    } catch (e) {
      notes.push(`USDA Branded skipped: ${e.message}`);
      log(`WARNING: USDA Branded step failed: ${e.message}`);
    }
  }
  const countries = env("OFF_COUNTRIES", "en:united-states,en:canada");
  if (countries !== "none") {
    try {
      const budget = +env("OFF_TIME_BUDGET_MIN", "8") * 60000;
      const r = await offBarcodes(env("OFF_CSV_URL", OFF_DEFAULT), put, has, countries, budget);
      counts.offBarcodes = r.n;
      if (r.partial) notes.push("Open Food Facts import stopped at its time budget; missing products are looked up live.");
    } catch (e) {
      notes.push(`Open Food Facts skipped: ${e.message}`);
      log(`WARNING: Open Food Facts step failed: ${e.message}`);
    }
  }

  // 3. Write output
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "bc"), { recursive: true });
  writeFileSync(join(OUT, "foods.json"), JSON.stringify(foods));
  for (let i = 0; i < 1000; i++) {
    const s = String(i).padStart(3, "0");
    const m = shards.get(s);
    writeFileSync(join(OUT, "bc", s + ".json"), m ? JSON.stringify(Object.fromEntries(m)) : "{}");
  }
  const now = new Date();
  const meta = {
    version: "d" + now.toISOString().replace(/[-:T]/g, "").slice(0, 12),
    builtAt: now.toISOString(),
    sources: { ...usda, off: countries === "none" ? null : env("OFF_CSV_URL", OFF_DEFAULT), offCountries: countries },
    counts,
    notes,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  writeFileSync(META, JSON.stringify(meta, null, 2));
  for (const f of readdirSync(TMP)) try { unlinkSync(join(TMP, f)); } catch {}
  log(`done in ${meta.seconds}s:`, JSON.stringify(counts));
  return meta;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildData().then(
    (r) => log("data ready:", r.meta.version),
    (e) => { console.error(e); process.exit(1); }
  );
}
