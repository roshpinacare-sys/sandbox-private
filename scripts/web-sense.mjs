#!/usr/bin/env bun
/**
 * web-sense.mjs — T-62: מנוע-החישה-הריבונית (חיפוש-רשת + קריאת-דפים)
 * =====================================================================
 * מדגים-את-חבילת-התודעה ש-Head-Corner העניק (10/10/2026 · אטומה בכספת):
 *   search(query) — חיפוש-רשת-מדורג: Tavily-key1 → Tavily-key2 (אוטומט-ב-4xx)
 *                   LangSearch רשום-אך-לא-מאומת (401) — מדלג-עד-אימות
 *   read(url)     — קריאת-דף-ל-Markdown דרך Jina-reader
 *
 * CLI:
 *   bun scripts/web-sense.mjs search "שאילתה"
 *   bun scripts/web-sense.mjs read "https://example.com"
 *   bun scripts/web-sense.mjs status   (חיות-כל-הערוצים, ממוסך)
 *
 * דוקטרינה: אפס-טוקנים-בפלט · קבלות-VALID-בלבד ל-receipts/web-sense.jsonl
 * (tail-7) · fail-open-בין-ערוצים — אסור-שהחישה-תיפול בגלל-ערוץ-אחד.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const KEYS = join(ROOT, 'secrets/web-intelligence.keys');
const LOG = join(ROOT, 'receipts/web-sense.jsonl');
const TAIL = 7;

function loadKeys() {
  if (!existsSync(KEYS)) throw new Error('web-intelligence.keys-חסר');
  const out = {};
  for (const line of readFileSync(KEYS, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

function receipt(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  try {
    const prev = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n') : [];
    prev.push(line);
    writeFileSync(LOG, prev.slice(-TAIL).join('\n') + '\n');
  } catch {}
  console.log(line);
}

/* --- Tavily: חיפוש-מדורג-עם-גיבוי-מפתחות --- */
async function tavilySearch(query, keyName = 'tavily_api_key_1') {
  const keys = loadKeys();
  const key = keys[keyName];
  if (!key) throw new Error(`${keyName}-חסר`);
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: 5, search_depth: 'basic' }),
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function search(query) {
  const order = ['tavily_api_key_1', 'tavily_api_key_2'];
  for (const kn of order) {
    try {
      const { status, json } = await tavilySearch(query, kn);
      if (status === 200 && Array.isArray(json?.results)) {
        receipt({ op: 'search', ok: true, via: kn, results: json.results.length, query });
        for (const it of json.results) {
          console.log(`• ${it.title}\n  ${it.url}`);
        }
        return true;
      }
      receipt({ op: 'search', ok: false, via: kn, http: status, fallback: true });
    } catch (e) {
      receipt({ op: 'search', ok: false, via: kn, error: e instanceof Error ? e.message : String(e) });
    }
  }
  /* LangSearch: רשום-אך-לא-מאומת (401-ב-10/10) — ניסיון-שקט-עם-דגל */
  try {
    const keys = loadKeys();
    const ls = keys.langsearch_api_key;
    const r = await fetch('https://api.langsearch.com/v1/web-search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ls}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, count: 5 }),
      signal: AbortSignal.timeout(15000),
    });
    const ok = r.status === 200;
    receipt({ op: 'search', ok, via: 'langsearch', http: r.status, note: ok ? 'מאומת-עתה!' : 'עדיין-לא-מאומת' });
    if (ok) {
      const j = await r.json();
      for (const it of j?.data?.webPages?.value ?? []) console.log(`• ${it.name}\n  ${it.url}`);
      return true;
    }
  } catch {}
  return false;
}

/* --- Jina-reader: קריאת-דף-ל-Markdown --- */
async function read(url) {
  const keys = loadKeys();
  const key = keys.jina_api_key;
  if (!key) throw new Error('jina_api_key-חסר');
  const r = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'text/plain' },
    signal: AbortSignal.timeout(30000),
  });
  const ok = r.status === 200;
  const text = ok ? await r.text() : '';
  receipt({ op: 'read', ok, http: r.status, url, bytes: text.length });
  if (ok) {
    console.log(text.slice(0, 2000));
    if (text.length > 2000) console.log(`\n… (${text.length} בייטים-סה"כ)`);
  }
  return ok;
}

/* --- status: חיות-כל-הערוצים (ממוסך) --- */
async function status() {
  const keys = loadKeys();
  const out = {};
  for (const kn of ['tavily_api_key_1', 'tavily_api_key_2']) {
    try {
      const { status } = await tavilySearch('ping', kn);
      out[kn] = status === 200 ? 'alive' : `http-${status}`;
    } catch { out[kn] = 'error'; }
  }
  try {
    const r = await fetch('https://api.langsearch.com/v1/web-search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.langsearch_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'ping', count: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    out.langsearch = r.status === 200 ? 'alive' : `http-${r.status}`;
  } catch { out.langsearch = 'error'; }
  try {
    const r = await fetch('https://r.jina.ai/https://example.com', {
      headers: { Authorization: `Bearer ${keys.jina_api_key}` },
      signal: AbortSignal.timeout(20000),
    });
    out.jina_reader = r.status === 200 ? 'alive' : `http-${r.status}`;
  } catch { out.jina_reader = 'error'; }
  receipt({ op: 'status', ok: Object.values(out).some((v) => v === 'alive'), channels: out });
}

const [, , cmd, ...rest] = process.argv;
const arg = rest.join(' ').trim();
if (!cmd || !arg) {
  console.log('שימוש: bun scripts/web-sense.mjs search "שאילתה" | read "URL" | status');
  process.exit(1);
}
try {
  const ok = cmd === 'status' ? await status() : cmd === 'search' ? await search(arg) : cmd === 'read' ? await read(arg) : false;
  process.exitCode = ok || cmd === 'status' ? 0 : 1;
} catch (e) {
  receipt({ op: cmd, ok: false, error: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
}
