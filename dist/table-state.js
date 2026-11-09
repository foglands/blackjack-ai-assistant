(function () {
  'use strict';

  const ranks = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
  const seatCount = 7;
  const copiesPerRank = 32;
  const shoeSize = ranks.length * copiesPerRank;
  const seatOrder = 'right-to-left';

  function newHand(cards = [], splitHand = false, splitAces = false) {
    return { cards, status: 'playing', splitHand, splitAces };
  }

  function create({ trusted = false } = {}) {
    return {
      seatOrder,
      trusted: Boolean(trusted),
      round: 1,
      seats: Array.from({ length: seatCount }, () => [newHand()]),
      dealerCards: [],
      peek: 'unknown',
      priorCards: [],
      mySeat: 3,
    };
  }

  function checkSeat(seat) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= seatCount) {
      throw new Error('请选择 1 到 7 号座位。');
    }
  }

  function mirrorSeat(seat) {
    checkSeat(seat);
    return seatCount - 1 - seat;
  }

  function migrateSeatOrder(state) {
    if (state.seatOrder === seatOrder) return state;
    return { ...state, seatOrder, seats: state.seats.slice().reverse(), mySeat: mirrorSeat(state.mySeat) };
  }

  function checkHand(state, seat, hand) {
    checkSeat(seat);
    if (!Number.isInteger(hand) || !state.seats[seat][hand]) {
      throw new Error('这个座位没有这手牌。');
    }
  }

  function rankIndex(rank) {
    const index = ranks.indexOf(rank);
    if (index < 0) throw new Error('请选择 A、2 至 10、J、Q 或 K。');
    return index;
  }

  function cardPoints(rank) {
    return Math.min(rankIndex(rank) + 1, 10);
  }

  function handTotal(cards) {
    const hard = cards.reduce((sum, rank) => sum + cardPoints(rank), 0);
    return cards.includes('A') && hard <= 11 ? hard + 10 : hard;
  }

  function roundCards(state) {
    return [...state.dealerCards, ...state.seats.flatMap(hands => hands.flatMap(hand => hand.cards))];
  }

  function recordedCards(state) {
    return [...state.priorCards, ...roundCards(state)];
  }

  function withSeat(state, seat, hands) {
    const seats = state.seats.slice();
    seats[seat] = hands;
    return { ...state, seats };
  }

  function withHand(state, seat, hand, data) {
    const hands = state.seats[seat].slice();
    hands[hand] = data;
    return withSeat(state, seat, hands);
  }

  function addCard(state, { rank, seat, hand = 0 }) {
    rankIndex(rank);
    const copies = recordedCards(state).filter(card => card === rank).length;
    if (copies >= copiesPerRank) {
      throw new Error(`八副牌里只有 ${copiesPerRank} 张 ${rank}，请检查重复录入或是否已洗牌。`);
    }

    if (seat === 'dealer') return { ...state, dealerCards: [...state.dealerCards, rank] };

    checkHand(state, seat, hand);
    const current = state.seats[seat][hand];
    const cards = [...current.cards, rank];
    const total = handTotal(cards);
    let status = current.status;
    if (total > 21) status = 'bust';
    else if (status === 'playing' && (total === 21 || (current.splitAces && cards.length === 2))) {
      status = 'stood';
    }
    return withHand(state, seat, hand, { ...current, cards, status });
  }

  function splitSeat(state, seat) {
    checkSeat(seat);
    const hands = state.seats[seat];
    if (hands.length !== 1) throw new Error('真人 Classic 每个座位每局只能分牌一次。');

    const { cards } = hands[0];
    if (cards.length !== 2 || cardPoints(cards[0]) !== cardPoints(cards[1])) {
      throw new Error('分牌需要起手两张点值相同的牌。');
    }
    const splitAces = cards[0] === 'A';
    return withSeat(state, seat, cards.map(card => newHand([card], true, splitAces)));
  }

  function apply(state, event) {
    switch (event.type) {
      case 'card':
        return addCard(state, event);
      case 'split':
        return splitSeat(state, event.seat);
      case 'status': {
        const { seat, hand = 0, status } = event;
        checkHand(state, seat, hand);
        if (!['playing', 'stood', 'bust', 'doubled'].includes(status)) {
          throw new Error('请选择有效的手牌状态。');
        }
        return withHand(state, seat, hand, { ...state.seats[seat][hand], status });
      }
      case 'round': {
        const next = create({ trusted: state.trusted });
        return {
          ...next,
          round: state.round + 1,
          mySeat: state.mySeat,
          priorCards: recordedCards(state),
        };
      }
      case 'shoe':
        return { ...create({ trusted: event.trusted }), mySeat: state.mySeat };
      case 'peek':
        if (!['unknown', 'clear', 'blackjack'].includes(event.value)) {
          throw new Error('请选择有效的庄家查牌状态。');
        }
        return { ...state, peek: event.value };
      case 'mySeat':
        checkSeat(event.seat);
        return { ...state, mySeat: event.seat };
      case 'trust':
        return { ...state, trusted: Boolean(event.value) };
      default:
        throw new Error('无法识别这个牌桌操作。');
    }
  }

  function summary(state) {
    // Hidden cards stay in this distribution until a visible rank is recorded.
    const counts = [32, 32, 32, 32, 32, 32, 32, 32, 32, 128];
    const cards = recordedCards(state);
    let running = 0;
    for (const rank of cards) {
      const points = cardPoints(rank);
      counts[points - 1] -= 1;
      if (points >= 2 && points <= 6) running += 1;
      else if (points === 1 || points === 10) running -= 1;
    }
    const remaining = shoeSize - cards.length;
    return {
      counts,
      seen: cards.length,
      running,
      trueCount: remaining > 0 ? running * 52 / remaining : null,
      remaining,
    };
  }

  const api = { create, apply, summary, ranks, mirrorSeat, migrateSeatOrder };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.TableState = api;
})();
