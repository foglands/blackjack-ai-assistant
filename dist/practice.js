(function (root) {
  'use strict';

  const table = root.TableState || (typeof require === 'function' && require('./table-state.js'));
  const engine = root.BlackjackEngine || (typeof require === 'function' && require('./engine.js'));
  const actionNames = { hit: '要牌', stand: '停牌', double: '加倍', split: '分牌' };
  const statusNames = { playing: '', stood: '停牌', bust: '爆牌', doubled: '加倍结束' };
  const storageKey = 'blackjack-practice-v1';
  const cutAt = 104;
  const seats = [0, 1, 2, 3, 4, 5, 6];

  function shuffle(random = Math.random) {
    const cards = Array.from({ length: 32 }, () => table.ranks).flat();
    for (let index = cards.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [cards[index], cards[other]] = [cards[other], cards[index]];
    }
    return cards;
  }

  function create(random) {
    return {
      table: table.create({ trusted: true }),
      shoe: shuffle(random),
      phase: 'ready',
      shoeNumber: 1,
      settings: { seat: 3, occupied: seats.slice() },
      active: [],
      cursor: 0,
      hand: 0,
      hole: null,
      doubled: [],
      log: [],
      result: [],
      lossRule: 'all',
      last: null,
      stats: { rounds: 0, correct: 0, close: 0, missed: 0 },
    };
  }

  function cloneRound(session) {
    return {
      ...session,
      shoe: session.shoe.slice(),
      log: session.log.slice(),
      doubled: session.doubled.slice(),
      stats: { ...session.stats },
    };
  }

  function record(session, event) {
    session.table = table.apply(session.table, event);
  }

  function draw(session, seat, hand = 0) {
    const rank = session.shoe.pop();
    if (!rank) throw new Error('本靴已经发完，请重新洗牌。');
    if (seat !== null) record(session, { type: 'card', seat, hand, rank });
    return rank;
  }

  function total(cards) {
    return engine.value(cards).total;
  }

  function isNatural(hand) {
    return !hand.splitHand && hand.cards.length === 2 && total(hand.cards) === 21;
  }

  function actionOptions(hand) {
    return hand?.status === 'playing' ? engine.availableActions(hand) : [];
  }

  function handLabel(session, seat, hand) {
    const name = seat === session.table.mySeat ? '你' : `座位 ${seat + 1}`;
    return session.table.seats[seat].length === 2 ? `${name} · 手 ${hand + 1}` : name;
  }

  function chooseOpponent(hand, upcard, lossRule) {
    const options = actionOptions(hand);
    const up = upcard === 'A' ? 11 : total([upcard]);
    const { total: points, soft } = engine.value(hand.cards);
    if (options.includes('split')) {
      const pair = hand.cards[0];
      const canSplit = pair === 'A'
        || (pair === '8' && (up !== 10 || lossRule === 'original'))
        || (pair === '9' && ((up >= 2 && up <= 6) || up === 8 || up === 9))
        || (pair === '7' && up <= 7)
        || (pair === '6' && up >= 3 && up <= 6)
        || (['2', '3'].includes(pair) && up >= 4 && up <= 7);
      if (canSplit) return 'split';
    }
    if (options.includes('double')) {
      if (soft && points >= 13 && points <= 18) {
        const min = [5, 5, 4, 4, 3, 3][points - 13];
        if (up >= min && up <= 6) return 'double';
      }
      if (!soft && (
        (points === 9 && up >= 3 && up <= 6)
        || (points === 10 && up <= 9)
        || (points === 11 && up <= (lossRule === 'original' ? 10 : 9))
      )) return 'double';
    }
    if (soft) return points >= 19 || (points === 18 && up <= 8) ? 'stand' : 'hit';
    return points >= 17 || (points >= 13 && up <= 6) || (points === 12 && up >= 4 && up <= 6)
      ? 'stand' : 'hit';
  }

  function takeAction(session, seat, hand, action) {
    const label = handLabel(session, seat, hand);
    switch (action) {
      case 'hit':
        session.log.push(`${label}要牌，抽到 ${draw(session, seat, hand)}`);
        break;
      case 'stand':
        record(session, { type: 'status', seat, hand, status: 'stood' });
        session.log.push(`${label}停牌`);
        break;
      case 'double':
        session.doubled.push(seat * 2 + hand);
        record(session, { type: 'status', seat, hand, status: 'doubled' });
        session.log.push(`${label}加倍，抽到 ${draw(session, seat, hand)}`);
        break;
      case 'split': {
        record(session, { type: 'split', seat });
        const first = draw(session, seat, 0);
        const second = draw(session, seat, 1);
        session.log.push(`${label}分牌，两手分别补到 ${first}、${second}`);
        break;
      }
      default:
        throw new Error('请选择有效的打法。');
    }
  }

  function settle(session) {
    record(session, { type: 'card', seat: 'dealer', rank: session.hole });
    session.log.push(`庄家翻出底牌 ${session.hole}`);
    const dealerBlackjack = total(session.table.dealerCards) === 21;
    const live = session.active.some(seat => session.table.seats[seat].some(hand => !isNatural(hand) && total(hand.cards) <= 21));
    while (live && total(session.table.dealerCards) < 17) {
      session.log.push(`庄家要牌，抽到 ${draw(session, 'dealer')}`);
    }

    const dealerTotal = total(session.table.dealerCards);
    const own = session.table.mySeat;
    session.result = session.table.seats[own].map((hand, index) => {
      const points = total(hand.cards);
      if (isNatural(hand)) return dealerBlackjack ? 0 : 1.5;
      const stake = session.doubled.includes(own * 2 + index) ? 2 : 1;
      if (dealerBlackjack) return session.lossRule === 'original' ? (index === 0 ? -1 : 0) : -stake;
      if (points > 21) return -stake;
      if (dealerTotal > 21) return stake;
      return stake * Math.sign(points - dealerTotal);
    });
    session.phase = 'complete';
    session.hole = null;
    session.stats.rounds++;
  }

  function advance(session) {
    while (session.cursor < session.active.length) {
      const seat = session.active[session.cursor];
      const hands = session.table.seats[seat];
      if (session.hand >= hands.length) {
        session.cursor++;
        session.hand = 0;
        continue;
      }
      const hand = hands[session.hand];
      if (actionOptions(hand).length === 0) {
        session.hand++;
        continue;
      }
      if (seat === session.table.mySeat) return;
      const action = chooseOpponent(hand, session.table.dealerCards[0], session.lossRule);
      takeAction(session, seat, session.hand, action);
    }
    settle(session);
  }

  function start(session, lossRule = 'all', random) {
    if (session.phase === 'player') return session;
    const next = cloneRound(session);
    const newShoe = next.shoe.length <= cutAt;
    if (newShoe) {
      next.shoe = shuffle(random);
      next.shoeNumber++;
      record(next, { type: 'shoe', trusted: true });
    } else if (session.phase === 'complete') {
      record(next, { type: 'round' });
    }

    const own = next.settings.seat;
    record(next, { type: 'mySeat', seat: own });
    next.active = seats.filter(seat => seat === own || next.settings.occupied.includes(seat));
    next.cursor = 0;
    next.hand = 0;
    next.doubled = [];
    next.log = [newShoe ? '发到练习切牌点，洗牌后开始新局' : '发出起手牌'];
    next.result = [];
    next.last = null;
    next.lossRule = lossRule === 'original' ? 'original' : 'all';
    next.phase = 'player';

    next.active.forEach(seat => draw(next, seat));
    const upcard = draw(next, 'dealer');
    next.active.forEach(seat => draw(next, seat));
    next.hole = draw(next, null);
    if (upcard === 'A') {
      const natural = total([upcard, next.hole]) === 21;
      record(next, { type: 'peek', value: natural ? 'blackjack' : 'clear' });
      next.log.push(natural ? '庄家查牌，确认 Blackjack' : '庄家查牌，确认无 Blackjack');
      if (natural) {
        settle(next);
        return next;
      }
    }

    advance(next);
    return next;
  }

  function scoreAction(session, hand, action, model) {
    const shoe = table.summary(session.table);
    const situation = {
      ...hand,
      dealerCards: session.table.dealerCards,
      addedSplitHand: hand.splitHand && session.hand === 1,
      trueCount: shoe.trueCount,
    };
    const { rows, trials } = engine.evaluate({
      ...situation,
      counts: shoe.counts,
      peek: session.table.peek,
      lossRule: session.lossRule,
      trials: 16000,
    });
    const chosen = rows.find(row => row.action === action);
    const best = rows[0];
    const gap = best.ev - chosen.ev;
    // Both candidates have sampling error. Sum the standard errors to bound
    // the standard error of the difference without assuming independence.
    const close = gap <= 1.96 * (best.stderr + chosen.stderr);
    const grade = chosen.action === best.action ? 'correct' : close ? 'close' : 'missed';
    let ai = null;
    if (model && root.BlackjackTraining) {
      try {
        ai = root.BlackjackTraining.recommend(model, situation);
      } catch {
        // A stale or incompatible model should not interrupt practice.
      }
    }
    return { grade, action, gap, rows, trials, ai, cards: hand.cards, upcard: situation.dealerCards[0] };
  }

  function choose(session, action, model) {
    if (session.phase !== 'player') throw new Error('请先开始一局练习。');
    const seat = session.table.mySeat;
    const hand = session.table.seats[seat][session.hand];
    if (!actionOptions(hand).includes(action)) throw new Error('这手牌不能使用这个动作。');

    const next = cloneRound(session);
    next.last = scoreAction(session, hand, action, model);
    next.stats[next.last.grade]++;
    takeAction(next, seat, next.hand, action);
    advance(next);
    return next;
  }

  function migrateSeatOrder(session) {
    const migratedTable = table.migrateSeatOrder(session.table);
    if (migratedTable === session.table) return session;

    const mirror = table.mirrorSeat;
    return {
      ...session,
      table: migratedTable,
      settings: {
        ...session.settings,
        seat: mirror(session.settings.seat),
        occupied: session.settings.occupied.map(mirror).sort((a, b) => a - b),
      },
      // Keep this round's deal order and cursor so an active hand resumes at the same physical seat.
      active: session.active.map(mirror),
      doubled: session.doubled.map(key => mirror(Math.floor(key / 2)) * 2 + key % 2),
      log: session.log.map(line => line.replace(/^座位 ([1-7])/, (_, seat) => `座位 ${mirror(Number(seat) - 1) + 1}`)),
    };
  }

  function restore() {
    try {
      const session = JSON.parse(root.localStorage.getItem(storageKey));
      if (session?.table?.seats?.length === seats.length && Array.isArray(session.shoe)
        && session.stats && session.settings && ['ready', 'player', 'complete'].includes(session.phase)) {
        const migrated = migrateSeatOrder(session);
        if (migrated !== session) persist(migrated);
        return migrated;
      }
    } catch {
      // Storage can be unavailable when the page is opened from disk.
    }
    return create();
  }

  function persist(session) {
    try { root.localStorage.setItem(storageKey, JSON.stringify(session)); } catch { /* Play continues in memory. */ }
  }

  function escape(value) {
    return String(value).replace(/[&<>"']/g, symbol => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[symbol]);
  }

  function cardMarkup(rank) {
    return `<span class="card${rank === 'A' ? ' ace' : ''}">${escape(rank)}</span>`;
  }

  function signed(value, digits = 2) {
    return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
  }

  function handDescription(hand) {
    if (isNatural(hand)) return 'Blackjack';
    const value = engine.value(hand.cards);
    const status = statusNames[hand.status];
    return `${value.soft ? '软 ' : ''}${value.total}${status ? ` · ${status}` : ''}`;
  }

  function renderSeat(session, seat) {
    const ready = session.phase === 'ready';
    const mine = seat === (ready ? session.settings.seat : session.table.mySeat);
    const acting = mine && session.phase === 'player';
    const hands = session.table.seats[seat];
    const occupied = mine || (ready ? session.settings.occupied : session.active).includes(seat);
    const name = mine ? '本人' : occupied ? `座位 ${seat + 1}` : '空位';
    return `<div class="seat${mine ? ' is-mine' : ''}${acting ? ' is-selected' : ''}">
      <div class="seat-label"><span class="seat-number">${seat + 1}</span><span class="seat-name">${name}</span></div>
      <div class="seat-hands">${hands.filter(hand => hand.cards.length).map((hand, index) => `
        <div class="hand${acting && index === session.hand ? ' is-active' : ''}">
          <span class="cards">${hand.cards.map(cardMarkup).join('')}</span>
          <span class="hand-meta">${hands.length > 1 ? `${index + 1} · ` : ''}${handDescription(hand)}</span>
        </div>`).join('')}</div></div>`;
  }

  function renderReview(last) {
    if (!last) return '<p class="model-note">做出选择后，显示每个动作的模拟期望值和差异。</p>';
    const best = last.rows[0];
    const headline = {
      correct: '你的选择在模拟中排名第一。',
      close: '两个动作的模拟结果很接近，这题不计入正确率。',
      missed: `这一手里，${actionNames[best.action]}的模拟期望值更高。`,
    }[last.grade];
    const reasons = {
      hit: '补牌会改变牌点，也可能爆牌。',
      stand: '停牌保留当前点数，由庄家继续按桌规发牌。',
      double: '加倍后只补一张，收益和亏损以两倍虚拟单位计算。',
      split: '分牌把同点值的两张牌变成两手，分别结算。',
    };
    const ai = last.ai && actionNames[last.ai.action];
    const aiSource = { count: '当前真数组', pooled: '同牌型训练数据', baseline: '基础策略回退' }[last.ai?.source];
    return `<div class="practice-result"><p><strong>${headline}</strong></p>
      <p class="model-note">你拿 ${last.cards.map(escape).join('、')}，庄家明牌 ${escape(last.upcard)}。你选了${actionNames[last.action]}。${reasons[best.action]}</p>
      ${last.gap > 0 ? `<p class="model-note">你的选择比模拟第一低 ${last.gap.toFixed(3)} 虚拟单位。</p>` : ''}
      <div class="result-list">${last.rows.map((row, index) => `<div class="result-row${index === 0 ? ' best' : ''}">
        <span>${actionNames[row.action]}${row.action === last.action ? ' · 你的选择' : ''}</span>
        <div><strong>${signed(row.ev, 3)}</strong><small>± ${row.stderr.toFixed(3)}</small></div></div>`).join('')}</div>
      <p class="model-note">${last.trials.toLocaleString('zh-CN')} 次模拟 · 每 1 虚拟单位的净收益 · ± 为标准误</p>
      ${ai ? `<p class="model-note">AI 策略给出 <strong>${ai}</strong>（${aiSource || '训练模型'}）。</p>` : ''}</div>`;
  }

  function render(element, session, error) {
    const shoe = table.summary(session.table);
    const graded = session.stats.correct + session.stats.missed;
    const accuracy = graded ? `${(session.stats.correct * 100 / graded).toFixed(0)}%` : '—';
    const playing = session.phase === 'player';
    const hand = session.table.seats[session.table.mySeat][session.hand];
    const ownSeat = session.settings.seat;
    const dealer = session.table.dealerCards;
    const handCount = session.table.seats[session.table.mySeat].length;
    const result = session.result.map((units, index) => `${session.result.length > 1 ? `第 ${index + 1} 手 ` : ''}${units > 0 ? '赢' : units < 0 ? '输' : '和'} ${Math.abs(units)} 单位`).join(' · ');
    const dealerDescription = dealer.length > 1 ? ` · ${total(dealer)} 点` : '';
    const nextLabel = session.phase === 'ready' ? '开始练习' : session.shoe.length <= cutAt ? '洗牌并发下一局' : '发下一局';
    element.innerHTML = `<section class="intro"><div><p class="eyebrow">PERSONAL PRACTICE</p><h1>模拟牌桌</h1>
      <p class="subtitle">对手按固定策略依次行动。所有明牌都计入同一副牌靴，模拟底牌在翻开前保留为未知牌。</p></div></section>
      <section class="stats" aria-label="练习统计">
        <article class="stat"><span>练习正确率</span><strong>${accuracy}</strong><small>按模拟排名评分 · ${session.stats.close} 次接近</small></article>
        <article class="stat"><span>已练局数</span><strong>${session.stats.rounds}</strong><small>${graded} 次可区分的选择</small></article>
        <article class="stat"><span>Hi‑Lo 跑数</span><strong>${signed(shoe.running, 0)}</strong><small>牌靴 ${session.shoeNumber} · 已见 ${shoe.seen} 张</small></article>
        <article class="stat"><span>Hi‑Lo 真数</span><strong>${shoe.trueCount === null ? '—' : signed(shoe.trueCount)}</strong><small>还有 ${shoe.remaining} 张未知牌</small></article>
      </section>
      <div class="workspace"><section class="panel table-panel" aria-label="练习牌桌">
        <div class="panel-head"><div><p class="eyebrow">PRACTICE · ROUND ${String(session.table.round).padStart(2, '0')}</p><h2>七座练习桌</h2></div>
          <span class="soft-badge">虚拟单位</span></div>
        <div class="felt"><div class="felt-arc" aria-hidden="true"></div><div class="felt-caption" aria-hidden="true"><span>♠</span><small>BLACKJACK PAYS 3 TO 2</small></div>
          <div class="dealer"><div class="seat-label"><span class="seat-number">D</span><span class="seat-name">庄家${dealerDescription}</span></div>
          <div class="hand"><span class="cards">${dealer.map(cardMarkup).join('')}${dealer.length === 1 ? '<span class="card placeholder" title="未知底牌" aria-label="未知底牌">◆</span>' : ''}</span></div></div>
          <div class="seats">${seats.map(seat => renderSeat(session, seat)).join('')}</div></div>
        <div class="input-area"><div class="practice-commands" aria-live="polite">
          ${playing ? `<div class="input-header"><strong>轮到你${handCount > 1 ? ` · 第 ${session.hand + 1} 手` : ''}</strong></div>
            <div class="entry-actions">${actionOptions(hand).map(action => `<button type="button" class="button accent" data-practice-action="${action}">${actionNames[action]}</button>`).join('')}</div>`
            : `<div class="input-header"><strong>${result || '选择座位后开始发牌'}</strong></div><div class="entry-actions"><button type="button" class="button accent" data-practice-action="start">${nextLabel}</button></div>`}
          <p class="feedback${error ? ' error' : ''}" role="status">${error ? escape(error) : ''}</p></div>
          <div class="practice-options"><label class="setting"><span>本人座位</span><select data-practice-seat ${playing ? 'disabled' : ''}>${seats.map(seat => `<option value="${seat}" ${seat === ownSeat ? 'selected' : ''}>座位 ${seat + 1}</option>`).join('')}</select></label>
          <fieldset ${playing ? 'disabled' : ''}><legend>${session.phase === 'complete' ? '下局参与发牌的座位' : '参与发牌的座位'}</legend>${seats.map(seat => `<label><input type="checkbox" data-practice-occupied="${seat}" ${seat === ownSeat || session.settings.occupied.includes(seat) ? 'checked' : ''} ${seat === ownSeat ? 'disabled' : ''}> ${seat + 1}</label>`).join('')}</fieldset></div>
          <p class="model-note">练习牌靴以剩约两副牌作为切牌点。庄家亮 A 时模拟查牌。当前结算模型为${session.lossRule === 'original' ? '仅输原注' : '追加注也输'}。</p>
        </div></section>
        <aside class="sidebar" aria-label="练习分析"><section class="panel analysis"><div class="panel-head"><div><p class="eyebrow">DECISION REVIEW</p><h2>打法复盘</h2></div></div>
          <div class="analysis-body" aria-live="polite">${renderReview(session.last)}</div></section>
          <section class="panel practice-timeline"><div class="panel-head"><div><p class="eyebrow">TABLE LOG</p><h2>本局动作</h2></div></div>
          <div class="analysis-body">${session.log.length ? `<ol>${session.log.map(line => `<li>${escape(line)}</li>`).join('')}</ol>` : '<p class="model-note">发牌后会显示各座位与庄家的动作。</p>'}</div></section></aside></div>`;
  }

  function mount(element, { getModel = () => null, getLossRule = () => 'all' } = {}) {
    let session = restore();
    let error = '';
    const refresh = () => render(element, session, error);

    element.addEventListener('click', event => {
      const button = event.target.closest('[data-practice-action]');
      if (!button) return;
      const action = button.dataset.practiceAction;
      const keyboard = event.detail === 0;
      try {
        session = action === 'start' ? start(session, getLossRule()) : choose(session, action, getModel(session.lossRule));
        error = '';
        persist(session);
      } catch (failure) {
        error = failure.message;
      }
      refresh();
      if (keyboard) element.querySelector('[data-practice-action]')?.focus();
    });

    element.addEventListener('change', event => {
      if (session.phase === 'player') return;
      const { target } = event;
      const { settings } = session;
      if (target.matches('[data-practice-seat]')) {
        const seat = Number(target.value);
        settings.seat = seat;
        settings.occupied = seats.filter(option => option === seat || settings.occupied.includes(option));
      } else if (target.matches('[data-practice-occupied]')) {
        const seat = Number(target.dataset.practiceOccupied);
        settings.occupied = target.checked ? [...settings.occupied, seat] : settings.occupied.filter(option => option !== seat);
      } else return;
      persist(session);
      const selector = target.matches('[data-practice-seat]') ? '[data-practice-seat]' : `[data-practice-occupied="${target.dataset.practiceOccupied}"]`;
      refresh();
      element.querySelector(selector)?.focus();
    });

    refresh();
    return { refresh };
  }

  const api = { mount, create, start, choose };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackPractice = api;
}(globalThis));
