# Plateful

A phone-first calorie, macro, water and weight tracker that you install on your iPhone home screen. It comes with a free food database that lives on the phone.

- **Nutrition Facts** home screen: calories left, fat, carbs, protein, water, today's weight, and everything you ate.
- **Enter Meal**: search about 9,000 USDA foods with real serving sizes, scan barcodes with the camera, or add custom foods.
- **Enter Weight**: log weigh-ins (or straight from the home screen). Plot weight with a smoothed trend line, or calories, over 7 days, 30 days, 60 days, 1 year or all time, with your goal line.

## Built for fast logging

- **Log food** button on the home screen, and **+ Add** next to each meal.
- Search opens on **Your meals**, **Often at this meal**, **Recent** and **Your foods & recipes**. A **+** on any of them logs it in one tap with the amount you used last time.
- **Repeat yesterday's breakfast** (or whichever meal) in one tap.
- **Save a meal** (2+ foods) and log it in one tap later.
- **Quick add**: just a calorie number (protein optional) for restaurant meals and guesses.
- **Recipes**: build from any foods, set the number of servings, and log a serving.
- **Edit** any entry (amount or meal) by tapping it. Every removal and one-tap add has **Undo**.
- Going over target is shown in a neutral colour, never red.

## Adaptive calorie target (the coach)

A one-minute setup (goal, pace, sex, age, height, weight, activity) gives a starting target from the Mifflin-St Jeor formula. After that, Plateful measures your real daily burn from your weigh-ins and food log (a small Kalman filter in `src/coach.js`) and offers a new target at a weekly check-in on the home screen.

- **Learning phase**: the first 3 weeks keep the starting target while it gathers data.
- **Under-logging cancels out**: burn is measured in the same units you log in.
- **Plateaus** (4 weeks of no change): offers a 150 kcal lower target or a 2-week maintenance break. If the measured burn dropped unusually fast, it suggests a "precision week" of careful logging first instead of cutting.
- **Habit checks**: losing faster than 1% of body weight a week raises the target; big swings between very low and very high days, or weeks that felt "Hard", suggest the Gentle pace; it flags weekend overshoot; patchy logs leave the target unchanged.
- **Guardrails**: never below 1,200 kcal (women) / 1,500 kcal (men); never faster than 1% of body weight a week; deficit at most 1,000 kcal or 25% of burn; the target moves at most 150 kcal a week; no goal weight below a BMI of 18.5. Weight-loss targets are switched off for anyone who says they are pregnant or breastfeeding, under 18, or have had an eating disorder.
- Turn it off any time under Goals ("Let my plan adjust this each week").

`npm test` runs simulated people through months of use and checks these decisions.

## Where the food data comes from (all free)

| Data | Source | License |
|---|---|---|
| Generic foods (search) | USDA FoodData Central: Foundation Foods and SR Legacy | Public domain |
| Barcodes (bundled) | USDA FoodData Central: Branded Foods (about 450,000 US products) | Public domain |
| Barcodes (bundled + live) | Open Food Facts (US and Canada by default) | Open Database License |
| Brand-name search (optional) | USDA FoodData Central API | Public domain; free API key |

## How it stays fast

The data isn't fetched from USDA or Open Food Facts while you use the app. Netlify downloads both databases **at build time** and turns them into small static files:

- `data/<version>/foods.json`: the search list, a few hundred KB compressed. It downloads once, in the background, and is then cached on the phone. Every search runs on the phone instantly, even offline.
- `data/<version>/bc/000.json` … `999.json`: barcodes split into 1,000 small files by barcode digits. A scan downloads only the one file holding that barcode, typically tens of KB. It's cached afterwards, so scanning the same product again is instant and works offline.
- If a barcode isn't bundled, the app asks Open Food Facts live through `/api/off/<code>`. Netlify's CDN caches the answer for a week.
- If nobody has the product, you photograph the label once (or type the numbers), and it's saved on your phone.

These data files are served with a one-year cache header. Each data rebuild uses a new version folder, so phones never get stale data.

## Deploy

1. Put this folder in a new GitHub repository.
2. In Netlify: **Add new project → Import an existing project →** pick the repository. The settings in `netlify.toml` are picked up automatically (build command `npm run build`, publish folder `dist`).
3. Deploy. **The first build downloads about 1.4 GB of source data and takes several minutes.** Later builds reuse the processed data (cached by `plugins/data-cache`) and take under a minute until the data is 25 days old.
4. On your iPhone, open the site in Safari, tap **Share → Add to Home Screen**.

### Optional settings (Netlify → Project configuration → Environment variables)

| Variable | What it turns on |
|---|---|
| `FDC_API_KEY` | Brand-name search while you type ("Cheerios", "Chobani"). Free key: https://fdc.nal.usda.gov/api-key-signup |
| `ANTHROPIC_API_KEY` | Reading a Nutrition Facts label from a photo when a barcode isn't found. Each read is one small Claude API call billed to your key. `ANTHROPIC_MODEL` overrides the model (default `claude-haiku-5-5`). |
| `BUILD_HOOK_URL` | Monthly automatic data refresh. Create a build hook under Project configuration → Build & deploy → Build hooks and paste its URL here. |

Give the variables the **Functions** scope. Without them the app still works; those two features are just hidden.

### Build settings (in `netlify.toml`)

| Setting | Default | Meaning |
|---|---|---|
| `DATA_MAX_AGE_DAYS` | 25 | Rebuild the food data when the cached copy is older than this. |
| `OFF_COUNTRIES` | `en:united-states,en:canada` | Which Open Food Facts products to bundle. `all` bundles every country; `none` skips the import (live lookups still work). |
| `OFF_TIME_BUDGET_MIN` | 8 | Stops the Open Food Facts import after this many minutes, so the build stays inside Netlify's build time limit. Products not imported are still found by live lookup. |
| `FORCE_DATA_REBUILD` | (unset) | Set to `1` for one deploy to rebuild the data immediately. |
| `SKIP_BRANDED` | (unset) | Set to `1` to skip the USDA Branded download. |

If the first build ever times out, set `OFF_COUNTRIES = "none"` and deploy again.

If a data download fails on a later build, the previous data is kept and the deploy still succeeds. The build log says what happened.

## Your data

Your log stays on your phone, in the browser storage of the installed app. Nothing is uploaded. Use **Goals → Export backup** before switching phones, and **Import backup** on the new one. Note that an app added to the Home Screen has its own storage, separate from Safari.

## Local development

```
npm install
npm run build:nodata     # quick build without the food database
npx netlify dev          # serves dist/ and the functions
```

`npm run build` runs the full data build. You can point it at local copies of the source files with `USDA_FOUNDATION_URL`, `USDA_SR_URL`, `USDA_BRANDED_URL` and `OFF_CSV_URL` (file paths work).

## Files

```
src/                 the app (index.html, app.js, service worker, manifest, icons)
scripts/build.mjs    assembles dist/
scripts/build-data.mjs  downloads, trims and shards the USDA and Open Food Facts data
netlify/functions/   off (live barcode lookup), search (brand search), label (photo reading),
                     features, refresh-data (monthly rebuild trigger)
plugins/data-cache/  keeps processed data between builds
```

Attribution: food data from USDA FoodData Central and Open Food Facts (openfoodfacts.org, Open Database License). The app shows this under Goals.
