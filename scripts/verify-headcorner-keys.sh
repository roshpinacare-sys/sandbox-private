#!/bin/bash
# verify-headcorner-keys.sh — אימות-אפס-אמון-של-4-מפתחות-Head-Corner (T-55).
# לא מדפיס אף טוקן מלא — רק קודי-HTTP + מטאדטה-ממוסכת. אפס-תלויות: curl בלבד.
set -u
F="${1:-/home/z/my-project/upload/apiii.txt}"
GITLAB=$(sed -n 's/.*Head Corner: \(glpat-[^ ]*\).*/\1/p' "$F" | head -1)
SUPA=$(sed -n 's/.*Head Corner: \(sbp_[^ ]*\).*/\1/p' "$F" | head -1)
VERCEL=$(sed -n 's/.*Head Corner: \(vck_[^ ]*\).*/\1/p' "$F" | head -1)
RENDER=$(sed -n 's/.*Head Corner: \(rnd_[^ ]*\).*/\1/p' "$F" | head -1)
mask() { sed -E 's/(glpat-|sbp_|vck_|rnd_)[A-Za-z0-9._-]+/\1••••/g'; }
echo "== 1. GitLab (glpat-) =="
if [ -n "$GITLAB" ]; then
  R=$(curl -s -m 15 -w "\n%{http_code}" -H "PRIVATE-TOKEN: $GITLAB" "https://gitlab.com/api/v4/user" | mask)
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | head -n -1)
  echo "http=$CODE"
  echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print('user=',d.get('username','?'),'| id=',d.get('id','?'),'| admin=',d.get('is_admin','?'))" 2>/dev/null || echo "$BODY" | head -c 200
  SC=$(curl -s -m 15 -H "PRIVATE-TOKEN: $GITLAB" "https://gitlab.com/api/v4/personal_access_tokens/self" | mask)
  echo "token-self: $(echo "$SC" | python3 -c "import sys,json;d=json.load(sys.stdin);print('scopes=',d.get('scopes'),'| expires=',d.get('expires_at'),'| name=',d.get('name'))" 2>/dev/null || echo "$SC" | head -c 200)"
else echo "אין-טוקן"; fi
echo "== 2. Supabase (sbp_) =="
if [ -n "$SUPA" ]; then
  R=$(curl -s -m 15 -w "\n%{http_code}" -H "Authorization: Bearer $SUPA" "https://api.supabase.com/v1/projects" | mask)
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | head -n -1)
  echo "http=$CODE"
  echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print('projects=',len(d));[print(' -',p.get('name'),'|',p.get('id'),'|',p.get('region'),'|',p.get('status')) for p in d[:10]]" 2>/dev/null || echo "$BODY" | head -c 200
else echo "אין-טוקן"; fi
echo "== 3. Vercel (vck_) =="
if [ -n "$VERCEL" ]; then
  R=$(curl -s -m 15 -w "\n%{http_code}" -H "Authorization: Bearer $VERCEL" "https://api.vercel.com/v2/user" | mask)
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | head -n -1)
  echo "http=$CODE"
  echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin).get('user',{});print('user=',d.get('username'),'| email=',d.get('email'),'| plan=',d.get('billing',{}).get('plan'))" 2>/dev/null || echo "$BODY" | head -c 200
  PR=$(curl -s -m 15 -H "Authorization: Bearer $VERCEL" "https://api.vercel.com/v9/projects?limit=5" | mask)
  echo "projects: $(echo "$PR" | python3 -c "import sys,json;d=json.load(sys.stdin);print([p.get('name') for p in d.get('projects',[])])" 2>/dev/null || echo "$PR" | head -c 150)"
else echo "אין-טוקן"; fi
echo "== 4. Render (rnd_) =="
if [ -n "$RENDER" ]; then
  R=$(curl -s -m 15 -w "\n%{http_code}" -H "Authorization: Bearer $RENDER" "https://api.render.com/v1/owners?limit=10" | mask)
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | head -n -1)
  echo "http=$CODE"
  echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print('owners=',[(o.get('name'),o.get('id')[:14]) for o in d])" 2>/dev/null || echo "$BODY" | head -c 200
  SV=$(curl -s -m 15 -H "Authorization: Bearer $RENDER" "https://api.render.com/v1/services?limit=5" | mask)
  echo "services: $(echo "$SV" | python3 -c "import sys,json;d=json.load(sys.stdin);print([(s.get('service',{}).get('name'),s.get('service',{}).get('serviceDetails',{}).get('url')) for s in d])" 2>/dev/null || echo "$SV" | head -c 150)"
else echo "אין-טוקן"; fi
echo "== סוף-אימות (אפס-טוקנים-בפלט) =="
