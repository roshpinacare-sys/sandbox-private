# sanbox — השרת-המפעיל / הסנדבוקס-המקיף של-הרשת

**ROLE (declared 2026-10-11, task 10-c un-silence sweep):** the
**operator's local HQ server** (Bun :3010, scrypt door, secrets vault, git
pusher) — the human-side sandbox this whole fleet was steered from, and the
heart-writer home (lighthouse-sync). Died with the operator's machine on
10-10 (last heart tick 17:40 local) — dormancy is environmental, not
abandonment. Known risk recorded: `vault/vault-backup.enc` tracked in git.
Revival path: boot the machine, run the heart tick — the sovereign-heart
workflow stays dispatch-only with its honest billing header, and the 30-min
HQ-sync resumes by itself.

> נבנה-משותף-על-ידי-5 סוכנים (Task 42) — במקום-הסנדבוקסים-הזמניים-שנמחקים.
> הבעלים-הורה: כל-מה-שתלוי-סנדבוקס — נבנה-כאן, קבוע, ריבוני.

## מה-זה

שרת-HQ עצמאי (Bun-stdlib בלבד, אפס-תלויות) על-פורט **3010**:

- **דלת-אחת:** סיסמת-הבעלים (headcorner) — מאומתת-scrypt, session-HttpOnly.
- **כספת:** כל-הסודות (GitHub-PAT, OpenRouter, Cloudflare/R2) — מקומיים-בלבד, מנותקים-מגיט.
- **מבצעים:** סריקת-סודות-לפני-כל-דחיפה, דחיפת-גיט-מאומתת (טוקן-מעולם-לא-ב-argv/בקבצים), סטטוס-רשת.
- **שער-חוץ:** פורטל-הבעלים (Next.js ראשי, `/`) מתחבר-אליו-דרך-פרוקסי-API — הסודות-לא-יוצאים-מהכספת.

## מבנה

```
sanbox/
├── server.ts          # Bun.serve :3010 — הדלת-וה-API
├── core/
│   ├── auth.ts        # scrypt + sessions
│   ├── vault.ts       # כספת-סודות (שמות-בלבד-חוצה)
│   ├── ops.ts         # סטטוס, סריקה, דחיפה
│   └── scan-patterns.ts
├── public/            # ממשק-fallback (גישה-ישירה)
├── secrets/           # כספת — מנוטרלת-מגיט (.gitignore)
├── db/ receipts/      # זמן-ריצה — מנוטרלים-מגיט
└── scripts/
```

## אבטחה

- אפס-חשיפות: סריקת-7+ דפוסים-חוסמת-דחיפה-אם-כל-סוד-דולף-לקבצים-נעקבים.
- הטוקן-עובר-ל-git דרך-`credential.helper` עם-משתנה-סביבה — לא-ב-argv, לא-ב-.git/config, לא-בקבצים.
- ריפו-היעד: **פרטי** (הבעלים-יכול-להפוך-לציבורי-אחרי-אימות).

## הרצה

```bash
bun server.ts   # פורט 3010
```

## שרשרת-הריבונות

```
שומר-עצמאי (~/.sovereign)          ← טוקן-גישה-לריפו + קונפיג-הריבונות (מחוץ-ל-sanbox)
      │ משחזר-קוד-מהריפו-אם-הכל-נמחק (git clone)
      ▼
מפקח (scripts/supervisor.ts)       ← תמיד-חי; מחיה-את-שניהם
      ├──► HQ (sanbox, פורט 3010)   ← הדלת + הכספת + האופס
      └──► אפליקציה (Next.js, פורט 3000)

HQ (בכל-30 דק'):
  ├── דחיפה-עצמית: sync-זיכרון → סריקת-סודות → auto-commit → pull --rebase --autostash → push
  └── גיבוי-כספת-מוצפן: vault/vault-backup.enc (AES-256-GCM בסיסמת-האם — כתיבה-רק-בשינוי-תוכן)
```

הפורטל (`/`, פורט 3000) מציג-את-השרשרת-בכרטיס-'ריבונות' (שומר/גיבוי/סנכרון) ומאפשר
'גבה עכשיו' + 'שחזר מגיבוי'. אם-תיקיית-ה-sanbox נמחקה-כולה, הפורטל-משחזר-את-הקוד-מהריפו-לבדו
(ensure-hq → git clone) ואז-מקים-את-HQ.

### מכונה-חדשה (תחייה-מלאה)

```bash
git clone https://github.com/<owner>/sanbox.git
cd sanbox
./scripts/boot-all.sh
# שחזור-סודות (אם-הכספת-ריקה): HQ_VAULT_PASS='סיסמת-האם' bun scripts/vault-restore.ts
# שומר-עצמאי: sh scripts/install-guardian.sh
```
