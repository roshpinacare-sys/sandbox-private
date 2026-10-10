import { NextResponse, type NextRequest } from "next/server";
import { HQ_BASE, HQ_UNAVAILABLE, getHqToken, hqHeaders, isHttps } from "@/lib/hq-session";

export const runtime = "nodejs";

/** פרוקסי-התנתקות: מעביר את הטוקן (cookie או כותרת) ל-sanbox ותמיד מנקה את ה-cookie המקומי. */
export async function POST(request: NextRequest) {
  const token = getHqToken(request);

  const clearCookie = (res: NextResponse) => {
    res.cookies.set({
      name: "hq_session",
      value: "",
      httpOnly: true,
      sameSite: isHttps(request) ? "none" : "lax",
      secure: isHttps(request),
      path: "/",
      maxAge: 0,
    });
    return res;
  };

  if (!token) {
    return clearCookie(NextResponse.json({ ok: true }));
  }

  try {
    const hqRes = await fetch(`${HQ_BASE}/api/logout`, {
      method: "POST",
      headers: hqHeaders(token, { "Content-Type": "application/json" }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });

    const text = await hqRes.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: hqRes.ok };
    }
    return clearCookie(NextResponse.json(data, { status: hqRes.status }));
  } catch {
    // sanbox לא מגיב — עדיין מנתקים בצד-הפורטל, בהודעה כנה
    return clearCookie(NextResponse.json({ ok: false, error: HQ_UNAVAILABLE }));
  }
}
