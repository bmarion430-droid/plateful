// Assembles the deployable site in dist/:
//   1. builds (or reuses) the nutrition data  -> dist/data/<version>/
//   2. copies the app from src/               -> dist/
//   3. vendors the barcode decoder            -> dist/vendor/zxing.min.js
//   4. stamps version info into index.html and sw.js
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildData } from "./build-data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SRC = join(ROOT, "src");
const log = (...a) => console.log("[plateful-build]", ...a);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

let data = null;
if (/^(1|true)$/i.test(process.env.SKIP_DATA || "")) {
  log("SKIP_DATA is set: deploying without the offline food database");
} else {
  data = await buildData();
  cpSync(data.dir, join(DIST, "data", data.meta.version), { recursive: true });
  log(`data ${data.meta.version}: ${JSON.stringify(data.meta.counts)}`);
}

cpSync(SRC, DIST, { recursive: true });
const zx = join(ROOT, "node_modules", "@zxing", "library", "umd", "index.min.js");
if (!existsSync(zx)) throw new Error("Missing @zxing/library. Run npm install.");
mkdirSync(join(DIST, "vendor"), { recursive: true });
cpSync(zx, join(DIST, "vendor", "zxing.min.js"));

const build = (process.env.COMMIT_REF || "").slice(0, 7) || Date.now().toString(36);
const config = {
  build,
  dataVersion: data ? data.meta.version : null,
  dataBuiltAt: data ? data.meta.builtAt : null,
  counts: data ? data.meta.counts : null,
};
const stamp = (file, map) => {
  const p = join(DIST, file);
  let s = readFileSync(p, "utf8");
  for (const [k, v] of Object.entries(map)) {
    if (!s.includes(k)) throw new Error(`${file}: placeholder ${k} missing`);
    s = s.split(k).join(v);
  }
  writeFileSync(p, s);
};
stamp("index.html", { "/*PLATEFUL_CONFIG*/null": JSON.stringify(config), "__BUILD__": build });
stamp("sw.js", { "__BUILD__": build, "__DATA__": config.dataVersion || "none" });
log(`site ready in dist/ (build ${build})`);
