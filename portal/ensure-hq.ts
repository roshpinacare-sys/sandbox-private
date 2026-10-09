import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import * as path from "node:path";

/**
 * הבטחת-חיים-עצמאית לשרת-HQ (sanbox, פורט 3010).
 * נקרא מפרוקסי-הסטטוס בכל בדיקה: אם-הפורט-מת — הקם-מחדש-detached
 * מעץ-ה-boot (next-server), כך-שהוא-שורד-את-ה-reaper-של-מעטפות-ad-hoc.
 *
 * שחזור-מגיט (ריבונות-מלאה): אם-הפורט-מת **וגם** sanbox/server.ts לא-קיים —
 * לפני-ההקמה משחזרים את תיקיית-ה-sanbox מהריפו-הפרטי (git clone):
 *  - remoteUrl מ-~/.sovereign/config.json (ברירת-מחדל: הריפו הפרטי roshpinacare-sys/sanbox)
 *  - PAT מ-~/.sovereign/remote.env (`PAT=...` או שורה-גולמית); אם-אין —
 *    מ-sanbox/secrets/pat.env (אם-התיקייה-שרדה). אין-PAT → נכשלים-בשקט
 *    (השומר-העצמאי יטפל בהקמה כשיהיה מה לשחזר).
 *  - היגיינה-מלאה: הטוקן מעולם לא ב-argv, לא ב-URL, לא ב-.git/config —
 *    רק GIT_ASKPASS זמני-תחת-tmpdir (מצב 700) + HQ_TOKEN בסביבת-התהליך;
 *    ה-helper נמחק תמיד (finally). GIT_TERMINAL_PROMPT=0 — אין-שאיבת-קלט.
 */

const HQ_PORT = 3010;
const SPAWN_DEBOUNCE_MS = 30_000;
const RESTORE_DEBOUNCE_MS = 120_000; // debounce-שחזור-נפרד מלבד-debounce-ההקמה
const SANDBOX_DIR = "/home/z/my-project/sanbox";
const REMOTE_DEFAULT = "https://github.com/roshpinacare-sys/sanbox.git";
const CLONE_TIMEOUT_MS = 60_000;

// אותו-מבנה-askpass כמו-ב-core/ops.ts: Username→x-access-token, אחרת הטוקן-מהסביבה
const ASKPASS_BODY =
  '#!/bin/sh\ncase "$1" in Username*) echo "x-access-token";; *) echo "$HQ_TOKEN";; esac';

let lastSpawnAt = 0;
let lastRestoreAt = 0;

const execFileP = promisify(execFile);

function portAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** remoteUrl מ-~/.sovereign/config.json — רק-https נקי; אחרת ברירת-המחדל. */
function readRemoteUrl(): string {
  try {
    const raw = readFileSync(
      path.join(os.homedir(), ".sovereign", "config.json"),
      "utf8"
    );
    const j = JSON.parse(raw) as Record<string, unknown>;
    const v = typeof j.remoteUrl === "string" ? j.remoteUrl.trim() : "";
    if (v.startsWith("https://")) return v;
  } catch {
    /* אין-קונפיג — ברירת-המחדל */
  }
  return REMOTE_DEFAULT;
}

/** פרסור-תוכן-env: `PAT=...` (או מפתח-דומה) קודם, אחר-כך שורה-גולמית. */
function parsePatText(raw: string): string | null {
  const stripQuotes = (s: string): string => s.replace(/^["']+|["']+$/g, "");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  const kvs: { k: string; v: string }[] = [];
  const raws: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq > 0)
      kvs.push({
        k: line.slice(0, eq).trim(),
        v: stripQuotes(line.slice(eq + 1).trim()),
      });
    else raws.push(stripQuotes(line));
  }
  const exact = kvs.find(
    (x) =>
      (x.k.toUpperCase() === "PAT" || x.k.toUpperCase() === "HQ_TOKEN") &&
      x.v.length > 0
  );
  if (exact) return exact.v;
  const anyKv = kvs.find((x) => x.v.length > 0);
  if (anyKv) return anyKv.v;
  return raws.find((s) => s.length > 0) ?? null;
}

/**
 * PAT לשחזור: קודם ~/.sovereign/remote.env; אם-אין — sanbox/secrets/pat.env
 * (רק-אם-התיקייה-קיימת). הערך-אף-פעם-לא-נרשם/מוחזר-החוצה.
 */
function readPatForRestore(): string | null {
  const candidates = [
    path.join(os.homedir(), ".sovereign", "remote.env"),
    path.join(SANDBOX_DIR, "secrets", "pat.env"),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const pat = parsePatText(readFileSync(p, "utf8"));
      if (pat) return pat;
    } catch {
      /* ממשיכים-למועמד-הבא */
    }
  }
  return null;
}

function isDirEmpty(p: string): boolean {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

/**
 * שחזור-sanbox-מהריפו-הפרטי — clone-בהיגיינה-מלאה.
 * מחזיר true רק-אם-הקוד-שוחזר בהצלחה. שקט-מוחלט: אפס-הדפסת-טוקן/פלט-git.
 */
async function restoreFromGit(): Promise<boolean> {
  const pat = readPatForRestore();
  if (!pat) return false; // שקט — השומר-העצמאי-יטפל
  const remoteUrl = readRemoteUrl();

  const askpass = path.join(
    os.tmpdir(),
    `.hq-restore-askpass-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`
  );
  try {
    writeFileSync(askpass, `${ASKPASS_BODY}\n`, { mode: 0o700 });
    chmodSync(askpass, 0o700);
  } catch {
    return false;
  }

  // הטוקן-רק-בסביבת-התהליך — לא-ב-argv, לא-ב-URL, לא-ב-.git/config
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpass,
    HQ_TOKEN: pat,
  };
  const gitOpts = {
    timeout: CLONE_TIMEOUT_MS,
    windowsHide: true,
    encoding: "utf8" as const,
    env: gitEnv,
  };

  try {
    if (!existsSync(SANDBOX_DIR) || isDirEmpty(SANDBOX_DIR)) {
      // התרחיש-המלא: התיקייה-נמחקה-כולה (או-ריקה) — שכפול-נקי
      await execFileP("git", ["clone", remoteUrl, SANDBOX_DIR], gitOpts);
      return true;
    }

    // תיקייה-קיימת-ולא-ריקה (למשל-רק secrets/ + db/ שרדו) — לא-מוחקים-כלום:
    // init + fetch + checkout כופה משחזר-רק-קבצים-נעקבים ומשאיר-את-הכספת-במקומה.
    try {
      await execFileP("git", ["-C", SANDBOX_DIR, "rev-parse", "--git-dir"], {
        ...gitOpts,
        timeout: 10_000,
      });
    } catch {
      await execFileP("git", ["init", SANDBOX_DIR], {
        ...gitOpts,
        timeout: 10_000,
      });
    }
    try {
      await execFileP(
        "git",
        ["-C", SANDBOX_DIR, "remote", "add", "origin", remoteUrl],
        { ...gitOpts, timeout: 10_000 }
      );
    } catch {
      await execFileP(
        "git",
        ["-C", SANDBOX_DIR, "remote", "set-url", "origin", remoteUrl],
        { ...gitOpts, timeout: 10_000 }
      );
    }
    await execFileP(
      "git",
      ["-C", SANDBOX_DIR, "fetch", "origin", "main"],
      gitOpts
    );
    await execFileP(
      "git",
      ["-C", SANDBOX_DIR, "checkout", "-f", "-B", "main", "FETCH_HEAD"],
      gitOpts
    );
    return true;
  } catch {
    // שקט — אין-רשת/PAT-נדחה; ננסה-שוב-אחרי-ה-debounce
    return false;
  } finally {
    try {
      rmSync(askpass, { force: true });
    } catch {
      /* מחיקה-מיטבית */
    }
  }
}

export async function ensureHQ(): Promise<boolean> {
  if (await portAlive(HQ_PORT)) return true;

  // שחזור-מגיט: פורט-מת + server.ts-חסר → לשחזר-מהריפו-לפני-ההקמה
  if (!existsSync(path.join(SANDBOX_DIR, "server.ts"))) {
    const nowR = Date.now();
    if (nowR - lastRestoreAt < RESTORE_DEBOUNCE_MS) return false;
    lastRestoreAt = nowR;
    const restored = await restoreFromGit();
    if (!restored) return false; // אין-PAT/אין-רשת — שקט
  }

  const now = Date.now();
  if (now - lastSpawnAt < SPAWN_DEBOUNCE_MS) return false;
  lastSpawnAt = now;

  try {
    const child = spawn("bun", ["server.ts"], {
      cwd: SANDBOX_DIR,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // המתנה-קצרה-לאימות-עלייה
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (await portAlive(HQ_PORT)) return true;
    }
  } catch {
    // שקט — הפרוקסי-ידווח 'לא זמין' בלי-חשיפה
  }
  return false;
}
