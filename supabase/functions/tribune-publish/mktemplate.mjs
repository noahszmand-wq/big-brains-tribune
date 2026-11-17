// Builds supabase/functions/tribune-publish/template.json from the decoded Week 9 issue (dec/week9.html) and the
// public lock shell (week-9/index.html). The publisher fetches this file from the repo at run time.
import { readFileSync, writeFileSync } from "node:fs";
const lines = readFileSync("dec/week9.html", "utf8").split("\n");
const L = (a, b) => lines.slice(a - 1, b).join("\n");
const css = L(18, 727) + "\n" + readFileSync("/home/claude/big-brains-tribune/supabase/functions/tribune-publish/extra.css", "utf8");
const head = L(1, 16);
let shell = readFileSync("/home/claude/big-brains-tribune/week-9/index.html", "utf8");
shell = shell.replace(/staticryptConfig = \{[^\n]*\}/, 'staticryptConfig = {"staticryptEncryptedMsgUniqueVariableName":"{{ENCRYPTED}}","isRememberEnabled":true,"rememberDurationInDays":0,"staticryptSaltUniqueVariableName":"{{SALT}}"}');
if (!shell.includes("{{ENCRYPTED}}")) throw new Error("config line not found");
shell = shell.replace(/Babe wake up, BBT Issue No\. 3 is live/g, "{{OG_TITLE}}").replace(/https:\/\/noahszmand-wq\.github\.io\/big-brains-tribune\/og\/week-9\.png/g, "{{OG_IMAGE}}");
if ((shell.match(/\{\{OG_TITLE\}\}/g) || []).length !== 2 || (shell.match(/\{\{OG_IMAGE\}\}/g) || []).length !== 2) throw new Error("og placeholders");
// Scripts, as <script>…</script> blocks. The tea script reads the word and endpoint from the .tips element instead of literals.
let tea = L(852, 861);
tea = tea.replace(/const btns = \[\.\.\.document\.querySelectorAll\('\.tipcard \.fire'\)\]; if \(!btns\.length\) return;/, "const tipsRoot = document.querySelector('.tips'); const btns = [...document.querySelectorAll('.tipcard .fire')]; if (!tipsRoot || !btns.length) return;");
tea = tea.replace(/fetch\('[^']*tribune-comments'/, "fetch(tipsRoot.dataset.endpoint").replace(/word: '[a-z0-9]+'/, "word: tipsRoot.dataset.word");
if (/grandmasbedframe|supabase\.co/.test(tea) || !tea.includes("tipsRoot.dataset.word")) throw new Error("tea script rewrite failed");
const spill = L(932, 954), comments = L(957, 1053);
let tail = L(1085, 1139);
// Issue drawer: latest on top, every earlier issue inside a BBArchive folder.
const oldList = tail.slice(tail.indexOf("    ul.innerHTML = j.issues.map((x) => {"), tail.indexOf("    }).join('');") + "    }).join('');".length);
if (!oldList.includes("Issue No.")) throw new Error("drawer list block not found");
tail = tail.replace(oldList, `    const li = (x) => { const latest = x.week === j.latest, cur = x.week === here; const href = latest ? '/big-brains-tribune/' : '/big-brains-tribune/week-' + x.week + '/';
      return '<li><a href="' + href + '"' + (cur ? ' aria-current="page"' : '') + '><span class="mono">Issue No. ' + x.issue + '</span><b>Week ' + x.week + '</b>' + (latest ? '<em>Latest</em>' : '') + (cur && !latest ? '<em class="here">You are here</em>' : '') + '</a></li>'; };
    const past = j.issues.filter((x) => x.week !== j.latest);
    ul.innerHTML = j.issues.filter((x) => x.week === j.latest).map(li).join('') + (past.length ? '<li class="folder"><details' + (past.some((x) => x.week === here) ? ' open' : '') + '><summary><span class="mono">BBArchive</span><b>' + past.length + ' past issue' + (past.length === 1 ? '' : 's') + '</b></summary><ul class="issues">' + past.map(li).join('') + '</ul></details></li>' : '');`);
for (const [n, s] of Object.entries({ css, head, shell, tea, spill, comments, tail })) if (/grandmasbedframe/.test(s)) throw new Error("league word leaked into " + n);
const out = { built_from: "week-9", css, head, shell, scripts: { tea, spill, comments, tail } };
writeFileSync("/home/claude/big-brains-tribune/supabase/functions/tribune-publish/template.json", JSON.stringify(out));
console.log("ok", JSON.stringify(out).length);
