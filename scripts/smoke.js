// End-to-end smoke test: runs one full research session against a running server.
// Usage: node scripts/smoke.js [baseUrl]
const base = process.argv[2] || 'http://localhost:3000';
const t0 = Date.now();
const stamp = () => `[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`;

const res = await fetch(base + '/api/research', { method: 'POST' });
if (!res.ok) { console.error('HTTP', res.status, await res.text()); process.exit(1); }
const dec = new TextDecoder();
let buf = '';
let result = null;
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
    buf = buf.slice(i + 2);
    if (!line) continue;
    const ev = JSON.parse(line.slice(6));
    if (ev.type === 'stage') console.log(stamp(), `stage ${ev.index + 1} ${ev.status}`, ev.detail ? '\n        ' + ev.detail : '');
    else if (ev.type === 'note') console.log(stamp(), '   …', ev.text);
    else if (ev.type === 'queued') console.log(stamp(), 'queued #' + ev.position);
    else if (ev.type === 'error') { console.error(stamp(), 'ERROR:', ev.message); process.exit(2); }
    else if (ev.type === 'result') result = ev.data;
  }
}
if (!result) { console.error('Stream ended without a result'); process.exit(3); }
console.log('\n================ RESULT ================');
console.log(JSON.stringify(result, null, 2));
const bad = result.sources.filter((s) => !/^https:\/\//.test(s.url));
console.log(`\nChecks: name=${!!result.name} loop=${result.loop.length} quality=${result.quality.total}>=${result.quality.pass} sources=${result.sources.length} nonHttpsSources=${bad.length}`);
process.exit(result.quality.total >= result.quality.pass && result.name && !bad.length ? 0 : 4);
