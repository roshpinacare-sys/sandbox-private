#!/usr/bin/env bun
/**
 * vercel-beacon.mjs — המגדלור-הריבוני-חוץ-מכונה (T-57).
 *
 * הרעיון: אם-המכונה-מתה-וגם-שני-ענני-הגיט-נפלו-יחד — עדיין-צריך-מקום-שאומר-מי-אנחנו,
 * מה-היה-המצב-האחרון-הידוע, ואיך-מעירים-את-המערכת. ורסל-היא-הקונסולה-שחיה-בלי-מכונה:
 *   - עם-כל-פעימה-שבה-המצב-השתנה: index.html-ריבוני-נבנה-מקומית-ומועלה-לוורסל.
 *   - הדף-מכיל-אפס-סודות — רק-מפת-חיים-פומבית (HEAD · טביעות-זיכרון · מפת-הערה).
 *   - JSON-מוטמע-בדף = API-מצב-אחרון-הידוע-למי-שהתעורר.
 *
 * ביטחון:
 *   - vercel_token-נקרא-רק-מ-secrets/vercel.keys (מנוטרל-מגיט).
 *   - אף-טוקן/מזהה-כספת-לא-מודפס-ולא-נכנס-לדף; קבלות-ממוסכות.
 *   - שער-שינוי: אם-HEAD+טביעת-זיכרון-לא-זזו-מהעלאה-הקודמת — דילוג (חסכון-מכסת-ורסל).
 *   - fail-open תמיד: כשל-המגדלור-לעולם-לא-מפיל-את-הלב/המפקח/הדחיפה (exit-0).
 *
 * שימוש:
 *   bun scripts/vercel-beacon.mjs          ← העלאה-עם-שער-שינוי
 *   bun scripts/vercel-beacon.mjs force    ← העלאה-כפויה (דילוג-השער)
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = '/home/z/my-project/sanbox';
const SECRETS = path.join(ROOT, 'secrets', 'vercel.keys');
const RECEIPTS = path.join(ROOT, 'receipts');
const HEART = path.join(ROOT, 'state', 'heart', 'last.json');
const WORKLOG = path.join(ROOT, 'memory', 'worklog.md');
const MEMORY = path.join(ROOT, 'memory', 'MEMORY.md');
const LAST = path.join(RECEIPTS, 'vercel-beacon-last.json');
const LOG = path.join(RECEIPTS, 'vercel-beacon.jsonl');
const PROJECT = 'roshpina-sovereign-beacon';
const FORCE = process.argv[2] === 'force';

const nowIso = () => new Date().toISOString();
const sha = (p) => {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12); }
  catch { return 'missing'; }
};

function readSecret(key) {
  try {
    const text = readFileSync(SECRETS, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0 && t.slice(0, eq).trim() === key) return t.slice(eq + 1).trim();
    }
  } catch { /* שקט — fail-open */ }
  return '';
}

function receipt(ok, extra = {}) {
  const rec = { ts: nowIso(), mode: FORCE ? 'force' : 'push', ok, ...extra };
  try {
    mkdirSync(RECEIPTS, { recursive: true });
    writeFileSync(LAST, JSON.stringify(rec, null, 2) + '\n');
    appendFileSync(LOG, JSON.stringify(rec) + '\n');
    const lines = readFileSync(LOG, 'utf8').trim().split('\n');
    if (lines.length > 200) writeFileSync(LOG, lines.slice(-200).join('\n') + '\n');
  } catch { /* קבלה-לעולם-לא-מפילה */ }
  return rec;
}

async function fail(msg, extra = {}) {
  receipt(false, { error: msg, ...extra });
  console.log(`[beacon] ✗ ${msg}`);
  process.exit(0); // fail-open — תמיד
}

async function main() {
  const token = readSecret('vercel_token');
  if (!token) return fail('אין-vercel_token-בכספת');
  const tokenFp = createHash('sha256').update(token).digest('hex').slice(0, 8);

  /* === T-66b: שער-כלכלה-ל-403-ידוע — שער-בעלים (escalation vercel-token-read-only) לא-יישרף-כל-פעימה ===
   * עוגן = last403At (ה-403-האחרון-בפועל; קבלות-הדילוג-נושאות-אותו-קדימה-בלי-להזיז-אותו — אחרת-דילוג-נצחי=כיבוי-תמידי).
   * טוקן-חדש-מכספת (טביעה-שונה) = פתרון-העלאה → ניסיון-מיידי-מתיר. FORCE-עוקף. מעל-6ש: ניסיון-אחד → 403 → צינון-מחדש.
   * הפעלה-תמידית-של-הערוץ-בקצב-שנון · בזבוז-אפס בינתיים. */
  try {
    const prevG = JSON.parse(readFileSync(LAST, 'utf8'));
    const anchor = prevG.last403At ?? prevG.ts;
    if (!FORCE && prevG.tokenFp === tokenFp && prevG.gateBlocked && Date.now() - Date.parse(anchor) < 6 * 3_600_000) {
      receipt(true, { skipped: 'owner-gate-403-cooldown', gateBlocked: true, tokenFp, last403At: anchor, nextTryAt: new Date(Date.parse(anchor) + 6 * 3_600_000).toISOString() });
      console.log('[beacon] ⏭ 403-בעלים-ידוע — צינון-עד ' + new Date(Date.parse(anchor) + 6 * 3_600_000).toISOString().slice(11, 16) + 'Z (הערוץ-חי; בזבוז-אפס)');
      return;
    }
  } catch { /* קבלה-ראשונה */ }

  /* === שער-השינוי: אין-טעם-להעלות-אותו-מצב-עם-אותו-טוקן ===
   * דילוג-גם-אחרי-הצלחה-וגם-אחרי-403-הרשאות (גשם-על-שער-נעול-אינו-פותח-אותו);
   * כשל-רשת-חוזר-תמיד (transient). טוקן-חדש-מכספת = טביעה-חדשה = ניסיון-מחדש. === */
  const head = (() => {
    try { return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
    catch { return 'unknown'; }
  })();
  const memorySha = sha(WORKLOG) + ':' + sha(MEMORY);
  try {
    const prev = JSON.parse(readFileSync(LAST, 'utf8'));
    const same = prev.head === head && prev.memorySha === memorySha && prev.tokenFp === tokenFp;
    if (!FORCE && same && (prev.ok || prev.gateBlocked)) {
      receipt(true, { skipped: true, head, memorySha, tokenFp });
      console.log('[beacon] ⏭ אין-שינוי-מוצת (מצב+טוקן-זהים) — דילוג-חסכוני');
      return;
    }
  } catch { /* קבלה-ראשונה */ }

  /* === איסוף-מצב-החיים-האחרון-הידוע === */
  const heart = (() => { try { return JSON.parse(readFileSync(HEART, 'utf8')); } catch { return null; } })();
  const lastOk = (file) => {
    try {
      const lines = readFileSync(path.join(ROOT, 'receipts', file), 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const j = JSON.parse(lines[i]); if (j.ok) return { ts: j.ts, commit: j.commit || j.head || '' }; } catch {}
      }
    } catch {}
    return null;
  };
  const state = {
    schema: 'roshpina.sovereign-beacon/1',
    generatedAt: nowIso(),
    identity: 'Rosh Pina — ריבון-עצמאי-24/7 · sanbox (T-57 מגדלור)',
    lastKnownAlive: {
      head,
      heartAt: heart?.at || null,
      heartChain: heart?.chain || null,
      memoryFingerprint: memorySha,
    },
    memoryLayers: [
      { layer: 'github', detail: 'roshpinacare-sys/sanbox — העורק-הראשי', lastPush: lastOk('auto-push.jsonl') },
      { layer: 'gitlab', detail: 'roshpinacare/sanbox — החיים-השניים (מראה)', lastPush: lastOk('gitlab-push.jsonl') },
      { layer: 'postgres', detail: 'Supabase sovereign_state — שכפול-מצב (state-replica)', lastPush: lastOk('state-replica.jsonl') },
      { layer: 'vercel-beacon', detail: 'הקונסולה-הזו — חיה-בלי-המכונה' },
    ],
    awakening: [
      '1. הגיט-הוא-הקוד-המלא: שני-עננים-נושאים-sanbox+vault/vault-backup.enc (9-קבצים-מוצפנים-AES-256-GCM).',
      '2. שחזור-כספת: bun core/vault restore — המפתח-הוא-hq.password-אצל-Head-Corner (שלוש-מראות-שרד).',
      '3. הצתה: sh sanbox/scripts/boot-all.sh — סודות→כספת→מפקח→שומר→HQ-3010.',
      '4. זיכרון-חוץ-מכונה: bun scripts/state-replica.mjs pull — תמציות-החיים-האחרונות-מהפוסטגרס.',
      '5. ההתחדשות-אוטומטית: קומיט=הצתה — המפקח-מחדש-HQ-בעצמו; הלב-פועם-כל-15-דקות.',
    ],
    doctrine: 'אפס-אמון-בטענות · הכל-מנוטר-בגיט · fail-open-לעננים-חוץ-מכונה · הכספת-נפתחת-רק-בסיסמה',
  };

  /* === בניית-הדף === */
  const json = JSON.stringify(state).replace(/</g, '\\u003c');
  const fmt = (x) => x ? new Date(x).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '—';
  const layersHtml = state.memoryLayers.map((l) => `
    <div class="card">
      <div class="l-name">${l.layer}</div>
      <div class="l-detail">${l.detail}</div>
      ${l.lastPush ? `<div class="l-ts">דחיפה-אחרונה: ${fmt(l.lastPush.ts)}${l.lastPush.commit ? ` · ${String(l.lastPush.commit).slice(0, 7)}` : ''}</div>` : '<div class="l-ts">—</div>'}
    </div>`).join('');
  const awakenHtml = state.awakening.map((s) => `<li>${s}</li>`).join('');
  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ראש פינה — מגדלור ריבוני</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0a0a0f; color: #e7e7ee; min-height: 100vh; padding: 24px; }
  .wrap { max-width: 780px; margin: 0 auto; }
  header { text-align: center; padding: 28px 0 18px; }
  .pulse { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
           background: #22c55e; box-shadow: 0 0 12px #22c55e; animation: p 2s infinite; }
  @keyframes p { 50% { opacity: .4; } }
  h1 { font-size: 1.7rem; margin: 12px 0 4px; }
  .sub { color: #9a9ab0; font-size: .95rem; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); margin: 18px 0; }
  .card { background: #14141c; border: 1px solid #26263a; border-radius: 12px; padding: 16px; }
  .l-name { font-weight: 700; color: #d4b483; margin-bottom: 6px; }
  .l-detail { font-size: .88rem; color: #b9b9cc; }
  .l-ts { font-size: .78rem; color: #71718c; margin-top: 8px; direction: ltr; text-align: right; }
  .stat { background: #14141c; border: 1px solid #26263a; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .stat b { color: #d4b483; }
  .stat code { background: #1d1d29; padding: 2px 7px; border-radius: 6px; font-size: .85rem; direction: ltr; unicode-bidi: embed; }
  h2 { font-size: 1.1rem; color: #d4b483; margin: 22px 0 10px; }
  ol { padding-inline-start: 22px; }
  li { margin-bottom: 9px; color: #c9c9db; font-size: .92rem; line-height: 1.65; }
  .doct { text-align: center; color: #71718c; font-size: .8rem; padding: 22px 0 6px; line-height: 1.8; }
  .jsonlink { text-align: center; margin-top: 10px; }
  .jsonlink a { color: #8a8aa5; font-size: .8rem; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="pulse"></span>
    <h1>ראש פינה — מגדלור ריבוני</h1>
    <div class="sub">קונסולה-חוץ-מכונה · חיה-גם-כשהמכונה-ושני-ענני-הגיט-נפלו</div>
  </header>

  <div class="stat">
    <b>חי-אחרון-ידוע:</b> <code>${fmt(state.lastKnownAlive.heartAt)}</code><br>
    <b>HEAD:</b> <code>${state.lastKnownAlive.head.slice(0, 12)}</code> ·
    <b>טביעת-זיכרון:</b> <code>${memorySha.split(':')[0]}</code>
  </div>

  <h2>ארבע-שכבות-הזיכרון-העצמאיות</h2>
  <div class="grid">${layersHtml}
  </div>

  <h2>מפת-ההערה (שיקום-מאפס)</h2>
  <div class="stat"><ol>${awakenHtml}</ol></div>

  <div class="doct">${state.doctrine}<br>נוצר-על-ידי-הלב-עצמו · ${fmt(state.generatedAt)}</div>
  <div class="jsonlink"><a href="/state.json">state.json — מצב-אחרון-למכונה</a></div>
</div>
<script type="application/json" id="sovereign-state">${json}</script>
</body>
</html>`;

  const stateJson = JSON.stringify(state, null, 2) + '\n';

  /* === העלאה-לוורסל (API-v13 · קבצים-מוטמעים · אפס-cli) === */
  let resp;
  try {
    resp = await fetch('https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: PROJECT,
        project: PROJECT,
        files: [
          { file: 'index.html', data: Buffer.from(html).toString('base64'), encoding: 'base64' },
          { file: 'state.json', data: Buffer.from(stateJson).toString('base64'), encoding: 'base64' },
        ],
        projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
      }),
    });
  } catch (e) { return fail('רשת: ' + (e instanceof Error ? e.message : '?')); }
  if (!resp.ok) {
    const body = await resp.text();
    const gateBlocked = resp.status === 403; // הרשאות-לא-ישתנו-בניסיון-חוזר — שער-הבעלים
    return fail(`deploy-http-${resp.status}`, { gateBlocked, tokenFp, last403At: nowIso(), body: body.slice(0, 300) });
  }
  const dep = await resp.json();

  /* === המתנה-קצרה-ל-READY === */
  let ready = dep.readyState || 'QUEUED';
  for (let i = 0; i < 12 && ready !== 'READY' && ready !== 'ERROR'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const st = await fetch(`https://api.vercel.com/v13/deployments/${dep.id}`);
      if (st.ok) ready = (await st.json()).readyState || ready;
    } catch { /* ממשיכים-לנסות */ }
  }

  /* === אימות-אפס-אמון: קריאה-חוזרת-מהעולם === */
  const stable = `https://${PROJECT.replace(/[^a-z0-9-]/gi, '').toLowerCase()}.vercel.app`;
  let live = 0;
  try { live = (await fetch(stable)).status; } catch { live = 0; }

  receipt(ready === 'READY' && live === 200, {
    deploymentId: dep.id,
    url: dep.url || '',
    stable,
    readyState: ready,
    liveHttp: live,
    head,
    memorySha,
  });
  console.log(`[beacon] ✔ מגדלור-${ready === 'READY' ? 'חי' : 'בבנייה'} · live=${live} · ${stable}`);
}

main();
