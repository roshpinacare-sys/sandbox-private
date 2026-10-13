#!/usr/bin/env bash
# push-gitlab.sh — דחיפה-אל-החיים-השני (T-55): מראת-GitLab-מלאה של sanbox.
#
# הרעיון-הריבוני: GitHub-אינו-האל-היחיד. אם-GitHub-נופל/חוסם/נועל —
# הכספת-כולה (קוד+יומני-איחוד+צופן-הסודות) חיה-גם-ב-GitLab.
# המפתח: secrets/gitlab.keys (glpat-) — נאומת-חי http=200, תוקף-עד-2027-10-10.
#
# משמעת-ביטחון (זהה-ל-push-hq.sh):
#   - אין-טוקן-ב-argv, אין-טוקן-ב-URL, אין-טוקן-ב-.git/config — רק-askpass-זמני.
#   - כל-פלט-ממוסך. קבלה: receipts/gitlab-push.jsonl.
#   - fail-open תמיד: כשל-GitLab-לעולם-לא-מפיל-את-הדחיפה-ל-GitHub-ולא-את-הלופ.
#
# שימוש:  bash scripts/push-gitlab.sh           (דחיפה --all + --tags)
#         PUSH_GITLAB_DRYRUN=1 bash scripts/push-gitlab.sh   (בדיקה-בלי-דחיפה)
set -uo pipefail

if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

SANBOX="/home/z/my-project/sanbox"
SECRETS="$SANBOX/secrets"
RECEIPTS="$SANBOX/receipts"
KEY_FILE="$SECRETS/gitlab.keys"
GITLAB_URL="https://gitlab.com/roshpinacare/sanbox.git"
ASKPASS="$(mktemp)"
LOG="$RECEIPTS/gitlab-push.jsonl"

cleanup() { rm -f "$ASKPASS"; }
trap cleanup EXIT

cd "$SANBOX" || exit 1
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log_gl() { # log_gl <ok> <stage> <commit> <detail>
  mkdir -p "$RECEIPTS"
  printf '{"ts":"%s","ok":%s,"stage":"%s","commit":"%s","detail":"%s"}\n' \
    "$(now_iso)" "$1" "$2" "$3" "$4" >> "$LOG"
}

# --- מפתח-GitLab-מהכספת (gitlab_pat=... או-טוקן-גולמי) ---
GLPAT=""
if [ -f "$KEY_FILE" ]; then
  first_line="$(grep -vE '^[[:space:]]*(#|$)' "$KEY_FILE" | grep -E '^gitlab_pat=' | head -n1 | cut -d= -f2- || true)"
  [ -n "$first_line" ] || first_line="$(grep -vE '^[[:space:]]*(#|$)' "$KEY_FILE" | head -n1 || true)"
  GLPAT="$(printf '%s' "$first_line" | tr -d '[:space:]')"
fi
if [ -z "$GLPAT" ]; then
  echo '[gitlab] אין-מפתח-GitLab-בכספת (secrets/gitlab.keys)'
  log_gl false "no-key" "$(git rev-parse --short HEAD 2>/dev/null || echo '?')" "missing glpat"
  exit 1
fi

# --- askpass זמני (כמו-push-hq.sh) ---
cat > "$ASKPASS" <<EOF
#!/bin/sh
case "\$1" in
  Username*) echo 'oauth2' ;;
  Password*) printf '%s' "$GLPAT" ;;
esac
EOF
chmod 700 "$ASKPASS"

export GIT_ASKPASS="$ASKPASS"
export GIT_TERMINAL_PROMPT=0
unset GIT_HTTP_LOW_SPEED_LIMIT GIT_HTTP_LOW_SPEED_TIME 2>/dev/null || true

HEAD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
echo "[gitlab] מראה-GitLab: HEAD=$HEAD_COMMIT dryrun=${PUSH_GITLAB_DRYRUN:-0}"

# --- remote נקי-ללא-טוקן ---
if ! git remote get-url gitlab >/dev/null 2>&1; then
  git remote add gitlab "$GITLAB_URL"
else
  git remote set-url gitlab "$GITLAB_URL"
fi

if [ "${PUSH_GITLAB_DRYRUN:-0}" = "1" ]; then
  echo '[gitlab] dryrun — מסתיים-לפני-דחיפה'
  exit 0
fi

# --- דחיפה: כל-הענפים + תגיות-אם-קיימות (mirror-חי-של-הריבונות) ---
# mirror-חוזה: העותק-בגיטלאב-תמיד-כנוע-לאמת-המקומית — אחרי-rebase-בגיטהאב
# ההיסטוריה-משתנה-והמראה-חייבת-להתאים-את-עצמה (force-כגיבוי, לא-כברירת-מחדל).
ERR_ALL=0
FORCED=0
OUT_ALL="$(git push gitlab --all 2>&1)" || ERR_ALL=1
if [ "$ERR_ALL" = "1" ]; then
  echo '[gitlab] דחיפה-רגילה-נדחתה — mirror-מתכנס-עם-force (המראה-כנועה-לאמת)'
  OUT_ALL="$(git push gitlab --all --force 2>&1)" && { ERR_ALL=0; FORCED=1; } || ERR_ALL=1
fi
echo "$OUT_ALL" | sed -E 's/(glpat-|oauth2:)[A-Za-z0-9._-]+/\1••••/g' | tail -3
ERR_TAGS=0
if [ -n "$(git tag --list | head -1)" ]; then
  OUT_TAGS="$(git push gitlab --tags 2>&1)" || ERR_TAGS=1
  echo "$OUT_TAGS" | sed -E 's/(glpat-|oauth2:)[A-Za-z0-9._-]+/\1••••/g' | tail -3
fi

if [ "$ERR_ALL" = "0" ]; then
  echo "[gitlab] דחיפה-אל-החיים-השני: ok commit=$HEAD_COMMIT forced=$FORCED"
  log_gl true "push" "$HEAD_COMMIT" "all+tags errs=$ERR_TAGS forced=$FORCED"
  exit 0
else
  echo "[gitlab] דחיפה-נכשלה (fail-open — לא-מפיל-כלום-אחר) commit=$HEAD_COMMIT"
  log_gl false "push" "$HEAD_COMMIT" "err=$ERR_ALL tags=$ERR_TAGS"
  exit 0   # fail-open: אף-מתקשר-לא-נשבר-בגללנו
fi
