// Big Brains Tribune value engine, shared by the trade calculator and Big Brain Analytics. Expects a global S = { data, src, tune, ... }.
// Loaded as a plain script; everything here is a global.
const ENDPOINT = "https://eempzkiumbnffftkqdas.supabase.co/functions/v1/tribune-values";
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const store = { get(k) { try { return localStorage.getItem("bbtdesk_" + k); } catch (_) { return null; } }, set(k, v) { try { if (v == null) localStorage.removeItem("bbtdesk_" + k); else localStorage.setItem("bbtdesk_" + k, v); } catch (_) {} } };
const TUNE_DEFAULT = { lean: 0, qb: 1, rb: 1, wr: 1, te: 1, pick: 1, age: 0, star: 0, injury: 0, faab: 12 };
const PRESETS = {
  default: { label: "Default", t: {} },
  qbheavy: { label: "QB-heavy SF", t: { qb: 1.2, te: 1.05 } },
  picks: { label: "Picks are gold", t: { pick: 1.3 } },
  winnow: { label: "Win now", t: { lean: 60, age: 0, star: 10, injury: 15 } },
  rebuild: { label: "Rebuild", t: { lean: 0, age: 6, pick: 1.15 } },
  consolidate: { label: "Stars matter", t: { star: 15 } },
};
const loadTune = () => { try { const t = JSON.parse(store.get("tune") || "{}"); return { ...TUNE_DEFAULT, ...(t && typeof t === "object" ? t : {}) }; } catch (_) { return { ...TUNE_DEFAULT }; } };
const SRC_NAME = { fc: "FantasyCalc", dd: "Dynasty Daddy", both: "Both" };
// ---------- data ----------
async function api(body) {
  const r = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ word: S.word, ...body }) });
  const j = await r.json().catch(() => ({ ok: false, error: "error" }));
  if (!j.ok) throw Object.assign(new Error(j.error || "error"), { code: j.error || "error" });
  return j;
}
// One number per asset for the maths: FantasyCalc's scale, with Dynasty Daddy rescaled onto it so "Both" is a fair average.
function prep(d) {
  const P = d.players, ids = Object.keys(P).filter((id) => P[id].fc.value > 0 && P[id].dd.value > 0).sort((x, y) => P[y].fc.value - P[x].fc.value).slice(0, 60);
  const scale = ids.length ? ids.reduce((s, id) => s + P[id].fc.value, 0) / ids.reduce((s, id) => s + P[id].dd.value, 0) : 1;
  d.scale = scale;
  d.assets = {};
  for (const [id, p] of Object.entries(P)) d.assets[id] = { id, kind: "player", name: p.name, pos: p.pos, team: p.team, age: p.age, fc: p.fc.value, dd: p.dd.value, ddn: Math.round(p.dd.value * scale), rank: p.fc.rank, posRank: p.fc.posRank, ddPosRank: p.dd.posRank, trend: p.fc.trend, x: p.x || {} };
  for (const pk of d.picks) d.assets[pk.id] = { id: pk.id, kind: "pick", name: pk.label, pos: "PICK", team: null, age: null, fc: pk.fc, dd: pk.dd, ddn: Math.round(pk.dd * scale), season: pk.season, round: pk.round, owner: pk.owner, orig: pk.orig, x: {} };
  d.byRid = Object.fromEntries(d.teams.map((t) => [t.rid, t]));
  d.holdings = {};
  for (const t of d.teams) d.holdings[t.rid] = [...t.players, ...d.picks.filter((p) => p.owner === t.rid).map((p) => p.id)];
  d.trades = (d.trades || []).sort((a, b) => b.at - a.at);
  // FAAB as a tradable asset (one per team, amount set in the calculator). Only when the league actually runs FAAB.
  for (const t of d.teams) if (d.settings.faab_budget) d.assets[`faab:${t.rid}`] = { id: `faab:${t.rid}`, kind: "faab", name: "FAAB", pos: "FAAB", team: null, age: null, fc: 0, dd: 0, ddn: 0, amount: 0, left: t.faab ?? 0, rid: t.rid, x: {} };
  recompute(d);
}
// The tuning knobs turn each site's raw number into the number the calculator actually uses (a.v.fc / a.v.dd / a.v.both).
function recompute(d) {
  const T = S.tune, top = Math.max(...Object.values(d.assets).map((a) => a.fc || 0), 1);
  const posMul = { QB: T.qb, RB: T.rb, WR: T.wr, TE: T.te };
  const ageLine = { RB: 26, QB: 32, WR: 28, TE: 28 };
  for (const a of Object.values(d.assets)) {
    if (a.kind === "faab") { const v = (a.amount || 0) * T.faab; a.v = { fc: v, dd: v, both: v }; continue; }
    const adj = (raw, isFc) => {
      if (!raw) return 0;
      let v = raw;
      if (a.kind === "player") {
        if (isFc && T.lean && a.x.redraft) v = raw * (1 - T.lean / 100) + a.x.redraft * (T.lean / 100); // win-now lean mixes in FantasyCalc's redraft number
        v *= posMul[a.pos] ?? 1;
        const over = Math.max(0, (a.age ?? 0) - (ageLine[a.pos] ?? 28)); if (T.age && over) v *= Math.pow(1 - T.age / 100, over);
        if (T.injury && a.x.injury) v *= 1 - T.injury / 100;
      } else v *= T.pick;
      if (T.star) v *= 1 + (T.star / 100) * Math.pow(Math.min(raw, top) / top, 2); // the best assets get the consolidation premium
      return v;
    };
    const fc = adj(a.fc, true), dd = adj(a.ddn, false);
    a.v = { fc, dd, both: fc && dd ? (fc + dd) / 2 : fc || dd };
  }
  S.sugCache = {};
}
const val = (a, src = S.src) => a.v ? a.v[src] : 0;
const tuneHash = () => JSON.stringify(S.tune);
const tweaksActive = () => Object.keys(TUNE_DEFAULT).filter((k) => S.tune[k] !== TUNE_DEFAULT[k] && k !== "faab");
const badge = (t) => `<span class="tb" style="--c:var(${t.c})">${esc(t.k)}</span>`;
const posTag = (a) => `<span class="pos ${a.pos}">${a.pos === "PICK" ? "PICK" : a.pos}</span>`;
// ---------- lineup maths ----------
const SLOT_OK = { QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], FLEX: ["RB", "WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"], K: ["K"], DEF: ["DEF"] };
function lineupValue(ids, d) {
  const A = ids.map((id) => d.assets[id]).filter((a) => a && a.kind === "player").sort((x, y) => val(y) - val(x));
  const used = new Set(); let total = 0;
  const fixed = d.settings.slots.filter((s) => SLOT_OK[s] && SLOT_OK[s].length === 1), flex = d.settings.slots.filter((s) => SLOT_OK[s] && SLOT_OK[s].length > 1);
  for (const s of [...fixed, ...flex]) { const a = A.find((x) => !used.has(x.id) && SLOT_OK[s].includes(x.pos)); if (a) { used.add(a.id); total += val(a); } }
  const bench = A.filter((x) => !used.has(x.id)).reduce((s, x) => s + val(x), 0);
  return { starters: total, bench };
}
// What a team is playing for decides what "better" means: contenders want this year's lineup, rebuilders want youth and picks.
const contending = (t, d) => t.seed <= Math.ceil(d.teams.length / 2);
function futureValue(ids, d) {
  return ids.reduce((s, id) => { const a = d.assets[id]; if (!a) return s; const v = val(a); if (a.kind === "pick") return s + v * 1.1; const age = a.age ?? 26; return s + v * (age <= 24 ? 1.12 : age <= 26 ? 1.04 : age <= 28 ? 0.96 : 0.82); }, 0);
}
function objective(t, ids, d) { if (contending(t, d)) { const l = lineupValue(ids, d); return l.starters + 0.15 * l.bench; } return futureValue(ids, d); }
function combos(arr, k) { const out = []; if (k === 1) return arr.map((x) => [x]); for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]); return out; }
function suggest(rid, d) {
  if (S.sugCache[S.src + ":" + rid]) return S.sugCache[S.src + ":" + rid];
  // (recompute() empties this cache whenever a knob changes)
  const me = d.byRid[rid], mine = d.holdings[rid];
  const pool = (ids) => { const pl = ids.filter((id) => d.assets[id].kind === "player" && val(d.assets[id]) > 0).sort((x, y) => val(d.assets[y]) - val(d.assets[x])).slice(0, 11); const pk = ids.filter((id) => d.assets[id].kind === "pick" && val(d.assets[id]) > 0); return [...pl, ...pk]; };
  const myPool = pool(mine), myCombos = [...combos(myPool, 1), ...combos(myPool, 2)];
  const base = objective(me, mine, d);
  const out = [];
  for (const them of d.teams) {
    if (them.rid === rid) continue;
    const theirs = d.holdings[them.rid], theirPool = pool(theirs), theirBase = objective(them, theirs, d);
    const theirCombos = [...combos(theirPool, 1), ...combos(theirPool, 2)];
    for (const give of myCombos) {
      const gv = give.reduce((s, id) => s + val(d.assets[id]), 0); if (!gv) continue;
      for (const get of theirCombos) {
        const rv = get.reduce((s, id) => s + val(d.assets[id]), 0); if (!rv) continue;
        const diff = Math.abs(gv - rv) / Math.max(gv, rv); if (diff > 0.12) continue;
        if (give.length === 2 && get.length === 2 && give.every((id) => d.assets[id].kind === "pick") && get.every((id) => d.assets[id].kind === "pick")) continue;
        const giveSet = new Set(give), getSet = new Set(get);
        const myAfter = [...mine.filter((id) => !giveSet.has(id)), ...get], theirAfter = [...theirs.filter((id) => !getSet.has(id)), ...give];
        const g1 = objective(me, myAfter, d) - base; if (g1 <= 0) continue;
        const g2 = objective(them, theirAfter, d) - theirBase; if (g2 <= 0) continue;
        out.push({ them, give, get, gv, rv, g1, g2, score: Math.min(g1, g2) * 2 + (g1 + g2) * 0.5 - diff * 1500 });
      }
    }
  }
  out.sort((x, y) => y.score - x.score);
  // One suggestion per partner first, then the rest, so the list isn't nine versions of the same deal.
  const seen = new Map(), pkg = new Map(), top = [], rest = [];
  for (const s of out) {
    const key = s.them.rid, pk = [...s.give].sort().join("+"); if ((pkg.get(pk) || 0) >= 3) continue;
    if (!seen.has(key)) { seen.set(key, 1); pkg.set(pk, (pkg.get(pk) || 0) + 1); top.push(s); } else if (seen.get(key) < 3) { seen.set(key, seen.get(key) + 1); pkg.set(pk, (pkg.get(pk) || 0) + 1); rest.push(s); }
  }
  const res = [...top, ...rest].slice(0, 12);
  S.sugCache[S.src + ":" + rid] = res; return res;
}
function needs(rid, d) {
  const t = d.byRid[rid], ids = d.holdings[rid];
  const byPos = {}; for (const id of ids) { const a = d.assets[id]; if (a.kind !== "player") continue; (byPos[a.pos] ??= []).push(val(a)); }
  const starters = { QB: 2, RB: 2, WR: 3, TE: 1 }; // superflex: a second QB starts
  const rows = Object.entries(starters).map(([pos, n]) => { const v = (byPos[pos] || []).sort((x, y) => y - x); const start = v.slice(0, n).reduce((s, x) => s + x, 0) / n || 0; const depth = v.slice(n).reduce((s, x) => s + x, 0); return { pos, start, depth, count: v.length }; });
  const weakest = [...rows].sort((x, y) => x.start - y.start)[0], deepest = [...rows].sort((x, y) => y.depth - x.depth)[0];
  const picks = ids.filter((id) => d.assets[id].kind === "pick").length;
  return { t, rows, weakest, deepest, picks, mode: contending(t, d) ? "contending" : "rebuilding" };
}

// GM indices, from the league's own trade log scored at today's values (how each deal has aged).
// Aggression 0–1: how often a GM trades, how much value moves per deal, and how often a 1st or a star is in it, as league percentiles.
// Success 0–1: half win rate (deals where what you got is worth more today than what you gave), half net value as a share of what moved.
const SIX_MO = 183 * 864e5;
// The 2026 expansion draft (May 1, 2026): SilentCountPoota and Moose is Loose were stocked through one-sided "trades" where
// the new teams received players and gave nothing. Those are league setup, not deals, so they are left out of every index,
// count and total. The rule is data-driven: a trade on that day where everything flows to one team and no picks move.
const EXPANSION_DAY = "2026-05-01";
const isExpansion = (t) => new Date(t.at).toISOString().slice(0, 10) === EXPANSION_DAY && !t.picks.length && new Set(Object.values(t.adds)).size === 1 && !Object.values(t.drops || {}).some((r) => Object.values(t.adds).includes(r));
const realTrades = (d) => { if (!d._real) d._real = d.trades.filter((t) => !isExpansion(t)); return d._real; };
function tradeSides(t, d) {
  // Two tallies per side: the tuned blend (drives the indexes) and raw Dynasty Daddy points (the all-time up/down figure).
  const cur = d.settings.season;
  const proxy = (round, key) => { const next = d.picks.filter((p) => p.round === round && p.season === cur + 1); return next.length ? next.reduce((s, p) => s + key(d.assets[p.id]), 0) / next.length : 0; };
  const blend = (a) => val(a, "both"), raw = (a) => a.dd || 0;
  const pickVal = (p, key) => { const a = d.assets[`pick:${p.season}:${p.round}:${p.orig}`]; return a ? key(a) : proxy(p.round, key); };
  const out = {};
  for (const rid of t.rids) out[rid] = { got: 0, gave: 0, gotDD: 0, gaveDD: 0, bold: false, n: 0 };
  for (const [id, to] of Object.entries(t.adds)) { const a = d.assets[id], v = a ? blend(a) : 0, vd = a ? raw(a) : 0, from = (t.drops || {})[id]; if (out[to]) { out[to].got += v; out[to].gotDD += vd; out[to].n++; } if (out[from]) { out[from].gave += v; out[from].gaveDD += vd; } if (v >= 0.7 * (d.top || 1)) for (const r of t.rids) out[r].bold = true; }
  for (const p of t.picks) { const v = pickVal(p, blend), vd = pickVal(p, raw); if (out[p.owner]) { out[p.owner].got += v; out[p.owner].gotDD += vd; out[p.owner].n++; } if (out[p.prev]) { out[p.prev].gave += v; out[p.prev].gaveDD += vd; } if (p.round === 1) for (const r of t.rids) out[r].bold = true; }
  return out;
}
function gmStats(d, sinceMs) {
  const trades = realTrades(d).filter((t) => !sinceMs || t.at >= sinceMs);
  const seasons = Math.max(1, new Set(trades.map((t) => t.season)).size);
  const per = Object.fromEntries(d.teams.map((t) => [t.rid, { n: 0, moved: 0, net: 0, ddNet: 0, ddGot: 0, ddGave: 0, wins: 0, bold: 0, best: null, worst: null }]));
  for (const t of trades) { const sides = tradeSides(t, d); for (const [rid, x] of Object.entries(sides)) { const p = per[rid]; if (!p) continue; const net = x.got - x.gave; p.n++; p.moved += (x.got + x.gave) / 2; p.net += net; p.ddNet += x.gotDD - x.gaveDD; p.ddGot += x.gotDD; p.ddGave += x.gaveDD; if (net > 0) p.wins++; if (x.bold) p.bold++; if (!p.best || net > p.best.net) p.best = { net, t }; if (!p.worst || net < p.worst.net) p.worst = { net, t }; } }
  // Centered on the league: each component is scaled so the league average sits at 0.50 (double the average = 1.00), then
  // success is shifted so its league mean is exactly 0.50. A desk with no trades sits at 0 / blank.
  const rids = d.teams.map((t) => t.rid), active = rids.filter((r) => per[r].n > 0);
  const mean = (f) => active.length ? active.reduce((s, r) => s + f(per[r]), 0) / active.length : 0;
  const comp = (p, f, m) => (m > 0 ? Math.min(1, f(p) / (2 * m)) : 0);
  const mRate = mean((p) => p.n / seasons), mSize = mean((p) => p.moved / p.n), mBold = mean((p) => p.bold / p.n);
  const rawSucc = (p) => 0.5 * (p.wins / p.n) + 0.5 * (0.5 + 0.5 * Math.max(-1, Math.min(1, p.net / (p.moved || 1))));
  const mSucc = mean(rawSucc);
  const out = {};
  for (const r of rids) { const p = per[r]; const aggression = p.n ? 0.5 * comp(p, (q) => q.n / seasons, mRate) + 0.3 * comp(p, (q) => q.moved / q.n, mSize) + 0.2 * comp(p, (q) => q.bold / q.n, mBold) : 0; const success = p.n ? Math.max(0, Math.min(1, 0.5 + (rawSucc(p) - mSucc))) : null; out[r] = { ...p, aggression, success, seasons }; }
  return out;
}
function gmIndex(d) {
  const key = S.src + tuneHash(); if (d._gm && d._gm.key === key) return d._gm.v;
  d.top = Math.max(...Object.values(d.assets).map((a) => val(a, "both") || 0), 1);
  const all = gmStats(d, 0), recent = gmStats(d, Date.now() - SIX_MO), v = {};
  // Trend = the last six months on their own versus the full record: ↑ / ↓ past ±0.10, – inside it, with the signed change alongside.
  const arrow = (a, b) => a == null || b == null ? "–" : b - a > 0.1 ? "↑" : a - b > 0.1 ? "↓" : "–";
  const delta = (a, b) => a == null || b == null ? null : b - a;
  for (const t of d.teams) { const A = all[t.rid], R = recent[t.rid], ra = R.n ? R.aggression : null, rs = R.n ? R.success : null; v[t.rid] = { ...A, aggrTrend: arrow(A.aggression, ra), succTrend: arrow(A.success, rs), aggrDelta: delta(A.aggression, ra), succDelta: delta(A.success, rs), recent: R }; }
  d._gm = { key, v }; return v;
}
const trendTxt = (arrow, delta) => delta == null ? "– no deals in 6 mo" : `${arrow} ${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)}`;
const gmLine = (t, d) => { const g = gmIndex(d)[t.rid]; return g.n ? `<span class="gm" title="Aggression: how often and how big this GM trades, league percentile. Success: how those deals have aged at today's values. In brackets: the last six months against the full record."><b>${g.aggression.toFixed(2)}</b> aggr <i class="${g.aggrTrend === "↑" ? "up" : g.aggrTrend === "↓" ? "dn" : ""}">(${trendTxt(g.aggrTrend, g.aggrDelta)})</i> · <b>${g.success.toFixed(2)}</b> success <i class="${g.succTrend === "↑" ? "up" : g.succTrend === "↓" ? "dn" : ""}">(${trendTxt(g.succTrend, g.succDelta)})</i> · ${g.n} trade${g.n === 1 ? "" : "s"} · <b class="${sign(g.ddNet)}">${g.ddNet >= 0 ? "+" : "−"}${fmt(Math.abs(g.ddNet))}</b> DD pts all-time</span>` : `<span class="gm">No trades on record</span>`; };
const ddNetTxt = (g) => `${g.ddNet >= 0 ? "+" : "−"}${fmt(Math.abs(g.ddNet))} DD pts`;
// The definitions, called out at the top of each tool.
const indexCallout = (open) => `<details class="defs" ${open ? "open" : ""}><summary><b>The indexes</b><span>Aggression · Success · how the trends work</span></summary>
  <div class="defgrid">
    <div><b>Aggression (0–1)</b><p>How much of a dealer a GM is, measured against the league: half how often they trade (per season), 30% how much value moves per deal, 20% how often a 1st-round pick or a top asset is involved. Each part is scaled so the league average is 0.50 and double the average is 1.00; 0 means no trades on record.</p></div>
    <div><b>Trade success (0–1)</b><p>How a GM's deals have aged, scored at today's values: half the share of trades where what they got is now worth more than what they gave, half their net value gained as a share of everything they moved, then centered so the league average is exactly 0.50. Above 0.50 means better than the average desk; below it, worse.</p></div>
    <div><b>The trend in brackets</b><p>The same index computed on the last six months only (against that window's league average), compared with the full record (two seasons back). <i class="up">↑</i> means up by more than 0.10, <i class="dn">↓</i> down by more than 0.10, – within that band, with the exact change shown, e.g. (↑ +0.14). "No deals in 6 mo" means the desk has been quiet.</p></div>
    <div><b>All-time on trades (DD pts)</b><p>Everything a GM has received in trades minus everything they have given, in raw Dynasty Daddy points (0–9,999 per asset) at today's values. Positive means their trade pieces have held more value than what they sent out.</p></div>
    <div><b>Not counted</b><p>The May 1, 2026 expansion draft, where SilentCountPoota and Moose is Loose were stocked through one-sided transfers, is league setup rather than trading. Those 14 transfers are left out of every index, trade count and all-time total.</p></div>
    <div><b>Values</b><p>Player and pick values come from FantasyCalc and Dynasty Daddy (dynasty, superflex, PPR), blended by default, with your Tune settings applied. Old trades are scored at today's prices, so a deal's success reflects how the pieces have held value since, not what they cost on the day.</p></div>
  </div></details>`;

// Positional needs, league-relative: each team's starters at a position ranked against the other nine, picks counted the same way.
const STARTERS = { QB: 2, RB: 2, WR: 3, TE: 1 };
function posStrength(ids, d) {
  const by = { QB: [], RB: [], WR: [], TE: [] };
  for (const id of ids) { const a = d.assets[id]; if (a && a.kind === "player" && by[a.pos]) by[a.pos].push(a); }
  const out = {};
  for (const [pos, n] of Object.entries(STARTERS)) { const l = by[pos].sort((x, y) => val(y) - val(x)); out[pos] = { sum: l.slice(0, n).reduce((s, a) => s + val(a), 0), top: l.slice(0, n) }; }
  out.picks = ids.filter((id) => d.assets[id]?.kind === "pick").length;
  out.firsts = ids.filter((id) => d.assets[id]?.kind === "pick" && d.assets[id].round === 1).length;
  return out;
}
function leagueTable(d) {
  if (d._lt && d._lt.key === S.src + tuneHash()) return d._lt.v;
  const v = Object.fromEntries(d.teams.map((t) => [t.rid, posStrength(d.holdings[t.rid], d)])); d._lt = { key: S.src + tuneHash(), v }; return v;
}
const rankOf = (value, values) => values.filter((x) => x > value).length + 1;
function teamNeeds(rid, d, afterIds) {
  const lt = leagueTable(d), mine = lt[rid], n = d.teams.length;
  const after = afterIds ? posStrength(afterIds, d) : null;
  const rows = Object.keys(STARTERS).map((pos) => {
    const others = d.teams.filter((t) => t.rid !== rid).map((t) => lt[t.rid][pos].sum);
    const rank = rankOf(mine[pos].sum, others), rankAfter = after ? rankOf(after[pos].sum, others) : null;
    return { pos, rank, rankAfter, top: mine[pos].top, topAfter: after ? after[pos].top : null, need: rank >= Math.ceil(n * 0.6) };
  });
  const othersPicks = d.teams.filter((t) => t.rid !== rid).map((t) => lt[t.rid].picks);
  const pickRank = rankOf(mine.picks, othersPicks), pickRankAfter = after ? rankOf(after.picks, othersPicks) : null;
  const pickNeed = !contending(d.byRid[rid], d) && (pickRank >= Math.ceil(n * 0.6) || mine.firsts === 0);
  return { rows, needs: rows.filter((r) => r.need), picks: { count: mine.picks, countAfter: after ? after.picks : null, firsts: mine.firsts, rank: pickRank, rankAfter: pickRankAfter, need: pickNeed } };
}
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
const prank = (a) => `${a.posRank ? `${a.pos}${a.posRank}` : "–"}${a.ddPosRank ? ` / ${a.pos}${a.ddPosRank}` : ""}`;
function needsHtml(t, d, afterIds) {
  const N = teamNeeds(t.rid, d, afterIds), n = d.teams.length;
  const arrow = (r, ra) => ra != null && ra !== r ? ` → <b class="${ra < r ? "up" : "dn"}">${ordinal(ra)}</b>` : "";
  const items = N.needs.map((r) => `<li><b>${r.pos}</b> <span class="dim">${ordinal(r.rank)} of ${n}${arrow(r.rank, r.rankAfter)}</span><small>${r.top.length ? r.top.map((a) => `${esc(a.name)} <i>${prank(a)}</i>`).join(", ") : "nobody startable"}${r.topAfter && r.rankAfter !== r.rank ? ` → ${r.topAfter.map((a) => `${esc(a.name)} <i>${prank(a)}</i>`).join(", ")}` : ""}</small></li>`);
  if (N.picks.need) items.push(`<li><b>Picks</b> <span class="dim">${N.picks.count} owned, ${ordinal(N.picks.rank)} of ${n}${N.picks.firsts === 0 ? ", no 1sts" : ""}${N.picks.countAfter != null && N.picks.countAfter !== N.picks.count ? ` → <b class="${N.picks.countAfter > N.picks.count ? "up" : "dn"}">${N.picks.countAfter}</b>` : ""}</span><small>rebuilding without draft capital</small></li>`);
  const strengths = N.rows.filter((r) => r.rank <= 2).map((r) => r.pos);
  return `<div class="needs2"><div class="k">${badge(t)} needs</div>${items.length ? `<ul>${items.join("")}</ul>` : `<p class="small dim" style="margin:0">No glaring hole: every position sits in the top half of the league.</p>`}${strengths.length ? `<p class="small dim" style="margin:4px 0 0">Strength: ${strengths.join(", ")} (top 2 in the league). Ranks are FC / DD position ranks.</p>` : ""}</div>`;
}
const avgAge = (ids, d) => { const a = ids.map((id) => d.assets[id]).filter((x) => x && x.kind === "player" && x.age); return a.length ? a.reduce((s, x) => s + x.age, 0) / a.length : 0; };
// ---------- analytics: trends, projections, trade volume ----------
function spark(pts, w = 180, h = 44) {
  const fc = pts.map((p) => p.fc).filter(Boolean), dd = pts.map((p) => p.dd * S.data.scale).filter(Boolean);
  const all = [...fc, ...dd]; if (all.length < 2) return `<span class="dim small">Not enough history yet</span>`;
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1, n = pts.length;
  const line = (key, color) => { const q = pts.map((p, i) => [p, i]).filter(([p]) => p[key]); if (q.length < 2) return ""; return `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${q.map(([p, i]) => `${((i / (n - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((key === "fc" ? p.fc : p.dd * S.data.scale) - lo) / span * (h - 6)).toFixed(1)}`).join(" ")}"/>`; };
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Value history">${line("fc", "var(--pylon)")}${line("dd", "var(--blue)")}</svg>`;
}
function projection(a, pts) {
  // Rough six-month projection: the recent slope (dampened), plus an age curve by position. Clamped to ±40%.
  const now = val(a, "both"); if (!now) return null;
  const series = pts.map((p) => (p.fc && p.dd ? (p.fc + p.dd * S.data.scale) / 2 : p.fc || p.dd * S.data.scale)).filter(Boolean);
  let slope = 0; if (series.length >= 7) { const k = Math.min(series.length, 90), s = series.slice(-k); slope = (s[s.length - 1] - s[0]) / k; }
  const trendPart = slope * 180 * 0.5;
  const age = a.age ?? 26, pos = a.pos;
  const ageMult = pos === "RB" ? (age >= 27 ? 0.92 : age <= 24 ? 1.03 : 1) : pos === "QB" ? (age >= 34 ? 0.95 : age <= 25 ? 1.03 : 1) : (age >= 30 ? 0.95 : age <= 24 ? 1.03 : 1);
  const raw = (now + trendPart) * ageMult;
  return Math.max(now * 0.6, Math.min(now * 1.4, raw));
}
const sign = (n) => n > 0 ? "up" : n < 0 ? "dn" : "";
const pm = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
// ---------- Big Brain analytics: a full dashboard per team ----------
function teamTotals(d) {
  const key = "tt" + S.src + tuneHash(); if (d._tt && d._tt.key === key) return d._tt.v;
  const v = {};
  for (const t of d.teams) {
    const ids = d.holdings[t.rid], pl = ids.filter((id) => d.assets[id].kind === "player"), pk = ids.filter((id) => d.assets[id].kind === "pick");
    const l = lineupValue(ids, d);
    v[t.rid] = { total: ids.reduce((s, id) => s + val(d.assets[id]), 0), players: pl.reduce((s, id) => s + val(d.assets[id]), 0), picks: pk.reduce((s, id) => s + val(d.assets[id]), 0), starters: l.starters, bench: l.bench, age: avgAge(ids, d), momentum: pl.reduce((s, id) => s + (d.assets[id].trend || 0), 0), n: pl.length, nPicks: pk.length, firsts: pk.filter((id) => d.assets[id].round === 1).length };
  }
  d._tt = { key, v }; return v;
}
function dashboard(root) {
  const d = S.data; if (!S.dashTeam) S.dashTeam = S.sides[0].rid;
  const v = el(`<div><div class="field" style="margin-top:4px"><label class="lab" for="dashteam">Team</label><select id="dashteam">${d.teams.map((t) => `<option value="${t.rid}" ${t.rid === S.dashTeam ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div><div id="dashbody"></div></div>`);
  root.appendChild(v);
  $("#dashteam", v).onchange = (e) => { S.dashTeam = Number(e.target.value); render(); };
  const t = d.byRid[S.dashTeam], tt = teamTotals(d), me = tt[t.rid], n = d.teams.length, g = gmIndex(d)[t.rid], N = teamNeeds(t.rid, d);
  const rank = (key) => rankOf(me[key], d.teams.filter((x) => x.rid !== t.rid).map((x) => tt[x.rid][key]));
  const rankLow = (key) => rankOf(-me[key], d.teams.filter((x) => x.rid !== t.rid).map((x) => -tt[x.rid][key]));
  const tile = (k, v, sub) => `<div class="dt"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
  const ids = d.holdings[t.rid], assets = ids.map((id) => d.assets[id]).sort((x, y) => val(y) - val(x));
  const top5 = assets.slice(0, 5), top5share = me.total ? top5.reduce((s, a) => s + val(a), 0) / me.total : 0;
  const maxTotal = Math.max(...d.teams.map((x) => tt[x.rid].total), 1);
  const leagueBars = [...d.teams].sort((a, b) => tt[b.rid].total - tt[a.rid].total).map((x) => `<div class="lb ${x.rid === t.rid ? "me" : ""}"><span class="nm">${badge(x)}</span><div class="bar"><i style="width:${((tt[x.rid].total / maxTotal) * 100).toFixed(1)}%;background:var(${x.c})"></i></div><span class="num">${fmt(tt[x.rid].total)}</span></div>`).join("");
  const posRows = N.rows.map((r) => `<tr><td><b>${r.pos}</b></td><td>${ordinal(r.rank)}${r.need ? ' <span class="needtag">need</span>' : r.rank <= 2 ? ' <span class="strtag">strength</span>' : ""}</td><td>${r.top.map((a) => `${esc(a.name)} <i>${prank(a)}</i>`).join("<br>") || "<span class=dim>—</span>"}</td></tr>`).join("");
  const picks = ids.filter((id) => d.assets[id].kind === "pick").map((id) => d.assets[id]).sort((a, b) => a.season - b.season || a.round - b.round);
  const ageBuckets = [["≤24", (a) => a.age <= 24], ["25–27", (a) => a.age > 24 && a.age <= 27], ["28–30", (a) => a.age > 27 && a.age <= 30], ["31+", (a) => a.age > 30]].map(([k, f]) => { const l = assets.filter((a) => a.kind === "player" && a.age && f(a)); return { k, n: l.length, v: l.reduce((s, a) => s + val(a), 0) }; });
  const myTrades = d.trades.filter((x) => x.rids.includes(t.rid)).slice(0, 10).map((x) => { if (isExpansion(x)) return `<div class="tr dimmed"><div class="w">${x.season} · expansion draft · with ${x.rids.filter((r) => r !== t.rid).map((r) => esc(d.byRid[r]?.k || "?")).join(", ")}</div><div class="small dim">${Object.keys(x.adds).length} player${Object.keys(x.adds).length === 1 ? "" : "s"} moved to stock the new team · not counted in any index</div></div>`; const sd = tradeSides(x, d)[t.rid]; const gave = [...Object.entries(x.drops || {}).filter(([, r]) => r === t.rid).map(([id]) => d.assets[id]?.name || "a player"), ...x.picks.filter((p) => p.prev === t.rid).map((p) => `${p.season} ${ordinal(p.round)}`)]; const got = [...Object.entries(x.adds).filter(([, r]) => r === t.rid).map(([id]) => d.assets[id]?.name || "a player"), ...x.picks.filter((p) => p.owner === t.rid).map((p) => `${p.season} ${ordinal(p.round)}`)]; const net = sd.got - sd.gave, ddn = sd.gotDD - sd.gaveDD; return `<div class="tr"><div class="w">${x.season} · Wk ${x.week} · with ${x.rids.filter((r) => r !== t.rid).map((r) => esc(d.byRid[r]?.k || "?")).join(", ")}</div><div class="gg"><span><small>Gave</small>${gave.map(esc).join(", ") || "—"}</span><span><small>Got</small>${got.map(esc).join(", ") || "—"}</span></div><div class="net ${net > 0 ? "up" : net < 0 ? "dn" : ""}">${net >= 0 ? "+" : "−"}${fmt(Math.abs(net))} today · ${ddn >= 0 ? "+" : "−"}${fmt(Math.abs(ddn))} DD pts</div></div>`; }).join("");
  $("#dashbody", v).innerHTML = `<div class="dash">
    <div class="dh"><div>${badge(t)} <b class="big">${esc(t.name)}</b></div><div class="small dim">${t.wins}–${t.losses}${t.ties ? `–${t.ties}` : ""} · seed ${t.seed} · ${fmt(t.pf)} PF · ${contending(t, d) ? "contending" : "rebuilding"}</div><div class="small">${gmLine(t, d)}</div></div>
    <div class="dtiles">
      ${tile("Roster value", fmt(me.total), `${ordinal(rank("total"))} of ${n} · ${SRC_NAME[S.src]}`)}
      ${tile("Starting lineup", fmt(me.starters), `${ordinal(rank("starters"))} of ${n}`)}
      ${tile("Bench", fmt(me.bench), `${ordinal(rank("bench"))} of ${n}`)}
      ${tile("Draft capital", fmt(me.picks), `${me.nPicks} picks, ${me.firsts} first${me.firsts === 1 ? "" : "s"} · ${ordinal(rank("picks"))} of ${n}`)}
      ${tile("Average age", me.age.toFixed(1), `${ordinal(rankLow("age"))} youngest`)}
      ${tile("30-day momentum", `${me.momentum >= 0 ? "+" : "−"}${fmt(Math.abs(me.momentum))}`, `FantasyCalc trend, summed · ${ordinal(rank("momentum"))} of ${n}`)}
      ${tile("Top-5 share", `${Math.round(top5share * 100)}%`, top5share > 0.6 ? "top-heavy roster" : top5share < 0.4 ? "spread thin" : "balanced")}
      ${tile("GM aggression", g.n ? g.aggression.toFixed(2) : "–", g.n ? `6 mo: ${trendTxt(g.aggrTrend, g.aggrDelta)} · ${g.n} trades` : "no trades on record")}
      ${tile("Trade success", g.n && g.success != null ? g.success.toFixed(2) : "–", g.n ? `6 mo: ${trendTxt(g.succTrend, g.succDelta)} · ${g.wins} aged well` : "")}
      ${tile("All-time on trades", g.n ? `${g.ddNet >= 0 ? "+" : "−"}${fmt(Math.abs(g.ddNet))}` : "–", g.n ? `Dynasty Daddy points, today's values · got ${fmt(g.ddGot)}, gave ${fmt(g.ddGave)}` : "no trades on record")}
    </div>
    <h2>League by roster value</h2><div class="lbars">${leagueBars}</div>
    <h2>Positions</h2><table class="postab"><thead><tr><th>Pos</th><th>Rank</th><th>Starters · FC / DD rank</th></tr></thead><tbody>${posRows}</tbody><tbody><tr><td><b>Picks</b></td><td>${ordinal(N.picks.rank)}${N.picks.need ? ' <span class="needtag">need</span>' : ""}</td><td>${picks.length ? picks.map((a) => `${esc(a.name)} <i>${fmt(val(a))}</i>`).join("<br>") : "<span class=dim>none</span>"}</td></tr></tbody></table>
    <h2>Core assets</h2><div class="core">${top5.map((a, i) => `<div class="ca"><span class="i">${i + 1}</span>${posTag(a)}<span class="nm">${esc(a.name)}<small>${a.kind === "pick" ? `${a.season} rookie draft` : `${esc(a.team || "FA")}${a.age ? ` · ${Math.floor(a.age)}` : ""} · ${prank(a)}${a.trend ? ` · 30d ${pm(a.trend)}` : ""}`}</small></span><span class="num"><b>${fmt(val(a))}</b><small>${Math.round((val(a) / (me.total || 1)) * 100)}%</small></span></div>`).join("")}</div>
    <h2>Age profile</h2><div class="ages">${ageBuckets.map((b) => `<div><div class="k">${b.k}</div><div class="bar"><i style="width:${((b.v / (me.players || 1)) * 100).toFixed(1)}%"></i></div><div class="s">${b.n} player${b.n === 1 ? "" : "s"} · ${Math.round((b.v / (me.players || 1)) * 100)}% of player value</div></div>`).join("")}</div>
    ${needsHtml(t, d)}
    <h2>Trade history</h2>${myTrades ? `<div class="trs">${myTrades}</div>` : `<p class="dim small">No trades on record for ${esc(t.name)}.</p>`}
    <p class="note">Ranks are against the other ${n - 1} teams on ${SRC_NAME[S.src]} values with your Tune settings applied. Trade history is scored at today's values (how each deal has aged), not what the pieces were worth on the day.</p>
  </div>`;
}


// ---------- Tune: the knobs sheet and the chips under the toolbar (needs #tune, #tunen, #tweaks and a global render()) ----------
function drawTweaks() {
  const on = tweaksActive(); const btn = $("#tune"); btn.classList.toggle("on", on.length > 0); $("#tunen").textContent = on.length;
  const T = S.tune, chip = (k) => ({ lean: `Win-now lean ${T.lean}%`, qb: `QB ×${T.qb}`, rb: `RB ×${T.rb}`, wr: `WR ×${T.wr}`, te: `TE ×${T.te}`, pick: `Picks ×${T.pick}`, age: `Age −${T.age}%/yr`, star: `Star premium +${T.star}%`, injury: `Injured −${T.injury}%` }[k]);
  $("#tweaks").innerHTML = on.map((k) => `<span>${esc(chip(k))}</span>`).join("");
}
function tuneSheet() {
  const T = { ...S.tune };
  const knob = (k, label, hint, min, max, step, fmtv) => `<div class="knob"><div class="l">${label}<small>${hint}</small></div><div class="v" data-v="${k}">${fmtv(T[k])}</div><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${T[k]}"></div>`;
  const sheet = el(`<div><div class="sheet-bg" id="tbg"></div><div class="sheet" role="dialog" aria-label="Tune the calculator"><div class="in"><div class="sh"><h2>Tune the calculator</h2><button type="button" class="dclose" id="tclose" aria-label="Close">✕</button></div>
    <p class="dim small">Start from a preset or drag the knobs. Everything here changes the numbers across the calculator, the verdict and the suggested trades. Your settings stick on this phone.</p>
    <div class="presets" id="presets">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" data-p="${k}">${p.label}</button>`).join("")}</div>
    ${knob("lean", "Win-now lean", "Mix FantasyCalc's redraft (this-season) value into dynasty value", 0, 100, 5, (v) => `${v}%`)}
    <div class="knob"><div class="l">Position premiums<small>Multiply every player at a position. Superflex leagues often run QB 1.1–1.3</small></div><div class="v"></div><div class="row4">${["qb", "rb", "wr", "te"].map((k) => `<label>${k.toUpperCase()}<input type="number" data-k="${k}" min="0.5" max="2" step="0.05" value="${T[k]}"></label>`).join("")}</div></div>
    ${knob("pick", "Pick premium", "Multiply every rookie pick. Above 1 if your league overpays for picks", 0.5, 1.6, 0.05, (v) => `×${v}`)}
    ${knob("age", "Age discount", "Per year past the cliff (RB 26, WR/TE 28, QB 32)", 0, 15, 1, (v) => `−${v}%/yr`)}
    ${knob("star", "Star premium", "Consolidation bonus: the best assets get up to this much extra, so 2-for-1s stop looking like a steal", 0, 30, 1, (v) => `+${v}%`)}
    ${knob("injury", "Injury discount", "Players carrying an injury tag on Dynasty Daddy", 0, 50, 5, (v) => `−${v}%`)}
    ${S.data.settings.faab_budget ? knob("faab", "FAAB dollar", "Value of one FAAB dollar when it's part of a deal ($${S.data.settings.faab_budget} budget)", 2, 40, 1, (v) => `${v} / $1`) : ""}
    <div class="acts"><button type="button" class="btn" id="treset">Reset</button><button type="button" class="btn primary" id="tapply">Apply</button></div></div></div></div>`);
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  const sync = () => { sheet.querySelectorAll("input[data-k]").forEach((inp) => { inp.value = T[inp.dataset.k]; }); sheet.querySelectorAll("[data-v]").forEach((x) => { const k = x.dataset.v, fv = { lean: (v) => `${v}%`, pick: (v) => `×${v}`, age: (v) => `−${v}%/yr`, star: (v) => `+${v}%`, injury: (v) => `−${v}%`, faab: (v) => `${v} / $1` }[k]; x.textContent = fv ? fv(T[k]) : T[k]; }); const match = Object.entries(PRESETS).find(([, p]) => Object.keys(TUNE_DEFAULT).every((k) => k === "faab" || String(T[k]) === String(k in p.t ? p.t[k] : TUNE_DEFAULT[k]))); sheet.querySelectorAll("#presets button").forEach((b) => b.setAttribute("aria-pressed", String(!!match && match[0] === b.dataset.p))); };
  sheet.querySelectorAll("input[data-k]").forEach((inp) => inp.addEventListener("input", () => { T[inp.dataset.k] = Number(inp.value); sync(); }));
  sheet.querySelectorAll("#presets button").forEach((b) => b.onclick = () => { Object.assign(T, { ...TUNE_DEFAULT, faab: T.faab }, PRESETS[b.dataset.p].t); sync(); });
  $("#treset", sheet).onclick = () => { Object.assign(T, TUNE_DEFAULT); sync(); };
  $("#tapply", sheet).onclick = () => { S.tune = { ...T }; store.set("tune", JSON.stringify(S.tune)); recompute(S.data); close(); render(); };
  $("#tclose", sheet).onclick = close; $("#tbg", sheet).onclick = close;
  sync();
}
