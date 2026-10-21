// Live Open Food Facts lookup for barcodes that aren't in the bundled data.
// GET /api/off/:code -> { name, brand, serving, kcal, p, c, f } or 404
// Responses are cached on Netlify's CDN so repeat scans of a product never hit OFF again.
import type { Config, Context } from "@netlify/functions";

const UA = "Plateful/1.0 (personal nutrition tracker)";
const r1 = (n: number) => Math.round(n * 10) / 10;

export default async (req: Request, context: Context) => {
  const code = String(context.params.code || "").replace(/\D/g, "");
  if (code.length < 6 || code.length > 14) return Response.json({ error: "Barcodes are 6 to 14 digits." }, { status: 400 });

  const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,serving_size,serving_quantity,nutriments`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  } catch {
    return Response.json({ error: "Open Food Facts didn't respond." }, { status: 504 });
  }
  if (res.status === 404) return notFound();
  if (!res.ok) return Response.json({ error: `Open Food Facts returned ${res.status}.` }, { status: 502 });

  const j: any = await res.json().catch(() => null);
  const p = j?.product;
  const n = p?.nutriments || {};
  if (!j || j.status !== 1 || !p?.product_name) return notFound();

  let kcal = num(n["energy-kcal_100g"]);
  if (!isFinite(kcal)) kcal = num(n["energy_100g"]) / 4.184;
  const per100 = [kcal, num(n.proteins_100g), num(n.carbohydrates_100g), num(n.fat_100g)];
  if (!per100.every(isFinite)) return notFound();

  const sq = num(p.serving_quantity);
  const hasServing = sq > 0 && sq < 2000;
  const k = hasServing ? sq / 100 : 1;
  const body = {
    name: String(p.product_name).trim().slice(0, 90),
    brand: String(p.brands || "").split(",")[0].trim().slice(0, 60),
    serving: hasServing ? String(p.serving_size || `${r1(sq)} g`).slice(0, 40) : "100 g",
    kcal: r1(per100[0] * k), p: r1(per100[1] * k), c: r1(per100[2] * k), f: r1(per100[3] * k),
    source: "Open Food Facts",
  };
  return Response.json(body, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=604800, stale-while-revalidate=86400",
    },
  });
};

function num(v: unknown) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : NaN;
}

function notFound() {
  return Response.json({ error: "Not found" }, {
    status: 404,
    headers: { "Netlify-CDN-Cache-Control": "public, durable, s-maxage=86400" },
  });
}

export const config: Config = {
  path: "/api/off/:code",
  method: "GET",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
