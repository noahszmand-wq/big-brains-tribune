// Big Brains Tribune Contributor Desk API. One keyless endpoint; every call carries the league word.
// Admin calls also carry the admin word. All data lives in the private `tribune` schema.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
class Fail extends Error { constructor(public code: string, public status = 400) { super(code); } }

async function settings(): Promise<Record<string, string>> {
  const rows = await sql`select key, value from tribune.settings`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
const SLEEPER = "https://api.sleeper.app/v1";
async function sleeper(path: string) {
  const r = await fetch(`${SLEEPER}${path}`);
  if (!r.ok) throw new Fail("sleeper_" + r.status, 502);
  return r.json();
}
// NFL records + next opponent from ESPN's public scoreboard (unofficial; any failure just means no line is shown).
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
let NFLC: { at: number; data: any } | null = null;
let NFLERR = "";
const espn = async (week?: number) => {
  try {
    const r = await fetch(week ? `${ESPN}?week=${week}` : ESPN, { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0 (compatible; BBT-desk)", Accept: "application/json" } });
    if (!r.ok) { NFLERR = `espn ${week ?? "cur"} status ${r.status}`; return null; }
    return await r.json();
  } catch (e) { NFLERR = `espn ${week ?? "cur"} ${String(e).slice(0, 150)}`; return null; }
};
const fixAbbr = (a: string) => (a === "WSH" ? "WAS" : a);
async function nflSnapshot() {
  if (NFLC && Date.now() - NFLC.at < 600000) return NFLC.data;
  const cur = await espn();
  if (!cur?.events?.length) { if (!NFLERR) NFLERR = "espn returned no events"; return NFLC?.data ?? null; }
  const wk = cur.week?.number as number | undefined;
  const nxt = wk ? await espn(wk + 1) : null;
  const teams: Record<string, any> = {}; const post = new Set<string>();
  const walk = (sb: any, fn: (me: string, c: any, opp: string, st: string) => void) => {
    for (const ev of sb?.events ?? []) {
      const comp = ev.competitions?.[0]; if (!comp) continue;
      const st = comp.status?.type?.state ?? ev.status?.type?.state ?? "pre";
      for (const c of comp.competitors ?? []) {
        const o = comp.competitors.find((x: any) => x !== c); if (!o) continue;
        fn(fixAbbr(c.team.abbreviation), c, fixAbbr(o.team.abbreviation), st);
      }
    }
  };
  const recOf = (c: any) => c.records?.find((r: any) => r.type === "total")?.summary ?? null;
  walk(cur, (me, c, opp, st) => { teams[me] = { rec: recOf(c), opp, ha: c.homeAway === "home" ? "vs" : "at" }; if (st === "post") post.add(me); });
  walk(nxt, (me, c, opp) => {
    if (!teams[me]) teams[me] = { rec: recOf(c), opp, ha: c.homeAway === "home" ? "vs" : "at" };
    else if (post.has(me)) { teams[me].opp = opp; teams[me].ha = c.homeAway === "home" ? "vs" : "at"; post.delete(me); }
  });
  for (const me of post) { teams[me].opp = null; teams[me].ha = null; } // played, and off next week
  const data = { week: wk ?? null, teams };
  NFLC = { at: Date.now(), data };
  return data;
}
let PLAYERS: Record<string, any> | null = null;
async function allPlayers() { if (!PLAYERS) PLAYERS = await sleeper("/players/nfl"); return PLAYERS!; }
// Walk previous_league_id back from the current league; returns [{season, league_id}] newest first.
async function leagueChain(leagueId: string) {
  const out: { season: string; league_id: string }[] = [];
  let id: string | null = leagueId;
  for (let i = 0; id && i < 15; i++) {
    const L = await sleeper(`/league/${id}`);
    out.push({ season: L.season, league_id: id });
    id = L.previous_league_id;
  }
  return out;
}
// Columnist personalization, validated: short strings only, no markup.
function cleanProfile(p: any) {
  const str = (v: unknown, n: number) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, n);
  const topics = Array.isArray(p?.topics) ? p.topics.map((t: unknown) => str(t, 24)).filter(Boolean).slice(0, 8) : [];
  const emoji = str(p?.emoji, 8);
  return { tagline: str(p?.tagline, 80), topics, emoji: /^\p{Extended_Pictographic}/u.test(emoji) ? [...new Intl.Segmenter().segment(emoji)][0].segment : "", signoff: str(p?.signoff, 60) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  try {
    const b = await req.json().catch(() => { throw new Fail("bad_request"); });
    const S = await settings();
    if (norm(b.word) !== norm(S.league_word)) throw new Fail("wrong_word", 401);
    const admin = !!b.admin_word && norm(b.admin_word) === norm(S.admin_word);
    const season = Number(S.season), week = Number(b.week ?? S.current_week);
    const locked = Date.now() > Date.parse(S.deadline_at);
    const a = String(b.action ?? "");

    if (a === "bootstrap") {
      const sections = await sql`select key, title, kind, sort, roast, active from tribune.sections order by sort`;
      const contributors = await sql`select id, name, team, section_key, active, sort, is_editor, profile from tribune.contributors order by sort, id`;
      const pieces = await sql`select id, contributor_id, section_key, status, updated_at, submitted_at, image_url, edited_by_admin
                               from tribune.pieces where season = ${season} and week = ${week}`;
      // Previous board for the tier builder: newest earlier week's tiers from the same section.
      const prev = await sql`select p.content, p.week from tribune.pieces p join tribune.sections s on s.key = p.section_key
                             where s.kind = 'tiers' and (p.season < ${season} or (p.season = ${season} and p.week < ${week}))
                             order by p.season desc, p.week desc limit 1`;
      const nfl = await nflSnapshot().catch((e) => { NFLERR = "snap " + String(e).slice(0, 150); return null; });
      return json({ ok: true, admin, season, week, locked, deadline_at: S.deadline_at, deadline_label: S.deadline_label, nfl, nfl_err: nfl ? "" : NFLERR,
        sections, contributors, pieces, prev_tiers: prev[0]?.content?.tiers ?? null, prev_extra: prev[0]?.content?.extra ?? null, prev_tiers_week: prev[0]?.week ?? null });
    }
    if (a === "get_piece") {
      const r = await sql`select * from tribune.pieces where season = ${season} and week = ${week} and contributor_id = ${Number(b.contributor_id)}`;
      return json({ ok: true, piece: r[0] ?? null, locked });
    }
    if (a === "save_piece") {
      if (locked && !admin) throw new Fail("locked", 423);
      const cid = Number(b.contributor_id);
      const c = (await sql`select section_key, active from tribune.contributors where id = ${cid}`)[0];
      if (!c || !c.active) throw new Fail("no_contributor", 404);
      const status = b.status === "submitted" ? "submitted" : b.status === "held" && admin ? "held" : "draft";
      const content = typeof b.content === "object" && b.content ? b.content : {};
      delete (content as any).nfl;
      if (Array.isArray((content as any).tiers)) { const snap = await nflSnapshot().catch((e) => { NFLERR = "snap " + String(e).slice(0, 150); return null; }); if (snap) (content as any).nfl = snap; }
      if (JSON.stringify(content).length > 60000) throw new Fail("too_long");
      const r = await sql`insert into tribune.pieces (season, week, contributor_id, section_key, status, content, image_url, submitted_at, edited_by_admin)
        values (${season}, ${week}, ${cid}, ${c.section_key}, ${status}, ${sql.json(content)}, ${b.image_url ?? null},
                ${status === "submitted" ? sql`now()` : null}, ${admin && !!b.as_admin})
        on conflict (season, week, contributor_id) do update set
          status = case when tribune.pieces.status = 'held' and not ${admin} then 'held' else excluded.status end,
          content = excluded.content, image_url = excluded.image_url, updated_at = now(),
          submitted_at = coalesce(excluded.submitted_at, tribune.pieces.submitted_at),
          edited_by_admin = tribune.pieces.edited_by_admin or excluded.edited_by_admin
        returning id, status, updated_at, submitted_at`;
      return json({ ok: true, piece: r[0] });
    }
    if (a === "set_profile") {
      const cid = Number(b.contributor_id);
      const c = (await sql`select id from tribune.contributors where id = ${cid} and active`)[0];
      if (!c) throw new Fail("no_contributor", 404);
      const profile = cleanProfile(b.profile);
      await sql`update tribune.contributors set profile = ${sql.json(profile)} where id = ${cid}`;
      return json({ ok: true, profile });
    }
    if (a === "upload_image") {
      if (locked && !admin) throw new Fail("locked", 423);
      const mime = String(b.mime ?? ""); const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[mime];
      if (!ext) throw new Fail("bad_image");
      const bytes = Uint8Array.from(atob(String(b.data_b64 ?? "")), (ch) => ch.charCodeAt(0));
      if (bytes.length > 1_600_000) throw new Fail("image_too_big");
      const path = `${season}/w${week}/c${Number(b.contributor_id)}-${Date.now()}.${ext}`;
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const up = await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/tribune-images/${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": mime, "x-upsert": "true" }, body: bytes });
      if (!up.ok) { console.error("upload", up.status, await up.text()); throw new Fail("upload_failed", 500); }
      return json({ ok: true, url: `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/tribune-images/${path}` });
    }
    if (a === "seasons") {
      const chain = await leagueChain(S.league_id);
      return json({ ok: true, seasons: chain.map((c) => c.season) });
    }
    if (a === "history") {
      const chain = await leagueChain(S.league_id);
      const L = chain.find((c) => c.season === String(b.season));
      if (!L) throw new Fail("no_season", 404);
      const wk = Number(b.hweek);
      if (!(wk >= 1 && wk <= 18)) throw new Fail("bad_week");
      const [matchups, rosters, users] = await Promise.all([
        sleeper(`/league/${L.league_id}/matchups/${wk}`), sleeper(`/league/${L.league_id}/rosters`), sleeper(`/league/${L.league_id}/users`)]);
      const owner: Record<string, string> = {}, record: Record<string, string> = {};
      for (const r of rosters) {
        const u = users.find((u: { user_id: string }) => u.user_id === r.owner_id);
        owner[r.roster_id] = u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`;
        record[r.roster_id] = `${r.settings?.wins ?? 0}–${r.settings?.losses ?? 0}`;
      }
      // Player names: our players table first, then Sleeper's full map (cached per instance) for anyone retired since.
      const ids = new Set<string>();
      for (const m of matchups) for (const pid of (m.starters ?? [])) if (pid && pid !== "0") ids.add(String(pid));
      const names: Record<string, { name: string; pos: string }> = {};
      if (ids.size) {
        const rows = await sql`select player_id, full_name, position from public.players where player_id = any(${[...ids]})`;
        for (const r of rows) names[r.player_id] = { name: r.full_name, pos: r.position };
      }
      const missing = [...ids].filter((id) => !names[id]);
      if (missing.length) {
        const all = await allPlayers();
        for (const id of missing) { const p = all[id]; if (p) names[id] = { name: p.full_name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || (p.position === "DEF" ? `${id} D/ST` : id), pos: p.position ?? "" }; }
      }
      const nm = (id: string) => names[id] ?? { name: /^[A-Z]{2,3}$/.test(id) ? `${id} D/ST` : "Unknown", pos: names[id]?.pos ?? "" };
      type Side = { team: string; pts: number; record: string; top: { name: string; pos: string; pts: number }[] };
      const byM: Record<string, Side[]> = {};
      const everyone: { name: string; pos: string; pts: number; team: string }[] = [];
      for (const m of matchups) {
        if (m.matchup_id == null) continue;
        const team = owner[m.roster_id] ?? `Team ${m.roster_id}`;
        const starters = (m.starters ?? []).filter((pid: string) => pid && pid !== "0")
          .map((pid: string) => ({ ...nm(String(pid)), pts: Number(m.players_points?.[pid] ?? 0) }))
          .sort((x: { pts: number }, y: { pts: number }) => y.pts - x.pts);
        for (const s of starters) everyone.push({ ...s, team });
        (byM[m.matchup_id] ??= []).push({ team, pts: Number(m.points ?? 0), record: record[m.roster_id] ?? "", top: starters.slice(0, 3) });
      }
      const games = Object.values(byM).filter((g) => g.length === 2).map(([x, y]) => (x.pts >= y.pts ? { w: x, l: y } : { w: y, l: x }))
        .sort((g1, g2) => (g2.w.pts - g2.l.pts) - (g1.w.pts - g1.l.pts));
      if (!games.length) throw new Fail("no_games", 404);
      const sides = games.flatMap((g) => [g.w, g.l]).sort((p, q) => q.pts - p.pts);
      const high = { team: sides[0].team, pts: sides[0].pts }, low = { team: sides[sides.length - 1].team, pts: sides[sides.length - 1].pts };
      const closest = games[games.length - 1], blowout = games[0];
      const extras = {
        top_players: everyone.sort((x, y) => y.pts - x.pts).slice(0, 5),
        low, closest: { w: closest.w.team, l: closest.l.team, margin: +(closest.w.pts - closest.l.pts).toFixed(2) },
        blowout: { w: blowout.w.team, l: blowout.l.team, margin: +(blowout.w.pts - blowout.l.pts).toFixed(2) },
        avg: +(sides.reduce((s, x) => s + x.pts, 0) / sides.length).toFixed(2),
        final_records: Object.fromEntries(Object.keys(owner).map((rid) => [owner[rid], record[rid]])),
      };
      return json({ ok: true, card: { season: L.season, week: wk, games, high, extras } });
    }

    // Admin only below.
    if (!admin) throw new Fail("not_admin", 403);
    if (a === "board") {
      const rows = await sql`select c.id as contributor_id, c.name, c.team, c.section_key, s.title, s.kind, c.active, c.is_editor,
          p.id as piece_id, p.status, p.updated_at, p.submitted_at, p.image_url, p.edited_by_admin
        from tribune.contributors c join tribune.sections s on s.key = c.section_key
        left join tribune.pieces p on p.contributor_id = c.id and p.season = ${season} and p.week = ${week}
        order by c.sort, c.id`;
      return json({ ok: true, week, season, rows });
    }
    if (a === "archive") {
      const rows = await sql`select season, week, count(*) filter (where status in ('submitted','held')) as filed, count(*) as pieces, max(updated_at) as last
        from tribune.pieces group by season, week order by season desc, week desc limit 60`;
      return json({ ok: true, weeks: rows });
    }
    if (a === "set_status") {
      const st = String(b.status); if (!["draft", "submitted", "held"].includes(st)) throw new Fail("bad_status");
      const r = await sql`update tribune.pieces set status = ${st}, updated_at = now(), edited_by_admin = true
        where season = ${season} and week = ${week} and contributor_id = ${Number(b.contributor_id)} returning id, status`;
      return json({ ok: true, piece: r[0] ?? null });
    }
    if (a === "upsert_contributor") {
      const c = b.contributor ?? {};
      const r = c.id
        ? await sql`update tribune.contributors set name = ${c.name}, team = ${c.team ?? null}, section_key = ${c.section_key}, active = ${c.active ?? true}, sort = ${Number(c.sort ?? 100)} where id = ${Number(c.id)} returning *`
        : await sql`insert into tribune.contributors (name, team, section_key, active, sort) values (${c.name}, ${c.team ?? null}, ${c.section_key}, ${c.active ?? true}, ${Number(c.sort ?? 100)}) returning *`;
      return json({ ok: true, contributor: r[0] });
    }
    if (a === "upsert_section") {
      const s = b.section ?? {};
      if (!["tiers", "column", "history", "note"].includes(s.kind)) throw new Fail("bad_kind");
      const key = String(s.key ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30); if (!key) throw new Fail("bad_key");
      const r = await sql`insert into tribune.sections (key, title, kind, sort, roast, active) values (${key}, ${s.title}, ${s.kind}, ${Number(s.sort ?? 100)}, ${s.roast ?? null}, ${s.active ?? true})
        on conflict (key) do update set title = excluded.title, kind = excluded.kind, sort = excluded.sort, roast = excluded.roast, active = excluded.active returning *`;
      return json({ ok: true, section: r[0] });
    }
    if (a === "set_settings") {
      const allowed = ["current_week", "deadline_at", "deadline_label", "admin_word", "league_word"];
      for (const [k, v] of Object.entries(b.settings ?? {})) {
        if (!allowed.includes(k)) continue;
        if (k === "deadline_at" && Number.isNaN(Date.parse(String(v)))) throw new Fail("bad_deadline");
        await sql`insert into tribune.settings (key, value) values (${k}, ${String(v)}) on conflict (key) do update set value = excluded.value`;
      }
      return json({ ok: true, settings: await settings() });
    }
    throw new Fail("unknown_action", 404);
  } catch (e) {
    if (e instanceof Fail) return json({ ok: false, error: e.code }, e.status);
    console.error(e);
    return json({ ok: false, error: "error" }, 500);
  }
});
