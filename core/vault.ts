/**
 * core/vault.ts — קורא-הכספת של sanbox (תיקיית secrets/, מנוטרלת-מגיט).
 *
 * חוק-ברזל:
 * - ערכי-סוד מלאים לא יוצאים מהמודול אלא רק דרך vaultTexts(), שנועדה לשימוש-פנימי
 *   בלבד (סריקת-סודות לפני-דחיפה) — אסור להחזיר אותה ללקוח או להדפיס אותה.
 * - כל-פלט שנועד לתצוגה/לרשת עובר מיסוך maskSecret(): 4 ראשונים + •••• + 4 אחרונים.
 *
 * אפס-תלויות: node:fs + node:path בלבד.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SECRETS_DIR = path.resolve(import.meta.dir, '..', 'secrets');

export type VaultItem = { name: string; kind: string; masked: string };
export type VaultText = { name: string; text: string };

/** סיווג-לפי-שם-קובץ (המיפוי-המוסכם של חוזה-42-0). */
const KIND_BY_NAME: Record<string, string> = {
  'pat.env': 'github-token',
  'hq.password': 'password',
  'openrouter.keys': 'api-keys',
  'cloudflare.txt': 'cloudflare',
};

/**
 * מיסוך-ערך-סוד לתצוגה:
 * - אורך >= 8 → 4 התווים-הראשונים + '••••' + 4 האחרונים.
 * - קצר-מ-8 (או לא-מחרוזת) → '••••'.
 */
export function maskSecret(s: string): string {
  if (typeof s !== 'string' || s.length < 8) return '••••';
  return s.slice(0, 4) + '••••' + s.slice(-4);
}

/** סיווג-קינד: מיפוי-שמות-מוסכם קודם, ואחר-כך היוריסטיקת-תוכן עדינה (בלי-לחשוף-דבר). */
function classify(name: string, text: string): string {
  const byName = KIND_BY_NAME[name];
  if (byName) return byName;
  const n = name.toLowerCase();
  if (n.endsWith('.password')) return 'password';
  if (n.endsWith('.keys')) return 'api-keys';
  if (n.includes('cloudflare')) return 'cloudflare';
  if (/(ghp_|gho_|ghs_|ghr_|github_pat)/.test(text)) return 'github-token';
  if (text.includes('sk-or-')) return 'api-keys';
  return 'other';
}

/** רשימת-קבצי-הכספת (קבצים-בלבד, ממוינים). כשל → רשימה-ריקה + שגיאה-בעברית. */
function listVaultFiles(): string[] {
  try {
    return readdirSync(SECRETS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    console.error('[vault] לא ניתן לקרוא את תיקיית secrets/ —', err instanceof Error ? err.message : err);
    return [];
  }
}

/** איסוף-מועמדים-ל"ערך-הראשי": סיסמה = השורה-המלאה; אחרת — חלק-אחרי '=' או הטוקנים-בשורה. */
function candidatesOf(text: string, kind: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.trim().replace(/^["']|["']$/g, '');
    if (t) out.push(t);
  };
  if (kind === 'password') {
    // סיסמה עשויה להכיל רווחים — השורה-המלאה (trim) היא הערך, ללא-פיצול.
    const t = text.trim();
    if (t) push(t);
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const eq = t.indexOf('=');
    const valuePart = eq >= 0 ? t.slice(eq + 1) : t;
    for (const tok of valuePart.split(/[\s,;]+/)) push(tok);
  }
  return out;
}

/** הערך-הארוך-הראשי-מוסק (ה"ערך הראשי" = המועמד הארוך ביותר בקובץ). */
function mainMasked(text: string, kind: string): string {
  const cands = candidatesOf(text, kind);
  if (cands.length === 0) return '••••';
  let best = cands[0];
  for (const c of cands) if (c.length > best.length) best = c;
  return maskSecret(best);
}

/**
 * מלוא-קבצי-הכספת: name + kind + הערך-הארוך-הראשי-מוסק.
 * בטוח להחזרה ללקוח — מכיל מוסקים-בלבד.
 */
export async function vaultInventory(): Promise<VaultItem[]> {
  const items: VaultItem[] = [];
  for (const name of listVaultFiles()) {
    try {
      const text = readFileSync(path.join(SECRETS_DIR, name), 'utf8');
      const kind = classify(name, text);
      items.push({ name, kind, masked: mainMasked(text, kind) });
    } catch (err) {
      console.error(`[vault] קריאת ${name} נכשלה —`, err instanceof Error ? err.message : err);
      items.push({ name, kind: KIND_BY_NAME[name] ?? 'other', masked: '••••' });
    }
  }
  return items;
}

/**
 * טקסט-מלא של קבצי-הכספת — לשימוש-פנימי בלבד (סריקת-סודות לפני-דחיפה).
 * אסור להחזיר תוצאה זו ללקוח, לרשת או ליומנים.
 */
export async function vaultTexts(): Promise<VaultText[]> {
  const out: VaultText[] = [];
  for (const name of listVaultFiles()) {
    try {
      out.push({ name, text: readFileSync(path.join(SECRETS_DIR, name), 'utf8') });
    } catch (err) {
      console.error(`[vault] קריאת ${name} נכשלה —`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
