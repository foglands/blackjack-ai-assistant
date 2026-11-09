(function (root) {
  'use strict';

  const SHOE_SIZE = 416;
  const CUT = 312;
  const VERSION = 1;
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
  const policyCache = new Map();

  function rankValue(rank) {
    const label = String(rank).trim().toUpperCase();
    const value = ['J', 'Q', 'K', 'T'].includes(label) ? 10 : ranks.indexOf(label) + 1;
    if (value === 0) throw new Error('训练模型收到无效的牌面。');
    return value;
  }

  function score(hard, ace) {
    return ace && hard <= 11 ? hard + 10 : hard;
  }

  function hand(cards, split = false, splitAces = false, added = false) {
    const hard = cards.reduce((sum, rank) => sum + rank, 0);
    const ace = cards.includes(1);
    return { hard, ace, cards, split, splitAces, added, stake: 1, total: score(hard, ace) };
  }

  function drawTo(current, rank) {
    current.cards.push(rank);
    current.hard += rank;
    current.ace ||= rank === 1;
    current.total = score(current.hard, current.ace);
  }

  function natural(current) {
    return !current.split && current.cards.length === 2 && current.total === 21;
  }

  function pairOf(current) {
    return current.cards.length === 2 && current.cards[0] === current.cards[1] ? current.cards[0] : 0;
  }

  function actions(current) {
    if (current.cards.length < 2 || current.total >= 21 || current.splitAces) return [];
    const allowed = ['stand', 'hit'];
    if (current.cards.length === 2 && !current.split) {
      allowed.push('double');
      if (pairOf(current)) allowed.push('split');
    }
    return allowed;
  }

  function rankProbability(rank) {
    return (rank === 10 ? 4 : 1) / 13;
  }

  function dealerPolicy(up) {
    if (policyCache.has(up)) return policyCache.get(up);
    const totals = new Float64Array(23);
    const complement = up === 1 ? 10 : up === 10 ? 1 : 0;
    const allowedProbability = complement ? 1 - rankProbability(complement) : 1;

    function visit(hard, ace, probability) {
      const total = score(hard, ace);
      if (total >= 17) {
        totals[Math.min(total, 22)] += probability;
        return;
      }
      for (let rank = 1; rank <= 10; rank++) {
        visit(hard + rank, ace || rank === 1, probability * rankProbability(rank));
      }
    }

    for (let rank = 1; rank <= 10; rank++) {
      if (rank !== complement) visit(up + rank, up === 1 || rank === 1, rankProbability(rank) / allowedProbability);
    }

    // This composition-independent baseline first evaluates the branch in
    // which the dealer has no natural. Dealer-ten natural exposure is then
    // restored separately for each action by baselineValues().
    const stand = new Float64Array(22);
    for (let player = 0; player <= 21; player++) {
      stand[player] = totals[22];
      for (let dealer = 17; dealer <= 21; dealer++) {
        stand[player] += totals[dealer] * Math.sign(player - dealer);
      }
    }

    const follow = new Float64Array(44);
    const hit = new Float64Array(44);
    for (let hard = 21; hard >= 0; hard--) {
      for (let hasAce = 0; hasAce <= 1; hasAce++) {
        const key = hard * 2 + hasAce;
        const total = score(hard, hasAce);
        if (total < 21) {
          for (let rank = 1; rank <= 10; rank++) {
            const next = hard + rank;
            hit[key] += rankProbability(rank) * (next > 21 ? -1 : follow[next * 2 + Number(hasAce || rank === 1)]);
          }
        }
        follow[key] = total === 21 ? stand[total] : Math.max(stand[total], hit[key]);
      }
    }
    const policy = { stand, follow, hit };
    policyCache.set(up, policy);
    return policy;
  }

  function baselineValues(current, up, lossRule, allowed) {
    const { stand, follow, hit } = dealerPolicy(up);
    const dealerNatural = up === 10 ? 1 / 13 : 0;
    const loseHand = lossRule === 'original' && current.added ? 0 : -1;
    const loseAdded = lossRule === 'original' ? -1 : -2;
    const values = {
      stand: (1 - dealerNatural) * stand[current.total] + dealerNatural * loseHand,
      hit: (1 - dealerNatural) * hit[current.hard * 2 + Number(current.ace)] + dealerNatural * loseHand,
    };

    if (allowed.includes('double')) {
      let result = 0;
      for (let rank = 1; rank <= 10; rank++) {
        const total = score(current.hard + rank, current.ace || rank === 1);
        result += rankProbability(rank) * (total > 21 ? -1 : stand[total]);
      }
      values.double = (1 - dealerNatural) * 2 * result + dealerNatural * loseAdded;
    }

    if (allowed.includes('split')) {
      const pair = pairOf(current);
      let result = 0;
      for (let rank = 1; rank <= 10; rank++) {
        const hard = pair + rank;
        const ace = pair === 1 || rank === 1;
        const play = pair === 1 ? stand[score(hard, ace)] : follow[hard * 2 + Number(ace)];
        result += rankProbability(rank) * play;
      }
      values.split = (1 - dealerNatural) * 2 * result + dealerNatural * loseAdded;
    }
    return values;
  }

  function countBucket(value) {
    return Math.max(-4, Math.min(4, Math.round(Number.isFinite(value) ? value : 0)));
  }

  function decision(current, up, trueCount, lossRule) {
    const allowed = actions(current);
    const soft = current.ace && current.hard <= 11 ? 'S' : 'H';
    const stage = current.split ? (current.added ? 'B' : 'F') : current.cards.length === 2 ? 'I' : 'C';
    const pair = allowed.includes('split') ? pairOf(current) : 0;
    const pooled = [up, soft + current.total, stage, pair].join(':');
    return {
      allowed, pooled, specific: pooled + ':' + countBucket(trueCount),
      baseline: baselineValues(current, up, lossRule, allowed),
    };
  }

  function greedy(allowed, getValue) {
    let best = allowed[0];
    for (const action of allowed.slice(1)) {
      if (getValue(action) > getValue(best)) best = action;
    }
    return best;
  }

  function select(model, state) {
    const count = model.table[state.specific];
    if (count && state.allowed.every(action => count[action].visits >= 8)) {
      return { key: state.specific, source: 'count', values: count };
    }
    const pooled = model.table[state.pooled];
    if (pooled && state.allowed.every(action => pooled[action].visits >= 16)) {
      return { key: state.pooled, source: 'pooled', values: pooled };
    }
    return { key: state.specific, source: 'baseline', values: null };
  }

  function learnedAction(model, state) {
    const selected = select(model, state);
    return greedy(state.allowed, action => selected.values?.[action].ev ?? state.baseline[action]);
  }

  function normalizedLossRule(lossRule) {
    if (lossRule !== 'all' && lossRule !== 'original') throw new Error('无效的训练赔付规则。');
    return lossRule;
  }

  function createModel({ lossRule = 'all', seed = 20261108 } = {}) {
    return {
      version: VERSION,
      lossRule: normalizedLossRule(lossRule),
      rounds: 0,
      decisions: 0,
      table: {},
      rng: (seed | 0) ^ 0x775F7853,
      simulation: { rng: seed | 0, deck: [], cursor: 0, running: 0 },
    };
  }

  function verifyModel(model) {
    if (!model || model.version !== VERSION || !model.table || !model.simulation) {
      throw new Error('训练模型的格式或版本无效。');
    }
    normalizedLossRule(model.lossRule);
  }

  function recommend(model, {
    cards = [], dealerCards = [], trueCount = 0, splitHand = false,
    splitAces = false, addedSplitHand = false,
  } = {}) {
    verifyModel(model);
    const current = hand(cards.map(rankValue), splitHand, splitAces, addedSplitHand);
    if (dealerCards.length !== 1 || actions(current).length === 0) {
      return { action: null, source: 'baseline', rows: [], key: null };
    }
    const state = decision(current, rankValue(dealerCards[0]), trueCount, model.lossRule);
    const selected = select(model, state);
    const rows = state.allowed.map(action => ({
      action,
      ev: selected.values?.[action].ev ?? state.baseline[action],
      visits: selected.values?.[action].visits ?? 0,
    }));
    rows.sort((a, b) => b.ev - a.ev);
    return { action: rows[0].action, source: selected.source, rows, key: selected.key };
  }

  function random(state) {
    state.rng = (state.rng + 0x6D2B79F5) | 0;
    let bits = Math.imul(state.rng ^ (state.rng >>> 15), state.rng | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
  }

  function startShoe(shoe) {
    const deck = [];
    for (let rank = 1; rank <= 10; rank++) {
      const copies = rank === 10 ? 128 : 32;
      for (let index = 0; index < copies; index++) deck.push(rank);
    }
    for (let index = deck.length - 1; index > 0; index--) {
      const other = Math.floor(random(shoe) * (index + 1));
      [deck[index], deck[other]] = [deck[other], deck[index]];
    }
    Object.assign(shoe, { deck, cursor: 0, running: 0 });
  }

  function reveal(shoe, rank) {
    if (rank >= 2 && rank <= 6) shoe.running++;
    else if (rank === 1 || rank === 10) shoe.running--;
  }

  function take(shoe, visible = true) {
    if (shoe.cursor === shoe.deck.length) throw new Error('模拟牌靴用尽。');
    const rank = shoe.deck[shoe.cursor++];
    if (visible) reveal(shoe, rank);
    return rank;
  }

  function settle(current, dealer, lossRule) {
    if (natural(current)) return natural(dealer) ? 0 : 1.5;
    if (natural(dealer)) {
      if (lossRule === 'original') return current.added ? 0 : -1;
      return -current.stake;
    }
    if (current.total > 21) return -current.stake;
    if (dealer.total > 21) return current.stake;
    return current.stake * Math.sign(current.total - dealer.total);
  }

  function playRound(shoe, lossRule, otherPlayers, choose, learn) {
    if (!shoe.deck.length || shoe.cursor >= CUT) startShoe(shoe);
    const seats = Array.from({ length: otherPlayers + 1 }, () => [take(shoe)]);
    const up = take(shoe);
    for (const cards of seats) cards.push(take(shoe));
    const hole = take(shoe, false);
    const dealer = hand([up, hole]);
    const mySeat = Math.floor(otherPlayers / 2);
    if (up === 1 && natural(dealer)) {
      reveal(shoe, hole);
      return settle(hand(seats[mySeat]), dealer, lossRule);
    }

    const finished = [];
    const traces = [];
    const myHands = [];
    let splitDecision = null;

    function play(current, mine) {
      const trace = [];
      while (current.total < 21 && !current.splitAces) {
        const trueCount = shoe.running * 52 / (SHOE_SIZE - shoe.cursor + 1);
        const state = decision(current, up, trueCount, lossRule);
        const action = mine
          ? choose(state)
          : greedy(state.allowed, item => state.baseline[item]);
        if (mine && learn) trace.push({ state, action });
        if (action === 'stand') break;
        if (action === 'split') {
          const rank = current.cards[0];
          const first = hand([rank, take(shoe)], true, rank === 1);
          const second = hand([rank, take(shoe)], true, rank === 1, true);
          if (mine && learn) splitDecision = trace[0];
          play(first, mine);
          play(second, mine);
          return;
        }
        drawTo(current, take(shoe));
        if (action === 'double') {
          current.stake = 2;
          break;
        }
      }
      finished.push(current);
      if (mine) {
        myHands.push(current);
        traces.push({ current, trace });
      }
    }

    seats.forEach((cards, index) => play(hand(cards), index === mySeat));
    reveal(shoe, hole);
    if (finished.some(current => current.total <= 21 && !natural(current))) {
      while (dealer.total < 17) drawTo(dealer, take(shoe));
    }
    const net = myHands.reduce((total, current) => total + settle(current, dealer, lossRule), 0);
    if (learn) {
      for (const { current, trace } of traces) learn(trace, settle(current, dealer, lossRule));
      if (splitDecision) learn([splitDecision], net);
    }
    return net;
  }

  function entry(model, key, state) {
    if (!model.table[key]) {
      model.table[key] = Object.fromEntries(state.allowed.map(action => [
        action, { ev: state.baseline[action], visits: 0 },
      ]));
    }
    return model.table[key];
  }

  function trainTrace(model, trace, reward) {
    for (let index = trace.length - 1; index >= 0; index--) {
      const { state, action } = trace[index];
      const next = trace[index + 1]?.state;
      for (const lane of ['specific', 'pooled']) {
        const q = entry(model, state[lane], state)[action];
        let target = reward;
        if (next) {
          const nextValues = entry(model, next[lane], next);
          target = Math.max(...next.allowed.map(move => nextValues[move].ev));
        }
        q.visits++;
        q.ev += Math.pow(q.visits + 12, -0.62) * (target - q.ev);
      }
      model.decisions++;
    }
  }

  function runRounds(shoe, lossRule, rounds, otherPlayers, choose, learn) {
    const metrics = { rounds, wins: 0, pushes: 0, losses: 0, netUnits: 0 };
    for (let index = 0; index < rounds; index++) {
      const result = playRound(shoe, lossRule, otherPlayers, choose, learn);
      metrics.netUnits += result;
      if (result > 0) metrics.wins++;
      else if (result < 0) metrics.losses++;
      else metrics.pushes++;
    }
    return { ...metrics, winRate: metrics.wins / rounds, netPerRound: metrics.netUnits / rounds };
  }

  function options(rounds, otherPlayers) {
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 250000) {
      throw new Error('每批训练或评估需要 1 至 250,000 局。');
    }
    if (!Number.isSafeInteger(otherPlayers) || otherPlayers < 0 || otherPlayers > 6) {
      throw new Error('其他玩家数量必须在 0 至 6 之间。');
    }
  }

  function train(model, { rounds = 2000, otherPlayers = 3 } = {}) {
    verifyModel(model);
    options(rounds, otherPlayers);
    const results = runRounds(model.simulation, model.lossRule, rounds, otherPlayers, state => {
      const exploration = Math.max(0.06, 0.35 / Math.sqrt(1 + model.decisions / 40000));
      if (random(model) < exploration) return state.allowed[Math.floor(random(model) * state.allowed.length)];
      return learnedAction(model, state);
    }, (trace, reward) => trainTrace(model, trace, reward));
    model.rounds += rounds;
    return { ...results, totalRounds: model.rounds, totalDecisions: model.decisions, states: Object.keys(model.table).length };
  }

  function evaluate(model, { rounds = 10000, seed = 1618033, otherPlayers = 3 } = {}) {
    verifyModel(model);
    options(rounds, otherPlayers);
    function newSimulation() {
      return { rng: seed | 0, deck: [], cursor: 0, running: 0 };
    }
    const learned = runRounds(newSimulation(), model.lossRule, rounds, otherPlayers, state => learnedAction(model, state));
    const baseline = runRounds(newSimulation(), model.lossRule, rounds, otherPlayers, state => greedy(state.allowed, action => state.baseline[action]));
    return { rounds, learned, baseline };
  }

  const api = { createModel, train, evaluate, recommend };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackTraining = api;
}(globalThis));
