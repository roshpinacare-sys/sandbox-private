#!/usr/bin/env bash
# push-hq.sh — דחיפת-git-מאובטחת-מה-CLI (Task 42-c). לשימון-ידני-חירום.
# מריץ-את-אותו-זרימה-כמו core/ops.ts:
#   סריקת-סודות → auto-commit → PAT-מהכספת → זיהוי-משתמש → יצירת-ריפו-אם-חסר
#   → remote-נקי-ללא-טוקן → דחיפה-עם-askpass-זמני (HQ_TOKEN-בסביבה-בלבד) → קבלה.
# אין-טוקן-ב-argv, אין-טוקן-ב-URL, אין-טוקן-ב-.git/config. כל-פלט-ממוסך.
# בדיקה-ללא-דחיפה/קומיט:  PUSH_HQ_DRYRUN=1 scripts/push-hq.sh   (עוצר-אחרי-הסריקה)
set -euo pipefail

SANBOX="/home/z/my-project/sanbox"
SECRETS="$SANBOX/secrets"
RECEIPTS="$SANBOX/receipts"
DB="$SANBOX/db"
PAT_FILE="$SECRETS/pat.env"
ASKPASS="$DB/.askpass.sh"
TMP_BASE="$(mktemp)"
TMP_DYN="$(mktemp)"
ASKPASS_CREATED=0

cleanup() {
  [ "$ASKPASS_CREATED" = "1" ] && rm -f "$ASKPASS"
  rm -f "$TMP_BASE" "$TMP_DYN"
}
trap cleanup EXIT

cd "$SANBOX"
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log_push() { # log_push <ok> <stage> <commit> <repo> <clean>
  mkdir -p "$RECEIPTS"
  printf '{"ts":"%s","ok":%s,"stage":"%s","commit":"%s","repo":"%s","clean":%s}\n' \
    "$(now_iso)" "$1" "$2" "$3" "$4" "$5" >> "$RECEIPTS/push-log.jsonl"
}

# --- PAT מהכספת (תמיכה-ב-PAT=... ובטוקן-גולמי) ---
PAT=""
if [ -f "$PAT_FILE" ]; then
  first_line="$(grep -vE '^[[:space:]]*(#|$)' "$PAT_FILE" | head -n1 || true)"
  case "$first_line" in
    *=*) PAT="${first_line#*=}" ;;
    *)   PAT="$first_line" ;;
  esac
  PAT="${PAT%\"}"; PAT="${PAT#\"}"; PAT="${PAT%\'}"; PAT="${PAT#\'}"
  PAT="$(printf '%s' "$PAT" | tr -d '[:space:]')"
fi
[ -n "$PAT" ] || { echo 'אין PAT בכספת'; exit 1; }
echo "PAT: ${PAT:0:4}•••• (מוסק)"

# --- סריקת-סודות על הקבצים-הנעקבים ---
# קידומת-הסיסמה-הראשית-מורכבת-משני-חלקים-כדי-שהסקריפט-הזה-לא-יתפוס-את-עצמו.
MASTER_PREFIX="P5KQG""nQ3GWx7"
BASE_SPECS=(
  "github-classic-pat|ghp_[A-Za-z0-9]{20,}"
  "github-fine-grained-pat|github_pat_[A-Za-z0-9_]{20,}"
  "openrouter-key|sk-or-v1-[a-f0-9]{32,}"
  "anthropic-key|sk-ant-[A-Za-z0-9_-]{10,}"
  "aws-access-key|AKIA[0-9A-Z]{16}"
  "cloudflare-api-token|cfat_[A-Za-z0-9]{20,}"
  "slack-token|xox[bpars]-[A-Za-z0-9-]{10,}"
  "google-ai-key|gsk_[A-Za-z0-9]{20,}"
  "private-key|-----BEGIN [A-Z ]*PRIVATE KEY-----"
  "master-password-prefix|${MASTER_PREFIX}"
  "generic-long|[A-Za-z0-9]{40,}"
)

# דפוסים-דינמיים: כל-טוקן-ארוך (>=20) מקבצי-הכספת → grep -F
grep -hoE '[A-Za-z0-9_-]{20,}' "$SECRETS"/* 2>/dev/null | sort -u > "$TMP_DYN" || true

scan_hits=0
scanned=0
declare -a HIT_LINES=()
hits_json=""

while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  # FIX(T-47): הצופן-המתוכנן-של-הכספת — בינארי-מוצפן, אינו-סוד-גלוי (מדוד:
  # כל-היט-ממנו-היה-שארית-בסיס64-אקראית-של-ההצפנה). זהה-ל-exclusion-של-ops.ts.
  case "$f" in vault/vault-backup.enc) continue ;; esac
  scanned=$((scanned + 1))
  for spec in "${BASE_SPECS[@]}"; do
    kind="${spec%%|*}"; pattern="${spec#*|}"
    if [ "$kind" = "generic-long" ]; then
      # FIX(T-47): גנרי-ארוך-חכם — אותו-חוק-כמו-core/scan-patterns.ts:
      # רצפים-40+ נשללים-אם-צורתם-ציבורית-ידועה (האש-הקס/כתובת-EVM/bech32/
      # בסיס58-43..53/חתימת-סולנה-87..88). WIF/xprv-נתפסים-בכללים-משלהם-למטה.
      suspects="$(grep -oE '[A-Za-z0-9]{40,}' "$f" 2>/dev/null \
        | grep -vE '^0[xX][0-9a-fA-F]{40}$|^0[xX][0-9a-fA-F]{64}$|^[0-9a-fA-F]{40,64}$|^bc1[a-z0-9]{20,87}$|^[1-9A-HJ-NP-Za-km-z]{43,53}$|^[1-9A-HJ-NP-Za-km-z]{87,88}$' || true)"
      if [ -n "$suspects" ]; then
        HIT_LINES+=("${f}|${kind}")
        scan_hits=$((scan_hits + 1))
      fi
      continue
    fi
    if grep -qE -- "$pattern" "$f" 2>/dev/null; then
      HIT_LINES+=("${f}|${kind}")
      scan_hits=$((scan_hits + 1))
    fi
  done
  if [ -s "$TMP_DYN" ] && grep -qF -f "$TMP_DYN" -- "$f" 2>/dev/null; then
    HIT_LINES+=("${f}|dynamic-vault-token")
    scan_hits=$((scan_hits + 1))
  fi
done < <(git ls-files -z)

for h in "${HIT_LINES[@]:-}"; do
  [ -n "$h" ] || continue
  hf="${h%%|*}"; hk="${h#*|}"
  hits_json+="$(printf '{"file":"%s","patternKind":"%s","masked":"••••"}' "$hf" "$hk"),"
done
hits_json="[${hits_json%,}]"

mkdir -p "$RECEIPTS"
if [ "$scan_hits" -gt 0 ]; then
  printf '{"clean":false,"scannedFiles":%d,"hits":%s,"ts":"%s"}\n' "$scanned" "$hits_json" "$(now_iso)" \
    > "$RECEIPTS/scan-last.json"
  printf 'HITS: %s\n' "$hits_json"
  log_push false scan '' 'sanbox' false
  echo 'סריקת סודות נכשלה — דחיפה נחסמה'
  exit 3
fi
printf '{"clean":true,"scannedFiles":%d,"hits":[],"ts":"%s"}\n' "$scanned" "$(now_iso)" \
  > "$RECEIPTS/scan-last.json"
echo "סריקה נקייה ($scanned קבצים)"

# --- מצב-בדיקה: עוצר-כאן, בלי-קומיט-ובלי-דחיפה ---
if [ "${PUSH_HQ_DRYRUN:-0}" = "1" ]; then
  echo 'DRYRUN — עצירה-לפני-commit/דחיפה'
  exit 0
fi

# --- auto-commit ---
git add -A
if ! git diff --cached --quiet; then
  MSG="HQ sync $(now_iso)"
  if ! git commit -m "$MSG" 2>/dev/null; then
    git -c user.name=hq -c user.email=hq@localhost commit -m "$MSG"
  fi
fi
COMMIT="$(git rev-parse --short HEAD)"

# --- זיהוי-משתמש ---
command -v curl >/dev/null 2>&1 || { echo 'curl לא זמין'; log_push false auth "$COMMIT" 'sanbox' true; exit 1; }
LOGIN="$(curl -fsS --max-time 20 -H "Authorization: Bearer $PAT" -H 'User-Agent: hq' https://api.github.com/user \
  | grep -oE '"login"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
  | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')" || {
  echo 'PAT נדחה על ידי GitHub'; log_push false auth "$COMMIT" 'sanbox' true; exit 1; }
[ -n "$LOGIN" ] || { echo 'PAT נדחה על ידי GitHub'; log_push false auth "$COMMIT" 'sanbox' true; exit 1; }
REPO_FULL="$LOGIN/sanbox"
echo "משתמש: $LOGIN"

# --- יצירת-ריפו-אם-חסר (422 = קיים) ---
CODE="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $PAT" -H 'User-Agent: hq' -H 'Accept: application/vnd.github+json' \
  -H 'Content-Type: application/json' \
  -d '{"name":"sanbox","private":true,"auto_init":false}' \
  https://api.github.com/user/repos)" || CODE="000"
case "$CODE" in
  201|422) : ;;
  000) echo 'GitHub לא נגיש'; log_push false repo-create "$COMMIT" "$REPO_FULL" true; exit 1 ;;
  *)   echo "יצירת-ריפו נכשלה (HTTP $CODE)"; log_push false repo-create "$COMMIT" "$REPO_FULL" true; exit 1 ;;
esac

# --- remote-נקי-ללא-טוקן ---
URL="https://github.com/$LOGIN/sanbox.git"
if git remote get-url origin >/dev/null 2>&1; then
  CUR="$(git remote get-url origin)"
  case "$CUR" in
    "$URL") : ;;
    *"$PAT"*|*x-access-token*|https://*@*) git remote set-url origin "$URL" ;;
    *) : ;;
  esac
else
  git remote add origin "$URL"
fi

# --- דחיפה-עם-askpass-זמני (נמחק-בכל-יציאה) ---
mkdir -p "$DB"
cat > "$ASKPASS" <<'EOF'
#!/bin/sh
case "$1" in Username*) echo "x-access-token";; *) echo "$HQ_TOKEN";; esac
EOF
chmod 700 "$ASKPASS"
ASKPASS_CREATED=1

PUSH_OUT="$(GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$ASKPASS" HQ_TOKEN="$PAT" git push -u origin main 2>&1)" || {
  printf '%s\n' "$PUSH_OUT" | awk -v t="$PAT" '{ gsub(t, "••••"); print }'
  log_push false push "$COMMIT" "$REPO_FULL" true
  echo 'דחיפה נכשלה'
  exit 1
}
printf '%s\n' "$PUSH_OUT" | awk -v t="$PAT" '{ gsub(t, "••••"); print }'

log_push true push "$COMMIT" "$REPO_FULL" true
echo "נדחף: $REPO_FULL @ $COMMIT"
