/**
 * supervisor.ts — המפקח-הריבוני של-הרשת (אפס-תלויות, stdlib-בלבד).
 *
 * תפקיד: הכל-שתלוי-סנדבוקס-חי-מכאן-תמידית:
 *  1. HQ (פורט 3010, sanbox/server.ts) — מת-→ מוקם מיד (דה-באנס 15s).
 *  2. אפליקציה ראשית (פורט 3000) — מת-→ חוק-שתי-המכות: שתי-בדיקות-רצופות-מתות
 *     → מעטפת-תקועה-מטוהרת (pkill) → `bun run dev` מנותק.
 *  3. בודק-שלא-נולדו-שני-מפקחים (pidfile) — מופע-יחיד.
 *
 * יולד-על-ידי server.ts בעלייה או boot-all.sh — תמיד-detached+unref.
 * קבלות: receipts/supervisor.jsonl (מוגבל), pid: db/supervisor.pid
 */
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = '/home/z/my-project/sanbox';
const PROJECT = '/home/z/my-project';
const RECEIPTS = path.join(ROOT, 'receipts');
const DB = path.join(ROOT, 'db');
const EVENTS = path.join(RECEIPTS, 'supervisor.jsonl');
const PIDFILE = path.join(DB, 'supervisor.pid');

const TICK_MS = 10_000;
const HQ_PORT = 3010;
const DEV_PORT = 3000;
const HQ_SPAWN_DEBOUNCE_MS = 15_000;
const DEV_SPAWN_DEBOUNCE_MS = 60_000;
const MAX_EVENTS = 500;

let hqLastSpawn = 0;
let devLastSpawn = 0;
let devDeadStrikes = 0;

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

async function tick(): Promise<void> {
  const now = Date.now();

  /* --- HQ (3010): מת → מיד-מוקם --- */
  if (!(await portAlive(HQ_PORT))) {
    if (now - hqLastSpawn > HQ_SPAWN_DEBOUNCE_MS) {
      hqLastSpawn = now;
      const pid = spawnDetached('bun', ['server.ts'], ROOT);
      log({ type: 'hq-revive', pid, port: HQ_PORT });
    }
  }

  /* --- אפליקציה-ראשית (3000): חוק-שתי-המכות --- */
  if (await portAlive(DEV_PORT)) {
    devDeadStrikes = 0;
  } else {
    devDeadStrikes += 1;
    log({ type: 'dev-strike', strikes: devDeadStrikes });
    if (devDeadStrikes >= 2) {
      const procPids = pidsByPattern('next dev -p 3000|next-server');
      if (procPids.length > 0) {
        // מעטפת-תקועה: תהליך-קיים-אבל-הפורט-מת → טיהור-והקמה
        pkillPattern('next dev -p 3000|next-server');
        log({ type: 'dev-wedged-purged', pids: procPids });
        await new Promise(r => setTimeout(r, 1000));
      }
      if (now - devLastSpawn > DEV_SPAWN_DEBOUNCE_MS) {
        devLastSpawn = now;
        const pid = spawnDetached('bun', ['run', 'dev'], PROJECT);
        log({ type: 'dev-revive', pid, port: DEV_PORT, strikes: devDeadStrikes });
      }
      devDeadStrikes = 0;
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
  log({ type: 'supervisor-start', pid: process.pid, tickMs: TICK_MS });

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
