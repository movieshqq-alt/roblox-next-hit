// Real, free, keyless research sources:
//  - Roblox Explore API (the actual Home/Charts sorts with live player counts)
//  - Roblox Games API (creation date, visits, descriptions, genres)
//  - Roblox Omni Search (find existing games with a given mechanic)
//  - Official Roblox Creator Docs (served as Markdown)
//  - Web search via DuckDuckGo HTML, falling back to Bing RSS
import { cache } from './store.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function http(url, { timeout = 20000, json = false, ...opts } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*', ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return json ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export const gameUrl = (placeId) => `https://www.roblox.com/games/${placeId}`;

/* ---------------- Roblox Explore (front page / charts) ---------------- */
export async function getFrontPage({ pages = 3 } = {}) {
  const sessionId = crypto.randomUUID();
  const sorts = [];
  let token = '';
  for (let p = 0; p < pages; p++) {
    const url = `https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${sessionId}&device=computer&country=all` + (token ? `&sortsPageToken=${encodeURIComponent(token)}` : '');
    let data;
    try { data = await http(url, { json: true }); } catch (e) { if (p === 0) throw e; break; }
    for (const s of data.sorts || []) {
      if (!Array.isArray(s.games) || !s.games.length) continue;
      sorts.push({
        id: s.sortId,
        name: s.sortDisplayName || s.sortId,
        games: s.games.map((g) => ({
          universeId: g.universeId,
          placeId: g.rootPlaceId,
          name: g.name,
          players: g.playerCount ?? 0,
          up: g.totalUpVotes ?? 0,
          down: g.totalDownVotes ?? 0,
          genre: g.genreL1 || g.genre || '',
          sponsored: !!g.isSponsored,
        })),
      });
    }
    token = data.nextSortsPageToken;
    if (!token) break;
  }
  if (!sorts.length) throw new Error('Roblox Explore API returned no sorts');
  return { sorts, fetchedAt: new Date().toISOString() };
}

/* ---------------- Roblox Games API ---------------- */
export async function getGameDetails(universeIds) {
  const out = new Map();
  for (let i = 0; i < universeIds.length; i += 50) {
    const chunk = universeIds.slice(i, i + 50);
    try {
      const data = await http(`https://games.roblox.com/v1/games?universeIds=${chunk.join(',')}`, { json: true });
      for (const g of data.data || []) {
        out.set(g.id, {
          description: (g.description || '').replace(/\s+/g, ' ').slice(0, 420),
          created: g.created,
          updated: g.updated,
          visits: g.visits,
          maxPlayers: g.maxPlayers,
          genre: g.genre_l1 || g.genre || '',
          subgenre: g.genre_l2 || '',
          favorites: g.favoritedCount,
        });
      }
    } catch { /* partial data is fine; we never invent missing fields */ }
  }
  return out;
}

/* ---------------- Roblox search (existing-mechanic check) ---------------- */
export async function searchRobloxGames(query, limit = 6) {
  const key = 'rsearch:' + query.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const url = `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${crypto.randomUUID()}&pageType=all`;
  const data = await http(url, { json: true });
  const games = [];
  for (const group of data.searchResults || []) {
    for (const c of group.contents || []) {
      if (c.contentType !== 'Game' || !c.rootPlaceId) continue;
      games.push({ name: c.name, players: c.playerCount ?? 0, up: c.totalUpVotes ?? 0, down: c.totalDownVotes ?? 0, placeId: c.rootPlaceId, url: gameUrl(c.rootPlaceId) });
    }
  }
  const result = games.slice(0, limit);
  cache.set(key, result, 30 * 60e3);
  return result;
}

/* ---------------- Official Roblox documentation ---------------- */
export const DOCS = [
  { path: 'discovery', title: 'Roblox Creator Docs — Discovery' },
  { path: 'production/recommendation', title: 'Roblox Creator Docs — Recommendation systems' },
  { path: 'discovery-faq', title: 'Roblox Creator Docs — Discovery FAQ' },
  { path: 'production/analytics/retention', title: 'Roblox Creator Docs — Retention analytics' },
  { path: 'production/analytics/engagement', title: 'Roblox Creator Docs — Engagement analytics' },
];

export async function getDoc(path) {
  const key = 'doc:' + path;
  const hit = cache.get(key);
  if (hit) return hit;
  const md = await http(`https://create.roblox.com/docs/en-us/${path}.md`, { timeout: 25000 });
  const doc = { path, url: `https://create.roblox.com/docs/${path}`, markdown: md, fetchedAt: new Date().toISOString() };
  cache.set(key, doc, 6 * 3600e3); // docs change rarely; refreshed every 6h
  return doc;
}

/* ---------------- Web search ---------------- */
const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function ddg(query) {
  const html = await http(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeout: 15000 });
  const results = [];
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, '&');
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (/duckduckgo\.com\/y\.js|ad_domain/.test(url)) continue; // skip ads
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title: decode(a[2]), url, snippet: sn ? decode(sn[1]) : '' });
  }
  return results;
}

async function bing(query) {
  const xml = await http(`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`, { timeout: 15000 });
  return [...xml.matchAll(/<item><title>([\s\S]*?)<\/title><link>([\s\S]*?)<\/link><description>([\s\S]*?)<\/description>/g)]
    .map((m) => ({ title: decode(m[1]), url: decode(m[2]), snippet: decode(m[3]) }));
}

export async function webSearch(query, limit = 6) {
  const key = 'web:' + query.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  let results = [];
  let provider = 'duckduckgo';
  try { results = await ddg(query); } catch { /* fall through */ }
  if (!results.length) {
    provider = 'bing';
    try { results = await bing(query); } catch { results = []; }
  }
  // Keep only results that are actually about Roblox (fallback engines can return generic junk).
  const relevant = (r) => /^https?:\/\//.test(r.url) && /roblox|rblx|devforum/i.test(`${r.title} ${r.url} ${r.snippet}`);
  const out = { provider, results: results.filter(relevant).slice(0, limit) };
  cache.set(key, out, 60 * 60e3);
  return out;
}
