(function (root) {
  'use strict';

  const ranks = new Map([
    ['A', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
    ['8', 8], ['9', 9], ['10', 10], ['T', 10], ['J', 10], ['Q', 10], ['K', 10],
  ]);
  const baselinePolicies = new Map();

  function rankValue(rank) {
    const result = ranks.get(String(rank).trim().toUpperCase());
    if (!result) throw new Error(`无效的牌面：${rank}`);
    return result;
  }

  function handState(cards) {
    const values = cards.map(rankValue);
    return { hard: values.reduce((sum, rank) => sum + rank, 0), ace: values.includes(1) };
  }

  function score(hard, ace) {
    return ace && hard <= 11 ? hard + 10 : hard;
  }

  function value(cards) {
    const { hard, ace } = handState(cards);
    return { total: score(hard, ace), soft: ace && hard <= 11 };
  }

  function availableActions({ cards = [], splitHand = false, splitAces = false }) {
    if (cards.length < 2 || splitAces || value(cards).total >= 21) return [];
    const actions = ['hit', 'stand'];
    if (cards.length === 2 && !splitHand) {
      actions.push('double');
      if (rankValue(cards[0]) === rankValue(cards[1])) actions.push('split');
    }
    return actions;
  }

  function mustHitDealer(hard, ace) {
    return score(hard, ace) < 17;
  }

  function blackjackHole(up) {
    return up === 1 ? 10 : up === 10 ? 1 : 0;
  }

  function hitStandTable(up, draws, holes) {
    const dealerTotals = new Float64Array(23);
    const pending = new Float64Array(44);
    for (let rank = 1; rank <= 10; rank++) {
      pending[(up + rank) * 2 + Number(up === 1 || rank === 1)] += holes[rank - 1];
    }
    // Every draw increases the hard sum. Accumulate each reachable dealer
    // state once, including hands that demote an ace from eleven to one.
    for (let hard = 2; hard <= 21; hard++) {
      for (let ace = 0; ace <= 1; ace++) {
        const probability = pending[hard * 2 + ace];
        if (!probability) continue;
        if (!mustHitDealer(hard, ace)) {
          dealerTotals[score(hard, ace)] += probability;
          continue;
        }
        for (let rank = 1; rank <= 10; rank++) {
          const next = hard + rank;
          const mass = probability * draws[rank - 1];
          if (next > 21) dealerTotals[22] += mass;
          else pending[next * 2 + Number(ace || rank === 1)] += mass;
        }
      }
    }

    const stand = new Float64Array(22);
    for (let total = 0; total <= 21; total++) {
      stand[total] = dealerTotals[22];
      for (let dealerTotal = 17; dealerTotal <= 21; dealerTotal++) {
        stand[total] += Math.sign(total - dealerTotal) * dealerTotals[dealerTotal];
      }
    }

    const optimal = new Float64Array(44);
    const hit = new Float64Array(44);
    const policy = new Uint8Array(44);
    for (let hard = 21; hard >= 0; hard--) {
      for (let ace = 0; ace <= 1; ace++) {
        const key = hard * 2 + ace;
        const total = score(hard, ace);
        if (total === 21) {
          optimal[key] = stand[total];
          continue;
        }
        let hitReturn = 0;
        for (let rank = 1; rank <= 10; rank++) {
          const next = hard + rank;
          const nextKey = next * 2 + Number(ace || rank === 1);
          hitReturn += draws[rank - 1] * (next > 21 ? -1 : optimal[nextKey]);
        }
        hit[key] = hitReturn;
        policy[key] = Number(hitReturn > stand[total]);
        optimal[key] = Math.max(hitReturn, stand[total]);
      }
    }
    return { stand, hit, policy };
  }

  function holeDistribution(up, counts) {
    // Dealer blackjack has the same outcome for hit and stand. Compare the
    // two decisions on the remaining branches, where a choice matters.
    const natural = blackjackHole(up);
    const eligible = counts.map((count, index) => index + 1 === natural ? 0 : count);
    const size = eligible.reduce((sum, count) => sum + count, 0);
    return size ? eligible.map(count => count / size) : null;
  }

  function baselinePolicy(up) {
    if (!baselinePolicies.has(up)) {
      const counts = [1, 1, 1, 1, 1, 1, 1, 1, 1, 4];
      baselinePolicies.set(up, hitStandTable(up, counts.map(count => count / 13), holeDistribution(up, counts)).policy);
    }
    return baselinePolicies.get(up);
  }

  function hitStandPolicy(dealerUp, counts) {
    const up = rankValue(dealerUp);
    const size = counts.reduce((sum, count) => sum + count, 0);
    const holes = holeDistribution(up, counts);
    if (size < 2 || !holes) return null;
    // Reserve the expected hidden card. Use the resulting composition as a
    // fixed distribution for future draws so all seats share one fast table.
    const draws = counts.map((count, index) => (count - holes[index]) / (size - 1));
    const table = hitStandTable(up, draws, holes);
    return cards => {
      const { hard, ace } = handState(cards);
      const total = score(hard, ace);
      if (cards.length < 2 || total >= 21) return null;
      const key = hard * 2 + Number(ace);
      const difference = table.hit[key] - table.stand[total];
      return { action: difference > 1e-12 ? 'hit' : 'stand', difference };
    };
  }

  function randomGenerator(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      let bits = Math.imul(seed ^ (seed >>> 15), seed | 1);
      bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
      return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
    };
  }

  function evaluate({
    counts, dealerCards = [], peek = 'unknown', cards = [], splitHand = false,
    splitAces = false, addedSplitHand = false, lossRule = 'all', trials = 12000, seed = 452981,
  }) {
    const actions = availableActions({ cards, splitHand, splitAces });
    if (actions.length === 0 || dealerCards.length !== 1) {
      return { rows: [], trials: 0, dealerBlackjackPossible: false, dealerBlackjackProbability: 0 };
    }
    if (!counts || counts.length !== 10 || Array.from(counts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
      throw new Error('牌靴必须包含十个有效的剩余点值计数。');
    }
    if (lossRule !== 'all' && lossRule !== 'original') throw new Error('无效的庄家 Blackjack 结算规则。');
    const shoe = Array.from(counts);
    const size = shoe.reduce((sum, count) => sum + count, 0);
    const up = rankValue(dealerCards[0]);
    const natural = blackjackHole(up);
    const excluded = peek === 'clear' ? natural : 0;
    const validHoles = size - (excluded ? shoe[excluded - 1] : 0);
    if (validHoles <= 0) throw new Error('剩余牌与庄家底牌状态冲突。');
    const dealerBlackjackProbability = natural && !excluded ? shoe[natural - 1] / size : 0;
    const trialCount = Number.isFinite(trials) ? Math.max(2, Math.min(75000, Math.trunc(trials))) : 12000;
    const random = randomGenerator(seed);
    const policy = baselinePolicy(up);
    const player = handState(cards);
    const pair = rankValue(cards[0]);
    const sums = actions.map(() => 0);
    const squares = actions.map(() => 0);
    const pool = shoe.slice();
    const draws = [];
    let left = 0;
    let cursor = 0;

    function take(available, skip = 0) {
      if (available <= 0) throw new Error('牌靴中未知牌不足，无法完成模拟。');
      let index = Math.floor(random() * available);
      for (let rank = 1; rank <= 10; rank++) {
        if (rank === skip) continue;
        index -= pool[rank - 1];
        if (index < 0) {
          pool[rank - 1]--;
          left--;
          return rank;
        }
      }
      throw new Error('牌靴余量与牌面记录不一致。');
    }

    function draw() {
      if (cursor === draws.length) draws.push(take(left));
      return draws[cursor++];
    }

    function completePlayer(hard, ace, forcedDraw, oneCardOnly) {
      if (forcedDraw) {
        const rank = draw();
        hard += rank;
        ace ||= rank === 1;
      }
      if (!oneCardOnly) {
        while (hard <= 21 && policy[hard * 2 + Number(ace)]) {
          const rank = draw();
          hard += rank;
          ace ||= rank === 1;
        }
      }
      return score(hard, ace);
    }

    function completeDealer(hole) {
      let hard = up + hole;
      let ace = up === 1 || hole === 1;
      while (mustHitDealer(hard, ace)) {
        const rank = draw();
        hard += rank;
        ace ||= rank === 1;
      }
      return score(hard, ace);
    }

    function settle(total, dealer) {
      if (total > 21) return -1;
      if (dealer > 21) return 1;
      return Math.sign(total - dealer);
    }

    function simulate(action, hole) {
      if (hole === natural) {
        // With an ace up the dealer always checks before any added bets.
        // For a ten up, apply the selected late-blackjack settlement model.
        if (up !== 10) return -1;
        if (lossRule === 'original') return splitHand && addedSplitHand ? 0 : -1;
        return action === 'double' || action === 'split' ? -2 : -1;
      }

      if (action === 'split') {
        const firstCard = draw();
        const secondCard = draw();
        const first = completePlayer(pair + firstCard, pair === 1 || firstCard === 1, false, pair === 1);
        const second = completePlayer(pair + secondCard, pair === 1 || secondCard === 1, false, pair === 1);
        if (first > 21 && second > 21) return -2;
        const dealer = completeDealer(hole);
        return settle(first, dealer) + settle(second, dealer);
      }

      const total = action === 'stand'
        ? score(player.hard, player.ace)
        : completePlayer(player.hard, player.ace, true, action === 'double');
      const stake = action === 'double' ? 2 : 1;
      return total > 21 ? -stake : stake * settle(total, completeDealer(hole));
    }

    for (let trial = 0; trial < trialCount; trial++) {
      for (let index = 0; index < pool.length; index++) pool[index] = shoe[index];
      left = size;
      const hole = take(validHoles, excluded);
      draws.length = 0;

      // Every candidate uses the same randomized hole and subsequent card
      // sequence. Future unobserved draws by other seats are marginalized:
      // after an adaptive number of unseen draws, the dealer's unseen draws
      // have the same marginal law in a shuffled shoe. All revealed cards
      // from all seats must already be excluded in the supplied counts.
      for (let index = 0; index < actions.length; index++) {
        cursor = 0;
        const result = simulate(actions[index], hole);
        sums[index] += result;
        squares[index] += result * result;
      }
    }

    const rows = actions.map((action, index) => {
      const ev = sums[index] / trialCount;
      const variance = Math.max(0, (squares[index] - trialCount * ev * ev) / (trialCount - 1));
      return { action, ev, stderr: Math.sqrt(variance / trialCount) };
    });
    rows.sort((leftRow, rightRow) => rightRow.ev - leftRow.ev);
    return { rows, trials: trialCount, dealerBlackjackPossible: dealerBlackjackProbability > 0, dealerBlackjackProbability };
  }

  const engine = { availableActions, evaluate, value, hitStandPolicy };
  if (typeof module === 'object' && module.exports) module.exports = engine;
  else root.BlackjackEngine = engine;
}(globalThis));
