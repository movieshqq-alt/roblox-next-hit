// The research engine. Eight real stages; each one emits what it actually found.
import { getFrontPage, getGameDetails, getDoc, DOCS, webSearch, gameUrl } from './sources.js';
import { askJSON } from './llm.js';
import { getHistory, cache } from './store.js';
import { selectAndPresent } from './quality.js';

export const STAGES = [
  'Studying the current Roblox front page',
  'Investigating successful Roblox experiences',
  'Analyzing current Discovery signals',
  'Identifying market opportunities',
  'Testing potential gameplay mechanics',
  'Evaluating addictiveness and retention',
  'Eliminating repetitive and weak concepts',
  'Selecting the strongest game idea',
];

// Random design "primitives" injected each run so exploration genuinely varies run to run.
const PRIMITIVES = [
  'physics & momentum', 'rhythm & timing', 'deduction & hidden information', 'asymmetric roles', 'spatial building under pressure',
  'communication-limited co-op', 'territory & area control', 'movement mastery', 'live trading & negotiation', 'stealth & perception',
  'emergent chain reactions', 'drawing or shape-making', 'sound & audio cues', 'gravity or perspective tricks', 'shrinking/growing scale',
  'procedural expeditions', 'voting & social prediction', 'herding / crowd control', 'cooking-style juggling of tasks', 'tag-style pursuit variants',
  'weather & environmental hazards', 'vehicles with unusual controls', 'time manipulation', 'creature taming via behavior (not loot)', 'sports with a twist',
  'puzzles solved by multiple bodies', 'destruction with purpose', 'bluffing & betrayal', 'navigation & mapping', 'ecosystem simulation',
];

const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
const ratio = (g) => (g.up + g.down ? Math.round((g.up / (g.up + g.down)) * 100) : null);
const daysSince = (iso) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 864e5) : null);

function stripMarkdown(md) {
  return md
    .replace(/^---[\s\S]*?---/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\|/g, ' . ');
}

const SIGNAL_RX = /retention|retain|return|playtime|play time|session|engag|co-?play|friends|play-?through|bounce|thumbnail|click|qualified|play days|monetiz|spend|recommend|ranking|retrieval|satisf|rating|first.?play|day 1|day 7|D1|D7|personali|notification|invite|repeat play/i;

export async function runResearch(emit, opts = {}) {
  const sources = new Map(); // url -> {id,title,url,kind}
  const addSource = (title, url, kind) => {
    if (!sources.has(url)) sources.set(url, { id: 'S' + (sources.size + 1), title, url, kind });
    return sources.get(url).id;
  };
  const stage = async (i, fn) => {
    emit({ type: 'stage', index: i, status: 'active' });
    const t0 = Date.now();
    const detail = await fn((text) => emit({ type: 'note', index: i, text }));
    emit({ type: 'stage', index: i, status: 'done', detail, ms: Date.now() - t0 });
  };
  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const history = getHistory();

  /* 1 ─ Front page */
  let fp, games;
  await stage(0, async (note) => {
    note('Requesting live Home/Charts sorts from the Roblox Explore API…');
    fp = await getFrontPage();
    games = new Map();
    for (const s of fp.sorts) {
      s.games.forEach((g, rank) => {
        const e = games.get(g.universeId) || { ...g, sorts: [] };
        e.sorts.push({ sort: s.name, rank: rank + 1 });
        games.set(g.universeId, e);
      });
    }
    addSource('Roblox Charts (live sorts read via the Roblox Explore API)', 'https://www.roblox.com/charts', 'live');
    const top = fp.sorts.find((s) => /playing/i.test(s.id))?.games[0];
    return `Read ${fp.sorts.length} live sorts (${fp.sorts.map((s) => s.name).join(', ')}) covering ${games.size} experiences.` + (top ? ` Most played right now: ${top.name} (${fmt(top.players)} concurrent).` : '');
  });

  /* 2 ─ Successful experiences */
  let loops, focus, newHits, marketWeb;
  await stage(1, async (note) => {
    const bySort = (rx, n) => (fp.sorts.find((s) => rx.test(s.id) || rx.test(s.name))?.games || []).filter((g) => !g.sponsored).slice(0, n);
    const pool = [
      ...bySort(/top-trending/, 14), ...bySort(/up-and-coming/, 14), ...bySort(/top-playing-now/, 10),
      ...bySort(/revisit/, 10), ...bySort(/friends/, 10),
    ];
    focus = [...new Map(pool.map((g) => [g.universeId, games.get(g.universeId)])).values()];
    note(`Pulling creation dates, visits and descriptions for ${focus.length} experiences…`);
    const details = await getGameDetails(focus.map((g) => g.universeId));
    for (const g of focus) Object.assign(g, details.get(g.universeId) || {}, { age: daysSince(details.get(g.universeId)?.created) });
    newHits = focus.filter((g) => g.age !== null && g.age <= 180).sort((a, b) => b.players - a.players).slice(0, 10);

    note('Searching the web for this month\'s breakout releases…');
    const searches = await Promise.all([
      webSearch(`new roblox games ${monthYear}`),
      webSearch(`fastest growing roblox games ${monthYear}`),
    ]);
    marketWeb = searches.flatMap((s) => s.results).filter((r, i, a) => a.findIndex((x) => x.url === r.url) === i).slice(0, 8);

    note('Breaking down the core loops of the strongest performers…');
    const lines = focus
      .sort((a, b) => b.players - a.players)
      .slice(0, 22)
      .map((g) => `- ${g.name} | ${g.genre || '?'} | ${fmt(g.players)} playing | ${ratio(g) ?? '?'}% like | ${g.age ?? '?'} days old | sorts: ${g.sorts.map((s) => s.sort).join(', ')} | "${(g.description || '').slice(0, 200)}"`)
      .join('\n');
    const web = marketWeb.map((r) => `- ${r.title}: ${r.snippet}`).join('\n');
    const { data } = await askJSON(
      'You are a senior Roblox game analyst. You only reason from the data given. When you infer a core loop from a title/description, keep it concrete and short. Never invent player numbers.',
      `Live Roblox chart data (${monthYear}):\n${lines}\n\nWeb snippets about current releases (may be noisy):\n${web || '(none)'}\n\nReturn JSON:\n{"games":[{"name":"exact name from data","coreLoop":"what players repeatedly DO, <=20 words","hook":"why the first minute grabs people, <=15 words","mechanicFamily":"2-4 word mechanic family"}],` +
        `"patterns":["5 cross-cutting patterns behind what is working right now, each <=25 words, citing game names"],"newReleaseLessons":["3 lessons from the newest (<180 days) successes, each <=25 words"]}\nCover the 14 most informative games.`,
      { temperature: 0.3, maxTokens: 6000, label: 'loops', arrayKey: 'games' },
    );
    loops = { games: (data.games || []).slice(0, 16), patterns: (data.patterns || []).slice(0, 6), lessons: (data.newReleaseLessons || []).slice(0, 4) };
    newHits.slice(0, 4).forEach((g) => addSource(`${g.name} — ${g.age} days old, ${fmt(g.players)} playing when researched`, gameUrl(g.placeId), 'game'));
    marketWeb.slice(0, 3).forEach((r) => addSource(r.title, r.url, 'web'));
    const nh = newHits[0];
    return `Profiled ${focus.length} chart games; ${newHits.length} launched in the last 6 months` + (nh ? ` (top: ${nh.name}, ${nh.age} days old, ${fmt(nh.players)} playing)` : '') + `. Mapped ${loops.games.length} core loops.`;
  });

  /* 3 ─ Discovery signals (official docs, verified quotes only) */
  let signals = [], docSentences = [], devforum = [];
  await stage(2, async (note) => {
    note('Reading the official Roblox Creator Documentation on Discovery, recommendations and analytics…');
    const docs = (await Promise.allSettled(DOCS.map((d) => getDoc(d.path)))).map((r, i) => (r.status === 'fulfilled' ? { ...r.value, title: DOCS[i].title } : null)).filter(Boolean);
    if (!docs.length) throw new Error('Could not reach the official Roblox documentation');
    for (const d of docs) {
      const sentences = stripMarkdown(d.markdown).split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, ' ').replace(/^[ .]+/, '').trim());
      for (const s of sentences) if (s.length > 50 && s.length < 380 && SIGNAL_RX.test(s)) docSentences.push({ id: 'D' + (docSentences.length + 1), text: s, doc: d });
    }
    docSentences = docSentences.filter((s, i, a) => a.findIndex((x) => x.text === s.text) === i).slice(0, 90);

    note('Checking the Developer Forum for recent Discovery changes…');
    devforum = (await webSearch('site:devforum.roblox.com discovery recommendation algorithm update')).results.slice(0, 4);

    const cacheKey = 'signals:' + docSentences.map((s) => s.text.length).join(',');
    let grouped = cache.get(cacheKey);
    if (!grouped) {
      note(`Extracting documented ranking signals from ${docSentences.length} relevant passages…`);
      const { data } = await askJSON(
        'You extract ONLY what official documentation states. Every signal MUST cite passage ids that literally support it. Do not add signals the passages do not state.',
        `Official Roblox documentation passages:\n${docSentences.map((s) => `${s.id}: ${s.text}`).join('\n')}\n\n` +
          'Return JSON {"signals":[{"name":"short signal name","meaning":"what Roblox says it measures/rewards, <=25 words","ids":["D#"]}],' +
          '"checklist":{"playThroughOrBounce":"D# ids or []","playtime":[],"playDaysOrReturning":[],"intentionalCoPlay":[],"thumbnailClickability":[],"monetization":[]}}\nGive 6-10 signals.',
        { temperature: 0.1, maxTokens: 4000, label: 'signals', arrayKey: 'signals' },
      );
      grouped = data;
      cache.set(cacheKey, grouped, 6 * 3600e3);
    }
    const valid = new Set(docSentences.map((s) => s.id));
    signals = (grouped.signals || [])
      .map((s) => ({ name: s.name, meaning: s.meaning, ids: (s.ids || []).filter((id) => valid.has(id)) }))
      .filter((s) => s.ids.length && s.name);
    for (const s of signals) for (const id of s.ids) { const d = docSentences.find((x) => x.id === id).doc; addSource(d.title, d.url, 'official'); }
    devforum.slice(0, 2).forEach((r) => addSource(r.title, r.url, 'web'));
    const missing = Object.entries(grouped.checklist || {}).filter(([, ids]) => !(Array.isArray(ids) && ids.some((id) => valid.has(id)))).map(([k]) => k);
    return `Read ${docs.length} official docs pages and verified ${signals.length} documented signals against the source text (${signals.slice(0, 5).map((s) => s.name).join(', ')}).` + (missing.length ? ` Not explicitly documented: ${missing.join(', ')} — treated as hypotheses.` : '');
  });

  /* 4 ─ Market opportunities */
  let market;
  await stage(3, async (note) => {
    note('Measuring genre saturation by live player share…');
    const totals = {};
    let all = 0;
    for (const g of games.values()) { const k = g.genre || 'Unlabelled'; totals[k] = (totals[k] || 0) + g.players; all += g.players; }
    const share = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${((v / all) * 100).toFixed(1)}% of front-page players`).slice(0, 12);
    const social = (fp.sorts.find((s) => /friends/i.test(s.id))?.games || []).slice(0, 12).map((g) => g.name);
    const revisited = (fp.sorts.find((s) => /revisit/i.test(s.id))?.games || []).slice(0, 12).map((g) => g.name);
    const seed = pick(PRIMITIVES, 6);
    note('Comparing what is crowded against what players keep coming back to…');
    const { data } = await askJSON(
      'You are a ruthless Roblox market strategist. Base saturation claims on the data. Opportunities must be gameplay-mechanic opportunities (not themes or skins) and must differ from each other.',
      `Genre share (live): \n${share.join('\n')}\n\nCore loops of chart games:\n${loops.games.map((g) => `- ${g.name}: ${g.coreLoop} [${g.mechanicFamily}]`).join('\n')}\n\nPatterns: ${loops.patterns.join(' | ')}\nNew-release lessons: ${loops.lessons.join(' | ')}\n` +
        `"Fun with Friends" sort: ${social.join(', ')}\n"Top Revisited" sort: ${revisited.join(', ')}\n\n` +
        `Previously chosen ideas (must NOT be repeated or reskinned): ${history.slice(-30).map((h) => `${h.name} [${h.mechanicFamily}]`).join('; ') || 'none'}\n` +
        `This run's exploration lenses (use at least 3 of them): ${seed.join(', ')}\n` +
        'Do not propose door games, supermarket/store sims, generic horror, steal-and-collect, basic incremental sims, generic tycoons or reskins of chart games.\n' +
        'Return JSON {"saturated":[{"family":"","evidence":"<=20 words using the data"}],"opportunities":[{"direction":"<=15 words","mechanicFamily":"","whyOpen":"<=25 words","demandEvidence":"real game names from the data that prove adjacent demand"}]} with 4 saturated and 6 opportunities.',
      { temperature: 0.8, maxTokens: 5000, label: 'market' },
    );
    market = { saturated: (data.saturated || []).slice(0, 5), opportunities: (data.opportunities || []).slice(0, 7), share, seed };
    return `Crowded: ${market.saturated.map((s) => s.family).join(', ')}. Open directions: ${market.opportunities.map((o) => o.mechanicFamily).join(', ')}.`;
  });

  /* 5–8 ─ Generate, test, score (Game Quality Evaluation System), challenge, present */
  return selectAndPresent({ stage, addSource, sources, market, history, loops, signals, docSentences, newHits, marketWeb, devforum, rethink: opts.rethink });
}

