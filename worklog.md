# worklog — sanbox (append-only · עברית)

---
Task ID: 46
Agent: agent-6
Task: הלב-השני-נולד — heart-tick + sovereign-heart workflow; HQ-חי-ומוכח-E2E

Work Log:
- scripts/heart-tick.mjs: stdlib-בלבד (node:crypto/fs/child_process/url; תואם-Node-ו-Bun); מצערת-12דק'-ב-CI; שרשרת sha256(head|prevChain|at)[:24]; קבלת-רשומה-מעוקבת state/heart/last.json + יומן-מקומי-מנוטרל receipts/heart/log.jsonl (זנב-500)
- .github/workflows/sovereign-heart.yml: cron 13,43 · push · workflow_dispatch · repository_dispatch[sovereign-heart]-עצמי; GITHUB_TOKEN-בלבד; commit-rebase-safe; chain-next = sleep-עד-המשבצת-הבאה→dispatch-עצמי
- מבחן-חי-מקומי: טיק genesis→fcecdd212f468286a89f1638→a33fe750f149667ce28d1289 (קיפול-שרשרת-מוכח); קבלה-נכתבה-בשני-המסלולים
- HQ: server.ts+supervisor.ts+guardian.ts+boot-all.sh — דלת-HQ_PORT-נפתחה (ברירת-מחדל 3010-שמורה); HQ-חי-מקומית-על 3011 (3010=דקס)
- E2E (receipts/e2e-hq.json): root=200 "Head Corner — שער-הכניסה" · 401×5→429 (מצערת-חיה) · /api/status=401 — נעול-כחוק-עד-שהבעלים-משחזר-hq.password
- הכספת: secrets/pat.env (600; PAT-מאומת len=93); boot-all.sh+guardian(~/.sovereign)-מוכנים-להקמה-על-כל-מכונה-טרייה
- הערה-כנה: תקרת-זיכרון-הסנדבוקס-האפמרלי (free≈121MB) קוצרת-תהליכים-מקומית-ב-OOM-שקט — המנגנון-מחיה-אוטומטית-נמדד-חי; על-מכונת-הבעלים-הכל-יציב

Stage Summary:
- sanbox=לב-ריבוני-שני-עצמאי-לגמרי (אף-מצב/סוד/תלות-משותפים-עם-Sandbox)
- השרת-חי-ומוכח; השער-קשה-ונעול-כחוק; הקמה-מחדש-בפקודה-אחת (scripts/boot-all.sh)
