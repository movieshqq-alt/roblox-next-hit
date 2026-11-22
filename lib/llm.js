// Provider-agnostic LLM client. Every provider speaks the OpenAI chat-completions format.
// Keys live ONLY in server environment variables. Providers are tried in order; on rate
// limits / outages the next one is used. The last provider (Pollinations anonymous tier)
// needs no key at all, so the site keeps working with zero paid dependencies.

function buildProviders() {
  const p = [];
  const env = process.env;
  if (env.GROQ_API_KEY) p.push({ name: 'Groq', base: 'https://api.groq.com/openai/v1', key: env.GROQ_API_KEY, model: env.GROQ_MODEL || 'openai/gpt-oss-120b', json: true });
  if (env.CEREBRAS_API_KEY) p.push({ name: 'Cerebras', base: 'https://api.cerebras.ai/v1', key: env.CEREBRAS_API_KEY, model: env.CEREBRAS_MODEL || 'gpt-oss-120b', json: true });
  if (env.GEMINI_API_KEY) p.push({ name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || 'gemini-2.5-flash', json: true });
  if (env.OPENROUTER_API_KEY) p.push({ name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free', json: false });
  // Keyless anonymous tier: documented limit is 1 reply / 45 s per IP, so calls are serialized.
  if ((env.POLLINATIONS || 'on') !== 'off') p.push({ name: 'Pollinations (anonymous)', base: 'https://text.pollinations.ai', path: '/openai', key: null, model: 'openai', json: false, minGapMs: 46000, serial: true });
  return p;
}
const providers = buildProviders();
const cooldown = new Map(); // provider name -> timestamp until which it's skipped
const lastCall = new Map();
const locks = new Map(); // provider name -> promise chain (serializes rate-limited providers)

export function providerNames() { return providers.map((p) => `${p.name} (${p.model})`); }
/** True when the only AI available is the slow keyless tier. */
export const keylessOnly = () => providers.every((p) => !p.key);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// When a long list comes back partly malformed, keep every element object that parses on its own.
function salvageArray(text, key) {
  const at = text.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
  if (at === -1) return null;
  const items = [];
  let i = text.indexOf('[', at) + 1, depth = 0, start = -1, inStr = false, esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}') { if (--depth === 0 && start !== -1) { try { items.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip broken item */ } start = -1; } }
    else if (ch === ']' && depth === 0) break;
  }
  return items.length ? { [key]: items } : null;
}

function extractJson(text, arrayKey) {
  try { return strictJson(text); } catch (e) {
    const s = arrayKey && salvageArray(text, arrayKey);
    if (s) return s;
    throw e;
  }
}

function strictJson(text) {
  if (!text) throw new Error('empty response');
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in response');
  t = t.slice(start, end + 1);
  try { return JSON.parse(t); } catch {
    // light repair: trailing commas
    return JSON.parse(t.replace(/,\s*([}\]])/g, '$1'));
  }
}

function callProvider(p, messages, opts) {
  if (!p.serial) return rawCall(p, messages, opts);
  const prev = locks.get(p.name) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => rawCall(p, messages, opts));
  locks.set(p.name, run.catch(() => {}));
  return run;
}

async function rawCall(p, messages, { temperature, maxTokens, json }) {
  const gap = p.minGapMs ? p.minGapMs - (Date.now() - (lastCall.get(p.name) || 0)) : 0;
  if (gap > 0) await sleep(gap);
  lastCall.set(p.name, Date.now());
  const body = { model: p.model, messages, temperature, max_tokens: maxTokens };
  // Random seed: fresh sampling each call, and defeats response caches on identical prompts.
  if (!p.key) body.seed = Math.floor(Math.random() * 2 ** 31);
  if (json && p.json) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  try {
    const res = await fetch(p.base + (p.path || '/chat/completions'), {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}) },
      body: JSON.stringify(body),
    });
    if (res.status === 402 || res.status === 429 || res.status >= 500) {
      const text = await res.text().catch(() => '');
      if (res.status === 402 && !/FREE_LIMIT|limit/i.test(text)) throw new Error(`${p.name} HTTP 402: ${text.slice(0, 200)}`);
      const hinted = Number((text.match(/retry after (\d+)\s*s/i) || [])[1]) || 0;
      const ra = Number(res.headers.get('retry-after')) || hinted;
      if (p.minGapMs) lastCall.set(p.name, Date.now() - p.minGapMs + ra * 1000 + 1500);
      const err = new Error(`${p.name} HTTP ${res.status}`);
      err.retryable = true;
      err.retryAfter = ra;
      throw err;
    }
    if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) { const e = new Error(`${p.name} returned no content`); e.retryable = true; throw e; }
    return content;
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error(`${p.name} timed out`); t.retryable = true; throw t; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask for a JSON object. Tries each provider (with one retry each) and one JSON-repair pass.
 * Returns { data, provider }.
 */
export async function askJSON(system, user, { temperature = 0.5, maxTokens = 3500, label = 'llm', arrayKey } = {}) {
  if (!providers.length) throw new Error('No AI provider configured');
  const messages = [
    { role: 'system', content: system + '\n\nRespond with ONE valid JSON object only. No markdown, no commentary.' },
    { role: 'user', content: user },
  ];
  const errors = [];
  for (const p of providers) {
    if ((cooldown.get(p.name) || 0) > Date.now()) { errors.push(`${p.name}: cooling down`); continue; }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const text = await callProvider(p, messages, { temperature, maxTokens, json: true });
        try {
          return { data: extractJson(text, arrayKey), provider: p.name };
        } catch {
          const fix = await callProvider(p, [...messages, { role: 'assistant', content: text.slice(0, 9000) }, { role: 'user', content: 'That was not valid JSON (check for unescaped double quotes inside strings). Return the same content as ONE valid JSON object only.' }], { temperature: 0.1, maxTokens, json: true });
          return { data: extractJson(fix, arrayKey), provider: p.name };
        }
      } catch (e) {
        errors.push(`${p.name}: ${e.message}`);
        console.warn(`[${label}] ${p.name} attempt ${attempt + 1} failed: ${e.message}`);
        if (!e.retryable && !/JSON/.test(e.message)) break;
        if (e.retryable && attempt === 2 && providers.length > 1) cooldown.set(p.name, Date.now() + Math.max(60e3, (e.retryAfter || 0) * 1000));
        // Serialized providers already wait for their own gap; others back off briefly.
        if (!p.serial) await sleep(Math.min(20000, (e.retryAfter || 4) * 1000 * (attempt + 1)));
      }
    }
  }
  const err = new Error('All AI providers are busy or unavailable right now.');
  err.details = errors;
  throw err;
}
