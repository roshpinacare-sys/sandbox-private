/**
 * supervisor.ts — המפקח-הריבוני של-הרשת (אפס-תלויות, stdlib-בלבד).
 *
 * תפקיד: הכל-שתלוי-סנדבוקס-חי-מכאן-תמידית:
 *  1. HQ (HQ_PORT, sanbox/server.ts) — מת-→ מוקם מיד (דה-באנס 15s) · בדיקת-HTTP.
 *  2. קונסולת-האם (3050 · חוזה-הדלת-הקדמית, T-47) — מתה → מוקמת-דרך-המשגיח-של-zip.
 *  3. דלת-הכניסה (3000 · חוזה-השלום, T-47) — הגשר-הוא-הבעלים: דגדוג-הדקס-במקום-pkill-גלובלי.
 *  4. רכבת-התחזוקה (T-49): heart-tick מקומי כל-15 דק' · mirror-project כל-6 שעות.
 *  5. שער-הזיכרון (T-54, שורש-נפילות-3050): next dev -p 3050 שתפח-מעל-סף-RSS
 *     ממוחזר-מבוקר-לפני-שהקרנל-מכריע — ראיה: dmesg OOM-kill next-server
 *     (pid 18816 · anon-rss 1535828kB · 2026-10-10 ~03:00) + 6-נפילות-3050-ב-3.5-שעות.
 *     ה-OOM-killer אינו-מבחין-בין-תהליכים — הוא-עלול-היה-להרוג-את-הדקס-או-הקוקפיט.
 *  6. בודק-שלא-נולדו-שני-מפקחים (pidfile) — מופע-יחיד.
 *
 * גנאלוגיה (T-54): שתי-דריסות-מתחלפות-בין-סוכנים — 4af1acf (19:10) הוסיף-את-שומרי-
 * T-47-ואיבד-את-רכבת-T-49; 32f2512 (19:21) החזיר-T-49-ואיבד-את-השומרים. הקובץ-הזה-
 * האיחוד-האמיתי-הראשון-שלשניהם — אפס-אובדן-תכונות.
 *
 * יולד-על-ידי server.ts בעלייה, boot-all.sh, או-השומר-החיצוני — תמיד-detached+unref.
 * קבלות: receipts/supervisor.jsonl (מוגבל), pid: db/supervisor.pid
 */
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// נגזרות-מיקום-דינמיות: המפקח-חי-בתוך-הריפו — ROOT=sanbox, PROJECT=ההורה-שלו
const ROOT = path.resolve(import.meta.dir, '..');
const PROJECT = path.resolve(import.meta.dir, '..', '..');
const RECEIPTS = path.join(ROOT, 'receipts');
const DB = path.join(ROOT, 'db');
const EVENTS = path.join(RECEIPTS, 'supervisor.jsonl');
const PIDFILE = path.join(DB, 'supervisor.pid');

const TICK_MS = 10_000;
const HQ_PORT = Number(process.env.HQ_PORT ?? 3010);
const DEV_PORT = 3000;
const CONSOLE_PORT = 3050; // T-47: קונסולת-האם (חוזה-הדלת-הקדמית)
const ZIP = path.join(PROJECT, 'zip');
const SAOS_DEX = path.join(PROJECT, 'saos-dex');
const HQ_SPAWN_DEBOUNCE_MS = 15_000;
const DEV_SPAWN_DEBOUNCE_MS = 60_000;
const CONSOLE_SPAWN_DEBOUNCE_MS = 30_000;
const MAX_EVENTS = 500;

// T-49: רכבת-התחזוקה-האוטונומית
const HEART_INTERVAL_MS = 15 * 60_000;      // פעימה-מקומית-של-הלב-השני
const MIRROR_INTERVAL_MS = 6 * 60 * 60_000; // רענון-המראה-העננית (מצערת-נוספת-בתוך-הסקריפט)

// T-54: שער-הזיכרון — מיחזור-מבוקר-לפני-הקרנל
const MEM_GATE_RSS_MB = Number(process.env.MEM_GATE_RSS_MB ?? 1100); // סף-RSS (אב+ילדים) למיחזור-מבוקר
const MEM_PRESSURE_AVAIL_MB = Number(process.env.MEM_PRESSURE_AVAIL_MB ?? 350); // סף-ראיית-לחץ-כללי
const MEM_GATE_COOLDOWN_MS = 10 * 60_000; // שקט-אחרי-מיחזור (לתת-לשרת-החדש-להתחמם)

let hqLastSpawn = 0;
let devLastSpawn = 0;
let consoleLastSpawn = 0;
let devDeadStrikes = 0;
let heartLastRun = 0;
let mirrorLastRun = 0;
let memGateLastRun = 0;
let memLogLastRun = 0;

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

function spawnDetached(cmd: string, args: string[], cwd: string): number | null {
  try {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
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

  /* --- T-54: שער-הזיכרון — מיחזור-מבוקר-לפני-הקרנל (שורש-נפילות-3050) ---
   * next dev -p 3050 חורג-מסף-RSS (אב+ילדים) → SIGTERM-מדויק-להורה-בלבד (לא-pkill-גלובלי!);
   * המשגיח-של-zip מחיה-אותו-מיידית, ו-console-revive-למטה-כגיבוי. קולדאון-10-דק'-לתת-להתחמם. */
  if (now - memGateLastRun > MEM_GATE_COOLDOWN_MS) {
    for (const pidStr of pidsByPattern('next dev -p 3050')) {
      const pid = Number(pidStr);
      if (!pid) continue;
      const rss = pidTreeRssKB(pid);
      if (rss > MEM_GATE_RSS_MB * 1024) {
        memGateLastRun = now;
        try { process.kill(pid, 'SIGTERM'); log({ type: 'mem-gate-recycle', pid, rssKB: rss, thresholdKB: MEM_GATE_RSS_MB * 1024 }); } catch { /* שקט */ }
        break; // מיחזור-אחד-לתיקון-לחץ-מספיק; הסריקה-תחזור-בקולדאון-הבא
      }
    }
    // ראיית-לחץ-זיכרון-כללית (תצפית-בלבד · מוצער-10-דק')
    try {
      const avail = Number((readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/) ?? [])[1] ?? 0);
      if (avail && avail < MEM_PRESSURE_AVAIL_MB * 1024 && now - memLogLastRun > 600_000) {
        memLogLastRun = now;
        log({ type: 'mem-pressure', availKB: avail });
      }
    } catch { /* שקט */ }
  }

  /* --- HQ (HQ_PORT): מת → מיד-מוקם --- FIX(T-47): בדיקת-HTTP (לא-TCP-בלבד) --- */
  if (!(await httpAlive(HQ_PORT, '/'))) {
    if (now - hqLastSpawn > HQ_SPAWN_DEBOUNCE_MS) {
      hqLastSpawn = now;
      const pid = spawnDetached('bun', ['server.ts'], ROOT);
      log({ type: 'hq-revive', pid, port: HQ_PORT, check: 'http' });
    }
  }

  /* --- קונסולת-האם (3050 · חוזה-הדלת-הקדמית): מתה → מוקמת (T-47) ---
   * המשגיח-של-zip (בון-טהור) מקים-ומחיה-את-next-dev-שלה-בלולאה; אנחנו
   * מקימים-את-המשגיח-עצמו. בדיקת-HTTP על-3050-ישירות (הגשר-לא-מעורב). */
  if (!(await httpAlive(CONSOLE_PORT, '/'))) {
    if (now - consoleLastSpawn > CONSOLE_SPAWN_DEBOUNCE_MS) {
      consoleLastSpawn = now;
      const pid = spawnDetached('bun', ['mini-services/web/index.ts'], ZIP);
      log({ type: 'console-revive', pid, port: CONSOLE_PORT });
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
          const pid = spawnDetached('bun', ['run', 'dev'], SAOS_DEX);
          log({ type: 'dex-revive', pid, port: 3010 });
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
