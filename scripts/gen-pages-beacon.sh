#!/bin/sh
# gen-pages-beacon.sh — T-57: המגדלור-הריבוני-חוץ-מכונה ב-GitLab-Pages.
#
# הרעיון: ה-CI-של-גיטלאב-רץ-על-ברזל-של-גוגל — לא-על-המכונה-שלנו. אם-המכונה-מתה,
# כל-דחיפה-עתידית-מכל-מקור-מציתה-את-ה-CI-הזה, שמאמת-את-שלמות-המאגר (צופה-חוץ-מכונה)
# ומפרסם-את-מפת-החיים-הריבונית-ל-Pages (קונסולה-שחיה-בלי-המכונה).
#
# הכל-מבוסס-רק-על-מצב-מקומט-בגיט — אפס-סודות, אפס-תלויות-חוץ. fail-closed-בתוך-ה-CI:
# אם-השלמות-נפגעה — ה-pipeline-נכשל-וועדה-עדה-זועקת-בענן-השני.
#
# שימוש: sh scripts/gen-pages-beacon.sh   (ב-CI או-מקומית-לבדיקה)

set -eu
cd "$(dirname "$0")/.."
mkdir -p public

# === מזהי-CI-או-מקומי ===
HEAD_SHA="${CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
HEAD_DATE="${CI_COMMIT_TIMESTAMP:-$(git log -1 --format=%cI 2>/dev/null || echo unknown)}"
BRANCH="${CI_COMMIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo local)}"

# === מצב-הלב (מקומט-בגיט — ההיסטוריה-היא-הראיה) ===
HEART_AT=$(grep -o '"at"[[:space:]]*:[[:space:]]*"[^"]*"' state/heart/last.json 2>/dev/null | head -1 | cut -d'"' -f4 || true)
HEART_CHAIN=$(grep -o '"chain"[[:space:]]*:[[:space:]]*"[^"]*"' state/heart/last.json 2>/dev/null | head -1 | cut -d'"' -f4 || true)

# === טביעות-זיכרון ===
W_SHA=$(sha256sum memory/worklog.md 2>/dev/null | cut -c1-12 || echo missing)
M_SHA=$(sha256sum memory/MEMORY.md 2>/dev/null | cut -c1-12 || echo missing)
V_BYTES=$(wc -c < vault/vault-backup.enc 2>/dev/null || echo 0)

# === סדרת-האימות — ה-CI-הוא-הצופה-חוץ-מכונה (fail-closed) ===
test -s vault/vault-backup.enc || { echo "WATCHDOG-FAIL: vault-backup.enc חסר/ריק — הכספת-לא-נוסעת-עם-הגיט"; exit 1; }
test -s memory/worklog.md      || { echo "WATCHDOG-FAIL: worklog ריק/חסר"; exit 1; }
test -s memory/MEMORY.md       || { echo "WATCHDOG-FAIL: MEMORY ריק/חסר"; exit 1; }
test -s state/heart/last.json  || { echo "WATCHDOG-FAIL: הלב-חסר"; exit 1; }
grep -q '"at"' state/heart/last.json || { echo "WATCHDOG-FAIL: הלב-פגום (אין-at)"; exit 1; }
echo "WATCHDOG-GREEN: vault=${V_BYTES}B worklog=${W_SHA} memory=${M_SHA}"

# === בניית-state.json (מצב-אחרון-למכונה) ===
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > public/state.json <<EOF
{
  "schema": "roshpina.sovereign-beacon/1",
  "publisher": "gitlab-ci (ברזל-חוץ-מכונה)",
  "generatedAt": "$NOW",
  "commit": "$HEAD_SHA",
  "commitDate": "$HEAD_DATE",
  "branch": "$BRANCH",
  "lastKnownAlive": {
    "heartAt": "${HEART_AT:-null}",
    "heartChain": "${HEART_CHAIN:-null}",
    "worklogSha12": "$W_SHA",
    "memorySha12": "$M_SHA",
    "vaultBytes": $V_BYTES
  },
  "memoryLayers": [
    { "layer": "github", "detail": "roshpinacare-sys/sanbox" },
    { "layer": "gitlab", "detail": "roshpinacare/sanbox + Pages-הזה" },
    { "layer": "postgres", "detail": "Supabase sovereign_state (state-replica)" },
    { "layer": "pages-beacon", "detail": "הקונסולה-הזו — נולדה-ב-CI-חוץ-מכונה" }
  ],
  "awakening": [
    "1. הגיט-הוא-הקוד-המלא: שני-עננים-נושאים-sanbox + vault/vault-backup.enc (AES-256-GCM)",
    "2. שחזור-כספת: bun core/vault restore — המפתח-הוא-hq.password אצל-Head-Corner",
    "3. הצתה: sh sanbox/scripts/boot-all.sh — סודות→כספת→מפקח→שומר→HQ-3010",
    "4. זיכרון-חוץ-מכונה: bun scripts/state-replica.mjs pull",
    "5. ההתחדשות-אוטומטית: קומיט=הצתה; הלב-פועם-כל-15-דקות"
  ],
  "doctrine": "אפס-אמון-בטענות · הכל-מנוטר-בגיט · fail-open-לעננים-חוץ-מכונה · הכספת-נפתחת-רק-בסיסמה"
}
EOF

# === בניית-index.html (הקונסולה) ===
cat > public/index.html <<'HTMLEOF'
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ראש פינה — מגדלור ריבוני</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0a0a0f; color: #e7e7ee; min-height: 100vh; padding: 24px; }
  .wrap { max-width: 780px; margin: 0 auto; }
  header { text-align: center; padding: 28px 0 18px; }
  .pulse { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
           background: #22c55e; box-shadow: 0 0 12px #22c55e; animation: p 2s infinite; }
  @keyframes p { 50% { opacity: .4; } }
  h1 { font-size: 1.7rem; margin: 12px 0 4px; }
  .sub { color: #9a9ab0; font-size: .95rem; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); margin: 18px 0; }
  .card { background: #14141c; border: 1px solid #26263a; border-radius: 12px; padding: 16px; }
  .l-name { font-weight: 700; color: #d4b483; margin-bottom: 6px; }
  .l-detail { font-size: .88rem; color: #b9b9cc; }
  .stat { background: #14141c; border: 1px solid #26263a; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .stat b { color: #d4b483; }
  .stat code { background: #1d1d29; padding: 2px 7px; border-radius: 6px; font-size: .85rem;
               direction: ltr; unicode-bidi: embed; }
  h2 { font-size: 1.1rem; color: #d4b483; margin: 22px 0 10px; }
  ol { padding-inline-start: 22px; }
  li { margin-bottom: 9px; color: #c9c9db; font-size: .92rem; line-height: 1.65; }
  .doct { text-align: center; color: #71718c; font-size: .8rem; padding: 22px 0 6px; line-height: 1.8; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="pulse"></span>
    <h1>ראש פינה — מגדלור ריבוני</h1>
    <div class="sub">קונסולה-חוץ-מכונה · נולדה-ב-CI של גיטלאב · חיה-גם-כשהמכונה-מתה</div>
  </header>
  <div class="stat" id="alive"><b>טוען-מצב-אחרון…</b></div>
  <h2>ארבע-שכבות-הזיכרון-העצמאיות</h2>
  <div class="grid" id="layers"></div>
  <h2>מפת-ההערה (שיקום-מאפס)</h2>
  <div class="stat"><ol id="awaken"></ol></div>
  <div class="doct" id="doct"></div>
</div>
<script>
fetch('state.json').then(r => r.json()).then(s => {
  const fmt = (x) => x ? String(x).replace('T', ' ').slice(0, 19) + 'Z' : '—';
  document.getElementById('alive').innerHTML =
    '<b>חי-אחרון-ידוע (לב):</b> <code>' + fmt(s.lastKnownAlive.heartAt) + '</code><br>' +
    '<b>קומיט:</b> <code>' + String(s.commit).slice(0, 12) + '</code> (' + fmt(s.commitDate) + ')<br>' +
    '<b>טביעת-יומן:</b> <code>' + s.lastKnownAlive.worklogSha12 + '</code> · ' +
    '<b>טביעת-זיכרון:</b> <code>' + s.lastKnownAlive.memorySha12 + '</code> · ' +
    '<b>כספת:</b> <code>' + s.lastKnownAlive.vaultBytes + 'B</code> · ' +
    '<b>ענף:</b> <code>' + s.branch + '</code>';
  document.getElementById('layers').innerHTML = s.memoryLayers.map(l =>
    '<div class="card"><div class="l-name">' + l.layer + '</div><div class="l-detail">' + l.detail + '</div></div>').join('');
  document.getElementById('awaken').innerHTML = s.awakening.map(x => '<li>' + x + '</li>').join('');
  document.getElementById('doct').innerHTML = s.doctrine + '<br>נוצר-ב-CI-חוץ-מכונה · ' + fmt(s.generatedAt) + ' · publisher: ' + s.publisher;
}).catch(() => {
  document.getElementById('alive').innerHTML = '<b>state.json-לא-נטען</b> — הדף-חי-אך-המצב-חסר';
});
</script>
</body>
</html>
HTMLEOF

echo "BEACON-BUILT: public/index.html + public/state.json"
