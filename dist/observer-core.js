(function (root) {
  'use strict';

  const ranks = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
  const shoeSize = 416;
  const copies = 32;
  const modes = ['complete', 'mid'];
  const peekStates = ['unknown', 'clear', 'blackjack'];
  const handStatuses = ['playing', 'stood', 'doubled'];
  const uniformLogLoss = Math.log(ranks.length);
  const uniformBrier = 1 - 1 / ranks.length;
  const learningRate = 0.025;
  const shrinkage = 0.15;
  const biasLimit = 0.30;
  const seatOrder = 'screen-right-1';
  const projections = new WeakMap();

  function modeValue(mode) {
    if (!modes.includes(mode)) throw new Error('请选择完整牌靴或中途加入。');
    return mode;
  }

  function seatValue(seat, dealerAllowed = true) {
    if (!Number.isInteger(seat) || seat < Number(!dealerAllowed) || seat > 9) {
      throw new Error(dealerAllowed ? '请选择庄家或 1 到 9 号座位。' : '请选择 1 到 9 号座位。');
    }
    return seat;
  }

  function rankValue(rank) {
    const value = String(rank).trim().toUpperCase().replace(/^T$/, '10');
    if (!ranks.includes(value)) throw new Error('请选择 A、2 至 10、J、Q 或 K。');
    return value;
  }

  function points(rank) {
    return Math.min(ranks.indexOf(rank) + 1, 10);
  }

  function tally() {
    return { predictions: 0, topHits: 0, logTotal: 0, brierTotal: 0, contradictions: 0 };
  }

  function emptyArchive() {
    return { complete: tally(), mid: tally() };
  }

  function clampBias(value) {
    return Math.max(-biasLimit, Math.min(biasLimit, value));
  }

  function calibrationCopy(source) {
    return {
      bias: ranks.map((_, index) => {
        const value = source?.bias?.[index];
        return Number.isFinite(value) ? clampBias(value) : 0;
      }),
      score: { ...tally(), ...source?.score },
      baselineLogTotal: source?.baselineLogTotal ?? 0,
      baselineBrierTotal: source?.baselineBrierTotal ?? 0,
      updates: source?.updates ?? 0,
    };
  }

  function origin({ mode, mySeat, shoe, archive, calibration }) {
    return { mode, mySeat, shoe, archive, calibration, seatOrder };
  }

  function fresh(base, undoShoe = null) {
    return {
      version: 1,
      ...base,
      round: 1,
      entries: [],
      tombstones: {},
      splits: {},
      peeks: {},
      statuses: {},
      journal: [],
      origin: base,
      undoShoe,
    };
  }

  function create({ mode = 'mid', mySeat = 4 } = {}) {
    return fresh(origin({ mode: modeValue(mode), mySeat: seatValue(mySeat, false), shoe: 1, archive: emptyArchive() }));
  }

  function mirrorSeat(seat) {
    return Number.isInteger(seat) && seat >= 1 && seat <= 7 ? 8 - seat : seat;
  }

  function mirrorSeatFields(item) {
    const seat = mirrorSeat(item.seat);
    return seat === item.seat ? item : { ...item, seat };
  }

  function mirrorSeatKeys(map) {
    return Object.fromEntries(Object.entries(map ?? {}).map(([key, value]) => [
      key.replace(/^(\d+):([1-7])(?=:|$)/, (_, round, seat) => round + ':' + mirrorSeat(Number(seat))),
      value,
    ]));
  }

  function migrateSeatOrder(state) {
    if (state.seatOrder === seatOrder) return state;
    if (state.seatOrder != null) throw new Error('无法识别保存记录的座位编号。');
    return {
      ...state,
      seatOrder,
      mySeat: mirrorSeat(state.mySeat),
      entries: state.entries.map(mirrorSeatFields),
      journal: state.journal.map(mirrorSeatFields),
      tombstones: mirrorSeatKeys(state.tombstones),
      splits: mirrorSeatKeys(state.splits),
      statuses: mirrorSeatKeys(state.statuses),
      origin: { ...state.origin, seatOrder, mySeat: mirrorSeat(state.origin.mySeat) },
      undoShoe: state.undoShoe ? migrateSeatOrder(state.undoShoe) : null,
    };
  }

  function position(state, event) {
    const { seat, hand = 0, slot, round = state.round } = event;
    seatValue(seat);
    if (!Number.isInteger(round) || round < 1 || round > state.round) throw new Error('请选择已开始的一局。');
    if ((hand !== 0 && hand !== 1) || (seat === 0 && hand !== 0) || !Number.isInteger(slot) || slot < 1 || slot > 21) {
      throw new Error('请选择有效的手牌和牌位。');
    }
    return { seat, hand, slot, round };
  }

  function key({ round, seat, hand, slot }) {
    return [round, seat, hand, slot].join(':');
  }

  function splitKey(round, seat) {
    return round + ':' + seat;
  }

  function handKey(round, seat, hand) {
    return [round, seat, hand].join(':');
  }

  function findEntry(state, place) {
    const target = key(place);
    return state.entries.findIndex(entry => key(entry) === target);
  }

  function cardEvent(state, event) {
    const place = position(state, event);
    const rank = rankValue(event.rank);
    const source = event.source ?? 'manual';
    if (source !== 'auto' && source !== 'manual') throw new Error('无效的录入来源。');
    const split = state.splits[splitKey(place.round, place.seat)];
    if (source === 'auto' && (place.round !== state.round || (split && event.hand === undefined))) return state;
    if (place.hand === 1 && !split) throw new Error('请先标记该座位已分牌。');
    const id = key(place);
    const index = findEntry(state, place);
    const previous = state.entries[index];
    if (source === 'auto' && (state.tombstones[id] || previous)) return state;
    if (previous?.source === source && previous.rank === rank) return state;
    if (state.entries.filter(entry => entry.rank === rank).length >= copies && previous?.rank !== rank) {
      throw new Error('这靴牌只有 ' + copies + ' 张 ' + rank + '，请检查重复录入或洗牌。');
    }

    const initial = Boolean(event.initial);
    const observed = !initial && (source === 'auto' || event.observed === true);
    const time = Number.isFinite(event.time) && event.time >= 0 ? event.time : null;
    const entry = previous
      ? { ...previous, rank, source }
      : { ...place, rank, source, initial, observed, time, mode: state.mode, peek: state.peeks[place.round] ?? 'unknown' };
    if (source === 'auto' && event.templateSource === 'fallback') entry.templateSource = 'fallback';
    else if (previous?.templateSource) delete entry.templateSource;
    const entries = state.entries.slice();
    if (previous) entries[index] = entry;
    else entries.push(entry);
    const tombstones = { ...state.tombstones };
    delete tombstones[id];
    return { ...state, entries, tombstones };
  }

  function deleteEvent(state, event) {
    const place = position(state, event);
    const index = findEntry(state, place);
    if (index < 0) return state;
    const entries = state.entries.slice();
    entries.splice(index, 1);
    return { ...state, entries, tombstones: { ...state.tombstones, [key(place)]: true } };
  }

  function splitEvent(state, event) {
    const seat = seatValue(event.seat, false);
    const round = event.round ?? state.round;
    const first = position(state, { seat, round, slot: 1 });
    const id = splitKey(round, seat);
    if (state.splits[id]) return state;
    const cards = state.entries.filter(entry => entry.round === round && entry.seat === seat);
    const left = cards.find(entry => key(entry) === key(first));
    const right = cards.find(entry => entry.hand === 0 && entry.slot === 2);
    if (cards.length !== 2 || !left || !right || points(left.rank) !== points(right.rank)) {
      throw new Error('分牌需要恰好两张点值相同的起手牌。');
    }
    return {
      ...state,
      entries: state.entries.map(entry => entry === right ? { ...entry, hand: 1, slot: 1 } : entry),
      splits: { ...state.splits, [id]: { aces: left.rank === 'A' } },
    };
  }

  function change(state, event) {
    switch (event.type) {
      case 'card': return cardEvent(state, event);
      case 'delete': return deleteEvent(state, event);
      case 'split': return splitEvent(state, event);
      case 'round': return { ...state, round: state.round + 1, mode: event.gap ? 'mid' : state.mode };
      case 'gap': return state.mode === 'mid' ? state : { ...state, mode: 'mid' };
      case 'mySeat': {
        const mySeat = seatValue(event.seat, false);
        return mySeat === state.mySeat ? state : { ...state, mySeat };
      }
      case 'peek': {
        const { round } = position(state, { round: event.round, seat: 0, slot: 1 });
        const value = event.value ?? event.peek;
        if (!peekStates.includes(value)) throw new Error('请选择有效的庄家查牌状态。');
        return (state.peeks[round] ?? 'unknown') === value
          ? state
          : { ...state, peeks: { ...state.peeks, [round]: value } };
      }
      case 'status': {
        const { round, seat, hand } = position(state, { ...event, slot: 1 });
        const status = event.status ?? event.value;
        if (!seat || !handStatuses.includes(status)) throw new Error('请选择有效的玩家手牌状态。');
        if (hand === 1 && !state.splits[splitKey(round, seat)]) throw new Error('请先标记该座位已分牌。');
        const id = handKey(round, seat, hand);
        return (state.statuses[id] ?? 'playing') === status
          ? state
          : { ...state, statuses: { ...state.statuses, [id]: status } };
      }
      default: throw new Error('无法识别这个观察操作。');
    }
  }

  function undoIndex(journal) {
    return journal.findLastIndex((event, index) => {
      if (event.source === 'auto') return false;
      const later = journal.slice(index + 1);
      if (event.type === 'round' && later.some(item => item.round > event.round)) return false;
      if (event.type === 'split' && later.some(item => item.round === event.round && item.seat === event.seat && item.hand === 1)) return false;
      return true;
    });
  }

  function undo(state) {
    if (!state.journal.length) return state.undoShoe ?? state;
    const index = undoIndex(state.journal);
    if (index < 0) return state;
    const journal = state.journal.filter((_, position) => position !== index);
    const previous = journal.reduce(change, fresh(state.origin, state.undoShoe));
    return { ...previous, journal };
  }

  function apply(state, event) {
    if (!state || state.version !== 1 || !event || typeof event.type !== 'string') throw new Error('观察记录的格式无效。');
    if (event.type === 'undo') return undo(state);
    if (event.type === 'shoe') {
      const mode = modeValue(event.mode ?? 'complete');
      const { scores: archive, calibration } = evaluate(state);
      const base = origin({ mode, mySeat: state.mySeat, shoe: state.shoe + 1, archive, calibration });
      return fresh(base, { ...state, undoShoe: null });
    }
    const recorded = { ...event, round: event.round ?? state.round };
    const next = change(state, recorded);
    if (next === state) return state;
    return { ...next, journal: [...state.journal, recorded] };
  }

  function rows(state, { round = state.round } = {}) {
    return state.entries.filter(entry => round === null || entry.round === round);
  }

  function stock() {
    return Array(ranks.length).fill(copies);
  }

  function remove(counts, rank) {
    counts[ranks.indexOf(rank)]--;
  }

  function chances(counts, target, dealer, peek) {
    const size = counts.reduce((sum, count) => sum + count, 0);
    if (size === 0) return counts.map(() => 0);
    if (dealer.up !== 'A' || dealer.hole || peek === 'unknown') return counts.map(count => count / size);

    // The unknown hole card is already reserved. A confirmed ace peek changes
    // its distribution, and in turn the marginal law of the next visible draw.
    const eligible = counts.map((count, index) => {
      const tenValue = index >= 9;
      return tenValue === (peek === 'blackjack') ? count : 0;
    });
    const eligibleSize = eligible.reduce((sum, count) => sum + count, 0);
    if (!eligibleSize) return counts.map(() => 0);
    const hole = eligible.map(count => count / eligibleSize);
    if (target.seat === 0 && target.hand === 0 && target.slot === 2) return hole;
    if (size < 2) return counts.map(() => 0);
    return counts.map((count, index) => Math.max(0, count - hole[index]) / (size - 1));
  }

  function handInfo(cards) {
    const hard = cards.reduce((total, rank) => total + points(rank), 0);
    const ace = cards.includes('A');
    const soft = ace && hard <= 11;
    return { hard, ace, total: hard + (soft ? 10 : 0), soft };
  }

  function bustProbability(cards, probability) {
    if (cards.length < 2) return null;
    const info = handInfo(cards);
    if (info.total >= 21 || probability.every(value => value === 0)) return null;
    return probability.reduce((sum, value, index) => {
      return sum + (info.hard + points(ranks[index]) > 21 ? value : 0);
    }, 0);
  }

  function dealerKnowledge(entries) {
    const up = entries.find(row => row.seat === 0 && row.slot === 1)?.rank;
    const hole = entries.find(row => row.seat === 0 && row.slot === 2)?.rank;
    return { up, hole };
  }

  function countValue(rank) {
    const value = points(rank);
    return value >= 2 && value <= 6 ? 1 : value === 1 || value === 10 ? -1 : 0;
  }

  function topIndex(probability) {
    let best = 0;
    for (let index = 1; index < probability.length; index++) {
      if (probability[index] > probability[best]) best = index;
    }
    return probability[best] > 0 ? best : -1;
  }

  function learnedProbabilities(baseline, bias) {
    const weighted = baseline.map((value, index) => value * Math.exp(bias[index]));
    const size = weighted.reduce((sum, value) => sum + value, 0);
    return size > 0 ? weighted.map(value => value / size) : weighted;
  }

  function scoreForecast(probability, actual) {
    const best = topIndex(probability);
    const actualProbability = probability[actual];
    return {
      probability: actualProbability,
      topRank: best < 0 ? null : ranks[best],
      logLoss: -Math.log(Math.max(actualProbability, 1e-12)),
      brier: probability.reduce((sum, value, index) => sum + (value - Number(index === actual)) ** 2, 0),
    };
  }

  function addScore(score, observation, rank) {
    score.predictions++;
    score.topHits += Number(observation.topRank === rank);
    score.contradictions += Number(observation.probability === 0);
    score.logTotal += observation.logLoss;
    score.brierTotal += observation.brier;
  }

  function updateCalibration(model, probability, actual) {
    // An impossible outcome means the ledger or an explicit peek is
    // inconsistent. Score it as a contradiction and keep the model intact.
    if (probability[actual] === 0) return;
    model.bias = model.bias.map((value, index) => {
      const gradient = Number(index === actual) - probability[index] - shrinkage * value;
      return clampBias(value + learningRate * gradient);
    });
    model.updates++;
  }

  function evaluate(state) {
    const existing = projections.get(state);
    if (existing) return existing;
    const scores = { complete: { ...state.archive.complete }, mid: { ...state.archive.mid } };
    const calibration = {
      complete: calibrationCopy(state.calibration?.complete),
      mid: calibrationCopy(state.calibration?.mid),
    };
    const counts = stock();
    const dealers = new Map();
    let running = 0;
    let lastPrediction = null;
    for (const entry of state.entries) {
      const dealer = dealers.get(entry.round) ?? {};
      if (entry.observed) {
        const probability = chances(counts, entry, dealer, entry.peek);
        const actual = ranks.indexOf(entry.rank);
        const model = calibration[entry.mode];
        const learned = learnedProbabilities(probability, model.bias);
        const baselineResult = scoreForecast(probability, actual);
        const learnedResult = scoreForecast(learned, actual);
        addScore(scores[entry.mode], baselineResult, entry.rank);
        addScore(model.score, learnedResult, entry.rank);
        model.baselineLogTotal += baselineResult.logLoss;
        model.baselineBrierTotal += baselineResult.brier;
        lastPrediction = {
          round: entry.round, seat: entry.seat, hand: entry.hand, slot: entry.slot,
          rank: entry.rank, ...baselineResult,
          learnedProbability: learnedResult.probability, learnedTopRank: learnedResult.topRank,
          learnedLogLoss: learnedResult.logLoss, learnedBrier: learnedResult.brier,
        };
        updateCalibration(model, learned, actual);
      }
      if (entry.seat === 0 && entry.slot <= 2) {
        dealers.set(entry.round, { ...dealer, [entry.slot === 1 ? 'up' : 'hole']: entry.rank });
      }
      remove(counts, entry.rank);
      running += countValue(entry.rank);
    }
    const result = { counts, running, scores, lastPrediction, calibration };
    projections.set(state, result);
    return result;
  }

  function mergeScores(first, second) {
    return Object.fromEntries(Object.keys(first).map(name => [name, first[name] + second[name]]));
  }

  function metricsFor(score) {
    const { predictions, topHits, logTotal, brierTotal, contradictions } = score;
    return {
      predictions, topHits, contradictions,
      topAccuracy: predictions ? topHits / predictions : null,
      logLoss: predictions ? logTotal / predictions : null,
      brier: predictions ? brierTotal / predictions : null,
      uniformLogLoss, uniformBrier,
    };
  }

  function learningMetrics(model) {
    const metrics = metricsFor(model.score);
    const { predictions } = metrics;
    return {
      ...metrics,
      updates: model.updates,
      baselineLogLoss: predictions ? model.baselineLogTotal / predictions : null,
      baselineBrier: predictions ? model.baselineBrierTotal / predictions : null,
    };
  }

  function summary(state) {
    const { counts, running, scores, lastPrediction, calibration } = evaluate(state);
    const { complete, mid } = calibration;
    const learningTotal = {
      score: mergeScores(complete.score, mid.score),
      updates: complete.updates + mid.updates,
      baselineLogTotal: complete.baselineLogTotal + mid.baselineLogTotal,
      baselineBrierTotal: complete.baselineBrierTotal + mid.baselineBrierTotal,
    };
    const seen = state.entries.length;
    const unseen = shoeSize - seen;
    return {
      mode: state.mode,
      round: state.round,
      shoe: state.shoe,
      mySeat: state.mySeat,
      counts: counts.slice(),
      seen,
      unseen,
      remaining: state.mode === 'complete' ? unseen : null,
      running,
      trueCount: state.mode === 'complete' && unseen > 0 ? running * 52 / unseen : null,
      canUndo: state.journal.length ? undoIndex(state.journal) >= 0 : Boolean(state.undoShoe),
      lastPrediction: lastPrediction && { ...lastPrediction },
      metrics: {
        ...metricsFor(mergeScores(scores.complete, scores.mid)),
        complete: metricsFor(scores.complete),
        mid: metricsFor(scores.mid),
      },
      learning: {
        ...learningMetrics(learningTotal),
        complete: learningMetrics(complete),
        mid: learningMetrics(mid),
      },
    };
  }

  function forecast(state, target = {}, { seatCount = 7 } = {}) {
    const { counts, calibration } = evaluate(state);
    const current = rows(state);
    const known = dealerKnowledge(current);
    const peek = state.peeks[state.round] ?? 'unknown';
    const probability = chances(counts, { ...target, hand: target.hand ?? 0 }, known, peek);
    const learned = learnedProbabilities(probability, calibration[state.mode].bias);
    const nextDraw = chances(counts, {}, known, peek);
    const best = topIndex(probability);
    const learnedBest = topIndex(learned);
    const leaders = best < 0 ? [] : ranks.filter((_, index) => probability[index] === probability[best]);
    const count = Math.max(1, Math.min(9, Number.isInteger(seatCount) ? seatCount : 7));
    const seats = Array.from({ length: count }, (_, index) => {
      const seat = index + 1;
      const split = state.splits[splitKey(state.round, seat)];
      const seatRows = current.filter(row => row.seat === seat);
      const splitAces = Boolean(split && [0, 1].every(hand =>
        seatRows.some(row => row.hand === hand && row.slot === 1 && row.rank === 'A')));
      const hands = (split ? [0, 1] : [0]).map(hand => {
        const cards = seatRows.filter(row => row.hand === hand)
          .sort((a, b) => a.slot - b.slot).map(row => row.rank);
        const value = handInfo(cards);
        const status = state.statuses[handKey(state.round, seat, hand)] ?? 'playing';
        return {
          hand, cards, total: value.total, soft: value.soft, status,
          splitHand: Boolean(split), splitAces,
          bustProbability: splitAces || status !== 'playing' ? null : bustProbability(cards, nextDraw),
        };
      });
      return { seat, active: hands.some(hand => hand.cards.length > 0), isMine: seat === state.mySeat, hands };
    });
    const dealerCards = current.filter(row => row.seat === 0).sort((a, b) => a.slot - b.slot).map(row => row.rank);
    const dealer = handInfo(dealerCards);
    const hole = known.up && !known.hole ? chances(counts, { seat: 0, hand: 0, slot: 2 }, known, peek) : null;
    return {
      confidenceMode: state.mode,
      ranks: ranks.map((rank, index) => ({ rank, count: counts[index], probability: probability[index] })),
      learnedRanks: ranks.map((rank, index) => ({ rank, count: counts[index], probability: learned[index] })),
      topRank: best < 0 ? null : ranks[best],
      learnedTopRank: learnedBest < 0 ? null : ranks[learnedBest],
      topRanks: leaders,
      seats,
      dealer: {
        cards: dealerCards, total: dealer.total, soft: dealer.soft, peek,
        holeRanks: hole?.map((value, index) => ({ rank: ranks[index], probability: value })) ?? null,
        bustProbability: known.hole && dealer.total < 17 ? bustProbability(dealerCards, nextDraw) : null,
      },
    };
  }

  const api = { create, apply, summary, forecast, rows, ranks, migrateSeatOrder };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackObserver = api;
}(globalThis));
