#!/usr/bin/env node
/**
 * grids/run.mjs — T-66: הגריד-הריבוני — פעילות-גלויה-מראיות
 * ============================================================
 * הבעיה-שנתפסה-בחיים (T-66 · דברי-הריבון): "אני-לא-רואה-פוסטים, לא-רואה-התקדמות".
 * האבחון-אימת: grids/run.mjs היה-רק-שורה-במפקד-הצי (fleet-census) — מעולם-לא-התקיים
 * (גם-לא-בהיסטוריית-הגיט). הצי-עבד-אך-לא-דיבר.
 * (שוחזר-פעמיים: פעם-ראשונה-נמחק-על-ידי-pull--rebase--autostash--X-theirs-של-תאום —
 *  תקרית-T-66a-המתועדת-ביומן. אפס-בכי — שחזור-מההקשר-ולמעלה-מזה.)
 *
 * הפתרון: הגריד-הוא-קול-הצי. עם-כל-הזמנה-מהלב (spawn-חמישי · heart-tick), הרץ:
 *  1. אוסף-ראיות-חדשות-מאז-הפוסט-הקודם: קומיטים · קבלות-הצי (revive/כשלים/דחיפות/
 *     סיורים/משפטים) · פתוחי-escalations · תזוזת-שרשרת-הלב — הכל-מקבצים-על-הדיסק,
 *     אפס-טענות, אפס-סודות (לא-נוגע-בכספת-כלל).
 *  2. מחבר-פוסט-עברית-קצרה (title+lines) — כל-שורה-נגזרת-מאירוע-ממשי.
 *  3. סורק-את-הפוסט-באותו-regex-סודות-של-המגדלור — פגיעה=חסימת-פוסט+קבלה.
 *  4. כותב: grids/posts/YYYY-MM-DD.jsonl (צירוף) · grids/index.json (מצביע+8-אחרונים)
 *     · grids/receipts.jsonl (זנב-200).
 *
 * כלכלה: מינימום-25 דק' בין-פוסטים; אין-ראיות-חדשות=skip-שקט-עם-nextRunAt;
 * keep-alive-כל-6 שעות גם-בלי-ראיות (פועם-אך-לא-מזייף-רעש).
 * דוקטרינה: fail-open · execPath-אגנוסטי (node/bun) · יציאה-0-תמיד.
 *
 * T-67-שחרור: מעתה הפוסטים-גם-יוצאים-לשרשרת-באמת — Hive (posting-authority,
 * המפתח-מ-sanbox/secrets/hive-posting.wif 600 · gitignored · לעולם-לא-נכנס-לפוסט).
 * כלכלת-שרשרת: מינימום-60 דק' בין-פרסומי-שרשרת (RC-mana) · קבלות-כנות:
 * recorded (=נרשם-מקומית) נפרד-מ-chain-hive (=אושר-בשרשרת-מget_content).
 * אין-מפתח/כשל-RC/כשל-רשת = קבלה-כנה ok:false והרישום-המקומי-נשאר.
 * GRID_FORCE=1 — שער-בדיקה (מדלג-על too-soon/too-soon-chain) לצורך-תרגילים-ידניים.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const INDEX = join(HERE, 'index.json');
const POSTS = join(HERE, 'posts');
const RECEIPTS = join(HERE, 'receipts.jsonl');
const RECEIPT_TAIL = 200;
const MIN_INTERVAL_MS = 25 * 60_000;
const KEEPALIVE_MS = 6 * 3_600_000;
const CHAIN_MIN_INTERVAL_MS = 60 * 60_000;
const CHAIN_AUTHOR = 'headcorner';
const CHAIN_WIF_PATH = join(ROOT, 'secrets/hive-posting.wif');
const LIGHTHOUSE_URL = 'https://roshpinacare-sys.github.io/sovereign-lighthouse/';

/* --- אותו-גורם-סודות-כמו-המגדלור (T-60) — פגיעה-חוסמת-פרסום --- */
const SECRET_RX = /(glrt-[A-Za-z0-9_\-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-or-[A-Za-z0-9\-]{10,}|nvapi-[A-Za-z0-9\-]{10,}|eyJ[A-Za-z0-9_\-]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

const nowIso = () => new Date().toISOString();
const readJson = (p, fb = null) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; }
};
const tailLines = (p, n) => {
  try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).slice(-n); } catch { return []; }
};

function writeReceipt(obj) {
  try {
    const prev = tailLines(RECEIPTS, RECEIPT_TAIL - 1);
    prev.push(JSON.stringify({ ts: nowIso(), ...obj }));
    writeFileSync(RECEIPTS, prev.join('\n') + '\n');
  } catch { /* fail-open */ }
}

/* --- איסוף-ראיות: הכל-מהדיסק, הכל-אופציונלי, אפס-רשת --- */
function gitCommits(sinceCursor) {
  try {
    const range = sinceCursor ? `${sinceCursor}..HEAD` : 'HEAD~5..HEAD';
    const out = execFileSync('git', ['-C', ROOT, 'log', '--oneline', '--no-decorate', range], {
      encoding: 'utf8', timeout: 10_000,
    }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    try {
      const out = execFileSync('git', ['-C', ROOT, 'log', '--oneline', '--no-decorate', '-5', 'HEAD'], {
        encoding: 'utf8', timeout: 10_000,
      }).trim();
      return out ? out.split('\n').filter(Boolean) : [];
    } catch { return []; }
  }
}
const lineCount = (p) => { try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };

/* מקורות-ראיות: קבצי-קבלות-הצי — כל-אחד-עם-מסנן-אירועים-ראויי-פוסט */
const SOURCES = [
  { key: 'supervisor', path: join(ROOT, 'receipts/supervisor.jsonl'), kinds: ['revive', 'spawn', 'console-revive', 'hq-revive'] },
  { key: 'consoleServer', path: join(ROOT, 'receipts/console-server.jsonl'), kinds: ['revive', 'boot', 'start'] },
  { key: 'webRecon', path: join(ROOT, 'receipts/web-recon.jsonl'), kinds: ['recon'] },
  { key: 'lighthouse', path: join(ROOT, 'receipts/lighthouse.jsonl'), kinds: [] },
  { key: 'stateReplica', path: join(ROOT, 'receipts/state-replica.jsonl'), kinds: [] },
  { key: 'vercelBeacon', path: join(ROOT, 'receipts/vercel-beacon.jsonl'), kinds: [] },
  { key: 'gitlabPush', path: join(ROOT, 'receipts/gitlab-push.jsonl'), kinds: [] },
  { key: 'pushLog', path: join(ROOT, 'receipts/push-log.jsonl'), kinds: [] },
  { key: 'sovereigntyDrill', path: join(ROOT, 'receipts/sovereignty-drill.jsonl'), kinds: [] },
  { key: 'vaultDrill', path: join(ROOT, 'receipts/vault-drill.jsonl'), kinds: [] },
];

/* מפענח-אירוע-לשורת-פוסט (עברית · אפס-סודות · טוקנים-לא-נכנסים-כלל) */
function summarize(sourceKey, line) {
  let e = null;
  try { e = JSON.parse(line); } catch { return null; }
  const type = String(e.type || e.op || e.mode || '');
  switch (sourceKey) {
    case 'supervisor':
      if (/-revive/.test(type) || /revive/.test(type)) return `שומר-החיים-הצמיד: ${type} (port ${e.port ?? '?'} · pid ${e.pid ?? '?'})`;
      if (e.type === 'console-source-missing') return 'מקור-קונסולה-חסר — נצפה-בדיחוי (debounce), המשגיח-ממשיך';
      return null;
    case 'consoleServer':
      if (e.event === 'boot' || e.event === 'start') return `קונסולת-האם 3050 קמה (pid ${e.pid ?? '?'})`;
      return null;
    case 'webRecon':
      if (e.ok && !e.skipped) return `סיור-רשת-הושלם: "${e.topic ?? '?'}" (${e.durationMs ?? '?'}ms · חיפוש+ביקורת-חוץ-עצמית)`;
      return null;
    case 'lighthouse':
      if (e.ok === false) return `תקלת-מגדלור-נתפסה (${e.error ?? e.mode ?? '?'})`;
      if (e.ok && e.mode === 'push' && e.liveHttp === 200) return `מגדלור-מוכתב-מהלב: פורסם-ואומת-200 מבחוץ (chain ${String(e.heartChain ?? '').slice(0, 8)})`;
      return null;
    case 'stateReplica':
      if (e.ok === false) return `תקלת-שכפול-פוסטגרס-נתפסה (${e.error ?? '?'})`;
      if (e.ok && e.mode === 'push') return `זיכרון-חוץ-מכונה נחתם בפוסטגרס (head ${String(e.head ?? '').slice(0, 4)}•)`;
      return null;
    case 'vercelBeacon':
      if (e.ok === false && e.gateBlocked) return 'ורסל-חסום-שער-בעלים (403 create-project) — מתועד-כנה, לא-מזויף-כהצלחה';
      if (e.ok === false) return `תקלת-משדר-ורסל (${e.error ?? '?'})`;
      if (e.ok && e.mode === 'push') return 'משדר-ורסל-פורסם';
      return null;
    case 'gitlabPush':
      if (e.ok) return `דחיפה-לגיטלאב אומתה (${String(e.sha ?? e.head ?? '').slice(0, 7)})`;
      if (e.ok === false) return `כשל-דחיפה-גיטלאב (${e.error ?? '?'})`;
      return null;
    case 'pushLog':
      if (e.ok) return `דחיפה-לענן: ${e.remote ?? e.target ?? '?'} (${String(e.sha ?? '').slice(0, 7)})`;
      if (e.ok === false) return `כשל-דחיפה: ${e.remote ?? e.target ?? '?'} (${e.error ?? '?'})`;
      return null;
    case 'sovereigntyDrill':
      if (e.ok) return `משפט-הריבונות: פסק-דין-עובר (ביט-מול-חיים ${e.identical ?? '?'}/${e.total ?? '?'})`;
      if (e.ok === false) return `משפט-הריבונות: פער-נתפס! (${e.gap ?? e.error ?? 'ראה-קבלה'})`;
      return null;
    case 'vaultDrill':
      if (e.ok) return `תרגיל-כספת: שחזור-ביט-מושלם (${e.identical ?? '?'}/${e.total ?? '?'})`;
      if (e.ok === false) return `תרגיל-כספת: פער! (${e.error ?? '?'})`;
      return null;
    default: return null;
  }
}

async function main() {
  const now = Date.now();
  const force = process.env.GRID_FORCE === '1';
  const idx = readJson(INDEX, {}) || {};
  const lastPostAt = idx.lastPostAt ? Date.parse(idx.lastPostAt) : 0;

  /* --- כלכלה: too-soon → skip-שקט-עם-nextRunAt (GRID_FORCE מדלג-לתרגילים) --- */
  const sinceLast = lastPostAt ? now - lastPostAt : Infinity;
  if (!force && lastPostAt && sinceLast < MIN_INTERVAL_MS) {
    writeReceipt({ op: 'grid', ok: true, skipped: 'too-soon', msSinceLast: sinceLast, nextRunAt: new Date(lastPostAt + MIN_INTERVAL_MS).toISOString() });
    return;
  }

  /* --- איסוף --- */
  const cursor = idx.cursor || {};
  const commits = gitCommits(cursor.commit);
  const lines = [];
  let totalNewEvents = 0;

  for (const src of SOURCES) {
    const curCount = lineCount(src.path);
    const prevCount = (cursor.lineCounts || {})[src.key] ?? curCount; // בפעימה-ראשונה: לא-מציפים-היסטוריה
    if (curCount <= prevCount) continue;
    const fresh = tailLines(src.path, curCount - prevCount);
    const notable = [];
    for (const l of fresh) {
      const s = summarize(src.key, l);
      if (s) notable.push(s);
    }
    totalNewEvents += fresh.length;
    for (const s of notable.slice(0, 4)) lines.push(`· ${s} [${src.key}]`);
  }

  /* --- T-66c: משימת-המקור-מהיומן — ההתקדמות-האמיתית-נראית (לא-רק-מספרי-קומיטים) ---
   * הריבון: "אני-לא-רואה-התקדמות" — עתה-כל-פוסט-נושא-את-שורת-המשימה-האחרונה-מהיומן-עצמו. */
  const lastTask = (() => {
    try {
      const txt = readFileSync(join(ROOT, 'memory/worklog.md'), 'utf8');
      const ids = [...txt.matchAll(/^Task ID:\s*(.+)$/gm)].map((m) => m[1].trim());
      return ids.length ? ids[ids.length - 1].slice(0, 60) : null;
    } catch { return null; }
  })();
  if (lastTask) lines.push(`· משימת-מקור-ביומן: T-${lastTask.replace(/^T-?/, '')} [worklog]`);

  /* --- escalations + לב --- */
  const escal = readJson(join(ROOT, 'repo-vault/escalations.json'), null);
  /* T-66c: רק-שערים-חוסמים-נספרים — SUPERSEDED/OPTIONAL/blocking:false אינם-חוסמים-ריבונות
   * (היה: כל-לא-RESOLVED-נספר-כפתוח → תדמית-"ריבונות-תקועה"-בעודה-חופשית) */
  const isBlocking = (x) =>
    x && !String(x.status ?? 'OPEN').toUpperCase().startsWith('RESOLVED') &&
    x.blocking !== false && !/OPTIONAL|SUPERSEDED/.test(String(x.status ?? '').toUpperCase());
  const escalAll = Array.isArray(escal) ? escal : (escal?.items ?? []);
  const escalOpen = Array.isArray(escalAll) ? escalAll.filter(isBlocking).length : null;
  if (escalOpen !== null && escalOpen !== cursor.escalOpen) {
    lines.push(`· שערים-חוסמים: ${escalOpen} (היה ${cursor.escalOpen ?? '?'}) [escalations]`);
    totalNewEvents++;
  }

  const heart = readJson(join(ROOT, 'state/heart/last.json'), {});
  const heartChanged = heart.chain && heart.chain !== cursor.heartChain;
  if (heartChanged) totalNewEvents++;

  /* --- החלטה: פוסט / keep-alive / skip --- */
  const headNow = (() => { try { return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim(); } catch { return cursor.commit || ''; } })();
  const hasEvidence = commits.length > 0 || lines.length > 0 || heartChanged;
  const keepaliveDue = lastPostAt && now - lastPostAt >= KEEPALIVE_MS;

  if (!force && !hasEvidence && !keepaliveDue) {
    writeReceipt({ op: 'grid', ok: true, skipped: 'no-evidence', newEvents: 0, nextRunAt: new Date(now + Math.max(MIN_INTERVAL_MS - (lastPostAt ? now - lastPostAt : 0), 60_000)).toISOString() });
    return;
  }

  let title; let kind;
  if (!hasEvidence && keepaliveDue) {
    kind = 'keepalive';
    title = 'פעימה-ריבונית — הצי-חי, אין-ראיות-חדשות-מאז-הפוסט-הקודם';
    lines.push(`· לב: chain ${String(heart.chain ?? '').slice(0, 8)} · at ${heart.at ?? '?'}`);
  } else if (commits.length > 0) {
    /* T-66c: כותרת-מהותית-מהקומיט-הראשון — קץ-תבנית-"N קומיטים-חדשים"-השחוקה
     * (הריבון-ראה-4-פוסטים-תאומים-וקרא-לזה-כפילויות — והיה-צודק) */
    kind = 'report';
    const firstSubject = (() => {
      const first = commits[0] ?? '';
      const sp = first.indexOf(' ');
      return sp > 0 ? first.slice(sp + 1).trim().slice(0, 72) : first.slice(0, 72);
    })();
    title = `${commits.length} קומיטים: ${firstSubject}${commits.length > 1 ? ` (+${commits.length - 1} עוד)` : ''}`;
    for (const c of commits.slice(0, 5)) lines.push(`· commit: ${c}`);
    if (commits.length > 5) lines.push(`· ועוד ${commits.length - 5} קומיטים (זנב-מלא-בגיט)`);
  } else {
    kind = 'report';
    const firstTag = (() => { const m = (lines[0] ?? '').match(/\[([a-zA-Z]+)\]\s*$/); return m ? m[1] : ''; })();
    title = `פעילות-צי: ${lines.length} אירועים${firstTag ? ` — ${firstTag}` : ''}`;
  }

  /* --- T-66c: חיסון-אנטי-כפילות-ברמת-התוכן — זהה-לפוסט-הקודם-בתוך-6 שעות → אין-פוסט ---
   * (רעש-זהה-אינו-ראיה; keep-alive-השעתי-ממילא-מבטיח-פעימה-חיה) */
  const postSig = JSON.stringify([title, lines]);
  if (idx.lastSig === postSig && !keepaliveDue) {
    writeReceipt({ op: 'grid', ok: true, skipped: 'duplicate-content', msSinceLast: now - lastPostAt });
    return;
  }

  /* --- סריקת-סודות-על-הפוסט (חוסם-פרסום) --- */
  const post = {
    id: `g${now.toString(36)}`,
    ts: nowIso(),
    kind,
    title,
    lines,
    evidence: { commits: commits.length, newReceiptLines: totalNewEvents, escalOpen, heartChain: String(heart.chain ?? '').slice(0, 12), head: headNow.slice(0, 12) },
  };
  const hit = SECRET_RX.exec(JSON.stringify(post));
  if (hit) {
    writeReceipt({ op: 'grid', ok: false, blocked: 'secret-scan', hint: hit[0].slice(0, 4) + '•••' });
    return;
  }

  /* --- T-67: פרסום-שרשרת-אמיתי (Hive · posting-authority · כנות-מלאה) --- */
  post.chain = await publishToChain(post, idx, force);

  /* --- כתיבה: פוסט יומי + אינדקס --- */
  const day = post.ts.slice(0, 10);
  try {
    appendFileSync(join(POSTS, `${day}.jsonl`), JSON.stringify(post) + '\n');
  } catch { /* fail-open */ }

  const recent = Array.isArray(idx.recent) ? idx.recent : [];
  recent.push({ id: post.id, ts: post.ts, kind: post.kind, title: post.title, chain: post.chain && post.chain.hive ? { ok: post.chain.hive.ok, permlink: post.chain.hive.permlink, url: post.chain.hive.url } : undefined });
  const newIndex = {
    schema: 'sanbox.grid/1',
    asof: post.ts,
    total: (idx.total ?? 0) + 1,
    lastPostAt: post.ts,
    lastTitle: post.title,
    lastSig: postSig, // T-66c: חיסון-אנטי-כפילות
    cursor: { commit: headNow, lineCounts: Object.fromEntries(SOURCES.map((s) => [s.key, lineCount(s.path)])), escalOpen, heartChain: heart.chain ?? '' },
    recent: recent.slice(-8),
  };
  try { writeFileSync(INDEX, JSON.stringify(newIndex, null, 1) + '\n'); } catch { /* fail-open */ }
  writeReceipt({ op: 'grid', ok: true, recorded: post.id, kind, title, commits: commits.length, newEvents: totalNewEvents, chain: post.chain?.hive?.ok ? post.chain.hive.permlink : (post.chain?.hive?.error ?? post.chain?.hive?.skipped ?? 'no-key') });
}

/* --- T-67: Hive פרסום — posting-WIF-מהסודות (600·gitignored) · get_content-מזהה-כפילויות
 *    · תוצאה-מאומתת-רק-מget_content (לא-מההבטחה-של-הbroadcast) · כל-כשל-כנה-ולא-חוסם-רישום-מקומי --- */
async function publishToChain(post, idx, force) {
  const out = { hive: { ok: false } };
  try {
    if (!existsSync(CHAIN_WIF_PATH)) { out.hive.skipped = 'no-key'; return out; }
    const lastChainAt = idx.lastChainAt ? Date.parse(idx.lastChainAt) : 0;
    if (!force && lastChainAt && Date.now() - lastChainAt < CHAIN_MIN_INTERVAL_MS) { out.hive.skipped = 'chain-too-soon'; return out; }
    const wif = readFileSync(CHAIN_WIF_PATH, 'utf8').trim();
    if (!/^[5KL][1-9A-HJ-NP-Za-km-z]{50,52}$/.test(wif)) { out.hive.skipped = 'bad-key-shape'; return out; }
    const hive = createRequire('/home/z/my-project/package.json')('@hiveio/hive-js');
    try { hive.api.setOptions({ url: 'https://api.hive.blog' }); } catch { /* ברירת-מחדל-כן */ }
    const permlink = `saos-grid-${post.id.toLowerCase()}`;
    const exists = await new Promise((resolve) => {
      try { hive.api.getContent(CHAIN_AUTHOR, permlink, (e, r) => resolve(!e && r && r.author === CHAIN_AUTHOR)); } catch { resolve(false); }
    });
    if (exists) { out.hive = { ok: true, already: true, permlink, url: `https://hive.blog/@${CHAIN_AUTHOR}/${permlink}` }; return out; }
    const body = [
      post.title,
      '',
      ...post.lines.slice(0, 8),
      '',
      `ראיות: קומיטים ${post.evidence.commits} · אירועים ${post.evidence.newReceiptLines} · לב ${String(post.evidence.heartChain || '').slice(0, 8)} · HEAD ${String(post.evidence.head || '').slice(0, 8)}`,
      `מקור: צי-ריבוני · מגדלור: ${LIGHTHOUSE_URL}`,
    ].join('\n');
    const meta = { tags: ['saos', 'sovereignty', 'autonomy', 'hive', 'grid'], app: 'saos-grid/1.1', format: 'markdown', lighthouse: LIGHTHOUSE_URL };
    const bc = await new Promise((resolve) => {
      try { hive.broadcast.comment(wif, '', 'saos', CHAIN_AUTHOR, permlink, post.title, body, meta, (e, r) => resolve({ e, r })); } catch (e) { resolve({ e }); }
    });
    if (bc.e) { out.hive.error = String(bc.e.message || bc.e).slice(0, 200); return out; }
    const verified = await new Promise((resolve) => {
      setTimeout(() => {
        try { hive.api.getContent(CHAIN_AUTHOR, permlink, (e, r) => resolve(!e && r && r.author === CHAIN_AUTHOR ? r : null)); } catch { resolve(null); }
      }, 2500);
    });
    if (verified) { out.hive = { ok: true, permlink, url: `https://hive.blog/@${CHAIN_AUTHOR}/${permlink}`, created: verified.created, txId: String(verified.transaction_id || '').slice(0, 16) || undefined }; writeReceipt({ op: 'chain-hive', ok: true, permlink, url: out.hive.url, txId: out.hive.txId, postId: post.id }); }
    else out.hive.error = 'broadcast-accepted-but-content-not-visible-yet';
  } catch (e) { out.hive.error = String(e && e.message || e).slice(0, 200); }
  return out;
}

main().catch((e) => { writeReceipt({ op: 'grid', ok: false, error: e instanceof Error ? e.message : '?' }); }).finally(() => process.exit(0));
