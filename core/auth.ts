/**
 * core/auth.ts — אימות-המפעיל של שרת-HQ.
 *
 * עקרונות:
 * - הסיסמה-הראשית חיה רק ב-secrets/hq.password (מחוץ-לגיט) ולעולם אינה נשמרת,
 *   מודפסת או נרשמת בשום מקום. נשמר רק hash-scrypt (N=16384, מלח-אקראי 16B).
 * - אתחול-אוטומטי בטעינת-המודול: אם db/auth.json חסר/פגום — נבנה מהסיסמה, בצ'מוד 600.
 * - סשנים: טוקן-אקראי 32B-hex, תוקף 7 ימים, מתמשכים ב-db/sessions.json (600).
 * - הגבלת-קצב בזיכרון: 5 כשלים לכל-היותר בחלון 5 דקות לכל IP.
 *
 * אפס-תלויות: node:crypto + node:fs + node:path בלבד.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

const DB_DIR = path.resolve(import.meta.dir, '..', 'db');
const SECRETS_DIR = path.resolve(import.meta.dir, '..', 'secrets');
const AUTH_FILE = path.join(DB_DIR, 'auth.json');
const SESSIONS_FILE = path.join(DB_DIR, 'sessions.json');
const HQ_PASSWORD_FILE = path.join(SECRETS_DIR, 'hq.password');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ימים
const FILE_MODE = 0o600;

const FAIL_WINDOW_MS = 5 * 60 * 1000; // 5 דקות
const FAIL_MAX = 5; // מקס-כשלים ל-IP בחלון

export type SessionRecord = { token: string; createdAt: string; expiresAt: string };

let hashBuf: Buffer | null = null;
let saltBuf: Buffer | null = null;
const sessions = new Map<string, SessionRecord>();
const failsByIp = new Map<string, number[]>();

/* ---------- אתחול ---------- */

/** ניסיון-טעינת db/auth.json קיים; true אם-תקין. */
function tryLoadAuth(): boolean {
  if (!existsSync(AUTH_FILE)) return false;
  try {
    const raw = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as { hash?: unknown; salt?: unknown };
    if (typeof raw.hash !== 'string' || typeof raw.salt !== 'string') throw new Error('מבנה לא תקין');
    const h = Buffer.from(raw.hash, 'hex');
    const s = Buffer.from(raw.salt, 'hex');
    if (h.length !== KEY_LEN || s.length !== SALT_LEN) throw new Error('אורכי hash/salt לא תקינים');
    hashBuf = h;
    saltBuf = s;
    return true;
  } catch (err) {
    console.error('[auth] אזהרה: db/auth.json פגום — נבנה מחדש מ-secrets/hq.password (', err instanceof Error ? err.message : err, ')');
    return false;
  }
}

function initAuth(): void {
  try {
    mkdirSync(DB_DIR, { recursive: true });
  } catch (err) {
    console.error('[auth] יצירת תיקיית db נכשלה:', err instanceof Error ? err.message : err);
  }
  if (tryLoadAuth()) {
    console.log('[auth] אותחל: hash-scrypt קיים ב-db/auth.json (N=16384).');
    return;
  }
  if (!existsSync(HQ_PASSWORD_FILE)) {
    console.error('[auth] שגיאה קריטית: קובץ הסיסמה-הראשית secrets/hq.password חסר — אימות-המפעיל ידחה כל סיסמה עד שהקובץ יוחזר לכספת.');
    return; // hashBuf נשאר null → verifyPassword תחזיר תמיד false
  }
  try {
    const pw = readFileSync(HQ_PASSWORD_FILE, 'utf8').trim();
    if (!pw) {
      console.error('[auth] שגיאה: secrets/hq.password ריק — לא ניתן לאתחל אימות.');
      return;
    }
    const salt = randomBytes(SALT_LEN);
    const hash = scryptSync(pw, salt, KEY_LEN, SCRYPT_PARAMS);
    // נשמר hash+salt בלבד — הסיסמה עצמה לעולם לא.
    writeFileSync(AUTH_FILE, JSON.stringify({ hash: hash.toString('hex'), salt: salt.toString('hex') }, null, 2), { mode: FILE_MODE });
    try { chmodSync(AUTH_FILE, FILE_MODE); } catch { /* mode כבר הוחל בכתיבה */ }
    hashBuf = hash;
    saltBuf = salt;
    console.log('[auth] אותחל: hash-scrypt חדש (N=16384, מלח 16B) נשמר ב-db/auth.json בצ\'מוד 600.');
  } catch (err) {
    console.error('[auth] אתחול-האימות נכשל:', err instanceof Error ? err.message : err);
  }
}

/* ---------- סשנים ---------- */

function saveSessions(): void {
  try {
    mkdirSync(DB_DIR, { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.values()], null, 2), { mode: FILE_MODE });
    try { chmodSync(SESSIONS_FILE, FILE_MODE); } catch { /* mode כבר הוחל בכתיבה */ }
  } catch (err) {
    console.error('[auth] שמירת db/sessions.json נכשלה:', err instanceof Error ? err.message : err);
  }
}

function loadSessions(): void {
  if (!existsSync(SESSIONS_FILE)) return;
  try {
    const raw: unknown = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('מבנה לא תקין (צפוי מערך)');
    const now = Date.now();
    for (const r of raw) {
      const rec = r as Partial<SessionRecord>;
      if (rec && typeof rec.token === 'string' && typeof rec.createdAt === 'string' && typeof rec.expiresAt === 'string') {
        if (Date.parse(rec.expiresAt) > now) sessions.set(rec.token, rec as SessionRecord);
      }
    }
  } catch (err) {
    console.error('[auth] אזהרה: db/sessions.json פגום — כל-הסשנים בוטלו (', err instanceof Error ? err.message : err, ')');
  }
}

/** יוצר-סשן חדש (טוקן 32B-hex, תוקף 7 ימים) ומחזיר את הטוקן. */
export async function createSession(): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const now = Date.now();
  sessions.set(token, {
    token,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  saveSessions();
  return token;
}

/** מידע-הסשן אם-קיים-ובתוקף; אחרת null (סשן-שפג-נמחק במקום). */
export function getSessionInfo(token: string): SessionRecord | null {
  if (typeof token !== 'string' || !token) return null;
  const rec = sessions.get(token);
  if (!rec) return null;
  if (!(Date.parse(rec.expiresAt) > Date.now())) {
    sessions.delete(token);
    saveSessions();
    return null;
  }
  return rec;
}

/** בדיקת-תוקף סשן. */
export function validateSession(token: string): boolean {
  return getSessionInfo(token) !== null;
}

/** ביטול-סשן. */
export function destroySession(token: string): void {
  if (sessions.delete(token)) saveSessions();
}

/* ---------- סיסמה ---------- */

/** אימות-סיסמה מול-hash ה-scrypt שנשמר (השוואה בזמן-קבוע). */
export function verifyPassword(pw: string): boolean {
  if (typeof pw !== 'string' || !hashBuf || !saltBuf) return false;
  try {
    const candidate = scryptSync(pw, saltBuf, KEY_LEN, SCRYPT_PARAMS);
    return timingSafeEqual(candidate, hashBuf);
  } catch {
    return false;
  }
}

/* ---------- הגבלת-קצב (בזיכרון) ---------- */

/** true = מותר לנסות; false = חריגה (5 כשלים/5 דקות ל-IP). */
export function checkRateLimit(ip: string): boolean {
  if (typeof ip !== 'string' || !ip) return true;
  const now = Date.now();
  const arr = (failsByIp.get(ip) ?? []).filter((ts) => now - ts < FAIL_WINDOW_MS);
  if (arr.length !== (failsByIp.get(ip) ?? []).length) failsByIp.set(ip, arr); // גיזום
  return arr.length < FAIL_MAX;
}

/** רישום-כשל-אימות ל-IP. */
export function recordFail(ip: string): void {
  if (typeof ip !== 'string' || !ip) return;
  const now = Date.now();
  const arr = (failsByIp.get(ip) ?? []).filter((ts) => now - ts < FAIL_WINDOW_MS);
  arr.push(now);
  failsByIp.set(ip, arr);
}

/** ניקוי-כשלי-IP (לאחר הצלחה). */
export function clearFails(ip: string): void {
  failsByIp.delete(ip);
}

/* ---------- אתחול-אוטומטי בטעינה ---------- */

initAuth();
loadSessions();
