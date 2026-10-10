/**
 * קונסולת-האם (3050) — שרת-סטטי-קנוני (T-64)
 * ============================================
 * גנאלוגיה: הקונסולה-הישנה חיתה ב-/home/z/my-project/zip/mini-services/web — עץ-שנמחק
 * מהדיסק ואינו בשום היסטוריית-מראה (SovereignConsole·GitHub·GitLab — נבדק-היסטורית-מלאה).
 * העץ-הסטטי Console/ שרד ומשוקף-לענן — לכן הקונסולה-עתה נולדת-מהריפו-הריבוני עצמו:
 * שורדת-מחיקות-סנדבוקס (git), נסרקת-למראה (SovereignConsole), ומוקמת-אוטומטית על-ידי
 * המשגיח (T-64: שער-מקור-חסר + spawn-אסינכרוני-מנוון).
 *
 * עקרונות: בון-טהור (אפס-תלויות) · אפס-סודות · קריאה-בלבד מתוך Console/ (מנע-מסלול)
 * · קבלות-מוגבלות (receipts/console-server.jsonl, חיתוך-בעלייה) · fail-safe (ברירת-404).
 *
 * קבלת-פעולה: GET / → 200 קונסולה · GET /healthz → JSON חיות · המשגיח מודד HTTP כל-10 שנ'.
 */
import http from 'node:http';
import path from 'node:path';
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from 'node:fs';

const PORT = Number(process.env.CONSOLE_PORT ?? 3050);
const ROOT = path.resolve(import.meta.dir, '..');            // sanbox/
const PROJECT = path.resolve(ROOT, '..');                   // /home/z/my-project
const CONSOLE_DIR = path.join(PROJECT, 'Console');
const RECEIPT = path.join(ROOT, 'receipts', 'console-server.jsonl');

/* --- MIME מינימלי (העץ-הסטטי: html/js/css/תמונות/פונטים) --- */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8',
};

function receipt(obj: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
    try { appendFileSync(RECEIPT, line); } catch { /* הקבלה-אף-פעם-לא-מפילה-את-השרת */ }
  } catch { /* fail-open */ }
}

/* חיתוך-קבלות-בעלייה (תבנית-המשגיח): מעבר-ל-400 שורות → 200 אחרונות */
try {
  if (existsSync(RECEIPT)) {
    const lines = readFileSync(RECEIPT, 'utf8').trim().split('\n');
    if (lines.length > 400) truncateSync(RECEIPT, 0), appendFileSync(RECEIPT, lines.slice(-200).join('\n') + '\n');
  }
} catch { /* fail-open */ }

/* --- הצלבה: נתיב-בטוח בתוך Console/ בלבד (מנע-מסלול-מעלה) --- */
function safeFile(urlPath: string): string | null {
  try {
    const rel = decodeURIComponent(urlPath).replace(/^\/+/, '').split('?')[0].split('#')[0];
    if (rel.includes('..') || rel.includes('\0')) return null;
    const abs = path.resolve(CONSOLE_DIR, rel);
    if (!abs.startsWith(CONSOLE_DIR + path.sep) && abs !== CONSOLE_DIR) return null;
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    if (st.isDirectory()) return safeFile(path.join(rel, 'index.html'));
    return st.isFile() ? abs : null;
  } catch { return null; }
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];
  try {
    if (urlPath === '/healthz') {
      const body = JSON.stringify({ ok: true, svc: 'mother-console', port: PORT, ts: new Date().toISOString() });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    /* --- T-66c: עורקות-חיים — state.json+grid.json+הדף-החי, מוכתבים-מהלב (sanbox/public) ---
     * הפטולוגיה-שנמדדה: Console/-הסטטי-לא-החזיק-state.json (404-חי) והדף-המקומי-היה-ארטיפקט-ישן.
     * מעתה: הקונסולה-מגישה-את-אותם-קבצים-שהלב-מכתיב-למגדלור — מקור-אמת-יחיד, אפס-עותקים-סטטיים. */
    const liveArteries: Record<string, string> = {
      '/state.json': path.join(ROOT, 'public', 'state.json'),
      '/grid.json': path.join(ROOT, 'public', 'grid.json'),
      '/lighthouse': path.join(ROOT, 'public', 'index.html'),
    };
    if (liveArteries[urlPath]) {
      const f = liveArteries[urlPath];
      if (existsSync(f)) {
        const ext = path.extname(f).toLowerCase();
        res.writeHead(200, {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'x-sovereign-console': 'mother/2 (T-66c live-artery)',
        });
        res.end(readFileSync(f));
      } else {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('503 — עורק-טרם-נולד (הלב-יכתוב-בפעימה-הבאה)');
      }
      return;
    }
    const file = safeFile(urlPath === '/' ? 'index.html' : urlPath) ?? safeFile('404.html');
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 — לא-נמצא (קונסולת-האם)');
      return;
    }
    const is404 = path.basename(file) === '404.html' && urlPath !== '/404.html';
    const ext = path.extname(file).toLowerCase();
    res.writeHead(is404 ? 404 : 200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-sovereign-console': 'mother/1 (T-64)',
    });
    res.end(readFileSync(file));
  } catch (e) {
    try {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('500 — תקלה-פנימית');
    } catch { /* השרת-ממשיך */ }
    receipt({ op: 'serve-error', path: urlPath, error: e instanceof Error ? e.message : String(e) });
  }
});

server.on('error', (e) => {
  // EADDRINUSE = כבר-חי (המשגיח-לא-ישגר-כפול — T-54 חוזר) — יוצאים-בכן, לא-קריסה
  receipt({ op: 'server-error', error: (e as Error).message });
  process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  receipt({ op: 'boot', ok: true, port: PORT, consoleDir: CONSOLE_DIR, exists: existsSync(CONSOLE_DIR) });
});

process.on('SIGTERM', () => { try { server.close(); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { server.close(); } catch {} process.exit(0); });
