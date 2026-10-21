(() => {
"use strict";
const CFG = window.PLATEFUL || { dataVersion: null };
const C = window.PlatefulCoach;
const MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks"];

// Small built-in list, used only if the offline database was not built.
const FALLBACK_FOODS = [
  ["Rolled oats, cooked","1 cup",166,5.9,28,3.6],["Banana","1 medium",105,1.3,27,0.4],["Apple","1 medium",95,0.5,25,0.3],
  ["Egg, large","1 egg",72,6.3,0.4,4.8],["Greek yogurt, plain nonfat","170 g",100,17,6,0.7],["Milk, 2%","1 cup",122,8.1,12,4.8],
  ["Whole wheat bread","1 slice",81,4,14,1.1],["Peanut butter","2 tbsp",190,7,8,16],["Chicken breast, grilled","4 oz",187,35,0,4],
  ["Salmon, baked","4 oz",233,25,0,14],["White rice, cooked","1 cup",205,4.3,45,0.4],["Broccoli, steamed","1 cup",55,3.7,11,0.6],
  ["Olive oil","1 tbsp",119,0,0,13.5],["Almonds","1 oz",164,6,6,14],["Avocado","1/2 fruit",120,1.5,6,11]
].map(r => ({ kind: "s", name: r[0], serving: r[1], kcal: r[2], p: r[3], c: r[4], f: r[5], src: "builtin" }));

// ---------- utilities ----------
const $ = id => document.getElementById(id);
const { iso, fromIso, addDays, diffDays } = C;
let TODAY = iso(new Date());
const uid = () => Math.random().toString(36).slice(2, 9);
const r0 = n => Math.round(n), r1 = n => Math.round(n * 10) / 10, r10 = n => Math.round(n / 10) * 10;
const fmt = n => r0(n).toLocaleString();
const r2q = n => Math.round(n * 100) / 100;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const canon = code => { const d = String(code || "").replace(/\D/g, "").replace(/^0+/, ""); return d.length >= 6 && d.length <= 14 ? d : null; };
const shardOf = key => key.padStart(4, "0").slice(-4, -1);
function upcEtoA(e) {
  const ns = e[0], d = e.slice(1, 7), chk = e[7], last = d[5]; let m;
  if ("012".includes(last)) m = d[0] + d[1] + last + "0000" + d[2] + d[3] + d[4];
  else if (last === "3") m = d[0] + d[1] + d[2] + "00000" + d[3] + d[4];
  else if (last === "4") m = d[0] + d[1] + d[2] + d[3] + "00000" + d[4];
  else m = d[0] + d[1] + d[2] + d[3] + d[4] + "0000" + last;
  return ns + m + chk;
}
let toastT;
function toast(m, undo) {
  const t = $("toast");
  t.innerHTML = esc(m) + (undo ? '<button type="button">Undo</button>' : "");
  t.classList.toggle("act", !!undo);
  if (undo) t.querySelector("button").onclick = () => { undo(); t.classList.remove("show", "act"); };
  t.classList.add("show"); clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show", "act"), undo ? 4500 : 1900);
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

// ---------- state ----------
const KEY = "plateful.v2";
const DEFAULT_GOALS = { kcal: 2000, p: 120, c: 220, f: 65, water: 8, unit: "lb", weight: null, auto: false };
function blank() { return { goals: { ...DEFAULT_GOALS }, days: {}, weights: {}, custom: [], barcodes: {}, meals: [], profile: null, coach: {} }; }
function normalize(s) {
  s = s && typeof s === "object" ? s : blank();
  s.goals = { ...DEFAULT_GOALS, ...(s.goals || {}) };
  s.days = s.days || {}; s.weights = s.weights || {}; s.custom = s.custom || []; s.barcodes = s.barcodes || {};
  s.meals = s.meals || []; s.profile = s.profile || null;
  s.coach = { feel: {}, flagsAt: {}, ...(s.coach || {}) };
  return s;
}
let state = normalize((() => { try { return JSON.parse(store.get(KEY) || "null"); } catch { return null; } })());
function save() { if (!store.set(KEY, JSON.stringify(state))) toast("Couldn't save. Storage may be full."); }
const unit = () => state.goals.unit;

let cur = TODAY, tab = "today", meal = defaultMeal(), mode = "search", draft = null;
function defaultMeal() { const h = new Date().getHours(); return h < 11 ? "Breakfast" : h < 16 ? "Lunch" : h < 21 ? "Dinner" : "Snacks"; }
const day = s => state.days[s] || (state.days[s] = { water: 0, entries: [] });
function totals(s) {
  const d = state.days[s], t = { kcal: 0, p: 0, c: 0, f: 0, n: 0 };
  if (!d) return t;
  d.entries.forEach(e => { t.kcal += e.kcal * e.qty; t.p += e.p * e.qty; t.c += e.c * e.qty; t.f += e.f * e.qty; t.n++; });
  return t;
}
function dateText(s) {
  const d = fromIso(s);
  const rel = s === TODAY ? "Today" : s === addDays(TODAY, -1) ? "Yesterday" : s === addDays(TODAY, 1) ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "long" });
  return { rel, full: d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }), short: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), wd: d.toLocaleDateString(undefined, { weekday: "short" }) };
}
const latestWeightLb = () => { const ks = Object.keys(state.weights).filter(k => k <= TODAY).sort(); return ks.length ? C.toLb(state.weights[ks[ks.length - 1]], unit()) : null; };

// ---------- server features (brand search, label reading) ----------
let FEATURES = (() => { try { return JSON.parse(store.get("plateful.features") || "{}"); } catch { return {}; } })();
fetch("/api/features").then(r => r.ok ? r.json() : null).then(f => {
  if (f) { FEATURES = f; store.set("plateful.features", JSON.stringify(f)); updateLabelUI(); }
}).catch(() => {});

// ---------- tabs ----------
function showTab(t) {
  tab = t;
  ["today", "meal", "weight"].forEach(x => { $("scr-" + x).hidden = x !== t; });
  document.querySelectorAll(".tabbar button").forEach(b => { if (b.dataset.tab === t) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  try { sessionStorage.setItem("plateful.tab", t); } catch {}
  window.scrollTo(0, 0);
  render();
}
document.querySelectorAll(".tabbar button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function goLog(m) {
  if (m) meal = m; else if (cur === TODAY) meal = defaultMeal();
  mode = "search"; $("q").value = ""; showTab("meal");
  setTimeout(() => $("q").focus(), 50);
}

// ---------- Nutrition Facts (home) ----------
function renderToday() {
  const g = state.goals, t = totals(cur), d = day(cur), dt = dateText(cur);
  $("todayTitle").textContent = dt.rel;
  $("dateLabel").innerHTML = esc(dt.rel) + "<small>" + esc(dt.full) + "</small>";
  $("factsDate").textContent = dt.full;
  $("entryCount").textContent = t.n + (t.n === 1 ? " item" : " items");
  const left = g.kcal - t.kcal;
  $("calLeft").textContent = fmt(Math.abs(left));
  $("calLeft").style.color = left < 0 ? "var(--over)" : "";
  $("leftLbl").textContent = left < 0 ? "over target" : "remaining";
  $("calGoal").textContent = fmt(g.kcal);
  $("calEaten").textContent = fmt(t.kcal);
  $("calLeft2").textContent = (left < 0 ? "+" : "") + fmt(Math.abs(left));
  $("leftBox").className = left < 0 ? "over" : "left";
  $("leftBox").firstChild.textContent = left < 0 ? "Over" : "Left";
  $("calMeter").className = "meter" + (left < 0 ? " over" : "");
  $("calMeter").firstElementChild.style.width = Math.min(100, t.kcal / g.kcal * 100) + "%";
  ["p", "c", "f"].forEach(k => {
    const v = t[k], gv = g[k] || 1;
    $(k + "Txt").textContent = r0(v) + "g"; $(k + "Pct").textContent = r0(v / gv * 100) + "%";
    $(k + "Bar").style.width = Math.min(100, v / gv * 100) + "%";
  });
  const cups = $("cups"); cups.innerHTML = "";
  const n = Math.max(g.water, d.water);
  for (let i = 0; i < n; i++) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "cup" + (i < d.water ? " full" : "");
    b.setAttribute("aria-label", (i + 1) + " of " + g.water + " cups");
    b.onclick = () => { d.water = d.water === i + 1 ? i : i + 1; save(); renderToday(); };
    cups.appendChild(b);
  }
  $("waterTxt").textContent = d.water + " / " + g.water + " cups";
  const w = state.weights[cur];
  $("wtToday").textContent = w != null ? w + " " + unit() : "Not logged";
  const es = d.entries;
  $("ingSummary").textContent = es.length ? es.map(e => e.name).join(", ") + "." : "nothing logged yet. Tap Enter Meal, or + Add next to a meal.";
  $("ingList").innerHTML = MEALS.map(m => {
    const xs = es.filter(e => e.meal === m);
    const head = '<li class="mealhdr">' + m + (xs.length ? " · " + fmt(xs.reduce((a, e) => a + e.kcal * e.qty, 0)) + " kcal" : "") + '<button type="button" class="mealadd" data-addmeal="' + m + '">+ Add</button></li>';
    return head + xs.map(entryRow).join("");
  }).join("");
  renderCoach();
}
function entryRow(e) {
  return '<li><button type="button" class="nm" data-edit="' + e.id + '" style="border:0;background:none;padding:0;text-align:left;font:inherit;color:inherit">' + esc(e.name) + "<small>" + esc((e.qty !== 1 ? r2q(e.qty) + " × " : "") + e.serving) +
    " · P " + r0(e.p * e.qty) + " · C " + r0(e.c * e.qty) + " · F " + r0(e.f * e.qty) + '</small></button><span class="kc">' + fmt(e.kcal * e.qty) +
    '</span><button class="del" data-del="' + e.id + '" aria-label="Remove ' + esc(e.name) + '">&times;</button></li>';
}
$("prevDay").onclick = () => { cur = addDays(cur, -1); render(); };
$("nextDay").onclick = () => { cur = addDays(cur, 1); render(); };
function removeEntry(id) {
  const d = day(cur), i = d.entries.findIndex(x => x.id === id);
  if (i < 0) return;
  const [e] = d.entries.splice(i, 1); const on = cur;
  save(); render();
  toast("Removed " + e.name, () => { day(on).entries.splice(i, 0, e); save(); render(); });
}
$("ingList").addEventListener("click", e => {
  const del = e.target.closest("[data-del]"); if (del) return removeEntry(del.dataset.del);
  const ed = e.target.closest("[data-edit]"); if (ed) return openEdit(ed.dataset.edit);
  const add = e.target.closest("[data-addmeal]"); if (add) return goLog(add.dataset.addmeal);
});

// ---------- coach card (home) ----------
function renderCoach() {
  const area = $("coachArea");
  if (cur !== TODAY) { area.innerHTML = ""; return; }
  const p = state.profile, c = state.coach, parts = [];
  if (!p || !p.setupDone) {
    if (!(c.setupSnooze && c.setupSnooze > TODAY)) parts.push('<div class="coach"><span class="eyebrow">Your plan</span><h3>Get a calorie target that adjusts to you</h3><p>Answer a few questions. Plateful then learns your real calorie burn from your weigh-ins and fine-tunes your target every week.</p><div class="btns"><button type="button" class="primary" data-coach="setup">Set up in a minute</button><button type="button" class="ghost" data-coach="snooze">Not now</button></div></div>');
  } else if (state.goals.auto) {
    const ci = C.checkin(state, TODAY);
    if (ci) {
      window.__lastCheckin = ci;
      const feel = c.feel[TODAY];
      parts.push('<div class="coach" id="checkin"><span class="eyebrow">Weekly check-in</span><h3>' + esc(ci.title) + "</h3><p>" + esc(ci.body) + "</p>" +
        ci.tips.map(t => '<p class="tip">' + esc(t) + "</p>").join("") +
        '<div class="feel"><span>How did this week feel?</span>' + ["easy", "ok", "hard"].map(v => '<button type="button" class="chip" data-feel="' + v + '" aria-pressed="' + (feel === v) + '">' + (v === "ok" ? "OK" : v[0].toUpperCase() + v.slice(1)) + "</button>").join("") + "</div>" +
        '<div class="btns">' + ci.options.map(o => '<button type="button" class="' + (o.primary ? "primary" : "ghost") + '" data-ci="' + o.id + '">' + esc(o.label) + "</button>").join("") + "</div></div>");
    } else {
      parts.push(statusCard());
    }
  }
  if (state.weights[TODAY] == null && (p || Object.keys(state.weights).length)) {
    const last = latestWeightLb();
    parts.push('<form class="coach" id="weighForm"><span class="eyebrow">Morning weigh-in</span><div class="weighin"><input type="number" id="weighVal" step="0.1" inputmode="decimal" placeholder="' + (last ? r1(C.fromLb(last, unit())) : "Your weight") + '" aria-label="Today\'s weight"><span class="u">' + unit() + '</span><button type="submit" class="primary" style="width:auto;padding:11px 16px">Save</button></div></form>');
  }
  area.innerHTML = parts.join("");
  const wf = $("weighForm");
  if (wf) wf.addEventListener("submit", e => {
    e.preventDefault();
    const v = parseFloat($("weighVal").value);
    if (!(v > 20 && v < 1000)) { $("weighVal").focus(); return; }
    state.weights[TODAY] = r1(v); save(); render(); toast("Saved " + r1(v) + " " + unit());
  });
}
function statusCard() {
  const p = state.profile, c = state.coach, days = diffDays(p.start, TODAY);
  const e = C.estimate(state, TODAY);
  if (c.breakUntil && TODAY < c.breakUntil) {
    const left = diffDays(TODAY, c.breakUntil);
    return '<div class="coach"><span class="eyebrow">Maintenance break</span><h3>' + left + " day" + (left === 1 ? "" : "s") + " left</h3><p>You're eating at maintenance (" + fmt(state.goals.kcal) + " kcal) so your body and routine get a rest. Weight should hold steady.</p></div>";
  }
  if (c.precisionUntil && TODAY < c.precisionUntil) {
    const left = diffDays(TODAY, c.precisionUntil);
    return '<div class="coach"><span class="eyebrow">Precision week</span><h3>' + left + " day" + (left === 1 ? "" : "s") + ' left</h3><p>Weigh portions and log everything, including cooking oil, drinks and bites. It shows whether the log or your body changed.</p></div>';
  }
  if (days < C.LEARN_DAYS) {
    const pct = Math.max(4, Math.round(days / C.LEARN_DAYS * 100));
    return '<div class="coach"><span class="eyebrow">Learning your burn · day ' + (days + 1) + " of " + C.LEARN_DAYS + '</span><div class="progress"><i style="width:' + pct + '%"></i></div><p>Weigh in most mornings and log what you eat, even roughly. After 3 weeks your target (now ' + fmt(state.goals.kcal) + ") adjusts to how your body actually responds.</p></div>";
  }
  const next = addDays(c.lastCheckin || p.start, 7);
  return '<div class="coach"><span class="eyebrow">Your plan</span><p>Measured burn about <b>' + fmt(r10(e ? e.est : state.goals.kcal)) + " kcal</b> a day. Next check-in " + esc(dateText(next).wd) + ".</p></div>";
}
$("coachArea").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.coach === "setup") return openSetup();
  if (b.dataset.coach === "snooze") { state.coach.setupSnooze = addDays(TODAY, 7); save(); return renderCoach(); }
  if (b.dataset.feel) { state.coach.feel[TODAY] = b.dataset.feel; save(); return renderCoach(); }
  if (b.dataset.ci) resolveCheckin(b.dataset.ci);
});
function resolveCheckin(act) {
  const ci = C.checkin(state, TODAY); if (!ci) return;
  const c = state.coach, est = ci.est ? r10(ci.est) : state.goals.kcal;
  let msg = "Check-in done";
  if (act === "accept") { setTarget(ci.newTarget); msg = "Target set to " + fmt(ci.newTarget); }
  if (act === "break") { c.breakUntil = addDays(TODAY, 14); setTarget(Math.max(est, C.floorFor(state.profile))); msg = "2-week maintenance break started"; }
  if (act === "precision") { c.precisionUntil = addDays(TODAY, 7); msg = "Precision week started"; }
  if (act === "gentle") {
    state.profile.pace = "gentle";
    const t = C.planTarget(state, ci.est, latestWeightLb(), TODAY, state.goals.kcal).target;
    setTarget(t); msg = "Switched to Gentle pace · target " + fmt(t);
  }
  if (act === "maintain") { state.profile.goal = "maintain"; setTarget(est); msg = "Switched to maintenance · target " + fmt(est); }
  c.lastCheckin = TODAY;
  for (const f of ci.flags) c.flagsAt[f] = TODAY;
  (c.history = c.history || []).push({ d: TODAY, est: ci.est ? r0(ci.est) : null, target: state.goals.kcal, flags: ci.flags, act });
  save(); render(); toast(msg);
}
function setTarget(kcal) {
  const g = state.goals;
  g.kcal = r10(kcal);
  // macros: protein ~0.7 g per lb of (goal-adjusted) body weight, fat 30% of calories, carbs the rest
  const p = state.profile, w = latestWeightLb();
  if (p && w) {
    const ref = p.goal === "lose" && p.goalWeightLb ? Math.max(p.goalWeightLb, w * 0.85) : w;
    g.p = Math.min(200, r0(0.7 * ref));
    g.f = r0(g.kcal * 0.3 / 9);
    g.c = Math.max(50, r0((g.kcal - g.p * 4 - g.f * 9) / 4));
  }
}

// ---------- plan setup ----------
const setupDlg = $("setupDlg");
const su = { goal: "lose", pace: "steady", sex: null };
function segSet(id, v) { $(id).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === v)); }
["suGoal", "suPace", "suSex"].forEach(id => $(id).addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  su[{ suGoal: "goal", suPace: "pace", suSex: "sex" }[id]] = b.dataset.v; setupPreview();
}));
function openSetup() {
  const p = state.profile || {}, imp = unit() === "lb";
  su.goal = p.goal || "lose"; su.pace = p.pace || "steady"; su.sex = p.sex || null;
  $("suAge").value = p.age || "";
  const w = latestWeightLb();
  $("suWt").value = w ? r1(C.fromLb(w, unit())) : "";
  $("suHtImp").hidden = !imp; $("suHtMet").hidden = imp;
  if (p.heightCm) { const inch = p.heightCm / 2.54; $("suFt").value = Math.floor(inch / 12); $("suIn").value = r0(inch % 12); $("suCm").value = r0(p.heightCm); }
  $("suAct").value = String(p.activity || 1.375);
  $("suGoalWt").value = p.goalWeightLb ? r1(C.fromLb(p.goalWeightLb, unit())) : "";
  $("suPreg").checked = !!p.pregnant; $("suU18").checked = !!p.under18; $("suEd").checked = !!p.edHistory;
  document.querySelectorAll(".suUnit").forEach(x => x.textContent = unit());
  $("suSave").textContent = state.profile ? "Save plan" : "Start my plan";
  setupPreview();
  if ($("goalDlg").open) $("goalDlg").close();
  setupDlg.showModal();
}
function readSetup() {
  const imp = unit() === "lb";
  const heightCm = imp ? ((+$("suFt").value || 0) * 12 + (+$("suIn").value || 0)) * 2.54 : +$("suCm").value;
  const wLb = C.toLb(parseFloat($("suWt").value), unit());
  const gw = parseFloat($("suGoalWt").value);
  return {
    goal: su.goal, pace: su.pace, sex: su.sex, age: +$("suAge").value, heightCm, activity: +$("suAct").value,
    goalWeightLb: gw > 0 ? C.toLb(gw, unit()) : null, wLb,
    pregnant: $("suPreg").checked, under18: $("suU18").checked || (+$("suAge").value > 0 && +$("suAge").value < 18), edHistory: $("suEd").checked,
  };
}
function setupPreview() {
  segSet("suGoal", su.goal); segSet("suPace", su.pace); segSet("suSex", su.sex);
  const p = readSetup();
  const lose = p.goal === "lose";
  $("suPaceField").hidden = !lose; $("suGoalWtField").hidden = !lose;
  if (lose && p.wLb > 0) {
    const lb = C.PACES[p.pace] * p.wLb;
    $("suPaceHint").textContent = "About " + r1(C.fromLb(lb, unit())) + " " + unit() + " per week at your weight. Gentle is the easiest to keep up.";
  } else $("suPaceHint").textContent = "";
  const missing = [];
  if (!p.sex) missing.push("sex");
  if (!(p.age >= 10 && p.age <= 100)) missing.push("age");
  if (!(p.heightCm >= 120 && p.heightCm <= 230)) missing.push("height");
  if (!(p.wLb > 60 && p.wLb < 900)) missing.push("weight");
  const out = $("suPreview");
  $("suSave").disabled = missing.length > 0;
  if (missing.length) { out.textContent = "Add your " + missing.join(", ") + " to see your starting target."; return; }
  let note = "";
  if (lose && !C.eligibleForLoss(p)) note = " Weight-loss targets are off for you, so this is a maintenance target. Plateful will still track and learn your burn.";
  if (lose && p.goalWeightLb && p.goalWeightLb < C.minHealthyWeightLb(p.heightCm)) note += " That goal weight is below the healthy range for your height; the lowest goal Plateful will use is " + r1(C.fromLb(C.minHealthyWeightLb(p.heightCm), unit())) + " " + unit() + ".";
  const t = C.startingTarget(p, p.wLb);
  out.innerHTML = "Starting target: <b>" + fmt(t.target) + " kcal</b> a day (estimated burn about " + fmt(t.est) + "). It adjusts weekly once Plateful has 3 weeks of your weigh-ins." + esc(note);
}
["suAge", "suWt", "suFt", "suIn", "suCm", "suAct", "suGoalWt", "suPreg", "suU18", "suEd"].forEach(id => $(id).addEventListener("input", setupPreview));
$("setupForm").addEventListener("submit", e => {
  e.preventDefault(); if ($("suSave").disabled) return;
  const p = readSetup();
  if (p.goalWeightLb && p.goalWeightLb < C.minHealthyWeightLb(p.heightCm)) p.goalWeightLb = r1(C.minHealthyWeightLb(p.heightCm));
  const old = state.profile;
  const restart = !old || old.goal !== p.goal;
  state.profile = { ...p, wLb: undefined, start: restart ? TODAY : old.start, setupDone: true };
  delete state.profile.wLb;
  if (state.weights[TODAY] == null) state.weights[TODAY] = r1(C.fromLb(p.wLb, unit()));
  state.goals.auto = true;
  if (restart) { state.coach.lastCheckin = null; state.coach.breakUntil = null; }
  setTarget(C.startingTarget(state.profile, p.wLb).target);
  if (p.goalWeightLb) state.goals.weight = r1(C.fromLb(p.goalWeightLb, unit()));
  save(); setupDlg.close(); render();
  toast("Plan saved · starting target " + fmt(state.goals.kcal));
});

// ---------- Enter Meal ----------
$("mealSeg").innerHTML = MEALS.map(m => '<button type="button" data-meal="' + m + '">' + (m === "Snacks" ? "Snack" : m) + "</button>").join("");
$("mealSeg").onclick = e => { const b = e.target.closest("button"); if (b) { meal = b.dataset.meal; listResults(); renderMeal(); } };
$("modeSeg").onclick = e => { const b = e.target.closest("button"); if (b) { mode = b.dataset.mode; renderMeal(); if (mode === "quick") $("qkKcal").focus(); } };
function lastMealBefore(m) {
  for (let i = 1; i <= 14; i++) {
    const d = addDays(cur, -i), xs = (state.days[d]?.entries || []).filter(e => e.meal === m);
    if (xs.length) return { d, xs };
  }
  return null;
}
function renderMeal() {
  const dt = dateText(cur);
  $("mealEyebrow").textContent = dt.rel === "Today" ? "Today" : dt.rel + ", " + dt.short;
  $("mealSeg").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.meal === meal));
  $("modeSeg").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  ["search", "scan", "quick", "custom"].forEach(m => $("pane" + m[0].toUpperCase() + m.slice(1)).hidden = mode !== m);
  const label = draft ? "Add to recipe" : "Add to " + meal;
  ["addSearch", "addScan", "addQuick", "addCustom"].forEach(id => $(id).textContent = label);
  $("startRecipe").hidden = !!draft;
  // recipe bar
  $("recipeBar").hidden = !draft;
  if (draft) {
    const tot = draft.items.reduce((a, x) => a + x.kcal * x.qty, 0), sv = Math.max(1, +$("rbServ").value || 1);
    $("rbCount").textContent = draft.items.length; $("rbKcal").textContent = fmt(tot);
    $("rbPer").textContent = draft.items.length ? fmt(tot / sv) + " kcal per serving" : "Add ingredients with Search, Scan, Quick or Custom.";
  }
  // repeat last meal
  const items = day(cur).entries.filter(e => e.meal === meal);
  const last = !draft && !items.length ? lastMealBefore(meal) : null;
  $("repeatMeal").hidden = !last;
  if (last) {
    const k = last.xs.reduce((a, e) => a + e.kcal * e.qty, 0);
    $("repeatMeal").textContent = "Repeat " + (last.d === addDays(cur, -1) ? "yesterday's" : dateText(last.d).wd + "'s") + " " + meal.toLowerCase() + " · " + last.xs.length + " item" + (last.xs.length > 1 ? "s" : "") + " · " + fmt(k) + " kcal";
    $("repeatMeal").onclick = () => logMany(last.xs, "Added " + meal.toLowerCase() + " (" + last.xs.length + " items)");
  }
  // list: the meal so far, or the recipe's ingredients
  if (draft) {
    $("mealListTitle").textContent = "Recipe ingredients";
    $("mealList").innerHTML = draft.items.length ? draft.items.map((e, i) => '<li><span class="dt">' + esc(e.name) + "<small>" + esc((e.qty !== 1 ? r2q(e.qty) + " × " : "") + e.serving) + '</small></span><span class="v">' + fmt(e.kcal * e.qty) + '</span><button class="del" data-rdel="' + i + '" aria-label="Remove ' + esc(e.name) + '">&times;</button></li>').join("")
      : '<li class="empty" style="display:block;border:0;padding:0">No ingredients yet.</li>';
    $("saveMealRow").hidden = true;
  } else {
    $("mealListTitle").textContent = meal + " so far · " + fmt(items.reduce((a, e) => a + e.kcal * e.qty, 0)) + " kcal";
    $("mealList").innerHTML = items.length ? items.map(e => '<li><button type="button" class="dt" data-edit="' + e.id + '" style="border:0;background:none;padding:0;text-align:left;font:inherit;color:inherit">' + esc(e.name) + "<small>" + esc((e.qty !== 1 ? r2q(e.qty) + " × " : "") + e.serving) +
      '</small></button><span class="v">' + fmt(e.kcal * e.qty) + '</span><button class="del" data-del="' + e.id + '" aria-label="Remove ' + esc(e.name) + '">&times;</button></li>').join("")
      : '<li class="empty" style="display:block;border:0;padding:0">Nothing logged for ' + meal.toLowerCase() + " yet.</li>";
    $("saveMealRow").hidden = items.length < 2;
    $("saveMealName").placeholder = "Save as a meal, e.g. My usual " + meal.toLowerCase();
  }
  validate();
}
$("mealList").addEventListener("click", e => {
  const del = e.target.closest("[data-del]"); if (del) return removeEntry(del.dataset.del);
  const ed = e.target.closest("[data-edit]"); if (ed) return openEdit(ed.dataset.edit);
  const rd = e.target.closest("[data-rdel]"); if (rd) { draft.items.splice(+rd.dataset.rdel, 1); renderMeal(); }
});
// Central "add": into the recipe draft if one is open, otherwise into the log.
function logFood(f, qty, quiet) {
  const entry = { name: f.name, serving: f.serving, qty, kcal: r1(f.kcal), p: r1(f.p), c: r1(f.c), f: r1(f.f) };
  if (draft) { draft.items.push(entry); renderMeal(); toast("Added to recipe"); return; }
  const e = { id: uid(), meal, ...entry }, on = cur;
  day(cur).entries.push(e);
  save(); renderMeal(); if (tab === "today") renderToday();
  if (!quiet) toast("Added " + f.name, () => { const d = day(on); const i = d.entries.findIndex(x => x.id === e.id); if (i > -1) d.entries.splice(i, 1); save(); render(); });
  return e;
}
function logMany(items, msg) {
  if (draft) { items.forEach(x => draft.items.push({ ...x })); renderMeal(); toast("Added to recipe"); return; }
  const ids = items.map(x => logFood(x, x.qty, true).id), on = cur;
  listResults();
  toast(msg, () => { const d = day(on); d.entries = d.entries.filter(x => !ids.includes(x.id)); save(); render(); });
}
$("saveMealBtn").onclick = () => {
  const items = day(cur).entries.filter(e => e.meal === meal);
  if (items.length < 2) return;
  const name = $("saveMealName").value.trim() || "My usual " + meal.toLowerCase();
  state.meals.unshift({ id: "m" + uid(), name, items: items.map(({ id, meal, ...x }) => x) });
  $("saveMealName").value = ""; save(); listResults();
  toast("Saved “" + name + "”. It's at the top of Search.");
};

// ---------- recipes ----------
$("startRecipe").onclick = () => {
  draft = { items: [] }; $("rbName").value = ""; $("rbServ").value = 4; mode = "search"; renderMeal();
  window.scrollTo(0, 0); $("rbName").focus();
};
$("rbCancel").onclick = () => { draft = null; renderMeal(); };
$("rbServ").addEventListener("input", renderMeal);
$("rbSave").onclick = () => {
  if (!draft.items.length) { toast("Add at least one ingredient first."); return; }
  const name = $("rbName").value.trim(); if (!name) { $("rbName").focus(); toast("Give the recipe a name."); return; }
  const sv = Math.max(1, +$("rbServ").value || 1), sum = k => draft.items.reduce((a, x) => a + x[k] * x.qty, 0);
  state.custom.unshift({ id: "u" + uid(), name, serving: "1 serving (1/" + sv + " of recipe)", kcal: r1(sum("kcal") / sv), p: r1(sum("p") / sv), c: r1(sum("c") / sv), f: r1(sum("f") / sv), recipe: { servings: sv, items: draft.items } });
  draft = null; save(); renderMeal(); listResults();
  toast("Saved recipe “" + name + "”");
};

// ---------- food database (loaded once, then cached by the service worker) ----------
let DB = null, dbLoading = null;
function loadDB() {
  if (dbLoading) return dbLoading;
  if (!CFG.dataVersion) {
    DB = FALLBACK_FOODS.map(f => ({ ...f, ln: f.name.toLowerCase() }));
    $("dbStatus").textContent = "Using a basic food list. The full food database wasn't included in this deploy.";
    return (dbLoading = Promise.resolve());
  }
  const t0 = performance.now();
  dbLoading = fetch("/data/" + CFG.dataVersion + "/foods.json").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(rows => {
    DB = rows.map(r => ({ kind: "g", name: r[0], ln: r[0].toLowerCase(), per100: [r[1], r[2], r[3], r[4]], portions: r[5] || [], src: r[6] }));
    const ms = Math.round(performance.now() - t0);
    $("dbStatus").textContent = DB.length.toLocaleString() + " foods ready" + (ms < 150 ? ", works offline" : "") + ".";
    if ($("q").value) listResults();
  }).catch(() => {
    DB = FALLBACK_FOODS.map(f => ({ ...f, ln: f.name.toLowerCase() }));
    $("dbStatus").textContent = "Couldn't load the food database. Showing a basic list; check your connection.";
    dbLoading = null;
  });
  return dbLoading;
}
function searchLocal(q) {
  const toks = q.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!toks.length || !DB) return [];
  const out = [];
  for (const f of DB) {
    let ok = true;
    for (const t of toks) if (!f.ln.includes(t)) { ok = false; break; }
    if (!ok) continue;
    const head = f.ln.split(",")[0];
    let s = 0;
    if (f.ln.startsWith(toks[0])) s -= 10;
    if (head.includes(toks[0])) s -= 4;
    if (toks.every(t => head.includes(t))) s -= 4;
    s += (f.ln.match(/,/g) || []).length * 1.5 + f.ln.length / 25;
    if (/\braw\b/.test(f.ln)) s -= 1;
    if (f.src === "f") s -= 0.5;
    out.push([s, f]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(0, 40).map(x => x[1]);
}
const customAsItem = f => ({ kind: "s", name: f.name, serving: f.serving, kcal: f.kcal, p: f.p, c: f.c, f: f.f, src: f.recipe ? "recipe" : "custom", id: f.id });
// Recent and frequent foods from the log: one tap re-logs with the last amount used.
function historyFoods() {
  const seen = new Map(), freq = new Map();
  const dates = Object.keys(state.days).filter(d => d <= TODAY && d >= addDays(TODAY, -60)).sort().reverse();
  for (const d of dates) for (const e of [...state.days[d].entries].reverse()) {
    const k = e.name + "|" + e.serving;
    if (!seen.has(k)) seen.set(k, { kind: "s", name: e.name, serving: e.serving, kcal: e.kcal, p: e.p, c: e.c, f: e.f, qty: e.qty, src: "history" });
    if (e.meal === meal) freq.set(k, (freq.get(k) || 0) + 1);
  }
  const often = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => seen.get(k));
  const oftenKeys = new Set(often.map(x => x.name + "|" + x.serving));
  const recent = [...seen.entries()].filter(([k]) => !oftenKeys.has(k)).slice(0, 12).map(([, v]) => v);
  return { often, recent };
}

// Brand-name search through /api/search (USDA FoodData Central), debounced and cached.
const brandCache = new Map();
let brandTimer, brandCtl, brandResults = null, brandQuery = "";
function queueBrandSearch(q) {
  clearTimeout(brandTimer); brandCtl?.abort();
  brandResults = null; brandQuery = q;
  if (!FEATURES.brandSearch || q.length < 3) return;
  if (brandCache.has(q)) { brandResults = brandCache.get(q); return; }
  brandResults = "loading";
  brandTimer = setTimeout(() => {
    brandCtl = new AbortController();
    fetch("/api/search?q=" + encodeURIComponent(q), { signal: brandCtl.signal })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(j => { const items = (j.foods || []).map(x => ({ kind: "s", src: "usda-brand", ...x })); brandCache.set(q, items); if (brandQuery === q) { brandResults = items; listResults(); } })
      .catch(e => { if (e?.name !== "AbortError" && brandQuery === q) { brandResults = "error"; listResults(); } });
  }, 450);
}

let shown = [], selected = null;
function listResults() {
  const q = $("q").value.trim(), ql = q.toLowerCase();
  shown = [];
  let html = "";
  const row = (it, quick) => {
    const i = shown.push(it) - 1;
    const s = defaultServing(it);
    const qty = it.qty && it.qty !== 1 ? r2q(it.qty) + " × " : "";
    const sub = (it.brand ? it.brand + " · " : "") + qty + s.serving + (it.src === "custom" ? " · yours" : it.src === "recipe" ? " · recipe" : "");
    const main = '<button type="button" data-i="' + i + '" aria-pressed="' + (selected && selected.item === it) + '"><span class="rn">' + esc(it.name) + '</span><span class="rs">' + esc(sub) + '</span><span class="rk">' + fmt(s.kcal * (it.qty || 1)) + "</span></button>";
    return quick ? '<li class="qrow">' + main + '<button type="button" class="qadd" data-q="' + i + '" aria-label="Add ' + esc(it.name) + ' now">+</button></li>' : "<li>" + main + "</li>";
  };
  const sec = t => '<li class="sec">' + t + "</li>";
  if (!ql) {
    if (state.meals.length) {
      html += sec("Your meals") + state.meals.slice(0, 6).map(m => {
        const k = m.items.reduce((a, x) => a + x.kcal * x.qty, 0);
        return '<li class="qrow"><button type="button" data-meal-id="' + m.id + '"><span class="rn">' + esc(m.name) + '</span><span class="rs">' + m.items.length + " items · " + esc(m.items.map(x => x.name).join(", ").slice(0, 60)) + '</span><span class="rk">' + fmt(k) + '</span></button><button type="button" class="qadd" data-meal-id="' + m.id + '" aria-label="Add ' + esc(m.name) + ' now">+</button></li>';
      }).join("");
    }
    const h = historyFoods();
    if (h.often.length) html += sec("Often at " + meal.toLowerCase()) + h.often.map(x => row(x, true)).join("");
    if (h.recent.length) html += sec("Recent") + h.recent.map(x => row(x, true)).join("");
    const mine = state.custom.slice(0, 10).map(customAsItem);
    if (mine.length) html += sec("Your foods & recipes") + mine.map(x => row(x, true)).join("");
    if (!html) html = '<li class="empty">Search ' + (DB ? DB.length.toLocaleString() + " foods" : "foods") + ", scan a barcode, or use Quick to log a calorie number. Foods you log show up here for one-tap adding.</li>";
  } else {
    const mine = state.custom.filter(f => f.name.toLowerCase().includes(ql)).slice(0, 8).map(customAsItem);
    const hist = historyFoods(), past = [...hist.often, ...hist.recent].filter(x => x.name.toLowerCase().includes(ql)).slice(0, 5);
    const local = searchLocal(q);
    if (past.length) html += sec("You've had") + past.map(x => row(x, true)).join("");
    if (mine.length) html += sec("Your foods & recipes") + mine.map(x => row(x, true)).join("");
    if (local.length) html += sec("Foods") + local.map(x => row(x)).join("");
    if (FEATURES.brandSearch && q.length >= 3) {
      html += sec("Brand-name products");
      if (brandResults === "loading" || brandResults === null) html += '<li class="empty">Searching brand-name products…</li>';
      else if (brandResults === "error") html += '<li class="empty">Brand search isn\'t responding right now. Try Scan instead.</li>';
      else if (!brandResults.length) html += '<li class="empty">No brand-name matches.</li>';
      else html += brandResults.slice(0, 20).map(x => row(x)).join("");
    }
    if (!html) html = '<li class="empty">' + (DB ? "No match. Try fewer words, Scan the barcode, or use Quick." : "Loading the food database…") + "</li>";
  }
  $("results").innerHTML = html;
}
$("q").addEventListener("input", () => { const q = $("q").value.trim(); queueBrandSearch(q); listResults(); });
$("q").addEventListener("focus", () => loadDB());
$("results").addEventListener("click", e => {
  const mb = e.target.closest("[data-meal-id]");
  if (mb) { const m = state.meals.find(x => x.id === mb.dataset.mealId); if (m) logMany(m.items, "Added " + m.name); return; }
  const qb = e.target.closest("[data-q]");
  if (qb) { const it = shown[+qb.dataset.q]; const s = defaultServing(it); logFood({ name: it.brand && !it.name.toLowerCase().includes(it.brand.toLowerCase()) ? it.name + " (" + it.brand + ")" : it.name, ...s }, it.qty || 1); listResults(); return; }
  const b = e.target.closest("button[data-i]"); if (!b) return;
  pick(shown[+b.dataset.i]);
});
function defaultServing(it) {
  if (it.kind === "s") return { serving: it.serving, kcal: it.kcal, p: it.p, c: it.c, f: it.f };
  const [label, g] = it.portions[0] || ["100 g", 100];
  return per(it, label, g);
}
function per(it, label, g) {
  const k = g / 100, [kc, p, c, f] = it.per100;
  return { serving: label === "100 g" || /\d\s*g\b/.test(label) ? label : label + " (" + r0(g) + " g)", kcal: kc * k, p: p * k, c: c * k, f: f * k };
}
function pick(it) {
  selected = { item: it };
  const sel = $("portion");
  if (it.kind === "g") {
    const opts = [...it.portions];
    if (!opts.some(o => o[0] === "100 g")) opts.push(["100 g", 100]);
    opts.push(["1 oz", 28.35], ["1 g", 1]);
    sel.innerHTML = opts.map((o, i) => '<option value="' + i + '">' + esc(o[0]) + (o[0].endsWith(" g") || o[0] === "1 oz" ? "" : " (" + r0(o[1]) + " g)") + "</option>").join("");
    sel.disabled = false; selected.opts = opts;
  } else {
    sel.innerHTML = "<option>" + esc(it.serving) + "</option>"; sel.disabled = true;
  }
  $("qty").value = it.qty || 1;
  listResults(); updatePreview();
  $("addSearch").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function currentPick() {
  if (!selected) return null;
  const it = selected.item;
  if (it.kind === "s") return { name: it.brand && !it.name.toLowerCase().includes(it.brand.toLowerCase()) ? it.name + " (" + it.brand + ")" : it.name, serving: it.serving, kcal: r1(it.kcal), p: r1(it.p), c: r1(it.c), f: r1(it.f) };
  const o = selected.opts[+$("portion").value || 0];
  const s = per(it, o[0], o[1]);
  return { name: it.name, serving: s.serving, kcal: r1(s.kcal), p: r1(s.p), c: r1(s.c), f: r1(s.f) };
}
function updatePreview() {
  const q = parseFloat($("qty").value) || 0, s = currentPick();
  if (!selected) { $("portion").innerHTML = "<option>Pick a food first</option>"; $("portion").disabled = true; }
  $("preview").innerHTML = s ? "<span>" + esc(s.name) + "</span><span><b>" + fmt(s.kcal * q) + "</b> kcal</span><span>P <b>" + r0(s.p * q) + "</b>g</span><span>C <b>" + r0(s.c * q) + "</b>g</span><span>F <b>" + r0(s.f * q) + "</b>g</span>" : "Pick a food to see its totals, or tap + to add it straight away.";
  validate();
}
$("qty").addEventListener("input", updatePreview);
$("portion").addEventListener("change", updatePreview);
["cName", "cKcal", "cQty", "qkKcal"].forEach(i => $(i).addEventListener("input", validate));
function validate() {
  $("addSearch").disabled = !(selected && parseFloat($("qty").value) > 0);
  $("addScan").disabled = !(scanKey && !$("scanForm").hidden && $("sName").value.trim() && $("sKcal").value !== "" && parseFloat($("sQty").value) > 0);
  $("addCustom").disabled = !($("cName").value.trim() && $("cKcal").value !== "" && parseFloat($("cQty").value) > 0);
  $("addQuick").disabled = !(parseFloat($("qkKcal").value) > 0);
}
$("paneSearch").addEventListener("submit", e => {
  e.preventDefault();
  if (document.activeElement === $("q")) { $("q").blur(); return; }
  if ($("addSearch").disabled) return;
  logFood(currentPick(), parseFloat($("qty").value));
  selected = null; $("q").value = ""; $("qty").value = 1; brandResults = null;
  listResults(); updatePreview();
});
$("paneCustom").addEventListener("submit", e => {
  e.preventDefault(); if ($("addCustom").disabled) return;
  const f = { id: "u" + uid(), name: $("cName").value.trim(), serving: $("cServ").value.trim() || "1 serving", kcal: +$("cKcal").value || 0, p: +$("cP").value || 0, c: +$("cC").value || 0, f: +$("cF").value || 0 };
  state.custom.unshift(f);
  logFood(f, parseFloat($("cQty").value));
  ["cName", "cServ", "cKcal", "cP", "cC", "cF"].forEach(i => $(i).value = ""); $("cQty").value = 1; validate();
});
$("paneQuick").addEventListener("submit", e => {
  e.preventDefault(); if ($("addQuick").disabled) return;
  const k = +$("qkKcal").value, p = +$("qkP").value || 0;
  logFood({ name: $("qkName").value.trim() || "Quick add", serving: "quick add", kcal: k, p, c: 0, f: 0 }, 1);
  ["qkKcal", "qkP", "qkName"].forEach(i => $(i).value = ""); validate();
});

// ---------- edit an entry ----------
const editDlg = $("editDlg");
let editing = null;
$("edMeal").innerHTML = MEALS.map(m => '<button type="button" data-v="' + m + '">' + (m === "Snacks" ? "Snack" : m) + "</button>").join("");
function openEdit(id) {
  const e = day(cur).entries.find(x => x.id === id); if (!e) return;
  editing = { id, meal: e.meal };
  $("editTitle").textContent = e.name; $("editServing").textContent = "Serving: " + e.serving;
  $("edQty").value = e.qty; edRender(); editDlg.showModal();
}
function edRender() {
  const e = day(cur).entries.find(x => x.id === editing.id), q = parseFloat($("edQty").value) || 0;
  $("edMeal").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === editing.meal));
  $("edPreview").innerHTML = "<span><b>" + fmt(e.kcal * q) + "</b> kcal</span><span>P <b>" + r0(e.p * q) + "</b>g</span><span>C <b>" + r0(e.c * q) + "</b>g</span><span>F <b>" + r0(e.f * q) + "</b>g</span>";
}
$("edMeal").onclick = ev => { const b = ev.target.closest("button"); if (b) { editing.meal = b.dataset.v; edRender(); } };
$("edQty").addEventListener("input", edRender);
const step = q => (q <= 1 ? 0.25 : 0.5);
const r2 = n => Math.round(n * 100) / 100;
$("edMinus").onclick = () => { const q = parseFloat($("edQty").value) || 1; $("edQty").value = Math.max(0.25, r2(q - step(q - 0.01))); edRender(); };
$("edPlus").onclick = () => { const q = parseFloat($("edQty").value) || 1; $("edQty").value = r2(q + step(q)); edRender(); };
$("editForm").addEventListener("submit", ev => {
  ev.preventDefault();
  const e = day(cur).entries.find(x => x.id === editing.id), q = parseFloat($("edQty").value);
  if (!(q > 0)) { $("edQty").focus(); return; }
  e.qty = q; e.meal = editing.meal; save(); editDlg.close(); render(); toast("Updated " + e.name);
});
$("edDelete").onclick = () => { editDlg.close(); removeEntry(editing.id); };

// ---------- barcode scanning ----------
let scanKey = "";
const shardCache = new Map();
function setStatus(id, msg, kind) { const el = $(id); el.hidden = !msg; el.textContent = msg || ""; el.className = "status" + (kind ? " " + kind : ""); }
function resetScan() {
  scanKey = ""; $("bcCode").value = ""; $("lbFile").value = "";
  setStatus("bcStatus", ""); setStatus("lbStatus", ""); $("labelStep").hidden = true; $("scanForm").hidden = true;
  ["sName", "sServ", "sKcal", "sP", "sC", "sF"].forEach(i => $(i).value = ""); $("sQty").value = 1;
  document.querySelectorAll(".drop img").forEach(i => i.remove()); validate();
}
function hints() {
  const h = new Map();
  h.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.CODE_128]);
  h.set(ZXing.DecodeHintType.TRY_HARDER, true);
  return h;
}
// Live scanning: our own frame loop over the centre of the video, decoded with the
// browser's BarcodeDetector when available (Android Chrome) or ZXing (iPhone Safari).
let camStream = null, camTimer = null, camSession = 0;
const scanDlg = $("scanDlg");
$("openScanner").onclick = () => { scanDlg.showModal(); startCamera(); };
scanDlg.addEventListener("close", stopCamera);
async function makeDetector() {
  if (!("BarcodeDetector" in window)) return null;
  try {
    const want = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];
    const have = await BarcodeDetector.getSupportedFormats();
    const formats = want.filter(f => have.includes(f));
    return formats.length ? new BarcodeDetector({ formats }) : null;
  } catch { return null; }
}
async function decodeFrame(v, canvas, ctx, det, mfr) {
  const vw = v.videoWidth, vh = v.videoHeight;
  const sx = vw * 0.05, sy = vh * 0.2, sw = vw * 0.9, sh = vh * 0.6;
  const k = Math.min(1, 960 / sw);
  canvas.width = Math.round(sw * k); canvas.height = Math.round(sh * k);
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  if (det) { try { const r = await det.detect(canvas); if (r[0]) return r[0].rawValue; } catch {} }
  if (mfr) {
    try { return mfr.decodeWithState(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas)))).getText(); }
    catch { /* no barcode in this frame */ }
  }
  return null;
}
async function startCamera() {
  const msg = $("camMsg"), session = ++camSession;
  if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = "This browser can't open the camera. Use a photo instead."; return; }
  msg.textContent = "Starting camera…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (session !== camSession) { stream.getTracks().forEach(t => t.stop()); return; }
    camStream = stream;
    const v = $("video");
    v.srcObject = stream;
    await v.play().catch(() => {});
    if (v.readyState < 2) await new Promise(r => v.addEventListener("loadeddata", r, { once: true }));
    const det = await makeDetector();
    if (!det && !window.ZXing) { msg.textContent = "The scanner is still loading. Close this and try again in a moment."; return; }
    let mfr = null;
    if (window.ZXing) { mfr = new ZXing.MultiFormatReader(); mfr.setHints(hints()); }
    msg.textContent = "Hold the barcode inside the frame.";
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = async () => {
      if (session !== camSession || !camStream) return;
      const text = v.videoWidth ? await decodeFrame(v, canvas, ctx, det, mfr) : null;
      if (session !== camSession) return;
      if (text) {
        try { navigator.vibrate?.(60); } catch {}
        stopCamera(); scanDlg.close(); lookupCode(text);
        return;
      }
      camTimer = setTimeout(tick, 120);
    };
    tick();
  } catch (e) {
    msg.textContent = e?.name === "NotAllowedError" ? "Camera access is blocked. Allow the camera for this site in Settings, or use a photo." : "Couldn't start the camera. Use a photo instead.";
  }
}
function stopCamera() {
  camSession++;
  clearTimeout(camTimer);
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  camStream = null;
  $("video").srcObject = null;
}
async function decodePhoto(file) {
  if ("BarcodeDetector" in window) {
    try { const det = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] }); const r = await det.detect(await createImageBitmap(file)); if (r[0]) return r[0].rawValue; } catch {}
  }
  if (!window.ZXing) throw new Error("no decoder");
  const url = URL.createObjectURL(file);
  try { return (await new ZXing.BrowserMultiFormatReader(hints()).decodeFromImageUrl(url)).getText(); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}
$("bcFile").addEventListener("change", async e => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  $("camMsg").textContent = "Reading the photo…";
  try { const code = await decodePhoto(file); stopCamera(); scanDlg.close(); lookupCode(code); }
  catch { $("camMsg").textContent = "No barcode found in that photo. Try closer, in good light, or type the number."; }
});
$("bcLook").onclick = () => lookupCode($("bcCode").value);
$("bcCode").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); lookupCode($("bcCode").value); } });

async function shardLookup(key) {
  if (!CFG.dataVersion) return null;
  const s = shardOf(key);
  let m = shardCache.get(s);
  if (!m) {
    const r = await fetch("/data/" + CFG.dataVersion + "/bc/" + s + ".json");
    if (!r.ok) throw new Error("shard " + r.status);
    m = await r.json(); shardCache.set(s, m);
  }
  const v = m[key];
  return v ? { name: v[0], brand: v[1], serving: v[2], kcal: v[3], p: v[4], c: v[5], f: v[6], src: v[7] === "o" ? "Open Food Facts" : "USDA" } : null;
}
async function lookupCode(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (mode !== "scan") { mode = "scan"; renderMeal(); }
  resetScan(); $("bcCode").value = digits;
  const keys = [canon(digits)];
  if (digits.length === 8 && /^[01]/.test(digits)) keys.push(canon(upcEtoA(digits)));
  if (!keys[0]) { setStatus("bcStatus", "Barcodes are 8 to 14 digits. Check the number and try again.", "err"); return; }
  scanKey = keys[0];
  setStatus("bcStatus", "Looking up " + digits + "…");
  const t0 = performance.now();
  for (const k of keys) if (state.barcodes[k]) { scanKey = k; return found(state.barcodes[k], "your list", t0); }
  try { for (const k of keys.filter(Boolean)) { const hit = await shardLookup(k); if (hit) { scanKey = k; return found(hit, hit.src, t0); } } }
  catch { /* offline or not deployed; fall through to live lookup */ }
  try {
    const r = await fetch("/api/off/" + digits);
    if (r.ok) { const j = await r.json(); if (j && j.name) return found(j, "Open Food Facts", t0); }
  } catch {}
  setStatus("bcStatus", "Barcode " + digits + " isn't in the USDA or Open Food Facts databases yet. Add it once from the label and it will be ready next time.");
  $("labelStep").hidden = false; $("scanForm").hidden = false; updateLabelUI(); scanPreview();
  $("sName").focus();
}
function found(p, source, t0) {
  const name = p.brand && !String(p.name).toLowerCase().includes(String(p.brand).toLowerCase()) ? p.name + " (" + p.brand + ")" : p.name;
  fillScan({ ...p, name });
  const ms = Math.round(performance.now() - t0);
  setStatus("bcStatus", "Found in " + source + (ms < 1000 ? " (" + ms + " ms)" : "") + ". Check the serving, then add.", "ok");
  $("addScan").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function fillScan(f) {
  $("sName").value = f.name || ""; $("sServ").value = f.serving || "";
  $("sKcal").value = f.kcal ?? ""; $("sP").value = f.p ?? ""; $("sC").value = f.c ?? ""; $("sF").value = f.f ?? "";
  $("scanForm").hidden = false; scanPreview();
}
function scanPreview() {
  const q = parseFloat($("sQty").value) || 0;
  $("sPreview").innerHTML = "<span><b>" + fmt((+$("sKcal").value || 0) * q) + "</b> kcal</span><span>P <b>" + r0((+$("sP").value || 0) * q) + "</b>g</span><span>C <b>" + r0((+$("sC").value || 0) * q) + "</b>g</span><span>F <b>" + r0((+$("sF").value || 0) * q) + "</b>g</span>";
  validate();
}
["sName", "sKcal", "sP", "sC", "sF", "sQty"].forEach(i => $(i).addEventListener("input", scanPreview));
$("paneScan").addEventListener("submit", e => {
  e.preventDefault(); if ($("addScan").disabled) return;
  const f = { name: $("sName").value.trim(), serving: $("sServ").value.trim() || "1 serving", kcal: +$("sKcal").value || 0, p: +$("sP").value || 0, c: +$("sC").value || 0, f: +$("sF").value || 0 };
  state.barcodes[scanKey] = f;
  logFood(f, parseFloat($("sQty").value));
  resetScan();
});

// Label photo -> /api/label (Claude reads the Nutrition Facts panel)
function updateLabelUI() {
  $("lbDrop").hidden = !FEATURES.label;
  if (!FEATURES.label) setStatus("lbStatus", $("labelStep").hidden ? "" : "Type the values from the package's Nutrition Facts panel below.");
}
function shrink(file, max = 1400) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      res(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("bad image")); };
    img.src = url;
  });
}
$("lbFile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  const drop = $("lbDrop"); let img = drop.querySelector("img");
  if (!img) { img = document.createElement("img"); img.alt = ""; drop.insertBefore(img, drop.firstChild); }
  img.src = URL.createObjectURL(file);
  setStatus("lbStatus", "Reading the label…");
  try {
    const data = await shrink(file);
    const r = await fetch("/api/label", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: data, mediaType: "image/jpeg" }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Label reading failed (" + r.status + ").");
    fillScan({ name: $("sName").value || j.name || "", serving: j.serving || "", kcal: j.kcal, p: j.p, c: j.c, f: j.f });
    setStatus("lbStatus", "Label read. Check the numbers against the package, then add it.", "ok");
    if (!$("sName").value) $("sName").focus();
  } catch (err) {
    setStatus("lbStatus", (err.message || "Couldn't read that label.") + " You can type the values below.", "err");
  }
});

// ---------- Enter Weight ----------
const wkeys = () => Object.keys(state.weights).filter(k => k <= TODAY).sort();
function latestWeight() { const ks = wkeys(); return ks.length ? { date: ks[ks.length - 1], v: state.weights[ks[ks.length - 1]] } : null; }
function trendNow() {
  const ks = wkeys(); if (!ks.length) return null;
  const s = C.trendSeries(state, ks[Math.max(0, ks.length - 60)], TODAY);
  return s.length ? s[s.length - 1].trend : null;
}
function trendAt(d) {
  const ks = wkeys(); if (!ks.length || d < ks[0]) return null;
  const s = C.trendSeries(state, ks[0] < addDays(d, -90) ? addDays(d, -90) : ks[0], d);
  return s.length ? s[s.length - 1].trend : null;
}
function renderWeight() {
  $("wtUnit").textContent = unit();
  if (!$("wtDate").value) $("wtDate").value = TODAY;
  $("wtDate").max = TODAY;
  if (document.activeElement !== $("wtVal") && $("wtVal").value === "") { const l = latestWeight(); $("wtVal").value = l ? l.v : unit() === "kg" ? 75 : 165; }
  const tNow = trendNow(), t7 = trendAt(addDays(TODAY, -7)), t30 = trendAt(addDays(TODAY, -30));
  const conv = lb => lb == null ? null : C.fromLb(lb, unit());
  const ch = (a, b) => a == null || b == null ? "<b>—</b>" : '<b class="' + (a - b <= 0 ? "dn" : "up") + '">' + (a - b > 0 ? "+" : a - b < 0 ? "−" : "") + Math.abs(r1(a - b)) + "</b>";
  $("wtStats").innerHTML = '<div class="stat"><span>Trend</span><b>' + (tNow != null ? r1(conv(tNow)) : "—") + '</b></div><div class="stat"><span>7-day</span>' + ch(conv(tNow), conv(t7)) + '</div><div class="stat"><span>30-day</span>' + ch(conv(tNow), conv(t30)) + "</div>";
  const ks = Object.keys(state.weights).sort().reverse();
  $("wtList").innerHTML = ks.length ? ks.slice(0, 12).map((k, i) => {
    const prev = state.weights[ks[i + 1]], dt = dateText(k), d = prev != null ? r1(state.weights[k] - prev) : null;
    return '<li><span class="dt">' + esc(dt.rel === "Today" || dt.rel === "Yesterday" ? dt.rel : dt.short) + "<small>" + (d == null ? "First entry" : (d > 0 ? "+" : d < 0 ? "−" : "±") + Math.abs(d) + " " + unit() + " from previous") +
      '</small></span><span class="v">' + state.weights[k] + " " + unit() + '</span><button class="del" data-wdel="' + k + '" aria-label="Delete weight for ' + esc(dt.full) + '">&times;</button></li>';
  }).join("") : '<li class="empty" style="display:block;border:0;padding:0">No weigh-ins yet. Enter your weight above.</li>';
}
$("wtMinus").onclick = () => { $("wtVal").value = r1((parseFloat($("wtVal").value) || 0) - 0.2); };
$("wtPlus").onclick = () => { $("wtVal").value = r1((parseFloat($("wtVal").value) || 0) + 0.2); };
$("wtForm").addEventListener("submit", e => {
  e.preventDefault();
  const v = parseFloat($("wtVal").value), d = $("wtDate").value || TODAY;
  if (!(v > 20 && v < 1000)) { $("wtVal").focus(); toast("Enter a weight"); return; }
  if (d > TODAY) { toast("Pick today or an earlier date"); return; }
  state.weights[d] = r1(v); save(); renderWeight(); toast("Saved " + r1(v) + " " + unit());
});
$("wtList").addEventListener("click", e => {
  const b = e.target.closest("[data-wdel]"); if (!b) return;
  const k = b.dataset.wdel, v = state.weights[k];
  delete state.weights[k]; save(); renderWeight();
  toast("Weigh-in deleted", () => { state.weights[k] = v; save(); renderWeight(); });
});

// ---------- Plot sheet ----------
const plotDlg = $("plotDlg");
let plotKind = "cal", plotRange = "7";
try { plotRange = sessionStorage.getItem("plateful.range") || "7"; } catch {}
document.querySelectorAll("[data-plot]").forEach(b => b.onclick = () => { plotKind = b.dataset.plot; renderPlot(); plotDlg.showModal(); });
$("rangeSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; plotRange = b.dataset.range; try { sessionStorage.setItem("plateful.range", plotRange); } catch {} renderPlot(); };
function rangeStart(dates) {
  if (plotRange !== "all") return addDays(TODAY, -(+plotRange - 1));
  const first = dates.sort()[0];
  return first && first < addDays(TODAY, -6) ? first : addDays(TODAY, -6);
}
function fmtTick(s, span) {
  const d = fromIso(s);
  if (span <= 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (span <= 90) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short" }) + (span > 400 ? " ’" + String(d.getFullYear()).slice(2) : "");
}
function niceStep(range, target) { const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p; }
function renderPlot() {
  $("rangeSeg").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.range === plotRange));
  plotKind === "cal" ? plotCalories() : plotWeight();
}
const W = 640, H = 300, PL = 46, PR = 14, PT = 16, PB = 34;
function frame(yMin, yMax, start, span, yFmt) {
  const x = s => PL + (W - PL - PR) * (span <= 1 ? 0.5 : diffDays(start, s) / (span - 1));
  const y = v => PT + (H - PT - PB) * (1 - (v - yMin) / (yMax - yMin));
  let g = ""; const st = niceStep(yMax - yMin, 5);
  for (let v = Math.ceil(yMin / st) * st; v <= yMax + 1e-9; v += st)
    g += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)"/><text x="' + (PL - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + yFmt(v) + "</text>";
  const nt = span <= 7 ? span : 5;
  for (let i = 0; i < nt; i++) {
    const di = span <= 7 ? i : Math.round(i * (span - 1) / (nt - 1)), s = addDays(start, di);
    const anchor = span <= 7 ? "middle" : i === 0 ? "start" : i === nt - 1 ? "end" : "middle";
    g += '<text x="' + x(s) + '" y="' + (H - 10) + '" text-anchor="' + anchor + '">' + fmtTick(s, span) + "</text>";
  }
  return { x, y, g };
}
function plotCalories() {
  $("plotTitle").textContent = "Calories";
  const g = state.goals.kcal;
  const logged = Object.keys(state.days).filter(k => k <= TODAY && totals(k).kcal > 0);
  const start = rangeStart(logged.slice()), span = diffDays(start, TODAY) + 1;
  const pts = [];
  for (let i = 0; i < span; i++) { const s = addDays(start, i), t = totals(s); if (t.kcal > 0) pts.push({ s, v: t.kcal }); }
  const weekly = span > 90;
  let series = pts;
  if (weekly) {
    const b = {};
    pts.forEach(p => { const k = Math.floor(diffDays(start, p.s) / 7); (b[k] = b[k] || []).push(p.v); });
    series = Object.keys(b).map(k => ({ s: addDays(start, Math.min(+k * 7 + 3, span - 1)), v: b[k].reduce((a, c) => a + c, 0) / b[k].length }));
  }
  const yMax = Math.ceil(Math.max(g * 1.15, ...series.map(p => p.v), 100) / 500) * 500;
  const fr = frame(0, yMax, start, span, v => v >= 1000 ? (v / 1000) + "k" : v);
  let s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Calories per day compared with target">' + fr.g;
  const bw = weekly ? Math.max(3, (W - PL - PR) / (span / 7) * 0.7) : Math.max(1.5, (W - PL - PR) / span * 0.66);
  series.forEach(p => {
    s += '<rect x="' + (fr.x(p.s) - bw / 2) + '" y="' + fr.y(p.v) + '" width="' + bw + '" height="' + (fr.y(0) - fr.y(p.v)) + '" rx="' + Math.min(4, bw / 3) + '" fill="' + (p.v > g ? "var(--over)" : "var(--accent)") + '"><title>' + (weekly ? "Week of " : "") + dateText(p.s).short + ": " + fmt(p.v) + " kcal" + (weekly ? "/day" : "") + "</title></rect>";
  });
  s += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + fr.y(g) + '" y2="' + fr.y(g) + '" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="5 4"/>';
  if (!pts.length) s += '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" style="font-size:14px">No meals logged in this range</text>';
  $("plotChart").innerHTML = s + "</svg>";
  const avg = pts.length ? pts.reduce((a, p) => a + p.v, 0) / pts.length : 0, over = pts.filter(p => p.v > g).length;
  $("plotStats").innerHTML = '<div class="stat"><span>Avg / day</span><b>' + (pts.length ? fmt(avg) : "—") + '</b></div><div class="stat"><span>Days logged</span><b>' + pts.length + '<small style="font-weight:400;color:var(--muted)">/' + span + '</small></b></div><div class="stat"><span>Over target</span><b>' + over + "</b></div>";
  $("plotLegend").innerHTML = '<span><i style="background:var(--accent)"></i>' + (weekly ? "Weekly average" : "Daily total") + '</span><span><i style="background:var(--over)"></i>Over target</span><span><i style="background:var(--ink)"></i>Target ' + fmt(g) + " kcal</span>";
}
function plotWeight() {
  $("plotTitle").textContent = "Weight";
  const all = wkeys(), start = rangeStart(all.slice()), span = diffDays(start, TODAY) + 1;
  const pts = all.filter(k => k >= start).map(k => ({ s: k, v: state.weights[k] }));
  // trend line (smoothed), seeded from up to 30 days before the visible range
  const tStart = all.length ? (all[0] > addDays(start, -30) ? all[0] : addDays(start, -30)) : start;
  const trend = all.length ? C.trendSeries(state, tStart, TODAY).filter(x => x.d >= start && x.trend != null).map(x => ({ s: x.d, v: r1(C.fromLb(x.trend, unit())) })) : [];
  const gw = state.goals.weight;
  let lo = Math.min(...pts.map(p => p.v), ...trend.map(p => p.v)), hi = Math.max(...pts.map(p => p.v), ...trend.map(p => p.v));
  if (!pts.length) { lo = gw || (unit() === "kg" ? 60 : 140); hi = lo + 20; }
  if (gw) { lo = Math.min(lo, gw); hi = Math.max(hi, gw); }
  const pad = Math.max(1, (hi - lo) * 0.15); lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
  const fr = frame(lo, hi, start, span, v => r1(v));
  let s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Body weight and trend over time">' + fr.g;
  if (gw) {
    s += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + fr.y(gw) + '" y2="' + fr.y(gw) + '" stroke="var(--good)" stroke-width="2" stroke-dasharray="6 4"/>';
    s += '<text x="' + (PL + 6) + '" y="' + (fr.y(gw) + (fr.y(gw) > H - PB - 20 ? -6 : 16)) + '" style="fill:var(--good);font-weight:600">Goal ' + gw + " " + unit() + "</text>";
  }
  const showDots = pts.length <= 90;
  pts.forEach(p => { if (showDots) s += '<circle cx="' + fr.x(p.s) + '" cy="' + fr.y(p.v) + '" r="3" fill="var(--surface)" stroke="var(--muted)" stroke-width="1.5"><title>' + dateText(p.s).short + ": " + p.v + " " + unit() + "</title></circle>"; });
  if (trend.length > 1) {
    const d = trend.map((p, i) => (i ? "L" : "M") + fr.x(p.s).toFixed(1) + "," + fr.y(p.v).toFixed(1)).join("");
    s += '<path d="' + d + "L" + fr.x(trend[trend.length - 1].s).toFixed(1) + "," + fr.y(lo) + "L" + fr.x(trend[0].s).toFixed(1) + "," + fr.y(lo) + 'Z" fill="var(--weight)" opacity=".08"/>';
    s += '<path d="' + d + '" fill="none" stroke="var(--weight)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>';
  }
  if (trend.length) { const l = trend[trend.length - 1]; s += '<circle cx="' + fr.x(l.s) + '" cy="' + fr.y(l.v) + '" r="5" fill="var(--weight)"/><text x="' + Math.min(fr.x(l.s), W - PR) + '" y="' + (fr.y(l.v) - 10) + '" text-anchor="end" style="fill:var(--ink);font-weight:600">' + l.v + "</text>"; }
  else s += '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" style="font-size:14px">No weigh-ins in this range</text>';
  $("plotChart").innerHTML = s + "</svg>";
  const ch = trend.length > 1 ? r1(trend[trend.length - 1].v - trend[0].v) : null;
  $("plotStats").innerHTML = '<div class="stat"><span>Start</span><b>' + (trend.length ? trend[0].v : "—") + '</b></div><div class="stat"><span>Trend now</span><b>' + (trend.length ? trend[trend.length - 1].v : "—") + '</b></div><div class="stat"><span>Change</span>' + (ch == null ? "<b>—</b>" : '<b class="' + (ch <= 0 ? "dn" : "up") + '">' + (ch > 0 ? "+" : ch < 0 ? "−" : "") + Math.abs(ch) + "</b>") + "</div>";
  $("plotLegend").innerHTML = '<span><i style="background:var(--weight)"></i>Trend (smooths out daily water swings)</span><span><i style="background:var(--muted);height:6px;width:6px;border-radius:99px"></i>Weigh-ins</span>' + (gw ? '<span><i style="background:var(--good)"></i>Goal ' + gw + " " + unit() + "</span>" : "");
}

// ---------- Goals, backup, about ----------
const goalDlg = $("goalDlg");
$("goalsBtn").onclick = () => {
  const g = state.goals;
  $("gK").value = g.kcal; $("gP").value = g.p; $("gC").value = g.c; $("gF").value = g.f; $("gW").value = g.water; $("gUnit").value = g.unit; $("gWt").value = g.weight ?? "";
  $("editPlan").textContent = state.profile ? "Edit your plan" : "Set up your plan (adaptive target)";
  $("gAutoRow").hidden = !state.profile; $("gAuto").checked = !!g.auto; $("gK").disabled = !!g.auto && !!state.profile;
  macroCheck(); resetIdle(); renderAbout(); goalDlg.showModal();
};
$("gAuto").addEventListener("change", () => { $("gK").disabled = $("gAuto").checked; });
$("editPlan").onclick = openSetup;
function macroCheck() { const k = (+$("gP").value * 4) + (+$("gC").value * 4) + (+$("gF").value * 9); $("macroCheck").textContent = "Your macro goals add up to " + fmt(k) + " kcal (4 per gram of protein and carbs, 9 per gram of fat)."; }
["gP", "gC", "gF"].forEach(i => $(i).addEventListener("input", macroCheck));
$("goalForm").addEventListener("submit", e => {
  e.preventDefault();
  const k = +$("gK").value; if (!(k > 0)) { $("gK").focus(); return; }
  const nu = $("gUnit").value;
  let gw = parseFloat($("gWt").value) || null;
  if (nu !== state.goals.unit) {
    const f = nu === "kg" ? C.KG : 1 / C.KG;
    Object.keys(state.weights).forEach(d => state.weights[d] = r1(state.weights[d] * f));
    if (gw && gw === state.goals.weight) gw = r1(gw * f);
    $("wtVal").value = "";
  }
  const auto = !!state.profile && $("gAuto").checked;
  state.goals = { ...state.goals, kcal: r0(k), p: +$("gP").value || 0, c: +$("gC").value || 0, f: +$("gF").value || 0, water: Math.max(1, Math.min(16, +$("gW").value || 8)), unit: nu, weight: gw, auto };
  if (state.profile && gw) state.profile.goalWeightLb = C.toLb(gw, nu);
  save(); goalDlg.close(); render(); toast("Goals saved");
});
function resetIdle() { $("resetZone").innerHTML = '<button type="button" class="ghost" id="resetAsk">Erase all logged data</button>'; $("resetAsk").onclick = resetConfirm; }
function resetConfirm() {
  $("resetZone").innerHTML = '<span class="hint">This removes every meal, weigh-in, saved food and your plan on this device.</span><button type="button" class="ghost" id="resetNo">Keep my data</button><button type="button" class="primary" id="resetYes" style="background:var(--danger);width:auto">Erase everything</button>';
  $("resetNo").onclick = resetIdle;
  $("resetYes").onclick = () => { state = normalize({ goals: { ...state.goals, auto: false } }); save(); goalDlg.close(); render(); toast("All data erased"); };
}
$("exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "plateful", version: 3, exportedAt: new Date().toISOString(), state }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "plateful-backup-" + TODAY + ".json";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("Backup exported");
};
$("importFile").addEventListener("change", async e => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    const s = j && j.state ? j.state : j;
    if (!s || typeof s.days !== "object") throw new Error("not a backup");
    state = normalize(s); save(); goalDlg.close(); render(); toast("Backup imported");
  } catch { toast("That file isn't a Plateful backup."); }
});
function renderAbout() {
  const c = CFG.counts;
  $("aboutData").innerHTML = "Food data from <a href=\"https://fdc.nal.usda.gov/\" target=\"_blank\" rel=\"noopener\">USDA FoodData Central</a> (public domain) and <a href=\"https://world.openfoodfacts.org/\" target=\"_blank\" rel=\"noopener\">Open Food Facts</a> (Open Database License)." +
    (c ? " Offline database: " + c.foods.toLocaleString() + " foods and " + (c.usdaBarcodes + c.offBarcodes).toLocaleString() + " barcodes, updated " + new Date(CFG.dataBuiltAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) + "." : "") +
    " App build " + esc(CFG.build || "dev") + ".";
}

document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => b.closest("dialog").close());
[plotDlg, goalDlg, scanDlg, editDlg, setupDlg].forEach(d => d.addEventListener("click", e => { if (e.target === d) d.close(); }));

// ---------- install hint (iPhone Safari) ----------
const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone && !store.get("plateful.installHint")) $("installBanner").hidden = false;
$("installDismiss").onclick = () => { $("installBanner").hidden = true; store.set("plateful.installHint", "1"); };

// ---------- boot ----------
function render() {
  if (tab === "today") renderToday(); else if (tab === "meal") { renderMeal(); listResults(); } else renderWeight();
  if (plotDlg.open) renderPlot();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { const t = iso(new Date()); if (t !== TODAY) { if (cur === TODAY) cur = t; TODAY = t; render(); } }
});
listResults(); updatePreview(); updateLabelUI();
let startTab = "today";
try { startTab = sessionStorage.getItem("plateful.tab") || "today"; } catch {}
showTab(["today", "meal", "weight"].includes(startTab) ? startTab : "today");
(window.requestIdleCallback || (fn => setTimeout(fn, 400)))(() => loadDB());
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
navigator.storage?.persist?.().catch(() => {});
})();
