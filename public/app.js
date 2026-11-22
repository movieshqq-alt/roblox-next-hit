// All server/AI/web text is inserted with textContent — never innerHTML.
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v ?? '';
    else if (k === 'style') n.style.cssText = v; // CSSOM is CSP-safe; style attributes are not
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : null);

let busy = false;
let timer = null;
let lastResult = null;

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function startTimer() {
  const t0 = Date.now();
  clearInterval(timer);
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function renderStages(stages) {
  const ol = $('stages');
  ol.replaceChildren(...stages.map((name, i) =>
    el('li', { class: 'stage', id: 'stage-' + i },
      el('span', { class: 'dot' }),
      el('div', { class: 'title' }, el('span', { class: 'n', text: String(i + 1).padStart(2, '0') }), name + '…'))));
}

function onEvent(ev) {
  if (ev.type === 'init') renderStages(ev.stages);
  else if (ev.type === 'queued') {
    const q = $('queue-note');
    q.hidden = false;
    q.textContent = `Others are researching right now — you're #${ev.position} in line. Your run starts automatically.`;
  } else if (ev.type === 'stage') {
    $('queue-note').hidden = true;
    const li = $('stage-' + ev.index);
    if (!li) return;
    li.querySelectorAll('.note, .detail').forEach((n) => n.remove());
    li.classList.remove('active', 'done');
    if (ev.status === 'active') {
      // A later round re-opens stages 5–7: clear their previous ticks.
      document.querySelectorAll('.stage').forEach((s, i) => { if (i > ev.index) { s.classList.remove('done', 'active'); s.querySelectorAll('.note, .detail').forEach((n) => n.remove()); } });
      li.classList.add('active');
      $('research-title').textContent = li.querySelector('.title').lastChild.textContent;
    } else {
      li.classList.add('done');
      if (ev.detail) li.append(el('div', { class: 'detail', text: ev.detail }));
    }
  } else if (ev.type === 'note') {
    const li = $('stage-' + ev.index);
    if (!li) return;
    li.querySelector('.note')?.remove();
    li.append(el('div', { class: 'note', text: ev.text }));
  } else if (ev.type === 'result') {
    lastResult = ev.data;
    renderResult(ev.data);
    show('result');
  } else if (ev.type === 'error') {
    fail(ev.message);
  }
}

function fail(msg) {
  $('error-msg').textContent = msg;
  show('error');
}

async function research(rethink) {
  if (busy) return;
  busy = true;
  $('stages').replaceChildren();
  $('research-title').textContent = 'Reading the Roblox market';
  $('queue-note').hidden = true;
  show('research');
  startTimer();
  let gotTerminal = false;
  try {
    const res = await fetch('/api/research', {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.isArray(rethink) ? { rethink } : {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      gotTerminal = true;
      return fail(body.error || `The server responded with ${res.status}.`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'result' || ev.type === 'error') gotTerminal = true;
        onEvent(ev);
      }
    }
    if (!gotTerminal) fail('The connection to the research engine was interrupted. Please try again.');
  } catch {
    if (!gotTerminal) fail('Could not reach the research engine. Check your connection and try again.');
  } finally {
    busy = false;
    clearInterval(timer);
  }
}

const WHY_LABELS = [
  ['addictiveness', 'Addictiveness'], ['retention', 'Retention'], ['replayability', 'Replayability'], ['viral', 'Viral potential'],
  ['multiplayer', 'Multiplayer'], ['discovery', 'Roblox Discovery'], ['originality', 'Originality'], ['monetization', 'Monetization'],
];
const KIND = { official: 'Official docs', live: 'Live data', game: 'Roblox game', web: 'Web' };

function renderResult(r) {
  const root = $('result');
  const tags = el('div', { class: 'tagrow' },
    el('span', { class: 'tag hot', text: r.belowBar ? 'Best idea found' : 'The next big Roblox game' }),
    r.belowBar ? el('span', { class: 'tag', text: `Below the ${r.quality.pass}-point bar · try Rethink` }) : null,
    r.rediscovery ? el('span', { class: 'tag', text: `Re-discovered · same mechanic as “${r.rediscovery}”` }) : null);

  const minutes = r.firstMinutes ? el('section', { class: 'block' }, el('h3', { text: 'A new player’s first minutes' }),
    el('div', { class: 'minutes' },
      el('div', {}, el('b', { text: '10 sec' }), r.firstMinutes.s10),
      el('div', {}, el('b', { text: '60 sec' }), r.firstMinutes.s60),
      el('div', {}, el('b', { text: '5 min' }), r.firstMinutes.m5))) : null;

  const why = el('dl', { class: 'why' }, WHY_LABELS.filter(([k]) => r.why?.[k]).map(([k, label]) =>
    el('div', {}, el('dt', { text: label }), el('dd', { text: r.why[k] }))));

  const q = r.quality;
  const quality = el('section', { class: 'block' }, el('h3', { text: 'Quality score' }),
    el('div', { class: 'scorehead' }, el('span', { class: 'big' }, String(q.total), el('small', { text: ' / 100' })),
      el('span', { class: 'muted', text: (r.belowBar
        ? `Did not reach the ${q.pass}-point bar — the strongest concept this run found. `
        : `Passed the ${q.pass}-point bar and a devil’s-advocate review. `) + 'An internal design-quality score, not a prediction of success.' })),
    el('div', { class: 'bar' }, el('i', { style: `width:${q.total}%` })),
    el('details', {}, el('summary', { text: 'Score breakdown' }),
      el('div', { class: 'inner' }, el('div', { class: 'breakdown' }, q.breakdown.map((b) =>
        el('div', {}, el('span', { text: `${b.label} (weight ${b.weight})` }), el('span', { class: 'muted', text: `${b.score}/10` })))))));

  const top5 = r.top5?.length ? el('section', { class: 'block' }, el('h3', { text: `Top ${r.top5.length} ideas it considered` }),
    el('ol', { class: 'top5' }, r.top5.map((t) => el('li', { class: t.rank === 1 ? 'first' : '' },
      el('details', {},
        el('summary', {},
          el('span', { class: 'rk', text: String(t.rank) }),
          el('span', { class: 'tt', text: t.title }),
          el('span', { class: 'sc' + (t.total >= r.quality.pass ? ' ok' : ''), text: `${t.total}` })),
        el('div', { class: 'inner' },
          el('p', { style: 'margin:0', text: t.oneSentence }),
          el('p', { class: 'muted', style: 'margin:0', text: 'Loop: ' + t.coreLoop }),
          el('p', { class: 'muted', style: 'margin:0', text: (t.passed ? '✓ ' : '✕ ') + t.verdict }))))))) : null;

  const c = r.confidence;
  const sources = el('ul', { class: 'sources' }, r.sources.filter((s) => safeUrl(s.url)).map((s) =>
    el('li', {}, el('span', { class: 'k', text: KIND[s.kind] || s.kind }), el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.title }))));
  const confidence = el('section', { class: 'block' }, el('h3', { text: 'Research confidence' }),
    el('div', { class: 'scorehead' }, el('span', { class: 'big', text: c.level }), el('span', { class: 'muted', text: `${c.score}/100 evidence score` })),
    el('div', { class: 'bar' }, el('i', { style: `width:${c.score}%` })),
    c.note ? el('p', { class: 'muted', text: c.note }) : null,
    sources);

  const deeper = el('details', {}, el('summary', { text: 'How the engine got here' }),
    el('div', { class: 'inner' },
      r.risk ? el('div', {}, el('h4', { text: 'Biggest risk' }), el('p', { style: 'margin:0', text: r.risk })) : null,
      r.validate?.length ? el('div', {}, el('h4', { text: 'How to validate it after launch' }),
        el('ul', {}, r.validate.map((v) => el('li', {}, el('b', { text: v.metric + ': ' }), `${v.healthy || ''} If weak: ${v.ifWeak || ''}`)))) : null,
      r.signals?.length ? el('div', {}, el('h4', { text: 'Officially documented Discovery signals used' }),
        el('ul', {}, r.signals.map((s) => el('li', {}, el('b', { text: s.name }), s.quote ? el('blockquote', { text: '“' + s.quote + '”' }) : null)))) : null,
      r.eliminated?.length ? el('div', {}, el('h4', { text: `Concepts eliminated (${r.eliminated.length})` }),
        el('ul', {}, r.eliminated.map((e) => el('li', {}, el('b', { text: e.title }), ' — ' + e.why)))) : null,
      el('p', { class: 'muted', style: 'margin:0', text: `Researched ${new Date(r.researchedAt).toLocaleString()}. Player counts are live snapshots from that moment.` })));

  root.replaceChildren(
    tags,
    el('h2', { text: r.name }),
    el('p', { class: 'concept', text: r.concept }),
    minutes,
    el('section', { class: 'block' }, el('h3', { text: 'Core gameplay loop' }), el('ol', { class: 'loop' }, r.loop.map((s) => el('li', { text: s })))),
    el('section', { class: 'block' }, el('h3', { text: 'Why it could become a hit' }), why),
    quality,
    top5,
    confidence,
    deeper,
  );
}

function copyText(r) {
  return [`${r.name}`, '', r.concept, '', 'Core loop:', ...r.loop.map((s, i) => `${i + 1}. ${s}`), '', ...WHY_LABELS.filter(([k]) => r.why?.[k]).map(([k, l]) => `${l}: ${r.why[k]}`), '', `Quality ${r.quality.total}/100 · Research confidence ${r.confidence.level}`, '', 'Sources:', ...r.sources.map((s) => `- ${s.title}: ${s.url}`)].join('\n');
}

$('go').addEventListener('click', () => research());
$('again').addEventListener('click', () => research());
$('retry').addEventListener('click', () => research());
$('rethink').addEventListener('click', () => research(lastResult?.top5?.map(({ title, oneSentence, coreLoop, total, weak, critique }) => ({ title, oneSentence, coreLoop, total, weak, critique }))));
$('copy').addEventListener('click', async () => {
  if (!lastResult) return;
  try { await navigator.clipboard.writeText(copyText(lastResult)); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Copy failed'; }
  setTimeout(() => { $('copy').textContent = 'Copy idea'; }, 1800);
});
