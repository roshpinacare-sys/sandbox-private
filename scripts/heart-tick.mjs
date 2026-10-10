/**
 * heart-tick.mjs — הלב-השני של sanbox (T-46): פעימה-עצמאית-לגמרי-מהעורק-הראשי.
 *
 * למה: המפעיל פתח שתי-תיקיות-גיט ("לא מפריע לי שיש 2") — ההלכה-המקצועית:
 * שני-לבבות-עצמאיים. העורק-הראשי (Sandbox/sovereign.yml) והלב-הזה (sanbox)
 * אינם-חולקים-שום-מצב, שום-סוד, שום-תלות — מיתה-בלב-אחד לא-משביתה-את-הרשת.
 *
 * חוקים:
 * - stdlib בלבד (node:crypto/fs/child_process/url) — אפס-תלויות; תואם-Node-ו-Bun.
 * - מצערת-פנימית 12 דק' (ב-CI בלבד; --force עוקף) — אפס-קבלות-כפולות.
 * - שרשרת: chain = sha256(head|prevChain|at)[:24] — כל-פעימה נשענת-על-קודמתה.
 * - קבלת-הרשומה: state/heart/last.json — מעוקבת-בגיט (ההיסטוריה-היא-הראיה).
 *   היומן-המקומי receipts/heart/ — מנוטרל-מגיט, פרט-מקומי-בלבד.
 * - אפס-סודות: הסקריפט לא קורא ולא כותב שום-טוקן; ה-push-נעשה-בשלב-נפרד
 *   ב-workflow עם GITHUB_TOKEN בלבד.
 * - כישלון-כנה: שגיאה = יציאה 1 (אף-קבלה-מזויפת).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_LATEST = path.join(ROOT, 'state', 'heart', 'last.json'); // מעוקב-בגיט
const H_DIR = path.join(ROOT, 'receipts', 'heart'); // מקומי-בלבד (gitignored)
const LOG = path.join(H_DIR, 'log.jsonl');
const MIN_INTERVAL_MS = 12 * 60 * 1000;
const TAIL = 500;

const FORCE = process.argv.includes('--force');
const CI = !!process.env.CI && !FORCE;

/** אות-ל-workflow: ticked=1 (פעימה-אמתית) / ticked=0 (מוצערת — אין-יורש-ממנה). */
function signal(kv) {
  try {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, kv);
  } catch { /* מקומי — אין-GITHUB_OUTPUT */ }
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim().slice(0, 12);
  } catch {
    return 'absent';
  }
}

function lastTickAt() {
  try {
    return Date.parse(JSON.parse(readFileSync(STATE_LATEST, 'utf8')).at) || 0;
  } catch {
    return 0;
  }
}

/* ---------- מצערת (CI בלבד; הקריאה-מקבלת-הרשומה-המעוקבת — עובדת-בין-ריצות) ---------- */
const last = lastTickAt();
const since = last > 0 ? Date.now() - last : -1;
if (CI && since >= 0 && since < MIN_INTERVAL_MS) {
  console.log(`[heart] ⏸ מוצער · last=${new Date(last).toISOString()} · ${Math.round(since / 1000)}s < 720s — אין-קבלה (השרשרת-ממשיכה-ב-workflow)`);
  signal('ticked=0\n');
  process.exit(0);
}

/* ---------- הפעימה ---------- */
const at = new Date().toISOString();
const head = gitHead();
const prev = (() => {
  try {
    return JSON.parse(readFileSync(STATE_LATEST, 'utf8')).chain || 'genesis';
  } catch {
    return 'genesis';
  }
})();
const chain = createHash('sha256').update(`${head}|${prev}|${at}`).digest('hex').slice(0, 24);

const tick = {
  schema: 'sanbox.heart/1',
  at,
  mode: CI ? 'ci' : 'local',
  head,
  prevChain: prev,
  chain,
};

try {
  mkdirSync(path.dirname(STATE_LATEST), { recursive: true });
  writeFileSync(STATE_LATEST, JSON.stringify(tick, null, 1) + '\n');
  mkdirSync(H_DIR, { recursive: true });
  writeFileSync(path.join(H_DIR, 'last.json'), JSON.stringify(tick, null, 1) + '\n');
  appendFileSync(LOG, JSON.stringify(tick) + '\n');
  // זנב-מוגבל — היומן-המקומי-לא-גדל-ללא-גבול
  const lines = readFileSync(LOG, 'utf8').trim().split('\n');
  if (lines.length > TAIL) writeFileSync(LOG, lines.slice(-TAIL).join('\n') + '\n');
} catch (err) {
  console.error('[heart] שמירת-קבלה-נכשלה:', err instanceof Error ? err.message : err);
  process.exit(1);
}

signal('ticked=1\n');
console.log(`[heart] ✔ ${at} · head=${head} · prev=${prev} · chain=${chain} · mode=${tick.mode}`);

/* === T-56: השכפול-הריבוני — עם-כל-פעימה, תמצית-החיים-נחתמת-גם-בענן-השני
 * (Supabase-פוסטגרס-חוץ-מכונה · fail-open · רק-מקומי — ב-CI-אין-כספת) === */
try {
  const { spawn } = await import('node:child_process');
  if (typeof CI === 'undefined' || !CI) {
    const child = spawn('bun', [path.join(HERE, 'state-replica.mjs')], {
      cwd: ROOT, detached: true, stdio: 'ignore',
    });
    child.unref();
  }
} catch { /* fail-open — הלב-אף-פעם-לא-נופל-בגלל-השכפול */ }

/* === T-57: המגדלור-הריבוני — עם-כל-פעימה-שבה-המצב-זז, index.html-ריבוני-מועלה-לוורסל
 * (קונסולה-שחיה-בלי-המכונה · שער-שינוי-בפנים · fail-open · רק-מקומי — ב-CI-אין-כספת) === */
try {
  const { spawn } = await import('node:child_process');
  if (typeof CI === 'undefined' || !CI) {
    const child = spawn('bun', [path.join(HERE, 'vercel-beacon.mjs')], {
      cwd: ROOT, detached: true, stdio: 'ignore',
    });
    child.unref();
  }
} catch { /* fail-open — הלב-אף-פעם-לא-נופל-בגלל-המגדלור */ }
