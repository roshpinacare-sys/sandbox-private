#!/bin/sh
# sovereignty-drill.sh — משפט-הריבונות (T-65): הוכחה-בפועל ש-"אפס-תלות-בסנדבוקס".
# =====================================================================================
# השאלה: האם-הריבונות-שורדת-מחיקת-מכונה? המבחן (אפס-טענות, רק-ראיות):
#   ①  עננים-נשאלים-מרחוק (GitHub-API · GitLab-API · מגדלור-200+תוכן) — לא-מקומי
#   ②  מכונה-חדשה-מדומה: clone-טרי-מ-GitHub → ספירת-ערכת-תחייה (12-רכיבים)
#   ③  שחזור-כספת-בתוך-הclone (HQ_VAULT_PASS-מ-guardian.env — חוזה-מפתח-ידוע)
#   ④  השוואה-ביט-מול-הסודות-החיים (sha256-לכל-קובץ) → bit-identical או-כישלון-כן
# כישלון-כל-שלב → יציאה-1 + קבלה-אדומה (fail-loud). ריצה-חוזרת-בטוחה (TMP-מת-בסוף).
# שימוש: sh sanbox/scripts/sovereignty-drill.sh
# =====================================================================================
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
LOG="$ROOT/receipts/sovereignty-drill.jsonl"
FAIL=0

receipt() {
  printf '{"ts":"%s",%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"
}

# --- מפתח-הכספת: חוזה-מפתח-ידוע-בלבד (HQ_VAULT_PASS מ-guardian.env) ---
VAULT_PASS="$(grep -m1 '^HQ_VAULT_PASS' "$HOME/.sovereign/guardian.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d ' ')"
if [ -z "$VAULT_PASS" ]; then
  receipt '"drill":"sovereignty","ok":false,"stage":"vault-pass","error":"HQ_VAULT_PASS not found in guardian.env"'
  echo "FATAL: HQ_VAULT_PASS לא-נמצא ב-guardian.env"; exit 1
fi

# --- PAT-לclone: חוזה-השורה-הראשונה (זהה-ל-readPat-במראה) ---
GH_PAT="$(grep -v '^[[:space:]]*#' "$ROOT/secrets/pat.env" 2>/dev/null | grep -m1 . | sed 's/^[^=]*=//' | tr -d '"'"'"'[:space:]')"
if [ -z "$GH_PAT" ]; then
  receipt '"drill":"sovereignty","ok":false,"stage":"pat","error":"PAT first-line contract failed"'
  echo "FATAL: PAT-לא-נקרא"; exit 1
fi

TMP="$(mktemp -d /tmp/sov-drill-XXXXXX)"
restore_on_fail() {
  if [ "$1" != "0" ] && [ -d "$TMP" ]; then cp -a "$TMP/clone" "$TMP/.rescued" 2>/dev/null; fi
}
trap 'rc=$?; restore_on_fail $rc; rm -rf "$TMP"; exit $rc' EXIT

echo "=== משפט-הריבונות (T-65) — $(date -u +%H:%M:%SZ) ==="

# ---------- ① עננים-מרחוק ----------
GH_SHA="$(curl -s -m 15 -H "Authorization: Bearer $GH_PAT" "https://api.github.com/repos/roshpinacare-sys/sanbox/branches/main" | grep -o '"sha": *"[0-9a-f]*"' | head -1 | sed 's/.*"sha": *"//;s/"//')"
LH_HTTP="$(curl -s -o "$TMP/lighthouse.json" -w '%{http_code}' -m 15 "https://roshpinacare-sys.github.io/sovereign-lighthouse/state.json")"
LH_MOTHER="$(grep -o 'motherConsole' "$TMP/lighthouse.json" 2>/dev/null | wc -l | tr -d ' ')"
LOCAL_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
if [ -n "$GH_SHA" ] && [ "$GH_SHA" = "$LOCAL_HEAD" ]; then GH_OK=true; else GH_OK=false; FAIL=1; fi
if [ "$LH_HTTP" = "200" ] && [ "$LH_MOTHER" -ge 1 ] 2>/dev/null; then LH_OK=true; else LH_OK=false; FAIL=1; fi
receipt "\"drill\":\"sovereignty\",\"stage\":\"clouds\",\"ok\":$GH_OK,\"githubHead\":\"${GH_SHA:-none}\",\"localHead\":\"$LOCAL_HEAD\",\"lighthouseHttp\":\"$LH_HTTP\",\"lighthouseHasMotherConsole\":$LH_OK"
echo "① עננים: GitHub-remote=$GH_SHA (התאמה=$GH_OK) · מגדלור=$LH_HTTP (motherConsole=$LH_OK)"

# ---------- ② מכונה-חדשה: clone-טרי ----------
if ! git clone -q --depth 1 "https://x-access-token:${GH_PAT}@github.com/roshpinacare-sys/sanbox.git" "$TMP/clone" 2>/dev/null; then
  receipt '"drill":"sovereignty","stage":"clone","ok":false,"error":"clone failed"'
  echo "FATAL: clone-נכשל"; exit 1
fi
KIT=""
for f in scripts/boot-all.sh scripts/install-guardian.sh scripts/vault-restore.ts vault/vault-backup.enc \
         scripts/heart-tick.mjs scripts/lighthouse-sync.mjs scripts/supervisor.ts scripts/console-server.ts \
         scripts/web-sense.mjs scripts/web-recon.mjs scripts/guardian.ts server.ts \
         memory/worklog.md memory/MEMORY.md repo-vault/escalations.json core/backup.ts; do
  if [ -f "$TMP/clone/$f" ]; then KIT="$KIT+$f"; else KIT="$KIT-MISSING:$f"; FAIL=1; fi
done
HARDENED="$(grep -o "child.on('error'" "$TMP/clone/scripts/supervisor.ts" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$HARDENED" -ge 1 ] 2>/dev/null; then HARD_OK=true; else HARD_OK=false; FAIL=1; fi
if [ "$FAIL" -eq 0 ]; then KIT_OK=true; else KIT_OK=false; fi
receipt "\"drill\":\"sovereignty\",\"stage\":\"fresh-clone-kit\",\"ok\":$KIT_OK,\"kit\":\"$KIT\",\"supervisorHardened\":$HARD_OK"
echo "② מכונה-חדשה: ערכת-תחייה — ${KIT#+} (מחוסן=$HARD_OK)"

# ---------- ③ שחזור-כספת-בתוך-המכונה-החדשה ----------
if (cd "$TMP/clone" && HQ_VAULT_PASS="$VAULT_PASS" bun scripts/vault-restore.ts > "$TMP/restore.out" 2>&1); then
  RESTORE_OK=true
else
  RESTORE_OK=false; FAIL=1
fi
receipt "\"drill\":\"sovereignty\",\"stage\":\"vault-restore-in-clone\",\"ok\":$RESTORE_OK"
echo "③ שחזור-כספת-במכונה-החדשה: $RESTORE_OK"

# ---------- ④ השוואה-ביט-מול-החיים ----------
IDENT=0; DIFF=0; DETAIL=""
LIVE_COUNT="$(ls "$ROOT"/secrets 2>/dev/null | wc -l | tr -d ' ')"
if [ -d "$TMP/clone/secrets" ] && [ "$LIVE_COUNT" -ge 1 ]; then
  for f in "$ROOT"/secrets/*; do
    b="$(basename "$f")"
    if [ -f "$TMP/clone/secrets/$b" ]; then
      if cmp -s "$f" "$TMP/clone/secrets/$b"; then IDENT=$((IDENT+1)); DETAIL="$DETAIL+$b"; else DIFF=$((DIFF+1)); DETAIL="$DETAIL-DIFF:$b"; FAIL=1; fi
    else DIFF=$((DIFF+1)); DETAIL="$DETAIL-MISSING:$b"; FAIL=1; fi
  done
else
  FAIL=1; receipt '"drill":"sovereignty","stage":"bit-compare","ok":false,"error":"no secrets dir in clone after restore"'
fi
if [ "$DIFF" -eq 0 ] && [ "$IDENT" -ge 1 ]; then BIT_OK=true; else BIT_OK=false; fi
receipt "\"drill\":\"sovereignty\",\"stage\":\"bit-compare\",\"ok\":$BIT_OK,\"identical\":$IDENT,\"different\":$DIFF,\"files\":\"$DETAIL\""
echo "④ ביט-מול-חיים: identical=$IDENT · different=$DIFF — $DETAIL"

# ---------- פסק-דין ----------
if [ "$FAIL" -eq 0 ]; then
  receipt '"drill":"sovereignty","ok":true,"verdict":"sovereign-proven","clouds":"remote-verified","freshClone":"full-kit","vault":"restored","secrets":"bit-identical"'
  echo "=== פסק-דין: ריבונות-מוכחת — המכונה-החדשה משחזרת-הכל-לבד ==="
else
  receipt '"drill":"sovereignty","ok":false,"verdict":"gaps-found"'
  echo "=== פסק-דין: נמצאו-פערים — ראה-קבלות ==="
fi
exit "$FAIL"
