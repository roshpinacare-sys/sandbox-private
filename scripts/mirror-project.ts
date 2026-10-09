/**
 * mirror-project.ts — רענון-המראה-העננית-של-כל-העץ-החי (T-49).
 *
 * למה-הוא-קיים: SovereignConsole (ריפו-פרטי) היא-העותק-הקנוני-המלא-של-העץ-החי
 * — עד-היום-נדחפה-ידנית-בלבד (פעם-אחת, 2026-10-09T18:30). מראה-שאינה-מתרעננת
 * אינה-ריבונות — היא-תמונת-עבר. הסקריפט-הזה-מכניס-את-הרענון-לשרשרת-החיים:
 * המפקח-מעיר-אותו-כל-6 שעות (וגם-ידנית: bun scripts/mirror-project.ts --force).
 *
 * מה-הוא-עושה (כל-ריצה):
 *   1. PAT-מהכספת (sanbox/secrets/pat.env) — אף-טוקן-לא-ב-argv/ב-URL/ב-.git/config
 *      (GIT_ASKPASS-זמני + HQ_TOKEN-בסביבה, נמחק-תמיד — היגיין-זהה-ל-push-hq.sh).
 *   2. מעבדת-שיקוף ב-~/.sovereign/mirror — היעדר → שכפול-מהמראה; קיימת → fetch+reset
 *      --hard-ל-origin/main (מתיישר-למרחוק-לפני-כל-העתקה — אפס-שאריות).
 *   3. מחיקת-כל-תוכן-המעבדה (חוץ-מ-.git) והעתקה-טרייה-של-העץ-החי-עם-רשימת-החרגות
 *      מפורשת (למטה) — מה-שהיה-במראה-הידנית: קוד+זיכרון+כלים, בלי-כבדים/רגישים.
 *   4. סריקת-סודות fail-closed על-כל-העץ-המועתק (BASE_RULES + דפוסים-דינמיים-מהכספת)
 *      — היט-אחד = אפס-דחיפה + קבלה.
 *   5. קומיט → pull --rebase → push (askpass). אין-שינויים = יציאה-נקייה.
 *
 * קבלות: receipts/mirror-last.json + receipts/mirror-log.jsonl;
 * מצב-מצערת: state/mirror/last.json (מעוקב-בגיט — נוסע-עם-הדחיפה-העצמית-של-HQ).
 * אפס-תלויות-חוץ: node:* בלבד + ייבוא-דפוסי-הסריקה-מ-core/scan-patterns.ts.
 */
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync,
  readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

const execFileP = promisify(execFile);

/* ---------- נתיבים ---------- */
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');               // sanbox/
const PROJECT = path.resolve(ROOT, '..');            // /home/z/my-project
const SOV_DIR = process.env.SOVEREIGN_DIR ?? path.join(process.env.HOME ?? '/home/z', '.sovereign');
const WORK = path.join(SOV_DIR, 'mirror');           // מעבדת-השיקוף (שורדת-מחיקת-הפרויקט)
const STATE = path.join(ROOT, 'state', 'mirror', 'last.json');
const RECEIPT_LAST = path.join(ROOT, 'receipts', 'mirror-last.json');
const RECEIPT_LOG = path.join(ROOT, 'receipts', 'mirror-log.jsonl');
const ASKPASS = path.join(ROOT, 'db', '.mirror-askpass.sh');

const MIRROR_URL =
  process.env.MIRROR_URL ??
  (() => {
    try {
      const cfg = JSON.parse(readFileSync(path.join(SOV_DIR, 'config.json'), 'utf8'));
      if (typeof cfg.mirrorUrl === 'string' && cfg.mirrorUrl) return cfg.mirrorUrl;
    } catch { /* ברירת-מחדל */ }
    return 'https://github.com/roshpinacare-sys/SovereignConsole.git';
  })();

/* ---------- מצערת ---------- */
const MIN_INTERVAL_MS = 6 * 60 * 60_000; // 6 שעות
const FORCE = process.argv.includes('--force') || process.env.MIRROR_FORCE === '1';
const GIT_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 1_000_000; // סריקה: קבצים-עד-1MB (קבצי-ענק-אינם-מקור-סודות-סביר)

/* ---------- החרגות-מפורשות (שקף-את-המראה-הידנית-המקורית + היגיין-סודות) ---------- */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.next', '.git', '.tmp-tools', 'tool-results', 'upload',
  'skills', 'db', '.sovereign', '.turbo', '.cache',
]);
const EXCLUDED_ROOT_ENTRIES = new Set([
  'dev.log', 'dev.out.log', 'server.log', 'tsconfig.tsbuildinfo', 'bun.lockb',
]);
// בתוך-sanbox-בלבד: הכספת-הגלויה-אסורה-במראה; הצופן-המוצפן (vault/) מותר-ונסרק-באדיבות
const EXCLUDED_UNDER_SANBOX = new Set(['secrets']);

/* ---------- קבלות ---------- */
function log(event: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(RECEIPT_LOG), { recursive: true });
    appendFileSync(RECEIPT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
    try {
      const lines = readFileSync(RECEIPT_LOG, 'utf8').trim().split('\n');
      if (lines.length > 300) writeFileSync(RECEIPT_LOG, lines.slice(-300).join('\n') + '\n');
    } catch { /* שקט */ }
  } catch { /* קבלה-היא-מיטבית */ }
}

function sanitize(msg: string, secret: string | null): string {
  let out = msg;
  if (secret && secret.length >= 8) out = out.split(secret).join('••••');
  return out.replace(/ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/g, '••••');
}

/* ---------- PAT (פרסור-זהה-ל-push-hq.sh) ---------- */
function readPat(): string | null {
  try {
    const firstLine = readFileSync(path.join(ROOT, 'secrets', 'pat.env'), 'utf8')
      .split(/\r?\n/).find((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
    if (!firstLine) return null;
    let pat = firstLine.includes('=') ? firstLine.slice(firstLine.indexOf('=') + 1) : firstLine;
    pat = pat.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
    return pat.length > 20 ? pat : null;
  } catch { return null; }
}

/* ---------- git-עם-אימות-בטוח ---------- */
async function git(args: string[], cwd: string, pat: string, timeoutMs = GIT_TIMEOUT_MS): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: ASKPASS, HQ_TOKEN: pat },
    });
    return { ok: true, out: `${stdout ?? ''}${stderr ?? ''}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: sanitize(`${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`, pat).slice(-600) };
  }
}

function writeAskpass(): void {
  mkdirSync(path.dirname(ASKPASS), { recursive: true });
  writeFileSync(ASKPASS, '#!/bin/sh\ncase "$1" in Username*) echo "x-access-token";; *) echo "$HQ_TOKEN";; esac\n');
  chmodSync(ASKPASS, 0o700);
}

/* ---------- העתקת-עץ ---------- */
function copyTree(src: string, dst: string, depth: number): { files: number } {
  let files = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const name = entry.name;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue;
      if (depth === 0 && name === 'sanbox') {
        // sanbox-נכנס-אך-הכספת-הגלויה-לא
        mkdirSync(d, { recursive: true });
        files += copySanbox(s, d);
        continue;
      }
      mkdirSync(d, { recursive: true });
      files += copyTree(s, d, depth + 1).files;
    } else if (entry.isFile()) {
      if (depth === 0 && EXCLUDED_ROOT_ENTRIES.has(name)) continue;
      if (name.endsWith('.log') || name.endsWith('.pid') || name.endsWith('.key')) continue;
      try {
        if (statSync(s).size > 8 * 1024 * 1024) continue; // קבצים-כבדים-חריגים — לא-במראה
        copyFileSync(s, d);
        files += 1;
      } catch { /* קובץ-נעלם-בין-הרף-לעין */ }
    }
  }
  return { files };
}

function copySanbox(src: string, dst: string): number {
  let files = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    if (EXCLUDED_UNDER_SANBOX.has(entry.name)) continue; // secrets — אסור
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(d, { recursive: true });
      files += copySanbox(s, d);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.log') || entry.name.endsWith('.pid')) continue;
      try {
        if (statSync(s).size > 8 * 1024 * 1024) continue;
        copyFileSync(s, d);
        files += 1;
      } catch { /* שקט */ }
    }
  }
  return files;
}

/* ---------- סריקת-סודות fail-closed על העץ-המועתק ---------- */
interface ScanHit { file: string; patternKind: string }
function scanTree(rootDir: string, blocking: { kind: string; re: RegExp }[], warnings: { kind: string; re: RegExp }[]): { scanned: number; hits: ScanHit[]; genericWarnings: number } {
  const hits: ScanHit[] = [];
  let genericWarnings = 0;
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile()) continue;
      if (abs.endsWith('.enc')) continue; // צופן-מתוכנן (vault-backup) — אינו-סוד-גלוי
      try {
        if (statSync(abs).size > MAX_FILE_BYTES) continue;
        const content = readFileSync(abs, 'utf8');
        scanned += 1;
        let hit = false;
        for (const rule of blocking) {
          const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
          if (re.test(content)) {
            hits.push({ file: path.relative(rootDir, abs), patternKind: rule.kind });
            hit = true;
            break; // מיסוך-בלבד — אין-תוכן-בקבלות
          }
        }
        if (!hit) {
          // generic-long = אזהרה-בלבד-במראה (לקח-חי T-49: hashים-ציבוריים/bun.lock
          // מפיקים-אלפי-שקרים-חיוביים; הכספת-מכוסה-בנפרד-בדפוסים-הדינמיים-המדויקים)
          const gw = warnings.find((w) => w.kind === 'generic-long');
          if (gw) {
            const wre = new RegExp(gw.re.source, gw.re.flags.includes('g') ? gw.re.flags : `${gw.re.flags}g`);
            if (wre.test(content)) genericWarnings += 1;
          }
        }
      } catch { /* בינארי/לא-קריא — דילוג */ }
    }
  };
  walk(rootDir);
  return { scanned, hits, genericWarnings };
}

async function loadScanRules(): Promise<{ blocking: { kind: string; re: RegExp }[]; warnings: { kind: string; re: RegExp }[] }> {
  // ייבוא-דינמי — דפוסי-הבסיס-זהים-לאלה-של-סריקת-הדחיפה-הרשמית (core/ops.ts)
  const { BASE_RULES, buildDynamicPatterns } = await import('../core/scan-patterns.ts');
  const vaultTexts: string[] = [];
  try {
    for (const f of readdirSync(path.join(ROOT, 'secrets'))) {
      try { vaultTexts.push(readFileSync(path.join(ROOT, 'secrets', f), 'utf8')); } catch { /* שקט */ }
    }
  } catch { /* אין-כספת — הדפוסים-הדינמיים-פשוט-ריקים */ }
  const blocking = [
    ...BASE_RULES.filter((r) => r.kind !== 'generic-long').map((r) => ({ kind: r.kind, re: r.re })),
    ...buildDynamicPatterns(vaultTexts).map((re) => ({ kind: 'dynamic-vault-token' as const, re })),
  ];
  const warnings = BASE_RULES.filter((r) => r.kind === 'generic-long').map((r) => ({ kind: r.kind, re: r.re }));
  return { blocking, warnings };
}

/* ---------- כלי-עזר ---------- */
function lastSuccessAt(): number {
  try { return Date.parse(JSON.parse(readFileSync(STATE, 'utf8')).pushedAt) || 0; } catch { return 0; }
}

function writeStateAndReceipt(r: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(STATE), { recursive: true });
    writeFileSync(STATE, `${JSON.stringify(r, null, 2)}\n`);
    writeFileSync(RECEIPT_LAST, `${JSON.stringify(r, null, 2)}\n`);
    log(r);
  } catch { /* שקט */ }
}

/* ---------- ראשי ---------- */
async function main(): Promise<void> {
  const t0 = Date.now();
  const pat = readPat();
  if (!pat) {
    writeStateAndReceipt({ ok: false, stage: 'pat', error: 'אין PAT בכספת — רענון-המראה חסום' });
    process.exit(1);
  }

  if (!FORCE) {
    const last = lastSuccessAt();
    if (last > 0 && Date.now() - last < MIN_INTERVAL_MS) {
      log({ ok: true, stage: 'throttled', nextDueAt: new Date(last + MIN_INTERVAL_MS).toISOString() });
      process.exit(0);
    }
  }

  writeAskpass();
  let pushed = false;
  let commit = '';
  try {
    // 1) מעבדה: שכפול או התאמה-למרחוק
    if (!existsSync(path.join(WORK, '.git'))) {
      rmSync(WORK, { recursive: true, force: true });
      mkdirSync(SOV_DIR, { recursive: true });
      const r = await git(['clone', '--depth', '1', MIRROR_URL, WORK], SOV_DIR, pat);
      if (!r.ok || !existsSync(path.join(WORK, '.git'))) {
        writeStateAndReceipt({ ok: false, stage: 'clone', error: r.out, durationMs: Date.now() - t0 });
        process.exit(1);
      }
    } else {
      await git(['fetch', 'origin', 'main'], WORK, pat);
      await git(['reset', '--hard', 'origin/main'], WORK, pat);
      await git(['clean', '-fdx'], WORK, pat);
    }
    await git(['config', 'user.name', 'sandbox-sovereign'], WORK, pat);
    await git(['config', 'user.email', 'sandbox-sovereign@users.noreply.github.com'], WORK, pat);

    // 2) ניקוי-המעבדה (הכל-חוץ-מ-.git) והעתקה-טרייה
    for (const entry of readdirSync(WORK)) {
      if (entry === '.git') continue;
      rmSync(path.join(WORK, entry), { recursive: true, force: true });
    }
    const { files } = copyTree(PROJECT, WORK, 0);

    // 3) סריקת-סודות fail-closed (חוסמים = דפוסים-מדויקים+דינמיים; generic-long = אזהרה)
    const { blocking, warnings } = await loadScanRules();
    const { scanned, hits, genericWarnings } = scanTree(WORK, blocking, warnings);
    if (hits.length > 0) {
      writeStateAndReceipt({
        ok: false, stage: 'scan', files, scanned,
        hits: hits.slice(0, 20).map((h) => ({ ...h, masked: '••••' })), // מיסוך-מלא
        durationMs: Date.now() - t0,
      });
      process.exit(3);
    }

    // 4) קומיט + דחיפה (rebase-safe; אפס-שינויים = יציאה-נקייה)
    await git(['add', '-A'], WORK, pat);
    const status = await git(['status', '--porcelain'], WORK, pat);
    if (status.out.trim().length === 0) {
      writeStateAndReceipt({ ok: true, stage: 'no-changes', files, scanned, genericWarnings, pushed: false, durationMs: Date.now() - t0 });
      process.exit(0);
    }
    const cm = await git(['commit', '-m', `mirror: ${new Date().toISOString()} · ${files} files · scan clean (${scanned})`], WORK, pat);
    if (!cm.ok) {
      writeStateAndReceipt({ ok: false, stage: 'commit', error: cm.out, durationMs: Date.now() - t0 });
      process.exit(1);
    }
    commit = (await git(['rev-parse', '--short', 'HEAD'], WORK, pat)).out.trim();
    const pull = await git(['pull', '--rebase', 'origin', 'main'], WORK, pat);
    if (!pull.ok) {
      writeStateAndReceipt({ ok: false, stage: 'pull', commit, error: pull.out, durationMs: Date.now() - t0 });
      process.exit(1);
    }
    const push = await git(['push', 'origin', 'main'], WORK, pat);
    if (!push.ok) {
      writeStateAndReceipt({ ok: false, stage: 'push', commit, error: push.out, durationMs: Date.now() - t0 });
      process.exit(1);
    }
    pushed = true;

    writeStateAndReceipt({
      ok: true, stage: 'push', repo: MIRROR_URL.replace('https://github.com/', ''), commit,
      pushed: true, pushedAt: new Date().toISOString(), files, scanned, genericWarnings, durationMs: Date.now() - t0,
    });
  } finally {
    try { rmSync(ASKPASS, { force: true }); } catch { /* מחיקה-מיטבית */ }
  }
  process.exit(pushed ? 0 : 1);
}

main().catch((e) => {
  writeStateAndReceipt({ ok: false, stage: 'fatal', error: sanitize(e instanceof Error ? e.message : String(e), null) });
  process.exit(1);
});
