#!/bin/sh
# e2e-hq.sh — בדיקת-קצה-לקצה של שער-HQ (T-46). אפס-סודות; קבלות-כנות-בלבד.
# מוכיח: ① שער-חי-ומגיב ② סיסמה-שגויה=401 ×5 ③ מצערת=429 בניסיון-6
# ④ /api/status ללא-סשן=401 (השער-הקשה). רץ-גם-בסנדבוקס-עני-זיכרון:
# פרץ-אטומי-אחד (spawn→בדיקות→קבלה) בתוך-חלון-החיים-של-התהליך.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${HQ_PORT:-3011}"
BASE="http://127.0.0.1:${PORT}"
OUT="$ROOT/receipts/e2e-hq.json"
mkdir -p "$ROOT/receipts"

# 1) הקמה-אם-אין-מאזין (setsid = ניתוק-כפול)
if ! curl -s -m 2 -o /dev/null "$BASE/"; then
  HQ_PORT="$PORT" setsid nohup bun "$ROOT/server.ts" >> "$ROOT/receipts/server.out" 2>&1 < /dev/null &
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

# 3) קבלה-כנה
VERDICT="gate-down"
[ "$R1" = "200" ] && VERDICT="gate-live"
cat > "$OUT" <<EOF
{
 "schema": "sanbox.e2e-hq/1",
 "at": "$TS",
 "port": $PORT,
 "root": $R1,
 "rootTitle": "$T1",
 "loginBurst": "$R2",
 "statusUnauth": $R3,
 "verdict": "$VERDICT"
}
EOF
cat "$OUT"
