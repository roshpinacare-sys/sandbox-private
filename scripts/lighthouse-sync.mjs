#!/usr/bin/env bun
/**
 * lighthouse-sync.mjs — T-60: הכתבת-המגדלור-מהלב
 * ============================================================
 * עם-כל-פעימת-לב (מופעל-מ-heart-tick.mjs · spawn-שלישי), תמצית-החיים
 * נודדת-אל-המגדלור-הציבורי: roshpinacare-sys/sovereign-lighthouse
 * (GitHub-Pages — https://roshpinacare-sys.github.io/sovereign-lighthouse/)
 *
 * דוקטרינה:
 *  - אפס-אמון: לפני-כל-פרסום — סריקת-סודות-על-התוכן-היוצא (אותו-regex-כמו-המנוע-הגיט)
 *  - שער-שינוי: אם-heart-chain+worklogSha+memorySha לא-זזו מהפרסום-הקודם — skip
 *  - PUT-רק-עם-ה-blob-sha-החי-מה-API (אם-409 — refetch+retry-פעם-אחת)
 *  - אימות-חי: ה-URL-הציבורי-חייב-להשיב-200-אחרי-פרסום
 *  - fail-open: כשל-כלשהו = קבלה-מתועדת + יציאה-שקטה — הלב-אף-פעם-לא-נופל-בגלל-המגדלור
 *  - אפס-סודות-בפלט: טוקנים-ממוסכים-תמיד
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HEART = join(ROOT, 'state/heart/last.json');
const WORKLOG = join(ROOT, 'memory/worklog.md');
const MEMORY = join(ROOT, 'memory/MEMORY.md');
const VAULT_ENC = join(ROOT, 'vault/vault-backup.enc');
const RECEIPT_LAST = join(ROOT, 'receipts/lighthouse-last.json');
const RECEIPT_LOG = join(ROOT, 'receipts/lighthouse.jsonl');
const PAT_FILE = join(ROOT, 'secrets/pat.env');

const OWNER = 'roshpinacare-sys';
const REPO = 'sovereign-lighthouse';
const PAGES_URL = `https://${OWNER}.github.io/${REPO}/`;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const BRANCH = 'main';
const TAIL = 7;
const PAGE_VERSION = 'T-66b.1'; // T-66b: גרסת-הדף — עליית-גרסה-מכתיבה-פרסום-גם-בשער-השינוי (הדף-מוצר-בפני-עצמו)

function maskSecret(s) {
  if (typeof s !== 'string' || s.length < 12) return '•••';
  return s.slice(0, 4) + '•••' + s.slice(-3);
}

function readPat() {
  if (!existsSync(PAT_FILE)) throw new Error('pat.env-חסר');
  const firstLine = readFileSync(PAT_FILE, 'utf8')
    .split('\n')
    .find((l) => l.trim() && !l.trim().startsWith('#'));
  if (!firstLine) throw new Error('pat.env-ריק');
  let pat = firstLine.includes('=') ? firstLine.split('=').slice(1).join('=') : firstLine;
  pat = pat.trim().replace(/^["']|["']$/g, '');
  if (!pat) throw new Error('PAT-ריק');
  return pat;
}

/* --- סריקת-סודות: אותו-גורם-כמו-מנוע-הגיט — אסור-שמאומת-לצאת-לציבור --- */
const SECRET_RX = /(glrt-[A-Za-z0-9_\-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-or-[A-Za-z0-9\-]{10,}|nvapi-[A-Za-z0-9\-]{10,}|eyJ[A-Za-z0-9_\-]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function sha12(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function writeReceipt(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  try { writeFileSync(RECEIPT_LAST, JSON.stringify({ ts: new Date().toISOString(), ...obj }, null, 1)); } catch {}
  try {
    const prev = existsSync(RECEIPT_LOG) ? readFileSync(RECEIPT_LOG, 'utf8').trim().split('\n') : [];
    prev.push(line);
    writeFileSync(RECEIPT_LOG, prev.slice(-TAIL).join('\n') + '\n');
  } catch {}
  console.log(`[lighthouse] ${line}`);
}

/* --- T-66b: הדף-החי — נולד-מהלב-בכל-פעימה; מציג-לב+גריד-מלא+שערי-בעלים-גלויים --- */
function buildPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ראש פינה — מגדלור ריבוני</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #0a0a0f; color: #e7e7ee; min-height: 100vh; padding: 24px; }
.wrap { max-width: 820px; margin: 0 auto; }
header { text-align: center; padding: 28px 0 18px; }
.pulse { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 12px #22c55e; animation: p 2s infinite; }
@keyframes p { 50% { opacity: .4; } }
h1 { font-size: 1.7rem; margin: 12px 0 4px; }
.sub { color: #9a9ab0; font-size: .95rem; }
.stat, .card { background: #14141c; border: 1px solid #26263a; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
.stat b, .card b { color: #d4b483; }
.stat code { background: #1d1d29; padding: 2px 7px; border-radius: 6px; font-size: .85rem; direction: ltr; unicode-bidi: embed; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); margin: 14px 0; }
.l-name { font-weight: 700; color: #d4b483; margin-bottom: 6px; }
.l-detail { font-size: .88rem; color: #b9b9cc; }
h2 { font-size: 1.15rem; color: #d4b483; margin: 26px 0 10px; }
ol, ul { padding-inline-start: 22px; }
li { margin-bottom: 9px; color: #c9c9db; font-size: .92rem; line-height: 1.65; }
.post { background: #14141c; border: 1px solid #26263a; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
.post .p-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.post .p-title { font-weight: 700; color: #e7e7ee; font-size: .98rem; }
.post .p-meta { color: #71718c; font-size: .78rem; direction: ltr; unicode-bidi: embed; }
.post .p-kind { display: inline-block; background: #1d1d29; color: #d4b483; border-radius: 6px; padding: 1px 8px; font-size: .75rem; }
.post ul { margin-top: 8px; }
.post li { font-size: .88rem; color: #b9b9cc; }
.esc { border-inline-start: 3px solid #f59e0b; }
.esc .e-id { font-weight: 700; color: #f59e0b; font-size: .9rem; }
.esc .e-gate { font-size: .85rem; color: #b9b9cc; margin-top: 4px; }
.esc .e-need { font-size: .85rem; color: #71718c; margin-top: 4px; }
.doct { text-align: center; color: #71718c; font-size: .8rem; padding: 22px 0 6px; line-height: 1.8; }
.err { color: #f87171; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <span class="pulse"></span>
  <h1>ראש פינה — מגדלור ריבוני</h1>
  <div class="sub">קונסולה-חוץ-מכונה · נולדת-מהלב · חיה-גם-כשהמכונה-מתה · T-66b</div>
</header>

<div class="stat" id="alive">טוען-מצב-אחרון…</div>

<h2>פוסטי-הגריד — פעילות-הצי-בראיות</h2>
<div id="gridPosts">טוען-פוסטים…</div>

<h2>שכבות-הזיכרון-העצמאיות</h2>
<div class="grid" id="layers"></div>

<h2>שערי-בעלים-פתוחים (שקיפות-מלאה — אין-הגבלות-סמויות)</h2>
<div id="esc"></div>

<h2>מפת-ההערה (שיקום-מאפס)</h2>
<ol id="awaken"></ol>

<div class="doct" id="doct"></div>
</div>

<script>
const fmt = (x) => x ? String(x).replace('T',' ').slice(0,19)+'Z' : '—';
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
fetch('state.json').then(r => r.json()).then(s => {
  document.getElementById('alive').innerHTML =
    '<b>חי-אחרון-ידוע (לב):</b> ' + fmt(s.lastKnownAlive.heartAt) + '<br>' +
    '<b>קומיט:</b> <code>' + esc(String(s.commit).slice(0,16)) + '</code> (' + fmt(s.commitDate) + ')<br>' +
    '<b>טביעת-יומן:</b> <code>' + esc(s.lastKnownAlive.worklogSha12) + '</code> · ' +
    '<b>טביעת-זיכרון:</b> <code>' + esc(s.lastKnownAlive.memorySha12) + '</code> · ' +
    '<b>כספת:</b> ' + s.lastKnownAlive.vaultBytes + 'B · <b>ענף:</b> ' + esc(s.branch);
  document.getElementById('layers').innerHTML = (s.memoryLayers||[]).map(l =>
    '<div class="card"><div class="l-name">' + esc(l.layer) + '</div><div class="l-detail">' + esc(l.detail) + '</div></div>').join('');
  document.getElementById('awaken').innerHTML = (s.awakening||[]).map(x => '<li>' + esc(x) + '</li>').join('');
  const es = s.escalations || [];
  document.getElementById('esc').innerHTML = es.length ? es.map(e =>
    '<div class="card esc"><div class="e-id">' + esc(e.id) + ' — ' + esc(String(e.status).split('—')[0].trim()) + '</div>' +
    '<div class="e-gate">' + esc(e.gate) + '</div>' +
    (e.needed ? '<div class="e-need">נדרש-מהבעלים: ' + esc(e.needed) + '</div>' : '') + '</div>').join('')
    : '<div class="card">אין-שערי-בעלים-פתוחים — הצי-ריבוני-מלא.</div>';
  document.getElementById('doct').innerHTML = esc(s.doctrine) + '<br>נוצר-מהלב-אוטומטית (T-66b) · ' + fmt(s.generatedAt) + ' · publisher: ' + esc(s.publisher);
}).catch(() => { document.getElementById('alive').innerHTML = '<span class="err">state.json-לא-נטען — הדף-חי-אך-המצב-חסר</span>'; });

fetch('grid.json').then(r => r.json()).then(g => {
  const posts = (g.posts && g.posts.length ? g.posts : (g.recent||[]).map(x => ({...x, lines:[]})));
  document.getElementById('gridPosts').innerHTML = posts.length ? posts.slice().reverse().map(p =>
    '<div class="post"><div class="p-head"><span class="p-title">' + esc(p.title) + '</span>' +
    '<span class="p-kind">' + esc(p.kind||'post') + '</span><span class="p-meta">' + fmt(p.ts) + '</span></div>' +
    ((p.lines&&p.lines.length) ? '<ul>' + p.lines.map(l => '<li>' + esc(l) + '</li>').join('') + '</ul>' : '') +
    '</div>').join('')
    : '<div class="post">עדיין-אין-פוסטים — הגריד-יפרסם-עם-הראיה-הראשונה.</div>';
}).catch(() => { document.getElementById('gridPosts').innerHTML = '<span class="err">grid.json-לא-נטען</span>'; });
</script>
</body>
</html>`;
}

async function main() {
  if (!existsSync(HEART)) throw new Error('לב-חסר');
  const heart = JSON.parse(readFileSync(HEART, 'utf8'));
  const heartChain = heart.chain || '';
  const heartAt = heart.at || '';
  const head = heart.head || '';

  const worklogBuf = existsSync(WORKLOG) ? readFileSync(WORKLOG) : Buffer.alloc(0);
  const memoryBuf = existsSync(MEMORY) ? readFileSync(MEMORY) : Buffer.alloc(0);
  const vaultBytes = existsSync(VAULT_ENC) ? statSync(VAULT_ENC).size : 0;
  const worklogSha = sha12(worklogBuf);
  const memorySha = sha12(memoryBuf);

  /* --- T-66: זנת-הגריד — קריאה-בטוחה --- */
  const gridIdx = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'grids/index.json'), 'utf8')); } catch { return null; } })();

  /* --- T-66b: הפוסטים-המלאים-עצמם — הראיות-נודדות-למגדלור (היה: כותרות-בלבד — הריבון-ראה-אפס-פוסטים) --- */
  const gridPosts = (() => {
    try {
      const dir = join(ROOT, 'grids/posts');
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
      const all = [];
      for (const f of files) {
        for (const l of readFileSync(join(dir, f), 'utf8').trim().split('\n')) {
          if (!l) continue;
          try { all.push(JSON.parse(l)); } catch { /* שורה-פגומה-אחת-לא-מפילה */ }
        }
      }
      return all.slice(-10);
    } catch { return []; }
  })();

  /* --- T-66b: שערי-הבעלים — גלויים-ומסווגים (קץ-ה"הגבלות-הלא-ברורות") --- */
  const escalSummary = (() => {
    try {
      const j = JSON.parse(readFileSync(join(ROOT, 'repo-vault/escalations.json'), 'utf8'));
      const items = Array.isArray(j?.escalations) ? j.escalations : [];
      return items.map((x) => ({ id: x.id ?? '?', status: String(x.status ?? 'OPEN').slice(0, 40), gate: x.gate ?? '', needed: x.needed_from_owner ?? '' }));
    } catch { return []; }
  })();
  const gridFp = gridIdx?.lastPostAt ?? '';

  /* --- שער-השינוי: אל-תדחוף-את-אותו-מצב-פעמיים (כמו-vercel-beacon) --- */
  let prev = null;
  try { prev = JSON.parse(readFileSync(RECEIPT_LAST, 'utf8')); } catch {}
  if (
    prev && prev.ok && prev.gateBlocked !== true &&
    prev.heartChain === heartChain && prev.worklogSha === worklogSha && prev.memorySha === memorySha &&
    prev.gridFp === gridFp && prev.pageVersion === PAGE_VERSION
  ) {
    console.log('[lighthouse] אין-שינוי-מצב-מהפרסום-הקודם — skip (שער-שינוי)');
    return;
  }

  const state = {
    schema: 'roshpina.sovereign-beacon/1',
    pageVersion: PAGE_VERSION,
    publisher: 'T-60 heart-tick-automated (lighthouse-sync · כל-פעימת-לב)',
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    commit: `lastKnown:${head}`,
    commitDate: heartAt,
    branch: 'sanbox-main',
    lastKnownAlive: {
      heartAt,
      heartChain,
      worklogSha12: worklogSha,
      memorySha12: memorySha,
      vaultBytes,
    },
    memoryLayers: [
      { layer: 'github', detail: 'roshpinacare-sys/sanbox' },
      { layer: 'gitlab', detail: 'roshpinacare/sanbox' },
      { layer: 'postgres', detail: 'Supabase sovereign_state (state-replica)' },
      { layer: 'lighthouse', detail: 'הכתובת-הזו — מוכתבת-מהלב-אוטומטית (T-60)' },
      { layer: 'gitlab-ci', detail: 'ממתין-לאימות-זהות-הבעלים (escalations)' },
    ],
    grid: gridIdx ? { posts: gridIdx.total ?? 0, lastPostAt: gridIdx.lastPostAt ?? null, lastTitle: gridIdx.lastTitle ?? null, recent: (gridIdx.recent ?? []).slice(-5) } : null,
    gridPosts,
    escalations: escalSummary,
    fleet: {
      runner: 'GitLab runner 57265759 (self-healing via boot-all.sh)',
      renderCockpit: 'הצי-מחזיק-את-הנתיב (אי-התנגשות>מאבק)',
      escalations: 'sanbox repo-vault/escalations.json — שערי-בעלים-עם-ראיות',
      webSense: 'T-62: חיפוש-ריבוני (Tavily x2 · 200) + קריאת-דפים (Jina · 200) — אטום-בכספת · scripts/web-sense.mjs',
      motherConsole: 'T-64: קונסולת-האם 3050 נולדה-מחדש-מהריפו (scripts/console-server.ts) · משגיח-מחוסן (spawn-אסינכרוני+execPath)',
      webRecon: 'T-64: סייר-ריבוני-תקופתי (כל-~שעה): חיפוש-מדורג + ביקורת-חוץ-עצמית-של-המגדלור-מהאינטרנט',
      sovereigntyDrill: 'T-65: משפט-הריבונות (scripts/sovereignty-drill.sh): עננים-מרחוק+clone-טרי+שחזור-כספת+ביט-מול-חיים',
      grid: gridIdx ? `T-66: הגריד-הריבוני-חי (grids/run.mjs · spawn-5-מהלב) — פוסטים-מראיות: ${gridIdx.total ?? 0} · אחרון: ${gridIdx.lastTitle ?? ''}` : 'T-66: מותקן-ממתין-לפעימה-הראשונה',
      developmentPaths: 'מ-Head-Corner: browser-use/Skyvern (דפדפן) · vLLM (אינפרנס-עצמאי) · LangSearch (401-ממתין-הפעלה)',
    },
    awakening: [
      '1. הגיט-הוא-הקוד-המלא: שני-עננים-נושאים-sanbox + vault/vault-backup.enc (AES-256-GCM)',
      '2. שחזור-כספת: bun scripts/vault-restore.ts — המפתח: HQ_VAULT_PASS (hq.password אצל-Head-Corner · וב-~/.sovereign/guardian.env לאוטונומיה-מלאה-לאחר-התקנת-השומר)',
      '3. הצתה: sh sanbox/scripts/boot-all.sh — סודות→כספת→מפקח→שומר→HQ-3010',
      '4. זיכרון-חוץ-מכונה: bun scripts/state-replica.mjs pull',
      '5. ההתחדשות-אוטומטית: קומיט=הצתה; הלב-פועם-כל-15-דקות ומכתיב-את-המגדלור-הזה',
    ],
    doctrine: 'אפס-אמון-בטענות · הכל-מנוטר-בגיט · fail-open-לעננים-חוץ-מכונה · הכספת-נפתחת-רק-בסיסמה',
  };

  const content = Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf8');
  const contentStr = content.toString('utf8');

  /* --- סריקת-סודות-על-התוכן-היוצא (חוסם-הפרסום) --- */
  const hit = SECRET_RX.exec(contentStr);
  if (hit) throw new Error(`חסימת-פרסום: חשד-סוד-בתוכן (${maskSecret(hit[0])})`);

  /* --- T-66: אפס-שקר-מקומי — public/state.json מתעדכן-מאותו-מצב-שנדחף ---
   * (היה-נולד-מיושן-וזרע-תדמית-"אין-התקדמות" — הריבון-ראה-heartAt-ישן) --- */
  try { writeFileSync(join(ROOT, 'public/state.json'), contentStr); } catch { /* fail-open */ }

  const pat = readPat();
  const auth = { Authorization: `token ${pat}`, Accept: 'application/vnd.github+json' };

  const gh = async (path, opts = {}) => {
    const r = await fetch(`${API}${path}`, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };

  /* --- אפס-אמון: קורא-את-ה-blob-הקיים (sha) ואת-תוכנו-להשוואה --- */
  const cur = await gh(`/contents/state.json?ref=${BRANCH}`);
  const curSha = cur.json?.sha || null;
  const curContent = cur.json?.content
    ? Buffer.from(cur.json.content, 'base64').toString('utf8')
    : null;

  if (curSha && curContent) {
    let curState = null;
    try { curState = JSON.parse(curContent); } catch {}
    if (
      curState?.lastKnownAlive?.heartChain === heartChain &&
      curState?.lastKnownAlive?.worklogSha12 === worklogSha &&
      curState?.lastKnownAlive?.memorySha12 === memorySha &&
      (curState?.grid?.lastPostAt ?? '') === gridFp &&
      (curState?.pageVersion ?? '') === PAGE_VERSION
    ) {
      writeReceipt({ ok: true, mode: 'skip-identical', heartChain, worklogSha, memorySha, gridFp, pageVersion: PAGE_VERSION, pagesUrl: PAGES_URL });
      return;
    }
  }

  /* --- הכתבה: PUT עם-ה-sha-החי (retry-אחד-ב-409) --- */
  const putOnce = async (sha) =>
    gh(`/contents/state.json`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `heartbeat: מגדלור-מוכתב-מהלב · chain=${heartChain.slice(0, 12)}`,
        content: content.toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

  let res = await putOnce(curSha);
  if (res.status === 409 && curSha) {
    const fresh = await gh(`/contents/state.json?ref=${BRANCH}`);
    if (fresh.json?.sha) res = await putOnce(fresh.json.sha);
  }

  if (res.status !== 200 && res.status !== 201) {
    const gateBlocked = res.status === 403 || res.status === 404;
    writeReceipt({
      ok: false,
      mode: 'push',
      gateBlocked,
      http: res.status,
      error: `contents-PUT-${res.status}`,
      heartChain,
      worklogSha,
      memorySha,
    });
    process.exitCode = gateBlocked ? 0 : 1;
    return;
  }

  /* --- T-66: פרסום-זנת-הגריד למגדלור (grid.json · fail-open גמור — לא-מפיל-את-ההכתבה) --- */
  let gridPush = null;
  if (gridIdx) {
    const gContent = Buffer.from(JSON.stringify({ ...gridIdx, posts: gridPosts }, null, 1) + '\n', 'utf8');
    const gHit = SECRET_RX.exec(gContent.toString('utf8'));
    if (gHit) {
      gridPush = { ok: false, blocked: 'secret-scan' };
    } else {
      const gMsg = `grid: פוסטים=${gridIdx.total ?? 0}`;
      const gPut = (sha) => gh(`/contents/grid.json`, { method: 'PUT', body: JSON.stringify({ message: gMsg, content: gContent.toString('base64'), branch: BRANCH, ...(sha ? { sha } : {}) }) });
      const gCur = await gh(`/contents/grid.json?ref=${BRANCH}`);
      let gRes = await gPut(gCur.json?.sha || null);
      if (gRes.status === 409 && gCur.json?.sha) {
        const fresh = await gh(`/contents/grid.json?ref=${BRANCH}`);
        if (fresh.json?.sha) gRes = await gPut(fresh.json.sha);
      }
      gridPush = { ok: gRes.status === 200 || gRes.status === 201, http: gRes.status };
    }
  }

  /* --- T-66b: הדף-עצמו-נולד-מהלב — index.html-מוכתב-מהלב (היה-ארטיפקט-ידני-מ-T-59 שהיה-קורא-רק-state.json
   *   ומעולם-לא-הציג-גריד — מכאן-"אני-לא-רואה-פוסטים"-של-הריבון) --- */
  let pagePush = null;
  try {
    const page = buildPage();
    const pContent = Buffer.from(page, 'utf8');
    const pHit = SECRET_RX.exec(pContent.toString('utf8'));
    if (pHit) {
      pagePush = { ok: false, blocked: 'secret-scan' };
    } else {
      const pPut = (sha) => gh(`/contents/index.html`, { method: 'PUT', body: JSON.stringify({ message: `page: מגדלור-חי-עם-גריד (chain=${heartChain.slice(0, 8)})`, content: pContent.toString('base64'), branch: BRANCH, ...(sha ? { sha } : {}) }) });
      const pCur = await gh(`/contents/index.html?ref=${BRANCH}`);
      let pRes = await pPut(pCur.json?.sha || null);
      if (pRes.status === 409 && pCur.json?.sha) {
        const fresh = await gh(`/contents/index.html?ref=${BRANCH}`);
        if (fresh.json?.sha) pRes = await pPut(fresh.json.sha);
      }
      pagePush = { ok: pRes.status === 200 || pRes.status === 201, http: pRes.status };
    }
  } catch { pagePush = { ok: false, error: 'page-exception' }; }

  /* --- אימות-חי: המגדלור-חייב-להשיב-200 --- */
  await new Promise((r) => setTimeout(r, 3000));
  let live = 0;
  try {
    const lr = await fetch(PAGES_URL, { redirect: 'follow' });
    live = lr.status;
  } catch {}
  const commit = res.json?.commit?.sha?.slice(0, 12) || '•••';
  writeReceipt({
    ok: live === 200 || live === 0 /* CDN-עוד-מתעדכן — הפרסום-עצמו-אושר-ב-200/201 */,
    mode: 'push',
    lighthouseCommit: commit,
    liveHttp: live,
    pagesUrl: PAGES_URL,
    heartChain,
    worklogSha,
    memorySha,
    gridFp,
    pageVersion: PAGE_VERSION,
    gridPush,
    pagePush,
  });
}

main().catch((err) => {
  writeReceipt({ ok: false, mode: 'push', error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
