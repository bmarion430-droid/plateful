// Plateful coach: estimates real daily calorie burn from logged food + weigh-ins,
// sets a calorie target with safety limits, and writes the weekly check-in.
// Pure functions over the app state, so it can be unit-tested in Node.
(function (root) {
"use strict";

const KCAL_PER_LB = 3500;
const KG = 0.45359237;
const PACES = { gentle: 0.0025, steady: 0.005, faster: 0.0075 };      // share of body weight per week
const MAX_RATE = 0.01;                  // never plan faster than 1% of body weight per week
const MAX_DEFICIT = 1000;               // kcal/day
const MAX_DEFICIT_SHARE = 0.25;         // of estimated burn
const MAX_STEP = 150;                   // max change to the target per weekly check-in
const FLOORS = { f: 1200, m: 1500 };    // bottom of the AHA/ACC/TOS guideline ranges
const LEARN_DAYS = 21;
const ACTIVITY = { 1.2: "Mostly sitting", 1.375: "Lightly active", 1.55: "Active", 1.725: "Very active" };

// ---------- dates ----------
const iso = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = fromIso(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((fromIso(b) - fromIso(a)) / 864e5);
const r0 = (n) => Math.round(n), r1 = (n) => Math.round(n * 10) / 10, r10 = (n) => Math.round(n / 10) * 10;

// ---------- units ----------
const toLb = (w, unit) => (unit === "kg" ? w / KG : w);
const fromLb = (lb, unit) => (unit === "kg" ? lb * KG : lb);

// ---------- starting estimate (Mifflin-St Jeor x activity) ----------
function bmr(p, weightLb) {
  const kg = weightLb * KG;
  const s = p.sex === "m" ? 5 : p.sex === "f" ? -161 : -78;
  return 10 * kg + 6.25 * p.heightCm - 5 * p.age + s;
}
function priorBurn(p, weightLb) { return bmr(p, weightLb) * (p.activity || 1.375); }
function floorFor(p) { return FLOORS[p && p.sex] || FLOORS.f; }
function eligibleForLoss(p) { return !(p && (p.pregnant || p.under18 || p.edHistory)); }
function bmiOf(weightLb, heightCm) { const m = heightCm / 100; return (weightLb * KG) / (m * m); }
function minHealthyWeightLb(heightCm) { const m = heightCm / 100; return (18.5 * m * m) / KG; }

// ---------- daily data ----------
function dayTotal(state, d) {
  const day = state.days[d];
  if (!day || !day.entries.length) return 0;
  return day.entries.reduce((a, e) => a + e.kcal * e.qty, 0);
}
// A day counts as "logged" when it holds at least 40% of the person's own typical day
// (median of their last 14 days with food), so a forgotten dinner doesn't read as a tiny-intake day,
// while someone who genuinely eats little is still measured correctly.
function typicalDay(state, d) {
  const t = [];
  for (let i = 1; i <= 14; i++) { const x = dayTotal(state, addDays(d, -i)); if (x > 0) t.push(x); }
  if (!t.length) return 0;
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
}
function loggedIntake(state, d) {
  const t = dayTotal(state, d);
  return t >= Math.max(500, 0.4 * typicalDay(state, d)) ? t : null;
}
function weightLb(state, d) {
  const w = state.weights[d];
  return w == null ? null : toLb(w, state.goals.unit);
}

// Smoothed "trend" weight: exponential moving average of weigh-ins (10% per day).
function trendSeries(state, start, end) {
  const out = [];
  let t = null;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const w = weightLb(state, d);
    if (w != null) t = t == null ? w : t + 0.1 * (w - t);
    out.push({ d, w, trend: t });
  }
  return out;
}

// ---------- expenditure estimate (Kalman filter on weight + burn) ----------
// State: true weight W (lb) and burn E (kcal/day, in the user's own logging units).
// Each day W moves by (intake - E)/3500; each weigh-in observes W plus water noise.
// Under-logging is absorbed because E is measured in the same units the user logs in.
function estimate(state, today) {
  const p = state.profile;
  const wkeys = Object.keys(state.weights).filter((k) => k <= today).sort();
  if (!p || !wkeys.length) return null;
  const start = p.start && p.start <= today ? p.start : today;
  // use up to 6 weeks of history from before the plan started
  const first = wkeys.find((k) => k >= addDays(start, -42)) || wkeys[wkeys.length - 1];
  const w0 = weightLb(state, first);
  const prior = priorBurn(p, w0);
  let x = [w0, prior];
  let P = [[4, 0], [0, 550 * 550]];
  const recent = [];
  const hist = [];
  let logged = 0, weighIns = 0, days = 0;
  for (let d = first; d <= today; d = addDays(d, 1)) {
    const w = weightLb(state, d);
    if (w != null) {
      weighIns++;
      const S = P[0][0] + 1.4 * 1.4;
      const K0 = P[0][0] / S, K1 = P[1][0] / S;
      const y = w - x[0];
      x = [x[0] + K0 * y, x[1] + K1 * y];
      P = [[P[0][0] - K0 * P[0][0], P[0][1] - K0 * P[0][1]], [P[1][0] - K1 * P[0][0], P[1][1] - K1 * P[0][1]]];
    }
    hist.push({ d, est: x[1], sd: Math.sqrt(P[1][1]), w: x[0] });
    if (d === today) break;                      // today's food isn't finished yet
    days++;
    const li = loggedIntake(state, d);
    if (li != null) { logged++; recent.push(li); if (recent.length > 14) recent.shift(); }
    const intake = li != null ? li : recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : x[1];
    // predict tomorrow
    const a = -1 / KCAL_PER_LB;
    x = [x[0] + (intake - x[1]) / KCAL_PER_LB, x[1]];
    let qw = 0.04 * 0.04;
    const sinceStart = diffDays(start, d);
    if (sinceStart >= 0 && sinceStart < 14) qw = 0.35 * 0.35;  // first days of a new plan: glycogen/water shifts
    if (li == null) qw += (300 / KCAL_PER_LB) ** 2;
    P = [
      [P[0][0] + 2 * a * P[0][1] + a * a * P[1][1] + qw, P[0][1] + a * P[1][1]],
      [P[1][0] + a * P[1][1], P[1][1] + 12 * 12],
    ];
  }
  return { est: x[1], sd: Math.sqrt(P[1][1]), prior, hist, logged, weighIns, days, start, first, weightNow: x[0] };
}

// ---------- target ----------
function goalDelta(p, weightLb, est) {
  if (!p || p.goal === "maintain" || !eligibleForLoss(p) && p.goal === "lose") return 0;
  if (p.goal === "gain") return Math.min(500, weightLb * 0.0025 * KCAL_PER_LB / 7);
  const rate = Math.min(PACES[p.pace] || PACES.steady, MAX_RATE) * weightLb;      // lb/week
  return -Math.min(rate * KCAL_PER_LB / 7, MAX_DEFICIT, MAX_DEFICIT_SHARE * est);
}
// Returns the target the plan calls for, after every safety limit. `current` limits the step size.
function planTarget(state, est, weightLb, today, current) {
  const p = state.profile, c = state.coach || {};
  const onBreak = c.breakUntil && today < c.breakUntil;
  const delta = onBreak ? 0 : goalDelta(p, weightLb, est);
  let t = est + delta;
  const notes = [];
  if (t < floorFor(p)) { t = floorFor(p); notes.push("floor"); }
  if (current != null && !onBreak) {
    if (t < current - MAX_STEP) { t = current - MAX_STEP; notes.push("step"); }
    if (t > current + MAX_STEP) { t = current + MAX_STEP; notes.push("step"); }
  }
  return { target: r10(Math.max(t, floorFor(p))), notes, onBreak };
}

// Starting target right after setup (no data yet).
function startingTarget(p, weightLb) {
  const est = priorBurn(p, weightLb);
  const s = { profile: p, coach: {} };
  return { est: r10(est), ...planTarget(s, est, weightLb, "0000-00-00", null) };
}

// ---------- weekly check-in ----------
function habitSignals(state, today, target) {
  let logged = 0, swings = 0, wkEnd = [], wkDay = [];
  let prev = null;
  for (let i = 14; i >= 1; i--) {
    const d = addDays(today, -i);
    const t = dayTotal(state, d);
    const isLogged = loggedIntake(state, d) != null;
    if (isLogged) {
      logged++;
      const dow = fromIso(d).getDay();
      (dow === 0 || dow === 5 || dow === 6 ? wkEnd : wkDay).push(t);
    }
    if (prev != null && prev > 0 && prev < 0.6 * target && t > 1.25 * target) swings++;
    prev = t;
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const weekendGap = wkEnd.length >= 2 && wkDay.length >= 4 ? avg(wkEnd) - avg(wkDay) : 0;
  return { loggedDays14: logged, swings, weekendGap };
}

function trendRate(series, weeks) {
  const n = series.length;
  const end = series[n - 1].trend, startIdx = n - 1 - weeks * 7;
  if (startIdx < 0 || end == null || series[startIdx].trend == null) return null;
  return (end - series[startIdx].trend) / weeks;     // lb per week (negative = losing)
}

// Least-squares slope of raw weigh-ins over the last `weeks` weeks (lb/week); steadier than trend endpoints.
function slopeRate(series, weeks) {
  const pts = series.slice(-weeks * 7).map((s, i) => [i, s.w]).filter((x) => x[1] != null);
  if (pts.length < weeks * 3) return null;
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? (num / den) * 7 : null;
}

// Plateau = the filtered weight (which uses food logs as well as the scale) and a 4-week fit of
// raw weigh-ins both show essentially no loss for 4 weeks.
function plateauSignal(e, r4s) {
  if (!e || r4s == null || e.hist.length < 29) return false;
  const k4 = (e.hist[e.hist.length - 1].w - e.hist[e.hist.length - 29].w) / 4;
  return k4 > -0.25 && r4s > -0.25;
}

function feelings(state) {
  const f = (state.coach && state.coach.feel) || {};
  return Object.keys(f).sort().slice(-3).map((k) => f[k]);
}

// Decide what the weekly check-in says. Returns null when no check-in is due.
function checkin(state, today, opts = {}) {
  const p = state.profile, c = state.coach || {};
  if (!p || !p.setupDone) return null;
  const e = estimate(state, today);
  const current = state.goals.kcal;
  const daysIn = diffDays(p.start, today);
  const due = opts.force || (daysIn >= 7 && (!c.lastCheckin || diffDays(c.lastCheckin, today) >= 7));
  if (!due) return null;
  const unit = state.goals.unit;
  const series = trendSeries(state, addDays(today, -35), today);
  const wNow = (e && e.weightNow) || series.filter((s) => s.trend != null).pop()?.trend;
  const week = Math.floor(daysIn / 7);
  const r1w = trendRate(series, 1), r3w = trendRate(series, 3), r4s = slopeRate(series, 4);
  const h = habitSignals(state, today, current);
  const out = { week, today, unit, current, est: e && e.est, newTarget: current, rate1w: r1w, rate3w: r3w, flags: [], tips: [], options: [] };
  const fmtW = (lb) => r1(Math.abs(fromLb(lb, unit))) + " " + unit;
  const change = r1w == null ? "" : (r1w < -0.05 ? "Down " + fmtW(r1w) : r1w > 0.05 ? "Up " + fmtW(r1w) : "Steady") + " this week (trend).";

  // Not enough data yet: keep the starting target.
  const learning = !e || daysIn < LEARN_DAYS || e.weighIns < 8 || e.logged < 10 || e.sd > 300;
  if (learning) {
    out.flags.push("learning");
    out.title = "Week " + week + ": still learning";
    out.body = (change ? change + " " : "") + "Your target updates once there's 2 to 3 weeks of weigh-ins and food logs. Keep weighing in most mornings.";
    out.options.push({ id: "ok", label: "Got it", primary: true });
    return out;
  }

  const plan = planTarget(state, e.est, wNow, today, current);
  out.newTarget = plan.target;
  const goingDown = p.goal === "lose" && eligibleForLoss(p);

  if (plan.onBreak) {
    out.flags.push("break");
    out.title = "Maintenance break";
    out.body = "Eating at maintenance (about " + r10(e.est).toLocaleString() + " kcal) until " + fromIso(c.breakUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ". Weight should hold steady; that's the point.";
    out.options.push({ id: "accept", label: "Keep going", primary: true });
    return out;
  }

  if (!eligibleForLoss(p) && p.goal === "lose") {
    out.flags.push("maintainOnly");
    out.title = "Week " + week + " check-in";
    out.body = "Plateful is set to maintenance for you, so your target follows your measured burn: about " + r10(e.est).toLocaleString() + " kcal.";
    out.options.push({ id: "accept", label: "Use " + out.newTarget.toLocaleString(), primary: true });
    return out;
  }

  // Goal reached
  if (goingDown && p.goalWeightLb && wNow <= p.goalWeightLb) {
    out.flags.push("goalReached");
    out.title = "You reached your goal weight";
    out.body = "Switch to maintenance? Your target would be about " + r10(e.est).toLocaleString() + " kcal, based on your measured burn.";
    out.options.push({ id: "maintain", label: "Switch to maintenance", primary: true }, { id: "keep", label: "Keep losing" });
    return out;
  }

  // Data quality first: don't move the target on patchy logs.
  if (h.loggedDays14 < 8) {
    out.flags.push("loggingDrop");
    out.newTarget = current;
    out.title = "Week " + week + ": logs were patchy";
    out.body = "Only " + h.loggedDays14 + " of the last 14 days have full logs, so your target stays at " + current.toLocaleString() + ". Rough logs beat no logs: a Quick add with your best guess counts.";
    out.options.push({ id: "ok", label: "OK", primary: true });
    return out;
  }

  // Losing too fast
  if (goingDown && r3w != null && r4s != null && -r3w > MAX_RATE * wNow && -r4s > MAX_RATE * wNow) {
    out.flags.push("tooFast");
    out.newTarget = r10(Math.min(e.est, current + MAX_STEP));
    out.title = "Week " + week + ": a bit too fast";
    out.body = "You've averaged " + fmtW(r3w) + " a week for 3 weeks, more than 1% of your weight. That's hard to keep up and costs muscle, so your target goes up to " + out.newTarget.toLocaleString() + ".";
    out.options.push({ id: "accept", label: "Use " + out.newTarget.toLocaleString(), primary: true }, { id: "keep", label: "Keep " + current.toLocaleString() });
  }

  // Plateau: 3 weeks with no real change while trying to lose
  // (both a 4-week fit of the raw weigh-ins and the 3-week trend must be flat, so one noisy week can't trigger it)
  else if (goingDown && plateauSignal(e, r4s) && daysIn >= 35) {
    const ago = e.hist[Math.max(0, e.hist.length - 22)];
    const estDropPerWeek = (e.est - ago.est) / 3;
    const shownAt = (c.flagsAt || {});
    const recently = (f, days) => shownAt[f] && diffDays(shownAt[f], today) < days;
    if (estDropPerWeek < -80 && ago.sd < 220 && daysIn >= 42 && !recently("checkLogging", 28)) {
      out.flags.push("checkLogging");
      out.newTarget = current;
      out.title = "Week " + week + ": progress has stalled";
      out.body = "Your weight has barely moved in 4 weeks and your measured burn dropped quickly. That can be your body adapting, but it's often food slipping past the log (cooking oil, drinks, bites, bigger portions). A precision week tells you which: weigh portions and log everything for 7 days. Your target stays at " + current.toLocaleString() + ".";
      out.options.push({ id: "precision", label: "Try a precision week", primary: true }, { id: "ok", label: "Not now" });
    } else if (recently("checkLogging", 14) || recently("plateau", 14)) {
      out.flags.push("plateauWait");
      out.newTarget = current;
      out.title = "Week " + week + " check-in";
      out.body = change + " Give the last change another week or two to show up on the scale. Your target stays at " + current.toLocaleString() + ".";
      out.options.push({ id: "ok", label: "OK", primary: true });
    } else if (current <= floorFor(p) + 10) {
      out.flags.push("atFloor");
      out.newTarget = current;
      out.title = "Week " + week + ": progress has stalled";
      out.body = "Your target is already at the lowest Plateful will set (" + floorFor(p).toLocaleString() + "). Going lower isn't a good idea without a professional. Options that help: a 2-week break at maintenance, or more daily walking.";
      out.options.push({ id: "break", label: "Take a 2-week break", primary: true }, { id: "ok", label: "Keep going" });
    } else {
      out.flags.push("plateau");
      const lower = r10(Math.max(floorFor(p), current - MAX_STEP));
      out.newTarget = lower;
      out.title = "Week " + week + ": progress has stalled";
      out.body = "Your weight has barely moved in 4 weeks. Bodies often adjust to eating less for a while; that's normal. Two good ways forward: lower your target to " + lower.toLocaleString() + ", or take a 2-week break at maintenance (about " + r10(e.est).toLocaleString() + ") and then pick back up.";
      out.options.push({ id: "accept", label: "Lower to " + lower.toLocaleString(), primary: true }, { id: "break", label: "2-week break" });
    }
  }

  // Normal week
  else {
    out.flags.push("onTrack");
    out.title = "Week " + week + " check-in";
    const diff = out.newTarget - current;
    out.body = change + " Your measured burn is about " + r10(e.est).toLocaleString() + " kcal a day" +
      (diff ? ", so your target " + (diff < 0 ? "moves down" : "moves up") + " to " + out.newTarget.toLocaleString() + "." : ", so your target stays at " + current.toLocaleString() + ".") +
      (plan.notes.includes("floor") ? " (That's the lowest target Plateful sets.)" : "");
    if (r1w != null && Math.abs(r1w) < 0.15 && goingDown) out.body += " One flat week is usually water weight, so no need to worry.";
    out.options.push({ id: "accept", label: diff ? "Use " + out.newTarget.toLocaleString() : "Sounds good", primary: true });
    if (diff) out.options.push({ id: "keep", label: "Keep " + current.toLocaleString() });
  }

  // Habit tips (added to any of the above)
  const f = feelings(state);
  if (goingDown && p.pace !== "gentle" && (h.swings >= 2 || f.filter((x) => x === "hard").length >= 2)) {
    out.flags.push("easeOff");
    out.tips.push(h.swings >= 2
      ? "There were big swings between very low and very high days. A smaller deficit is usually easier to keep steady."
      : "The last few weeks felt hard. A gentler pace loses a bit slower but is much easier to stick with.");
    out.options.push({ id: "gentle", label: "Switch to Gentle pace" });
  }
  if (h.weekendGap > 400) {
    out.flags.push("weekendGap");
    out.tips.push("Weekends average " + r10(h.weekendGap).toLocaleString() + " kcal more than weekdays. Planning one bigger weekend meal is easier than trying to be strict all weekend.");
  }
  return out;
}

const api = { KCAL_PER_LB, KG, PACES, ACTIVITY, FLOORS, LEARN_DAYS, iso, fromIso, addDays, diffDays, toLb, fromLb, bmr, priorBurn, floorFor,
  eligibleForLoss, bmiOf, minHealthyWeightLb, dayTotal, trendSeries, estimate, planTarget, startingTarget, checkin, habitSignals, goalDelta };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.PlatefulCoach = api;
})(typeof window !== "undefined" ? window : globalThis);
