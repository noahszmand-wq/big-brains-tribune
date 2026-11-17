// Big Brains Tribune publisher. Editor-only endpoint (league word + editor word) that turns the week's filed pieces,
// approved tips and the league's Sleeper data into an issue page, locks it with the league word (StatiCrypt format,
// same salt as every issue so "remember me" keeps working), commits it to GitHub Pages and rolls the desk to next week.
//
// Actions: preflight {week?} · publish {week?, include?, tips?, reject?, lead?, roll?, dry_run?}
// Secrets: SUPABASE_DB_URL (standard), GITHUB_TOKEN (fine-grained PAT, Contents: read/write on the repo).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

// The paper's CSS, <head>, lock shell and client scripts live in the repo (template.json, built by mktemplate.mjs from a
// decoded issue) and are fetched at run time, so a design change is a commit, not a redeploy.
type Template = { css: string; head: string; shell: string; scripts: { tea: string; spill: string; comments: string; tail: string } };
let TEMPLATE: { at: number; t: Template } | null = null;
async function loadTemplate(): Promise<Template> {
  if (TEMPLATE && Date.now() - TEMPLATE.at < 300000) return TEMPLATE.t;
  const urls = [`${SITE}/supabase/functions/tribune-publish/template.json`, `https://raw.githubusercontent.com/${REPO}/${BRANCH}/supabase/functions/tribune-publish/template.json`];
  for (const u of urls) {
    try { const r = await fetch(u, { cache: "no-store", signal: AbortSignal.timeout(10000) }); if (r.ok) { const t = await r.json(); if (t?.css && t?.shell && t?.scripts) { TEMPLATE = { at: Date.now(), t }; return t; } } } catch (e) { console.error("template", u, String(e).slice(0, 120)); }
  }
  throw new Fail("no_template", 500);
}

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
class Fail extends Error { constructor(public code: string, public status = 400, public detail?: string) { super(code); } }

const REPO = "noahszmand-wq/big-brains-tribune", BRANCH = "main";
const SITE = "https://noahszmand-wq.github.io/big-brains-tribune", BASE = "/big-brains-tribune";
const SALT = "a8a52c806256116f23433011f3b10f49"; // shared by every issue so a remembered league word opens all of them
const FN = "https://eempzkiumbnffftkqdas.supabase.co/functions/v1";
const TZ = "America/Chicago";

// ---------- small helpers ----------
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[c]!));
const f2 = (n: unknown) => Number(n ?? 0).toFixed(2);
const f1 = (n: unknown) => Number(n ?? 0).toFixed(1);
const fi = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString("en-US");
const fc = (n: unknown) => Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rec = (w: number, l: number, t = 0) => `${w}–${l}${t ? `–${t}` : ""}`;
const dateLong = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
const dateShort = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }).format(d);
const plain = (html: string) => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const firstName = (name: string) => String(name || "").trim().split(/\s+/)[0] || name;
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

// Same allow-list the desk applies on save; applied again here so nothing odd reaches the page.
function sanitize(html: string): string {
  let s = String(html ?? "");
  s = s.replace(/<(script|style|iframe|object|embed|img)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<(script|style|iframe|object|embed|img)\b[^>]*\/?>/gi, "");
  s = s.replace(/<\/?div\b[^>]*>/gi, (m) => (m.startsWith("</") ? "</p>" : "<p>"));
  s = s.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (m, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!["p", "br", "b", "strong", "i", "em", "ul", "ol", "li", "a", "blockquote"].includes(t)) return "";
    if (close) return `</${t}>`;
    if (t === "a") { const h = /href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/i.exec(attrs); return h ? `<a href="${esc(h[1])}" target="_blank" rel="noopener">` : "<a>"; }
    if (t === "blockquote") return `<blockquote class="pq">`;
    return `<${t}>`;
  });
  s = s.replace(/<a>([\s\S]*?)<\/a>/g, "$1").replace(/on\w+\s*=/gi, "");
  return s.replace(/<p>(\s|&nbsp;|<br>)*<\/p>/g, "").trim();
}

// ---------- StatiCrypt-compatible encryption (mirrors the engine embedded in the lock shell) ----------
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);
async function pbkdf2(pw: string, salt: string, iterations: number, hash: string) {
  const k = await crypto.subtle.importKey("raw", utf8(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash, iterations, salt: utf8(salt) }, k, 256));
}
async function hashPassword(pw: string, salt: string) {
  let h = await pbkdf2(pw, salt, 1000, "SHA-1"); h = await pbkdf2(h, salt, 14000, "SHA-256"); return pbkdf2(h, salt, 585000, "SHA-256");
}
async function staticrypt(msg: string, password: string) {
  const hp = await hashPassword(password, SALT);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", unhex(hp), "AES-CBC", false, ["encrypt"]);
  const enc = hex(iv) + hex(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, utf8(msg)));
  const mk = await crypto.subtle.importKey("raw", unhex(hp), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", mk, utf8(enc))) + enc;
}

// ---------- GitHub (Git Data API: one commit with every file) ----------
async function gh(path: string, init: RequestInit = {}) {
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) throw new Fail("no_github_token", 500);
  const r = await fetch(`https://api.github.com${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "bbt-publish", "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) { const t = await r.text().catch(() => ""); console.error("github", path, r.status, t.slice(0, 300)); throw new Fail(`github_${r.status}`, 502, t.slice(0, 200)); }
  return r.json();
}
async function repoState() {
  const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const commitSha = ref.object.sha as string;
  const commit = await gh(`/repos/${REPO}/git/commits/${commitSha}`);
  const tree = await gh(`/repos/${REPO}/git/trees/${commit.tree.sha}`);
  const entries: { path: string; type: string; sha: string }[] = tree.tree;
  const weeks = entries.filter((e) => e.type === "tree" && /^week-\d+$/.test(e.path)).map((e) => Number(e.path.slice(5)));
  let issues: { latest: number; issues: { week: number; issue: number }[] } = { latest: 0, issues: [] };
  const ij = entries.find((e) => e.path === "issues.json");
  if (ij) { const blob = await gh(`/repos/${REPO}/git/blobs/${ij.sha}`); try { issues = JSON.parse(atob(String(blob.content).replace(/\n/g, ""))); } catch { /* keep default */ } }
  let og: string[] = [];
  const ogDir = entries.find((e) => e.path === "og" && e.type === "tree");
  if (ogDir) { const t = await gh(`/repos/${REPO}/git/trees/${ogDir.sha}`); og = t.tree.map((e: { path: string }) => e.path); }
  return { commitSha, treeSha: commit.tree.sha as string, weeks, issues, og };
}
async function commitFiles(base: { commitSha: string; treeSha: string }, files: { path: string; content: string }[], message: string) {
  const blobs = await Promise.all(files.map(async (f) => ({ path: f.path, mode: "100644", type: "blob", sha: (await gh(`/repos/${REPO}/git/blobs`, { method: "POST", body: JSON.stringify({ content: f.content, encoding: "utf-8" }) })).sha })));
  const tree = await gh(`/repos/${REPO}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: base.treeSha, tree: blobs }) });
  const commit = await gh(`/repos/${REPO}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [base.commitSha] }) });
  await gh(`/repos/${REPO}/git/refs/heads/${BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
  return commit.sha as string;
}

// ---------- Sleeper ----------
const SLEEPER = "https://api.sleeper.app/v1";
async function sleeper(path: string) {
  const r = await fetch(`${SLEEPER}${path}`, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Fail("sleeper_" + r.status, 502);
  return r.json();
}
// Badge codes and colours the paper has used since Issue No. 1; anyone new gets initials and the next colour.
const KNOWN: Record<string, [string, string]> = {
  "Bishop Sycamore HS": ["BSHS", "--t8"], "Lamarsexuals": ["LS", "--t2"], "Horsecock Gallager": ["HCG", "--t5"], "Moose is Loose": ["MIL", "--t9"],
  "Beefy Slow Burn #BigUce": ["BSB", "--t3"], "SilentCountPoota": ["SCP", "--t10"], "John baptiste": ["JB", "--t7"], "Coachstradomus #DarkTimes": ["CSD", "--t1"],
  "JUD Corp": ["JUD", "--t4"], "Wausington For Sale Team": ["WFST", "--t6"],
};
type Team = { rid: number; name: string; k: string; c: string; wins: number; losses: number; ties: number; pf: number; pa: number; seed: number; last5: string[] };
type Game = { w: Team; l: Team; wp: number; lp: number; margin: number };
type League = { league: any; teams: Team[]; byRid: Record<number, Team>; byName: Record<string, Team>; games: Game[]; next: { a: Team; b: Team }[]; playoffTeams: number; playoffWeek: number | null };
async function leagueData(leagueId: string, week: number): Promise<League> {
  const [league, users, rosters] = await Promise.all([sleeper(`/league/${leagueId}`), sleeper(`/league/${leagueId}/users`), sleeper(`/league/${leagueId}/rosters`)]);
  const weeks = Array.from({ length: week + 1 }, (_, i) => i + 1); // 1..week+1
  const matchups: Record<number, any[]> = {};
  await Promise.all(weeks.map(async (w) => { matchups[w] = await sleeper(`/league/${leagueId}/matchups/${w}`).catch(() => []); }));
  const teams: Team[] = rosters.map((r: any, i: number) => {
    const u = users.find((u: any) => u.user_id === r.owner_id);
    const name = u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`;
    const known = KNOWN[name];
    const k = known?.[0] ?? (name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w: string) => w[0]).join("").toUpperCase().slice(0, 4) || `T${r.roster_id}`);
    const s = r.settings ?? {};
    return { rid: r.roster_id, name, k, c: known?.[1] ?? `--t${((i) % 10) + 1}`, wins: s.wins ?? 0, losses: s.losses ?? 0, ties: s.ties ?? 0,
      pf: (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100, pa: (s.fpts_against ?? 0) + (s.fpts_against_decimal ?? 0) / 100, seed: 0, last5: [] };
  });
  const byRid: Record<number, Team> = Object.fromEntries(teams.map((t) => [t.rid, t]));
  const byName: Record<string, Team> = Object.fromEntries(teams.map((t) => [t.name, t]));
  const pairs = (w: number) => {
    const by: Record<string, any[]> = {};
    for (const m of matchups[w] ?? []) if (m.matchup_id != null) (by[m.matchup_id] ??= []).push(m);
    return Object.values(by).filter((g) => g.length === 2);
  };
  // Final scores for the issue week (only games where somebody scored).
  const games: Game[] = pairs(week).filter(([a, b]) => Number(a.points) + Number(b.points) > 0).map(([a, b]) => {
    const [x, y] = Number(a.points) >= Number(b.points) ? [a, b] : [b, a];
    return { w: byRid[x.roster_id], l: byRid[y.roster_id], wp: Number(x.points), lp: Number(y.points), margin: +(Number(x.points) - Number(y.points)).toFixed(2) };
  }).filter((g) => g.w && g.l).sort((a, b) => a.margin - b.margin);
  // Last five results, oldest to newest.
  for (let w = Math.max(1, week - 4); w <= week; w++) for (const [a, b] of pairs(w)) {
    if (Number(a.points) + Number(b.points) === 0) continue;
    const ta = byRid[a.roster_id], tb = byRid[b.roster_id]; if (!ta || !tb) continue;
    const pa = Number(a.points), pb = Number(b.points);
    ta.last5.push(pa > pb ? "W" : pa < pb ? "L" : "T"); tb.last5.push(pb > pa ? "W" : pb < pa ? "L" : "T");
  }
  teams.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || (b.pf - a.pf)).forEach((t, i) => { t.seed = i + 1; });
  const next = pairs(week + 1).map(([a, b]) => ({ a: byRid[a.roster_id], b: byRid[b.roster_id] })).filter((g) => g.a && g.b);
  return { league, teams, byRid, byName, games, next, playoffTeams: Number(league?.settings?.playoff_teams ?? 5) || 5, playoffWeek: league?.settings?.playoff_week_start ?? null };
}

// ---------- page pieces ----------
const BRAIN = `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M40 16c-11 0-19 7-19 16 0 3 1 6 3 9-6 2-10 8-10 14 0 8 6 15 14 16 1 8 8 13 16 13 5 0 10-2 13-5 3 3 8 5 13 5 8 0 15-5 16-13 8-1 14-8 14-16 0-6-4-12-10-14 2-3 3-6 3-9 0-9-8-16-19-16-5 0-9 1-12 4-3-3-7-4-12-4h-10z" fill="#0A1220"/><path d="M60 20v62" stroke="#FF6A1F" stroke-width="3" stroke-linecap="round"/><path d="M28 38c6 2 11 1 15-3M92 38c-6 2-11 1-15-3M24 56c6-2 11 0 15 5M96 56c-6-2-11 0-15 5M36 72c5 0 8-2 10-5M84 72c-5 0-8-2-10-5" fill="none" stroke="#FF6A1F" stroke-width="3" stroke-linecap="round"/><path d="M44 28h32M50 23v10M58 23v10M66 23v10M74 23v10" stroke="#FFD60A" stroke-width="3.2" stroke-linecap="round"/></svg>`;
const CM = `<a class="cmchip" href="#comments">💬 Join the chat</a>`;
const tb = (t: Team | null | undefined, lg = false) => t ? `<span class="tb${lg ? " lg" : ""}" style="--c:var(${t.c})" title="${esc(t.name)}">${esc(t.k)}</span>` : "";
const sh = (id: string, title: string, extra = "", chat = true) => `<div class="sh"><h2 id="h-${id}">${esc(title)}</h2>${extra}${chat ? CM : ""}</div>`;
const NFL_NAMES: Record<string, string> = { ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears", CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers", HOU: "Texans", IND: "Colts", JAX: "Jaguars", KC: "Chiefs", LV: "Raiders", LAC: "Chargers", LAR: "Rams", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants", NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SF: "49ers", SEA: "Seahawks", TB: "Buccaneers", TEN: "Titans", WAS: "Commanders" };
const TIER_VARS = ["--tier-s", "--tier-a", "--tier-b", "--tier-c", "--tier-d", "--tier-ass", "--tier-mega", "--tier-super"];

type Piece = { contributor_id: number; name: string; team: string | null; section_key: string; title: string; kind: string; status: string | null; content: any; image_url: string | null; roast: string | null; include: boolean };
type Ctx = { week: number; issue: number; season: number; L: League | null; prevTiers: any | null; tipsRun: { id: number; headline: string; tip: string }[]; hottest: { headline: string; n: number } | null; word: string; now: Date; T: Template };

function sectionTiers(p: Piece, ctx: Ctx) {
  const c = p.content ?? {}, tiers: any[] = Array.isArray(c.tiers) ? c.tiers : [], extra: any[] = Array.isArray(c.extra) ? c.extra : [];
  const nfl = c.nfl?.teams ?? {};
  const nameOf = (id: string) => NFL_NAMES[id] ?? extra.find((e) => e.id === id)?.name ?? id;
  const codeOf = (id: string) => NFL_NAMES[id] ? id : (extra.find((e) => e.id === id)?.code ?? id);
  const prevIdx: Record<string, number> = {};
  (ctx.prevTiers?.tiers ?? []).forEach((t: any, i: number) => (t.teams ?? []).forEach((id: string) => { prevIdx[id] = i; }));
  const moves: { id: string; d: number }[] = [];
  const chip = (id: string, i: number) => {
    const t = nfl[id]; const ni = t ? [t.rec, t.opp ? `${t.ha} ${t.opp}` : (t.rec ? "bye" : "")].filter(Boolean).join(" · ") : "";
    let mv = "";
    if (ctx.prevTiers) { const d = prevIdx[id] == null ? null : prevIdx[id] - i; if (d == null) mv = `<small class="mv new">New</small>`; else if (d) { moves.push({ id, d }); mv = `<small class="mv ${d > 0 ? "up" : "dn"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</small>`; } }
    return `<span class="nfl"><b>${esc(codeOf(id))}</b><span class="tn">${esc(nameOf(id))}${ni ? `<small class="ni">${esc(ni)}</small>` : ""}</span>${mv}</span>`;
  };
  const rows = tiers.map((t, i) => {
    const fraud = /fraud/i.test(t.name), ass = /\bass\b/i.test(t.name), bottom = i === tiers.length - 1 && i >= 5;
    const cls = ["tier", fraud ? "fraud" : "", ass && !fraud ? "ass" : "", bottom ? "bottom" : ""].filter(Boolean).join(" ");
    const n = (t.teams ?? []).length;
    return `<div class="${cls}" style="--tc:var(${TIER_VARS[Math.min(i, TIER_VARS.length - 1)]})"><div class="lab">${fraud ? `<span>${esc(t.name)}</span>` : esc(t.name)}<small>${n} team${n === 1 ? "" : "s"}</small></div><div class="row">\n${(t.teams ?? []).map((id: string) => chip(id, i)).join("\n")}\n</div></div>`;
  }).join("\n");
  let mvline = "";
  if (ctx.prevTiers && moves.length) {
    const up = [...moves].sort((a, b) => b.d - a.d)[0], dn = [...moves].sort((a, b) => a.d - b.d)[0];
    mvline = `<p class="mvline mono">${up.d > 0 ? `Biggest riser: <b>${esc(nameOf(up.id))}</b> ▲${up.d}` : ""}${up.d > 0 && dn.d < 0 ? " · " : ""}${dn.d < 0 ? `Biggest faller: <b>${esc(nameOf(dn.id))}</b> ▼${Math.abs(dn.d)}` : ""} · ${moves.length} team${moves.length === 1 ? "" : "s"} moved vs. last week</p>`;
  }
  const team = ctx.L?.byName[p.team ?? ""] ?? null;
  const img = p.image_url ? `<figure class="pieceimg"><img src="${esc(p.image_url)}" alt="" loading="lazy"></figure>` : "";
  return `<section id="${esc(p.section_key)}" aria-labelledby="h-${esc(p.section_key)}">${sh(p.section_key, p.title, `<span class="sticker">Guest ranker</span><span class="mono">Week ${ctx.week} edition</span>`)}
<p class="rk-quote"><q>babe wake up, ${esc(firstName(p.name).toLowerCase())} released his weekly NFL Power Rankings</q></p>
<div class="byline"><span class="who">${tb(team)}By ${esc(p.name)}</span><span class="mono">Contributing ranker · printed as submitted</span></div>
<div class="tiers">
${mvline}${rows}
</div>${c.note ? `<p class="note">${esc(c.note)}</p>` : ""}${img}
</section>`;
}

function sectionColumn(p: Piece, ctx: Ctx) {
  const c = p.content ?? {}; const team = ctx.L?.byName[p.team ?? ""] ?? null;
  const body = sanitize(c.body_html);
  const img = p.image_url ? `<figure class="pieceimg"><img src="${esc(p.image_url)}" alt="" loading="lazy"></figure>` : "";
  const host = `<aside class="host"><span class="onair"><i aria-hidden="true"></i>ON AIR</span><div class="nm">${tb(team, true)}<b>${esc(p.team || p.name)}</b></div><div class="hh">Where his head is at while writing</div>${team ? `<dl><dt>Record</dt><dd>${rec(team.wins, team.losses, team.ties)} · seed ${team.seed}</dd><dt>Points</dt><dd>${fc(team.pf)} for · ${fc(team.pa)} against</dd></dl>` : ""}<div><div class="mono dim" style="margin-bottom:6px">Topics</div><div class="topics"><span>The league</span><span>Football</span>${p.team ? `<span>${esc(p.team)}</span>` : ""}<span>Politics</span><span>Life</span></div></div></aside>`;
  return `<section id="${esc(p.section_key)}" aria-labelledby="h-${esc(p.section_key)}">${sh(p.section_key, p.title, `<span class="sticker">Guest column</span><span class="mono">A column by ${esc(p.name)}</span>`)}
<div class="room">${host}<div class="page">${c.headline ? `<h3 class="colhead">${esc(c.headline)}</h3>` : ""}<div class="prose">${body || `<p class="dim">Filed without a body.</p>`}</div>${img}${c.signoff ? `<div class="signoff">${esc(c.signoff)}</div>` : ""}</div></div></section>`;
}

function sectionNote(p: Piece, ctx: Ctx, editor = false) {
  const c = p.content ?? {}; const team = ctx.L?.byName[p.team ?? ""] ?? null;
  const img = p.image_url ? `<figure class="pieceimg"><img src="${esc(p.image_url)}" alt="" loading="lazy"></figure>` : "";
  return `<section id="${esc(p.section_key)}" aria-labelledby="h-${esc(p.section_key)}"${editor ? ' style="padding-top:28px"' : ""}>${sh(p.section_key, p.title, "", !editor)}
<div class="ednote-box">${tb(team, true)}<div>${c.headline ? `<h3 class="colhead">${esc(c.headline)}</h3>` : ""}<div class="prose">${sanitize(c.body_html)}</div>${img}</div></div></section>`;
}

function sectionHistory(p: Piece, ctx: Ctx) {
  const c = p.content ?? {}; const card = c.card; const img = p.image_url ? `<figure class="pieceimg"><img src="${esc(p.image_url)}" alt="" loading="lazy"></figure>` : "";
  let left = "";
  if (card && Array.isArray(card.games)) {
    const pick = c.pick ?? { games: card.games.map((_: any, i: number) => i), nums: ["high", "low", "avg", "closest", "blowout"], players: (card.extras?.top_players ?? []).map((_: any, i: number) => i) };
    const x = card.extras ?? {}, fr = x.final_records ?? {};
    const side = (s: any, cls: string) => `<span class="${cls}">${esc(s.team)} <small class="dim">${esc(s.record || "")}${fr[s.team] ? ` · finished ${esc(fr[s.team])}` : ""}</small></span><span class="pts ${cls}">${f2(s.pts)}</span>`;
    const games = card.games.filter((_: any, i: number) => pick.games.includes(i)).map((g: any) => `<div class="histgame ${card.high && g.w.team === card.high.team && g.w.pts === card.high.pts ? "high" : ""}">${side(g.w, "w")}${side(g.l, "l")}</div>`).join("");
    const nums: string[] = [];
    if (pick.nums.includes("high") && card.high) nums.push(`<div><span class="mono">High</span><span>${f2(card.high.pts)} · ${esc(card.high.team)}</span></div>`);
    if (pick.nums.includes("low") && x.low) nums.push(`<div><span class="mono">Low</span><span>${f2(x.low.pts)} · ${esc(x.low.team)}</span></div>`);
    if (pick.nums.includes("avg") && x.avg != null) nums.push(`<div><span class="mono">Average</span><span>${f2(x.avg)} across the league</span></div>`);
    if (pick.nums.includes("closest") && x.closest) nums.push(`<div><span class="mono">Closest</span><span>${esc(x.closest.w)} over ${esc(x.closest.l)} by ${f2(x.closest.margin)}</span></div>`);
    if (pick.nums.includes("blowout") && x.blowout) nums.push(`<div><span class="mono">Blowout</span><span>${esc(x.blowout.w)} over ${esc(x.blowout.l)} by ${f2(x.blowout.margin)}</span></div>`);
    const players = (x.top_players ?? []).filter((_: any, i: number) => pick.players.includes(i)).map((pl: any) => `<li><b>${esc(pl.name)}</b> <span class="dim">${esc(pl.pos || "")} · ${esc(pl.team || "")}</span><span class="pts">${f2(pl.pts)}</span></li>`).join("");
    if (games || nums.length || players) left = `<div class="histcard"><div class="yr">${esc(card.season)}</div><div class="wk mono">Week ${esc(card.week)} scoreboard</div>${games}${nums.length ? `<div class="histnums">${nums.join("")}</div>` : ""}${players ? `<div class="mono dim" style="margin-top:14px">Top performers</div><ol class="histtop">${players}</ol>` : ""}</div>`;
  }
  const story = `<div>${c.headline ? `<h3 class="colhead">${esc(c.headline)}</h3>` : ""}<div class="prose">${sanitize(c.body_html) || `<p class="dim">Filed without a story.</p>`}</div>${img}</div>`;
  return `<section id="${esc(p.section_key)}" aria-labelledby="h-${esc(p.section_key)}">${sh(p.section_key, p.title, `<span class="sticker">Guest column</span><span class="mono">By ${esc(p.name)}</span>`)}
${left ? `<div class="hist">${left}${story}</div>` : story}</section>`;
}

function sectionRoast(key: string, title: string, roast: string) {
  return `<section id="${esc(key)}" aria-labelledby="h-${esc(key)}">${sh(key, title)}
<div class="roast"><span class="mono">Did not file</span><p>${esc(roast)}</p></div></section>`;
}

function sectionTea(ctx: Ctx) {
  if (!ctx.tipsRun.length) return "";
  const cards = ctx.tipsRun.map((t) => `<article class="tipcard"><span class="stamp">Anonymous tip · unconfirmed</span><h3>${esc(t.headline)}</h3><blockquote>${esc(t.tip)}</blockquote><button type="button" class="fire" data-tip="${t.id}" aria-pressed="false"><span>🔥</span><b>0</b></button></article>`).join("\n");
  const hot = ctx.hottest ? `<p class="mvline mono">Last week&#x27;s hottest tea · 🔥 ${ctx.hottest.n} · <b>${esc(ctx.hottest.headline)}</b></p>\n` : "";
  return `<section id="tipline" aria-labelledby="h-tipline">${sh("tipline", "The tea", `<span class="mono">Anonymous tip line · as received, lightly headlined</span>`)}<div class="tips" data-endpoint="${FN}/tribune-comments" data-word="${esc(ctx.word)}">
${hot}${cards}
</div></section>
${ctx.T.scripts.tea}`;
}

function sectionAwards(ctx: Ctx) {
  const L = ctx.L; if (!L || !L.games.length) return "";
  const sides = L.games.flatMap((g) => [{ t: g.w, p: g.wp, won: true, opp: g.l, m: g.margin }, { t: g.l, p: g.lp, won: false, opp: g.w, m: g.margin }]).sort((a, b) => b.p - a.p);
  const high = sides[0], low = sides[sides.length - 1];
  const beats = sides.filter((s) => s.p < high.p).length;
  const hardLuck = sides.filter((s) => !s.won).sort((a, b) => b.p - a.p)[0];
  const blow = [...L.games].sort((a, b) => b.margin - a.margin)[0];
  const tile = (badge: string, t: Team, stat: string, unit: string, text: string, xl = false, chips: string[] = []) =>
    `<article class="tile${xl ? " xl" : ""}"><span class="badge">${badge}</span><div class="tm">${tb(t)}<span>${esc(t.name)}</span></div><div class="stat num">${stat}<small>${unit}</small></div><p>${text}</p>${chips.length ? `<div class="chipsrow mono">${chips.map((c) => `<span>${c}</span>`).join("")}</div>` : ""}</article>`;
  const tiles = [
    tile("Week high", high.t, f2(high.p), "pts", `Beats ${beats === sides.length - 1 ? "all " : ""}${beats} of the other ${sides.length - 1} teams this week${high.won ? ` and takes the game against ${esc(high.opp.name)} by ${f2(high.m)}` : ` and still loses to ${esc(high.opp.name)}`}.`, true, [`${beats}–${sides.length - 1 - beats} all-play`, `${rec(high.t.wins, high.t.losses, high.t.ties)} · seed ${high.t.seed}`]),
    hardLuck ? tile("Hard luck", hardLuck.t, f2(hardLuck.p), "pts, lost", `${ord(sides.indexOf(hardLuck) + 1)}-best score of the week, and it ran into ${esc(hardLuck.opp.name)}&#x27;s ${f2(L.games.find((g) => g.l === hardLuck.t)?.wp ?? 0)}.`) : "",
    blow ? tile("Blowout", blow.w, "by " + f2(blow.margin), "pts", `${esc(blow.w.name)} ${f2(blow.wp)}, ${esc(blow.l.name)} ${f2(blow.lp)}. The widest margin of the week.`) : "",
    tile("Low score", low.t, f2(low.p), low.won ? "pts, won anyway" : "pts", `The low for the week${low.won ? `, and it still beat ${esc(low.opp.name)}` : `, in a ${f2(low.m)}-point loss to ${esc(low.opp.name)}`}.`),
  ].filter(Boolean).join("\n");
  return `<section id="awards" aria-labelledby="h-awards">${sh("awards", "Awards", `<span class="mono">What the scoreboard saw</span>`)}<div class="bento">
${tiles}
</div></section>`;
}

function sectionNext(ctx: Ctx) {
  const L = ctx.L; if (!L || !L.next.length) return "";
  const side = (t: Team, r = false) => `<div class="side2${r ? " r" : ""}"><div class="nm">${tb(t)}<span>${esc(t.name)}</span></div><span class="rec">${rec(t.wins, t.losses, t.ties)} · seed ${t.seed}</span></div>`;
  const cards = L.next.map((g) => {
    const tag = g.a.seed <= L.playoffTeams && g.b.seed <= L.playoffTeams ? "Playoff teams" : (g.a.seed === L.playoffTeams + 1 || g.b.seed === L.playoffTeams + 1 || g.a.seed === L.playoffTeams || g.b.seed === L.playoffTeams) ? "The bubble" : "";
    return `<article class="mu">${tag ? `<div class="tagrow"><span class="badge">${tag}</span></div>` : ""}<div class="vs">${side(g.a)}<div class="v">vs</div>${side(g.b, true)}</div></article>`;
  }).join("\n");
  const left = L.playoffWeek ? Math.max(0, L.playoffWeek - (ctx.week + 1)) : null;
  return `<section id="week" class="wk8" aria-labelledby="h-week">${sh("week", `Next up: Week ${ctx.week + 1}`, `<span class="mono">The slate</span>`)}${left != null ? `<div class="col"><p>${left === 0 ? `Last regular-season week before the playoffs start in Week ${L.playoffWeek}.` : `${left} regular-season game${left === 1 ? "" : "s"} left after this one; the playoffs start in Week ${L.playoffWeek}.`}</p></div>` : ""}<div class="docket"><div class="grid3">
${cards}
</div></div></section>`;
}

function sectionSpill(ctx: Ctx) {
  return `<section id="tipbox" aria-labelledby="h-tipbox">${sh("tipbox", "Spill it", `<span class="sticker">Anonymous</span><span class="mono">The tip line · best tips run next week</span>`, false)}<div class="spill"><div class="pitch"><p class="big">Heard something? Spill it. No name attached.</p><p>Trade talks that fell apart. A lineup decision that needs answers. Whatever’s brewing in the group chat. The best tips run as headlines in next week’s issue.</p><p class="fine">Tips are saved with no name, email or account attached. Each one gets a quick read before it runs. League drama only: real-life stuff about people stays out.</p></div><form id="spillform" data-endpoint="${FN}/tribune-tip" autocomplete="off" novalidate><label><span>The tea<b class="cnt num" aria-live="off">0 / 1000</b></span><textarea name="tip" maxlength="1000" required placeholder="Sources say…"></textarea></label><div class="hp" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1"></label></div><input type="hidden" name="word" value="${esc(ctx.word)}"><div class="go"><button type="submit">Spill it</button></div><p class="msg" role="status" aria-live="polite"></p></form></div></section>
${ctx.T.scripts.spill}`;
}

function sectionComments(ctx: Ctx) {
  const teams = (ctx.L?.teams ?? []).map((t) => ({ n: t.name, k: t.k, c: t.c }));
  const opts = teams.map((t) => `<option value="${esc(t.n)}">${esc(t.n)}</option>`).join("");
  return `<section id="comments" aria-labelledby="h-comments"><div class="sh"><h2 id="h-comments">Comments</h2><span class="mono count"></span></div><div class="cmts" id="cmts" data-endpoint="${FN}/tribune-comments" data-week="${ctx.week}" data-word="${esc(ctx.word)}" data-teams='${esc(JSON.stringify(teams))}'><div class="pick"><span>Who’s talking</span><select aria-label="Comment as"><option value="">Pick your team…</option>${opts}<option value="Anonymous">Anonymous</option></select></div><form autocomplete="off" novalidate><div class="replyto mono" hidden><span></span><button type="button" aria-label="Cancel reply">✕</button></div><textarea maxlength="600" placeholder="Say it with your chest."></textarea><input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true"><div class="pv" hidden></div><div class="row"><span class="as"></span><span class="rowr"><button type="button" class="photo" aria-label="Add a photo or GIF" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></button><input type="file" accept="image/*" hidden><button type="submit" disabled>Post</button></span></div><p class="msg" role="status" aria-live="polite"></p></form><div class="list"><p class="empty">Loading…</p></div></div></section>
${ctx.T.scripts.comments}`;
}

function sectionScores(ctx: Ctx) {
  const L = ctx.L; if (!L || !L.games.length) return "";
  const high = Math.max(...L.games.map((g) => g.wp));
  const cards = L.games.map((g, i) => {
    const tag = i === 0 ? "Closest" : g.wp === high ? "Week high" : `By ${f2(g.margin)}`;
    const pct = (g.wp / (g.wp + g.lp)) * 100;
    const ln = (t: Team, p: number, cls: string) => `<div class="ln ${cls}">${tb(t)}<span class="tm">${esc(t.name)}<small>${rec(t.wins, t.losses, t.ties)}</small></span><span class="pts num">${f2(p)}</span></div>`;
    return `<article class="bug${i === 0 ? " hot" : ""}"><div class="top mono"><span class="tag">${tag}</span><span>Final</span></div><div class="rows">${ln(g.w, g.wp, "win")}${ln(g.l, g.lp, "lose")}</div><div><div class="split" aria-hidden="true"><i style="--a:${pct.toFixed(1)}%"></i></div><div class="bot mono">By ${f2(g.margin)}</div></div></article>`;
  }).join("\n");
  return `<details class="fold" id="fold-scores"><summary><span class="ft">Scores</span><span class="mono">Tap to open</span></summary>
<section id="scores" aria-labelledby="h-scores">${sh("scores", "Final scores", `<span class="mono">Week ${ctx.week} · all games final</span>`, false)}<div class="bugs feat">
${cards}
</div></section>
</details>`;
}

function sectionStandings(ctx: Ctx) {
  const L = ctx.L; if (!L || !L.teams.length) return "";
  const maxPf = Math.max(...L.teams.map((t) => t.pf)) || 1;
  const rows = L.teams.map((t) => `<tr><td class="seed">${t.seed}</td><td class="team"><div>${tb(t)}<span>${esc(t.name)}</span></div></td><td>${rec(t.wins, t.losses, t.ties)}</td><td><div class="pf"><span class="mini"><i style="--a:${((t.pf / maxPf) * 100).toFixed(2)}%"></i></span><span>${fc(t.pf)}</span></div></td><td>${fc(t.pa)}</td><td><span class="pips" aria-label="Last five: ${t.last5.join("")}">${t.last5.map((r) => `<span class="pip ${r}">${r}</span>`).join("")}</span></td></tr>` + (t.seed === L.playoffTeams && L.teams.length > L.playoffTeams ? `\n<tr class="cut"><td colspan="6"><div class="cutline"><span>Playoff line</span></div></td></tr>` : "")).join("\n");
  const top = L.teams[0];
  return `<details class="fold" id="fold-standings"><summary><span class="ft">Standings</span><span class="mono">Tap to open</span></summary>
<section id="standings" aria-labelledby="h-standings">${sh("standings", "Standings", `<span class="mono">Top ${L.playoffTeams} make the playoffs${L.playoffWeek ? ` · Week ${L.playoffWeek}` : ""}</span>`, false)}<div class="tablebox"><table class="stand"><thead><tr><th class="l">Seed</th><th class="l">Team</th><th>W–L</th><th>Points for</th><th>Against</th><th>Last 5</th></tr></thead><tbody>
${rows}
</tbody></table></div><div class="col"><p class="note">Seeds order by record, then points for. Last 5 runs oldest to newest.</p><p>${esc(top.name)} holds the top seed at ${rec(top.wins, top.losses, top.ties)}${L.teams[1] && L.teams[1].wins === top.wins && L.teams[1].losses === top.losses ? ` on points over ${esc(L.teams[1].name)}` : ""}.</p></div></section>
</details>`;
}

// ---------- the whole issue ----------
function buildIssue(ctx: Ctx, pieces: Piece[], lead: { headline?: string; deck?: string } | null, issues: { week: number; issue: number }[]) {
  const L = ctx.L;
  const editorNote = pieces.find((p) => p.kind === "note" && p.include && plain(p.content?.body_html ?? ""));
  const body: { id: string; label: string; blurb: string; html: string }[] = [];
  if (editorNote) body.push({ id: editorNote.section_key, label: editorNote.title, blurb: editorNote.content?.headline || "From the editor's chair", html: sectionNote(editorNote, ctx, true) });
  for (const p of pieces) {
    if (p.kind === "note" && p === editorNote) continue;
    if (p.kind === "note") { if (p.include && plain(p.content?.body_html ?? "")) body.push({ id: p.section_key, label: p.title, blurb: p.content?.headline || `By ${p.name}`, html: sectionNote(p, ctx) }); continue; }
    if (p.include) {
      const c = p.content ?? {};
      const blurb = p.kind === "tiers" ? "Babe wake up" : c.headline || `By ${p.name}`;
      body.push({ id: p.section_key, label: p.title, blurb, html: p.kind === "tiers" ? sectionTiers(p, ctx) : p.kind === "history" ? sectionHistory(p, ctx) : sectionColumn(p, ctx) });
    } else if (p.roast) body.push({ id: p.section_key, label: p.title, blurb: "Did not file", html: sectionRoast(p.section_key, p.title, p.roast) });
  }
  if (ctx.tipsRun.length) body.push({ id: "tipline", label: "The tea", blurb: ctx.tipsRun[0].headline, html: sectionTea(ctx) });
  if (L?.games.length) {
    const hi = [...L.games].sort((a, b) => b.wp - a.wp)[0];
    body.push({ id: "awards", label: "Awards", blurb: `${hi.w.name} drops ${f2(hi.wp)}`, html: sectionAwards(ctx) });
  }
  if (L?.next.length) body.push({ id: "week", label: `Week ${ctx.week + 1}`, blurb: `${L.next.length} games on the slate`, html: sectionNext(ctx) });
  body.push({ id: "tipbox", label: "Spill it", blurb: "Anonymous tip line", html: sectionSpill(ctx) });
  body.push({ id: "comments", label: "Comments", blurb: "Pick your team, say your piece", html: sectionComments(ctx) });
  if (L?.games.length) { const c = L.games[0]; body.push({ id: "scores", label: "Scores", blurb: `${c.w.k} over ${c.l.k} by ${f2(c.margin)}`, html: sectionScores(ctx) }); }
  if (L?.teams.length) { const t = L.teams[0]; body.push({ id: "standings", label: "Standings", blurb: `${t.name} on top at ${rec(t.wins, t.losses, t.ties)}`, html: sectionStandings(ctx) }); }

  // Hero: the editor's override, else a factual line from the scoreboard.
  let h1 = "", deck = "";
  if (L?.games.length) {
    const hi = [...L.games].sort((a, b) => b.wp - a.wp)[0], close = L.games[0], top = L.teams[0];
    h1 = `Week ${ctx.week}: <span class="hl">${esc(hi.w.name)}</span> leads the week at ${f2(hi.wp)}`;
    deck = `${esc(hi.w.name)} posted the week&#x27;s high, ${f2(hi.wp)}, in a ${f2(hi.margin)}-point win over ${esc(hi.l.name)}. The closest game: ${esc(close.w.name)} over ${esc(close.l.name)} by ${f2(close.margin)}. ${esc(top.name)} sits on the top seed at ${rec(top.wins, top.losses, top.ties)}.`;
  } else { h1 = `Week ${ctx.week}: <span class="hl">Issue No. ${ctx.issue}</span>`; deck = `The league paper for Big Brains Only.`; }
  const filed = pieces.filter((p) => p.include && p.kind !== "note");
  if (filed.length) deck += ` <b>In this issue:</b> ${filed.map((p) => esc(p.title)).join(", ")}.`;
  if (lead?.headline) h1 = esc(lead.headline);
  if (lead?.deck) deck = esc(lead.deck);

  const seasonTag = `${String(ctx.season).slice(2)}-${String(ctx.season + 1).slice(2)} season`;
  const chips = body.map((b) => `<a href="#${esc(b.id)}">${esc(b.label)}</a>`).join("");
  const index = body.map((b) => `<a href="#${esc(b.id)}"><span class="mono">${esc(b.label)}</span><b>${esc(b.blurb)}</b></a>`).join("\n");
  const sorted = [...issues].sort((a, b) => b.week - a.week);
  const latestWeek = sorted[0]?.week ?? ctx.week;
  const drawerList = sorted.map((x) => `<li><a href="${x.week === latestWeek ? `${BASE}/` : `${BASE}/week-${x.week}/`}"${x.week === ctx.week ? ' aria-current="page"' : ""}><span class="mono">Issue No. ${x.issue}</span><b>Week ${x.week}</b>${x.week === latestWeek ? "<em>Latest</em>" : ""}</a></li>`).join("");
  const asOf = dateShort(ctx.now);

  return `${ctx.T.head}
<style>
${ctx.T.css}
</style>
</head>
<body>
<header class="masthead gut"><div class="wrap"><div class="mrule"><i></i><span class="mbrain">${BRAIN}</span><i></i></div><h1 class="mtitle">The Big Brains Tribune</h1><div class="mdate mono"><b>•</b><span>The league paper for Big Brains Only</span><b>•</b></div><div class="mdate mono"><span>${seasonTag}</span><b>|</b><span>Week ${ctx.week}</span><b>|</b><span>Issue No. ${ctx.issue}</span></div></div></header>
<header class="bar gut"><div class="wrap"><a class="brand" href="#top"><span class="mark logo">${BRAIN}</span><span class="word">Big Brains Tribune</span><span class="btag mono">${String(ctx.season).slice(2)}-${String(ctx.season + 1).slice(2)} | Wk ${ctx.week} | No. ${ctx.issue}</span></a><button type="button" class="theme-toggle" id="themetoggle" aria-pressed="false" title="Switch light / dark"><i aria-hidden="true"></i><span>Dark</span></button><button type="button" class="menu-btn" id="menubtn" aria-expanded="false" aria-controls="drawer" aria-label="Open the issue menu"><i></i><i></i><i></i></button><div class="chipwrap"><nav class="chips mono" aria-label="Sections">${chips}</nav></div></div></header>
<div class="drawer-bg" id="drawerbg" hidden></div><aside class="drawer" id="drawer" aria-label="Issues" hidden data-week="${ctx.week}"><div class="dh"><span class="brand"><span class="mark logo">${BRAIN}</span></span><button type="button" class="dclose" id="drawerclose" aria-label="Close">✕</button></div><div class="mono dim">Every issue</div><ul class="issues" id="issuelist">${drawerList}</ul><div class="mono dim" style="margin-top:18px">Contribute</div><ul class="issues"><li><a href="${BASE}/desk/"><span class="mono">Contributor Desk</span><b>File your column</b></a></li></ul></aside>
<main class="gut" id="top"><div class="wrap"><div class="hero"><div class="kicker mono"><span class="k1">Issue No. ${ctx.issue}</span><span class="k2">${esc(dateLong(ctx.now))}</span></div>
<h1>${h1}</h1>
<div class="hero-row solo"><p class="deck">${deck}</p></div></div>

<div class="indexhd"><h2>In this issue</h2><span>Tap a card to jump to it</span></div><nav class="index" aria-label="In this issue">
${index}
</nav>

${body.map((b) => b.html).join("\n\n")}

<footer><div class="row"><p>Every score and record comes straight from the league&#x27;s Sleeper data as of ${esc(asOf)}. Contributor pieces run as filed through the Contributor Desk.</p><div class="credit"><b>Created by WFST</b><span class="mono">Actively recruiting volunteer contributors</span></div></div></footer></div></main>
<a class="totop" href="#top" aria-label="Back to top">TOP</a>
${ctx.T.scripts.tail}
</body>
</html>`;
}

// ---------- data loading ----------
async function settings(): Promise<Record<string, string>> {
  const rows = await sql`select key, value from tribune.settings`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
async function loadPieces(season: number, week: number): Promise<Piece[]> {
  const rows = await sql`select c.id as contributor_id, c.name, c.team, c.section_key, s.title, s.kind, s.sort, s.roast, s.active as section_active, c.is_editor,
      p.status, p.content, p.image_url, p.updated_at, p.submitted_at
    from tribune.contributors c join tribune.sections s on s.key = c.section_key
    left join tribune.pieces p on p.contributor_id = c.id and p.season = ${season} and p.week = ${week}
    where c.active order by s.sort, c.sort, c.id`;
  return rows.map((r) => ({ contributor_id: r.contributor_id, name: r.name, team: r.team, section_key: r.section_key, title: r.title, kind: r.kind, status: r.status ?? null,
    content: r.content ?? {}, image_url: r.image_url ?? null, roast: r.section_active || r.kind === "note" ? r.roast : null, include: r.status === "submitted",
    // extra fields used by preflight only
    ...( { updated_at: r.updated_at, submitted_at: r.submitted_at, is_editor: r.is_editor, section_active: r.section_active, has_content: !!plain(r.content?.body_html ?? "") || (Array.isArray(r.content?.tiers) && r.content.tiers.some((t: any) => (t.teams ?? []).length)) } as any) }));
}
// Chicago wall-clock + 7 days, as an ISO instant (so the deadline stays at 3 PM across a DST change).
function nextDeadline(iso: string): string {
  const d = new Date(iso); if (isNaN(d.getTime())) return new Date(Date.now() + 7 * 864e5).toISOString();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const target = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + 7)); // date only, UTC midnight
  const hh = Number(p.hour) % 24, mm = Number(p.minute);
  for (const off of [5, 6]) {
    const t = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hh + off, mm));
    const q = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(t).map((x) => [x.type, x.value]));
    if (Number(q.day) === target.getUTCDate() && Number(q.hour) % 24 === hh && Number(q.minute) === mm) return t.toISOString();
  }
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hh + 6, mm)).toISOString();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  try {
    const b = await req.json().catch(() => { throw new Fail("bad_request"); });
    const S = await settings();
    if (norm(b.word) !== norm(S.league_word)) throw new Fail("wrong_word", 401);
    if (!b.admin_word || norm(b.admin_word) !== norm(S.admin_word)) throw new Fail("not_admin", 403);
    const season = Number(S.season), current = Number(S.current_week), week = Number(b.week ?? current);
    if (!(week >= 1 && week <= 18)) throw new Fail("bad_week");
    const a = String(b.action ?? "");
    const now = new Date();

    if (a === "preflight") {
      const pieces = await loadPieces(season, week);
      const tips = await sql`select id, tip, status, headline, issue_week, created_at from tribune.tips
        where status in ('new', 'approved') or (status = 'published' and issue_week = ${week}) order by created_at`;
      let repo: Awaited<ReturnType<typeof repoState>> | null = null, github_error: string | null = null;
      try { repo = await repoState(); } catch (e) { github_error = e instanceof Fail ? e.code : "github_error"; }
      const published = repo ? repo.weeks.includes(week) : false;
      const known = repo?.issues.issues.find((x) => x.week === week);
      const issue = known?.issue ?? ((repo?.issues.issues ?? []).reduce((m, x) => Math.max(m, x.issue), 0) + 1);
      let template_ok = true; try { await loadTemplate(); } catch { template_ok = false; }
      let sleeper_ok = true, next_games = 0, games = 0;
      try { const L = await leagueData(S.league_id, week); games = L.games.length; next_games = L.next.length; } catch { sleeper_ok = false; }
      return json({ ok: true, week, season, current_week: current, is_current: week === current, issue, already_published: published, latest_week: repo?.issues.latest ?? null,
        github_ok: !!repo, github_error, template_ok, sleeper_ok, games, next_games, deadline_at: S.deadline_at, next_deadline: nextDeadline(S.deadline_at),
        rows: pieces.map((p: any) => ({ contributor_id: p.contributor_id, name: p.name, team: p.team, section_key: p.section_key, title: p.title, kind: p.kind, status: p.status ?? "none", has_content: p.has_content, roast: p.roast, is_editor: p.is_editor, updated_at: p.updated_at, default_include: p.include })),
        tips });
    }

    if (a === "publish") {
      const dry = !!b.dry_run;
      const pieces = await loadPieces(season, week);
      const include: number[] | null = Array.isArray(b.include) ? b.include.map(Number) : null;
      for (const p of pieces) { p.include = include ? include.includes(p.contributor_id) : p.status === "submitted"; if (p.kind === "note") p.include = p.include || (!include && !!p.status); }
      // Tips: the editor sends the ones to run with their headlines; anything in `reject` is marked rejected.
      const run: { id: number; headline: string }[] = Array.isArray(b.tips) ? b.tips.map((t: any) => ({ id: Number(t.id), headline: String(t.headline ?? "").trim().slice(0, 200) })).filter((t: any) => t.id > 0 && t.headline) : [];
      const reject: number[] = Array.isArray(b.reject) ? b.reject.map(Number).filter((n: number) => n > 0) : [];
      const tipRows = run.length ? await sql`select id, tip from tribune.tips where id = any(${run.map((t) => t.id)}) and status <> 'rejected'` : [];
      const tipsRun = run.map((t) => { const r = tipRows.find((x) => x.id === t.id); return r ? { id: t.id, headline: t.headline, tip: r.tip } : null; }).filter(Boolean) as Ctx["tipsRun"];
      const hot = await sql`select t.headline, count(v.id)::int as n from tribune.tips t left join tribune.tip_votes v on v.tip_id = t.id
        where t.status = 'published' and t.issue_week = ${week - 1} group by t.id order by n desc, t.id limit 1`;
      const hottest = hot[0] && hot[0].n > 0 ? { headline: hot[0].headline, n: hot[0].n } : null;
      const prev = await sql`select p.content from tribune.pieces p join tribune.sections s on s.key = p.section_key
        where s.kind = 'tiers' and (p.season < ${season} or (p.season = ${season} and p.week < ${week})) order by p.season desc, p.week desc limit 1`;
      let L: League | null = null;
      try { L = await leagueData(S.league_id, week); } catch (e) { console.error("sleeper", e); if (!dry) throw new Fail("sleeper_down", 502); }

      let repo: Awaited<ReturnType<typeof repoState>> | null = null;
      if (!dry) repo = await repoState();
      const issuesList = repo?.issues.issues ?? [];
      const known = issuesList.find((x) => x.week === week);
      const issue = Number(b.issue) > 0 ? Number(b.issue) : (known?.issue ?? (issuesList.reduce((m, x) => Math.max(m, x.issue), 0) + 1));
      const newIssues = known ? issuesList : [...issuesList, { week, issue }];
      const ctx: Ctx = { week, issue, season, L, prevTiers: prev[0]?.content ?? null, tipsRun, hottest, word: norm(S.league_word), now, T: await loadTemplate() };
      const lead = b.lead && typeof b.lead === "object" ? { headline: String(b.lead.headline ?? "").trim().slice(0, 160), deck: String(b.lead.deck ?? "").trim().slice(0, 1200) } : null;
      const inner = buildIssue(ctx, pieces, lead, newIssues);
      if (dry) return json({ ok: true, week, issue, html: inner, sections: pieces.filter((p) => p.include).map((p) => p.section_key), tips: tipsRun.length, sleeper_ok: !!L });

      // Lock it with the league word and build the two shells (latest + permalink).
      const encrypted = await staticrypt(inner, norm(S.league_word));
      const ogTitle = `Babe wake up, BBT Issue No. ${issue} is live`;
      const ogImage = `${SITE}/og/${repo!.og.includes(`week-${week}.png`) ? `week-${week}.png` : "default.png"}`;
      const shell = ctx.T.shell.replace("{{ENCRYPTED}}", encrypted).replace("{{SALT}}", SALT).split("{{OG_TITLE}}").join(esc(ogTitle)).split("{{OG_IMAGE}}").join(ogImage);
      const latest = Math.max(week, ...newIssues.map((x) => x.week));
      const sortedIssues = [...newIssues].sort((x, y) => y.week - x.week);
      const files: { path: string; content: string }[] = [{ path: `week-${week}/index.html`, content: shell }, { path: "issues.json", content: JSON.stringify({ latest, issues: sortedIssues }) }];
      if (latest === week) files.push({ path: "index.html", content: shell });
      files.push({ path: "README.md", content: `# The Big Brains Tribune\n\nThe league paper for Big Brains Only.\n\n- Latest issue: ${SITE}/\n${sortedIssues.map((x) => `- Week ${x.week} (Issue No. ${x.issue}): ${SITE}/week-${x.week}/`).join("\n")}\n- Contributor Desk: ${SITE}/desk/\n` });
      const commit = await commitFiles(repo!, files, `${known ? "Republish" : "Publish"} Week ${week}: Issue No. ${issue}`);

      // Only now touch the database: tips that ran, tips rejected, and the roll to next week.
      for (const t of tipsRun) await sql`update tribune.tips set status = 'published', headline = ${t.headline}, issue_week = ${week}, reviewed_at = now() where id = ${t.id}`;
      if (reject.length) await sql`update tribune.tips set status = 'rejected', reviewed_at = now() where id = any(${reject}) and status <> 'published'`;
      let rolled = false, nextDl: string | null = null;
      if (b.roll !== false && week === current) {
        nextDl = nextDeadline(S.deadline_at);
        await sql`insert into tribune.settings (key, value) values ('current_week', ${String(week + 1)}) on conflict (key) do update set value = excluded.value`;
        await sql`insert into tribune.settings (key, value) values ('deadline_at', ${nextDl}) on conflict (key) do update set value = excluded.value`;
        rolled = true;
      }
      return json({ ok: true, week, issue, republished: !!known, url: latest === week ? `${SITE}/` : `${SITE}/week-${week}/`, permalink: `${SITE}/week-${week}/`, commit, rolled, next_week: rolled ? week + 1 : current, next_deadline: nextDl, tips_published: tipsRun.length, tips_rejected: reject.length });
    }
    throw new Fail("unknown_action", 404);
  } catch (e) {
    if (e instanceof Fail) return json({ ok: false, error: e.code, detail: e.detail ?? null }, e.status);
    console.error(e);
    return json({ ok: false, error: "error" }, 500);
  }
});
