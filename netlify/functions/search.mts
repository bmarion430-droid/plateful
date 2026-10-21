// Brand-name product search (USDA FoodData Central, Branded Foods).
// GET /api/search?q=cheerios -> { foods: [{ name, brand, serving, kcal, p, c, f, gtin }] }
// Needs FDC_API_KEY (free from https://fdc.nal.usda.gov/api-key-signup). Results are cached on
// the CDN for a week, which keeps usage well under USDA's 1,000 requests/hour limit.
import type { Config } from "@netlify/functions";

const r1 = (n: number) => Math.round(n * 10) / 10;
const tidy = (s: string) => {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s)) s = s.toLowerCase().replace(/(^|[\s\-\/(&,])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  return s.slice(0, 90);
};

export default async (req: Request) => {
  const key = Netlify.env.get("FDC_API_KEY");
  if (!key) return Response.json({ error: "Brand search isn't set up (FDC_API_KEY missing)." }, { status: 501 });
  const q = (new URL(req.url).searchParams.get("q") || "").trim().slice(0, 80);
  if (q.length < 3) return Response.json({ foods: [] });

  const api = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  api.searchParams.set("api_key", key);
  api.searchParams.set("query", q);
  api.searchParams.set("dataType", "Branded");
  api.searchParams.set("pageSize", "25");
  let res: Response;
  try {
    res = await fetch(api, { signal: AbortSignal.timeout(9000) });
  } catch {
    return Response.json({ error: "USDA search didn't respond." }, { status: 504 });
  }
  if (res.status === 429) return Response.json({ error: "USDA hourly limit reached." }, { status: 429 });
  if (!res.ok) return Response.json({ error: `USDA search returned ${res.status}.` }, { status: 502 });
  const j: any = await res.json();

  const seen = new Set<string>();
  const foods = [];
  for (const f of j.foods || []) {
    const nut = (id: number) => {
      const x = (f.foodNutrients || []).find((n: any) => n.nutrientId === id);
      return x && Number.isFinite(+x.value) ? +x.value : NaN;
    };
    let kcal = nut(1008);
    if (!Number.isFinite(kcal)) kcal = nut(1062) / 4.184;
    if (!Number.isFinite(kcal)) continue;
    // Branded search values are per 100 g / 100 ml; scale to the label serving when possible.
    const unit = String(f.servingSizeUnit || "").toLowerCase();
    const ss = +f.servingSize;
    const perUnit = ["g", "grm", "gm", "ml", "mlt"].includes(unit) && ss > 0;
    const k = perUnit ? ss / 100 : 1;
    const u = unit === "grm" || unit === "gm" ? "g" : unit === "mlt" ? "ml" : unit;
    const hh = String(f.householdServingFullText || "").trim();
    const name = tidy(f.description);
    const brand = tidy(f.brandName || f.brandOwner || "");
    const dedupe = (name + "|" + brand).toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    foods.push({
      name,
      brand,
      serving: perUnit ? (hh ? `${hh} (${r1(ss)} ${u})` : `${r1(ss)} ${u}`) : "100 g",
      kcal: r1(kcal * k),
      p: r1((nut(1003) || 0) * k),
      c: r1((nut(1005) || 0) * k),
      f: r1((nut(1004) || 0) * k),
      gtin: f.gtinUpc || null,
    });
  }
  return Response.json({ foods }, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=604800, stale-while-revalidate=86400",
      "Netlify-Vary": "query=q",
    },
  });
};

export const config: Config = {
  path: "/api/search",
  method: "GET",
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
