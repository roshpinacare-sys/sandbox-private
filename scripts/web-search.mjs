#!/usr/bin/env bun
/**
 * web-search.mjs — חיפוש-רשת-ריבוני (Tavily) — T-63.
 *
 * מה-פותח: ערוץ-חיפוש-עצמאי-לאוטונומיה (לצד-ה-sdk) — חוסן-אנטי-תלות-ספק.
 * מקור-מפתח: env TAVILY_API_KEY → ~/.sovereign/web-keys.env → sanbox/secrets/web-keys.env.
 * ברזל: stdlib-בלבד · אפס-סודות-בפלט (המפתח-לעולם-לא-מודפס/נרשם) · כישלון-כן exit-1.
 *
 * שימוש:
 *   bun scripts/web-search.mjs "שאילתה" [max_results]
 * פלט: JSON אחת — {ok, query, results:[{title,url,content}], ts}
 */
import { readFileSync, existsSync } from 'node:fs';

function loadKey() {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  for (const p of [`${process.env.HOME}/.sovereign/web-keys.env`, '/home/z/my-project/sanbox/secrets/web-keys.env']) {
    try {
      if (!existsSync(p)) continue;
      const m = readFileSync(p, 'utf8').match(/^TAVILY_API_KEY=(.+)$/m);
      if (m) return m[1].trim();
    } catch { /* הבא-בתור */ }
  }
  return '';
}

function sanitize(s) {
  return String(s ?? '').replace(/tvly-[A-Za-z0-9_-]+/g, 'tvly-<REDACTED>').replace(/jina_[A-Za-z0-9_-]+/g, 'jina_<REDACTED>');
}

const query = process.argv[2] ?? '';
const maxResults = Math.min(Number(process.argv[3] ?? 5) || 5, 20);
const out = { ok: false, query, ts: new Date().toISOString() };

if (!query.trim()) {
  console.log(JSON.stringify({ ...out, error: 'אין-שאילתה (argv[2])' }));
  process.exit(1);
}
const key = loadKey();
if (!key) {
  console.log(JSON.stringify({ ...out, error: 'אין-מפתח TAVILY_API_KEY (env/כספת)' }));
  process.exit(1);
}

try {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    signal: AbortSignal.timeout(25_000),
  });
  out.http = res.status;
  if (!res.ok) {
    console.log(JSON.stringify({ ...out, error: `tavily-http-${res.status}` }));
    process.exit(1);
  }
  const j = await res.json();
  out.ok = true;
  out.results = (j.results ?? []).map((r) => ({
    title: sanitize(r.title),
    url: r.url,
    content: sanitize(String(r.content ?? '').slice(0, 300)),
  }));
} catch (e) {
  out.error = sanitize(String(e?.message ?? e)).slice(0, 200);
  console.log(JSON.stringify(out));
  process.exit(1);
}
console.log(JSON.stringify(out));
