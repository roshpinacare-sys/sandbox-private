import net from "node:net";
import { spawn } from "node:child_process";

/**
 * הבטחת-חיים-עצמאית לשרת-HQ (sanbox, פורט 3010).
 * נקרא מפרוקסי-הסטטוס בכל בדיקה: אם-הפורט-מת — הקם-מחדש-detached
 * מעץ-ה-boot (next-server), כך-שהוא-שורד-את-ה-reaper-של-מעטפות-ad-hoc.
 * הבעלים-הורה: הכל-שתלוי-סנדבוקס-יבנה-ב-sanbox ויחיה-תמיד.
 */

const HQ_PORT = 3010;
const SPAWN_DEBOUNCE_MS = 30_000;

let lastSpawnAt = 0;

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

export async function ensureHQ(): Promise<boolean> {
  if (await portAlive(HQ_PORT)) return true;

  const now = Date.now();
  if (now - lastSpawnAt < SPAWN_DEBOUNCE_MS) return false;
  lastSpawnAt = now;

  try {
    const child = spawn("bun", ["server.ts"], {
      cwd: "/home/z/my-project/sanbox",
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
