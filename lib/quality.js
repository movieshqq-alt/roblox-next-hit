// Stages 5–8: generate → test against the live Roblox catalogue → score with the
// Game Quality Evaluation System → adversarial challenge → present ONE winner.
import { searchRobloxGames } from './sources.js';
import { askJSON, keylessOnly } from './llm.js';
import { addHistory, similarity } from './store.js';

export const PASS_SCORE = 85;
// Each extra round costs ~4 AI calls; the keyless tier allows one call per 45 s.
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || (keylessOnly() ? 2 : 3));

// §12 Mandatory Idea Scoring System (weights sum to 100). The model gives 1–10 per
// category; the server computes the weighted total so scores can't be "rounded up" in prose.
export const RUBRIC = {
  coreGameplay: { w: 20, label: 'Core gameplay addictiveness' },
  firstTimeExperience: { w: 15, label: 'First-time player experience' },
  retentionReplayability: { w: 15, label: 'Retention and replayability' },
  simplicity: { w: 10, label: 'Simplicity and instant understanding' },
  marketDifferentiation: { w: 10, label: 'Market demand and differentiation' },
  discovery: { w: 10, label: 'Roblox Discovery compatibility' },
  socialViral: { w: 10, label: 'Social and viral potential' },
  thumbnailTitle: { w: 5, label: 'Thumbnail and title potential' },
  feasibility: { w: 5, label: 'Development feasibility' },
};

const DEFAULT_TRAPS = /\b(door|doors|supermarket|grocery|store simulator|shop simulator|steal|stealing|brainrot|tycoon|incremental|clicker|idle|rebirth|obby|obbies|backrooms)\b/i;
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
const clamp = (n, lo = 1, hi = 10) => Math.max(lo, Math.min(hi, Math.round(Number(n)) || lo));

const DESIGN_PRINCIPLES = `Non-negotiable design principles:
- Understandable in 5-10 seconds without reading; explainable in one sentence; next action visually obvious; no menus/currencies needed to have fun.
- First 10s: already doing something interesting (no walking/reading/waiting). First 60s: core mechanic experienced + satisfying feedback. First 5 min: a discovery, a clear next objective, a reason to continue.
- The physical repeated action must be fun BEFORE any pets, rebirths, upgrades, currencies or unlocks. Theme is not gameplay.
- Progression supports gameplay (short/medium/long goals people actually care about), never grinding or number inflation.
- Sessions differ from each other; unexpected moments emerge without constant developer updates.
- Multiplayer must make the core mechanic better (funny interactions, rivalry, co-op, spectating, clip-worthy moments).
- One clear thumbnail image a child understands; the title communicates the concept; the game delivers exactly what the thumbnail promises.
- Recognizable concept + meaningful differentiator beats an unfamiliar invention. Must be launchable with a small, polished core.
- Monetization: optional cosmetics/expression/convenience only; never pay-to-win or a miserable free experience.`;

function historyDigest(history) {
  return history.slice(-40).map((h) => `${h.name} — mechanic: ${h.mechanicFamily}; loop: ${h.coreLoop}`).join('\n') || 'none';
}

export async function selectAndPresent(ctx) {
  const { stage, addSource, sources, market, history, loops, signals, docSentences, newHits, marketWeb, devforum } = ctx;
  const rejected = [];
  const feedback = [];
  const tried = [];
  let winner = null;
  let rediscovered = null;
  let bestSeen = null;
  // Top non-duplicate concepts that failed, with the critic's reasons. A "Rethink" request seeds
  // this with the previous run's top ideas so round 1 iterates on them.
  let nearMisses = (ctx.rethink || []).slice(0, 5);
  const allEvaluated = []; // every scored concept across all rounds (for the top-5 list)

  for (let round = 1; round <= MAX_ROUNDS && !winner; round++) {
    let candidates = [];

    /* 5 ─ Generate + test against existing Roblox games */
    await stage(4, async (note) => {
      note(round === 1 && nearMisses.length ? `Rethinking the previous top ${nearMisses.length} ideas and searching for stronger ones…` : round === 1 ? 'Drafting candidate concepts, one per mechanic family…' : `Round ${round}: nothing reached ${PASS_SCORE}/100 — researching new directions that avoid the last round's failures…`);
      const { data } = await askJSON(
        `You are an elite Roblox game designer. You design the CORE ACTION first. No franchise IP.\n${DESIGN_PRINCIPLES}`,
        `Market opportunities:\n${market.opportunities.map((o) => `- ${o.direction} [${o.mechanicFamily}] — ${o.whyOpen} (adjacent demand: ${o.demandEvidence})`).join('\n')}\n` +
          `Saturated (avoid): ${market.saturated.map((s) => s.family).join(', ')}\n` +
          'Banned defaults: door games, supermarket/store sims, generic horror, steal-and-collect, basic incremental/clicker sims, generic tycoons, obbies, reskins of chart games.\n' +
          `Previous concepts in the database (never reuse their MECHANICS, not just names):\n${historyDigest(history)}\n` +
          (tried.length ? `Already tried this run: ${tried.join(', ')}\n` : '') +
          (feedback.length ? `Why earlier candidates failed (fix these weaknesses): ${feedback.slice(-8).join(' | ')}\n` : '') +
          `Exploration lenses: ${market.seed.join(', ')}\n\n` +
          (nearMisses.length
            ? `ITERATE: these near-misses had promise. For EACH, create one improved version that directly fixes its critique — usually by SIMPLIFYING (fewer systems, a clearer first 10 seconds, a stronger single core action). Keep what scored well.\n${nearMisses.map((n) => `- ${n.title} (${n.total}/100): ${n.oneSentence} | Loop: ${n.coreLoop} | Weak scores: ${n.weak} | Critique: ${n.critique}`).join('\n')}\nThen fill the remaining slots with NEW concepts from different mechanic families.\n\n`
            : '') +
          'Create 6 candidates (each NEW one from a DIFFERENT mechanic family). Prefer simple. Return JSON {"candidates":[{"title":"","mechanicFamily":"","oneSentence":"the whole game in one sentence","first10s":"","first60s":"","first5min":"","coreLoop":"the physical repeated action cycle, <=35 words","sessionVariety":"","retentionHook":"why they return tomorrow AND why they care","withFriends":"","thumbnailMoment":"","monetization":"optional, non-pay-to-win","launchScope":"the minimum polished version",' +
          '"searchKeywords":["2-3 word Roblox search phrase for the core mechanic","another"]}]}',
        { temperature: 0.95, maxTokens: 8000, label: 'candidates', arrayKey: 'candidates' },
      );
      candidates = (data.candidates || []).filter((c) => c.title && c.coreLoop).slice(0, 7);
      if (!candidates.length) throw new Error('Concept generation returned nothing usable');
      tried.push(...candidates.map((c) => c.title));
      note(`Searching Roblox for existing games that already use these ${candidates.length} mechanics…`);
      for (const c of candidates) {
        const found = [];
        for (const kw of (c.searchKeywords || []).slice(0, 2)) {
          try { found.push(...(await searchRobloxGames(kw))); } catch { /* leave empty; never invent */ }
        }
        c.comparables = [...new Map(found.map((g) => [g.placeId, g])).values()].sort((a, b) => b.players - a.players).slice(0, 5);
        const mech = `${c.mechanicFamily} ${c.coreLoop} ${c.oneSentence}`;
        c.historyMatch = history.map((h) => ({ h, s: similarity(mech, `${h.mechanicFamily} ${h.coreLoop} ${h.oneLiner || ''}`) })).sort((a, b) => b.s - a.s)[0] || null;
        c.trap = DEFAULT_TRAPS.test(`${c.title} ${c.mechanicFamily} ${c.oneSentence}`);
      }
      const found = candidates.reduce((n, c) => n + c.comparables.length, 0);
      return `Drafted ${candidates.length} concepts across ${new Set(candidates.map((c) => String(c.mechanicFamily).toLowerCase())).size} mechanic families (${candidates.map((c) => c.title).join(', ')}); found ${found} existing Roblox games to test originality against.`;
    });

    /* 6 ─ Game Quality Evaluation System */
    let evaluated = [];
    await stage(5, async (note) => {
      note('Scoring every concept on the 100-point quality rubric: first 10 seconds, first minute, first 5 minutes, core loop, retention…');
      const block = candidates.map((c, i) => `#${i + 1} ${c.title} [${c.mechanicFamily}]\nOne sentence: ${c.oneSentence}\n10s: ${c.first10s}\n60s: ${c.first60s}\n5min: ${c.first5min}\nLoop: ${c.coreLoop}\nVariety: ${c.sessionVariety}\nReturn hook: ${c.retentionHook}\nFriends: ${c.withFriends}\nThumbnail: ${c.thumbnailMoment}\nScope: ${c.launchScope}\nExisting Roblox games found for this mechanic: ${c.comparables.map((g) => `${g.name} (${fmt(g.players)} playing)`).join('; ') || 'none found'}`).join('\n\n');
      const { data } = await askJSON(
        'You are a calibrated, skeptical Roblox playtest lead evaluating ideas for REAL first-time Roblox players (often kids on phones). Calibration: 10 = best-in-class on Roblox today, 8-9 = genuinely strong, 6-7 = average, 5 or less = weak. Do not inflate. Judge the raw core action with every reward system removed. Use the existing-game list to judge originality and demand honestly. A theme is not gameplay.\n' + DESIGN_PRINCIPLES,
        `${block}\n\nPrevious concepts already generated (flag semantic duplicates by MECHANIC):\n${historyDigest(history)}\n\n` +
          'For EACH concept return JSON {"evaluations":[{"index":1,"scores":{"coreGameplay":0,"firstTimeExperience":0,"retentionReplayability":0,"simplicity":0,"marketDifferentiation":0,"discovery":0,"socialViral":0,"thumbnailTitle":0,"feasibility":0},' +
          '"stripTest":{"pass":true,"why":"<=20 words: is the bare action fun with all rewards removed?"},"understoodIn10s":true,"funWithinFirstMinute":true,"repetitiveAfter10Min":false,' +
          '"retentionMechanism":"<=20 words, WHY they care to return","closestExisting":"name or none","differentiator":"<=18 words","duplicateOfPrevious":"previous concept name or empty",' +
          '"discoveryFit":{"clickability":0,"firstPlay":0,"playThrough":0,"retention":0,"playtime":0,"social":0,"longTerm":0},"biggestWeakness":"<=18 words"}]}\nScores are integers 1-10.',
        { temperature: 0.2, maxTokens: 9000, label: 'evaluate', arrayKey: 'evaluations' },
      );
      const evals = data.evaluations || [];
      evaluated = candidates.map((c, i) => {
        const e = evals.find((x) => Number(x.index) === i + 1) || evals[i];
        if (!e?.scores) return { ...c, missing: true };
        const scores = Object.fromEntries(Object.keys(RUBRIC).map((k) => [k, clamp(e.scores[k])]));
        const total = Math.round(Object.entries(RUBRIC).reduce((sum, [k, r]) => sum + (r.w * scores[k]) / 10, 0));
        return {
          ...c, scores, total, eval: e,
          strip: { pass: e.stripTest?.pass !== false, why: e.stripTest?.why || '' },
          disc: Object.fromEntries(Object.entries(e.discoveryFit || {}).map(([k, v]) => [k, clamp(v)])),
        };
      });
      const ok = evaluated.filter((c) => !c.missing).sort((a, b) => b.total - a.total);
      allEvaluated.push(...ok);
      if (ok[0] && (!bestSeen || ok[0].total > bestSeen.total)) bestSeen = ok[0];
      return `Scored ${ok.length} concepts out of 100: ${ok.map((c) => `${c.title} ${c.total}`).join(', ')}. Passing bar: ${PASS_SCORE}.`;
    });

    /* 7 ─ Eliminate weak + repetitive concepts, then adversarially challenge survivors */
    await stage(6, async (note) => {
      const pool = [];
      for (const c of evaluated) {
        const why = [];
        if (c.missing) why.push('could not be evaluated');
        else {
          if (!c.strip.pass || c.scores.coreGameplay < 8) why.push('core gameplay is not strong enough on its own');
          if (c.eval.understoodIn10s === false || c.scores.simplicity < 7) why.push('not instantly understandable');
          if (c.eval.funWithinFirstMinute === false || c.scores.firstTimeExperience < 7) why.push('takes too long to become fun');
          if (c.eval.repetitiveAfter10Min === true) why.push('becomes repetitive after 10 minutes');
          if (c.trap) why.push('falls back on an overused default genre');
          if (c.total < PASS_SCORE) why.push(`scored ${c.total}/100 (needs ${PASS_SCORE})`);
        }
        const dup = !c.missing && ((c.historyMatch && c.historyMatch.s >= 0.28) || (c.eval.duplicateOfPrevious || '').trim());
        if (why.length) { rejected.push({ title: c.title, why: why[0] }); feedback.push(`${c.title}: ${why.join('; ')}`); }
        else if (dup) {
          const prev = (c.eval.duplicateOfPrevious || '').trim() || c.historyMatch.h.name;
          rejected.push({ title: c.title, why: `same mechanic as previous concept "${prev}"` });
          feedback.push(`${c.title}: duplicate of ${prev}`);
          if (!rediscovered || c.total > rediscovered.total) rediscovered = { ...c, previous: prev };
        } else pool.push(c);
      }
      pool.sort((a, b) => b.total - a.total);

      // Remember the strongest original failures so the next round can iterate on them.
      nearMisses = evaluated
        .filter((c) => !c.missing && !c.trap && !pool.includes(c) && c.total >= 60)
        .sort((a, b) => b.total - a.total)
        .slice(0, 2)
        .map((c) => ({
          title: c.title, total: c.total, oneSentence: c.oneSentence, coreLoop: c.coreLoop,
          weak: Object.entries(c.scores).filter(([, v]) => v < 8).map(([k, v]) => `${RUBRIC[k].label} ${v}/10`).join(', ') || 'none',
          critique: [c.eval.biggestWeakness, c.strip.pass ? '' : c.strip.why].filter(Boolean).join('; '),
        }));

      // §L: the AI must challenge its own suggestions before presenting anything.
      for (const c of pool.slice(0, 2)) {
        note(`Devil's-advocate review of "${c.title}" (${c.total}/100): trying to break it…`);
        const { data } = await askJSON(
          'You are a hostile but fair reviewer whose job is to stop weak Roblox game ideas from shipping. Reject concepts instead of justifying them. Base claims on the evidence given.',
          `Concept: ${JSON.stringify({ title: c.title, oneSentence: c.oneSentence, first10s: c.first10s, first60s: c.first60s, first5min: c.first5min, coreLoop: c.coreLoop, retentionHook: c.retentionHook, withFriends: c.withFriends, launchScope: c.launchScope })}\n` +
            `Existing Roblox games with related mechanics: ${c.comparables.map((g) => `${g.name} (${fmt(g.players)} playing)`).join('; ') || 'none found'}\n\n` +
            'Return JSON {"strongestPart":"","biggestWeakness":"","originalityChallengers":"existing games that challenge it","newPlayerExperience":"what a brand-new player actually feels in minute one","achievable":true,"whyPlayersLeave":"","simplerVersionStronger":"describe a simpler version, or empty if current is already simplest",' +
            '"finalQuestion":{"immediatelyUnderstand":true,"enjoyDoingIt":true,"genuinelyWantToKeepPlaying":true,"evidenceBasedCase":"<=40 words"},"verdict":"present or reject","reason":"<=20 words"}',
          { temperature: 0.2, maxTokens: 4000, label: 'challenge' },
        );
        const fq = data.finalQuestion || {};
        const yes = fq.immediatelyUnderstand !== false && fq.enjoyDoingIt !== false && fq.genuinelyWantToKeepPlaying !== false && data.achievable !== false;
        if (yes && /present/i.test(data.verdict || '')) { winner = { ...c, challenge: data }; break; }
        const reason = data.reason || data.biggestWeakness || 'failed the adversarial review';
        rejected.push({ title: c.title, why: `failed devil's-advocate review: ${reason}` });
        feedback.push(`${c.title}: ${reason}`);
      }
      const summary = rejected.slice(-4).map((r) => `"${r.title}" (${r.why})`).join('; ');
      return winner
        ? `Kept "${winner.title}" (${winner.total}/100) after it survived the devil's-advocate review. Eliminated: ${summary || 'none'}.`
        : `No concept cleared every gate this round. Eliminated: ${summary}.`;
    });
  }

  // §13: if a previous concept is still the strongest, present it — clearly labelled.
  if (!winner && rediscovered && rediscovered.total >= PASS_SCORE) winner = { ...rediscovered, isRediscovery: true };
  // Never come back empty-handed: if nothing cleared the bar, present the best concept found,
  // clearly labelled as below the bar, alongside the full top-5 so the visitor can Rethink.
  let belowBar = false;
  if (!winner) {
    if (!bestSeen) throw new Error('The evaluator could not score any concept. Please try again.');
    winner = bestSeen;
    belowBar = true;
  }
  const rejectionOf = (title) => rejected.find((r) => r.title === title)?.why;
  const contenders = [...new Map(allEvaluated.sort((a, b) => b.total - a.total).map((c) => [c.title.toLowerCase(), c])).values()]
    .filter((c) => c !== winner)
    .slice(0, 4);
  const top5 = [winner, ...contenders].map((c, i) => ({
    rank: i + 1,
    title: c.title,
    oneSentence: c.oneSentence,
    coreLoop: c.coreLoop,
    total: c.total,
    passed: c === winner && !belowBar,
    verdict: c === winner && !belowBar ? 'Passed every gate' : rejectionOf(c.title) || `scored ${c.total}/100`,
    weak: Object.entries(c.scores).filter(([, v]) => v < 8).map(([k, v]) => `${RUBRIC[k].label} ${v}/10`).join(', ') || 'none',
    critique: [c.eval.biggestWeakness, c.strip.pass ? '' : c.strip.why].filter(Boolean).join('; '),
  }));

  /* 8 ─ Write up the single winner */
  let result;
  await stage(7, async (note) => {
    note(`Writing up "${winner.title}" against Roblox's documented Discovery signals…`);
    const { data } = await askJSON(
      'You write crisp, honest game pitches for Roblox developers. No hype words. Keep every field short. Distinguish what Roblox officially documents from your own hypotheses.',
      `Winning concept: ${JSON.stringify({ title: winner.title, mechanicFamily: winner.mechanicFamily, oneSentence: winner.oneSentence, first10s: winner.first10s, first60s: winner.first60s, first5min: winner.first5min, coreLoop: winner.coreLoop, sessionVariety: winner.sessionVariety, retentionHook: winner.retentionHook, withFriends: winner.withFriends, thumbnailMoment: winner.thumbnailMoment, monetization: winner.monetization })}\n` +
        (belowBar ? `IMPORTANT: this concept did NOT reach the ${PASS_SCORE}/100 quality bar; it is the best found. Be candid about that in confidenceNote and risk.\n` : '') +
        `Evaluation: ${winner.total}/100; retention mechanism: ${winner.eval.retentionMechanism}; closest existing: ${winner.eval.closestExisting} (differentiator: ${winner.eval.differentiator}); reviewer's strongest part: ${winner.challenge?.strongestPart || ''}; biggest weakness: ${winner.challenge?.biggestWeakness || winner.eval.biggestWeakness}.\n` +
        `Existing Roblox games with related mechanics: ${winner.comparables.map((g) => `${g.name} (${fmt(g.players)} playing)`).join('; ') || 'none found'}\n` +
        `Officially documented Discovery signals:\n${signals.map((s) => `- ${s.name}: ${s.meaning}`).join('\n')}\nMarket patterns: ${loops.patterns.join(' | ')}\n\n` +
        'Return JSON {"name":"memorable final title that communicates the concept","concept":"2-3 plain sentences: what the game is and what players actually do","loop":["3-5 short steps of the repeated loop"],' +
        '"firstMinutes":{"s10":"<=14 words","s60":"<=14 words","m5":"<=14 words"},' +
        '"why":{"addictiveness":"<=22 words","retention":"<=22 words, the real reason to care about returning","replayability":"","viral":"","multiplayer":"","discovery":"<=28 words, name which documented signals it serves","originality":"<=22 words naming the closest existing game and the difference","monetization":"<=18 words, non-pay-to-win"},' +
        '"validate":[{"metric":"e.g. Play-through rate","healthy":"<=14 words","ifWeak":"<=16 words: what that combination would indicate"}],"risk":"the single biggest risk, <=18 words","confidenceNote":"<=40 words: what is backed by market data/docs vs what is hypothesis"}\nGive exactly 3 validate items covering different metrics.',
      { temperature: 0.5, maxTokens: 5000, label: 'final' },
    );

    // Evidence-based research confidence (computed from what was actually found, not asked of the model).
    const demand = winner.comparables.filter((g) => g.players >= 500).length;
    const parts = {
      'Adjacent player demand on Roblox': Math.min(30, demand * 8 + (newHits.length ? 6 : 0)),
      'Official Discovery signals verified': Math.min(25, signals.length * 3),
      'Independent web sources': Math.min(15, (marketWeb.length + devforum.length) * 2),
      'Room in the market': Math.round(winner.scores.marketDifferentiation * 1.5),
      'Survived adversarial review': winner.challenge ? 15 : 8,
    };
    const score = Object.values(parts).reduce((a, b) => a + b, 0);
    const level = score >= 75 ? 'High' : score >= 55 ? 'Moderate' : 'Low';

    winner.comparables.slice(0, 3).forEach((g) => addSource(`${g.name} — related mechanic, ${fmt(g.players)} playing when researched`, g.url, 'game'));
    const order = { official: 0, live: 1, game: 2, web: 3 };
    const srcList = [...sources.values()].sort((a, b) => order[a.kind] - order[b.kind]).slice(0, 12);

    if (data.name) top5[0].title = data.name; // keep the list consistent with the headline
    result = {
      name: data.name || winner.title,
      concept: data.concept || winner.oneSentence,
      loop: Array.isArray(data.loop) && data.loop.length ? data.loop.slice(0, 5) : [winner.coreLoop],
      firstMinutes: data.firstMinutes || { s10: winner.first10s, s60: winner.first60s, m5: winner.first5min },
      why: data.why || {},
      validate: Array.isArray(data.validate) ? data.validate.slice(0, 3) : [],
      risk: data.risk || winner.challenge?.biggestWeakness || '',
      quality: { total: winner.total, pass: PASS_SCORE, breakdown: Object.entries(RUBRIC).map(([k, r]) => ({ label: r.label, weight: r.w, score: winner.scores[k] })) },
      discoveryScores: winner.disc,
      rediscovery: winner.isRediscovery ? winner.previous : null,
      belowBar,
      top5,
      confidence: { level, score, parts, note: data.confidenceNote || '' },
      signals: signals.slice(0, 8).map((s) => {
        const d = docSentences.find((x) => x.id === s.ids[0]);
        return { name: s.name, quote: d?.text, url: d?.doc.url };
      }),
      eliminated: rejected.map((r) => ({ title: r.title, why: r.why })),
      sources: srcList,
      researchedAt: new Date().toISOString(),
    };
    addHistory({ name: result.name, mechanicFamily: winner.mechanicFamily, oneLiner: winner.oneSentence, coreLoop: winner.coreLoop, score: winner.total });
    return (belowBar ? `Best idea found (below the ${PASS_SCORE} bar): ` : 'Winner: ') + `${result.name} — quality ${winner.total}/100, research confidence ${level} (${score}/100). Top 5 ranked.`;
  });
  return result;
}
