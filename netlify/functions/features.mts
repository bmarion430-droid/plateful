// Tells the app which optional server features are configured.
// GET /api/features -> { brandSearch: boolean, label: boolean }
import type { Config } from "@netlify/functions";

export default async () =>
  Response.json(
    {
      brandSearch: Boolean(Netlify.env.get("FDC_API_KEY")),
      label: Boolean(Netlify.env.get("ANTHROPIC_API_KEY")),
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );

export const config: Config = { path: "/api/features", method: "GET" };
