# Roblox Next Hit

One page. One button. Live Roblox market research → one rigorously filtered game idea. Free for visitors: no account, no API key, no subscription.

## What actually happens when someone clicks

Every stage is a real backend task. The progress screen streams what it actually found (Server-Sent Events).

| # | Stage | Real work |
|---|-------|-----------|
| 1 | Front page | Roblox **Explore API** (the sorts behind Home/Charts): Top Trending, Up-and-Coming, Top Playing Now, Fun with Friends, Top Revisited, genre sorts. Live concurrent player counts. Fetched fresh every run. |
| 2 | Successful experiences | Roblox **Games API** (creation date, visits, descriptions) for ~50 chart games; finds launches under 180 days old; web search for this month's breakout releases; AI breaks down core loops. |
| 3 | Discovery signals | Reads official **Roblox Creator Docs** (Discovery, Recommendation systems, Discovery FAQ, Retention, Engagement) as Markdown. The AI may only cite passage IDs, and the server drops any signal without a real passage. Signals that aren't documented are labelled as hypotheses. Also searches the DevForum. |
| 4 | Market opportunities | Measures genre saturation by live player share, compares it with the Fun-with-Friends and Top-Revisited sorts, and steers away from previous winners. Random "exploration lenses" each run stop it settling into the same directions. |
| 5 | Test mechanics | Generates 6 concepts, each from a different mechanic family, then **searches Roblox's catalogue** for each mechanic to find existing games and their live player counts. |
| 6 | Quality evaluation | **Game Quality Evaluation System**: scores out of 100 (core gameplay 20, first-time experience 15, retention 15, simplicity 10, market 10, Discovery 10, social 10, thumbnail 5, feasibility 5). The model gives 1–10 per category and the **server** works out the weighted total. Also checks the first 10 s, 60 s and 5 min, and runs the "remove all progression" test. |
| 7 | Elimination | Hard gates: total ≥ 85, core gameplay ≥ 8, passes the no-progression test, understood in 10 s, fun within 60 s, not repetitive by 10 min, no overused default genre, not a mechanic-level duplicate of a past concept. The top survivors then face a separate **devil's-advocate review** that has to answer *"would a brand-new player understand it, enjoy it and want to keep playing?"* If nothing passes, it researches again (up to 3 rounds), and later rounds **refine the top near-misses against their critiques**. |
| 8 | Presentation | Writes up the winner, plus the **top 5 ideas it considered**, ranked by score. Results are never empty. If nothing cleared 85, the best idea is shown and clearly labelled "Best idea found · below the 85-point bar". **Rethink** sends the top 5 back for a fresh research run that improves them. **Research confidence** is computed from evidence actually found (demand from comparable games, verified doc signals, web sources, room in the market, adversarial survival). It is not something the model gets to choose. |

History of past concepts (name, mechanic family, core loop) is stored in `data/history.json`. Each new candidate is compared on its **mechanic and loop text**, not just its name, both by token similarity and by the evaluator.

## Honesty rules built into the code
- Player counts only come from Roblox APIs and are labelled as snapshots from when they were read.
- Source links are collected by the server from what it actually fetched. The AI never writes URLs.
- Documented signals appear with their verbatim doc quote.
- The quality score is labelled as an internal design score, not a prediction of success.

## Run locally
Needs Node 20 or later. No dependencies.
```
node server.js        # http://localhost:3000
node scripts/smoke.js # full end-to-end research run against the local server
```

## AI providers (all free tiers, keys stay on the server)
Tried in order, with automatic failover:

| Env var | Provider | Default model | Notes |
|---|---|---|---|
| `GROQ_API_KEY` | Groq | `openai/gpt-oss-120b` | **Recommended.** Free key at console.groq.com, no card. Runs take ~1–2 min. |
| `CEREBRAS_API_KEY` | Cerebras | `gpt-oss-120b` | Free tier |
| `GEMINI_API_KEY` | Google AI Studio | `gemini-2.5-flash` | Free tier |
| `OPENROUTER_API_KEY` | OpenRouter | `openai/gpt-oss-120b:free` | Free models, daily cap |
| *(none)* | Pollinations anonymous | gpt-oss-20b | **Zero-key fallback.** Limited to 1 reply per 45 s per server IP, so a run takes ~6–10 min and only one runs at a time. Disable with `POLLINATIONS=off`. |

You can override models with `GROQ_MODEL`, `GEMINI_MODEL` and so on.

## Fair-use limits (so it stays free)
`PER_IP_PER_HOUR` (default 4), `DAILY_CAP` (150), `MAX_CONCURRENT` (2, or 1 in keyless mode), `MAX_QUEUE` (6), `MAX_ROUNDS` (3, or 2 in keyless mode). Extra visitors join a queue, and limits are explained to them in plain language. Official docs are cached for 6 h, web searches for 1 h and Roblox searches for 30 min. Front-page data is never cached.

## Deploy free
**Render:** push this folder to a GitHub repo → render.com → New → Blueprint → choose the repo (`render.yaml` is included) → paste a free `GROQ_API_KEY` → Deploy. Free instances sleep when idle, so the first visit takes about 30 s to wake. `data/history.json` lives on ephemeral disk and resets on redeploy. For permanent history, mount a disk and set `DATA_DIR`.

Any Node host works: Railway, Fly.io, Koyeb, or a VPS running `node server.js` behind a proxy (set `TRUST_PROXY=1`).

## Limitations, stated plainly
- Roblox's recommendation system is private. The engine uses only what Roblox documents publicly plus observable chart data. It cannot see private metrics such as play-through rate or D1 retention for other games.
- The Explore and Omni-Search endpoints are public but undocumented, and Roblox could change them.
- Web search scrapes DuckDuckGo's HTML endpoint, with Bing RSS as a fallback. Either can rate-limit cloud IPs, and if they do the engine carries on with Roblox's own data.
- Idea quality depends on the model. gpt-oss-120b (Groq/Cerebras) is noticeably better than the keyless 20b fallback.
