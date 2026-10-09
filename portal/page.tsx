"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  GitBranch,
  KeyRound,
  LogOut,
  RefreshCw,
  ScanSearch,
  ServerCog,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/* ---------- טיפוסים ---------- */

type VaultItem = { name?: string; kind?: string; masked?: string };

type StatusData = {
  ok?: boolean;
  uptime?: number | string;
  ports?: Record<string, unknown>;
  git?: {
    branch?: string;
    trackedFiles?: number | string;
    lastCommit?: string;
  };
  vault?: VaultItem[];
  scanLast?: unknown;
  sessionExpiresAt?: string;
  error?: string;
};

type LogLevel = "info" | "ok" | "error";

type LogEntry = {
  id: string;
  time: string;
  level: LogLevel;
  text: string;
  hits?: string[];
};

type ScanHit = Record<string, unknown>;

/* ---------- עזרים ---------- */

const SCROLLBAR_STYLE =
  "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent";

const DASH = "—";

/* ---------- ערוץ-זהות-משני (תצוגת-iframe חוסמת עוגיות-שלישוניות) ---------- */

const TOKEN_KEY = "hq_session_token";

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(t: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* פרטיות-מלאה (חסימת-storage) — העוגייה-ממשיכה-לעבוד */
  }
}

function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* שקט */
  }
}

function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const t = readToken();
  if (t) h["x-hq-session"] = t;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

function portAlive(p: unknown): boolean {
  if (typeof p === "boolean") return p;
  if (typeof p === "number") return p > 0;
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    for (const key of ["alive", "up", "ok", "listening", "running", "healthy"]) {
      const v = o[key];
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v > 0;
    }
    const st = o["status"];
    if (typeof st === "string") return ["up", "alive", "ok", "on"].includes(st);
  }
  return false;
}

function fmtUptime(u: unknown): string {
  const n =
    typeof u === "number"
      ? u
      : typeof u === "string" && /^\d+(\.\d+)?$/.test(u)
        ? Number(u)
        : NaN;
  if (Number.isNaN(n)) return typeof u === "string" && u ? u : DASH;
  const s = Math.floor(n);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} ימים ${h} שע׳`;
  if (h > 0) return `${h} שע׳ ${m} דק׳`;
  if (m > 0) return `${m} דק׳`;
  return `${s} שנ׳`;
}

function fmtTime(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function short(s: unknown, n = 300): string {
  if (typeof s !== "string" || !s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function extractHits(d: Record<string, unknown>): ScanHit[] {
  for (const key of ["hits", "findings", "matches", "issues", "results"]) {
    const v = d[key];
    if (Array.isArray(v)) return v as ScanHit[];
  }
  return [];
}

function fmtHit(h: ScanHit): string {
  const loc =
    (typeof h.file === "string" && h.file) ||
    (typeof h.path === "string" && h.path) ||
    (typeof h.name === "string" && h.name) ||
    (typeof h.target === "string" && h.target) ||
    "?";
  const line =
    typeof h.line === "number"
      ? h.line
      : typeof h.lineNo === "number"
        ? h.lineNo
        : null;
  const masked =
    (typeof h.masked === "string" && h.masked) ||
    (typeof h.preview === "string" && h.preview) ||
    (typeof h.snippet === "string" && h.snippet) ||
    (typeof h.value === "string" && h.value) ||
    "";
  return `${loc}${line !== null ? `:${line}` : ""}${masked ? ` → ${masked}` : ""}`;
}

function fmtScanLast(v: unknown): string {
  if (v == null) return DASH;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof o.at === "string") parts.push(`בשעה ${fmtTime(o.at)}`);
    if (typeof o.when === "string") parts.push(`בשעה ${fmtTime(o.when)}`);
    if (typeof o.hits === "number") parts.push(o.hits === 0 ? "נקי" : `${o.hits} ממצאים`);
    if (typeof o.total === "number") parts.push(`${o.total} ממצאים`);
    if (o.clean === true) parts.push("נקי");
    if (typeof o.status === "string") parts.push(o.status);
    return parts.length ? parts.join(" · ") : DASH;
  }
  return DASH;
}

/* ---------- הדף ---------- */

export default function OwnerPortalPage() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [lockSeconds, setLockSeconds] = useState(0);

  const [status, setStatus] = useState<StatusData | null>(null);
  const [linkDown, setLinkDown] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<"secret-scan" | "push-github" | null>(null);

  const addLog = useCallback((level: LogLevel, text: string, hits?: string[]) => {
    setLogs((prev) =>
      [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          time: new Date().toLocaleTimeString("he-IL"),
          level,
          text,
          hits,
        },
        ...prev,
      ].slice(0, 60)
    );
  }, []);

  /* בדיקה שקטה עם הטעינה: cookie תקף → כניסה ישירה לדשבורד */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/sandbox/status", {
          cache: "no-store",
          signal: AbortSignal.timeout(12000),
          headers: authHeaders(),
        });
        if (!alive || !r.ok || r.status === 401) return;
        const d = (await r.json()) as StatusData | null;
        if (!alive || !d) return;
        setStatus(d);
        setLinkDown(false);
        setAuthed(true);
      } catch {
        /* sanbox כבוי — נשארים במסך הכניסה */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* סקירת-מצב אחת — משמשת גם את הטיימר וגם רענון-ידני ופעולות */
  const fetchStatusOnce = useCallback(async () => {
    try {
      const r = await fetch("/api/sandbox/status", {
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
        headers: authHeaders(),
      });
      if (r.status === 401) {
        setAuthed(false);
        setStatus(null);
        clearToken();
        setLoginError("פג תוקף החיבור — יש להתחבר מחדש");
        return;
      }
      if (r.ok) {
        const d = (await r.json().catch(() => null)) as StatusData | null;
        if (d) {
          setStatus(d);
          setLinkDown(false);
        }
      } else {
        setLinkDown(true);
      }
    } catch {
      setLinkDown(true);
    }
  }, []);

  /* אחרי-התחברות: מיד ואז כל 30 שניות, ניקוי ב-unmount */
  useEffect(() => {
    if (!authed) return;
    void fetchStatusOnce();
    const iv = setInterval(() => {
      void fetchStatusOnce();
    }, 30000);
    return () => clearInterval(iv);
  }, [authed, fetchStatusOnce]);

  /* ספירה לאחור של נעילת-הכניסה אחרי 429 */
  useEffect(() => {
    if (lockSeconds <= 0) return;
    const t = setInterval(() => {
      setLockSeconds((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [lockSeconds]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (loggingIn || lockSeconds > 0 || !password) return;
    setLoginError(null);
    setLoggingIn(true);
    try {
      const r = await fetch("/api/sandbox/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(12000),
      });
      if (r.status === 429) {
        setLockSeconds(60);
        setLoginError("יותר מדי ניסיונות כניסה — נסה בעוד כמה דקות");
        return;
      }
      const d = (await r.json().catch(() => null)) as
        | (Record<string, unknown> & { ok?: boolean; error?: string })
        | null;
      if (r.ok && d && d.ok === true) {
        // שמירת-טוקן לערוץ-הזהות-המשני (עובד-גם-ב-iframe-שחוסם-עוגיות)
        if (typeof d.token === "string" && d.token) saveToken(d.token);
        setPassword("");
        setLoginError(null);
        setAuthed(true);
        return;
      }
      setLoginError(
        (d && typeof d.error === "string" && d.error) ||
          "סיסמה שגויה — נסה שוב"
      );
    } catch {
      setLoginError("לא ניתן להתחבר כרגע — בדוק שהשרת המקומי רץ");
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/sandbox/logout", { method: "POST", headers: authHeaders() });
    } catch {
      /* מתנתקים מקומית בכל-מקרה */
    }
    clearToken();
    setAuthed(false);
    setStatus(null);
    setLinkDown(false);
    setLogs([]);
    setPassword("");
    setLoginError("התנתקת — להתחברות חוזרת הזן סיסמה");
  }

  async function runAction(action: "secret-scan" | "push-github") {
    if (busy) return;
    setBusy(action);
    try {
      const r = await fetch("/api/sandbox/action", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(12000),
      });
      if (r.status === 401) {
        setAuthed(false);
        setStatus(null);
        clearToken();
        setLoginError("פג תוקף החיבור — יש להתחבר מחדש");
        return;
      }
      const d = (await r.json().catch(() => null)) as
        | (Record<string, unknown> & { ok?: boolean; error?: string })
        | null;
      if (!d) {
        addLog("error", "תשובה לא תקינה מהפרוקסי");
        return;
      }
      if (d.ok === false) {
        addLog(
          "error",
          action === "secret-scan"
            ? `הסריקה נכשלה${typeof d.error === "string" ? `: ${d.error}` : ""}`
            : `הדחיפה נכשלה${typeof d.error === "string" ? `: ${d.error}` : ""}`
        );
        return;
      }
      if (action === "secret-scan") {
        const hits = extractHits(d);
        const count =
          typeof d.total === "number"
            ? d.total
            : typeof d.count === "number"
              ? d.count
              : hits.length;
        if (count > 0 || d.clean === false) {
          addLog(
            "error",
            `הסריקה מצאה ${count} ממצאים חשודים — נדרש טיפול לפני דחיפה`,
            hits.map(fmtHit)
          );
        } else {
          addLog("ok", "הסריקה נקייה — לא נמצאו סודות חשופים בקבצים הנעקבים");
        }
      } else {
        const out = short(d.output ?? d.message ?? d.detail);
        addLog(
          "ok",
          out ? `הדחיפה לגיט הושלמה בהצלחה — ${out}` : "הדחיפה לגיט הושלמה בהצלחה"
        );
      }
    } catch {
      addLog("error", "הפעולה נכשלה — השרת לא השיב בזמן");
    } finally {
      setBusy(null);
      void fetchStatusOnce();
    }
  }

  const ports = status?.ports ?? {};
  const p3000 = portAlive(ports.p3000);
  const p3010 = portAlive(ports.p3010);
  const hqOk = status?.ok === true;
  const allGood = hqOk && !linkDown && p3000 && p3010;
  const hqDownMessage =
    status?.error ?? "שרת-HQ לא זמין כרגע — הפעל את sanbox/server.ts";

  const vault = Array.isArray(status?.vault) ? (status?.vault as VaultItem[]) : [];
  const git = status?.git ?? {};

  return (
    <div
      dir="rtl"
      className="dark flex min-h-screen flex-col bg-background text-foreground [background-image:radial-gradient(ellipse_at_top,rgba(255,255,255,0.04),transparent_55%)]"
    >
      {/* פס-עליון: כותרת + אינדיקטור-חיות כללי */}
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-emerald-500" aria-hidden="true" />
            <h1 className="text-lg font-semibold tracking-tight">
              Head Corner — השרת המפעיל
            </h1>
          </div>
          {authed && (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-2 text-sm">
                <span
                  className={`inline-block size-2.5 rounded-full ${
                    allGood
                      ? "animate-pulse bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]"
                      : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]"
                  }`}
                  aria-hidden="true"
                />
                <span className={allGood ? "text-emerald-500" : "text-red-500"}>
                  {allGood ? "כל המערכות תקינות" : "תקלה"}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRefreshing(true);
                  void fetchStatusOnce().finally(() => setRefreshing(false));
                }}
                disabled={refreshing}
                aria-label="רענון מצב"
              >
                <RefreshCw
                  className={`size-4 ${refreshing ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                רענן
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-8">
        {!authed ? (
          /* ---------- מסך-כניסה ---------- */
          <div className="flex flex-1 items-center justify-center">
            <Card className="w-full max-w-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="size-4 text-emerald-500" aria-hidden="true" />
                  כניסת בעלים
                </CardTitle>
                <CardDescription>
                  דלת אחת, סיסמה אחת — הכל שרת-מקומי, אפס חשיפה.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleLogin} className="flex flex-col gap-4">
                  <label className="flex flex-col gap-2 text-sm" htmlFor="hq-password">
                    סיסמת הבעלים
                    <Input
                      id="hq-password"
                      type="password"
                      autoComplete="current-password"
                      autoFocus
                      placeholder="••••••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loggingIn || lockSeconds > 0}
                      aria-invalid={!!loginError}
                    />
                  </label>

                  {loginError && (
                    <Alert variant="destructive">
                      <AlertTitle>הכניסה נחסמה</AlertTitle>
                      <AlertDescription>{loginError}</AlertDescription>
                    </Alert>
                  )}

                  <Button
                    type="submit"
                    disabled={loggingIn || lockSeconds > 0 || !password}
                  >
                    {loggingIn ? "מתחבר..." : "כניסה"}
                  </Button>

                  {lockSeconds > 0 && (
                    <p className="text-center text-xs text-amber-500">
                      הכניסה נעולה זמנית — נסה בעוד כמה דקות ({lockSeconds} שניות)
                    </p>
                  )}
                </form>
              </CardContent>
            </Card>
          </div>
        ) : (
          /* ---------- דשבורד ---------- */
          <div className="flex flex-col gap-6">
            {!allGood && (
              <Alert variant="destructive">
                <AlertTitle>בעיית קישוריות לשרת-HQ</AlertTitle>
                <AlertDescription>{hqDownMessage}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* כרטיס מצב-שרת */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ServerCog className="size-4 text-emerald-500" aria-hidden="true" />
                    מצב שרת
                  </CardTitle>
                  <CardDescription>לב-המערכת המקומי</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm">
                  <Row label="זמן פעילות" value={fmtUptime(status?.uptime)} />
                  <Row
                    label="פורט 3000 — אפליקציה"
                    value={<AliveBadge alive={p3000} />}
                  />
                  <Row
                    label="פורט 3010 — HQ"
                    value={<AliveBadge alive={p3010} />}
                  />
                  <Row label="סריקה אחרונה" value={fmtScanLast(status?.scanLast)} />
                  <Row
                    label="תוקף חיבור עד"
                    value={fmtTime(status?.sessionExpiresAt)}
                  />
                </CardContent>
              </Card>

              {/* כרטיס גיט */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <GitBranch className="size-4 text-emerald-500" aria-hidden="true" />
                    גיט
                  </CardTitle>
                  <CardDescription>מצב המאגר הנעקב</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm">
                  <Row
                    label="ענף"
                    value={
                      git.branch ? (
                        <Badge variant="default" dir="ltr">
                          {git.branch}
                        </Badge>
                      ) : (
                        DASH
                      )
                    }
                  />
                  <Row
                    label="קבצים במעקב"
                    value={
                      git.trackedFiles != null ? String(git.trackedFiles) : DASH
                    }
                  />
                  <Row
                    label="קומיט אחרון"
                    value={
                      git.lastCommit ? (
                        <span
                          dir="ltr"
                          className="block truncate font-mono text-xs text-muted-foreground"
                        >
                          {git.lastCommit}
                        </span>
                      ) : (
                        DASH
                      )
                    }
                  />
                </CardContent>
              </Card>

              {/* כרטיס כספת */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <KeyRound className="size-4 text-emerald-500" aria-hidden="true" />
                    כספת
                  </CardTitle>
                  <CardDescription>
                    שמות-בלבד חוצים — הערכים נשארים בכספת המקומית
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {vault.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      הכספת ריקה או שטרם נטענה.
                    </p>
                  ) : (
                    <ul
                      className={`max-h-96 space-y-2 overflow-y-auto pl-1 ${SCROLLBAR_STYLE}`}
                    >
                      {vault.map((item, i) => (
                        <li
                          key={item.name ?? String(i)}
                          className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2"
                        >
                          <div className="flex min-w-0 flex-col">
                            <span
                              dir="ltr"
                              className="truncate font-mono text-sm"
                            >
                              {item.name ?? "?"}
                            </span>
                            {item.masked ? (
                              <span
                                dir="ltr"
                                className="truncate font-mono text-xs text-muted-foreground"
                              >
                                {item.masked}
                              </span>
                            ) : null}
                          </div>
                          <Badge variant="secondary" className="shrink-0">
                            {item.kind ?? "secret"}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              {/* כרטיס פעולות */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Activity className="size-4 text-emerald-500" aria-hidden="true" />
                    פעולות
                  </CardTitle>
                  <CardDescription>
                    סריקת-סודות לפני כל דחיפה — אפס חשיפות
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => void runAction("secret-scan")}
                      disabled={busy !== null || !hqOk || linkDown}
                    >
                      <ScanSearch aria-hidden="true" />
                      {busy === "secret-scan" ? "מסריק..." : "סרוק סודות"}
                    </Button>
                    <Button
                      onClick={() => void runAction("push-github")}
                      disabled={busy !== null || !hqOk || linkDown}
                    >
                      <UploadCloud aria-hidden="true" />
                      {busy === "push-github" ? "מדחף..." : "דחוף לגיט"}
                    </Button>
                    <Button variant="outline" onClick={() => void handleLogout()}>
                      <LogOut aria-hidden="true" />
                      התנתקות
                    </Button>
                  </div>

                  <div
                    className={`max-h-48 overflow-y-auto rounded-lg border bg-background/40 p-3 ${SCROLLBAR_STYLE}`}
                    aria-live="polite"
                  >
                    {logs.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        לוג הפעולות יופיע כאן.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {logs.map((entry) => (
                          <li key={entry.id} className="text-sm">
                            <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                              {entry.time}
                            </span>{" "}
                            <span
                              className={
                                entry.level === "ok"
                                  ? "text-emerald-500"
                                  : entry.level === "error"
                                    ? "text-red-500"
                                    : "text-foreground/80"
                              }
                            >
                              {entry.text}
                            </span>
                            {entry.hits && entry.hits.length > 0 && (
                              <ul className="mt-1 flex flex-col gap-1 border-r-2 border-red-500/50 pr-2">
                                {entry.hits.slice(0, 12).map((h, i) => (
                                  <li
                                    key={i}
                                    dir="ltr"
                                    className="truncate font-mono text-xs text-red-400"
                                  >
                                    {h}
                                  </li>
                                ))}
                                {entry.hits.length > 12 && (
                                  <li className="text-xs text-muted-foreground">
                                    +{entry.hits.length - 12} ממצאים נוספים
                                  </li>
                                )}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/* ---------- רכיבים-קטנים ---------- */

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-left font-medium">{value}</span>
    </div>
  );
}

function AliveBadge({ alive }: { alive: boolean }) {
  return (
    <Badge
      variant={alive ? "default" : "destructive"}
      className={alive ? "bg-emerald-600 text-white" : undefined}
    >
      {alive ? "חי" : "מת"}
    </Badge>
  );
}
