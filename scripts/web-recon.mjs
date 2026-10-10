/**
 * web-recon.mjs — סיור-רשת-ריבוני-תקופתי (T-64 · נתיב-שנפתח-ב-T-63)
 * ====================================================================
 * למה: הלב (heart-tick) קיבל ב-T-63 יכולת-חישה (web-sense) אך היא עמדה-בפני-עצמה —
 * הכלי-קיים אך-אף-פעימה-לא-מפעילה-אותו. מעתה: כל-פעימה-שמזמינה (כל-~שעה) הלב שולח
 * סייר-אחד: חיפוש-אחד-מדורג (Tavily×2→LangSearch) + ביקורת-חוץ-עצמית אחת (קריאת-
 * המגדלור-מבחוץ — הוכחה-שה-200-שלנו נראה-גם-מהאינטרנט, לא-רק-מה-curl-הפנימי).
 *
 * כלכלה (ייעול-ריבוני): החלטת-קצב בתוך-הסייר עצמו (לא-בהלב) — אם-הסיור-הקודם
 * היה-לפני-פחות-מ-55 דק' → יציאה-שקטה. אפס-בזבוז-API גם-בפעימות-צפופות.
 *
 * אפס-סודות: המפתחות-נשארים-בתוך-web-sense.mjs (env→כספת-ריצה→כספת-שחזור) —
 * הסייר-רק-מזמין-CLI וקורא-קבלת-JSON. פלט-הקבלות: כותרות-בלבד, אף-snippet.
 * fail-open: כל-כשל → קבלת-ok:false → יציאה-0 (הלב-אף-פעם-לא-נופל-בגלל-הסייר).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, truncateSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');                       // sanbox/
const SENSE = path.join(HERE, 'web-sense.mjs');
const RECEIPT = path.join(ROOT, 'receipts', 'web-recon.jsonl');
const LIGHTHOUSE = 'https://roshpinacare-sys.github.io/sovereign-lighthouse/';
const MIN_INTERVAL_MS = 55 * 60_000; // כלכלה: לפחות-שעה-בין-סיורים

/* --- סבב-נושאים: סיור-שוק/תשתית-לצורכי-הריבונות (מתחלף-מדי-יום-UTC) --- */
const TOPICS = [
  'מחירי דלק בישראל היום',
  'מצב רשת החשמל בישראל',
  'GitHub Actions status incidents',
  'autonomous agent resilience patterns',
];
const topic = TOPICS[Math.floor(Date.now() / 86_400_000) % TOPICS.length];

function receipt(obj) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
    try { appendFileSync(RECEIPT, line); } catch { /* fail-open */ }
  } catch { /* fail-open */ }
}

/* חיתוך-קבלות-בעלייה: מעבר-ל-300 שורות → 150 אחרונות */
try {
  if (existsSync(RECEIPT)) {
    const lines = readFileSync(RECEIPT, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length > 300) truncateSync(RECEIPT, 0), appendFileSync(RECEIPT, lines.slice(-150).join('\n') + '\n');
  }
} catch { /* fail-open */ }

/* --- שער-כלכלה: מתי-הסיור-הקודם? --- */
try {
  if (existsSync(RECEIPT)) {
    const lines = readFileSync(RECEIPT, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    const j = JSON.parse(last);
    if (j?.ts && Date.now() - new Date(j.ts).getTime() < MIN_INTERVAL_MS) {
      // T-66: nextRunAt-בקבלה — כך-הקבלה-מתעדת-בעצמה-מתי-הסיור-הבא (לא-נראה-כתקלה)
      receipt({ op: 'recon', ok: true, skipped: 'too-soon', lastTs: j.ts, nextRunAt: new Date(new Date(j.ts).getTime() + MIN_INTERVAL_MS).toISOString(), topic });
      process.exit(0);
    }
  }
} catch { /* קבלה-פגומה לא חוסמת סיור — נמשיך */ }

const t0 = Date.now();

/* --- ① חיפוש-אחד-מדורג (דרך-web-sense — המפתחות-אצלו) --- */
function senseCmd(args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn(process.execPath, [SENSE, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', () => {});
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', () => { clearTimeout(timer); resolve(out); });
    } catch { resolve(null); }
  });
}

function parseReceipt(stdout, op) {
  try {
    for (const line of String(stdout).trim().split('\n').reverse()) {
      if (line.includes(`"op":"${op}"`)) {
        const j = JSON.parse(line);
        if (typeof j.ok === 'boolean') return j;
      }
    }
  } catch { /* קבלה-פגומה → null */ }
  return null;
}

const searchOut = await senseCmd(['search', topic]);
const searchR = parseReceipt(searchOut, 'search');

/* --- ② ביקורת-חוץ-עצמית: קריאת-המגדלור-מבחוץ (Jina-reader) --- */
const readOut = await senseCmd(['read', LIGHTHOUSE]);
const readR = parseReceipt(readOut, 'read');

const durationMs = Date.now() - t0;
const ok = Boolean(searchR?.ok) && Boolean(readR?.ok);
receipt({
  op: 'recon', ok, topic, durationMs,
  search: searchR ? { ok: searchR.ok, via: searchR.via ?? null, results: searchR.results ?? null, http: searchR.http ?? null } : { ok: false, error: 'no-receipt' },
  lighthouseExternal: readR ? { ok: readR.ok, via: readR.via ?? null, bytes: readR.bytes ?? readR.length ?? null } : { ok: false, error: 'no-receipt' },
});
process.exit(0); // fail-open תמיד — הלב-לא-מושפע
