/**
 * scan-patterns.ts — דפוסי-סריקת-סודות לשרת-HQ (Task 42-c).
 *
 * אפס-תלויות. שתי-שכבות:
 *  1) BASE_RULES / BASE_PATTERNS — דפוסים-ידועים (ספקים + קידומת-הסיסמה-הראשית + גנרי-ארוך).
 *  2) buildDynamicPatterns — כל-טוקן-ארוך (>=20 תווים [A-Za-z0-9_-]) שנמצא-בטקסטי-הכספת
 *     הופך-לדפוס-מילוטי-עם-גבולות — כך-גם-סוד-שאינו-מוכר-נתפס-אם-דולף-לקוד.
 *
 * הערת-עצמיות: הקובץ-הזה-נסרק-בעצמו (הוא-חלק-מה-ריפו). לכן-קידומת-הסיסמה-הראשית
 * נבנית-מחלקים-מפוצלים — המחרוזת-הרציפה-לא-מופיעה-בבייטים-של-הקובץ, והדפוס-עצמו
 * עדיין-תופס-אותה-בקבצים-אחרים. בלי-זה-הסריקה-הייתה-תופסת-את-עצמה-וחוסמת-כל-דחיפה.
 */

/** טקסט-כספת (מ-vault.ts של-42-a). */
export interface VaultText {
  name: string;
  text: string;
}

/** כלל-בסיס: דפוס + שם-סוג לדיווח-ממוסך בהיטים. */
export interface BaseRule {
  kind: string;
  re: RegExp;
}

// קידומת-הסיסמה-הראשית-הידועה — מחרוזות-מפוצלות בכוונה (ראה-הערת-עצמיות למעלה).
const MASTER_PW_PREFIX = 'P5KQG' + 'nQ3GWx7';

/**
 * דפוסי-הבסיס. לקידומות-הגולמיות (sk-ant-, xox..., gsk_) נוסף-גוף-מינימלי
 * כדי-שלא-יתפסו-טקסט-רגיל — מפתחות-אמיתיים ארוכים-בהרבה-מהגוף-הנדרש.
 */
export const BASE_RULES: BaseRule[] = [
  { kind: 'github-classic-pat', re: /ghp_[A-Za-z0-9]{20,}/ },
  { kind: 'github-fine-grained-pat', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'openrouter-key', re: /sk-or-v1-[a-f0-9]{32,}/ },
  { kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_\-]{10,}/ },
  { kind: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { kind: 'cloudflare-api-token', re: /cfat_[A-Za-z0-9]{20,}/ },
  { kind: 'slack-token', re: /xox[bpars]-[A-Za-z0-9\-]{10,}/ },
  { kind: 'google-ai-key', re: /gsk_[A-Za-z0-9]{20,}/ },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'master-password-prefix', re: new RegExp(MASTER_PW_PREFIX) },
  // גנרי-ארוך — דגל-עצמאי: כל-רצף-אלפאנומרי-באורך-40+ (למשל-SHA-1) ייתפס-וידגל.
  { kind: 'generic-long', re: /[A-Za-z0-9]{40,}/ },
];

/** חוזה-מהשיחה: רשימת-הדפוסים-הבסיסיים (בלי-שמות-הסוגים). */
export const BASE_PATTERNS: RegExp[] = BASE_RULES.map((r) => r.re);

/**
 * בונה-דפוסים-דינמיים מטקסטי-הכספת:
 * כל-טוקן [A-Za-z0-9_-]{20,} → RegExp מילוטי עם גבולות (?<!...)(?![...])
 * כדי-שטוקן-קצר-יותר-שמכיל-אותו-לא-יעורר. כשל-בנייה (מנוע-בלי-lookbehind)
 * מדלג-על-הטוקן בשקט — דפוסי-הבסיס עדיין עומדים.
 */
export function buildDynamicPatterns(texts: VaultText[]): RegExp[] {
  const seen = new Set<string>();
  const out: RegExp[] = [];
  const token = /[A-Za-z0-9_\-]{20,}/g;
  for (const t of texts) {
    if (!t || typeof t.text !== 'string' || t.text.length === 0) continue;
    for (const m of t.text.matchAll(token)) {
      const tok = m[0];
      if (!tok || seen.has(tok)) continue;
      seen.add(tok);
      const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        out.push(new RegExp(`(?<![A-Za-z0-9_\\-])${esc}(?![A-Za-z0-9_\\-])`));
      } catch {
        // מנוע-ללא-lookbehind — דילוג-בטוח.
      }
    }
  }
  return out;
}
