// Roblox Next Hit — zero-dependency Node server.
// POST /api/research streams real research progress as Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResearch, STAGES } from './lib/pipeline.js';
import { providerNames, keylessOnly } from './lib/llm.js';
import { getHistory } from './lib/store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);

// Fair-use limits that keep the free AI quotas alive for everyone.
const PER_IP_PER_HOUR = Number(process.env.PER_IP_PER_HOUR || 4);
const DAILY_CAP = Number(process.env.DAILY_CAP || 150);
// The keyless AI tier is rate-limited per server IP, so it can only serve one run at a time.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || (keylessOnly() ? 1 : 2));
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 6);
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || !!process.env.RENDER || !!process.env.FLY_APP_NAME;

const ipHits = new Map();
let day = new Date().toISOString().slice(0, 10);
let dayCount = 0;
let running = 0;
const queue = [];

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkLimits(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; }
  if (dayCount >= DAILY_CAP) return `The free daily research budget (${DAILY_CAP} runs) has been used up. It resets at 00:00 UTC.`;
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= PER_IP_PER_HOUR) {
    const mins = Math.ceil((3600e3 - (now - hits[0])) / 60e3);
    return `You've run ${PER_IP_PER_HOUR} research sessions this hour. To keep this free for everyone, please try again in ${mins} min.`;
  }
  if (running >= MAX_CONCURRENT && queue.length >= MAX_QUEUE) return 'The research engine is at capacity right now. Please try again in a few minutes.';
  hits.push(now);
  ipHits.set(ip, hits);
  dayCount++;
  return null;
}

function acquireSlot(onQueued) {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise((resolve) => { queue.push(resolve); onQueued(queue.length); });
}
function releaseSlot() {
  const next = queue.shift();
  if (next) next(); else running--;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; script-src 'self'",
};

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': /\.(html|js|css)$/.test(p) ? 'no-cache' : 'public, max-age=86400' }); // revalidate code so updates apply instantly
    res.end(buf);
  });
}

// Optional body: {"rethink":[{title,oneSentence,coreLoop,total,weak,critique}]} from a previous result.
function readBody(req, max = 20000) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => resolve(size > max ? '' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}
function parseRethink(raw) {
  try {
    const list = JSON.parse(raw || '{}').rethink;
    if (!Array.isArray(list)) return [];
    const s = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
    return list.slice(0, 5).filter((c) => c && c.title).map((c) => ({
      title: s(c.title, 80), oneSentence: s(c.oneSentence), coreLoop: s(c.coreLoop), total: Math.max(0, Math.min(100, Number(c.total) || 0)), weak: s(c.weak), critique: s(c.critique),
    }));
  } catch { return []; }
}

async function handleResearch(req, res) {
  const rethink = parseRethink(await readBody(req));
  const ip = clientIp(req);
  const limited = checkLimits(ip);
  if (limited) { res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: limited })); return; }

  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let closed = false;
  req.on('close', () => { closed = true; });
  const send = (obj) => { if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const keepAlive = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15000);

  send({ type: 'init', stages: STAGES });
  await acquireSlot((pos) => send({ type: 'queued', position: pos }));
  const t0 = Date.now();
  try {
    // Research continues even if the visitor disconnects; the result still enters history.
    const result = await runResearch(send, { rethink });
    send({ type: 'result', data: result, ms: Date.now() - t0 });
    console.log(`[research] ok "${result.name}" in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    console.error('[research] failed:', e.message, e.details || '');
    const msg = e.userFacing ? e.message : /AI providers/.test(e.message)
      ? 'The free AI capacity is busy right now. Please try again in a minute.'
      : `Research could not finish: ${e.message}`;
    send({ type: 'error', message: msg });
  } finally {
    releaseSlot();
    clearInterval(keepAlive);
    if (!closed) res.end();
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/research' && req.method === 'POST') return void handleResearch(req, res);
  if (url.pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify({ ok: true, aiProviders: providerNames().length, conceptsInHistory: getHistory().length, limits: { perIpPerHour: PER_IP_PER_HOUR, dailyCap: DAILY_CAP }, runsToday: dayCount, running, queued: queue.length }));
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405).end();
});
server.requestTimeout = 0; // research streams can legitimately run for several minutes
server.listen(PORT, () => {
  console.log(`Roblox Next Hit running on http://localhost:${PORT}`);
  console.log(`AI providers (in order): ${providerNames().join(' → ')}`);
});
