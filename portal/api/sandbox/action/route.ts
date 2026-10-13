import { NextResponse, type NextRequest } from "next/server";
import { HQ_BASE, HQ_UNAVAILABLE, getHqToken, hqHeaders } from "@/lib/hq-session";

export const runtime = "nodejs";

const ALLOWED_ACTIONS = new Set([
  "secret-scan",
  "push-github",
  "auto-push",
  "ping",
  "vault-backup",
  "vault-restore",
]);

/**
 * פרוקסי-פעולות ({action: 'secret-scan' | 'push-github' | 'vault-backup' | 'vault-restore' | 'ping'}):
 * מעביר את ה-cookie הנכנס + הגוף אל sanbox ומחזיר את הסטטוס וה-JSON כמו-שהם.
 * 'vault-restore' מקבל בנוסף שדה-password (מחרוזת-בלבד) — הסיסמה מועברת
 * ל-HQ בגוף-הבקשה בלבד: לא נרשמת בלוגים, לא נשמרת, לא חוזרת בתשובות.
 */
export async function POST(request: NextRequest) {
  const token = getHqToken(request);
  if (!token) {
    return NextResponse.json({ ok: false, error: "לא מחובר" }, { status: 401 });
  }

  let action = "";
  let password: string | undefined;
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object") {
      const rec = body as Record<string, unknown>;
      if (typeof rec.action === "string" && ALLOWED_ACTIONS.has(rec.action)) {
        action = rec.action;
      }
      // סיסמת-שחזור-הכספת: מחרוזת-בלבד; אינה-נכנסת-ללוגים/קבלות-ולא-חוזרת-בתשובה
      if (typeof rec.password === "string" && rec.password.length > 0) {
        password = rec.password;
      }
    }
  } catch {
    // גוף לא-תקין — action ריק; sanbox ידחה
  }

  if (!action) {
    return NextResponse.json(
      { ok: false, error: "פעולה לא מוכרת" },
      { status: 400 }
    );
  }

  try {
    const hqRes = await fetch(`${HQ_BASE}/api/action`, {
      method: "POST",
      headers: hqHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        action,
        ...(action === "vault-restore" &&
        typeof password === "string" &&
        password.length > 0
          ? { password }
          : {}),
      }),
      // דחיפה-מלאה (סריקה+קומיט+משיכה+אימות-עם-ניסיונות-חוזרים-בסערת-מכסה+דחיפה)
      // יכולה-לקחת-דקות-כשר-GitHub-מוגבל — 8ש-היו-חותכים-הצלחות-אמתיות (לקח-T-48)
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });

    const text = await hqRes.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: hqRes.ok };
    }
    return NextResponse.json(data, { status: hqRes.status });
  } catch (e) {
    // הפרדה-כנה: timeout ≠ שרת-מת (לקח-T-48 — אסור-לקרוא-להצלחה-שהושלמה-בצד-HQ "כישלון")
    const msg =
      e instanceof Error && /timeout|abort/i.test(e.message)
        ? "הפעולה-ארוכה-מהרגיל (כנראה-סערת-מכסה-אצל-GitHub) — היא-ממשיכה-בצד-השרת; רענן-מצב-בעוד-רגע"
        : HQ_UNAVAILABLE;
    return NextResponse.json({ ok: false, error: msg });
  }
}
