/**
 * server.ts — ליבת-שרת HQ: קונסולת-המפעיל של sanbox (פורט 3010).
 *
 * כללים:
 * - Bun.serve רק תחת `if (import.meta.main)` — ייבוא של הקובץ לא מאזין לשום פורט.
 * - אפס-תלויות: Bun.* + node:* בלבד. האימות מ-core/auth, הכספת מ-core/vault.
 * - אף-סוד-מלא לא יוצא מכאן: הכספת מוחזרת רק כמוסקים (vaultInventory).
 * - כל-ההודעות בעברית; כל-route עטוף try/catch; אין CORS (אפליקציה מקומית).
 *
 * Routes:
 *   GET  /            → panel.html (סשן-תקף) או login.html
 *   GET  /style.css…  → סטטי מ-public/ (עם הגנת path-traversal)
 *   POST /api/login   → 200 {ok:true}+cookie | 401 | 429
 *   POST /api/logout  → ביטול-סשן + ניקוי-cookie (דורש-auth)
 *   GET  /api/status  → מצב-מלא: uptime/ports/git/vault/scanLast/sessionExpiresAt (+ops)
 *   POST /api/action  → {action:'ping'} → {ok:true}; שאר-הפעולות בהוק core/ops (סוכן 42-c)
 */
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import {
  checkRateLimit,
  clearFails,
  createSession,
  destroySession,
  getSessionInfo,
  recordFail,
  validateSession,
  verifyPassword,
} from './core/auth';
import { vaultInventory } from './core/vault';

const ROOT = import.meta.dir;
const PUBLIC_DIR = path.join(ROOT, 'public');
const RECEIPTS_DIR = path.join(ROOT, 'receipts');
const SCAN_LAST_FILE = path.join(RECEIPTS_DIR, 'scan-last.json');
const AUTH_LOG_FILE = path.join(RECEIPTS_DIR, 'auth-log.jsonl');

const PORT = Number(process.env.HQ_PORT ?? 3010); // T-46: ניתן-לדריסה (HQ_PORT) — בסביבה-מקומית-שבה-3010-תפוס, HQ-עולה-על-3011-בלי-לגעת-בברירת-המחדל
const SESSION_COOKIE = 'hq_session';
const SESSION_MAX_AGE = 604800; // 7 ימים בשניות (תואם ל-TTL ב-core/auth)
const OPS_SPEC = './core/ops'; // הוק לסוכן 42-c — נטען דינמית, רך-כשל

/** ממשק-מינימלי ל-server של Bun (ללא-תלות ב-ambient-types). */
type HQServer = {
  requestIP?: (req: Request) => { address: string; family: string; port: number } | null;
};

/** חוזה-מתאר למודול core/ops של סוכן 42-c (אופציונלי — השרת חי גם בלעדיו). */
type OpsModule = {
  collectStatus?: () => Promise<unknown>;
  runAction?: (action: string, payload?: Record<string, unknown>) => Promise<unknown>;
};

async function loadOps(): Promise<OpsModule | null> {
  try {
    return (await import(OPS_SPEC)) as OpsModule;
  } catch {
    return null; // core/ops עדיין לא ממומש — לגיטימי
  }
}

/* ---------- עזרי-תשובה ---------- */

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function textHebrew(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/* ---------- עזרי-בקשה ---------- */

function getSessionToken(req: Request): string | null {
  // ערוץ-זהות-כפול: cookie (רגיל) או x-hq-session (fallback ל-iframe/HTTPS-תצוגה)
  const hdr = req.headers.get('x-hq-session');
  if (hdr && hdr.trim()) return hdr.trim();
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const v = part.slice(eq + 1).trim();
      return v || null;
    }
  }
  return null;
}

function isAuthed(req: Request): boolean {
  const token = getSessionToken(req);
  return token !== null && getSessionInfo(token) !== null;
}

function requestIp(req: Request, server: HQServer): string {
  // הפרוקסי מעביר את ה-IP האמיתי — כך נעילת-הניסיונות הוגנת לכל-לקוח בנפרד
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  try {
    return server?.requestIP?.(req)?.address ?? 'לא-ידוע';
  } catch {
    return 'לא-ידוע';
  }
}

/* ---------- קבצים-סטטיים (עם הגנת path-traversal) ---------- */

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeFor(absPath: string): string {
  return MIME_BY_EXT[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
}

let cachedPublicRoot: string | null = null;
function publicRootReal(): string {
  if (cachedPublicRoot === null) {
    try {
      cachedPublicRoot = realpathSync(PUBLIC_DIR);
    } catch {
      cachedPublicRoot = PUBLIC_DIR; // תיקייה חסרה — הבדיקות-בהמשך יחזירו 404
    }
  }
  return cachedPublicRoot;
}

/** מגיש-קובץ מ-public/ בלבד; null אם-לא-נמצא/חשד-חדירה. */
async function serveStatic(urlPath: string): Promise<Response | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const clean = path.normalize(decoded).replace(/^([/\\])+/, '');
  const abs = path.resolve(PUBLIC_DIR, clean);
  // הגנת-חדירה: הנתיב-הסופי חייב להישאר בתוך public/
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  let st: import('node:fs').Stats;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  try {
    const real = realpathSync(abs);
    const rootReal = publicRootReal();
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null; // symlink החוץ-החוצה
  } catch {
    return null;
  }
  const isHtml = abs.endsWith('.html');
  return new Response(Bun.file(abs), {
    status: 200,
    headers: { 'Content-Type': mimeFor(abs), 'Cache-Control': isHtml ? 'no-store' : 'no-cache' },
  });
}

/** GET / — panel.html למאומת, login.html לאחרים (גם /panel.html ישירות, ליתר-ביטחון). */
async function serveEntry(req: Request): Promise<Response> {
  const file = isAuthed(req) ? 'panel.html' : 'login.html';
  const res = await serveStatic('/' + file);
  return res ?? json({ ok: false, error: `קובץ הממשק ${file} חסר ב-public/` }, 404);
}

/* ---------- רישומי-אימות ---------- */

/** יומן-כניסות: {ts, ip, ok} בלבד — אף-פעם לא סיסמאות. */
function appendAuthLog(ip: string, ok: boolean): void {
  try {
    mkdirSync(RECEIPTS_DIR, { recursive: true });
    appendFileSync(AUTH_LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ip, ok }) + '\n');
  } catch (err) {
    console.error('[server] רישום יומן-האימות נכשל:', err instanceof Error ? err.message : err);
  }
}

/* ---------- Routes ---------- */

async function handleLogin(req: Request, server: HQServer): Promise<Response> {
  const ip = requestIp(req, server);
  if (!checkRateLimit(ip)) {
    appendAuthLog(ip, false);
    return json({ ok: false, error: 'ניסיונות כושלים רבים מדי — נסה שוב בעוד כמה דקות' }, 429);
  }
  let password: unknown;
  try {
    const body = (await req.json()) as { password?: unknown };
    password = body?.password;
  } catch {
    appendAuthLog(ip, false);
    return json({ ok: false, error: 'בקשה לא תקינה (JSON חסר)' }, 400);
  }
  const pw = typeof password === 'string' ? password : '';
  if (pw && verifyPassword(pw)) {
    clearFails(ip);
    const token = await createSession();
    appendAuthLog(ip, true);
    // טוקן-גם-בגוף: הפורטל משתמש-בו כערוץ-זהות-משני כשהדפדפן חוסם-עוגיות-שלישוניות (iframe)
    return json({ ok: true, token }, 200, {
      'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`,
    });
  }
  recordFail(ip);
  appendAuthLog(ip, false);
  return json({ ok: false, error: 'סיסמה שגויה' }, 401);
}

async function handleLogout(req: Request): Promise<Response> {
  const token = getSessionToken(req);
  if (!token || !validateSession(token)) return json({ ok: false, error: 'נדרש אימות' }, 401);
  destroySession(token);
  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  });
}

/* ---------- /api/status ---------- */

type VaultItem = Awaited<ReturnType<typeof vaultInventory>>[number];

type StatusBody = {
  ok: boolean;
  uptime: number;
  ports: { p3000: boolean; p3010: true };
  git: { branch: string; trackedFiles: number; lastCommit: string };
  vault: VaultItem[];
  scanLast: unknown;
  sessionExpiresAt: string | null;
  ops: unknown;
};

/** בדיקת-האזנה בפורט: net.connect עם timeout. */
function checkPort(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (up: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(up);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

const GIT_OPTS = { cwd: ROOT, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };

function gitInfo(): { branch: string; trackedFiles: number; lastCommit: string } {
  let branch = 'main';
  try {
    branch = execFileSync('git', ['branch', '--show-current'], GIT_OPTS).trim() || 'main';
  } catch { /* לא-ריפו? נשאר ברירת-מחדל */ }
  let trackedFiles = 0;
  try {
    trackedFiles = execFileSync('git', ['ls-files'], GIT_OPTS).split('\n').filter(Boolean).length;
  } catch { /* כשל — 0 כנה */ }
  let lastCommit = '(אין קומיטים עדיין)';
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], GIT_OPTS).trim().slice(0, 7);
    const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], GIT_OPTS).trim();
    lastCommit = `${hash} ${subject}`;
  } catch { /* ריפו-ללא-קומיטים */ }
  return { branch, trackedFiles, lastCommit };
}

function readScanLast(): unknown {
  try {
    if (!existsSync(SCAN_LAST_FILE)) return null;
    return JSON.parse(readFileSync(SCAN_LAST_FILE, 'utf8'));
  } catch (err) {
    console.error('[server] קריאת receipts/scan-last.json נכשלה:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function handleStatus(req: Request): Promise<Response> {
  const token = getSessionToken(req);
  const info = token ? getSessionInfo(token) : null;
  if (!token || !info) return json({ ok: false, error: 'נדרש אימות' }, 401);

  const [p3000, vault] = await Promise.all([checkPort(3000), vaultInventory()]);
  const body: StatusBody = {
    ok: true,
    uptime: Math.round(process.uptime() * 10) / 10,
    ports: { p3000, p3010: true },
    git: gitInfo(),
    vault,
    scanLast: readScanLast(),
    sessionExpiresAt: info.expiresAt,
    ops: null,
  };
  // הוק לסוכן 42-c: collectStatus מוסיף מצב-מערכות כשהמודול קיים; רך-כשל תמיד.
  const ops = await loadOps();
  if (ops && typeof ops.collectStatus === 'function') {
    try {
      body.ops = await ops.collectStatus();
    } catch (err) {
      console.error('[server] ops.collectStatus נכשל:', err instanceof Error ? err.message : err);
      body.ops = { ok: false, error: 'ops לא זמין' };
    }
  }
  return json(body);
}

/* ---------- /api/action ---------- */

async function handleAction(req: Request): Promise<Response> {
  if (!isAuthed(req)) return json({ ok: false, error: 'נדרש אימות' }, 401);
  let action = '';
  let payload: Record<string, unknown> = {};
  try {
    const body = (await req.json()) as { action?: unknown; password?: unknown };
    if (typeof body?.action === 'string') action = body.action.trim();
    // סיסמה-לפעולות-הכספת (למשל vault-restore): מחרוזת-בלבד, מועברת-רק-אל-runAction —
    // מעולם-לא-נרשמת, לא-נכתבת-לקבלה ולא-מוחזרת בתשובה.
    if (typeof body?.password === 'string' && body.password.length > 0) payload = { password: body.password };
  } catch {
    return json({ ok: false, error: 'בקשה לא תקינה (JSON חסר)' }, 400);
  }
  if (!action) return json({ ok: false, error: 'חסר שדה action' }, 400);
  if (action === 'ping') return json({ ok: true });
  // הוק לסוכן 42-c: כל-שאר-הפעולות מואצלות ל-core/ops אם-קיים (עם-payload-אופציונלי).
  const ops = await loadOps();
  if (ops && typeof ops.runAction === 'function') {
    try {
      const out = await ops.runAction(action, payload);
      return json(out ?? { ok: true });
    } catch (err) {
      console.error(`[server] ops.runAction('${action}') נכשל:`, err instanceof Error ? err.message : err);
      return json({ ok: false, error: 'הפעולה נכשלה' }, 500);
    }
  }
  return json({ ok: false, error: 'פעולה לא נתמכת עדיין' }, 400);
}

/* ---------- הנתב ---------- */

export async function hqFetch(req: Request, server: HQServer = {} as HQServer): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  try {
    if (method === 'GET') {
      if (pathname === '/' || pathname === '/panel.html') return await serveEntry(req);
      if (pathname === '/api/status') return await handleStatus(req);
      if (pathname.startsWith('/api/')) return json({ ok: false, error: 'נתיב לא קיים' }, 404);
      const file = await serveStatic(pathname);
      return file ?? textHebrew('404 — הדף לא נמצא', 404);
    }
    if (method === 'POST') {
      if (pathname === '/api/login') return await handleLogin(req, server);
      if (pathname === '/api/logout') return await handleLogout(req);
      if (pathname === '/api/action') return await handleAction(req);
      if (pathname.startsWith('/api/')) return json({ ok: false, error: 'נתיב לא קיים' }, 404);
    }
    return json({ ok: false, error: 'שיטה לא נתמכת' }, 405);
  } catch (err) {
    console.error('[server] שגיאה בלתי-צפויה בטיפול בבקשה:', pathname, err);
    if (pathname.startsWith('/api/')) return json({ ok: false, error: 'שגיאת שרת פנימית' }, 500);
    return textHebrew('500 — שגיאת שרת פנימית', 500);
  }
}

/* ---------- הפעלה (רק כראשי) ---------- */

if (import.meta.main) {
  Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: hqFetch });
  console.log(`[server] שרת-HQ מאזין על http://127.0.0.1:${PORT} — קונסולת-המפעיל (סיסמת-האם נדרשת).`);

  /* ריבונות-עצמית: מרים-את-המפקח-הריבוני (שמפקח-חזרה-על-ה-HQ ועל-האפליקציה) */
  try {
    const { spawn } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const pidfile = path.join(ROOT, 'db', 'supervisor.pid');
    let supervisorAlive = false;
    try {
      const pid = Number(readFileSync(pidfile, 'utf8').trim());
      if (pid) {
        process.kill(pid, 0);
        supervisorAlive = true;
      }
    } catch {
      supervisorAlive = false;
    }
    if (!supervisorAlive) {
      const child = spawn('bun', ['scripts/supervisor.ts'], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      console.log(`[server] המפקח-הריבוני הוקם (pid=${child.pid}) — הרשת-מפוקחת-תמידית.`);
    }
  } catch (err) {
    console.error('[server] הקמת-המפקח-נכשלה:', err instanceof Error ? err.message : err);
  }

  /* שומר-ריבונות-עצמאי (~/.sovereign): אם-אינו-חי — מריץ-את-המתקין-האידמפוטנטי ברקע.
     השומר-שורד-מחיקת-התיקייה-כולה-ומשחזר-את-הריפו-מ-GitHub — לא-חוסם-את-העלייה. */
  try {
    const { spawn: spawnDetached } = await import('node:child_process');
    const { existsSync: exSync, readFileSync: rfSync } = await import('node:fs');
    const osMod = await import('node:os');
    const sovDir = path.join(osMod.homedir(), '.sovereign');
    const guardianPidFile = path.join(sovDir, 'guardian.pid');
    let guardianAlive = false;
    try {
      if (exSync(guardianPidFile)) {
        const gpid = Number(rfSync(guardianPidFile, 'utf8').trim());
        if (gpid) {
          process.kill(gpid, 0);
          guardianAlive = true;
        }
      }
    } catch {
      guardianAlive = false;
    }
    if (!guardianAlive) {
      const child = spawnDetached('sh', ['scripts/install-guardian.sh'], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      console.log('[server] שומר-הריבונות-העצמאי לא חי — המתקין הורץ ברקע (~/.sovereign).');
    }
  } catch (err) {
    console.error('[server] בדיקת-שומר-הריבונות נכשלה:', err instanceof Error ? err.message : err);
  }

  /* דחיפה-עצמית-תקופתית: כל-30 דקות — סנכרון-זיכרון + commit + סריקה + push (רק-אם-יש-שינויים) */
  const AUTO_PUSH_MS = 30 * 60 * 1000;
  let autoPushBusy = false;
  const runAutoPush = async (): Promise<void> => {
    if (autoPushBusy) return;
    autoPushBusy = true;
    try {
      const ops = await import('./core/ops.ts');
      const r = (await ops.autoPush(false)) as Record<string, unknown>;
      console.log(`[server] דחיפה-עצמית: ok=${String(r.ok)} pushed=${String(r.pushed)} ${r.reason ? `(${String(r.reason)})` : ''}`);
      // T-55 — מראת-GitLab (החיים-השניים): אחרי-כל-דחיפת-אם-מוצלחת, מצית-מראה-GitLab
      // ברקע-נפרד (fail-open: כשל-GitLab-לעולם-לא-משפיע-על-הדחיפה-ל-GitHub-ולא-על-הלופ).
      if (r.ok) {
        try {
          const { spawn } = await import('node:child_process');
          const gl = spawn('bash', ['scripts/push-gitlab.sh'], {
            cwd: ROOT,
            detached: true,
            stdio: 'ignore',
          });
          gl.unref();
          console.log('[server] מראת-GitLab-הוצתה-ברקע (החיים-השניים, T-55).');
        } catch (glErr) {
          console.error('[server] הצתת-מראת-GitLab-נכשלה (fail-open):', glErr instanceof Error ? glErr.message : glErr);
        }
      }
    } catch (err) {
      console.error('[server] דחיפה-עצמית-נכשלה:', err instanceof Error ? err.message : err);
    } finally {
      autoPushBusy = false;
    }
  };
  const autoPushTimer = setInterval(() => { void runAutoPush(); }, AUTO_PUSH_MS);
  autoPushTimer.unref?.();
  // דחיפה-ראשונה-מושהית — מאחורי-העלייה, בלי-לחסום
  setTimeout(() => { void runAutoPush(); }, 45_000).unref?.();
  console.log('[server] דחיפה-עצמית-תקופתית פעילה (כל 30 דקות, סרוקה, רק-אם-יש-שינויים).');
}
