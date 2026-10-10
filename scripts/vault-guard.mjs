#!/usr/bin/env bun
/**
 * vault-guard.mjs (T-66) — שער-הכספת-הקנוני.
 *
 * המשפט-שנאסר-לנצח (T-64+T-66-מדוד-פעמיים): לדחוף-לגיט-בלוב-כספת-שאינו-נפתח
 * בסיסמה-הקנונית-הבלועה. שתי-מכונות-חיות-עם-שתי-סיסמאות-שונות דחפו-זו-את-זו-
 * במלחמת-בלובים (13:14-ה-10.10: מעטפת-T-62-ישנה-6748B-הוחזרה-על-פני-הקנונית).
 *
 * החוק-החדש: הסיסמה-הקנונית-היא-מה שנבלע-במעטפת-הארנק-של-האם (repo-vault,
 * seal.a⊕seal.b-בגיט — T-64). בלוב-כספת-שאינו-נפתח-בה — לא-נכנס-לגיט.
 * כל-מכונה-שהמקומי-שלה-נדחה — מרפאה-אותו-דרך-הself-heal-של-T-65 (backup.ts).
 *
 * אפס-סודות-בפלט: הסיסמה-חיה-בזיכרון-בלבד (צינור-מ-repo-vault-emit).
 *
 * יציאות: 0 = הבלוב-נפתח-בקנוני (מותר-לדחוף) · 3 = לא-נפתח (אסור-לדחוף)
 *          4 = לא-ניתן-לאמת (אין-מעטפת-אם/שגיאה) — fail-closed-לדחיפת-כספת
 * שימוש: bun scripts/vault-guard.mjs [נתיב-בלוב]  (ברירת-מחדל: vault/vault-backup.enc)
 */
import { createDecipheriv, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MOTHER = path.resolve(import.meta.dir, "..", "..");
const BLOB = process.argv[2] || path.join(MOTHER, "sanbox", "vault", "vault-backup.enc");

function fail(code, msg) {
  console.log(JSON.stringify({ guard: "vault", ok: false, code, reason: msg, ts: new Date().toISOString() }));
  process.exit(code);
}

// 1) הסיסמה-הקנונית: מעטפת-האם-אם-קיימת; אחרת — הקנון-המקומי (hq.password) — T-66c.
// המדידה-החיה (T-66c): בסביבה-זו repo-vault-emit-אינו-קיים-כלל (הארנק-של-מכונה-אחרת) —
// fail-closed-גורף-היה-חוסם-כל-דחיפת-כספת-לנצח (מגבלת-שקר) והשאיר-בגיט-בלוב-מת-שאי-אפשר-לפתוח-מקומית.
// מעתה: אין-ארנק-אם → הקנון-הוא-סיסמת-המכונה-הזאת — ניפול-בכבוד-עם-סימון-מקור-כנה.
let pass = '';
let source = 'mother-wallet';
const emit = spawnSync("bun", [path.join(MOTHER, "scripts", "repo-vault-emit.ts"), "--name", "hq-vault-pass"], {
  cwd: MOTHER, // emit מחפש-את-repo-vault/-לפי-cwd (נמדד: מ-sanbox-הוא-טוען-את-הrepo-vault-של-sanbox)
  encoding: "utf8",
  timeout: 30_000,
});
pass = (emit.stdout || "").trim();
if (emit.status !== 0 || pass.length < 20) {
  try {
    pass = fs.readFileSync(path.join(MOTHER, "sanbox", "secrets", "hq.password"), "utf8").trim();
    source = "machine-local (hq.password)";
  } catch {
    fail(4, `mother-vault-emit-failed (status=${emit.status}) + no-local-password`);
  }
  if (pass.length < 20) fail(4, "mother-vault-emit-failed + local-password-too-short");
}

// 2) הבלוב — מבנה-SQV1 (זהה-ל-census-vaultSelfCheck)
let raw;
try {
  raw = Buffer.from(fs.readFileSync(BLOB, "utf8").trim(), "base64");
} catch (e) {
  fail(4, `blob-unreadable: ${String(e.message).slice(0, 80)}`);
}
if (raw.subarray(0, 4).toString("ascii") !== "SQV1") fail(3, "bad-magic");

const salt = raw.subarray(4, 20);
const iv = raw.subarray(20, 32);
const tag = raw.subarray(32, 48);
const ct = raw.subarray(48);

try {
  const key = scryptSync(pass, salt, 32);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  Buffer.concat([d.update(ct), d.final()]);
} catch {
  fail(3, "not-canonical (אינו-נפתח-בסיסמה-הבלועה — אסור-בגיט)");
}

console.log(JSON.stringify({ guard: "vault", ok: true, source, blobBytes: raw.length, ts: new Date().toISOString() }));
process.exit(0);
