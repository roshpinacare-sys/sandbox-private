#!/usr/bin/env bun
/**
 * state-replica.mjs — השכפול-הריבוני-החוץ-מכונה (T-56).
 *
 * הרעיון: הזיכרון-המקומי-שריר-מול-מוות-כונן (אתחול-מכולה-הוכיח-זאת-ב-T-54).
 * פוסטגרס-ריבוני-ב-Supabase (ap-south-1) הוא-הזיכרון-שלא-ימות-עם-המכונה:
 *   push  — כל-פעימה: תמצית-החיים (HEAD · שרשרת-הלב · טביעת-זיכרון) נחתמת-לענן-השני.
 *   pull  — בשיקום: התמצית-האחרונה-נשלפת-מהענן — מפת-הדרך-למי-שהתעורר-בלי-זיכרון.
 *
 * ביטחון:
 *   - supabase_pat + supabase_ref נקראים-רק-מ-secrets/supabase.keys (מנוטרל-מגיט).
 *   - אף-טוקן-לא-מודפס; קבלות-ממוסכות-בלבד (receipts/state-replica-last.json + .jsonl).
 *   - fail-open תמיד: כשל-הענן-השני-לעולם-לא-מפיל-את-הלב/המפקח/הדחיפה.
 *
 * שימוש:
 *   bun scripts/state-replica.mjs          ← push (ברירת-מחדל)
 *   bun scripts/state-replica.mjs pull     ← pull (התמצית-האחרונה, ממוסכת)
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = '/home/z/my-project/sanbox';
const SECRETS = path.join(ROOT, 'secrets', 'supabase.keys');
const RECEIPTS = path.join(ROOT, 'receipts');
const HEART = path.join(ROOT, 'state', 'heart', 'last.json');
const WORKLOG = path.join(ROOT, 'memory', 'worklog.md');
const MEMORY = path.join(ROOT, 'memory', 'MEMORY.md');
const LAST = path.join(RECEIPTS, 'state-replica-last.json');
const LOG = path.join(RECEIPTS, 'state-replica.jsonl');

const nowIso = () => new Date().toISOString();
const mask = (s) => (typeof s === 'string' && s.length >= 8 ? s.slice(0, 4) + '••••' + s.slice(-4) : '••••');

function readSecret(key) {
  try {
    const text = readFileSync(SECRETS, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0 && t.slice(0, eq).trim() === key) return t.slice(eq + 1).trim();
    }
  } catch { /* שקט — fail-open */ }
  return '';
}

function receipt(push, ok, extra = {}) {
  mkdirSync(RECEIPTS, { recursive: true });
  const rec = { ts: nowIso(), mode: push ? 'push' : 'pull', ok, ...extra };
  writeFileSync(LAST, JSON.stringify(rec, null, 2));
  appendFileSync(LOG, JSON.stringify(rec) + '\n');
  return rec;
}

async function pgQuery(pat, ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`pg-http-${res.status}: ${body.slice(0, 140)}`);
  return JSON.parse(body);
}

function shaShort(p) {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
  } catch { return 'none'; }
}

/* --- איסוף-תמצית-החיים (רק-שדות-לא-סודיים) --- */
function gather() {
  let head = 'none', chain = 'none', prev = 'none', heartAt = 'none';
  try {
    head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
  } catch { /* שקט */ }
  try {
    const h = JSON.parse(readFileSync(HEART, 'utf8'));
    chain = h.chain ?? 'none'; prev = h.prevChain ?? 'none'; heartAt = h.at ?? 'none';
  } catch { /* שקט */ }
  return { head, chain, prev, heartAt, worklogSha: shaShort(WORKLOG), memorySha: shaShort(MEMORY) };
}

/* --- push: חתימת-תמצית-לענן-השני --- */
async function doPush() {
  const pat = readSecret('supabase_pat');
  const ref = readSecret('supabase_ref');
  if (!pat || !ref) return receipt(true, false, { error: 'missing pat/ref in secrets' });
  const g = gather();
  const summary = {
    heart_at: g.heartAt,
    worklog_sha: g.worklogSha,
    memory_sha: g.memorySha,
    machine: 'sandbox-agent-9',
    task: 'T-56-state-replica',
  };
  const q = `insert into sovereign_state (kind, head, chain, memory_sha, summary, note)
             values ('heartbeat', '${g.head.replace(/'/g, '')}', '${g.chain.replace(/'/g, '')}', '${g.memorySha}', '${JSON.stringify(summary).replace(/'/g, "''")}'::jsonb, 'heart-piggyback')`;
  try {
    await pgQuery(pat, ref, q);
    const rec = receipt(true, true, { head: mask(g.head), chain: mask(g.chain), memorySha: g.memorySha });
    console.log(`[state-replica] push-ok → ענן-השני (${g.memorySha})`);
    return rec;
  } catch (err) {
    const rec = receipt(true, false, { error: String(err instanceof Error ? err.message : err).slice(0, 160) });
    console.error('[state-replica] push-נכשל (fail-open):', rec.error);
    return rec;
  }
}

/* --- pull: מפת-הדרך-מהענן-השני (למי-שהתעורר-בלי-זיכרון) --- */
async function doPull() {
  const pat = readSecret('supabase_pat');
  const ref = readSecret('supabase_ref');
  if (!pat || !ref) return receipt(false, false, { error: 'missing pat/ref in secrets' });
  try {
    const rows = await pgQuery(pat, ref,
      `select created_at, kind, head, chain, memory_sha, summary from sovereign_state order by created_at desc limit 5`);
    const rec = receipt(false, true, { rows: rows.length, latest: rows[0] ?? null });
    console.log(`[state-replica] pull-ok — ${rows.length} תמציות-בענן-השני`);
    if (rows[0]) {
      console.log(`  אחרונה: ${rows[0].created_at} · head=${String(rows[0].head).slice(0, 7)} · memory=${rows[0].memory_sha}`);
    }
    return rec;
  } catch (err) {
    const rec = receipt(false, false, { error: String(err instanceof Error ? err.message : err).slice(0, 160) });
    console.error('[state-replica] pull-נכשל:', rec.error);
    return rec;
  }
}

const mode = (process.argv[2] ?? 'push').toLowerCase();
const out = mode === 'pull' ? await doPull() : await doPush();
process.exit(0); // fail-open תמיד — אף-מתקשר-לא-נשבר-בגללנו
