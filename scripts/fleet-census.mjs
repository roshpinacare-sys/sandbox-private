#!/usr/bin/env bun
/**
 * fleet-census.mjs — פקודת-האמת-האחת של-הצי (stdlib-בלבד · אפס-תלויות · אפס-סודות-בפלט).
 *
 * T-55 (הוראת-המפעיל: "לזקק להסיק ליישם"): כל-סוכן-חדש/שחזור/ספק — פקודה-אחת-מחזירה
 * את-כל-האמת-הנמדדת: מכונה · תהליכים · פורטים · 4-ריפו · קבלות · כספות-קיימות-והרשאות.
 * העיקרון (RECOVERY-PLAYBOOK P7): טענה-בלי-census = בדיה. אסור.
 *
 * שימוש:  bun sanbox/scripts/fleet-census.mjs   (או node — stdlib-בלבד)
 * יציאה:  JSON-אחת לstdout. אפס-תוכן-סוד — רק-קיום+הרשאות.
 */
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';

const PROJECT = '/home/z/my-project';
const REPOS = {
  'saos-control-center': PROJECT,
  sanbox: `${PROJECT}/sanbox`,
  'saos-dex': `${PROJECT}/saos-dex`,
};
const CONSOLE_MIRROR = `${process.env.HOME}/.sovereign/mirror`;
const SUPERVISOR_PID = `${PROJECT}/sanbox/db/supervisor.pid`;

/** בדיקת-TCP בלבד (לא מספיקה לשירות-חי — רק-סימן) */
function tcpAlive(port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ port, timeout });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

/** בדיקת-HTTP-אמיתית (הלקח-מ-T-47: TCP-בלבד-זייף-חיים) */
function httpAlive(port, path, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function pidsByPattern(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 4000 })
      .split('\n').filter(Boolean);
  } catch { return []; }
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function repoTruth(dir, name) {
  const g = (args) => {
    try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 6000 }).trim(); }
    catch (e) { return `error:${String(e.status ?? 'unknown')}`; }
  };
  return {
    name,
    path: dir,
    exists: existsSync(`${dir}/.git`),
    branch: g(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: g(['rev-parse', '--short', 'HEAD']),
    dirty: g(['status', '--porcelain']).split('\n').filter(Boolean).length,
  };
}

function fileTruth(p) {
  try {
    if (!existsSync(p)) return { path: p, exists: false };
    const m = statSync(p).mode & 0o777;
    return { path: p.replace(process.env.HOME ?? '', '~'), exists: true, mode: m.toString(8) };
  } catch { return { path: p, exists: 'error' }; }
}

function lastEvents(file, n) {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').trim().split('\n').slice(-n)
      .map((l) => { try { const j = JSON.parse(l); return { ts: j.ts, type: j.type }; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const mem = {};
try {
  const mi = readFileSync('/proc/meminfo', 'utf8');
  mem.totalMB = Math.round(Number(mi.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) / 1024);
  mem.availMB = Math.round(Number(mi.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) / 1024);
  mem.pressured = mem.availMB > 0 && mem.availMB < 350; // MEM_PRESSURE_AVAIL_MB-ברירת-המחדל
} catch { mem.error = true; }

let supervisor = { pidfile: false };
try {
  const pid = Number(readFileSync(SUPERVISOR_PID, 'utf8').trim());
  supervisor = { pidfile: true, pid, alive: pidAlive(pid) };
} catch { /* אין-קובץ — כנות */ }

const escal = {};
try {
  const j = JSON.parse(readFileSync(`${PROJECT}/repo-vault/escalations.json`, 'utf8'));
  const arr = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : Array.isArray(j.escalations) ? j.escalations : []);
  escal.total = arr.length;
  // T-56-fix: "RESOLVED-EXEC-CD-29"/"RESOLVED-T-55" וכד' — כל-סטטוס-שמתחיל-בRESOLVED-נסגר
  escal.open = arr.filter((e) => e && !String(e.status ?? 'OPEN').toUpperCase().startsWith('RESOLVED')).length;
} catch { escal.error = true; }

const census = {
  asof: new Date().toISOString(),
  machine: {
    uptimeH: +(os.uptime() / 3600).toFixed(2),
    load: os.loadavg().map((x) => +x.toFixed(2)),
    mem,
  },
  fleet: {
    supervisor,
    guardian: { alive: pidsByPattern('sovereign/guardian.ts').length > 0 },
    consoleWatchers: pidsByPattern('mini-services/web/index.ts').length, // >1 = מחלה-מחזרת
    nextDev3050: pidsByPattern('next dev -p 3050').length,
    nextDev3010: pidsByPattern('next dev -p 3010').length,
    gridRunner: pidsByPattern('grids/run.mjs').length,
  },
  ports: {
    3000: { tcp: await tcpAlive(3000) },
    3010: { http: await httpAlive(3010, '/saos-dex/') }, // / מחזיר-404-בכוונה (basePath)
    3011: { http: await httpAlive(3011, '/') },
    3050: { http: await httpAlive(3050, '/') },
  },
  repos: [
    repoTruth(REPOS['saos-control-center'], 'saos-control-center'),
    repoTruth(REPOS.sanbox, 'sanbox'),
    repoTruth(REPOS['saos-dex'], 'saos-dex'),
    repoTruth(CONSOLE_MIRROR, 'SovereignConsole-mirror'),
  ],
  receipts: {
    supervisor: lastEvents(`${PROJECT}/sanbox/receipts/supervisor.jsonl`, 5),
    guardian: lastEvents(`${process.env.HOME}/.sovereign/guardian.jsonl`, 3),
  },
  vaults: {
    walletEnc: fileTruth(`${PROJECT}/repo-vault/wallet.enc.json`),
    secretsBackup: fileTruth(`${PROJECT}/sanbox/vault/vault-backup.enc`),
    patEnv: fileTruth(`${PROJECT}/upload/pat.env`),
    sovereignRemote: fileTruth(`${process.env.HOME}/.sovereign/remote.env`),
    agentKey: fileTruth(`${process.env.HOME}/.sovereign/agent-key.env`),
    hqPassword: fileTruth(`${process.env.HOME}/.sovereign/hq.password`),
    guardianTs: fileTruth(`${process.env.HOME}/.sovereign/guardian.ts`),
  },
  escalations: escal,
};

const ok =
  supervisor.alive === true &&
  census.fleet.guardian.alive &&
  census.ports[3011].http &&
  census.ports[3050].http &&
  census.repos.every((r) => r.exists === true && !String(r.head).startsWith('error'));

console.log(JSON.stringify({ ...census, ok }, null, 1));
