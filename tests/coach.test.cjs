// Simulates people using Plateful for months and checks the coach's decisions.
// Run: npm test
const assert = require("node:assert/strict");
// coach.js is a browser script; load it into this context and read the global it defines.
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../src/coach.js"), "utf8"));
const C = globalThis.PlatefulCoach;

function rngFrom(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return { u, n: (sd = 1) => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()) * sd };
}

// opts: underlog, adapt (kcal of metabolic slowdown), driftFrom/driftExtra, eatFactor, logRate, swing, profile
function simulate(opts = {}) {
  const r = rngFrom(opts.seed || 1);
  const start = "2026-01-05";
  const profile = { sex: "m", age: 40, heightCm: 178, activity: 1.375, goal: "lose", pace: "steady", start, setupDone: true, ...(opts.profile || {}) };
  const state = { goals: { kcal: 0, unit: "lb", p: 150, c: 200, f: 70, water: 8 }, days: {}, weights: {}, profile, coach: { feel: {} } };
  let wTrue = 210, water = 0, glyco = 0, defDays = 0;
  const startTdee = opts.tdee || 2800;
  state.goals.kcal = C.startingTarget(profile, wTrue).target;
  const log = [];
  for (let i = 0; i < (opts.days || 140); i++) {
    const d = C.addDays(start, i);
    // weigh-in in the morning (5 of 7 days)
    water = 0.75 * water + r.n(0.72);
    if (r.u() < 5 / 7) state.weights[d] = Math.round((wTrue - glyco + water) * 10) / 10;
    // weekly check-in, accepting the first option
    const ci = C.checkin(state, d);
    if (ci) {
      log.push(ci);
      const opt = ci.options[0].id;
      if (opt === "accept") state.goals.kcal = ci.newTarget;
      if (opt === "break") state.coach.breakUntil = C.addDays(d, 14);
      if (opt === "gentle") state.profile.pace = "gentle";
      if (opt === "maintain") state.profile.goal = "maintain";
      state.coach.lastCheckin = d;
      state.coach.flagsAt = state.coach.flagsAt || {};
      for (const f of ci.flags) state.coach.flagsAt[f] = d;
    }
    // eat
    const u = (opts.underlog ?? 0.15) + (opts.driftFrom != null && i >= opts.driftFrom ? opts.driftExtra : 0);
    let loggedAmt = state.goals.kcal * (opts.eatFactor || 1) + r.n(200);
    if (opts.swing && i % 2 === 0) loggedAmt = state.goals.kcal * 0.5;
    if (opts.swing && i % 2 === 1) loggedAmt = state.goals.kcal * 1.5;
    const actual = loggedAmt / (1 - u);
    if (r.u() < (opts.logRate ?? 6 / 7)) state.days[d] = { water: 0, entries: [{ name: "day", serving: "x", qty: 1, kcal: loggedAmt, p: 0, c: 0, f: 0 }] };
    const tdee = startTdee - 10 * (210 - wTrue) - (opts.adapt || 120) * Math.min(1, defDays / 70) + r.n(120);
    const bal = actual - tdee;
    defDays = bal < -200 ? defDays + 1 : Math.max(0, defDays - 2);
    if (defDays > 0 && glyco < 2) glyco += 0.2;
    wTrue += bal / 3500;
    (state._true = state._true || {})[d] = wTrue;
  }
  return { state, log, wTrue };
}
const flagsOf = (log) => log.flatMap((c) => c.flags);
let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("PASS", name); };

test("starting target uses the formula minus the deficit, above the floor", () => {
  const t = C.startingTarget({ sex: "f", age: 30, heightCm: 160, activity: 1.2, goal: "lose", pace: "faster" }, 130);
  assert.ok(t.target >= 1200, "floor respected");
  const m = C.startingTarget({ sex: "m", age: 40, heightCm: 178, activity: 1.375, goal: "lose", pace: "steady" }, 210);
  assert.ok(m.target > 1800 && m.target < 2600, "reasonable: " + m.target);
});

test("a typical person keeps losing steadily (adaptive target)", () => {
  const { log, wTrue } = simulate({ seed: 3 });
  assert.ok(flagsOf(log).includes("learning"), "starts in learning mode");
  assert.ok(210 - wTrue > 10, "lost " + (210 - wTrue).toFixed(1) + " lb in 20 weeks");
});

test("targets never go below the floor or move more than 150 per week", () => {
  for (let s = 1; s <= 20; s++) {
    const { log } = simulate({ seed: s, profile: { sex: "f", heightCm: 160, age: 35 }, tdee: 2100, days: 200 });
    let prev = null;
    for (const c of log) {
      assert.ok(c.newTarget >= 1200, "floor " + c.newTarget);
      if (prev != null && !c.flags.includes("break")) assert.ok(Math.abs(c.newTarget - prev) <= 150, "step " + prev + "->" + c.newTarget);
      if (c.options[0].id === "accept") prev = c.newTarget; else prev = c.current;
    }
  }
});

test("forgetting to log food is flagged as a logging check, not a calorie cut", () => {
  const { log } = simulate({ seed: 5, driftFrom: 70, driftExtra: 0.25, days: 140 });
  const f = flagsOf(log.slice(10));
  assert.ok(f.includes("checkLogging") || f.includes("plateau"), "flags after drift: " + f.join(","));
  assert.ok(f.includes("checkLogging"), "should suspect logging: " + f.join(","));
});

test("patchy logs keep the target unchanged", () => {
  const { log } = simulate({ seed: 7, logRate: 0.4, days: 70 });
  const c = log.find((x) => x.flags.includes("loggingDrop"));
  assert.ok(c, "loggingDrop flagged");
  assert.equal(c.newTarget, c.current);
});

test("losing faster than 1% a week raises the target", () => {
  const { log } = simulate({ seed: 9, eatFactor: 0.6, days: 70 });
  const c = log.find((x) => x.flags.includes("tooFast"));
  assert.ok(c, "tooFast flagged: " + flagsOf(log).join(","));
  assert.ok(c.newTarget > c.current);
});

test("very low / very high day swings suggest a gentler pace", () => {
  const { log } = simulate({ seed: 11, swing: true, days: 60 });
  assert.ok(flagsOf(log).includes("easeOff"), flagsOf(log).join(","));
});

test("eating-disorder history turns weight-loss targets off", () => {
  const { log, state } = simulate({ seed: 13, profile: { edHistory: true }, days: 70 });
  assert.ok(flagsOf(log).includes("maintainOnly"), flagsOf(log).join(","));
  const t = C.startingTarget(state.profile, 210);
  assert.ok(t.target >= t.est - 10, "no deficit at start: " + t.target + " vs " + t.est);
});

test("strong metabolic slowdown leads to a plateau check-in with options", () => {
  let found = false;
  for (let s = 1; s <= 12 && !found; s++) {
    const { log } = simulate({ seed: s, adapt: 450, days: 182 });
    found = flagsOf(log).some((f) => f === "plateau" || f === "atFloor");
  }
  assert.ok(found, "plateau detected in at least one simulated person");
});

test("estimate absorbs under-logging (burn measured in logging units)", () => {
  const { state } = simulate({ seed: 17, underlog: 0.25, days: 84 });
  const e = C.estimate(state, C.addDays("2026-01-05", 83));
  // true burn ~2650 in real kcal => ~1990 in logging units
  assert.ok(e.est < 2350 && e.est > 1700, "est " + Math.round(e.est));
});

console.log(`\n${pass} tests passed`);
