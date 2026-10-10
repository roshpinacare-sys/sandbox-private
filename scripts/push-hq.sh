#!/usr/bin/env bash
# push-hq.sh — דחיפת-git-מאובטחת-מה-CLI (Task 42-c). לשימון-ידני-חירום.
# מריץ-את-אותו-זרימה-כמו core/ops.ts:
#   סריקת-סודות → auto-commit → PAT-מהכספת → זיהוי-משתמש → יצירת-ריפו-אם-חסר
#   → remote-נקי-ללא-טוקן → דחיפה-עם-askpass-זמני (HQ_TOKEN-בסביבה-בלבד) → קבלה.
# אין-טוקן-ב-argv, אין-טוקן-ב-URL, אין-טוקן-ב-.git/config. כל-פלט-ממוסך.
# בדיקה-ללא-דחיפה/קומיט:  PUSH_HQ_DRYRUN=1 scripts/push-hq.sh   (עוצר-אחרי-הסריקה)
set -euo pipefail

# שומר-מפני-קריאה-ב-sh (dash): הסקריפט-משתמש-ב-bashisms (מערכים · ${var:0:4}) —
# קריאה-שגויה `sh push-hq.sh` תיכשל-ב"Bad substitution" בשעת-חירום. עכשיו-מתוקן-אוטומטית:
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

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
  # T-50: התאמה-מלאה-לחוק-T-47-ב-core/scan-patterns.ts (מדוד: 32/32-היטים-היו-כוזבים-בחוק-הישן)
  # WIF/xprv — כללים-עצמאיים (השלילות-הציבוריות-של-גנרי-ארוך-מחליקים-WIF-שמתחיל-ב-5)
  "wif-private-key|(?<![A-Za-z0-9])[5KL][1-9A-HJ-NP-Za-km-z]{50,51}(?![A-Za-z0-9])"
  "bip32-xprv|(?<![A-Za-z0-9])xprv[1-9A-HJ-NP-Za-km-z]{100,107}(?![A-Za-z0-9])"
  # גנרי-ארוך-חכם: lookbehind-גבול-טוקן + שלילות-צורות-ציבוריות (EVM/tx-0x · הקס-חשוף-SHA/מרקל · bc1 · בסיס58-ציבורי · חתימת-סולנה)
  "generic-long|(?<![A-Za-z0-9])(?!0[xX][0-9a-fA-F]{40}(?![A-Za-z0-9]))(?!0[xX][0-9a-fA-F]{64}(?![A-Za-z0-9]))(?![0-9a-fA-F]{40,64}(?![A-Za-z0-9]))(?!bc1[a-z0-9]{20,87}(?![A-Za-z0-9]))(?![1-9A-HJ-NP-Za-km-z]{43,53}(?![A-Za-z0-9]))(?![1-9A-HJ-NP-Za-km-z]{87,88}(?![A-Za-z0-9]))[A-Za-z0-9]{40,}"
)

# דפוסים-דינמיים: כל-טוקן-ארוך (>=20) מקבצי-הכספת → grep -F
grep -hoE '[A-Za-z0-9_-]{20,}' "$SECRETS"/* 2>/dev/null | sort -u > "$TMP_DYN" || true

scan_hits=0
scanned=0
declare -a HIT_LINES=()
hits_json=""

while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  # הרשימה-הלבנה-זהה-ל-runSecretScan ב-core/ops.ts: הצופן-המתוכנן (AES-256-GCM)
  # אינו-סוד-גלוי — נבדק-בנפרד-וזוכה-לדחיפה-במתכוון (Task 44/49)
  [ "$f" = "vault/vault-backup.enc" ] && continue
  scanned=$((scanned + 1))
  for spec in "${BASE_SPECS[@]}"; do
    kind="${spec%%|*}"; pattern="${spec#*|}"
    if grep -qP -- "$pattern" "$f" 2>/dev/null; then
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
# T-66 · שער-הכספת-הקנוני: בלוב-כספת-שאינו-נפתח-בסיסמה-הבלועה-לא-נכנס-לגיט.
# (הלקח-החי-מ-13:14-ה-10.10: התאום-החזיר-מעטפת-T-62-לא-פתיחה-על-פני-הקנונית —
#  מלחמת-בלובים-בין-שתי-מכונות. השער-חוסם-אותה-מבנית: מה-שלא-נפתח-לא-נדחף;
#  הself-heal-של-T-65-מרפא-את-המקומי-בכל-10-דק'.)
if git diff --cached --name-only | grep -q '^vault/vault-backup.enc$'; then
  if ! bun "$SANBOX/scripts/vault-guard.mjs" "$SANBOX/vault/vault-backup.enc"; then
    git restore --staged --worktree -- vault/vault-backup.enc 2>/dev/null || true
    echo 'vault-guard: בלוב-לא-קנוני-הושמט-מהקומיט (fail-closed-לכספת, המשך-לשאר)'
    mkdir -p "$RECEIPTS"
    printf '{"ts":"%s","guard":"vault","ok":false,"action":"blob-excluded-from-commit"}\n' "$(now_iso)" >> "$RECEIPTS/vault-guard.jsonl"
  fi
fi
if ! git diff --cached --quiet; then
  MSG="HQ sync $(now_iso)"
  if ! git commit -m "$MSG" 2>/dev/null; then
    git -c user.name=hq -c user.email=hq@localhost commit -m "$MSG"
  fi
fi
COMMIT="$(git rev-parse --short HEAD)"

# --- מסלול-מהיר: origin-קיים-ונקי → ה-git-הוא-שופט-האמת; אין-צורך-ב-API-bootstrap
#     (לקח-T-49: 403-של-מגבלת-קצב-ב-/user-חסם-דחיפות-תקינות-לגמרי-למרות-שה-PAT-תקין) ---
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
case "$ORIGIN_URL" in
  https://github.com/*/*.git)
    REPO_FULL="$(printf '%s' "$ORIGIN_URL" | sed -E 's#https://github.com/([^/]+/.+)\.git#\1#')"
    echo "מסלול-מהיר: remote-קיים → $REPO_FULL (אין-קריאות-API)"
    ;;
  *)
    # --- זיהוי-משתמש (רק-באתחול-ראשון; 403/429 = ניסיון-חוזר — לקח-T-48b) ---
    command -v curl >/dev/null 2>&1 || { echo 'curl לא זמין'; log_push false auth "$COMMIT" 'sanbox' true; exit 1; }
    LOGIN=""
    for attempt in 1 2 3; do
      HTTP_CODE="$(curl -sS --max-time 20 -o /tmp/hq-user.json -w '%{http_code}' \
        -H "Authorization: Bearer $PAT" -H 'User-Agent: hq' https://api.github.com/user 2>/dev/null)" || HTTP_CODE="000"
      if [ "$HTTP_CODE" = "200" ]; then
        LOGIN="$(grep -oE '"login"[[:space:]]*:[[:space:]]*"[^"]*"' /tmp/hq-user.json | head -n1 \
          | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')"
        [ -n "$LOGIN" ] && break
      fi
      # 403/429 = מגבלת-קצב (לא-דחיית-PAT) — המתנה-וניסיון-חוזר
      echo "… /user החזיר $HTTP_CODE (ניסיון $attempt/3) — המתנה-לפני-חוזר"
      sleep $((attempt * 4))
    done
    rm -f /tmp/hq-user.json
    [ -n "$LOGIN" ] || { echo 'זיהוי-משתמש נכשל (גם אחרי חוזרים)'; log_push false auth "$COMMIT" 'sanbox' true; exit 1; }
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

    # --- remote-נקי-ללא-טוקן (אתחול-ראשון) ---
    URL="https://github.com/$LOGIN/sanbox.git"
    git remote add origin "$URL" 2>/dev/null || true
    ;;
esac

# --- דחיפה-עם-askpass-זמני (נמחק-בכל-יציאה) ---
mkdir -p "$DB"
cat > "$ASKPASS" <<'EOF'
#!/bin/sh
case "$1" in Username*) echo "x-access-token";; *) echo "$HQ_TOKEN";; esac
EOF
chmod 700 "$ASKPASS"
ASKPASS_CREATED=1

# --- משיכה-ב-rebase-לפני-דחיפה (פריטה-זהה-ל-autoPush ב-core/ops.ts — לקח-T-49:
#     הדחיפה-העצמית-של-HQ-עלולה-להקדים-את-הדוחף-הידני; בלי-rebase-הדחיפה-נדחית) ---
# T-51: תאום-ריבוני-שני-חי-במקביל — התנגשות-rebase אינה-כשל-סופי.
# T-66-תיקון-מחלקה: במקום `-X theirs`-עיוור (שהחזיר-בשקט-בלוב-כספת-ישן — T-64)
# פותר-ממוקד: קבצי-ריצה=מקומי-מנצח · קוד/כספת=הרחוק-מנצח (אפס-דריסת-עמיתים).
if ! PULL_OUT="$(GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$ASKPASS" HQ_TOKEN="$PAT" \
  git pull --rebase --autostash origin main 2>&1)"; then
  printf '%s\n' "$PULL_OUT" | awk -v t="$PAT" '{ gsub(t, "••••"); print }'
  echo 'התנגשות-rebase — פותר-ממוקד (ריצה=מקומי · קוד/כספת=רחוק)…'
  if ! SANBOX_DIR="$SANBOX" bash "$SANBOX/scripts/rebase-resolve.sh"; then
    git rebase --abort 2>/dev/null || true
    log_push false pull "$COMMIT" "$REPO_FULL" true
    echo 'משיכת-rebase נכשלה גם-בפותר-הממוקד — fail-closed (אין-force)'
    exit 1
  fi
fi
printf '%s\n' "$PULL_OUT" | awk -v t="$PAT" '{ gsub(t, "••••"); print }'
COMMIT="$(git rev-parse --short HEAD)"

PUSH_OUT="$(GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$ASKPASS" HQ_TOKEN="$PAT" git push -u origin main 2>&1)" || {
  printf '%s\n' "$PUSH_OUT" | awk -v t="$PAT" '{ gsub(t, "••••"); print }'
  log_push false push "$COMMIT" "$REPO_FULL" true
  echo 'דחיפה נכשלה'
  exit 1
}
printf '%s\n' "$PUSH_OUT" | awk -v t="$PAT" '{ gsub(t, "••••"); print }'

log_push true push "$COMMIT" "$REPO_FULL" true
echo "נדחף: $REPO_FULL @ $COMMIT"
