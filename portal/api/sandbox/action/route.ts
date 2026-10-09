import { NextResponse, type NextRequest } from "next/server";
import { HQ_BASE, HQ_UNAVAILABLE, getHqToken, hqHeaders } from "@/lib/hq-session";

export const runtime = "nodejs";

const ALLOWED_ACTIONS = new Set(["secret-scan", "push-github", "auto-push", "ping"]);

/**
 * פרוקסי-פעולות ({action: 'secret-scan' | 'push-github' | 'ping'}):
 * מעביר את ה-cookie הנכנס + הגוף אל sanbox ומחזיר את הסטטוס וה-JSON כמו-שהם.
 */
export async function POST(request: NextRequest) {
  const token = getHqToken(request);
  if (!token) {
    return NextResponse.json({ ok: false, error: "לא מחובר" }, { status: 401 });
  }

  let action = "";
  try {
    const body: unknown = await request.json();
    if (
      body &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>).action === "string"
    ) {
      const candidate = (body as Record<string, unknown>).action as string;
      if (ALLOWED_ACTIONS.has(candidate)) action = candidate;
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
      body: JSON.stringify({ action }),
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
