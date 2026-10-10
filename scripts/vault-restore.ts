#!/usr/bin/env bun
/**
 * vault-restore.ts — שחזור-כספת מגיבוי-מוצפן (CLI לבעלים) — Task 44-a.
 *
 * שימוש:
 *   HQ_VAULT_PASS="..." bun scripts/vault-restore.ts     ← סיסמה-מהסביבה
 *   bun scripts/vault-restore.ts                          ← סיסמה-מ-stdin (שאלה-ללא-הד)
 *   cat hq.password | bun scripts/vault-restore.ts        ← סיסמה-מצינור
 *
 * הסיסמה-נקראת מ-env HQ_VAULT_PASS ואם-חסרה — מ-stdin (שורה-אחת).
 * הפלט-הוא-תוצאה-ממוסקת-בלבד: ok/restored(שמות)/ts/error — אף-תוכן-סודות-ואף-סיסמה-אינם-מודפסים.
 * כישלון → exit 1.
 */
import { execSync } from 'node:child_process';

import { vaultRestore } from '../core/backup.ts';

/**
 * קריאת-שורה-אחת-מ-stdin בלי-readline (readline של-Bun נתקע-על-stdin-מוזרם).
 * נגמר-בירידת-שורה (מקלדת) או-בסוף-הזרמה (צינור/קובץ) — מה-שמגיע-קודם.
 */
async function readLineRaw(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const done = (val: string) => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onEnd);
      process.stdin.pause();
      resolve(val);
    };
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buf.search(/[\r\n]/);
      if (nl >= 0) done(buf.slice(0, nl));
    };
    const onEnd = () => done(buf);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onEnd);
  });
}

/** קריאת-הסיסמה-מ-stdin; כשיש-מסוף — הד-מושתק-זמנית-דרך-stty (ומוחזר-תמיד). */
async function readPasswordFromStdin(): Promise<string> {
  const isTTY = Boolean(process.stdin.isTTY);
  process.stdout.write('הזן סיסמת-אם: ');
  if (isTTY) {
    try {
      execSync('stty -echo', { stdio: ['inherit', 'ignore', 'ignore'] });
    } catch {
      /* stty-לא-זמין — ההד-יישאר, השחזור-עצמו-לא-נפגע */
    }
  }
  try {
    const line = await readLineRaw();
    return line.trim();
  } finally {
    if (isTTY) {
      try {
        execSync('stty echo', { stdio: ['inherit', 'ignore', 'ignore'] });
      } catch {
        /* מיטבי */
      }
      process.stdout.write('\n');
    }
  }
}

async function main(): Promise<number> {
  // סדר-קדימויות: env HQ_VAULT_PASS קודם; בהיעדרו — stdin.
  const envPass = process.env.HQ_VAULT_PASS ?? '';
  const password = envPass.length > 0 ? envPass : await readPasswordFromStdin();
  if (password.length === 0) {
    console.log(JSON.stringify({ ok: false, ts: new Date().toISOString(), error: 'לא-הוזנה-סיסמה (HQ_VAULT_PASS או stdin)' }));
    return 1;
  }
  const res = await vaultRestore(password);
  // פלט-ממוסק-בלבד — שמות-קבצים-מותרים, תוכן-אסור
  console.log(JSON.stringify({
    ok: res.ok,
    files: res.files,
    restored: res.restored,
    ts: res.ts,
    error: res.error,
  }));
  return res.ok ? 0 : 1;
}

const code = await main();
process.exit(code);
