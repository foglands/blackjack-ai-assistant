(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ranks = TableState.ranks;
  const storageKey = 'blackjack-table-lab:v1';
  const names = { hit: '要牌', stand: '停牌', double: '加倍', split: '分牌' };
  const statusNames = { stood: '停牌', bust: '爆牌', doubled: '加倍' };
  const groupedRanks = [...ranks.slice(0, 9), '10+'];
  const trials = 30000;
  const history = [];
  const confirmDialog = $('confirm-dialog');
  let { state, lossRule, sample, migrated } = restore();
  let target = { seat: state.mySeat, hand: 0 };
  let analysisHand = 0;
  let pendingAction;
  let analysisTimer;
  let analysisKey;
  if (migrated) persist();

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (saved?.state?.seats?.length === 7) {
        const migratedState = TableState.migrateSeatOrder(saved.state);
        return { ...saved, state: migratedState, migrated: migratedState !== saved.state };
      }
    } catch {
      // The workbench also works with storage disabled or cleared.
    }
    return { state: TableState.create(), lossRule: 'all', sample: false };
  }

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ state, lossRule, sample }));
    } catch {
      // Keep the active session usable in browsers without local storage.
    }
  }

  function update(next, message, isSample = sample, nextTarget = target) {
    history.push({ state, target, analysisHand, sample });
    state = next;
    target = nextTarget;
    sample = isSample;
    if (target.seat !== 'dealer' && !state.seats[target.seat][target.hand]) {
      target = { seat: target.seat, hand: 0 };
    }
    if (target.card !== undefined && !cardsAt(state, target)[target.card]) {
      target = { seat: target.seat, hand: target.hand };
    }
    if (!state.seats[state.mySeat][analysisHand]) analysisHand = 0;
    persist();
    render();
    feedback(message);
  }

  function dispatch(event, message) {
    try {
      update(applyEntry(state, event), message);
    } catch (error) {
      feedback(error.message, true);
    }
  }

  function feedback(message = '', error = false) {
    $('feedback').textContent = message;
    $('feedback').classList.toggle('error', error);
  }

  function select(seat, hand = 0, card) {
    target = card === undefined ? { seat, hand } : { seat, hand, card };
    if (seat === state.mySeat) analysisHand = hand;
    feedback();
    render();
  }

  function currentTarget() {
    if (target.seat === 'dealer') return '庄家';
    const own = target.seat === state.mySeat ? ' · 本人' : '';
    const split = state.seats[target.seat].length > 1 ? ` · 手 ${target.hand + 1}` : '';
    return `座位 ${target.seat + 1}${own}${split}`;
  }

  function cardsAt(current, position) {
    return position.seat === 'dealer' ? current.dealerCards : current.seats[position.seat][position.hand].cards;
  }

  function cardMarkup(rank, index, seat, hand = 0) {
    const selected = target.seat === seat && target.hand === hand && target.card === index;
    const label = seat === 'dealer' ? '庄家' : `座位 ${seat + 1}，手 ${hand + 1}`;
    return `<button type="button" class="card card-edit${rank === 'A' ? ' ace' : ''}${selected ? ' is-target-card' : ''}" data-seat="${seat}" data-hand="${hand}" data-card-index="${index}" aria-label="校正${label}第 ${index + 1} 张 ${rank}" aria-pressed="${selected}">${rank}</button>`;
  }

  function cardBack() {
    return '<button type="button" class="card card-edit placeholder" data-seat="dealer" data-hand="0" title="底牌翻开后再录入" aria-label="选择庄家底牌位置">◆</button>';
  }

  function handText(hand) {
    if (!hand.cards.length) return '';
    const { total, soft } = BlackjackEngine.value(hand.cards);
    if (total === 21 && hand.cards.length === 2 && !hand.splitHand) return 'Blackjack';
    const status = statusNames[hand.status];
    return `${soft && total < 21 ? '软 ' : ''}${total}${status ? ` · ${status}` : ''}`;
  }

  function renderTable() {
    const dealerSelected = target.seat === 'dealer';
    $('dealer').classList.toggle('is-selected', dealerSelected);
    const dealerTotal = state.dealerCards.length > 1 ? ` · ${BlackjackEngine.value(state.dealerCards).total} 点` : '';
    $('dealer').innerHTML = `
      <button type="button" class="seat-label" data-seat="dealer" aria-pressed="${dealerSelected}">
        <span class="seat-number">D</span><span class="seat-name">庄家${dealerTotal}</span>
      </button>
      <div class="hand"><span class="cards">${state.dealerCards.map((rank, index) => cardMarkup(rank, index, 'dealer')).join('')}${state.dealerCards.length === 1 ? cardBack() : ''}</span></div>`;

    $('seats').innerHTML = state.seats.map((hands, seat) => {
      const own = seat === state.mySeat;
      const selected = seat === target.seat;
      const label = `座位 ${seat + 1}${own ? '，本人' : ''}`;
      return `<div class="seat${own ? ' is-mine' : ''}${selected ? ' is-selected' : ''}">
        <button type="button" class="seat-label" data-seat="${seat}" aria-label="${label}" aria-pressed="${selected}">
          <span class="seat-number">${seat + 1}</span><span class="seat-name">${own ? '本人' : `座位 ${seat + 1}`}</span>
        </button>
        <div class="seat-hands">${hands.map((hand, index) => {
          if (!hand.cards.length) return '';
          const active = selected && target.hand === index;
          const name = handText(hand);
          return `<div class="hand${active ? ' is-active' : ''}" role="group" aria-label="${label}，手 ${index + 1}">
            <span class="cards">${hand.cards.map((rank, card) => cardMarkup(rank, card, seat, index)).join('')}</span>
            <button type="button" class="hand-meta hand-select" data-seat="${seat}" data-hand="${index}" aria-label="${label}，手 ${index + 1}，录下一张" aria-pressed="${active && target.card === undefined}">${hands.length > 1 ? `${index + 1} · ` : ''}${name}</button>
          </div>`;
        }).join('')}</div>
      </div>`;
    }).join('');
  }

  function renderControls() {
    const cards = cardsAt(state, target);
    const editing = target.card !== undefined;
    $('target-label').textContent = currentTarget();
    $('target-mode').textContent = editing ? '校正牌面' : '录入新牌';
    $('target-mode').classList.toggle('is-correction', editing);
    $('target-detail').textContent = editing ? `第 ${target.card + 1} 张 · 当前 ${cards[target.card]}`
      : target.seat === 'dealer' && cards.length === 1 ? '底牌 · 翻开后录入' : `第 ${cards.length + 1} 张`;
    $('append-button').hidden = !editing;
    $('own-button').hidden = target.seat === 'dealer' || target.seat === state.mySeat;
    for (const button of $('entry-seat-keys').children) {
      const seat = button.dataset.seat === 'dealer' ? 'dealer' : Number(button.dataset.seat);
      button.setAttribute('aria-pressed', String(seat === target.seat));
    }
    const splitControls = (state.seats[target.seat] ?? []).map((_, index, hands) => hands.length > 1
      ? `<button type="button" class="button compact entry-slot-chip" data-seat="${target.seat}" data-hand="${index}" aria-pressed="${index === target.hand}">手 ${index + 1}</button>`
      : '').join('');
    const slots = cards.map((rank, index) => `<button type="button" class="button compact entry-slot-chip" data-seat="${target.seat}" data-hand="${target.hand}" data-card-index="${index}" aria-label="校正第 ${index + 1} 张 ${rank}" aria-pressed="${target.card === index}">${index + 1} · ${rank}</button>`).join('');
    const nextSlot = target.seat === 'dealer' && cards.length === 1 ? '＋ 底牌' : `＋ 第 ${cards.length + 1} 张`;
    $('entry-slots').innerHTML = `${splitControls}${slots}<button type="button" class="button compact entry-slot-chip" data-action="append" aria-label="录下一张牌" aria-pressed="${!editing}">${nextSlot}</button>`;
    const hand = state.seats[target.seat]?.[target.hand];
    const actions = [];
    if (hand?.cards.length >= 2) {
      const allowed = BlackjackEngine.availableActions(hand);
      if (hand.status === 'playing' && allowed.includes('split')) actions.push(['split', '分牌', 'X']);
      if (hand.status === 'playing' && allowed.includes('double')) actions.push(['double', '标记加倍', 'F']);
      if (hand.status === 'playing') actions.push(['stand', '标记停牌', 'S']);
    }
    if (state.dealerCards.length === 1 && state.dealerCards[0] === 'A') {
      if (state.peek === 'unknown') actions.push(['peek', '确认庄家无 Blackjack', 'P']);
      else if (state.peek === 'clear') actions.push(['unpeek', '取消查牌确认', '']);
    }
    $('entry-actions').innerHTML = actions.map(([action, label, key]) =>
      `<button type="button" class="button compact" data-action="${action}">${label}${key ? ` <kbd>${key}</kbd>` : ''}</button>`).join('');
  }

  function renderStats(shoe) {
    const { trusted } = state;
    $('seen').textContent = shoe.seen;
    $('running').textContent = signed(shoe.running, 0);
    $('running-label').textContent = trusted ? 'Hi‑Lo 跑数' : 'Hi‑Lo 部分跑数';
    $('true-count').textContent = trusted && shoe.trueCount !== null ? signed(shoe.trueCount, 2) : '—';
    $('true-count-detail').textContent = trusted ? '跑数 ÷ 剩余未知牌副数' : '缺少完整记录';
    $('coverage').textContent = sample ? '示例牌靴' : trusted ? '完整牌靴 · 从洗牌起记录' : '部分记录 · 中途入桌或漏牌';
    $('remaining-label').textContent = trusted ? '未见牌数' : '牌靴剩余深度';
    $('remaining').textContent = trusted ? shoe.remaining : '未知';
    $('remaining-detail').textContent = trusted ? '含尚未翻开的牌' : '缺少入桌前或漏记的牌';
    $('round-label').textContent = `ROUND ${String(state.round).padStart(2, '0')}${sample ? '  /  DEMO' : ''}`;
    $('gap-button').disabled = !trusted;
    document.querySelector('[data-action="new-shoe"]').setAttribute('aria-pressed', String(trusted));
    document.querySelector('[data-action="join-shoe"]').setAttribute('aria-pressed', String(!trusted));
    document.querySelector('[data-action="undo"]').disabled = history.length === 0;
    renderDistribution(shoe, trusted);
  }

  function renderDistribution(shoe, trusted) {
    $('composition-kicker').textContent = trusted ? 'SHOE COMPOSITION' : 'OBSERVED CARDS';
    $('composition-title').textContent = trusted ? '未见牌分布' : '已录牌分布';
    $('composition-note').textContent = trusted
      ? '10 点牌合计包括 10、J、Q、K。底牌在翻开前计入未见牌。'
      : '包括本靴各局已录的牌，柱长按最高已录张数缩放。';
    const observed = Object.fromEntries(ranks.map(rank => [rank, 0]));
    if (!trusted) {
      const cards = [...state.priorCards, ...state.dealerCards, ...state.seats.flatMap(hands => hands.flatMap(hand => hand.cards))];
      for (const rank of cards) observed[rank] += 1;
    }
    const observedMax = Math.max(1, ...Object.values(observed));
    const labels = trusted ? groupedRanks : ranks;
    $('distribution').innerHTML = labels.map((rank, index) => {
      const count = trusted ? shoe.counts[index] : observed[rank];
      const fraction = count / (trusted ? (rank === '10+' ? 128 : 32) : observedMax);
      return `<div class="bar-item" aria-label="${rank}，${trusted ? '未见' : '已录'} ${count} 张"><b>${count}</b><div class="bar-track"><i style="--fraction:${fraction}"></i></div><small>${rank}</small></div>`;
    }).join('');
  }

  function signed(value, digits) {
    const number = Number(value.toFixed(digits));
    return `${number > 0 ? '+' : ''}${number.toFixed(digits)}`;
  }

  function renderAnalysis(shoe) {
    const hands = state.seats[state.mySeat];
    const hand = hands[analysisHand];
    $('model-seat').textContent = `座位 ${state.mySeat + 1}${hands.length > 1 ? ` · 手 ${analysisHand + 1}` : ''}`;
    $('analysis-hands').innerHTML = hands.length > 1 ? hands.map((_, index) =>
      `<button type="button" class="button compact" data-model-hand="${index}" aria-pressed="${analysisHand === index}">分析手 ${index + 1}</button>`).join('') : '';
    $('model-note').textContent = state.trusted
      ? '用录入的可见牌估算单手净收益。后续动作采用固定策略；表中 ± 为约 95% 的抽样误差。'
      : '估值假设未见旧牌随机分布，对其取平均。两种模式的已录牌相同时，估值可以相同。后续动作采用固定策略；± 为约 95% 的模拟抽样误差。';
    // Under the neutral shuffle prior, unseen old cards and future positions are exchangeable.
    // Drawing from all unobserved ranks averages over the unknown cards already removed.
    const model = {
      ...hand, addedSplitHand: analysisHand === 1, counts: shoe.counts,
      dealerCards: state.dealerCards, peek: state.peek, lossRule, trials,
    };
    const nextKey = JSON.stringify(model);
    if (analysisKey === nextKey) return;
    analysisKey = nextKey;
    clearTimeout(analysisTimer);

    if (!state.dealerCards.length || hand.cards.length < 2) {
      empty('等待起手牌', '先录入你的两张牌和庄家明牌。其他座位的可见牌会一起计入。');
    } else if (state.dealerCards.length > 1 || state.peek === 'blackjack') {
      empty('庄家已翻牌', '把这局剩余可见牌录完，再进入下一局。');
    } else if (hand.status !== 'playing') {
      empty('这手已完成操作', '分牌后可以切换另一手查看。');
    } else if (state.dealerCards[0] === 'A' && state.peek === 'unknown') {
      empty('等待庄家查底牌', '庄家亮 A 且确认没有 Blackjack 时，按 P 或点「确认庄家无 Blackjack」。');
    } else {
      empty('正在推算…', '按已录牌与庄家信息，无放回模拟后续抽牌。');
      analysisTimer = setTimeout(() => {
        try {
          const started = performance.now();
          const result = BlackjackEngine.evaluate(model);
          showResults(result, performance.now() - started);
        } catch (error) {
          empty('无法推算', error.message);
        }
      }, 0);
    }
  }

  function empty(title, copy) {
    const box = document.createElement('div');
    box.className = 'empty-state';
    const heading = document.createElement('strong');
    const detail = document.createElement('p');
    heading.textContent = title;
    detail.textContent = copy;
    box.append(heading, detail);
    $('analysis-results').replaceChildren(box);
  }

  function showResults(result, elapsedMs) {
    const rows = [...result.rows].sort((a, b) => b.ev - a.ev);
    if (!rows.length) return empty('这手没有待选动作', '请核对录入的牌和手牌状态。');
    const [best, next] = rows;
    const close = next && best.ev - next.ev <= 1.96 * (best.stderr + next.stderr);
    const chance = result.dealerBlackjackProbability;
    $('analysis-results').innerHTML = `<p class="result-summary"><strong>${close ? '最前两项估值接近' : `最高估值 · ${names[best.action]}`}</strong><span>每 1 单位原注</span></p>
      <div class="result-list">${rows.map((row, index) => `<div class="result-row${index === 0 && !close ? ' best' : ''}">
        <strong>${names[row.action]}</strong><div><strong>${signed(row.ev, 3)}</strong><small>± ${(1.96 * row.stderr).toFixed(3)}</small></div>
      </div>`).join('')}</div>
      <p class="model-note">每个动作模拟 ${result.trials.toLocaleString('zh-CN')} 次 · 本次计算 ${elapsedMs.toFixed(1)} 毫秒${chance > 0 ? ` · 庄家 Blackjack 约 ${(100 * chance).toFixed(1)}%` : ''}。</p>`;
  }

  function render() {
    const shoe = TableState.summary(state);
    renderStats(shoe);
    renderTable();
    renderControls();
    renderAnalysis(shoe);
  }

  function withHand(current, position, changes) {
    const seats = current.seats.slice();
    const hands = seats[position.seat].slice();
    const hand = position.hand ?? 0;
    hands[hand] = { ...hands[hand], ...changes };
    seats[position.seat] = hands;
    return { ...current, seats };
  }

  function withCards(current, position, cards, changes) {
    if (position.seat === 'dealer') return { ...current, dealerCards: cards };
    return withHand(current, position, { ...changes, cards });
  }

  function applyEntry(current, event) {
    const next = TableState.apply(current, event);
    return event.type === 'status' ? withHand(next, event, { enteredStatus: event.status }) : next;
  }

  function correctRank(rank) {
    const position = target;
    const cards = cardsAt(state, position);
    if (cards[position.card] === rank) return select(position.seat, position.hand);
    const replacement = cards.slice();
    replacement[position.card] = rank;
    const hand = state.seats[position.seat]?.[position.hand];
    const automaticStand = hand?.status === 'stood' &&
      (BlackjackEngine.value(cards).total === 21 || (hand.splitAces && cards.length >= 2));
    const legacyEnteredStatus = hand?.status === 'doubled' || (hand?.status === 'stood' && !automaticStand) ? hand.status : undefined;
    const enteredStatus = hand?.enteredStatus ?? legacyEnteredStatus;
    const splitAces = Boolean(hand?.splitHand && replacement[0] === 'A');
    const status = enteredStatus ?? (splitAces && cards.length >= 2 ? 'stood' : 'playing');
    const otherCards = cards.filter((_, index) => index !== position.card);
    try {
      // Temporarily remove the old rank so the normal shoe limit and hand
      // status logic can validate the replacement before restoring its order.
      const checked = TableState.apply(withCards(state, position, otherCards, { status, splitAces, enteredStatus }), { type: 'card', ...position, rank });
      let next = withCards(checked, position, replacement);
      if (position.seat === 'dealer' && position.card === 0) {
        next = TableState.apply(next, { type: 'peek', value: 'unknown' });
      }
      update(next, `${currentTarget()}第 ${position.card + 1} 张已改为 ${rank}。`, sample, { seat: position.seat, hand: position.hand });
    } catch (error) {
      feedback(error.message, true);
    }
  }

  function addRank(rank) {
    if (target.card !== undefined) return correctRank(rank);
    dispatch({ type: 'card', rank, ...target }, `${currentTarget()}已录入 ${rank}。`);
  }

  function undo() {
    const previous = history.pop();
    if (!previous) return feedback('当前会话没有可撤销的录入。');
    ({ state, target, analysisHand, sample } = previous);
    persist();
    render();
    feedback('已撤销上一步。');
  }

  function ask(title, copy, action) {
    $('confirm-title').textContent = title;
    $('confirm-copy').textContent = copy;
    pendingAction = action;
    confirmDialog.returnValue = 'cancel';
    confirmDialog.showModal();
  }

  function startShoe(trusted) {
    const title = trusted ? '从完整牌靴开始' : '从中途入桌开始';
    const copy = trusted ? '洗牌后从第一张可见牌录起。' : '从当前看得见的牌录起，牌靴剩余深度和真数将隐藏。';
    const start = () => update(TableState.apply(state, { type: 'shoe', trusted }), copy, false);
    if (!TableState.summary(state).seen) return start();
    ask(title, `${copy} 确认后会开启新记录，清空当前牌桌和已有计数。可以用撤销恢复。`, start);
  }

  function nextRound() {
    const shoe = TableState.summary(state);
    const onTable = shoe.seen > state.priorCards.length;
    const partial = onTable && state.dealerCards.length < 2;
    let next = TableState.apply(state, { type: 'round' });
    if (partial) next = TableState.apply(next, { type: 'trust', value: false });
    update(next, partial && state.trusted ? '已开始下一局。上一局庄家牌未录全，已切换为部分记录。' : '已开始下一局，本靴计数已保留。');
  }

  function demo() {
    const load = () => {
      let next = TableState.create({ trusted: true });
      const apply = (event) => { next = applyEntry(next, event); };
      const add = (seat, cards, hand = 0) => cards.forEach(rank => apply({ type: 'card', rank, seat, hand }));
      add('dealer', ['6', 'K', '5']);
      add(4, ['4', '5', '9']);
      add(3, ['A', '9']);
      apply({ type: 'round' });
      add('dealer', ['10']);
      const deals = [['Q', 'K'], ['4', '2'], ['J', '7'], ['6', '5'], ['A', '7'], ['8', '8'], ['K', '6']];
      deals.forEach((cards, seat) => add(seat, cards));
      add(6, ['5']);
      apply({ type: 'split', seat: 5 });
      add(5, ['2', '9']);
      add(5, ['3', 'Q'], 1);
      apply({ type: 'status', seat: 5, hand: 0, status: 'stood' });
      apply({ type: 'status', seat: 4, hand: 0, status: 'stood' });
      update(next, '已载入七座示例，可直接试用快捷键。', true);
      target = { seat: next.mySeat, hand: 0 };
      analysisHand = 0;
      render();
    };
    if (!TableState.summary(state).seen || sample) return load();
    ask('载入示例', '示例将替换当前牌桌和牌靴记录。可以用撤销恢复。', load);
  }

  function act(action) {
    const hand = state.seats[target.seat]?.[target.hand];
    switch (action) {
      case 'demo': return demo();
      case 'undo': return undo();
      case 'append': return select(target.seat, target.hand);
      case 'new-shoe': return startShoe(true);
      case 'join-shoe': return startShoe(false);
      case 'round': return nextRound();
      case 'gap': return dispatch({ type: 'trust', value: false }, '已切换为部分记录。本靴已录牌保留，余量和真数隐藏。');
      case 'own':
        if (target.seat !== 'dealer') {
          analysisHand = target.hand;
          dispatch({ type: 'mySeat', seat: target.seat }, `已设座位 ${target.seat + 1} 为本人。`);
        }
        return;
      case 'split':
        if (hand?.status === 'playing' && BlackjackEngine.availableActions(hand).includes('split')) {
          return dispatch({ type: 'split', seat: target.seat }, '已分牌。原来的两张牌各留一手，计数不变。');
        }
        return feedback('请选择一手可以分牌的起手牌。', true);
      case 'double':
      case 'stand': {
        const allowed = hand?.status === 'playing' ? BlackjackEngine.availableActions(hand) : [];
        if (!allowed.includes(action)) return feedback('该手当前没有这个动作。', true);
        const status = action === 'double' ? 'doubled' : 'stood';
        return dispatch({ type: 'status', ...target, status }, `已标记${names[action]}。${action === 'double' ? '请录入加倍后补的那张牌。' : ''}`);
      }
      case 'peek':
        if (state.dealerCards.length === 1 && state.dealerCards[0] === 'A' && state.peek === 'unknown') {
          return dispatch({ type: 'peek', value: 'clear' }, '已确认庄家底牌不是 10 点牌。');
        }
        return;
      case 'unpeek': return dispatch({ type: 'peek', value: 'unknown' }, '已取消查牌确认。');
    }
  }

  confirmDialog.addEventListener('close', () => {
    if (confirmDialog.returnValue === 'confirm') pendingAction?.();
    pendingAction = undefined;
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const { seat, hand, cardIndex, rank, action, modelHand } = button.dataset;
    if (seat !== undefined) {
      select(seat === 'dealer' ? seat : Number(seat), Number(hand ?? 0), cardIndex === undefined ? undefined : Number(cardIndex));
    }
    if (rank) addRank(rank);
    if (action) act(action);
    if (event.detail === 0 && (hand !== undefined || action === 'append')) {
      $('rank-keys').querySelector('button')?.focus({ preventScroll: true });
    }
    if (modelHand !== undefined) {
      analysisHand = Number(modelHand);
      renderAnalysis(TableState.summary(state));
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || confirmDialog.open) return;
    if (event.target.closest?.('input, select, textarea, [contenteditable]')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'z') {
      event.preventDefault();
      return undo();
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.shiftKey && /^Digit[1-7]$/.test(event.code)) {
      event.preventDefault();
      return select(Number(event.code.at(-1)) - 1);
    }
    if (event.shiftKey) return;
    if (key === 'escape' && target.card !== undefined) {
      event.preventDefault();
      return act('append');
    }
    const rank = key === 't' || key === '0' ? '10' : key.toUpperCase();
    if (ranks.includes(rank)) {
      event.preventDefault();
      return addRank(rank);
    }
    const action = { x: 'split', s: 'stand', f: 'double', n: 'round', p: 'peek' }[key];
    if (action) {
      event.preventDefault();
      return act(action);
    }
    if (key === 'd') return select('dealer');
    if ((key === '[' || key === ']') && state.seats[target.seat]?.length > 1) {
      select(target.seat, key === ']' ? 1 : 0);
    }
  });

  $('loss-rule').value = lossRule;
  $('loss-rule').addEventListener('change', (event) => {
    lossRule = event.target.value;
    persist();
    renderAnalysis(TableState.summary(state));
  });

  $('entry-seat-keys').innerHTML = ['dealer', ...Array.from(state.seats.keys()).reverse()].map(seat => {
    const label = seat === 'dealer' ? '庄家' : `座位 ${seat + 1}`;
    return `<button type="button" class="button compact entry-seat-key" data-seat="${seat}" aria-pressed="false" aria-label="选择${label}">${label}</button>`;
  }).join('');
  $('rank-keys').innerHTML = ranks.map(rank => `<button type="button" class="button rank-key" data-rank="${rank}" aria-label="选择 ${rank}">${rank}</button>`).join('');
  render();
})();
