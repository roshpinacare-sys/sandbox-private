/**
 * vault-blob-probe.ts — T-66c: אבחון-אפס-אמון — אילו-בלובים-היסטוריים-נפתחים-בסיסמה.
 * לא-כותב-שום-סוד-לדיסק; קורא-קובץ-צופן-אחד (או-stdin) ומחזיר-ok/שגיאה-ממוסקת-בלבד.
 * שימוש: bun scripts/vault-blob-probe.ts <path-to-enc>   (הסיסמה: secrets/hq.password או env)
 */
import { readFileSync } from 'node:fs';
import { scryptSync, createDecipheriv } from 'node:crypto';

const MAGIC = Buffer.from('SQV1', 'ascii');
const SALT_LEN = 16, IV_LEN = 12, KEY_LEN = 32, TAG_LEN = 16;
const FILE = process.argv[2] ?? 'vault/vault-backup.enc';
const pass = (process.env.HQ_VAULT_PASS ?? readFileSync('secrets/hq.password', 'utf8').trim());

try {
  const blob = Buffer.from(readFileSync(FILE, 'utf8'), 'base64');
  if (blob.subarray(0, MAGIC.length).toString('ascii') !== 'SQV1') {
    console.log(JSON.stringify({ file: FILE, opens: false, reason: 'no-magic', bytes: blob.length }));
    process.exit(0);
  }
  const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = blob.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const tag = blob.subarray(MAGIC.length + SALT_LEN + IV_LEN, MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN);
  const ct = blob.subarray(MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN);
  try {
    const key = scryptSync(pass, salt, KEY_LEN);
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(ct), d.final()]);
    let files = -1;
    try { files = (JSON.parse(plain.toString('utf8'))?.files ?? []).length; } catch { /* מבנה-לא-צפוי */ }
    console.log(JSON.stringify({ file: FILE, opens: true, plainBytes: plain.length, files }));
  } catch (e) {
    console.log(JSON.stringify({ file: FILE, opens: false, reason: 'auth-fail', bytes: blob.length }));
  }
} catch (e) {
  console.log(JSON.stringify({ file: FILE, opens: false, reason: 'read-fail' }));
}
