/**
 * ops.ts — מודול-האופס של-שרת-HQ (Task 42-c + 44-a): סטטוס-git, סריקת-סודות, דחיפה-מאובטחת,
 * גיבוי-כספת-מוצפן (vault-backup/vault-restore), סנכרון-דו-כיווני (pull --rebase) ומצב-שומר.
 *
 * כללי-ברזל:
 *  - node:child_process execFile בלבד — בלי exec, בלי shell-מחרוזות, timeout 30s, cwd= sanbox.
 *  - הטוקן מעולם לא ב-argv, לא ב-URL, לא ב-.git/config — רק דרך GIT_ASKPASS זמני + HQ_TOKEN בסביבת-התהליך.
 *  - כל-פלט, קבלה ושגיאה עוברים-מיסוך (sanitize/mask) — אפס-סודות-מלאים-מחוץ-לכספת.
 *  - סריקה-נכשלת = דחיפה-חסומה (fail-closed); גם-pull-דו-כיווני-נכשל = דחיפה-חסומה (אין-force).
 *  - אפס-תלויות: node builtins + Bun file API.
 */
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

import { vaultBackup, vaultRestore, VAULT_BACKUP_RECEIPT, VAULT_ENC_PATH } from './backup.ts';
import { BASE_RULES, buildDynamicPatterns, type VaultText } from './scan-patterns.ts';

const execFileP = promisify(execFile);

export const SANDBOX_DIR = '/home/z/my-project/sanbox';
const SECRETS_DIR = path.join(SANDBOX_DIR, 'secrets');
const RECEIPTS_DIR = path.join(SANDBOX_DIR, 'receipts');
const DB_DIR = path.join(SANDBOX_DIR, 'db');
const SCAN_RECEIPT = path.join(RECEIPTS_DIR, 'scan-last.json');
const PUSH_LOG = path.join(RECEIPTS_DIR, 'push-log.jsonl');
const ASKPASS_PATH = path.join(DB_DIR, '.askpass.sh');
const EXEC_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 10_000_000; // סף-בטיחות-זיכרון לסריקה
const MAX_HITS = 500; // חיתוך-חירום לרשימת-ההיטים

// === טיפוסים ===

export interface ScanHit {
  file: string;
  patternKind: string;
  masked: string;
}

export interface ScanResult {
  clean: boolean;
  scannedFiles: number;
  hits: ScanHit[];
  ts: string;
  error?: string;
}

export interface PushResult {
  ok: boolean;
  stage: string;
  repo: string;
  commit?: string;
  pushed?: boolean;
  error?: string;
  ts: string;
}

export interface StatusExtra {
  branch: string;
  trackedFiles: number;
  lastCommit: string;
  scanLast: ScanResult | null;
  supervisor: { alive: boolean; pid: number | null };
  autoPushLast: string | null;
  /** מצב-גיבוי-הכספת: קיום-הצופן + הקבלה-האחרונה (מוסק-בלבד) */
  vaultBackup?: { exists: boolean; ts?: string; hashShort?: string; bytes?: number } | null;
  /** סנכרון-מול-origin: כמה-קומיטים-קדימה/מאחורה (null = אין-upstream) */
  repoSync?: { ahead: number; behind: number } | null;
  /** השומר-החיצוני (~/.sovereign/guardian.pid) — חי? */
  guardian?: { alive: boolean; pid: number | null };
}

// === Bun file API (עם-גיבוי-node) ===

interface BunFileLike {
  readonly size: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

const BUN = (globalThis as { Bun?: { file(p: string): BunFileLike } }).Bun;

async function readTextFile(p: string): Promise<string> {
  if (BUN) return await BUN.file(p).text();
  return readFileSync(p, 'utf8');
}

async function readJsonFile(p: string): Promise<unknown | null> {
  try {
    if (BUN) return await BUN.file(p).json();
    return JSON.parse(readFileSync(p, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

// === כספת (vault.ts של-42-a) — ייבוא-רך: אם-עוד-לא-קיים, לא-מפיל-את-המודול ===

type VaultModule = {
  vaultTexts?: () => Promise<VaultText[]>;
  maskSecret?: (s: string) => string;
};

const VAULT_SPEC = './vault.ts';
let vaultModCache: VaultModule | undefined;

async function loadVaultModule(): Promise<VaultModule | null> {
  if (vaultModCache) return vaultModCache;
  try {
    // מפרט-לא-ליטרלי בכוונה — TypeScript לא מקמפל-את-הקשר, והריצה סובלת-היעדר-קובץ.
    vaultModCache = (await import(VAULT_SPEC)) as VaultModule;
    return vaultModCache;
  } catch {
    return null; // הכספת-עוד-לא-נכתבה — ננסה-שוב-בסריקה-הבאה
  }
}

/** מיסוך-מקומי כנפילה אם maskSecret של-הכספת אינו-זמין. */
function localMask(s: string): string {
  const t = String(s ?? '').trim();
  if (t.length < 8) return '••••';
  return `${t.slice(0, 4)}••••${t.slice(-2)}`;
}

function maskValue(s: string): string {
  try {
    if (vaultModCache && typeof vaultModCache.maskSecret === 'function') {
      const m = vaultModCache.maskSecret(s);
      if (typeof m === 'string' && m.length > 0) return m;
    }
  } catch {
    /* נופל-למיסוך-המקומי */
  }
  return localMask(s);
}

/**
 * טקסטי-הכספת לבניית-דפוסים-דינמיים. קודם vaultTexts() מ-vault.ts;
 * בהיעדרו — קריאה-ישירה של קבצי secrets/ (לא-יוצא-מכאן-תוכן-לשום-פלט).
 */
async function loadVaultTexts(): Promise<VaultText[]> {
  const mod = await loadVaultModule();
  if (mod && typeof mod.vaultTexts === 'function') {
    try {
      const texts = await mod.vaultTexts();
      if (Array.isArray(texts)) return texts;
    } catch {
      /* נופל-לקריאה-הישירה */
    }
  }
  try {
    const names = readdirSync(SECRETS_DIR)
      .filter((n) => !n.startsWith('.'))
      .sort();
    const out: VaultText[] = [];
    for (const name of names) {
      try {
        out.push({ name, text: await readTextFile(path.join(SECRETS_DIR, name)) });
      } catch {
        /* דילוג-בטוח */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// === תשתית-git (execFile בלבד) ===

async function git(args: readonly string[], extraEnv?: Record<string, string>): Promise<string> {
  const res = await execFileP('git', [...args], {
    cwd: SANDBOX_DIR,
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return res.stdout;
}

/** הודעת-שגיאה קצרה-ונטולת-סודות (מוסקת-שוב-ב-sanitizeOutput לפני-כל-רישום). */
function safeErrMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const ee = e as { message?: unknown; stderr?: unknown; stdout?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof ee.message === 'string') parts.push(ee.message);
    if (typeof ee.stderr === 'string' && ee.stderr.trim().length > 0) parts.push(ee.stderr.trim());
    else if (typeof ee.stdout === 'string' && ee.stdout.trim().length > 0) parts.push(ee.stdout.trim());
    if (typeof ee.code === 'string' || typeof ee.code === 'number') parts.push(`code=${String(ee.code)}`);
    return parts.join(' | ').slice(0, 400);
  }
  return String(e).slice(0, 400);
}

/** החלפת-מופעי-הטוקן (וכל-טוקן-דמוי-סוד) ב'••••' לפני-רישום/החזרה. */
export function sanitizeOutput(s: string, pat?: string | null): string {
  let out = String(s ?? '');
  if (pat && pat.length >= 8) out = out.split(pat).join('••••');
  out = out.replace(/ghp_[A-Za-z0-9]{10,}/g, 'ghp_••••');
  out = out.replace(/github_pat_[A-Za-z0-9_]{10,}/g, 'github_pat_••••');
  out = out.replace(/sk-or-v1-[a-f0-9]{10,}/g, 'sk-or-v1-••••');
  return out;
}

// === collectStatus ===

/** סטטוס-git של-sanbox — כל-פיסה-מבודדת-ב-try/catch משלה. */
export async function collectStatus(): Promise<Partial<StatusExtra>> {
  const out: Partial<StatusExtra> = {};
  try {
    out.branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    // ענף-עוד-לא-נולד (אין-קומיטים) — נופל-ל-symbolic-ref
    try {
      out.branch = (await git(['symbolic-ref', '--short', 'HEAD'])).trim();
    } catch {
      /* אין-repo */
    }
  }
  try {
    out.trackedFiles = (await git(['ls-files', '-z']))
      .split('\0')
      .filter((l) => l.trim().length > 0).length;
  } catch {
    /* אין-קבצים-נעקבים */
  }
  try {
    out.lastCommit = (await git(['log', '-1', '--format=%h-%s'])).trim();
  } catch {
    /* עדיין-אין-קומיטים */
  }
  try {
    const j = await readJsonFile(SCAN_RECEIPT);
    if (j && typeof j === 'object' && 'clean' in (j as Record<string, unknown>)) {
      out.scanLast = j as ScanResult;
    }
  } catch {
    /* אין-קבלת-סריקה */
  }
  out.supervisor = supervisorStatus();
  out.autoPushLast = lastAutoPush();
  out.guardian = guardianStatus();

  // מצב-גיבוי-הכספת: קיום-קובץ-הצופן (stat) + קבלת-הגיבוי (hash/גדלים בלבד)
  try {
    let exists = false;
    let bytes: number | undefined;
    try {
      const st = statSync(VAULT_ENC_PATH);
      exists = st.isFile();
      bytes = st.size;
    } catch {
      exists = false; // אין-צופן-עדיין
    }
    let ts: string | undefined;
    let hashShort: string | undefined;
    const receipt = (await readJsonFile(VAULT_BACKUP_RECEIPT)) as { ts?: unknown; hash?: unknown } | null;
    if (receipt && typeof receipt === 'object') {
      if (typeof receipt.ts === 'string') ts = receipt.ts;
      if (typeof receipt.hash === 'string' && receipt.hash.length >= 12) hashShort = receipt.hash.slice(0, 12);
    }
    out.vaultBackup = { exists, ts, hashShort, bytes };
  } catch {
    out.vaultBackup = null; // אין-מידע
  }

  // סנכרון-דו-כיווני מול-origin: ahead/behind (null = אין-upstream-עדיין)
  try {
    const ahead = Number((await git(['rev-list', '--count', '@{u}..HEAD'])).trim());
    const behind = Number((await git(['rev-list', '--count', 'HEAD..@{u}'])).trim());
    if (Number.isFinite(ahead) && Number.isFinite(behind)) out.repoSync = { ahead, behind };
    else out.repoSync = null;
  } catch {
    out.repoSync = null;
  }

  return out;
}

// === ריבונות: מפקח + זיכרון + דחיפה-עצמית ===

const SUPERVISOR_PIDFILE = path.join(SANDBOX_DIR, 'db', 'supervisor.pid');
const AUTOPUSH_RECEIPT = path.join(RECEIPTS_DIR, 'auto-push.jsonl');
const PROJECT_ROOT = '/home/z/my-project';

/** מצב-השומר-החיצוני (~/.sovereign/guardian.pid — pidfile חי?) */
function guardianStatus(): { alive: boolean; pid: number | null } {
  try {
    const raw = readFileSync(path.join(os.homedir(), '.sovereign', 'guardian.pid'), 'utf8').trim();
    const pid = Number(raw);
    if (!pid) return { alive: false, pid: null };
    process.kill(pid, 0); // קיים?
    return { alive: true, pid };
  } catch {
    return { alive: false, pid: null };
  }
}

/** מצב-המפקח-הריבוני (pidfile חי?) */
export function supervisorStatus(): { alive: boolean; pid: number | null } {
  try {
    const raw = readFileSync(SUPERVISOR_PIDFILE, 'utf8').trim();
    const pid = Number(raw);
    if (!pid) return { alive: false, pid: null };
    process.kill(pid, 0); // קיים?
    return { alive: true, pid };
  } catch {
    return { alive: false, pid: null };
  }
}

/** דחיפה-עצמית-אחרונה (מהקבלות) */
export function lastAutoPush(): string | null {
  try {
    const lines = readFileSync(AUTOPUSH_RECEIPT, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return null;
    const j = JSON.parse(last) as Record<string, unknown>;
    return typeof j.ts === 'string' ? j.ts : null;
  } catch {
    return null;
  }
}

/** סנכרון-הזיכרון: MEMORY.md + worklog.md מהפרויקט-הראשי → sanbox/memory/ (נדחף-לגיט) */
export function syncMemory(): { synced: string[]; missing: string[] } {
  const synced: string[] = [];
  const missing: string[] = [];
  try {
    mkdirSync(path.join(SANDBOX_DIR, 'memory'), { recursive: true });
  } catch {
    /* קיים */
  }
  for (const name of ['MEMORY.md', 'worklog.md']) {
    try {
      const src = path.join(PROJECT_ROOT, name);
      const content = readFileSync(src, 'utf8');
      writeFileSync(path.join(SANDBOX_DIR, 'memory', name), content, 'utf8');
      synced.push(name);
    } catch {
      missing.push(name);
    }
  }
  return { synced, missing };
}

/**
 * דחיפה-עצמית (תקופתית או ידנית): סנכרון-זיכרון → בדיקת-שינויים → דחיפה-מלאה-סרוקה.
 * אין-שינויים → לא-דוחף (מונע-רעש). כל-תוצאה-בקבלה receipts/auto-push.jsonl (מוגבל-ל-500).
 */
export async function autoPush(force = false): Promise<Record<string, unknown>> {
  const ts = new Date().toISOString();
  const mem = syncMemory();

  // גיבוי-כספת — לפני-בדיקת-השינויים: הצופן-מתעדכן-רק-כשהתוכן-השתנה (hash — אין-רעש). לא-חוסם.
  let backup: { ok: boolean; written: boolean; hashShort?: string } | null = null;
  try {
    const b = await vaultBackup();
    backup = { ok: b.ok, written: b.written, hashShort: b.hashShort };
  } catch {
    backup = null; // גיבוי-נכשל — לא-חוסם-דחיפה
  }

  let dirty = true;
  try {
    dirty = (await git(['status', '--porcelain'])).trim().length > 0;
  } catch {
    /* אם-גיט-נכשל — מנסים-לדחוף */
  }
  if (!dirty && !force) {
    const r = { ok: true, ts, pushed: false, reason: 'אין-שינויים', mem, backup };
    appendAutoReceipt(r);
    return r;
  }
  const res = (await pushToGitHub()) as unknown as Record<string, unknown>;
  const r = { ...res, ts, auto: true, mem, backup };
  appendAutoReceipt(r);
  return r;
}

function appendAutoReceipt(r: Record<string, unknown>): void {
  try {
    mkdirSync(RECEIPTS_DIR, { recursive: true });
    appendFileSync(AUTOPUSH_RECEIPT, JSON.stringify(r) + '\n');
    const lines = readFileSync(AUTOPUSH_RECEIPT, 'utf8').trim().split('\n');
    if (lines.length > 500) {
      writeFileSync(AUTOPUSH_RECEIPT, lines.slice(-500).join('\n') + '\n');
    }
  } catch {
    /* קבלה-היא-מיטבית */
  }
}

// === runSecretScan ===

function writeScanReceipt(r: ScanResult): void {
  try {
    mkdirSync(RECEIPTS_DIR, { recursive: true });
    writeFileSync(SCAN_RECEIPT, `${JSON.stringify(r, null, 2)}\n`, 'utf8');
  } catch {
    /* קבלה-היא-מיטבית */
  }
}

/**
 * סריקת-סודות על כל-קבצי-הגיט-הנעקבים (git ls-files) מול BASE_PATTERNS
 * ומול דפוסים-דינמיים שנבנים-מטקסטי-הכספת. ההיטים כוללים-מיסוך-בלבד.
 * כותבת-קבלה ל-receipts/scan-last.json. כשל-סריקה = clean:false (fail-closed).
 */
export async function runSecretScan(): Promise<ScanResult> {
  const ts = new Date().toISOString();
  const hits: ScanHit[] = [];
  const seenHits = new Set<string>();
  let scannedFiles = 0;
  try {
    const fileList = (await git(['ls-files', '-z']))
      .split('\0')
      .map((s) => s.trim())
      .filter(Boolean);

    const vaultTexts = await loadVaultTexts();
    const dynamic = buildDynamicPatterns(vaultTexts);
    const rules: { kind: string; re: RegExp }[] = [
      ...BASE_RULES,
      ...dynamic.map((re) => ({ kind: 'dynamic-vault-token' as const, re })),
    ];

    scan: for (const rel of fileList) {
      if (rel === 'vault/vault-backup.enc') continue; // צופן-גיבוי-מתוכנן-באדיבות-הריפו — אינו-סוד-גלוי (מאומת-בנפרד)
      const abs = path.join(SANDBOX_DIR, rel);
      let content: string;
      try {
        if (BUN) {
          const f = BUN.file(abs);
          if (f.size > MAX_FILE_BYTES) continue; // קובץ-ענק — דילוג (אין-כאלה-בריפו-הזה)
          content = await f.text();
        } else {
          content = readFileSync(abs, 'utf8');
        }
      } catch {
        continue; // נמחק-מהדיסק/לא-קריא — לא-נסרק
      }
      scannedFiles += 1;
      for (const rule of rules) {
        let gre: RegExp;
        try {
          gre = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
        } catch {
          continue;
        }
        gre.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = gre.exec(content)) !== null) {
          if (m.index === gre.lastIndex) gre.lastIndex += 1; // הגנה-ממצב-אפס-אורך
          const raw = m[0];
          if (!raw) continue;
          const masked = maskValue(raw);
          const key = `${rel}|${rule.kind}|${masked}`;
          if (!seenHits.has(key)) {
            seenHits.add(key);
            hits.push({ file: rel, patternKind: rule.kind, masked });
            if (hits.length >= MAX_HITS) break scan;
          }
        }
      }
    }
  } catch (e) {
    const failed: ScanResult = {
      clean: false,
      scannedFiles,
      hits,
      ts,
      error: `סריקה-נכשלה: ${sanitizeOutput(safeErrMsg(e))}`,
    };
    writeScanReceipt(failed);
    return failed;
  }
  const result: ScanResult = { clean: hits.length === 0, scannedFiles, hits, ts };
  writeScanReceipt(result);
  return result;
}

// === PAT ===

/** קריאת-PAT מ-secrets/pat.env — תומך-בשתי-הצורות: `PAT=...` וטוקן-גולמי. */
async function readPat(): Promise<string | null> {
  let raw = '';
  try {
    raw = await readTextFile(path.join(SECRETS_DIR, 'pat.env'));
  } catch {
    return null;
  }
  const stripQuotes = (s: string): string => s.replace(/^["']+|["']+$/g, '');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const kvs: { k: string; v: string }[] = [];
  const raws: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq > 0) kvs.push({ k: line.slice(0, eq).trim(), v: stripQuotes(line.slice(eq + 1).trim()) });
    else raws.push(stripQuotes(line));
  }
  const exact = kvs.find((x) => x.k.toUpperCase() === 'PAT' && x.v.length > 0);
  if (exact) return exact.v;
  const anyKv = kvs.find((x) => x.v.length > 0);
  if (anyKv) return anyKv.v;
  return raws.find((s) => s.length > 0) ?? null;
}

// === דחיפה ===

const ASKPASS_BODY =
  '#!/bin/sh\ncase "$1" in Username*) echo "x-access-token";; *) echo "$HQ_TOKEN";; esac';

function hasEmbeddedToken(url: string, pat: string): boolean {
  if (pat.length >= 8 && url.includes(pat)) return true;
  if (/x-access-token/i.test(url)) return true;
  if (/\/\/[^/@]+:[^/@]+@/.test(url)) return true;
  if (/ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/.test(url)) return true;
  return false;
}

function appendPushReceipt(r: PushResult, clean: boolean): void {
  try {
    mkdirSync(RECEIPTS_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: r.ts, ok: r.ok, stage: r.stage, commit: r.commit, repo: r.repo, clean });
    appendFileSync(PUSH_LOG, `${entry}\n`, 'utf8');
  } catch {
    /* קבלה-היא-מיטבית */
  }
}

/**
 * דחיפה-מאובטחת ל-GitHub — הסדר-החובה:
 *  1. סריקת-סודות (לא-נקי → חסימה + קבלה)
 *  2. auto-commit (add -A; commit אם-יש-staged; אין-סודות-בהודעות)
 *  3. PAT מהכספת (pat.env — שתי-הצורות)
 *  4. זיהוי-משתמש מול api.github.com/user
 *  5. יצירת-ריפו פרטי אם-חסר (422 = קיים — מתעלמים)
 *  6. remote-נקי ללא-טוקן-מוטמע
 *  7. דחיפה עם GIT_ASKPASS זמני + HQ_TOKEN בסביבה בלבד; ה-helper נמחק-תמיד (finally)
 *  8. קבלה ל-receipts/push-log.jsonl (רק-מוסקים)
 */
export async function pushToGitHub(): Promise<PushResult> {
  const ts = new Date().toISOString();
  const base = (over: Partial<PushResult>): PushResult => ({ ok: false, stage: 'init', repo: 'sanbox', ts, ...over });

  // 0) סנכרון-זיכרון קודם-כל — הזיכרון-תמיד-נוסע-עם-הריפו
  try {
    syncMemory();
  } catch {
    /* לא-חוסם */
  }

  // 1) סריקת-סודות — שער-חובה
  let scan: ScanResult;
  try {
    scan = await runSecretScan();
  } catch (e) {
    scan = { clean: false, scannedFiles: 0, hits: [], ts: new Date().toISOString(), error: safeErrMsg(e) };
  }
  if (!scan.clean) {
    const r = base({ stage: 'scan', error: 'סריקת סודות נכשלה — דחיפה נחסמה' });
    appendPushReceipt(r, false);
    return r;
  }

  // 2) auto-commit
  let commit: string | undefined;
  try {
    await git(['add', '-A']);
    const porcelain = await git(['status', '--porcelain']);
    if (porcelain.trim().length > 0) {
      const msg = `HQ sync ${new Date().toISOString()}`;
      try {
        await git(['commit', '-m', msg]);
      } catch (e) {
        if (/user\.name|user\.email|ident/i.test(safeErrMsg(e))) {
          // אין-זהות-git-מוגדרת — קומיט-עם-זהות-מקומית-מינימלית
          await git(['-c', 'user.name=hq', '-c', 'user.email=hq@localhost', 'commit', '-m', msg]);
        } else {
          throw e;
        }
      }
    }
    commit = (await git(['rev-parse', '--short', 'HEAD'])).trim();
  } catch (e) {
    const r = base({ stage: 'commit', commit, error: `auto-commit נכשל: ${sanitizeOutput(safeErrMsg(e))}` });
    appendPushReceipt(r, true);
    return r;
  }

  // 2.5) pull-rebase דו-כיווני — משיכת-שינויים-מהריפו-לפני-דחיפה (סנכרון-בין-מכונות; אסור-force)
  //      הריפו-פרטי — המשיכה-מאומתת-כמו-הדחיפה: PAT-מוקדם + askpass-זמני-שנמחק-תמיד.
  let hasUpstream = true;
  try {
    await git(['rev-parse', '--abbrev-ref', '@{u}']);
  } catch {
    hasUpstream = false; // עדיין-לא-נדחף-אף-פעם — אין-מה-למשוך
  }
  if (hasUpstream) {
    const patEarly = await readPat();
    if (!patEarly) {
      const r = base({ stage: 'pull', commit, error: 'אין PAT בכספת — משיכה-דו-כיוונית חסומה' });
      appendPushReceipt(r, true);
      return r;
    }
    let askpassReady = false;
    try {
      mkdirSync(DB_DIR, { recursive: true });
      writeFileSync(ASKPASS_PATH, `${ASKPASS_BODY}\n`, { mode: 0o700 });
      chmodSync(ASKPASS_PATH, 0o700);
      askpassReady = true;
    } catch {
      /* כתיבת-askpass-נכשלה — המשיכה-ייכשל-ותיחסם-בכישלון-למטה */
    }
    if (askpassReady) {
      try {
        try {
          await git(['pull', '--rebase', '--autostash', 'origin', 'main'], {
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: ASKPASS_PATH,
            HQ_TOKEN: patEarly,
          });
        } catch {
          // T-51: תאום-ריבוני-שני-חי-במקביל (סנכרון-בין-מכונות) — התנגשות-rebase
          // אינה-כשל-סופי: ניקוי → ניסיון-חוזר-אחד עם -X theirs (הרחוק-מנצח-בגדילי-קונפליקט;
          // יומני-*.jsonl מתמזגים-union-מלא-דרך-.gitattributes — אפס-אובדן-קבלות).
          try {
            await git(['rebase', '--abort']);
          } catch {
            /* אין-ריבייז-לבטל */
          }
          await git(['pull', '--rebase', '--autostash', '-X', 'theirs', 'origin', 'main'], {
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: ASKPASS_PATH,
            HQ_TOKEN: patEarly,
          });
        }
      } catch (e) {
        try {
          await git(['rebase', '--abort']); // ניקוי-מצב-ריבייז-תקוע (best-effort)
        } catch {
          /* אין-ריבייז-לבטל */
        }
        const r = base({ stage: 'pull', commit, error: `משיכה-דו-כיוונית נכשלה גם-בניסיון-החוזר — דחיפה נחסמה: ${sanitizeOutput(safeErrMsg(e), patEarly)}` });
        appendPushReceipt(r, true);
        return r; // fail-closed — אין-דריסה-של-הריפו-המרוחק
      } finally {
        try {
          rmSync(ASKPASS_PATH, { force: true }); // ה-helper-נמחק-תמיד — גם-אחרי-הצלחה
        } catch {
          /* מחיקה-מיטבית */
        }
      }
    }
  }

  // 3) PAT
  const pat = await readPat();
  if (!pat) {
    const r = base({ stage: 'pat', commit, error: 'אין PAT בכספת' });
    appendPushReceipt(r, true);
    return r;
  }

  const ghHeaders: Record<string, string> = {
    Authorization: `Bearer ${pat}`,
    'User-Agent': 'hq',
    Accept: 'application/vnd.github+json',
  };

  // 4) זיהוי-משתמש — עם-הפרדה-כנה-בין-טוקן-פסול (401) לבין-מגבלת-קצב (403/429):
  //    סערת-מכסה-משותפת (לקח-T-48) לא-יכולה-להיחשב-“PAT-נדחה” — זה-שקר-קבלות
  //    שחוסם-את-הלב-השני. ניסיונות-חוזרים → ואז-נפילה-חכמה: שם-הבעלים-מה-remote-הקיים.
  let login = '';
  const authAttempt = async (): Promise<{ ok: boolean; status: number; rateLimited: boolean; login: string }> => {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: ghHeaders,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const j = (await res.json()) as { login?: unknown };
        const l = typeof j.login === 'string' ? j.login : '';
        return { ok: l.length > 0, status: res.status, rateLimited: false, login: l };
      }
      const rateLimited = res.status === 403 || res.status === 429;
      return { ok: false, status: res.status, rateLimited, login: '' };
    } catch {
      return { ok: false, status: 0, rateLimited: false, login: '' };
    }
  };
  let attempt = await authAttempt();
  for (let i = 0; i < 3 && !attempt.ok && attempt.rateLimited; i++) {
    await new Promise((r) => setTimeout(r, 4000 * (i + 1))); // 4ש·8ש·12ש
    attempt = await authAttempt();
  }
  if (attempt.ok) {
    login = attempt.login;
  } else if (attempt.rateLimited || attempt.status === 0) {
    // מגבלת-קצב/אי-נגישות ≠ טוקן-פסול: שם-הבעלים-מה-remote-הקיים (הדחיפה-עצמה
    // תיכשל-בכנות-אצל-הגיט-אם-הטוקן-באמת-פסול — הגיט-הוא-השופט-האמתי).
    try {
      const cur = (await git(['remote', 'get-url', 'origin'])).trim();
      const m = cur.match(/github\.com[/:]([^/]+)\//);
      if (m?.[1]) login = m[1];
    } catch {
      /* אין-remote — ייכשל-למטה-בשקיפות */
    }
    if (!login) {
      const r = base({ stage: 'auth', commit, error: `GitHub-מוגבל-כרגע (HTTP ${attempt.status || 'network'}) ואין-remote-לגזור-ממנו-שם-בעלים — דחיפה-תידחה` });
      appendPushReceipt(r, true);
      return r;
    }
  } else {
    const r = base({ stage: 'auth', commit, error: 'PAT נדחה על ידי GitHub' });
    appendPushReceipt(r, true);
    return r;
  }
  const repoFull = `${login}/sanbox`;

  // 5) יצירת-ריפו-אם-חסר (422 = כבר-קיים — מתעלמים; 403/429 = מגבלת-קצב — הריפו-קיים
  //    ממילא-בדחיפות-הקבועות, דילוג-כנה-במקום-חסימת-שקר — לקח-T-48)
  try {
    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sanbox', private: true, auto_init: false }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok && res.status !== 422 && res.status !== 403 && res.status !== 429) {
      const r = base({ stage: 'repo-create', repo: repoFull, commit, error: `יצירת-ריפו נכשלה (HTTP ${res.status})` });
      appendPushReceipt(r, true);
      return r;
    }
  } catch (e) {
    const r = base({ stage: 'repo-create', repo: repoFull, commit, error: `GitHub לא נגיש: ${sanitizeOutput(safeErrMsg(e), pat)}` });
    appendPushReceipt(r, true);
    return r;
  }

  // 6) remote-נקי — אף-טוקן-ב-URL
  const cleanUrl = `https://github.com/${login}/sanbox.git`;
  try {
    let cur = '';
    try {
      cur = (await git(['remote', 'get-url', 'origin'])).trim();
    } catch {
      cur = '';
    }
    if (cur.length === 0) {
      await git(['remote', 'add', 'origin', cleanUrl]);
    } else if (cur !== cleanUrl && hasEmbeddedToken(cur, pat)) {
      await git(['remote', 'set-url', 'origin', cleanUrl]);
    }
  } catch (e) {
    const r = base({ stage: 'remote', repo: repoFull, commit, error: `קביעת-remote נכשלה: ${sanitizeOutput(safeErrMsg(e), pat)}` });
    appendPushReceipt(r, true);
    return r;
  }

  // 7) דחיפה-מאומתת — טוקן-בסביבה-בלבד, helper-זמני-נמחק-תמיד
  try {
    mkdirSync(DB_DIR, { recursive: true });
    writeFileSync(ASKPASS_PATH, `${ASKPASS_BODY}\n`, { mode: 0o700 });
    chmodSync(ASKPASS_PATH, 0o700);
  } catch (e) {
    const r = base({ stage: 'askpass', repo: repoFull, commit, error: `כתיבת-askpass נכשלה: ${sanitizeOutput(safeErrMsg(e), pat)}` });
    appendPushReceipt(r, true);
    return r;
  }

  let pushErr = '';
  try {
    await execFileP(
      'git',
      ['push', '-u', 'origin', 'main'],
      {
        cwd: SANDBOX_DIR,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: ASKPASS_PATH,
          HQ_TOKEN: pat,
        },
      },
    );
  } catch (e) {
    pushErr = sanitizeOutput(safeErrMsg(e), pat);
  } finally {
    try {
      rmSync(ASKPASS_PATH, { force: true });
    } catch {
      /* מחיקה-מיטבית */
    }
  }
  if (pushErr.length > 0) {
    const r = base({ stage: 'push', repo: repoFull, commit, error: `דחיפה נכשלה: ${pushErr}` });
    appendPushReceipt(r, true);
    return r;
  }

  // 8) קבלה + הצלחה
  const okResult: PushResult = { ok: true, stage: 'push', repo: repoFull, commit, pushed: true, ts };
  appendPushReceipt(okResult, true);
  return okResult;
}

// === מתג-פעולות ===

/**
 * מתג-הפעולות לשרת/לממשק:
 *  secret-scan | push-github | git-status | auto-push
 *  vault-backup — גיבוי-כספת-מוצפן אל vault/vault-backup.enc (אין-פרמטרים)
 *  vault-restore — שחזור-הכספת מהצופן; דורש payload.password (מחרוזת-לא-ריקה)
 */
export async function runAction(action: string, payload?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'secret-scan':
      return runSecretScan();
    case 'push-github':
      return pushToGitHub();
    case 'auto-push':
      return autoPush(true);
    case 'git-status':
      return { ok: true, ...(await collectStatus()) };
    case 'vault-backup':
      return vaultBackup();
    case 'vault-restore': {
      const pw = payload?.password;
      if (typeof pw !== 'string' || pw.length === 0) {
        return { ok: false, written: false, ts: new Date().toISOString(), error: 'נדרשת סיסמה' };
      }
      return vaultRestore(pw);
    }
    default:
      return { ok: false, error: 'פעולה לא ידועה' };
  }
}
