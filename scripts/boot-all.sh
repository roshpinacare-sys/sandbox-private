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

# 1.5) אם-הכספת-עדיין-חסרה: שחזור-מהגיבוי-המוצפן (דורש HQ_VAULT_PASS)
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

# 1.6) T-54: שחזור-כספת-מלא-מהגיבוי-המוצפן — תמיד-כשאפשר (השחזור-מ-upload-מחזיר
# רק-את-4-הקבצים-הישנים; nvidia.keys-ועתידיים-חיים-רק-בצופן). הסיסמה-האם = hq.password.
if [ -f "$ROOT/vault/vault-backup.enc" ] && [ -f "$ROOT/secrets/hq.password" ]; then
  echo "… משלים-כספת-מהגיבוי-המוצפן (כל-הקבצים)"
  (cd "$ROOT" && HQ_VAULT_PASS="$(cat "$ROOT/secrets/hq.password")" bun scripts/vault-restore.ts) \
    && echo "✓ הכספת-המלאה-שוחזרה" || echo "!! השלמת-הכספת-נכשלה (ממשיכים-עם-הקיים)"
fi

# 2) סנכרון-זיכרון (T-54: איחוד-מדורים-by-hash — לא-העתקה-גורפת; היומן-משותף-לכל-הסוכנים
# והצד-העשיר-יותר-הוא-הבסיס. נפילת-bun → נפילה-חזרה-להעתקה-הישנה-כמוצא-אחרון)
mkdir -p "$ROOT/memory"
if command -v bun > /dev/null 2>&1 && (cd "$ROOT" && bun -e "const { syncMemory } = await import('$ROOT/core/ops.ts'); syncMemory();" 2>/dev/null); then
  echo "✓ זיכרון-מסונכרן-באיחוד (syncMemory)"
else
  cp "$PROJECT/MEMORY.md" "$ROOT/memory/" 2>/dev/null
  cp "$PROJECT/worklog.md" "$ROOT/memory/" 2>/dev/null
  echo "… זיכרון-הועתק-גורפת (נפילה-חזרה — bun-לא-זמין)"
fi

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


# 6) רץ-הגריד-הריבוני-בגיטלאב (T-58): gitlab-runner — התקנה-עצמית-אם-חסר + הצתה-אם-מת
if [ -x "$HOME/.sovereign/bin/gitlab-runner" ] && [ -f "$HOME/.sovereign/gitlab-runner/config.toml" ]; then
  if pgrep -f 'gitlab-runner run' > /dev/null 2>&1; then
    echo "✓ gitlab-runner חי"
  else
    nohup "$HOME/.sovereign/bin/gitlab-runner" run --config "$HOME/.sovereign/gitlab-runner/config.toml" >> "$HOME/.sovereign/gitlab-runner/runner.log" 2>&1 &
    echo "✓ gitlab-runner הוקם (pid=$!)"
  fi
else
  echo "… מתקין-gitlab-runner (הורדה+רישום-מהכספת)"
  RUNNER_TOKEN="$(grep '^gitlab_runner_token=' "$ROOT/secrets/gitlab-runner.keys" 2>/dev/null | cut -d= -f2)"
  if [ -n "$RUNNER_TOKEN" ]; then
    mkdir -p "$HOME/.sovereign/bin" "$HOME/.sovereign/gitlab-runner"
    curl -sL -o "$HOME/.sovereign/bin/gitlab-runner" "https://gitlab-runner-downloads.s3.amazonaws.com/v17.10.1/binaries/gitlab-runner-linux-amd64" \
      && chmod +x "$HOME/.sovereign/bin/gitlab-runner" \
      && "$HOME/.sovereign/bin/gitlab-runner" register --non-interactive --url "https://gitlab.com" --token "$RUNNER_TOKEN" --executor "shell" --description "roshpina-sovereign-runner" --config "$HOME/.sovereign/gitlab-runner/config.toml" \
      && nohup "$HOME/.sovereign/bin/gitlab-runner" run --config "$HOME/.sovereign/gitlab-runner/config.toml" >> "$HOME/.sovereign/gitlab-runner/runner.log" 2>&1 &
    echo "✓ gitlab-runner מותקן-ומוקם (רקע)"
  else
    echo "!! אין-gitlab_runner_token-בכספת — דילוג (fail-open)"
  fi
fi

echo "== סוף boot-all — סטטוס תוך 10 שניות: curl 127.0.0.1:3010/api/status (מאומת) =="
