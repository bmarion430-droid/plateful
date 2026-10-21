// Monthly data refresh: triggers a new build through a Netlify build hook.
// The build rebuilds the nutrition data when the cached copy is older than DATA_MAX_AGE_DAYS (25).
// Set BUILD_HOOK_URL (Project configuration > Build & deploy > Build hooks). Without it, this does nothing.
// Schedule: 07:00 UTC on the 2nd of each month (3 AM Eastern in summer, 2 AM in winter).
import type { Config } from "@netlify/functions";

export default async () => {
  const hook = Netlify.env.get("BUILD_HOOK_URL");
  if (!hook) {
    console.log("refresh-data: BUILD_HOOK_URL not set; skipping");
    return;
  }
  const res = await fetch(hook + (hook.includes("?") ? "&" : "?") + "trigger_title=Monthly+food+data+refresh", { method: "POST" });
  console.log(`refresh-data: build hook responded ${res.status}`);
};

export const config: Config = { schedule: "0 7 2 * *" };
