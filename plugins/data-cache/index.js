// Keeps the built nutrition data (.data-cache) between Netlify builds, so ordinary
// deploys take seconds instead of re-downloading the USDA and Open Food Facts files.
module.exports = {
  async onPreBuild({ utils }) {
    const restored = await utils.cache.restore("./.data-cache");
    console.log(restored ? "data-cache: restored previous nutrition data" : "data-cache: no cached data yet (first build downloads it)");
  },
  async onPostBuild({ utils }) {
    const saved = await utils.cache.save("./.data-cache");
    console.log(saved ? "data-cache: saved nutrition data for next build" : "data-cache: nothing to save");
  },
};
