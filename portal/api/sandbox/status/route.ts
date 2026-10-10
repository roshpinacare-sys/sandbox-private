import { NextResponse, type NextRequest } from "next/server";
import { ensureHQ } from "@/lib/ensure-hq";
import { HQ_BASE, HQ_UNAVAILABLE, getHqToken, hqHeaders } from "@/lib/hq-session";

export const runtime = "nodejs";

/**
 * פרוקסי-סטטוס: מעביר את ה-cookie הנכנס אל sanbox (שרת-לשרת על 127.0.0.1:3010)
 * ומחזיר בדיוק את הסטטוס וה-JSON שהתקבלו. 401 עובר כמו-שהוא — הלקוח חוזר למסך-הכניסה.
 */
export async function GET(request: NextRequest) {
  const token = getHqToken(request);
  if (!token) {
    return NextResponse.json({ ok: false, error: "לא מחובר" }, { status: 401 });
  }

  // הבטחת-חיים: אם-HQ מת — הקם-מחדש (ריבונות: חי-תמיד)
  await ensureHQ();

  try {
    const hqRes = await fetch(`${HQ_BASE}/api/status`, {
      method: "GET",
      headers: hqHeaders(token),
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
    return NextResponse.json(data, { status: hqRes.status });
  } catch {
    // ECONNREFUSED / timeout — בלי-500 גולמי, בלי-stack
    return NextResponse.json({ ok: false, error: HQ_UNAVAILABLE });
  }
}
