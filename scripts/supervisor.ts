/**
 * supervisor.ts — המפקח-הריבוני של-הרשת (אפס-תלויות, stdlib-בלבד).
 *
 * תפקיד: הכל-שתלוי-סנדבוקס-חי-מכאן-תמידית:
 *  1. HQ (פורט 3010, sanbox/server.ts) — מת-→ מוקם מיד (דה-באנס 15s).
 *  2. אפליקציה ראשית (פורט 3000) — מת-→ חוק-שתי-המכות: שתי-בדיקות-רצופות-מתות
 *     → מעטפת-תקועה-מטוהרת (pkill) → `bun run dev` מנותק.
 *  3. בודק-שלא-נולדו-שני-מפקחים (pidfile) — מופע-יחיד.
 *  4. הלב-השני (T-49): heart-tick.mjs-מקומי-כל-15 דק' — עד-עכשיו-הלב-פעם-רק-ב-CI,
 *     וריפו-פרטי-חסום-מכסה-מימוט-אותו → דומם. עכשיו-פועם-גם-מקומית-תמיד.
 *  5. המראה-העננית (T-49): mirror-project.ts-כל-6 שעות (מצערת-פנימית-בתוך-הסקריפט)
 *     — SovereignConsole-המראה-הייתה-נדחפת-ידנית-בלבד; עכשיו-רענון-אוטונומי.
 *  6. התחדשות-קוד-חי (T-54): טביעת-אצבע-של-עץ-הקוד (server.ts+core+scripts ב-git-HEAD)
 *     — שינוי-קוד → ה-HQ-מוחזר-עם-הקוד-החדש. הלקח-מ-T-53: תיקון-על-הדיסק-אינו-פעיל
 *     בתהליך-חי-שעלה-לפני-התיקון; מעתה-המערכת-מתחדשת-מעצמה-תוך-טיק.
 *     שינויי-מצב/זיכרון (HQ-syncs-כל-30דק') אינם-מזיזים-את-טביעת-הקוד → אין-אתחולים-מיותרים.
 *
 * גנאלוגיה (T-54): שתי-דריסות-מתחלפות-בין-סוכנים — 4af1acf (19:10) הוסיף-את-שומרי-
 * T-47-ואיבד-את-רכבת-T-49; 32f2512 (19:21) החזיר-T-49-ואיבד-את-השומרים. הקובץ-הזה-
 * האיחוד-האמיתי-הראשון-שלשניהם — אפס-אובדן-תכונות.
 * גנאלוגיה (T-55): השער-הפך-מודע-לחץ — הראיות (04:46:37→04:56:44, בדיוק-קולדאון)
 * חשפו-הלו-מיחזור: עץ-3050-החם-נמדד-על-הסף-גם-ברגיעה → המשגיח-הרג-שרת-בריא-
 * כל-10-דק'. מעתה-מיחזור-רק-בלחץ-אמיתי (RSS>סף וגם MemAvailable<סף); אחרת mem-gate-hold.
 * גנאלוגיה (T-56): הדקס-הפך-פרודקשן-standalone (/home/z/dex-prod — נמדד: RSS-229MB-נגד-1094MB-dev,
 * -79%). dex-revive-מנותב-דרך-המשגר-הקנוני (dex-daemon/launch-prod.sh: heal+port-guard+self-heal —
 * במקום-לעוקף-את-שער-הפורט-וליצור-כותב-כפול-על-dex.db). קריסות-HQ-נראות-עתה-ב-db/hq.log
 * (הלקח: 8-החיות-05:48–06:00-היו-EADDRINUSE-שקט-מול-נושא-תלוי-מלחץ-בנייה — stdio:ignore בילע-ראיות).
 *
 * יולד-על-ידי server.ts בעלייה, boot-all.sh, או-השומר-החיצוני — תמיד-detached+unref.
 * קבלות: receipts/supervisor.jsonl (מוגבל), pid: db/supervisor.pid
 */
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { vaultBackup } from '../core/backup.ts'; // T-65: ריפוי-עצמי-תקופתי-של-מעטפת-הכספת

// נגזרות-מיקום-דינמיות: המפקח-חי-בתוך-הריפו — ROOT=sanbox, PROJECT=ההורה-שלו
const ROOT = path.resolve(import.meta.dir, '..');
const PROJECT = path.resolve(import.meta.dir, '..', '..');
const RECEIPTS = path.join(ROOT, 'receipts');
const DB = path.join(ROOT, 'db');
const EVENTS = path.join(RECEIPTS, 'supervisor.jsonl');
const PIDFILE = path.join(DB, 'supervisor.pid');

// T-66c: חיסון-הטעינה-העצמית — הפטולוגיה-שנמדדה-חי: המפקח-רץ-מקוד-ישן-בזיכרון (HQ_PORT=3010)
// בעוד-המקור-כבר-קנון-3011 → לולאת-החייאה-אינסופית (60 hq-revive · EADDRINUSE ב-db/hq.log).
// התרופה: בכל-טיק — אם-מט-המקור-שונה-מזה-שנטען → מצמיח-יורש-מהמקור-החי-ופורש.
// אפס-מפעיל-חוץ; תיקון-מקור-חי-תוך-מחזור-אחד. שינוי-מקור-הוא-אירוע-מבצעי, לא-בקשה.
const SELF_SRC = path.join(ROOT, 'scripts', 'supervisor.ts');
let selfSrcMtimeAtBoot = 0;
try { selfSrcMtimeAtBoot = statSync(SELF_SRC).mtimeMs; } catch { selfSrcMtimeAtBoot = 0; }

const TICK_MS = 10_000;
const HQ_PORT = Number(process.env.HQ_PORT ?? 3011); // T-66: HQ-קנוני-על-3011 (הדקס-בעלים-על-3010 — מלחמת-הפורטים-נגמרה)
const DEV_PORT = 3000;
const CONSOLE_PORT = 3050; // T-47: קונסולת-האם (חוזה-הדלת-הקדמית)
// T-64: עץ-zip נמחק מהדיסק ואינו בשום היסטוריית-מראה — קונסולת-האם עתה מהריפו-הריבוני (scripts/console-server.ts)
const BUN = process.execPath; // T-64: עצמאות-PATH — השומר מקים-אותנו בסביבה-חלקה (נמדד: spawn 'bun'→ENOENT posix_spawn)
const DEX_DAEMON = path.join(PROJECT, 'mini-services', 'dex-daemon'); // T-56: המשגר-הקנוני-של-הדקס (standalone-פרודקשן)
const HQ_SPAWN_DEBOUNCE_MS = 15_000;
const DEV_SPAWN_DEBOUNCE_MS = 60_000;
const CONSOLE_SPAWN_DEBOUNCE_MS = 30_000;
const MAX_EVENTS = 500;

// T-49: רכבת-התחזוקה-האוטונומית
const HEART_INTERVAL_MS = 15 * 60_000;      // פעימה-מקומית-של-הלב-השני
const MIRROR_INTERVAL_MS = 6 * 60 * 60_000; // רענון-המראה-העננית (מצערת-נוספת-בתוך-הסקריפט)
const VAULT_BACKUP_INTERVAL_MS = 10 * 60_000; // T-65: גיבוי-כספת-מרפא-עצמי-כל-10-דק'

// T-54: שער-הזיכרון — מיחזור-מבוקר-לפני-הקרנל
const MEM_GATE_RSS_MB = Number(process.env.MEM_GATE_RSS_MB ?? 1100); // סף-RSS (אב+ילדים) למיחזור-מבוקר
const MEM_PRESSURE_AVAIL_MB = Number(process.env.MEM_PRESSURE_AVAIL_MB ?? 350); // סף-ראיית-לחץ-כללי
const MEM_GATE_COOLDOWN_MS = 10 * 60_000; // שקט-אחרי-מיחזור (לתת-לשרת-החדש-להתחמם)

let hqLastSpawn = 0;
let hqHeldLogLastRun = 0; // T-56: מצערת-קבלת-hq-port-held-no-http (תצפית-על-נושא-תלוי)
let devLastSpawn = 0;
let consoleLastSpawn = 0;
let consoleSrcLogLastRun = 0; // T-64: דה-באנס-לוג-על-מקור-חסר (פעם-ב-10 דק' — לא-סערת-קבלות)
let devDeadStrikes = 0;
let heartLastRun = 0;
let memGateLastRun = 0; // T-55: FIX — היה-בשימוש-בלי-הצהרה-מאז-סוף-T-54 (tick-error-בכל-טיק-על-תהליך-חדש; החי-הישן-הסתיר-את-זה)
let memLogLastRun = 0;  // T-55: FIX — כנ"ל (מצערת-קבלות-תצפית)
let mirrorLastRun = 0;
let lastCodeFingerprint: string | null = null; // T-54: התחדשות-קוד-חי
let vaultLastRun = 0; // T-65: מתזמן-גיבוי-הכספת-המרפא

/** T-54: טביעת-אצבע-של-עץ-הקוד-הרלוונטי-לתהליכים-החיים (server.ts + core/ + scripts/). */
function codeFingerprint(): string | null {
  try {
    const parts: string[] = [];
    for (const p of ['server.ts', 'core', 'scripts']) {
      parts.push(
        execFileSync('git', ['rev-parse', `HEAD:${p}`], { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim(),
      );
    }
    return parts.join('|');
  } catch {
    return null; // אין-git/אין-HEAD — מדלגים-בשקט
  }
}

function log(event: Record<string, unknown>): void {
  try {
    mkdirSync(RECEIPTS, { recursive: true });
    mkdirSync(DB, { recursive: true });
    appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
    // הגבלת-גודל: שמירת-500 שורות-אחרונות
    try {
      const lines = readFileSync(EVENTS, 'utf8').trim().split('\n');
      if (lines.length > MAX_EVENTS) {
        writeFileSync(EVENTS, lines.slice(-MAX_EVENTS).join('\n') + '\n');
      }
    } catch { /* שקט */ }
  } catch { /* שקט */ }
}

function portAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function httpAlive(port: number, pathReq = '/', timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    // T-47: כל-תשובת-HTTP = השרת-עונה (200/401/429/502-מהשרת-עצמו = חי).
    // portAlive-בלבד-הוטעה-פעם (T-39: fd=41 · T-47: הגשר-502-על-3000) — HTTP-מדוד.
    const req = http.get({ host: '127.0.0.1', port, path: pathReq, timeout: timeoutMs }, (r) => {
      r.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function pidsByPattern(pattern: string): string[] {
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

function pkillPattern(pattern: string): boolean {
  try {
    execFileSync('pkill', ['-f', pattern], { timeout: 5000 });
    return true;
  } catch { return false; }
}

function spawnDetached(cmd: string, args: string[], cwd: string, logFile?: string): number | null {
  try {
    let stdio: ('ignore' | number)[] = ['ignore', 'ignore', 'ignore'];
    if (logFile) {
      // T-56: קריסות-שקטות-הן-חור-אבחון (נמדד: EADDRINUSE-נבלע-8-פעמים) — לוג-קובץ-לכל-שירות-קריטי
      try {
        mkdirSync(path.dirname(logFile), { recursive: true });
        const fd = openSync(logFile, 'a');
        stdio = ['ignore', fd, fd];
      } catch { /* נפילה-חזרה-ל-ignore */ }
    }
    const child = spawn(cmd, args, { cwd, detached: true, stdio });
    // T-64: שגיאת-spawn-אסינכרונית (ENOENT על בינארי/cwd) נפלטת-כאירוע-'error', לא-חריגה-מסונכרנת —
    // try/catch לא תופס אותה. בלי-המנוון: לולאת-קריסה-מלאה של המשגיח (נמדד-חי: 4+ revives 11:10–11:11).
    child.on('error', () => {});
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/* --- T-54: סכום-RSS של-תהליך-וצאצאיו-הישירים (אפס-תלויות · /proc בלבד) --- */
function pidTreeRssKB(pid: number): number {
  const readRss = (p: number): number => {
    try {
      const s = readFileSync(`/proc/${p}/status`, 'utf8');
      const m = s.match(/VmRSS:\s+(\d+)/);
      return m ? Number(m[1]) : 0;
    } catch { return 0; }
  };
  let total = readRss(pid);
  try {
    const kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 5000 })
      .split('\n').map(s => s.trim()).filter(Boolean);
    for (const k of kids) total += readRss(Number(k));
  } catch { /* שקט */ }
  return total;
}

async function tick(): Promise<void> {
  const now = Date.now();

  /* --- T-66c: חיסון-הטעינה-העצמית — מקור-זז → יורש-מהמקור-החי-ופרישה-מסודרת ---
   * סדר-הבריחה: pidfile-מנוטרל קודם (אחרת-היורש-מזוהה-ככפיל-ומת), אח"כ-הצמחה, ויציאה
 * אחרי-400ms (היורש-כותב-pidfile-משלו). השומר-החיצוני-רואה-מפקח-חי-תמיד. */
  try {
    const m = statSync(SELF_SRC).mtimeMs;
    if (selfSrcMtimeAtBoot && m !== selfSrcMtimeAtBoot) {
      log({ type: 'supervisor-self-reload', bootMtime: selfSrcMtimeAtBoot, srcMtime: m });
      try { writeFileSync(PIDFILE, '0'); } catch { /* היורש-יכתוב-את-שלו */ }
      spawnDetached(BUN, [SELF_SRC], ROOT, path.join(DB, 'supervisor.log'));
      setTimeout(() => process.exit(0), 400);
      return;
    }
  } catch { /* fail-open — תצפית-מקור-לא-תפיל-מפקח */ }

  /* --- T-54: התחדשות-קוד-חי — עץ-הקוד-זז → ה-HQ-מוחזר-עם-הקוד-החדש (רק-אם-הוא-חי;
   *    אם-הוא-מת-המנגנון-הרגיל-מקים-אותו-עם-הקוד-הטרי-ממילא) --- */
  const fp = codeFingerprint();
  if (fp && lastCodeFingerprint && fp !== lastCodeFingerprint && (await portAlive(HQ_PORT))) {
    pkillPattern('bun server\\.ts'); // רק-את-ה-HQ — לא-מפקח/שומר/אפליקציה
    log({ type: 'code-drift-renewal', from: lastCodeFingerprint.slice(0, 30), to: fp.slice(0, 30) });
  }
  if (fp) lastCodeFingerprint = fp;

  /* --- T-49: הלב-השני (מקומי) — פעימה-כל-15 דק' (detached; הסקריפט-כותב-קבלות-בעצמו) --- */
  if (existsSync(path.join(ROOT, 'scripts', 'heart-tick.mjs')) && now - heartLastRun > HEART_INTERVAL_MS) {
    heartLastRun = now;
    const pid = spawnDetached('bun', ['scripts/heart-tick.mjs'], ROOT);
    log({ type: 'heart-tick-spawn', pid });
  }

  /* --- T-49: המראה-העננית — רענון-כל-6 שעות (הסקריפט-מוצער-בעצמו-וכותב-קבלות) --- */
  if (existsSync(path.join(ROOT, 'scripts', 'mirror-project.ts')) && now - mirrorLastRun > MIRROR_INTERVAL_MS) {
    mirrorLastRun = now;
    const pid = spawnDetached('bun', ['scripts/mirror-project.ts'], ROOT);
    log({ type: 'mirror-spawn', pid });
  }

  /* --- T-65: ריפוי-עצמי-של-כספת-הסודות — כל-10-דק' ---
   * השיעור-מ-T-64: מעטפת-ישנה/מוחזרת (קדנס pull -X theirs) ישבה-שעות-בשקט —
   * הקבלה-טענה-תקינות-אך-הבלוב-לא-נפתח. vaultBackup-עתה-מאמת-פענוח-אמיתי
   * (vaultBlobOpens) וכותב-מחדש-מעטפת-פגומה. כישלון-כאן-לעולם-לא-מפיל-טיק. */
  if (now - vaultLastRun > VAULT_BACKUP_INTERVAL_MS) {
    vaultLastRun = now;
    try {
      const r = await vaultBackup();
      log({ type: 'vault-backup', ok: r.ok, written: r.written, files: r.files, bytes: r.bytes, hashShort: r.hashShort, error: r.error });
    } catch (e) {
      log({ type: 'vault-backup', ok: false, error: e instanceof Error ? e.message.slice(0, 80) : 'שגיאה' });
    }
  }

  /* --- T-54+T-55: שער-הזיכרון — מודע-לחץ (תיקון-הלו-המיחזור) ---
   * T-54 מדד: מיחזור-בכל-קולדאון (04:46:37→04:56:44 = בדיוק-10-דק') — העץ-החם-
   * של-3050 (~1.4GB) גבוה-מהסף-גם-כשהמכונה-רגועה (934MB-פנויים) → המשגיח-
   * הרג-שרת-בריא-כל-10-דק' לנצח (הלו-מיחזור). הקרנל-מאיים-רק-כשהמכונה-דחוקה.
   * הלקח (מאוטם-בכספת): למחזר-רק-כששני-התנאים-מתקיימים — RSS>סף **וגם**
   * MemAvailable<סף-לחץ. גדול-בלי-לחץ → mem-gate-hold (קבלה-מוצערת, לא-הרג). */
  if (now - memGateLastRun > MEM_GATE_COOLDOWN_MS) {
    let availKB = 0;
    try {
      availKB = Number((readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/) ?? [])[1] ?? 0);
    } catch { /* שקט */ }
    const pressured = availKB > 0 && availKB < MEM_PRESSURE_AVAIL_MB * 1024;
    // T-56: התבנית-מכסה-dev-של-הקוקפיט (3000) · dev-ישן-של-3050 · standalone (קונסולה+דקס).
    // הלקח-החי: הקוקפיט-ב-dev-התנפח-ל-1565MB-והיה-נקודה-עיוורת-של-השער (התבנית-הישנה-כיסתה-רק-3050)
    for (const pidStr of pidsByPattern('(next (dev|start) -p (3000|3050))|(standalone/server\\.js)')) {
      const pid = Number(pidStr);
      if (!pid) continue;
      const rss = pidTreeRssKB(pid);
      if (rss > MEM_GATE_RSS_MB * 1024) {
        if (!pressured) {
          if (now - memLogLastRun > 600_000) {
            memLogLastRun = now;
            log({ type: 'mem-gate-hold', pid, rssKB: rss, availKB, thresholdKB: MEM_GATE_RSS_MB * 1024 });
          }
          continue; // גדול-אבל-יש-מקום: להשאיר-חי (תיקון-T-55)
        }
        memGateLastRun = now;
        try { process.kill(pid, 'SIGTERM'); log({ type: 'mem-gate-recycle', pid, rssKB: rss, availKB, thresholdKB: MEM_GATE_RSS_MB * 1024 }); } catch { /* שקט */ }
        break; // מיחזור-אחד-לתיקון-לחץ-מספיק; הסריקה-תחזור-בקולדאון-הבא
      }
    }
    // ראיית-לחץ-זיכרון-כללית (תצפית-בלבד · מוצער-10-דק')
    if (pressured && now - memLogLastRun > 600_000) {
      memLogLastRun = now;
      log({ type: 'mem-pressure', availKB });
    }
  }

  /* --- HQ (HQ_PORT): מת → מיד-מוקם --- FIX(T-47): בדיקת-HTTP (לא-TCP-בלבד) ---
   * T-56: תצפית-על-נושא-תלוי — נמדד-חי (05:48–06:00): לחץ-בנייה-תלה-את-ה-HQ-מחזיק-פורט-
   * בלי-לענות → כל-spawn-מת-EADDRINUSE-בשקט → סערת-החיות. מעתה: קריסות-HQ-נופלות-ל-db/hq.log,
   * ופורט-תפוס-בלי-HTTP = קבלת-hq-port-held-no-http (מוצערת) — ראיה-לפני-כל-פעולה-עתידית. */
  if (!(await httpAlive(HQ_PORT, '/'))) {
    if ((await portAlive(HQ_PORT)) && now - hqHeldLogLastRun > 600_000) {
      hqHeldLogLastRun = now;
      log({ type: 'hq-port-held-no-http', port: HQ_PORT });
    }
    if (now - hqLastSpawn > HQ_SPAWN_DEBOUNCE_MS) {
      hqLastSpawn = now;
      const pid = spawnDetached(BUN, ['server.ts'], ROOT, path.join(DB, 'hq.log'));
      log({ type: 'hq-revive', pid, port: HQ_PORT, check: 'http' });
    }
  }

  /* --- קונסולת-האם (3050 · חוזה-הדלת-הקדמית): מתה → מוקמת (T-47) ---
   * המשגיח-של-zip (בון-טהור) מקים-ומחיה-את-next-dev-שלה-בלולאה; אנחנו
   * מקימים-את-המשגיח-עצמו. בדיקת-HTTP על-3050-ישירות (הגשר-לא-מעורב).
   * FIX(T-54): אם-המשגיח-כבר-חי — לא-שוגר-שני (פורט-מת-זמנית-בזמן-קימפול
   * יצר-משגיחים-כפולים; נמדד: 18329+28698). המשגיח-החי-מחיה-את-הילד-בעצמו. */
  if (!(await httpAlive(CONSOLE_PORT, '/'))) {
    const consoleEntry = path.join(ROOT, 'scripts', 'console-server.ts');
    if (!existsSync(consoleEntry)) {
      // T-64: מקור-חסר ≠ קריסה — תצפית-מדודה-בדה-באנס, והמשגיח-ממשיך-לשמור-על-השאר
      if (now - consoleSrcLogLastRun > 600_000) {
        consoleSrcLogLastRun = now;
        log({ type: 'console-source-missing', entry: 'scripts/console-server.ts' });
      }
    } else if (pidsByPattern('console-server.ts').length === 0 && now - consoleLastSpawn > CONSOLE_SPAWN_DEBOUNCE_MS) {
      consoleLastSpawn = now;
      const pid = spawnDetached(BUN, [consoleEntry], ROOT, path.join(DB, 'console.log'));
      log({ type: 'console-revive', pid, port: CONSOLE_PORT, via: 'repo-canonical' });
    }
  }

  /* --- דלת-הכניסה (3000 · חוזה-השלום · T-47 משופר): הגשר-הוא-הבעלים.
   * אם-הפורט-מת: ① דגדוג-הדקס (3010) — ה-handler מקשר-מחדש-את-הגשר
   * (ensurePreviewBridge); ② הדקס-עצמו-מת? מוקם (next dev -p 3010).
   * FIX(T-47): אין-pkill-גלובלי ('next-server' היה-הורג-את-עץ-הדקס!)
   * ואין-הקמת-cockpit-ישן-על-3000 (היה-מתחרה-בגשר — הפרת-חוזה). */
  if (await portAlive(DEV_PORT)) {
    devDeadStrikes = 0;
  } else {
    devDeadStrikes += 1;
    log({ type: 'dev-strike', strikes: devDeadStrikes });
    if (devDeadStrikes >= 2) {
      await httpAlive(3010, '/saos-dex/'); // דגדוג → ensurePreviewBridge מקשר-מחדש
      await new Promise(r => setTimeout(r, 2000));
      if (await portAlive(DEV_PORT)) {
        devDeadStrikes = 0;
        log({ type: 'bridge-rebound' });
      } else if (now - devLastSpawn > DEV_SPAWN_DEBOUNCE_MS) {
        devLastSpawn = now;
        if (!(await portAlive(3010))) {
          // T-56: דרך-המשגר-הקנוני (heal+port-guard+standalone) — לא-עוקף-את-שער-הפורט
          const pid = spawnDetached(BUN, ['run', 'dev'], DEX_DAEMON);
          log({ type: 'dex-revive', pid, port: 3010, via: 'dex-daemon-launch-prod' });
        }
        devDeadStrikes = 0;
      }
    }
  }
}

function writeOwnPid(): void {
  mkdirSync(DB, { recursive: true });
  writeFileSync(PIDFILE, String(process.pid));
}

function anotherSupervisorAlive(): boolean {
  try {
    if (!existsSync(PIDFILE)) return false;
    const pid = Number(readFileSync(PIDFILE, 'utf8').trim());
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0); // קיים?
    return true;
  } catch {
    return false;
  }
}

/* ---------- הפעלה (רק כראשי) ---------- */

async function main(): Promise<void> {
  mkdirSync(RECEIPTS, { recursive: true });
  mkdirSync(DB, { recursive: true });

  if (anotherSupervisorAlive()) {
    log({ type: 'supervisor-duplicate-exit' });
    process.exit(0);
  }
  writeOwnPid();
  log({ type: 'supervisor-start', pid: process.pid, tickMs: TICK_MS, memGateRssMB: MEM_GATE_RSS_MB });

  // לולאת-אם — לנצח (עד-שהמכונה-כבה; את-זה-boot-all.sh-משיב)
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log({ type: 'tick-error', msg: err instanceof Error ? err.message : String(err) });
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

if (import.meta.main) {
  void main();
}
