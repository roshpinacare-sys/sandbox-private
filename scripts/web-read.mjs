#!/usr/bin/env bun
/**
 * web-read.mjs — קריאת-דף-רשת-ריבונית (Jina Reader) — T-63.
 *
 * מה-פותח: ערוץ-קריאת-דפים-עצמאי (markdown-נקי) — החצי-השני-של-המחקר-האוטונומי.
 * מקור-מפתח: env JINA_API_KEY → ~/.sovereign/web-keys.env → sanbox/secrets/web-keys.env.
 * ברזל: stdlib-בלבד · אפס-סודות-בפלט · כישלון-כן exit-1.
 *
 * שימוש:
 *   bun scripts/web-read.mjs "https://example.com" [maxChars]
 * פלט: markdown לstdout (הכלי-האמיתי-היחיד-שמדפיס-תוכן — תוכן-הדף-עצמו).
 *      שגיאה → JSON אחת {ok:false,error} לstderr + exit-1.
 */
import { readFileSync, existsSync } from 'node:fs';

function loadKey() {
  if (process.env.JINA_API_KEY) return process.env.JINA_API_KEY;
  for (const p of [`${process.env.HOME}/.sovereign/web-keys.env`, '/home/z/my-project/sanbox/secrets/web-keys.env']) {
    try {
      if (!existsSync(p)) continue;
      const m = readFileSync(p, 'utf8').match(/^JINA_API_KEY=(.+)$/m);
      if (m) return m[1].trim();
    } catch { /* הבא-בתור */ }
  }
  return '';
}

function sanitize(s) {
  return String(s ?? '').replace(/tvly-[A-Za-z0-9_-]+/g, 'tvly-<REDACTED>').replace(/jina_[A-Za-z0-9_-]+/g, 'jina_<REDACTED>');
}

const url = process.argv[2] ?? '';
const maxChars = Math.min(Number(process.argv[3] ?? 20_000) || 20_000, 200_000);
const die = (err) => { process.stderr.write(`${JSON.stringify({ ok: false, url, error: sanitize(err).slice(0, 200), ts: new Date().toISOString() })}\n`); process.exit(1); };

if (!/^https?:\/\//.test(url)) die('כתובת-לא-תקינה (חייבת http/https)');
const key = loadKey();
if (!key) die('אין-מפתח JINA_API_KEY (env/כספת)');

let res;
try {
  res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'text/plain' },
    signal: AbortSignal.timeout(40_000),
  });
} catch (e) { die(e?.message ?? e); }

if (!res.ok) die(`jina-http-${res.status}`);
const text = await res.text();
process.stdout.write(sanitize(text.slice(0, maxChars)) + (text.length > maxChars ? '\n…[truncated]' : '') + '\n');
