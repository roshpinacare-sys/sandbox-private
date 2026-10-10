/**
 * backup.ts — גיבוי-כספת-מוצפן-בתוך-הריפו + שחזור (Task 44-a).
 *
 * הבעיה-שהמודול-פותר: sanbox/secrets/ מנוטרל-מגיט — אם-התיקייה-תימחק, הסודות-אבודים-לנצח.
 * הפתרון: צופן-אחד-מוצפן (vault/vault-backup.enc) שנסע-עם-הריפו-הפרטי, מוצפן
 * AES-256-GCM במפתח-שנגזר-scrypt מסיסמת-האם (secrets/hq.password). הריפו-מכיל-רק-צופן —
 * אף-סוד-גלוי-לא-עובר-לגיט, והסריקה-מרשה-במפורש-את-הנתיב-הזה (allowlist ב-ops.ts).
 *
 * פורמט-קובץ-הגיבוי (לפני-base64):
 *   "SQV1" (4 בתים ASCII) | salt (16B) | iv (12B) | authTag (16B) | ciphertext (AES-256-GCM)
 * ה-magic מאפשר-זיהוי-קובץ-תקין-לפני-ניסיון-פענוח.
 *
 * מניעת-רעש-קומיטים: hash (sha256) על המיפוי-הממוין שם→תוכן של-קבצי-הכספת.
 * hash-זהה-מהקבלה → הצופן-לא-נכתב-מחדש (written:false) — אפס-שינויים-בגיט.
 *
 * כללי-ברזל:
 *  - אפס-תלויות: node:crypto + node:fs + node:path בלבד.
 *  - אף-פונקציה-כאן-לא מדפיסה ולא מחזירה תוכן-סודות או סיסמאות — רק מוסקים (hashShort, שמות, בייטים).
 *  - קבלת-הגיבוי ב-db/vault-backup.json (מחוץ-לגיט); קבלת-השחזור ב-receipts/vault-restore-last.json.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

// T-65: היה-מקודד-אבסולוטי — מכונה-חדשה-לא-הייתה-יכולה-לפתוח-את-הכספת (נתפס-במשפט-הריבונות).
// עתה: דינמי-ממיקום-הסקריפט (core/→sanbox) עם-עקיפה-סביבתית. התנהגות-חיה-זהה.
const SANDBOX_DIR = process.env.SANDBOX_DIR ?? path.resolve(import.meta.dir, '..');
const SECRETS_DIR = path.join(SANDBOX_DIR, 'secrets');
const VAULT_DIR = path.join(SANDBOX_DIR, 'vault');
const DB_DIR = path.join(SANDBOX_DIR, 'db');
const RECEIPTS_DIR = path.join(SANDBOX_DIR, 'receipts');

/** קובץ-הצופן-שנסע-עם-הריפו */
export const VAULT_ENC_PATH = path.join(VAULT_DIR, 'vault-backup.enc');
/** קבלת-הגיבוי-האחרונה (hash/ts/bytes/files) — מחוץ-לגיט */
export const VAULT_BACKUP_RECEIPT = path.join(DB_DIR, 'vault-backup.json');
/** קבלת-השחזור-האחרונה — מחוץ-לגיט */
const RESTORE_RECEIPT = path.join(RECEIPTS_DIR, 'vault-restore-last.json');
/** מטמון-האימות (scrypt-hash) — נמחק-אם-סיסמת-האם-שוחזרה-והשתנתה */
const AUTH_DB = path.join(DB_DIR, 'auth.json');

const MAGIC = 'SQV1'; // זיהוי-פורמט (4 בתים ASCII)
const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;

/** סיסמת-האם — מפתח-ההצפנה של-הגיבוי */
const PASSWORD_FILE = path.join(SECRETS_DIR, 'hq.password');

/** תוצאת-פעולת-כספת — מוסקת-בלבד (אף-שדה-כאן-אינו-מכיל-תוכן-סודות) */
export interface VaultBackupResult {
  ok: boolean;
  /** בגיבוי: האם-קובץ-הצופן-נכתב-בפעם-הזאת (false = hash-זהה, אין-רעש). בשחזור: תמיד false. */
  written: boolean;
  bytes?: number;
  files?: number;
  hashShort?: string;
  ts: string;
  error?: string;
}

// === עזרים ===

/** קריאת-קובץ-סוד-כבאפר-גולמי (לעולם-לא-יוצא-מהמודול) */
function readSecretBuffer(name: string): Buffer | null {
  try {
    return readFileSync(path.join(SECRETS_DIR, name));
  } catch {
    return null;
  }
}

/** כתיבת-קבלה-מוגנת (600) — קבלות-הן-מיטביות ולא-מפילות-את-הפעולה */
function writeReceipt(p: string, obj: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
    chmodSync(p, 0o600);
  } catch {
    /* קבלה-היא-מיטבית */
  }
}

// === גיבוי ===

/**
 * vaultBackup — איסוף-כל-קבצי-secrets/ (קבצים-בלבד), הצפנתם-כצופן-אחד-וכתיבתו
 * אל vault/vault-backup.enc. hash-זהה-לקבלה-הקודמת → לא-כותבים (אין-רעש-קומיטים).
 */
export async function vaultBackup(): Promise<VaultBackupResult> {
  const ts = new Date().toISOString();
  try {
    // 1) סיסמת-האם — מפתח-ההצפנה (נקראת-ונשארת-בזיכרון-בלבד)
    let password = '';
    try {
      password = readFileSync(PASSWORD_FILE, 'utf8').trim();
    } catch {
      password = '';
    }
    if (password.length === 0) {
      return { ok: false, written: false, ts, error: 'אין-סיסמה-או-כספת' };
    }

    // 2) איסוף-קבצי-הכספת — קבצים-בלבד (תיקיות-מדולגות), ממוינים-ליציבות-ה-hash
    let names: string[] = [];
    try {
      names = readdirSync(SECRETS_DIR)
        .filter((n) => {
          try {
            return statSync(path.join(SECRETS_DIR, n)).isFile();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      names = [];
    }
    if (names.length === 0) {
      return { ok: false, written: false, ts, error: 'אין-סיסמה-או-כספת' };
    }

    const files: { name: string; b64: string }[] = names.map((name) => ({
      name,
      b64: readFileSync(path.join(SECRETS_DIR, name)).toString('base64'),
    }));

    // 3) hash על המיפוי-הממוין שם→תוכן (ללא-חותמת-זמן — כדי-שתוכן-זהה-ייתן-hash-זהה)
    const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    const hashShort = hash.slice(0, 12);

    // 4) קבלה-קודמת — hash-זהה → אין-כתיבה (מניעת-רעש), רק-עדכון-חותמת-זמן
    const prevReceipt: { hash?: unknown; bytes?: unknown } | null = (() => {
      try {
        return JSON.parse(readFileSync(VAULT_BACKUP_RECEIPT, 'utf8')) as { hash?: unknown; bytes?: unknown };
      } catch {
        return null;
      }
    })();
    const prev = prevReceipt;
    if (prev && typeof prev.hash === 'string' && prev.hash === hash) {
      const prevBytes = typeof prev.bytes === 'number' ? prev.bytes : undefined;
      writeReceipt(VAULT_BACKUP_RECEIPT, { hash, ts, bytes: prevBytes, files: files.length, hashShort });
      return { ok: true, written: false, bytes: prevBytes, files: files.length, hashShort, ts };
    }

    // 5) הצפנה: salt+iv אקראיים-בכל-כתיבה, מפתח-scrypt, AES-256-GCM
    const salt = randomBytes(SALT_LEN);
    const key = scryptSync(password, salt, KEY_LEN);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const payload = Buffer.from(JSON.stringify({ v: 1, ts, files }), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const blob = Buffer.concat([
      Buffer.from(MAGIC, 'ascii'),
      salt,
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]);
    const encoded = blob.toString('base64');

    // 6) כתיבת-הצופן — תיקיית-vault/, הרשאות-600
    mkdirSync(VAULT_DIR, { recursive: true });
    writeFileSync(VAULT_ENC_PATH, encoded, 'utf8');
    chmodSync(VAULT_ENC_PATH, 0o600);

    // 7) קבלה-חדשה (בלי-תוכן — רק-hash/גדלים)
    const bytes = Buffer.byteLength(encoded, 'utf8');
    writeReceipt(VAULT_BACKUP_RECEIPT, { hash, ts, bytes, files: files.length, hashShort });

    return { ok: true, written: true, bytes, files: files.length, hashShort, ts };
  } catch {
    // שגיאה-גולמית-אינה-נחשפת — עלולה-להכיל-נתיבי-סודות; מוחזרת-הודעה-גנרית-ממוסכת
    return { ok: false, written: false, ts, error: 'גיבוי-הכספת-נכשל' };
  }
}

// === שחזור ===

/** שם-קובץ-מותר: אותיות/ספרות/קו-תחתון/נקודה/מקף/עברית — מניעת-מסלולים (../, /, \0) */
const SAFE_NAME_RE = /^[\w.\-\u0590-\u05FF]+$/;

/**
 * vaultRestore — פענוח vault/vault-backup.enc (אותו-scrypt/salt/iv-מהקובץ-עצמו),
 * בדיקת-שמות-מול-תבנית-בטוחה, כתיבה-חזרה אל secrets/ במצב 600.
 * אם-סיסמת-האם-שוחזרה-והשתנתה → db/auth.json-נמחק (האימות-ייבנה-מחדש-בעלייה-הבאה).
 */
export async function vaultRestore(password: string): Promise<VaultBackupResult & { restored?: string[] }> {
  const ts = new Date().toISOString();
  const restored: string[] = [];
  const skipped: string[] = [];
  try {
    if (typeof password !== 'string' || password.length === 0) {
      return { ok: false, written: false, ts, error: 'נדרשת סיסמה' };
    }

    // 1) קריאת-הצופן
    let encoded = '';
    try {
      encoded = readFileSync(VAULT_ENC_PATH, 'utf8');
    } catch {
      encoded = '';
    }
    if (encoded.length === 0) {
      return { ok: false, written: false, ts, error: 'אין-גיבוי-לשחזור' };
    }
    const blob = Buffer.from(encoded, 'base64');
    if (blob.length <= MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN || blob.subarray(0, MAGIC.length).toString('ascii') !== MAGIC) {
      return { ok: false, written: false, ts, error: 'סיסמה-שגויה-או-גיבוי-פגום' };
    }

    // 2) פענוח — salt/iv/authTag מתוך-הקובץ; GCM-מאמת-ומפיל-כל-שינוי-ביט
    const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
    const iv = blob.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
    const tag = blob.subarray(MAGIC.length + SALT_LEN + IV_LEN, MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN);
    const ciphertext = blob.subarray(MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN);
    let plain: Buffer;
    try {
      const key = scryptSync(password, salt, KEY_LEN);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      return { ok: false, written: false, ts, error: 'סיסמה-שגויה-או-גיבוי-פגום' };
    }

    // 3) בניית-ה-payload
    let payload: { v?: unknown; files?: unknown };
    try {
      payload = JSON.parse(plain.toString('utf8')) as typeof payload;
    } catch {
      return { ok: false, written: false, ts, error: 'גיבוי-פגום (payload לא תקין)' };
    }
    if (!payload || !Array.isArray(payload.files)) {
      return { ok: false, written: false, ts, error: 'גיבוי-פגום (אין-רשימת-קבצים)' };
    }

    // 4) סיסמת-האם-הקודמת (להשוואה-בזיכרון-בלבד — לא-נרשמת-בשום-קבלה)
    const prevPassword = readSecretBuffer('hq.password');

    // 5) כתיבה-חזרה — שם-חשוד → דילוג-וציון (בלי-תוכן)
    for (const item of payload.files) {
      const name = (item as { name?: unknown })?.name;
      const b64 = (item as { b64?: unknown })?.b64;
      if (typeof name !== 'string' || typeof b64 !== 'string' || !SAFE_NAME_RE.test(name)) {
        skipped.push(typeof name === 'string' && name.length > 0 ? name : '(שם-לא-תקין)');
        continue;
      }
      const buf = Buffer.from(b64, 'base64');
      const dest = path.join(SECRETS_DIR, name);
      try {
        mkdirSync(SECRETS_DIR, { recursive: true });
        writeFileSync(dest, buf, { mode: 0o600 });
        chmodSync(dest, 0o600);
        restored.push(name);
      } catch {
        skipped.push(name);
      }
    }

    // 6) סיסמת-אם-חדשה? → מטמון-האימות-מתרוקן (ייבנה-מחדש-אוטומטית)
    if (restored.includes('hq.password')) {
      const newPassword = readSecretBuffer('hq.password');
      const changed = prevPassword === null || newPassword === null || !prevPassword.equals(newPassword);
      if (changed) {
        try {
          rmSync(AUTH_DB, { force: true });
        } catch {
          /* מחיקה-מיטבית */
        }
      }
    }

    // 7) קבלת-שחזור — שמות-בלבד, אף-תוכן
    const ok = restored.length > 0;
    writeReceipt(RESTORE_RECEIPT, { ok, restored, ts });

    let error: string | undefined;
    if (restored.length === 0) {
      error = 'לא-שוחזר-אף-קובץ מהגיבוי';
    } else if (skipped.length > 0) {
      error = `שמות-חשודים-דולגו: ${skipped.join(', ')}`;
    }
    return { ok, written: false, files: restored.length, restored, ts, error };
  } catch {
    // שגיאה-גולמית-אינה-נחשפת
    return { ok: false, written: false, files: restored.length, restored, ts, error: 'שחזור-הכספת-נכשל' };
  }
}

// === הרצה-כסקריפט ===

if (import.meta.main) {
  // SOV_ACTION=backup|restore (ברירת-מחדל: backup); ל-restore — סיסמה מ-HQ_VAULT_PASS בלבד.
  // הפלט-הוא-JSON-ממוסק-בלבד: אין-תוכן-סודות, אין-סיסמה.
  const action = (process.env.SOV_ACTION ?? 'backup').trim();
  void (async () => {
    let res: VaultBackupResult & { restored?: string[] };
    if (action === 'restore') {
      const pw = process.env.HQ_VAULT_PASS ?? '';
      res = pw.length > 0
        ? await vaultRestore(pw)
        : { ok: false, written: false, ts: new Date().toISOString(), error: 'חסר HQ_VAULT_PASS' };
    } else if (action === 'backup') {
      res = await vaultBackup();
    } else {
      res = { ok: false, written: false, ts: new Date().toISOString(), error: 'SOV_ACTION לא מוכר (backup|restore)' };
    }
    console.log(JSON.stringify({
      ok: res.ok,
      written: res.written,
      bytes: res.bytes,
      files: res.files,
      hashShort: res.hashShort,
      restored: res.restored,
      ts: res.ts,
      error: res.error,
    }));
    process.exitCode = res.ok ? 0 : 1; // כישלון → קוד-יציאה-1 (מרשת-סקריפטים-להגיב)
  })();
}
