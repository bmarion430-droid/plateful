// Reads a Nutrition Facts label photo with Claude.
// POST /api/label { image: <base64 JPEG>, mediaType: "image/jpeg" }
//   -> { name, serving, kcal, p, c, f }
// Optional: needs ANTHROPIC_API_KEY. Each read is one small API call billed to that key.
// ANTHROPIC_MODEL overrides the model (default claude-haiku-5-5).
import type { Config } from "@netlify/functions";

const PROMPT = `This photo shows a packaged food's Nutrition Facts label (it may be another country's nutrition panel).
Reply with only JSON in this exact shape, no other text:
{"name": string, "serving": string, "kcal": number, "protein_g": number, "carbs_g": number, "fat_g": number, "readable": boolean}
Use the values PER SERVING as printed. If only per-100 g values exist, use those and set serving to "100 g".
"name" is the product name if visible, otherwise "". Use 0 for a nutrient that is absent.
Set "readable" to false if this is not a legible nutrition label.`;

const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export default async (req: Request) => {
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!key) return Response.json({ error: "Label reading isn't set up on this site." }, { status: 501 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "Send the photo as JSON." }, { status: 400 }); }
  const image = String(body?.image || "");
  const mediaType = TYPES.has(body?.mediaType) ? body.mediaType : "image/jpeg";
  if (image.length < 1000) return Response.json({ error: "The photo didn't come through. Try again." }, { status: 400 });
  if (image.length > 4_000_000) return Response.json({ error: "That photo is too large." }, { status: 413 });

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Netlify.env.get("ANTHROPIC_MODEL") || "claude-haiku-5-5",
        max_tokens: 400,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    return Response.json({ error: "Label reading timed out." }, { status: 504 });
  }
  if (!res.ok) {
    console.error("Anthropic API error", res.status, await res.text().catch(() => ""));
    return Response.json({ error: res.status === 429 ? "Too many label reads right now. Wait a minute." : "Label reading failed." }, { status: 502 });
  }
  const j: any = await res.json();
  const text = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  let out: any;
  try { out = JSON.parse(m ? m[0] : text); } catch { return Response.json({ error: "Couldn't read that label." }, { status: 422 }); }
  if (out.readable === false) return Response.json({ error: "That doesn't look like a readable Nutrition Facts label. Retake it straight-on." }, { status: 422 });

  const n = (v: unknown) => { const x = parseFloat(String(v)); return Number.isFinite(x) && x >= 0 ? Math.round(x * 10) / 10 : 0; };
  return Response.json({
    name: String(out.name || "").slice(0, 90),
    serving: String(out.serving || "1 serving").slice(0, 40),
    kcal: n(out.kcal), p: n(out.protein_g), c: n(out.carbs_g), f: n(out.fat_g),
  });
};

export const config: Config = {
  path: "/api/label",
  method: "POST",
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
