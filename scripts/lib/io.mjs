import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const UA = "Plateful/1.0 (personal nutrition tracker; build script)";

export const log = (...a) => console.log("[plateful-data]", ...a);
export const mb = (n) => (n / 1048576).toFixed(0) + " MB";

function localPath(src) {
  if (src.startsWith("file:")) return fileURLToPath(src);
  if (!/^https?:/i.test(src)) return src;
  return null;
}

async function fetchWithRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (e) {
      last = e;
      log(`download attempt ${i + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw last;
}

function progress(label, total) {
  let seen = 0, next = 100 * 1048576;
  return new Transform({
    transform(chunk, _e, cb) {
      seen += chunk.length;
      if (seen >= next) { log(`${label}: ${mb(seen)}${total ? " of " + mb(total) : ""}`); next += 100 * 1048576; }
      cb(null, chunk);
    },
  });
}

// Download a URL to a file (or return the local path unchanged).
export async function downloadToFile(src, dest) {
  const lp = localPath(src);
  if (lp) { if (!existsSync(lp)) throw new Error(`File not found: ${lp}`); return lp; }
  log(`downloading ${src}`);
  const res = await fetchWithRetry(src);
  const total = +res.headers.get("content-length") || 0;
  await pipeline(Readable.fromWeb(res.body), progress("downloaded", total), createWriteStream(dest));
  log(`saved ${mb(statSync(dest).size)} to ${dest}`);
  return dest;
}

// Open a URL or local file as a byte stream (no temp file).
export async function openStream(src) {
  const lp = localPath(src);
  if (lp) return createReadStream(lp);
  log(`streaming ${src}`);
  const res = await fetchWithRetry(src);
  return Readable.fromWeb(res.body).pipe(progress("streamed", +res.headers.get("content-length") || 0));
}

// Read entries of a zip by base filename (USDA zips put CSVs inside a dated folder).
export function openZip(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      zip.on("entry", (e) => {
        const base = e.fileName.split("/").pop();
        if (base && !e.fileName.endsWith("/")) entries.set(base, e);
        zip.readEntry();
      });
      zip.on("end", () =>
        resolve({
          has: (name) => entries.has(name),
          names: () => [...entries.keys()],
          stream: (name) =>
            new Promise((res, rej) => {
              const e = entries.get(name);
              if (!e) return rej(new Error(`${name} not found in ${path}. Found: ${[...entries.keys()].join(", ")}`));
              zip.openReadStream(e, (er, s) => (er ? rej(er) : res(s)));
            }),
          close: () => zip.close(),
        })
      );
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}
