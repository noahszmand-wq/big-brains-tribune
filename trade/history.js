// Big Brains Tribune history engine: everything built on the league's game, move and draft history (the `shame` action of
// tribune-values). Plain script; expects core.js loaded first and a global S = { data, src, tune, hist }.

// ---------- loading ----------
// Fetches the history once per page, merges every player it mentions into the value engine, and caches it on S.hist.
async function loadHistory() {
  if (S.hist) return S.hist;
  const d = S.data, h = await api({ action: "shame" });
  for (const [id, p] of Object.entries(h.players || {})) if (!d.assets[id]) d.assets[id] = { id, kind: "player", name: p.n, pos: p.p, team: p.t, age: p.a, fc: p.fc || 0, dd: p.dd || 0, ddn: Math.round((p.dd || 0) * d.scale), rank: 0, posRank: 0, ddPosRank: 0, trend: 0, x: {} };
  recompute(d);
  S.hist = h; return h;
}
const hTeam = (rid) => S.data.byRid[rid] || { rid, name: `Team ${rid}`, k: `T${rid}`, c: "--t1" };
const hAsset = (id) => S.data.assets[id] || { id, kind: "player", name: "an unknown player", pos: "?", team: null, age: null, fc: 0, dd: 0, v: { fc: 0, dd: 0, both: 0 } };

// ---------- all-play, luck, power ----------
// All-play: each week, a team's score is ranked against every other score that week; wins = teams it outscored.
function allPlay(games, season) {
  const g = season ? games.filter((x) => x.season === season) : games;
  const byWeek = {}; for (const x of g) (byWeek[`${x.season}:${x.week}`] ??= []).push(x);
  const out = {};
  for (const list of Object.values(byWeek)) for (const x of list) { const o = (out[x.rid] ??= { w: 0, l: 0, t: 0, g: 0, pts: 0, wins: 0, losses: 0 }); for (const y of list) { if (y.rid === x.rid) continue; if (x.pts > y.pts) o.w++; else if (x.pts < y.pts) o.l++; else o.t++; } o.g++; o.pts += x.pts; if (x.pts > x.oppPts) o.wins++; else if (x.pts < x.oppPts) o.losses++; }
  for (const o of Object.values(out)) { o.pct = o.w + o.l + o.t ? (o.w + 0.5 * o.t) / (o.w + o.l + o.t) : 0; o.expWins = o.pct * o.g; o.luck = o.wins - o.expWins; o.ppg = o.g ? o.pts / o.g : 0; }
  return out;
}
// Power index 0–100: 40% all-play percentage, 25% points per game, 20% roster value (lineup), 15% last three weeks.
function powerIndex(d, H) {
  const season = d.settings.season, ap = allPlay(H.games, season), tt = teamTotals(d);
  const z = (vals) => { const m = vals.reduce((s, v) => s + v, 0) / (vals.length || 1), sd = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / (vals.length || 1)) || 1; return (v) => (v - m) / sd; };
  const rows = d.teams.map((t) => { const a = ap[t.rid] || { pct: 0, ppg: 0, luck: 0, g: 0, wins: 0, losses: 0, expWins: 0 }; const recent = H.games.filter((g) => g.season === season && g.rid === t.rid).sort((x, y) => y.week - x.week).slice(0, 3); return { t, pct: a.pct, ppg: a.ppg, luck: a.luck, g: a.g, wins: a.wins, losses: a.losses, expWins: a.expWins, lineup: tt[t.rid].starters, form: recent.length ? recent.reduce((s, g) => s + g.pts, 0) / recent.length : 0 }; });
  const zp = z(rows.map((r) => r.pct)), zg = z(rows.map((r) => r.ppg)), zl = z(rows.map((r) => r.lineup)), zf = z(rows.map((r) => r.form));
  for (const r of rows) { r.score = 0.4 * zp(r.pct) + 0.25 * zg(r.ppg) + 0.2 * zl(r.lineup) + 0.15 * zf(r.form); }
  const zs = z(rows.map((r) => r.score));
  for (const r of rows) r.power = Math.max(1, Math.min(99, Math.round(50 + 15 * zs(r.score))));
  rows.sort((a, b) => b.power - a.power).forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// ---------- playoff odds (Monte Carlo) ----------
// Each team scores from a normal fit to this season's games (last season's shrink the fit early on). The rest of the regular
// season is simulated from the real schedule, seeds by record then points, then a standard reseeded bracket with byes.
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(rnd) { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function playoffOdds(d, H, iters = 4000) {
  const season = d.settings.season, st = H.settings || {}, nPlay = st.playoff_teams || Math.ceil(d.teams.length / 2), rnd = mulberry(20260101 + iters);
  const cur = H.games.filter((g) => g.season === season), prev = H.games.filter((g) => g.season === season - 1);
  const fit = (rid) => { const a = cur.filter((g) => g.rid === rid).map((g) => g.pts), b = prev.filter((g) => g.rid === rid).map((g) => g.pts); const leagueAll = cur.map((g) => g.pts); const lm = leagueAll.reduce((s, v) => s + v, 0) / (leagueAll.length || 1); const k = 4; // prior weight in games
    const prior = b.length ? b.reduce((s, v) => s + v, 0) / b.length : lm; const mean = (a.reduce((s, v) => s + v, 0) + prior * k) / (a.length + k);
    const allVar = leagueAll.length > 1 ? leagueAll.reduce((s, v) => s + (v - lm) ** 2, 0) / (leagueAll.length - 1) : 400; const sd = Math.sqrt(a.length > 3 ? (a.reduce((s, v) => s + (v - mean) ** 2, 0) + allVar * 3) / (a.length + 2) : allVar); return { mean, sd: Math.max(8, sd) }; };
  const F = Object.fromEntries(d.teams.map((t) => [t.rid, fit(t.rid)]));
  const base = Object.fromEntries(d.teams.map((t) => [t.rid, { w: t.wins, l: t.losses, pf: t.pf }]));
  const sched = (H.schedule || []).filter((g) => d.byRid[g.a] && d.byRid[g.b]);
  const tally = Object.fromEntries(d.teams.map((t) => [t.rid, { playoffs: 0, bye: 0, title: 0, top: 0, wins: 0, seedSum: 0 }]));
  const byes = Math.max(0, (1 << Math.ceil(Math.log2(nPlay))) - nPlay);
  for (let it = 0; it < iters; it++) {
    const R = Object.fromEntries(d.teams.map((t) => [t.rid, { ...base[t.rid] }]));
    for (const g of sched) { const a = F[g.a].mean + F[g.a].sd * gauss(rnd), b = F[g.b].mean + F[g.b].sd * gauss(rnd); R[g.a].pf += a; R[g.b].pf += b; if (a >= b) { R[g.a].w++; R[g.b].l++; } else { R[g.b].w++; R[g.a].l++; } }
    const seeds = [...d.teams].sort((x, y) => (R[y.rid].w - R[x.rid].w) || (R[y.rid].pf - R[x.rid].pf)).map((t) => t.rid);
    seeds.forEach((rid, i) => { tally[rid].seedSum += i + 1; tally[rid].wins += R[rid].w; if (i === 0) tally[rid].top++; if (i < nPlay) tally[rid].playoffs++; if (i < byes) tally[rid].bye++; });
    // bracket: byes sit out round one; every round pairs best remaining seed with worst remaining seed
    let alive = seeds.slice(0, nPlay);
    const play = (a, b) => (F[a].mean + F[a].sd * gauss(rnd) >= F[b].mean + F[b].sd * gauss(rnd) ? a : b);
    let first = true;
    while (alive.length > 1) {
      const resting = first ? alive.slice(0, byes) : [], field = first ? alive.slice(byes) : alive; first = false;
      const winners = []; for (let i = 0; i < Math.floor(field.length / 2); i++) winners.push(play(field[i], field[field.length - 1 - i])); if (field.length % 2) winners.push(field[Math.floor(field.length / 2)]);
      alive = [...resting, ...winners].sort((x, y) => seeds.indexOf(x) - seeds.indexOf(y));
    }
    if (alive[0]) tally[alive[0]].title++;
  }
  return d.teams.map((t) => ({ t, playoffs: tally[t.rid].playoffs / iters, bye: tally[t.rid].bye / iters, title: tally[t.rid].title / iters, top: tally[t.rid].top / iters, projWins: tally[t.rid].wins / iters, avgSeed: tally[t.rid].seedSum / iters, mean: F[t.rid].mean, sd: F[t.rid].sd, left: sched.filter((g) => g.a === t.rid || g.b === t.rid).length })).sort((a, b) => b.playoffs - a.playoffs || b.title - a.title);
}

// ---------- lineup autopsy ----------
function autopsy(d, H, season) {
  const g = H.games.filter((x) => x.season === season && x.opt != null);
  const per = {}; for (const x of g) { const p = (per[x.rid] ??= { rid: x.rid, g: 0, pts: 0, opt: 0, left: 0, flips: 0, worst: null }); const left = Math.max(0, x.opt - x.pts); p.g++; p.pts += x.pts; p.opt += x.opt; p.left += left; if (x.pts < x.oppPts && x.opt > x.oppPts) p.flips++; if (x.miss && (!p.worst || x.miss.inPts - x.miss.outPts > p.worst.miss.inPts - p.worst.miss.outPts)) p.worst = x; }
  const rows = Object.values(per).map((p) => ({ ...p, t: hTeam(p.rid), eff: p.opt ? p.pts / p.opt : 1, perGame: p.g ? p.left / p.g : 0 })).sort((a, b) => a.left - b.left);
  const misses = g.filter((x) => x.miss).map((x) => ({ ...x, gain: x.miss.inPts - x.miss.outPts, flipped: x.pts < x.oppPts && x.pts + (x.miss.inPts - x.miss.outPts) > x.oppPts })).sort((a, b) => b.gain - a.gain);
  return { rows, misses };
}

// ---------- hall of fame, rivalries, draft grades ----------
function rivalries(d, H) {
  const pairs = {};
  const key = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  for (const g of H.games) { if (g.rid > g.opp) continue; const k = key(g.rid, g.opp), p = (pairs[k] ??= { a: Math.min(g.rid, g.opp), b: Math.max(g.rid, g.opp), games: [], wa: 0, wb: 0, t: 0, trades: 0 }); const aIsRid = g.rid === p.a; const aPts = aIsRid ? g.pts : g.oppPts, bPts = aIsRid ? g.oppPts : g.pts; p.games.push({ season: g.season, week: g.week, aPts, bPts }); if (aPts > bPts) p.wa++; else if (bPts > aPts) p.wb++; else p.t++; }
  for (const t of realTrades(d)) for (const a of t.rids) for (const b of t.rids) if (a < b) { const p = pairs[key(a, b)]; if (p) p.trades++; }
  for (const p of Object.values(pairs)) {
    p.games.sort((x, y) => x.season - y.season || x.week - y.week);
    let streakWho = null, streak = 0; for (const g of p.games) { const w = g.aPts > g.bPts ? p.a : g.bPts > g.aPts ? p.b : null; if (w && w === streakWho) streak++; else { streakWho = w; streak = w ? 1 : 0; } }
    p.streak = { rid: streakWho, n: streak };
    p.margin = p.games.length ? p.games.reduce((s, g) => s + (g.aPts - g.bPts), 0) / p.games.length : 0;
    p.closest = [...p.games].sort((x, y) => Math.abs(x.aPts - x.bPts) - Math.abs(y.aPts - y.bPts))[0] || null;
    p.biggest = [...p.games].sort((x, y) => Math.abs(y.aPts - y.bPts) - Math.abs(x.aPts - x.bPts))[0] || null;
    p.heat = p.games.length + 2 * p.trades + (Math.abs(p.wa - p.wb) <= 1 ? 2 : 0);
  }
  return Object.values(pairs).sort((x, y) => y.heat - x.heat);
}
// Draft grades: within each draft, the pick's value rank against where it was taken. +N means it has outperformed its slot by N places.
function draftGrades(d, H) {
  const classes = {};
  for (const p of H.draft) (classes[`${p.season}:${p.type}`] ??= { season: p.season, type: p.type, picks: [] }).picks.push({ ...p, v: val(hAsset(p.pid)), a: hAsset(p.pid) });
  for (const c of Object.values(classes)) {
    c.picks.sort((x, y) => x.pick - y.pick); c.perRound = c.picks.filter((p) => p.round === 1).length || d.teams.length;
    const byValue = [...c.picks].sort((x, y) => y.v - x.v); byValue.forEach((p, i) => { p.vRank = i + 1; });
    for (const p of c.picks) { p.slotRank = p.pick; p.delta = p.slotRank - p.vRank; p.inRound = p.pick - (p.round - 1) * c.perRound; p.label = `${p.round}.${String(p.inRound).padStart(2, "0")}`; }
    const grade = (delta, n) => { const r = delta / n; return r >= 0.3 ? "A" : r >= 0.12 ? "B" : r >= -0.12 ? "C" : r >= -0.3 ? "D" : "F"; };
    for (const p of c.picks) p.grade = grade(p.delta, c.picks.length);
    c.teams = d.teams.map((t) => { const mine = c.picks.filter((p) => p.rid === t.rid); const v = mine.reduce((s, p) => s + p.v, 0), delta = mine.reduce((s, p) => s + p.delta, 0); return { t, n: mine.length, v, delta, avgDelta: mine.length ? delta / mine.length : 0, grade: mine.length ? grade(delta / mine.length, c.picks.length) : "–", best: [...mine].sort((x, y) => y.delta - x.delta)[0] || null, worst: [...mine].sort((x, y) => x.delta - y.delta)[0] || null }; }).filter((x) => x.n).sort((x, y) => y.avgDelta - x.avgDelta);
  }
  return Object.values(classes).sort((x, y) => y.season - x.season || (x.type === "rookie" ? -1 : 1));
}
const gradeClass = (g) => ({ A: "gA", B: "gB", C: "gC", D: "gD", F: "gF" }[g] || "");
