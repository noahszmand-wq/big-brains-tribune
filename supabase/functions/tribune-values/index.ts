// Big Brains Tribune trade values. League-word-gated endpoint behind the trade calculator: FantasyCalc and Dynasty Daddy
// dynasty values (superflex, PPR) keyed by Sleeper id, the league's rosters with names, future rookie picks with their current
// owners, and the lineup slots. Everything is cached in tribune.cache so the value sites and Sleeper are hit a few times an
// hour at most, and the 5 MB Sleeper player file once a day.
//
// Action: POST {word} -> {ok, settings, teams, players, picks, sources, values_at}
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
class Fail extends Error { constructor(public code: string, public status = 400) { super(code); } }
const SLEEPER = "https://api.sleeper.app/v1";
const FC = "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=10&ppr=1";
const DD = "https://dynasty-daddy.com/api/v1/player/all/today";
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

// Badge codes and colours the paper has used since Issue No. 1 (same table as the publisher).
const KNOWN: Record<string, [string, string]> = {
  "Bishop Sycamore HS": ["BSHS", "--t8"], "Lamarsexuals": ["LS", "--t2"], "Horsecock Gallager": ["HCG", "--t5"], "Moose is Loose": ["MIL", "--t9"],
  "Beefy Slow Burn #BigUce": ["BSB", "--t3"], "SilentCountPoota": ["SCP", "--t10"], "John baptiste": ["JB", "--t7"], "Coachstradomus #DarkTimes": ["CSD", "--t1"],
  "JUD Corp": ["JUD", "--t4"], "Wausington For Sale Team": ["WFST", "--t6"],
};

// ---------- cache: memory first, then tribune.cache, then the network ----------
const MEM: Record<string, { at: number; v: any }> = {};
// `accept` can force an early refresh (a rostered player missing from the player file), but never more than once per 10 minutes.
async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>, accept: (v: T) => boolean = () => true): Promise<{ v: T; at: number }> {
  const fresh = (at: number, v: T) => Date.now() - at < ttlMs && (Date.now() - at < 600_000 || accept(v));
  const m = MEM[key];
  if (m && fresh(m.at, m.v)) return { v: m.v, at: m.at };
  try {
    const r = await sql`select value, extract(epoch from updated_at) * 1000 as at from tribune.cache where key = ${key}`;
    if (r[0] && fresh(Number(r[0].at), r[0].value)) { MEM[key] = { at: Number(r[0].at), v: r[0].value }; return { v: r[0].value, at: Number(r[0].at) }; }
  } catch (e) { console.error("cache read", key, String(e).slice(0, 120)); }
  let v: T;
  try { v = await fetcher(); } catch (e) {
    // Network down: serve whatever is stored, however old, rather than nothing.
    console.error("fetch", key, String(e).slice(0, 160));
    if (m) return { v: m.v, at: m.at };
    const r = await sql`select value, extract(epoch from updated_at) * 1000 as at from tribune.cache where key = ${key}`;
    if (r[0]) return { v: r[0].value, at: Number(r[0].at) };
    throw e;
  }
  MEM[key] = { at: Date.now(), v };
  try { await sql`insert into tribune.cache (key, value, updated_at) values (${key}, ${sql.json(v as any)}, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`; } catch (e) { console.error("cache write", key, String(e).slice(0, 120)); }
  return { v, at: Date.now() };
}
async function get(url: string, timeout = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { "User-Agent": "bbt-trade-calc" } });
  if (!r.ok) throw new Fail("upstream_" + r.status, 502);
  return r.json();
}

// ---------- the pieces ----------
type Extra = { nameId?: string; redraft?: number; tradeFreq?: number; rosterPct?: number; lastMonth?: number; m3Low?: number; m3High?: number; atHigh?: number; atLow?: number; lastMonthRank?: number; pctOwned?: number; pctStarted?: number; injury?: string | null };
type Val = { name: string; pos: string; team: string | null; age: number | null; value: number; rank: number; posRank: number; trend: number; x?: Extra };
async function values(): Promise<Record<string, Val>> {
  const rows: any[] = await get(FC, 20000);
  const out: Record<string, Val> = {};
  for (const r of rows) {
    const p = r.player ?? {};
    const key = p.position === "PICK" ? `pick:${p.name}` : p.sleeperId ? String(p.sleeperId) : null;
    if (!key) continue;
    out[key] = { name: p.name, pos: p.position, team: p.maybeTeam ?? null, age: p.maybeAge ?? null, value: Number(r.value) || 0, rank: Number(r.overallRank) || 0, posRank: Number(r.positionRank) || 0, trend: Number(r.trend30Day) || 0,
      x: { redraft: Number(r.redraftValue) || 0, tradeFreq: Number(r.maybeTradeFrequency) || 0, rosterPct: Number(r.maybeRosterPercent) || 0 } };
  }
  if (Object.keys(out).length < 100) throw new Fail("values_thin", 502);
  return out;
}

// Dynasty Daddy: one row per player (and per pick, position "PI", name_id like 2027early1stpi); sf_trade_value is the superflex number.
async function ddValues(): Promise<Record<string, Val>> {
  const rows: any[] = await get(DD, 30000);
  const out: Record<string, Val> = {};
  for (const r of rows) {
    const v = Number(r.sf_trade_value) || 0;
    if (r.position === "PI") {
      const m = /^(\d{4})(early|mid|late)(\d)(st|nd|rd|th)pi$/.exec(String(r.name_id ?? ""));
      if (!m || !v) continue;
      const tier = m[2][0].toUpperCase() + m[2].slice(1);
      out[`pick:${m[1]} ${m[3]}${m[4]} (${tier})`] = { name: r.full_name, pos: "PICK", team: null, age: null, value: v, rank: 0, posRank: 0, trend: v - (Number(r.last_month_value_sf) || v) };
      continue;
    }
    if (!r.sleeper_id) continue;
    out[String(r.sleeper_id)] = { name: r.full_name, pos: r.position, team: r.team ?? null, age: r.age ?? null, value: v, rank: 0, posRank: Number(r.sf_position_rank) || 0, trend: v - (Number(r.last_month_value_sf) || v),
      x: { nameId: String(r.name_id ?? ""), lastMonth: Number(r.last_month_value_sf) || 0, m3Low: Number(r.three_month_low_sf) || 0, m3High: Number(r.three_month_high_sf) || 0, atHigh: Number(r.all_time_high_sf) || 0, atLow: Number(r.all_time_low_sf) || 0, lastMonthRank: Number(r.last_month_rank_sf) || 0, pctOwned: Number(r.percent_owned) || 0, pctStarted: Number(r.percent_started) || 0, injury: r.injury_status ?? null } };
  }
  if (Object.keys(out).length < 100) throw new Fail("dd_thin", 502);
  // Overall rank from the superflex value, since the feed only carries position ranks.
  Object.values(out).filter((x) => x.pos !== "PICK").sort((a, b) => b.value - a.value).forEach((x, i) => { x.rank = i + 1; });
  return out;
}

type Team = { rid: number; name: string; k: string; c: string; wins: number; losses: number; ties: number; pf: number; seed: number; players: string[]; faab: number };
type LeagueBits = { season: number; slots: string[]; rounds: number; teams: Team[]; traded: any[]; seasons: number[]; faab_budget: number };
async function league(leagueId: string): Promise<LeagueBits> {
  const [lg, users, rosters, traded, drafts] = await Promise.all([get(`${SLEEPER}/league/${leagueId}`), get(`${SLEEPER}/league/${leagueId}/users`), get(`${SLEEPER}/league/${leagueId}/rosters`), get(`${SLEEPER}/league/${leagueId}/traded_picks`).catch(() => []), get(`${SLEEPER}/league/${leagueId}/drafts`).catch(() => [])]);
  const teams: Team[] = rosters.map((r: any, i: number) => {
    const u = users.find((u: any) => u.user_id === r.owner_id);
    const name = String(u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`).trim();
    const known = KNOWN[name];
    const k = known?.[0] ?? (name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w: string) => w[0]).join("").toUpperCase().slice(0, 4) || `T${r.roster_id}`);
    const s = r.settings ?? {};
    return { rid: r.roster_id, name, k, c: known?.[1] ?? `--t${(i % 10) + 1}`, wins: s.wins ?? 0, losses: s.losses ?? 0, ties: s.ties ?? 0, pf: (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100, seed: 0, players: (r.players ?? []).map(String), faab: Math.max(0, (Number(lg.settings?.waiver_budget) || 0) - (Number(s.waiver_budget_used) || 0)) };
  });
  teams.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || (b.pf - a.pf)).forEach((t, i) => { t.seed = i + 1; });
  const season = Number(lg.season) || new Date().getFullYear();
  const rounds = Math.max(1, Number(drafts?.[0]?.settings?.rounds ?? 3) || 3);
  const seasons = [...new Set([season + 1, season + 2, ...traded.map((t: any) => Number(t.season)).filter((s: number) => s > season)])].sort();
  // FAAB only means anything when the league runs blind-bid waivers (Sleeper waiver_type 2).
  const faab_budget = Number(lg.settings?.waiver_type) === 2 ? Number(lg.settings?.waiver_budget) || 0 : 0;
  return { season, slots: (lg.roster_positions ?? []).filter((s: string) => s !== "BN" && s !== "IR" && s !== "TAXI"), rounds, teams, traded, seasons, faab_budget };
}

type PlayerMeta = { name: string; pos: string; team: string | null; age: number | null };
async function playerFile(): Promise<Record<string, PlayerMeta>> {
  const all = await get(`${SLEEPER}/players/nfl`, 40000);
  const out: Record<string, PlayerMeta> = {};
  for (const [id, p] of Object.entries<any>(all)) {
    if (!p || !p.position || !["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.position)) continue;
    if (p.position !== "DEF" && !p.active && p.status !== "Active" && !p.team) continue; // keep the file small: active or signed only
    out[id] = { name: p.full_name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || id, pos: p.position, team: p.team ?? null, age: p.age ?? null };
  }
  return out;
}

// Every completed trade, this season and up to two seasons back (Sleeper keeps a previous_league_id chain for dynasty leagues).
type Trade = { season: number; week: number; at: number; rids: number[]; adds: Record<string, number>; drops: Record<string, number>; picks: { season: number; round: number; owner: number; prev: number; orig: number }[] };
async function tradeLog(leagueId: string, upToWeek: number): Promise<Trade[]> {
  const out: Trade[] = [];
  let id = leagueId, hops = 0;
  while (id && hops < 3) {
    const lg = await get(`${SLEEPER}/league/${id}`).catch(() => null); if (!lg) break;
    const season = Number(lg.season) || 0, last = hops === 0 ? Math.min(18, Math.max(1, upToWeek)) : 18;
    const weeks = Array.from({ length: last }, (_, i) => i + 1);
    const all = await Promise.all(weeks.map((w) => get(`${SLEEPER}/league/${id}/transactions/${w}`).catch(() => [])));
    all.forEach((list: any[], i) => { for (const t of list ?? []) if (t.type === "trade" && t.status === "complete") out.push({ season, week: weeks[i], at: Number(t.status_updated ?? t.created) || 0, rids: (t.roster_ids ?? []).map(Number), adds: Object.fromEntries(Object.entries(t.adds ?? {}).map(([k, v]) => [String(k), Number(v)])), drops: Object.fromEntries(Object.entries(t.drops ?? {}).map(([k, v]) => [String(k), Number(v)])), picks: (t.draft_picks ?? []).map((p: any) => ({ season: Number(p.season), round: Number(p.round), owner: Number(p.owner_id), prev: Number(p.previous_owner_id), orig: Number(p.roster_id) })) }); });
    id = lg.previous_league_id ? String(lg.previous_league_id) : ""; hops++;
  }
  return out.sort((a, b) => b.at - a.at);
}
// Dynasty Daddy's 30-day daily history for one player (their value and FantasyCalc's, as they record it).
async function ddHistory(nameId: string): Promise<{ d: string; dd: number; fc: number }[]> {
  const j = await get(`${DD.replace("/all/today", "")}/${encodeURIComponent(nameId)}/history`, 20000);
  return (j?.history ?? []).map((h: any) => ({ d: String(h.date).slice(0, 10), dd: Number(h.sf_trade_value) || 0, fc: Number(h.fc_sf_trade_value) || 0 })).filter((h: any) => h.dd || h.fc);
}
// One row per asset per day, so the paper builds its own long-run history (the public feeds only carry 30 days).
async function snapshot(rows: { key: string; fc: number; dd: number }[]) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const today = (await sql`select count(*)::int as n from tribune.value_history where day = ${day}`)[0]?.n ?? 0;
    if (today > 0 || !rows.length) return;
    await sql`insert into tribune.value_history ${sql(rows.map((r) => ({ day, key: r.key, fc: Math.round(r.fc), dd: Math.round(r.dd) })), "day", "key", "fc", "dd")} on conflict do nothing`;
  } catch (e) { console.error("snapshot", String(e).slice(0, 160)); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const S = Object.fromEntries((await sql`select key, value from tribune.settings`).map((r) => [r.key, r.value]));
    if (norm(b.word) !== norm(S.league_word)) throw new Fail("wrong_word", 401);

    const [V, D, L] = await Promise.all([cached("fc_values", 3600_000, values), cached("dd_values", 3600_000, ddValues).catch(() => null), cached("sleeper_league", 600_000, () => league(S.league_id))]);
    const DDv: Record<string, Val> = D?.v ?? {};

    // history {ids}: daily points per asset, Dynasty Daddy's last 30 days merged with the paper's own snapshots (up to 6 months).
    if (String(b.action ?? "") === "history") {
      const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 12) : [];
      const out: Record<string, { d: string; dd: number; fc: number }[]> = {};
      const own = ids.length ? await sql`select key, to_char(day, 'YYYY-MM-DD') as d, fc, dd from tribune.value_history where key = any(${ids}) and day >= current_date - 183 order by day` : [];
      await Promise.all(ids.map(async (id) => {
        const pts: Record<string, { d: string; dd: number; fc: number }> = {};
        for (const r of own) if (r.key === id) pts[r.d] = { d: r.d, dd: Number(r.dd), fc: Number(r.fc) };
        const nameId = DDv[id]?.x?.nameId;
        if (nameId) { try { const h = (await cached(`ddh:${nameId}`, 43200_000, () => ddHistory(nameId))).v; for (const p of h) pts[p.d] = { d: p.d, dd: p.dd || pts[p.d]?.dd || 0, fc: p.fc || pts[p.d]?.fc || 0 }; } catch (e) { console.error("ddh", nameId, String(e).slice(0, 100)); } }
        out[id] = Object.values(pts).sort((a, b) => a.d.localeCompare(b.d));
      }));
      const since = (await sql`select to_char(min(day), 'Mon FMDD, YYYY') as s from tribune.value_history`)[0]?.s ?? null;
      return json({ ok: true, history: out, own_since: since });
    }
    const T = await cached("sleeper_trades", 6 * 3600_000, () => tradeLog(S.league_id, Number(S.current_week) || 18)).catch(() => ({ v: [] as Trade[], at: Date.now() }));
    // Values for every rostered player, plus anyone who has been traded (so old deals can be scored at today's prices).
    const rostered = new Set([...L.v.teams.flatMap((t) => t.players), ...T.v.flatMap((t) => Object.keys(t.adds))]);
    // The player file is a day old at most, and refreshed early if a newly rostered id is missing from it.
    const nowIds = L.v.teams.flatMap((t) => t.players);
    const P = await cached("sleeper_players", 86400_000, playerFile, (m) => nowIds.every((id) => m[id] || V.v[id]));

    type Src = { value: number; rank: number; posRank: number; trend: number };
    const src = (v: Val | undefined): Src => ({ value: v?.value ?? 0, rank: v?.rank ?? 0, posRank: v?.posRank ?? 0, trend: v?.trend ?? 0 });
    const players: Record<string, PlayerMeta & { fc: Src; dd: Src; x: Extra }> = {};
    for (const id of rostered) {
      const v = V.v[id], d = DDv[id], m = P.v[id];
      if (!v && !d && !m) continue;
      const { nameId: _n, ...dx } = (d?.x ?? {}) as Extra;
      players[id] = { name: v?.name ?? d?.name ?? m!.name, pos: v?.pos ?? d?.pos ?? m!.pos, team: v?.team ?? d?.team ?? m?.team ?? null, age: v?.age ?? d?.age ?? m?.age ?? null, fc: src(v), dd: src(d), x: { ...(v?.x ?? {}), ...dx } };
    }

    // Picks: every team's own picks for the coming seasons, re-homed by Sleeper's traded_picks (last trade wins).
    const n = L.v.teams.length;
    const tier = (origSeed: number) => origSeed > n - Math.ceil(n * 0.3) ? "Early" : origSeed <= Math.ceil(n * 0.3) ? "Late" : "Mid";
    const bySeed: Record<number, Team> = Object.fromEntries(L.v.teams.map((t) => [t.rid, t]));
    const picks: { id: string; season: number; round: number; orig: number; owner: number; label: string; fc: number; dd: number }[] = [];
    for (const season of L.v.seasons) for (let round = 1; round <= L.v.rounds; round++) for (const t of L.v.teams) {
      const tr = L.v.traded.filter((x: any) => Number(x.season) === season && x.round === round && x.roster_id === t.rid);
      // Follow the chain of trades: the current owner is the one nobody has traded it on from.
      const prevs = new Set(tr.map((x: any) => Number(x.previous_owner_id)));
      const ends = tr.map((x: any) => Number(x.owner_id)).filter((o: number) => !prevs.has(o));
      const owner = ends.length ? ends[ends.length - 1] : tr.length ? Number(tr[tr.length - 1].owner_id) : t.rid;
      const next = season === L.v.seasons[0];
      // Next year's picks are tiered by where the original team sits now; later years are a coin flip, so FantasyCalc's plain
      // number and Dynasty Daddy's "Mid" stand in.
      const tr_ = next ? tier(bySeed[t.rid].seed) : "Mid";
      const fcv = (next ? V.v[`pick:${season} ${ord(round)} (${tr_})`] : null) ?? V.v[`pick:${season} ${ord(round)}`];
      const ddv = DDv[`pick:${season} ${ord(round)} (${tr_})`];
      picks.push({ id: `pick:${season}:${round}:${t.rid}`, season, round, orig: t.rid, owner, label: `${season} ${ord(round)}${next ? ` (${tr_})` : ""}${owner !== t.rid ? ` via ${t.k}` : ""}`, fc: fcv?.value ?? 0, dd: ddv?.value ?? 0 });
    }

    // Today's snapshot (once a day, first request wins), then the payload.
    await snapshot([...nowIds.filter((id) => players[id]).map((id) => ({ key: id, fc: players[id].fc.value, dd: players[id].dd.value })), ...picks.map((p) => ({ key: p.id, fc: p.fc, dd: p.dd }))]);
    const hist = (await sql`select to_char(min(day), 'Mon FMDD, YYYY') as s, count(distinct day)::int as n from tribune.value_history`)[0];

    return json({ ok: true, settings: { dynasty: true, superflex: L.v.slots.includes("SUPER_FLEX"), ppr: 1, slots: L.v.slots, season: L.v.season, faab_budget: L.v.faab_budget ?? 0 },
      teams: L.v.teams.map((t) => ({ ...t, players: t.players.filter((id) => players[id]) })), players, picks, trades: T.v, history_since: hist?.s ?? null, history_days: hist?.n ?? 0,
      sources: { fc: { name: "FantasyCalc", at: new Date(V.at).toISOString(), ok: true }, dd: { name: "Dynasty Daddy", at: D ? new Date(D.at).toISOString() : null, ok: !!D } },
      values_at: new Date(V.at).toISOString(), rosters_at: new Date(L.at).toISOString() });
  } catch (e) {
    if (e instanceof Fail) return json({ ok: false, error: e.code }, e.status);
    console.error(e);
    return json({ ok: false, error: "error" }, 500);
  }
});
