/**
 * guardian.ts — שומר-הריבונות-העצמאי (חי-מחוץ-לפרויקט: ~/.sovereign).
 *
 * למה-הוא-קיים: המפקח-הפנימי (sanbox/scripts/supervisor.ts) גר-בתוך-sanbox —
 * אם-התיקייה-נמחקת-שלמה, הוא-מת-איתה-ואין-מי-שישחזר. השומר-הזה-חי-בבית-המשתמש,
 * שורד-מחיקת-הפרויקט-כולו, ומשחזר-את-הריפו-מ-GitHub-בעצמו.
 *
 * סדר-הטיק (כל 30 שניות):
 *   a. שחזור-תיקיית-sanbox מהריפו-הפרטי (אם-חסרה/חסר-server.ts) — PAT-מ-remote.env
 *      + askpass-זמני + HQ_TOKEN-בסביבה (היגיינה-זהה-ל-pushToGitHub-ב-core/ops.ts)
 *   b. שחזור-כספת: vault/vault-backup.enc-קיים-אך-secrets/pat.env-חסר → vault-restore.ts
 *   c. המפקח-הפנימי: מת → מוקם (spawn-detached)
 *   d. HQ (3010): מת-**וגם-המפקח-מת** → מוקם (בלי-להתחרות-במפקח)
 *   e. אפליקציה (3000): רק-אם-המפקח-מת — חוק-שתי-המכות (כמו-במפקח)
 *
 * אפס-תלויות: node:* בלבד (רץ-תחת-bun). מופע-יחיד דרך guardian.pid.
 * קבלות: ~/.sovereign/guardian.jsonl (מוגבל-ל-500 שורות).
 * אף-סוד-לא-נכתב-לקבלות/לפלט — הטוקן-רק-בסביבת-תהליך-ה-git, askpass-נמחק-תמיד.
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

/* ---------- חוזה-מסלולים (~/.sovereign) ---------- */

const SOV_DIR = process.env.SOVEREIGN_DIR
  ? path.resolve(process.env.SOVEREIGN_DIR)
  : path.join(os.homedir(), '.sovereign');
const CONFIG_FILE = path.join(SOV_DIR, 'config.json');
const PIDFILE = path.join(SOV_DIR, 'guardian.pid');
const RECEIPTS_FILE = path.join(SOV_DIR, 'guardian.jsonl');
const REMOTE_ENV = path.join(SOV_DIR, 'remote.env');
const ASKPASS_PATH = path.join(SOV_DIR, '.askpass.sh');
// guardian.env — משתני-סביבה-אופציונליים-לשומר (כגון HQ_VAULT_PASS-לשחזור-כספת-אוטונומי);
// נכתב-על-ידי install-guardian.sh מ-secrets/hq.password במצב 600 — אותה-רמת-חשיפה-כמו-המקור.
const GUARDIAN_ENV = path.join(SOV_DIR, 'guardian.env');

type Config = { sanboxPath: string; projectPath: string; remoteUrl: string; mirrorUrl: string };

const DEFAULT_CONFIG: Config = {
  sanboxPath: '/home/z/my-project/sanbox',
  projectPath: '/home/z/my-project',
  remoteUrl: 'https://github.com/roshpinacare-sys/sanbox.git',
  mirrorUrl: 'https://github.com/roshpinacare-sys/SovereignConsole.git',
};

function loadConfig(): Config {
  try {
    const j = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    return {
      sanboxPath: typeof j.sanboxPath === 'string' && j.sanboxPath ? j.sanboxPath : DEFAULT_CONFIG.sanboxPath,
      projectPath: typeof j.projectPath === 'string' && j.projectPath ? j.projectPath : DEFAULT_CONFIG.projectPath,
      remoteUrl: typeof j.remoteUrl === 'string' && j.remoteUrl ? j.remoteUrl : DEFAULT_CONFIG.remoteUrl,
      mirrorUrl: typeof j.mirrorUrl === 'string' && j.mirrorUrl ? j.mirrorUrl : DEFAULT_CONFIG.mirrorUrl,
    };
  } catch {
    return DEFAULT_CONFIG; // אין-קונפיג → ברירות-המחדל-המוסכמות
  }
}

const CFG = loadConfig();
const SANBOX = CFG.sanboxPath;
const PROJECT = CFG.projectPath;

/* ---------- קבועים ---------- */

const TICK_MS = 30_000;
const MAX_EVENTS = 500;
const RESTORE_DEBOUNCE_MS = 5 * 60_000; // שחזור-תיקייה: ניסיון-לכל-היותר-אחת-ל-5 דק'
const VAULT_DEBOUNCE_MS = 5 * 60_000;   // ניסיון-שחזור-כספת: לכל-היותר-אחת-ל-5 דק'
const VAULT_NAG_MS = 30 * 60_000;       // 'vault-needs-password': קבלה-לכל-היותר-אחת-ל-30 דק'
const DEV_SPAWN_DEBOUNCE_MS = 60_000;   // חוק-שתי-המכות: השהיה-בין-הקמות
const CLONE_TIMEOUT_MS = 120_000;
const HQ_PORT = 3010;
const DEV_PORT = 3000;

/** זהה-במבנה-ל-ASKPASS_BODY-ב-core/ops.ts — הטוקן-עובר-רק-בסביבה (HQ_TOKEN). */
const ASKPASS_BODY =
  '#!/bin/sh\ncase "$1" in Username*) echo "x-access-token";; *) echo "$HQ_TOKEN";; esac';

/* ---------- מצב-פנימי ---------- */

let lastRestoreAttempt = 0;
let lastVaultAttempt = 0;
let lastVaultNag = 0;
let lastDevSpawn = 0;
let devDeadStrikes = 0;

/* ---------- קבלות (guardian.jsonl, מוגבל) ---------- */

function log(event: Record<string, unknown>): void {
  try {
    mkdirSync(SOV_DIR, { recursive: true });
    appendFileSync(RECEIPTS_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
    // הגבלת-גודל: 500 שורות-אחרונות
    try {
      const lines = readFileSync(RECEIPTS_FILE, 'utf8').trim().split('\n');
      if (lines.length > MAX_EVENTS) {
        writeFileSync(RECEIPTS_FILE, lines.slice(-MAX_EVENTS).join('\n') + '\n');
      }
    } catch { /* שקט */ }
  } catch { /* קבלה-היא-מיטבית */ }
}

/** מסתיר-סודות-מכל-מחרוזת-שעשויה-להירשם (הטוקן-לעולם-לא-בקבלות). */
function sanitize(msg: string, secret: string | null): string {
  let out = msg;
  if (secret && secret.length >= 8) out = out.split(secret).join('••••');
  return out.replace(/ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/g, '••••');
}

/* ---------- עזרי-רשת-ותהליכים ---------- */

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

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** קריאת-pidfile + בדיקת-חיות. */
function pidAliveFromFile(file: string): boolean {
  try {
    if (!existsSync(file)) return false;
    return pidAlive(Number(readFileSync(file, 'utf8').trim()));
  } catch {
    return false;
  }
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

function pidsByPattern(pattern: string): string[] {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

function pkillPattern(pattern: string): boolean {
  const r = spawnSync('pkill', ['-f', pattern], { timeout: 5000 });
  return r.status === 0;
}

/** git-אסינכרוני-עם-timeout; הפלט-מסונן-מסודות. */
function runGit(args: string[], cwd: string, env: Record<string, string | undefined>, secret: string | null): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, err: string) => {
      if (!settled) { settled = true; resolve({ ok, err }); }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, { cwd, env: { ...process.env, ...env } });
    } catch (e) {
      finish(false, sanitize(e instanceof Error ? e.message : String(e), secret));
      return;
    }
    let errOut = '';
    child.stderr?.on('data', (d: Buffer) => { errOut += String(d); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* שקט */ }
      finish(false, 'git הגיע לפסק-זמן');
    }, CLONE_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); finish(false, sanitize(e.message, secret)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0, code === 0 ? '' : sanitize(errOut, secret).slice(-400));
    });
  });
}

/* ---------- אימות: קריאת-PAT-מ-remote.env (פרסור-זהה-ל-readPat-ב-ops.ts) ---------- */

function readRemotePat(): string | null {
  let raw = '';
  try {
    raw = readFileSync(REMOTE_ENV, 'utf8');
  } catch {
    return null;
  }
  const stripQuotes = (s: string): string => s.replace(/^["']+|["']+$/g, '');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const kvs: { k: string; v: string }[] = [];
  const raws: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq > 0) kvs.push({ k: line.slice(0, eq).trim(), v: stripQuotes(line.slice(eq + 1).trim()) });
    else raws.push(stripQuotes(line));
  }
  const exact = kvs.find((x) => x.k.toUpperCase() === 'PAT' && x.v.length > 0);
  if (exact) return exact.v;
  const anyKv = kvs.find((x) => x.v.length > 0);
  if (anyKv) return anyKv.v;
  return raws.find((s) => s.length > 0) ?? null;
}

/* ---------- a) שחזור-תיקיית-sanbox ---------- */

async function restoreFolder(now: number): Promise<boolean> {
  if (now - lastRestoreAttempt <= RESTORE_DEBOUNCE_MS) return false;
  lastRestoreAttempt = now;

  const pat = readRemotePat();
  if (!pat) {
    log({ type: 'restore-blocked', reason: 'אין PAT ב-~/.sovereign/remote.env — הרץ את install-guardian.sh או הצב את הטוקן ידנית' });
    return false;
  }

  try {
    mkdirSync(SOV_DIR, { recursive: true });
    writeFileSync(ASKPASS_PATH, `${ASKPASS_BODY}\n`, { mode: 0o700 });
    chmodSync(ASKPASS_PATH, 0o700);
  } catch (e) {
    log({ type: 'restore-blocked', reason: `כתיבת-askpass נכשלה: ${sanitize(e instanceof Error ? e.message : String(e), pat)}` });
    return false;
  }

  // יעד-קיים-ולא-ריק → git-clone-יכשל; מדווחים-במקום-לנסות-שוב-ושוב-לחינם
  // (git-clone מותר-לתוך-תיקייה-קיימת-רק-אם-היא-ריקה לגמרי)
  let targetNonEmpty = false;
  try {
    targetNonEmpty = existsSync(SANBOX) && readdirSync(SANBOX).length > 0;
  } catch { targetNonEmpty = false; }

  let result: { ok: boolean; err: string };
  if (targetNonEmpty) {
    result = { ok: false, err: 'תיקיית-היעד קיימת ואינה ריקה — נדרשת התערבות ידנית (השומר אינו מוחק דבר)' };
  } else {
    mkdirSync(path.dirname(SANBOX), { recursive: true });
    result = await runGit(['clone', CFG.remoteUrl, SANBOX], path.dirname(SANBOX), {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: ASKPASS_PATH,
      HQ_TOKEN: pat,
    }, pat);
  }

  try { rmSync(ASKPASS_PATH, { force: true }); } catch { /* מחיקה-מיטבית */ }

  if (result.ok && existsSync(path.join(SANBOX, 'server.ts'))) {
    log({ type: 'folder-restored', sanboxPath: SANBOX });
    return true;
  }
  log({ type: 'restore-blocked', reason: result.ok ? 'השכפול הושלם אך server.ts עדיין חסר' : `שכפול נכשל: ${result.err}` });
  return false;
}

/* ---------- a2) שחזור-האפליקציה-המלאה-מהמראה-העננית (T-49) ---------- */

/**
 * restoreProject — אם-הפרויקט-עצמו (package.json) נמחק/אבד, השומר-משחזר-אותו
 * מהמראה-העננית (SovereignConsole — מרועננת-אוטומטית-על-ידי-המפקח-כל-6 שעות,
 * ובכל-רגע-היא-עדכנית-לפחות-לטיק-האחרון). אחרי-השכפול: bun install (והקמת-ה-DB
 * מהסכמה אם-חסר). כמו-restoreFolder — השומר-אינו-מוחק-דבר; תיקייה-קיימת-ולא-ריקה
 * בלי-package.json = חסימה-כנה-עם-קבלה.
 */
let lastProjectRestoreAttempt = 0;
const PROJECT_RESTORE_DEBOUNCE_MS = 5 * 60_000;

async function ensureProject(now: number): Promise<boolean> {
  const marker = path.join(PROJECT, 'package.json');
  if (existsSync(marker)) return true;
  if (now - lastProjectRestoreAttempt <= PROJECT_RESTORE_DEBOUNCE_MS) return false;
  lastProjectRestoreAttempt = now;

  const pat = readRemotePat();
  if (!pat) {
    log({ type: 'project-restore-blocked', reason: 'אין PAT ב-~/.sovereign/remote.env' });
    return false;
  }

  let targetNonEmpty = false;
  try {
    targetNonEmpty = existsSync(PROJECT) && readdirSync(PROJECT).length > 0;
  } catch { targetNonEmpty = false; }
  if (targetNonEmpty) {
    log({ type: 'project-restore-blocked', reason: 'תיקיית-הפרויקט קיימת ואינה ריקה ללא package.json — נדרשת התערבות ידנית (השומר אינו מוחק דבר)' });
    return false;
  }

  try {
    mkdirSync(SOV_DIR, { recursive: true });
    writeFileSync(ASKPASS_PATH, `${ASKPASS_BODY}\n`, { mode: 0o700 });
    chmodSync(ASKPASS_PATH, 0o700);
  } catch (e) {
    log({ type: 'project-restore-blocked', reason: `כתיבת-askpass נכשלה: ${sanitize(e instanceof Error ? e.message : String(e), pat)}` });
    return false;
  }

  const result = await runGit(['clone', CFG.mirrorUrl, PROJECT], path.dirname(PROJECT), {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: ASKPASS_PATH,
    HQ_TOKEN: pat,
  }, pat);

  try { rmSync(ASKPASS_PATH, { force: true }); } catch { /* מחיקה-מיטבית */ }

  if (!result.ok || !existsSync(marker)) {
    log({ type: 'project-restore-failed', reason: result.ok ? 'השכפול הושלם אך package.json עדיין חסר' : `שכפול נכשל: ${result.err}` });
    return false;
  }

  // תלויות (node_modules) — דרושות ל-`bun run dev`; הסכמה-מיושמת-אם-ה-DB-חסר
  log({ type: 'project-restored', projectPath: PROJECT, installing: true });
  const install = spawnSync('bun', ['install'], {
    cwd: PROJECT, timeout: 300_000, stdio: 'ignore',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  log({ type: 'project-install-done', code: install.status ?? null });
  if (!existsSync(path.join(PROJECT, 'db', 'custom.db'))) {
    const push = spawnSync('bunx', ['prisma', 'db', 'push', '--skip-generate'], {
      cwd: PROJECT, timeout: 120_000, stdio: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    log({ type: 'project-db-created', code: push.status ?? null });
  }
  return existsSync(marker);
}

/* ---------- b) שחזור-כספת ---------- */

function restoreVault(now: number): void {
  const backup = path.join(SANBOX, 'vault', 'vault-backup.enc');
  const patEnv = path.join(SANBOX, 'secrets', 'pat.env');
  if (!existsSync(backup) || existsSync(patEnv)) return;

  const pass = process.env.HQ_VAULT_PASS;
  if (!pass) {
    if (now - lastVaultNag > VAULT_NAG_MS) {
      lastVaultNag = now;
      log({ type: 'vault-needs-password', hint: 'הרץ: HQ_VAULT_PASS=... bun scripts/vault-restore.ts' });
    }
    return;
  }
  if (now - lastVaultAttempt <= VAULT_DEBOUNCE_MS) return;
  lastVaultAttempt = now;

  const script = path.join(SANBOX, 'scripts', 'vault-restore.ts');
  if (!existsSync(script)) {
    log({ type: 'vault-restore-failed', reason: 'scripts/vault-restore.ts חסר בריפו-המשוחזר' });
    return;
  }
  try {
    const r = spawnSync('bun', ['scripts/vault-restore.ts'], {
      cwd: SANBOX,
      timeout: 60_000,
      env: { ...process.env, HQ_VAULT_PASS: pass },
      stdio: 'ignore',
    });
    if (r.status === 0 && existsSync(patEnv)) {
      log({ type: 'vault-restored' });
    } else {
      log({ type: 'vault-restore-failed', code: r.status ?? null });
    }
  } catch (e) {
    log({ type: 'vault-restore-failed', reason: sanitize(e instanceof Error ? e.message : String(e), pass) });
  }
}

/* ---------- טעינת-סביבה-אופציונלית (guardian.env) ---------- */

/**
 * loadSovereignEnv — קורא ~/.sovereign/guardian.env (שורות KEY=VALUE) ומזריק
 * ל-process.env רק-משתנים-שעדיין-לא-מוגדרים. מטרה: שחזור-כספת-אוטונומי (HQ_VAULT_PASS)
 * גם-אם-השומר-הוקם-בלי-המשתנה. נקרא-בכל-טיק — קריאה-זולה-של-קובץ-זעיר.
 * הקובץ-נכתב-על-ידי install-guardian.sh במצב 600 ואינו-נכלל-בקבלות-או-בפלט.
 */
function loadSovereignEnv(): void {
  try {
    const raw = readFileSync(GUARDIAN_ENV, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key.length > 0 && value.length > 0 && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    /* אין-guardian.env — מותר; שחזור-הכספת-פשוט-יידרש-התערבות-בעלים */
  }
}

/* ---------- הטיק ---------- */

async function tick(): Promise<void> {
  const now = Date.now();

  /* אפס-סביבה: טעינת-guardian.env-בכל-טיק (מוזיל; רק-משתנים-חסרים-נקבעים)
   * — כך-שחזור-הכספת-עובד-גם-אם-השומר-הוקם-בלי-HQ_VAULT_PASS-בסביבה. */
  loadSovereignEnv();

  /* a. שחזור-תיקייה — אם-sanbox-חסר (או-server.ts-חסר) */
  let sanboxReady = existsSync(SANBOX) && existsSync(path.join(SANBOX, 'server.ts'));
  if (!sanboxReady) {
    sanboxReady = await restoreFolder(now);
    if (!sanboxReady) {
      // התיקייה-עדיין-לא-שוחזרה: המפקח-וה-HQ-בטח-אינם-ריצים — רק-האפליקציה-נבדקת (e)
      await ensureProject(now); // T-49: הפרויקט-משוחזר-מהמראה-גם-כש-sanbox-עדיין-חסרה
      await guardApp(now, false);
      return;
    }
  }

  /* b. שחזור-כספת */
  restoreVault(now);

  /* c. המפקח-הפנימי — מת → מוקם */
  const supervisorPidFile = path.join(SANBOX, 'db', 'supervisor.pid');
  const supervisorScript = path.join(SANBOX, 'scripts', 'supervisor.ts');
  let supervisorAlive = pidAliveFromFile(supervisorPidFile);
  if (!supervisorAlive && existsSync(supervisorScript)) {
    const pid = spawnDetached('bun', ['scripts/supervisor.ts'], SANBOX);
    log({ type: 'supervisor-revive', pid });
    supervisorAlive = pid !== null; // הוקם-זה-עתה → לא-מתחרים-על-ה-HQ-בטיק-הזה
  }

  /* d. HQ (3010) — מת-וגם-המפקח-מת → מוקם (בלי-התחרות) */
  if (!supervisorAlive && existsSync(path.join(SANBOX, 'server.ts'))) {
    if (!(await portAlive(HQ_PORT))) {
      const pid = spawnDetached('bun', ['server.ts'], SANBOX);
      log({ type: 'hq-revive', pid, port: HQ_PORT });
    }
  }

  /* a2. הפרויקט-המלא (T-49): אם-package.json-חסר → שחזור-מהמראה-העננית + bun install + DB */
  const projectReady = await ensureProject(now);

  /* e. אפליקציה (3000) — רק-אם-המפקח-מת (אחרת-המפקח-מטפל); והפרויקט-מוכן */
  await guardApp(now, supervisorAlive || !projectReady);
}

/** חוק-שתי-המכות על האפליקציה — פעיל-רק-כשהמפקח-הפנימי-מת. */
async function guardApp(now: number, supervisorAlive: boolean): Promise<void> {
  if (supervisorAlive) {
    devDeadStrikes = 0; // המפקח-חי — הוא-הבעלים-של-התחום; השומר-רק-מסומן
    return;
  }
  if (await portAlive(DEV_PORT)) {
    devDeadStrikes = 0;
    return;
  }
  devDeadStrikes += 1;
  if (devDeadStrikes < 2) return;

  const procPids = pidsByPattern('next dev -p 3000|next-server');
  if (procPids.length > 0) {
    // מעטפת-תקועה: תהליך-קיים-אבל-הפורט-מת → טיהור-והקמה
    pkillPattern('next dev -p 3000|next-server');
    log({ type: 'dev-wedged-purged', pids: procPids });
    await new Promise(r => setTimeout(r, 1000));
  }
  if (now - lastDevSpawn > DEV_SPAWN_DEBOUNCE_MS) {
    lastDevSpawn = now;
    const pid = spawnDetached('bun', ['run', 'dev'], PROJECT);
    log({ type: 'dev-revive', pid, port: DEV_PORT });
  }
  devDeadStrikes = 0;
}

/* ---------- מופע-יחיד + לולאת-נצח ---------- */

function writeOwnPid(): void {
  mkdirSync(SOV_DIR, { recursive: true });
  writeFileSync(PIDFILE, String(process.pid));
}

function anotherGuardianAlive(): boolean {
  try {
    if (!existsSync(PIDFILE)) return false;
    const pid = Number(readFileSync(PIDFILE, 'utf8').trim());
    if (!pid || pid === process.pid) return false;
    return pidAlive(pid);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  mkdirSync(SOV_DIR, { recursive: true });

  if (anotherGuardianAlive()) {
    log({ type: 'guardian-duplicate-exit', existingPid: (() => { try { return Number(readFileSync(PIDFILE, 'utf8').trim()); } catch { return null; } })() });
    process.exit(0);
  }
  writeOwnPid();
  log({ type: 'guardian-start', pid: process.pid, tickMs: TICK_MS, sanboxPath: SANBOX });

  // לולאת-נצח — השומר-אינו-נופל: כל-טיק-עטוף-בנפרד
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log({ type: 'tick-error', msg: sanitize(err instanceof Error ? err.message : String(err), null) });
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

if (import.meta.main) {
  void main();
}
