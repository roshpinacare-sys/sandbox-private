#!/bin/bash
# ═══ sovereignty-drill.sh — תרגיל-מות-הסנדבוקס (T-64) ════════════════════════
# מה-הוא-מוכיח: אם-הסנדבוקס-מתה, clone טרי-מ-GitHub בלבד משחזר-את-כל-הסודות:
#   clone → bun install (lockfile) → פתיחת-ארנק (seal.a⊕seal.b) →
#   שליפת-סיסמת-הכספת-מהמעטפת-הבלועה (hq-vault-pass) → שחזור-כספת-הסודות →
#   אימות-bit-identity מול-הסודות-החיים.
# חוזה: אף-סוד-לא-נדפס, לא-נכתב-לדיסק (הסיסמה-חיה-בצינור/זיכרון-בלבד).
# אכסניה: /tmp-מנוקה-בסוף. פלט-סופי: JSON עם PROVEN=true/false. כישלון → exit 1.
# הרצה: bash sanbox/scripts/sovereignty-drill.sh
set -u
PROJ="${SOV_PROJ:-/home/z/my-project}"
T="$(mktemp -d /tmp/sov-drill.XXXXXX)"
trap 'rm -rf "$T"' EXIT
redact() { sed 's|x-access-token:[^@]*|x-access-token:<REDACTED>|g'; }
fail() { echo "{\"ok\":false,\"stage\":\"$1\",\"PROVEN\":false}"; exit 1; }

echo "[1/7] clone טרי מ-GitHub (saos-control-center + sanbox)…"
TOKEN="$(tr -d '\r\n ' < "$PROJ/upload/pat.env")"
export GIT_TERMINAL_PROMPT=0
timeout 120 git clone -q "https://x-access-token:${TOKEN}@github.com/roshpinacare-sys/saos-control-center.git" "$T/cc" 2>&1 | redact
timeout 120 git clone -q "https://x-access-token:${TOKEN}@github.com/roshpinacare-sys/sanbox.git" "$T/sb" 2>&1 | redact
unset TOKEN
[ -d "$T/cc/.git" ] && [ -d "$T/sb/.git" ] || fail clone

echo "[2/7] התקנת-תלות מה-lockfile הנעול (npm-ציבורי בלבד)…"
(cd "$T/cc" && timeout 300 bun install --frozen-lockfile >/dev/null 2>&1) || fail install

echo "[3/7] פתיחת-ארנק-ריבוני מה-clone (seal.a ⊕ seal.b)…"
if ! (cd "$T/cc" && timeout 90 bun scripts/repo-vault-open.ts >/dev/null 2>&1); then fail wallet-open; fi

echo "[4/7] שליפת-סיסמת-הכספת-מהמעטפת-הבלועה (זיכרון-בלבד)…"
PASS="$(cd "$T/cc" && timeout 60 bun scripts/repo-vault-emit.ts --name hq-vault-pass 2>/dev/null)"
[ -n "$PASS" ] || fail emit
echo "[4/7] ✓ הסיסמה-נשלפה-לזיכרון (לא-תועדה-בשום-מקום)"

echo "[5/7] שחזור-כספת-הסודות מה-clone אל-תיקיית-בודדים…"
(cd "$T/sb" && VAULT_SANDBOX_ROOT="$T/sb" HQ_VAULT_PASS="$PASS" timeout 90 bun scripts/vault-restore.ts) > "$T/restore.json" 2>"$T/restore.err"
RESTORE_OK="$(grep -o '"ok":true' "$T/restore.json" | head -1)"
[ "$RESTORE_OK" = '"ok":true' ] || { echo "[5/7] restore.err: $(head -2 "$T/restore.err")"; fail restore; }
unset PASS
echo "[5/7] ✓ $(grep -o '"restored":\[[^]]*\]' "$T/restore.json" | head -c 200)"

echo "[6/7] אימות bit-identity מול-הסודות-החיים…"
LIVE="$PROJ/sanbox/secrets"
REST="$T/sb/secrets"
names_live="$(ls "$LIVE" | sort)"
names_rest="$(ls "$REST" | sort)"
[ "$names_live" = "$names_rest" ] || fail names
mism=0
for f in $names_live; do
  a="$(sha256sum "$LIVE/$f" | cut -d' ' -f1)"
  b="$(sha256sum "$REST/$f" | cut -d' ' -f1)"
  if [ "$a" != "$b" ]; then echo "[6/7] ✗ MISMATCH: $f"; mism=$((mism+1)); fi
done
[ "$mism" -eq 0 ] || fail identity
echo "[6/7] ✓ $(echo "$names_live" | wc -l) קבצי-סודות — bit-identity מלא"

echo "[7/7] בדיקת-ארטיפקטים-חיוניים ב-clone…"
for p in worklog.md repo-vault/RECOVERY-PLAYBOOK.md repo-vault/wallet.enc.json sanbox/vault/vault-backup.enc; do
  [ -f "$T/cc/$p" ] || fail "artifact:$p"
done
CC_HEAD="$(git -C "$T/cc" rev-parse HEAD)"
SB_HEAD="$(git -C "$T/sb" rev-parse HEAD)"

echo "{\"ok\":true,\"PROVEN\":true,\"cc\":\"${CC_HEAD:0:7}\",\"sb\":\"${SB_HEAD:0:7}\",\"secretsRestored\":$(echo "$names_live" | wc -l)}"
echo "תרגיל-הריבונות עבר: מות-הסנדבוקס לא מאבד דבר — הכל משתחזר מהגיט."
exit 0
