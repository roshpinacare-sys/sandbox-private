#!/usr/bin/env bash
# rebase-resolve.sh (T-66) — פותר-התנגשויות-rebase-באסטרטגיה-ממוקדת-במקום--X-theirs-עיוור.
#
# המשפט-שנאסר (T-64-מדוד): `pull --rebase -X theirs` החזיר-בשקט-בלוב-כספת-ישן
# ומחק-עבודה-שנדחפה. המחלקה: רזולוציה-אחידה-לכל-הקבצים.
#
# האסטרטגיה-החדשה (בהקשר-rebase: ours=הרחוק שכבר-מיושם · theirs=הpick-המקומי):
#   · קבצי-ריצה (state/ · db/state-snapshot.json · *.jsonl · receipts/ · heart · last.json · *.lock)
#     → theirs (המקומי מנצח — הקדנס-המקומי-הוא-הכותב-הקנוני-של-מצבו)
#   · קוד/כספת/כל-השאר
#     → ours (הרחוק מנצח — origin-הוא-נקודת-האינטגרציה; אף-עמית-לא-נדרס,
#       וכספת-לא-מוחזרת-אחורה — השער-vault-guard-אוסר-דחיפת-בלוב-לא-קנוני-בכל-מקרה)
#   · יומנים (worklog/MEMORY/*.jsonl) — union-דרך-.gitattributes, אף-פעם-לא-מגיעים-לכאן
#
# אפס-סודות. יציאה: 0=נפתר-והריבייז-הושלם · 1=לא-הצליח (הקורא עושה abort+fail-closed)
set -u
cd "${SANBOX_DIR:-/home/z/my-project/sanbox}" || exit 1

RUNTIME_RE='^(state/|db/state-snapshot\.json$|.*\.jsonl$|receipts/|.*heart.*|.*last\.json$|.*\.lock$)'

conflicts_now() { git diff --name-only --diff-filter=U 2>/dev/null || true; }

# פותר-את-כל-ההתנגשויות-הפתוחות-עכשיו-וממשיך-את-הריבייז; ok=1-אם-continue-עבר
resolve_batch() {
  local c f
  c="$(conflicts_now)"
  [ -n "$c" ] || return 1 # אין-מה-לפתור — הקורא-מבין-שאין-ריבייז-עצור
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if printf '%s' "$f" | grep -qE "$RUNTIME_RE"; then
      git checkout --theirs -- "$f" 2>/dev/null || git rm --quiet -- "$f" 2>/dev/null || true
    else
      git checkout --ours -- "$f" 2>/dev/null || git rm --quiet -- "$f" 2>/dev/null || true
    fi
    git add -- "$f" 2>/dev/null || true
  done <<< "$c"
  git -c core.editor=true rebase --continue >/dev/null 2>&1
}

# עד-3-picks-סותרים-ברצף
for _ in 1 2 3; do
  [ -n "$(conflicts_now)" ] || { echo "rebase-resolve: אין-התנגשויות"; exit 0; }
  resolve_batch || { echo "rebase-resolve: continue-נכשל" >&2; exit 1; }
done
if [ -z "$(conflicts_now)" ]; then
  echo "rebase-resolve: התנגשויות-נפתרו-ממוקדת (אפס-דריסת-עמיתים)"
  exit 0
fi
echo "rebase-resolve: לא-התכנס-תוך-3-סבבים" >&2
exit 1
