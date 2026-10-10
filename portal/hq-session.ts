import type { NextRequest } from "next/server";

/**
 * עזרי-זהות-משותפים לפרוקסי-sanbox.
 * ערוץ-זהות-כפול: cookie hq_session (רגיל) או כותרת x-hq-session —
 * כשהפורטל נטען-בתוך-iframe על-HTTPS דפדפנים חוסמים-עוגיות-שלישוניות;
 * הכותרת-עוברת-תמיד, ולכן-ההתחברות-עובדת-בכל-דפדפן. הטוקן-עצמו-מאומת-מול-HQ-בכל-קריאה.
 */

export const HQ_BASE = "http://127.0.0.1:3010";
export const HQ_UNAVAILABLE =
  "שרת-HQ לא זמין כרגע — הפעל את sanbox/server.ts";

export function getHqToken(request: NextRequest): string | null {
  const hdr = request.headers.get("x-hq-session");
  if (hdr && hdr.trim()) return hdr.trim();
  return request.cookies.get("hq_session")?.value ?? null;
}

export function hqHeaders(
  token: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    Cookie: `hq_session=${token}`,
    "x-hq-session": token,
    ...extra,
  };
}

export function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "127.0.0.1"
  );
}

export function isHttps(request: NextRequest): boolean {
  return (
    request.headers.get("x-forwarded-proto") === "https" ||
    (request.headers.get("x-forwarded-ssl") === "on")
  );
}
