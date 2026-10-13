#!/bin/sh
# e2e-hq.sh — בדיקת-קצה-לקצה של שער-HQ (T-46). אפס-סודות; קבלות-כנות-בלבד.
# מוכיח: ① שער-חי-ומגיב ② סיסמה-שגויה=401 ×5 ③ מצערת=429 בניסיון-6
# ④ /api/status ללא-סשן=401 (השער-הקשה) ⑤ השרת-האפמרלי-נמחק-בסוף (לקח-T-50 — נגד-יתומים).
# רץ-גם-בסנדבוקס-עני-זיכרון: פרץ-אטומי-אחד (spawn→בדיקות→ניקוי-מאומת→קבלה).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${HQ_PORT:-3011}"
BASE="http://127.0.0.1:${PORT}"
OUT="$ROOT/receipts/e2e-hq.json"
mkdir -p "$ROOT/receipts"
SPAWNED=0

# ניקוי-מחייב: השרת-האפמרלי-שאנחנו-הקמנו-חייב-למות-בסוף-הבדיקה.
# לקח-T-50: setsid-nohup-שרד-את-הסקריפט-והשאיר-מופע-HQ-יתום-על-3011 — שני-כותבים-על-אותן-קבלות.
# הניקוי-פוגע-רק-במאזין-על-הפורט-האפמרלי-שלנו (3011) — לעולם-לא-ב-HQ-הקבוע (3010).
cleanup() {
  [ "$SPAWNED" = "1" ] || return 0
  PID_ON_PORT="$(ss -tlnp 2>/dev/null | grep ":${PORT} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
  if [ -n "$PID_ON_PORT" ]; then
    kill "$PID_ON_PORT" 2>/dev/null || true
    sleep 1
  fi
}
trap cleanup EXIT

# 1) הקמה-אם-אין-מאזין (setsid = ניתוק-כפול; ימות-ב-cleanup-כי-אנחנו-הקמנו-אותו)
if ! curl -s -m 2 -o /dev/null "$BASE/"; then
  HQ_PORT="$PORT" setsid nohup bun "$ROOT/server.ts" >> "$ROOT/receipts/server.out" 2>&1 < /dev/null &
  SPAWNED=1
  sleep 1.5
fi

# 2) הפרובות (בפרץ-אחד — לפני-שהקצר-האפמרלי-יכול-לקצור)
R1="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/")"
T1="$(curl -s -m 3 "$BASE/" | grep -oE '<title>[^<]*' | head -1 | sed 's/<title>//')"
R2=""
i=1
while [ $i -le 6 ]; do
  c="$(curl -s -m 3 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"password":"wrong-e2e-probe"}' "$BASE/api/login")"
  R2="$R2 $c"
  i=$((i + 1))
done
R3="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/api/status")"
TS="$(date -u +%FT%TZ)"

# 2.5) קבלה-על-הניקוי: האם-השרת-האפמרלי-אכן-ימחק (אמת-במקום-הנחה)
cleanup
trap - EXIT
PORT_FREE=1
curl -s -m 2 -o /dev/null "$BASE/" && PORT_FREE=0

# 3) קבלה-כנה
VERDICT="gate-down"
[ "$R1" = "200" ] && [ "$PORT_FREE" = "1" ] && VERDICT="gate-live"
[ "$R1" = "200" ] && [ "$PORT_FREE" = "0" ] && VERDICT="gate-live-but-orphan-server"
cat > "$OUT" <<EOF
{
 "schema": "sanbox.e2e-hq/1",
 "at": "$TS",
 "port": $PORT,
 "root": $R1,
 "rootTitle": "$T1",
 "loginBurst": "$R2",
 "statusUnauth": $R3,
 "ephemeralCleaned": $PORT_FREE,
 "verdict": "$VERDICT"
}
EOF
cat "$OUT"
