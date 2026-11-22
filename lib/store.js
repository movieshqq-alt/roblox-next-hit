// Tiny persistence layer: in-memory TTL cache + JSON-file generation history.
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_LIMIT = 300;

class TTLCache {
  #m = new Map();
  get(k) {
    const e = this.#m.get(k);
    if (!e) return undefined;
    if (Date.now() > e.exp) { this.#m.delete(k); return undefined; }
    return e.v;
  }
  set(k, v, ttlMs) {
    this.#m.set(k, { v, exp: Date.now() + ttlMs });
    if (this.#m.size > 2000) this.#m.delete(this.#m.keys().next().value);
  }
}
export const cache = new TTLCache();

let history = [];
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  if (!Array.isArray(history)) history = [];
} catch { history = []; }

export function getHistory() { return history; }

export function addHistory(entry) {
  history.push({ ...entry, at: new Date().toISOString() });
  if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify(history, null, 2));
    fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
  } catch (e) {
    console.warn('[history] could not persist:', e.message);
  }
}

const STOP = new Set('the a an and or of to in on for with your you their they is are be as at by from into it its that this game roblox players player each who while then them can more most than'.split(' '));
export function tokens(text) {
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
