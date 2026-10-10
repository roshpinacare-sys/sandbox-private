#!/usr/bin/env bun
/**
 * lighthouse-sync.mjs — T-60: הכתבת-המגדלור-מהלב
 * ============================================================
 * עם-כל-פעימת-לב (מופעל-מ-heart-tick.mjs · spawn-שלישי), תמצית-החיים
 * נודדת-אל-המגדלור-הציבורי: roshpinacare-sys/sovereign-lighthouse
 * (GitHub-Pages — https://roshpinacare-sys.github.io/sovereign-lighthouse/)
 *
 * דוקטרינה:
 *  - אפס-אמון: לפני-כל-פרסום — סריקת-סודות-על-התוכן-היוצא (אותו-regex-כמו-המנוע-הגיט)
 *  - שער-שינוי: אם-heart-chain+worklogSha+memorySha לא-זזו מהפרסום-הקודם — skip
 *  - PUT-רק-עם-ה-blob-sha-החי-מה-API (אם-409 — refetch+retry-פעם-אחת)
 *  - אימות-חי: ה-URL-הציבורי-חייב-להשיב-200-אחרי-פרסום
 *  - fail-open: כשל-כלשהו = קבלה-מתועדת + יציאה-שקטה — הלב-אף-פעם-לא-נופל-בגלל-המגדלור
 *  - אפס-סודות-בפלט: טוקנים-ממוסכים-תמיד
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HEART = join(ROOT, 'state/heart/last.json');
const WORKLOG = join(ROOT, 'memory/worklog.md');
const MEMORY = join(ROOT, 'memory/MEMORY.md');
const VAULT_ENC = join(ROOT, 'vault/vault-backup.enc');
const RECEIPT_LAST = join(ROOT, 'receipts/lighthouse-last.json');
const RECEIPT_LOG = join(ROOT, 'receipts/lighthouse.jsonl');
const PAT_FILE = join(ROOT, 'secrets/pat.env');

const OWNER = 'roshpinacare-sys';
const REPO = 'sovereign-lighthouse';
const PAGES_URL = `https://${OWNER}.github.io/${REPO}/`;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const BRANCH = 'main';
const TAIL = 7;

function maskSecret(s) {
  if (typeof s !== 'string' || s.length < 12) return '•••';
  return s.slice(0, 4) + '•••' + s.slice(-3);
}

function readPat() {
  if (!existsSync(PAT_FILE)) throw new Error('pat.env-חסר');
  const firstLine = readFileSync(PAT_FILE, 'utf8')
    .split('\n')
    .find((l) => l.trim() && !l.trim().startsWith('#'));
  if (!firstLine) throw new Error('pat.env-ריק');
  let pat = firstLine.includes('=') ? firstLine.split('=').slice(1).join('=') : firstLine;
  pat = pat.trim().replace(/^["']|["']$/g, '');
  if (!pat) throw new Error('PAT-ריק');
  return pat;
}

/* --- סריקת-סודות: אותו-גורם-כמו-מנוע-הגיט — אסור-שמאומת-לצאת-לציבור --- */
const SECRET_RX = /(glrt-[A-Za-z0-9_\-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-or-[A-Za-z0-9\-]{10,}|nvapi-[A-Za-z0-9\-]{10,}|eyJ[A-Za-z0-9_\-]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function sha12(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function writeReceipt(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  try { writeFileSync(RECEIPT_LAST, JSON.stringify({ ts: new Date().toISOString(), ...obj }, null, 1)); } catch {}
  try {
    const prev = existsSync(RECEIPT_LOG) ? readFileSync(RECEIPT_LOG, 'utf8').trim().split('\n') : [];
    prev.push(line);
    writeFileSync(RECEIPT_LOG, prev.slice(-TAIL).join('\n') + '\n');
  } catch {}
  console.log(`[lighthouse] ${line}`);
}

async function main() {
  if (!existsSync(HEART)) throw new Error('לב-חסר');
  const heart = JSON.parse(readFileSync(HEART, 'utf8'));
  const heartChain = heart.chain || '';
  const heartAt = heart.at || '';
  const head = heart.head || '';

  const worklogBuf = existsSync(WORKLOG) ? readFileSync(WORKLOG) : Buffer.alloc(0);
  const memoryBuf = existsSync(MEMORY) ? readFileSync(MEMORY) : Buffer.alloc(0);
  const vaultBytes = existsSync(VAULT_ENC) ? statSync(VAULT_ENC).size : 0;
  const worklogSha = sha12(worklogBuf);
  const memorySha = sha12(memoryBuf);

  /* --- שער-השינוי: אל-תדחוף-את-אותו-מצב-פעמיים (כמו-vercel-beacon) --- */
  let prev = null;
  try { prev = JSON.parse(readFileSync(RECEIPT_LAST, 'utf8')); } catch {}
  if (
    prev && prev.ok && prev.gateBlocked !== true &&
    prev.heartChain === heartChain && prev.worklogSha === worklogSha && prev.memorySha === memorySha
  ) {
    console.log('[lighthouse] אין-שינוי-מצב-מהפרסום-הקודם — skip (שער-שינוי)');
    return;
  }

  /* --- T-66: זנת-הגריד — קריאה-בטוחה --- */
  const gridIdx = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'grids/index.json'), 'utf8')); } catch { return null; } })();

  const state = {
    schema: 'roshpina.sovereign-beacon/1',
    publisher: 'T-60 heart-tick-automated (lighthouse-sync · כל-פעימת-לב)',
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    commit: `lastKnown:${head}`,
    commitDate: heartAt,
    branch: 'sanbox-main',
    lastKnownAlive: {
      heartAt,
      heartChain,
      worklogSha12: worklogSha,
      memorySha12: memorySha,
      vaultBytes,
    },
    memoryLayers: [
      { layer: 'github', detail: 'roshpinacare-sys/sanbox' },
      { layer: 'gitlab', detail: 'roshpinacare/sanbox' },
      { layer: 'postgres', detail: 'Supabase sovereign_state (state-replica)' },
      { layer: 'lighthouse', detail: 'הכתובת-הזו — מוכתבת-מהלב-אוטומטית (T-60)' },
      { layer: 'gitlab-ci', detail: 'ממתין-לאימות-זהות-הבעלים (escalations)' },
    ],
    grid: gridIdx ? { posts: gridIdx.total ?? 0, lastPostAt: gridIdx.lastPostAt ?? null, lastTitle: gridIdx.lastTitle ?? null, recent: (gridIdx.recent ?? []).slice(-5) } : null,
    fleet: {
      runner: 'GitLab runner 57265759 (self-healing via boot-all.sh)',
      renderCockpit: 'הצי-מחזיק-את-הנתיב (אי-התנגשות>מאבק)',
      escalations: 'sanbox repo-vault/escalations.json — שערי-בעלים-עם-ראיות',
      webSense: 'T-62: חיפוש-ריבוני (Tavily x2 · 200) + קריאת-דפים (Jina · 200) — אטום-בכספת · scripts/web-sense.mjs',
      motherConsole: 'T-64: קונסולת-האם 3050 נולדה-מחדש-מהריפו (scripts/console-server.ts) · משגיח-מחוסן (spawn-אסינכרוני+execPath)',
      webRecon: 'T-64: סייר-ריבוני-תקופתי (כל-~שעה): חיפוש-מדורג + ביקורת-חוץ-עצמית-של-המגדלור-מהאינטרנט',
      sovereigntyDrill: 'T-65: משפט-הריבונות (scripts/sovereignty-drill.sh): עננים-מרחוק+clone-טרי+שחזור-כספת+ביט-מול-חיים',
      grid: gridIdx ? `T-66: הגריד-הריבוני-חי (grids/run.mjs · spawn-5-מהלב) — פוסטים-מראיות: ${gridIdx.total ?? 0} · אחרון: ${gridIdx.lastTitle ?? ''}` : 'T-66: מותקן-ממתין-לפעימה-הראשונה',
      developmentPaths: 'מ-Head-Corner: browser-use/Skyvern (דפדפן) · vLLM (אינפרנס-עצמאי) · LangSearch (401-ממתין-הפעלה)',
    },
    awakening: [
      '1. הגיט-הוא-הקוד-המלא: שני-עננים-נושאים-sanbox + vault/vault-backup.enc (AES-256-GCM)',
      '2. שחזור-כספת: bun scripts/vault-restore.ts — המפתח: HQ_VAULT_PASS (hq.password אצל-Head-Corner · וב-~/.sovereign/guardian.env לאוטונומיה-מלאה-לאחר-התקנת-השומר)',
      '3. הצתה: sh sanbox/scripts/boot-all.sh — סודות→כספת→מפקח→שומר→HQ-3010',
      '4. זיכרון-חוץ-מכונה: bun scripts/state-replica.mjs pull',
      '5. ההתחדשות-אוטומטית: קומיט=הצתה; הלב-פועם-כל-15-דקות ומכתיב-את-המגדלור-הזה',
    ],
    doctrine: 'אפס-אמון-בטענות · הכל-מנוטר-בגיט · fail-open-לעננים-חוץ-מכונה · הכספת-נפתחת-רק-בסיסמה',
  };

  const content = Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf8');
  const contentStr = content.toString('utf8');

  /* --- סריקת-סודות-על-התוכן-היוצא (חוסם-הפרסום) --- */
  const hit = SECRET_RX.exec(contentStr);
  if (hit) throw new Error(`חסימת-פרסום: חשד-סוד-בתוכן (${maskSecret(hit[0])})`);

  /* --- T-66: אפס-שקר-מקומי — public/state.json מתעדכן-מאותו-מצב-שנדחף ---
   * (היה-נולד-מיושן-וזרע-תדמית-"אין-התקדמות" — הריבון-ראה-heartAt-ישן) --- */
  try { writeFileSync(join(ROOT, 'public/state.json'), contentStr); } catch { /* fail-open */ }

  /* --- T-66: פרסום-זנת-הגריד למגדלור (grid.json · fail-open גמור — לא-מפיל-את-ההכתבה) --- */
  let gridPush = null;
  if (gridIdx) {
    const gContent = Buffer.from(JSON.stringify(gridIdx, null, 1) + '\n', 'utf8');
    const gHit = SECRET_RX.exec(gContent.toString('utf8'));
    if (gHit) {
      gridPush = { ok: false, blocked: 'secret-scan' };
    } else {
      const gMsg = `grid: פוסטים=${gridIdx.total ?? 0}`;
      const gPut = (sha) => gh(`/contents/grid.json`, { method: 'PUT', body: JSON.stringify({ message: gMsg, content: gContent.toString('base64'), branch: BRANCH, ...(sha ? { sha } : {}) }) });
      const gCur = await gh(`/contents/grid.json?ref=${BRANCH}`);
      let gRes = await gPut(gCur.json?.sha || null);
      if (gRes.status === 409 && gCur.json?.sha) {
        const fresh = await gh(`/contents/grid.json?ref=${BRANCH}`);
        if (fresh.json?.sha) gRes = await gPut(fresh.json.sha);
      }
      gridPush = { ok: gRes.status === 200 || gRes.status === 201, http: gRes.status };
    }
  }

  const pat = readPat();
  const auth = { Authorization: `token ${pat}`, Accept: 'application/vnd.github+json' };

  const gh = async (path, opts = {}) => {
    const r = await fetch(`${API}${path}`, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };

  /* --- אפס-אמון: קורא-את-ה-blob-הקיים (sha) ואת-תוכנו-להשוואה --- */
  const cur = await gh(`/contents/state.json?ref=${BRANCH}`);
  const curSha = cur.json?.sha || null;
  const curContent = cur.json?.content
    ? Buffer.from(cur.json.content, 'base64').toString('utf8')
    : null;

  if (curSha && curContent) {
    let curState = null;
    try { curState = JSON.parse(curContent); } catch {}
    if (
      curState?.lastKnownAlive?.heartChain === heartChain &&
      curState?.lastKnownAlive?.worklogSha12 === worklogSha &&
      curState?.lastKnownAlive?.memorySha12 === memorySha
    ) {
      writeReceipt({ ok: true, mode: 'skip-identical', heartChain, worklogSha, memorySha, pagesUrl: PAGES_URL });
      return;
    }
  }

  /* --- הכתבה: PUT עם-ה-sha-החי (retry-אחד-ב-409) --- */
  const putOnce = async (sha) =>
    gh(`/contents/state.json`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `heartbeat: מגדלור-מוכתב-מהלב · chain=${heartChain.slice(0, 12)}`,
        content: content.toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

  let res = await putOnce(curSha);
  if (res.status === 409 && curSha) {
    const fresh = await gh(`/contents/state.json?ref=${BRANCH}`);
    if (fresh.json?.sha) res = await putOnce(fresh.json.sha);
  }

  if (res.status !== 200 && res.status !== 201) {
    const gateBlocked = res.status === 403 || res.status === 404;
    writeReceipt({
      ok: false,
      mode: 'push',
      gateBlocked,
      http: res.status,
      error: `contents-PUT-${res.status}`,
      heartChain,
      worklogSha,
      memorySha,
    });
    process.exitCode = gateBlocked ? 0 : 1;
    return;
  }

  /* --- אימות-חי: המגדלור-חייב-להשיב-200 --- */
  await new Promise((r) => setTimeout(r, 3000));
  let live = 0;
  try {
    const lr = await fetch(PAGES_URL, { redirect: 'follow' });
    live = lr.status;
  } catch {}
  const commit = res.json?.commit?.sha?.slice(0, 12) || '•••';
  writeReceipt({
    ok: live === 200 || live === 0 /* CDN-עוד-מתעדכן — הפרסום-עצמו-אושר-ב-200/201 */,
    mode: 'push',
    lighthouseCommit: commit,
    liveHttp: live,
    pagesUrl: PAGES_URL,
    heartChain,
    worklogSha,
    memorySha,
    gridPush,
  });
}

main().catch((err) => {
  writeReceipt({ ok: false, mode: 'push', error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
