#!/bin/sh
# vault-drill.sh — T-61: מבחן-החלמת-אסון-מדוד-של-הכספת-הריבונית
# ============================================================
# מדמה-מחיקת-כספת-מלאה → שחזור-מ-vault-backup.enc (המטען-שנוסע-בגיט)
# → השוואת-טביעות-אצבע-ביט-ביט. נכשל-בטוח: רשת-ביטחון-ב-/tmp ושחזור-חוזר-אוטומטי.
#
# הדוקטרינה: "הגיט-הוא-הקוד-המלא" — מבחן-זה-מוכיח-אותה-שוב-ושוב בלי-לגעת-בעננים.
# קבלה: receipts/vault-drill.jsonl (tail-7)
# הרצה: sh sanbox/scripts/vault-drill.sh

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="receipts/vault-drill.jsonl"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

receipt() {
  LINE="{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"$1\"}"
  echo "$LINE" >> "$LOG"
  echo "[vault-drill] $LINE"
  # שמירה-על-זנב-קצר
  TAIL_N=7
  LINES=$(wc -l < "$LOG")
  if [ "$LINES" -gt "$TAIL_N" ]; then
    tail -n "$TAIL_N" "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

# 1) טביעות-אצבע-לפני + רשת-ביטחון-מחוץ-לסנדבוקס
if [ ! -d secrets ]; then
  receipt '"ok":false,"reason":"no-vault-dir"}'
  exit 1
fi
sha256sum secrets/* > "$TMP/before.sha" 2>/dev/null || { receipt '"ok":false,"reason":"hash-before-failed"}'; exit 1; }
cp -a secrets "$TMP/backup"

# 2) המחיקה-המדומה
rm -rf secrets

# 3) שחזור-מהמטען-המוצפן (אותו-מסלול-כמו-boot-all)
if [ ! -f vault/vault-backup.enc ]; then
  receipt '"ok":false,"reason":"no-encrypted-cargo"}'
  cp -a "$TMP/backup" secrets
  exit 1
fi
PASS="$(cat "$TMP/backup/hq.password")"
if ! HQ_VAULT_PASS="$PASS" bun scripts/vault-restore.ts > "$TMP/restore.out" 2>&1; then
  receipt '"ok":false,"reason":"restore-failed"}'
  cp -a "$TMP/backup" secrets
  exit 1
fi

# 4) אימות-ביט-ביט
sha256sum secrets/* > "$TMP/after.sha" 2>/dev/null
if diff -q "$TMP/before.sha" "$TMP/after.sha" > /dev/null 2>&1; then
  receipt "\"ok\":true,\"result\":\"bit-identical\",\"files\":$(wc -l < "$TMP/after.sha")}"
else
  receipt '"ok":false,"result":"hash-mismatch"}'
  cp -a "$TMP/backup" secrets
  exit 1
fi
