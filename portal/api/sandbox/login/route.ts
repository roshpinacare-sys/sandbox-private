import { NextResponse, type NextRequest } from "next/server";
import { HQ_BASE, HQ_UNAVAILABLE, clientIp, hqHeaders, isHttps } from "@/lib/hq-session";

export const runtime = "nodejs";

/**
 * פרוקסי-התחברות אל שרת-HQ (sanbox, פורט פנימי 3010).
 * מעביר {password} שרת-לשרת + את ה-IP האמיתי (לנעילת-ניסיונות הוגנת),
 * מחלץ את hq_session מ-Set-Cookie של sanbox ומחזיר:
 *  - cookie: SameSite=None; Secure; Partitioned ב-HTTPS (תצוגת-iframe), Lax ב-local
 *  - גם את הטוקן בגוף (ערוץ-זהות-משני — עוקף חסימת-עוגיות-שלישוניות בדפדפנים)
 */
export async function POST(request: NextRequest) {
  let password = "";
  try {
    const body: unknown = await request.json();
    if (
      body &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>).password === "string"
    ) {
      password = (body as Record<string, unknown>).password as string;
    }
  } catch {
    // גוף לא-תקין — מעבירים סיסמה ריקה; sanbox ידחה עם 401
  }

  try {
    const hqRes = await fetch(`${HQ_BASE}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": clientIp(request),
      },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });

    const text = await hqRes.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { ok: hqRes.ok };
    }

    if (!hqRes.ok) {
      // 401 (סיסמה שגויה) / 429 (נעילת-ניסיונות) — מועברים כמו-שהם
      return NextResponse.json(data, { status: hqRes.status });
    }

    const token = extractHqSession(hqRes);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "שרת-HQ לא החזיר טוקן התחברות" },
        { status: 200 }
      );
    }

    const https = isHttps(request);
    const res = NextResponse.json({ ...data, token }, { status: hqRes.status });
    res.cookies.set({
      name: "hq_session",
      value: token,
      httpOnly: true,
      // HTTPS/iframe → None+Secure+Partitioned (היחיד-שעובר); local-http → Lax
      sameSite: https ? "none" : "lax",
      secure: https,
      partitioned: https,
      path: "/",
      maxAge: 604800,
    });
    return res;
  } catch {
    // ECONNREFUSED / timeout — בלי-500 גולמי, בלי-stack
    return NextResponse.json({ ok: false, error: HQ_UNAVAILABLE });
  }
}

function extractHqSession(hqRes: Response): string | null {
  const headers = hqRes.headers as Headers & { getSetCookie?: () => string[] };
  const candidates: string[] =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie") ?? ""];
  for (const c of candidates) {
    const m = /(?:^|,)\s*hq_session=([^;,\s]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}
