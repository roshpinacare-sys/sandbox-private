#!/bin/sh
# boot-all.sh — שחזור-הרשת-המלאה-בפקודה-אחת (אחרי-מחיקת-סנדבוקס/אתחול-מכונה).
# עקרון: הכל-חי-בתוך-הריפו-הזה → הפקודה-הזאת-מעירה-הכל.
# שימוש: sh /home/z/my-project/sanbox/scripts/boot-all.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="/home/z/my-project"
echo "== boot-all: מעיר את הרשת הריבונית (ROOT=$ROOT) =="

# 1) כספת חייבת להיות קיימת (secrets/ מנוטרל-מגיט — אם-נמחקה, משחזרים-מ-upload)
if [ ! -f "$ROOT/secrets/pat.env" ]; then
  echo "!! הכספת חסרה — משחזר מ-upload/"
  mkdir -p "$ROOT/secrets"
  cp "$PROJECT/upload/pat.env" "$ROOT/secrets/pat.env" 2>/dev/null
  tail -1 "$PROJECT/upload/headcorner.txt" > "$ROOT/secrets/hq.password" 2>/dev/null
  cp "$PROJECT/upload/llm.txt" "$ROOT/secrets/openrouter.keys" 2>/dev/null
  cp "$PROJECT/upload/קלודפלרדודי.txt" "$ROOT/secrets/cloudflare.txt" 2>/dev/null
  chmod 600 "$ROOT/secrets/"* 2>/dev/null
fi

# 1.1) אם-הכספת-עדיין-חסרה: שחזור-מהגיבוי-המוצפן (דורש HQ_VAULT_PASS)
if [ ! -f "$ROOT/secrets/pat.env" ] && [ -f "$ROOT/vault/vault-backup.enc" ]; then
  if [ -n "${HQ_VAULT_PASS:-}" ]; then
    echo "… משחזר את הכספת מ-vault/vault-backup.enc (HQ_VAULT_PASS)"
    if (cd "$ROOT" && HQ_VAULT_PASS="$HQ_VAULT_PASS" bun scripts/vault-restore.ts); then
      echo "✓ הכספת-שוחזרה מהגיבוי-המוצפן"
    else
      echo "!! שחזור-הכספת-מהגיבוי נכשל"
    fi
  else
    echo "!! יש גיבוי-מוצפן אך-אין-סיסמה בסביבה — הרץ: HQ_VAULT_PASS=... bun scripts/vault-restore.ts"
  fi
elif [ ! -f "$ROOT/secrets/pat.env" ]; then
  echo "!! הכספת-חסרה ואין-גיבוי מוצפן — העלה קבצי-כספת אל upload/ והרץ שוב"
fi

# 2) סנכרון-זיכרון (MEMORY + worklog → הריפו)
mkdir -p "$ROOT/memory"
cp "$PROJECT/MEMORY.md" "$ROOT/memory/" 2>/dev/null
cp "$PROJECT/worklog.md" "$ROOT/memory/" 2>/dev/null

# 3) המפקח-הריבוני (מיד-מקים-HQ, וממשיך-לפקח-על-הכל-תמידית)
if pgrep -f 'scripts/supervisor.ts' > /dev/null 2>&1; then
  echo "✓ המפקח-הריבוני כבר חי"
else
  nohup bun "$ROOT/scripts/supervisor.ts" >> "$ROOT/receipts/supervisor.out" 2>&1 &
  echo "✓ המפקח-הריבוני הוקם (pid=$!)"
fi

# 3.5) שומר-הריבונות-העצמאי (~/.sovereign — שורד-מחיקת-התיקייה-ומשחזר-הכל-מהריפו)
if [ -f "$HOME/.sovereign/guardian.pid" ] && kill -0 "$(cat "$HOME/.sovereign/guardian.pid" 2>/dev/null)" 2>/dev/null; then
  echo "✓ שומר-הריבונות-העצמאי כבר חי (pid=$(cat "$HOME/.sovereign/guardian.pid" 2>/dev/null))"
else
  sh "$ROOT/scripts/install-guardian.sh"
fi

# 4) HQ מיד (בלי-לחכות-לטיק-הראשון-של-המפקח)
HQ_PORT="${HQ_PORT:-3010}"
if curl -s -m 2 -o /dev/null "http://127.0.0.1:${HQ_PORT}/"; then
  echo "✓ HQ (${HQ_PORT}) חי"
else
  HQ_PORT="$HQ_PORT" nohup bun "$ROOT/server.ts" >> "$ROOT/receipts/server.out" 2>&1 &
  echo "✓ HQ הוקם (pid=$!, port=$HQ_PORT)"
fi

# 5) האפליקציה-הראשית (3000) — אם-מתה-ואין-מעטפת
if curl -s -m 3 -o /dev/null http://127.0.0.1:3000/; then
  echo "✓ האפליקציה (3000) חיה"
else
  if pgrep -f 'next dev -p 3000|next-server' > /dev/null 2>&1; then
    echo "… מעטפת-קיימת-אבל-הפורט-מת — המפקח-יטהר-ויקים (חוק-שתי-המכות)"
  else
    nohup bun run dev > "$PROJECT/dev.log" 2>&1 &
    echo "✓ האפליקציה-הוקמה (pid=$!)"
  fi
fi

echo "== סוף boot-all — סטטוס תוך 10 שניות: curl 127.0.0.1:3010/api/status (מאומת) =="
