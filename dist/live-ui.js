(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const observer = window.BlackjackObserver;
  const preview = $('live-preview-canvas');
  const overlay = $('live-crop-overlay');
  const guideOverlay = $('live-guide-overlay');
  const anchorOverlay = $('live-anchor-overlay');
  const anchorSeat = $('live-anchor-seat');
  const anchorSlot = $('live-anchor-slot');
  const anchorFlip = $('live-anchor-flip');
  const anchorInvert = $('live-anchor-invert');
  const layoutPicker = $('live-layout-picker');
  const layoutName = $('live-layout-name');
  const layoutSeatCount = $('live-layout-seat-count');
  const layoutPublicGlyphs = $('live-layout-public-glyphs');
  const ledger = $('live-ledger');
  const felt = $('live-felt');
  const seatPicker = $('live-editor-seat');
  const handPicker = $('live-editor-hand');
  const slotPicker = $('live-editor-slot');
  const seatShortcuts = $('live-seat-shortcuts');
  const slotStrip = $('live-slot-strip');
  const rankKeys = $('live-ranks');
  const justSeen = $('live-just-seen');
  const confirm = $('live-confirm');
  const fields = ['x', 'y', 'width', 'height'];
  const storageKey = 'blackjack-lab:observer:v1';
  const defaultLayout = { id: 'classic', name: '内置 Classic 参考', builtin: true, canStart: true, canSave: false, seats: [] };
  const cropInputs = Object.fromEntries(fields.map(field => [field, $(`live-crop-${field}`)]));
  const wholeWindow = { x: 0, y: 0, width: 1, height: 1 };
  const slotLimit = 21;
  const cssRanks = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);

  if (!observer) {
    $('live-start').disabled = true;
    $('live-capture-feedback').textContent = '无法载入观察模式，请检查桌面应用文件。';
    return;
  }

  let ledgerLayoutId = defaultLayout.id;
  let layoutOptionsKey = '';
  let paintedSeatCount = 0;
  let saveMigratedSeats = false;
  let state = restoreState();
  let summary = observer.summary(state);
  let current = observer.rows(state);
  let target = { seat: summary.mySeat, hand: 0, slot: firstOpen(summary.mySeat, 0) ?? slotLimit };
  let projection = null;
  let source = null;
  let aligned = false;
  let choosing = false;
  let crop = wholeWindow;
  let drag = null;
  let anchorDrag = null;
  let showGuide = true;
  let guideKey = '';
  let anchoring = false;
  let captureStatus = 'idle';
  let previewFrames = 0;
  let autoConfirmed = 0;
  let autoWritten = 0;
  let publicConfirmed = 0;
  let scanDiagnostics = null;
  let openingStates = [];
  const unreadOpeners = new Set();
  let lastDiagnosticsAt = -Infinity;
  let frameDeliveryMs = null;
  let pendingConfirm = null;
  let frameCount = 0;
  let totalTimes = [];
  let lastPreviewAt = -Infinity;
  let lastMetricsAt = -Infinity;
  let lastConfirmationMs = null;
  let saveTimer = null;

  const capture = window.BlackjackLiveCapture?.create({ onFrame, onStatus, onReady, onTiming });

  function ledgerKey() {
    return ledgerLayoutId === defaultLayout.id ? storageKey : `${storageKey}:${ledgerLayoutId}`;
  }

  function restoreState() {
    try {
      const saved = JSON.parse(localStorage.getItem(ledgerKey()));
      if (saved?.version === 1 && Array.isArray(saved.entries) && Array.isArray(saved.journal)) {
        const migrated = observer.migrateSeatOrder(saved);
        observer.summary(migrated);
        saveMigratedSeats = migrated !== saved;
        return migrated.mode === 'complete' ? observer.apply(migrated, { type: 'gap', source: 'auto' }) : migrated;
      }
    } catch {
      // A clean local session remains available if the saved state cannot be loaded.
    }
    return observer.create({ mode: 'mid', mySeat: 4 });
  }

  function saveState() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    try {
      localStorage.setItem(ledgerKey(), JSON.stringify(state));
      setText('live-storage-note', '牌靴记录和学习模型按布局保存在本机。');
    } catch {
      setText('live-storage-note', '本机存储不可用，关闭窗口前请保留所需数据。');
    }
  }

  function setText(id, value) { $(id).textContent = value; }
  function seatName(seat) { return seat === 0 ? '庄家' : `座位 ${seat}`; }
  function positionName({ seat, hand, slot }) { return `${seatName(seat)}${seat ? ` · 手 ${hand + 1}` : ''} · 第 ${slot} 张`; }
  function signed(value, digits = 0) { return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`; }
  function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—'; }
  function ms(value, digits = 1) { return Number.isFinite(value) ? `${value.toFixed(digits)} ms` : '—'; }
  function statusName(status) { return { stood: '停牌', doubled: '加倍结束', bust: '爆牌' }[status] ?? ''; }
  function placeKey({ seat, hand, slot }) { return `${seat}:${hand}:${slot}`; }
  function samePlace(a, b) { return placeKey(a) === placeKey(b); }
  function selectedRow() { return current.find(row => samePlace(row, target)); }

  function editorMessage(text, error = false) {
    setText('live-editor-feedback', text);
    $('live-editor-feedback').classList.toggle('error', error);
  }

  function captureMessage(text, error = false) {
    setText('live-capture-feedback', text);
    $('live-capture-feedback').classList.toggle('error', error);
  }

  function layoutStatus(rect = source ? crop : undefined) {
    return capture?.layoutStatus?.(rect) ?? defaultLayout;
  }

  function seatLimit(layout = layoutStatus()) {
    return !layout.builtin && Number.isInteger(layout.seatCount) ? Math.max(1, Math.min(9, layout.seatCount)) : 7;
  }

  function switchLedger(id, flush = true) {
    if (id === ledgerLayoutId) return;
    if (flush || saveTimer !== null) saveState();
    ledgerLayoutId = id;
    saveMigratedSeats = false;
    openingStates = [];
    unreadOpeners.clear();
    setState(restoreState());
    target = { seat: summary.mySeat, hand: 0, slot: firstOpen(summary.mySeat, 0) ?? slotLimit };
    $('live-just-seen').checked = false;
  }

  function updateSeatPickers(count) {
    if (paintedSeatCount === count) return;
    paintedSeatCount = count;
    for (const picker of [seatPicker, anchorSeat]) {
      const selected = Number(picker.value);
      picker.replaceChildren(...Array.from({ length: count + 1 }, (_, seat) => {
        const option = document.createElement('option');
        option.value = String(seat);
        option.textContent = seatName(seat);
        return option;
      }));
      picker.value = String(selected >= 0 && selected <= count ? selected : Math.ceil(count / 2));
    }
  }

  function fitFocus(count) {
    if (summary.mySeat > count) setState(observer.apply(state, { type: 'mySeat', seat: Math.ceil(count / 2) }));
    if (target.seat > count) target = { seat: summary.mySeat, hand: 0, slot: firstOpen(summary.mySeat, 0) ?? slotLimit };
  }

  function syncAnchorOrientation(layout = layoutStatus()) {
    const info = layout.seats.find(seat => seat.seat === Number(anchorSeat.value));
    anchorFlip.checked = Boolean(info?.flip);
    anchorInvert.checked = Boolean(info?.invert);
  }

  function supportsPublicGlyphs(layout) {
    return !layout.builtin && Boolean(layout.publicGlyphsAvailable && capture?.setLayoutPublicGlyphs);
  }

  function paintLayoutControls(layout) {
    const layouts = capture?.listLayouts?.() ?? [defaultLayout];
    const choices = layouts.some(entry => entry.id === layout.id) ? layouts : [...layouts, layout];
    const nextKey = JSON.stringify([choices.map(({ id, name }) => [id, name]), layout.id, layout.dirty]);
    if (nextKey !== layoutOptionsKey) {
      layoutOptionsKey = nextKey;
      layoutPicker.replaceChildren(...choices.map(entry => {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = `${entry.name}${entry.id === layout.id && layout.dirty ? ' · 未保存' : ''}`;
        return option;
      }));
    }
    layoutPicker.value = layout.id;
    layoutPicker.disabled = aligned || choosing || !capture?.selectLayout;
    layoutName.disabled = choosing || !capture?.newLayout;
    $('live-layout-new').disabled = aligned || choosing || !capture?.newLayout;
    $('live-layout-save').disabled = layout.builtin || !layout.canSave || !capture?.saveLayout;
    $('live-layout-seat-count-field').hidden = layout.builtin;
    layoutSeatCount.disabled = layout.builtin || aligned || choosing || !capture?.setLayoutSeatCount;
    layoutSeatCount.value = String(seatLimit(layout));
    const publicGlyphsAvailable = supportsPublicGlyphs(layout);
    $('live-layout-public-glyphs-field').hidden = !publicGlyphsAvailable;
    layoutPublicGlyphs.disabled = !publicGlyphsAvailable || aligned || choosing;
    layoutPublicGlyphs.checked = Boolean(layout.publicGlyphs);

    const coverage = $('live-layout-coverage');
    coverage.hidden = layout.builtin;
    const missing = layout.missingPrimaryRanks ?? [];
    const glyphNote = missing.length ? ` 首选字形缺少 ${missing.join('、')}。${layout.publicGlyphs ? '已启用公开样本作为辅助。' : '看到这些牌时可手动选牌点后保存字形。'}` : '';
    if (layout.builtin) {
      const trackingNote = layout.id === 'classic-front' ? '适用于正面看见完整桌面和两侧座位的取景，按画面定位牌点。'
        : layout.id === 'classic-close' ? '每局会自动重新寻找各座位的首牌位置。' : '';
      setText('live-layout-note', trackingNote + (aligned
        ? '要切换布局，先点「框选画面」暂停自动识牌。各布局的牌靴记录分开保存。'
        : '参考布局适用于相近的桌面取景。不同取景可新建自定义布局，名称仅用于区分。') + glyphNote);
      return;
    }
    const bySeat = new Map(layout.seats.map(seat => [seat.seat, seat.points]));
    coverage.replaceChildren(...Array.from({ length: seatLimit(layout) + 1 }, (_, seat) => {
      const points = bySeat.get(seat) ?? [];
      const chip = document.createElement('span');
      chip.dataset.marked = String(points.includes(1));
      chip.textContent = `${seatName(seat)} · ${points.length ? `已标 ${points.join('、')}` : '待标'}`;
      return chip;
    }));
    const readiness = layout.canStart ? '已具备启动条件。' : layout.message || '先标庄家和至少一位玩家的第 1 张牌点。';
    const switching = aligned ? ' 切换前先点「框选画面」。' : '';
    setText('live-layout-note', `${readiness} 未标首牌的座位跳过自动扫描。只标首牌时仅扫首牌，标第 2 张可定后续方向。庄家第 2 张未标时请手动换局。${switching}${glyphNote}`);
  }

  function useLayout(action) {
    if (aligned || choosing) return;
    try {
      const result = action();
      if (!result?.ok) throw new Error(result?.message || '无法切换识牌布局。');
      const layout = layoutStatus();
      switchLedger(layout.id);
      fitFocus(seatLimit(layout));
      layoutName.value = layout.builtin ? '' : layout.name;
      anchoring = false;
      if (source) enterAlignment(capture.getCrop() ?? layout.crop ?? wholeWindow);
      else paintCaptureControls();
      syncAnchorOrientation(layout);
      captureMessage(result.message || `已选择 ${layout.name}。`);
      render();
    } catch (error) {
      captureMessage(error.message, true);
      paintCaptureControls();
    }
  }

  function saveLayout() {
    const layout = layoutStatus();
    if (layout.builtin || !layout.canSave || !capture?.saveLayout) return;
    try {
      const result = capture.saveLayout(layoutName.value.trim() || undefined, source ? crop : undefined);
      if (!result?.ok) throw new Error(result?.message || '无法保存布局。');
      layoutName.value = layoutStatus().name;
      captureMessage(result.message || '布局已保存到本机。');
      paintCaptureControls();
    } catch (error) {
      captureMessage(error.message, true);
    }
  }

  function togglePublicGlyphs() {
    const layout = layoutStatus();
    if (!aligned && !choosing && supportsPublicGlyphs(layout)) {
      try {
        const enabled = layoutPublicGlyphs.checked;
        const result = capture.setLayoutPublicGlyphs(enabled);
        if (!result?.ok) throw new Error(result?.message || '无法修改辅助识牌设置。');
        captureMessage(result.message || `${enabled ? '已开启' : '已关闭'}公开样本辅助。请保存布局。`);
      } catch (error) {
        captureMessage(error.message, true);
      }
    }
    paintCaptureControls();
  }

  function resizeLayout() {
    const count = Number(layoutSeatCount.value);
    if (aligned || choosing || !capture?.setLayoutSeatCount) return;
    try {
      if (current.some(row => row.seat > count)) throw new Error('本局仍有待保留的较高编号座位。请在本局结束后调整座位数。');
      const result = capture.setLayoutSeatCount(count, source ? crop : undefined);
      if (!result?.ok) throw new Error(result?.message || '无法调整座位数。');
      fitFocus(count);
      captureMessage(result.message || `已将布局设为 ${count} 个玩家座位。`);
      paintCaptureControls();
      syncAnchorOrientation();
      drawGuide();
      render();
    } catch (error) {
      captureMessage(error.message, true);
      paintCaptureControls();
    }
  }

  function splitSeat(seat) {
    return projection?.seats.find(row => row.seat === seat)?.hands.length === 2;
  }

  function selectedHand() {
    return projection.seats.find(seat => seat.seat === target.seat)?.hands.find(hand => hand.hand === target.hand);
  }

  function isTombstone(seat, hand, slot) {
    return Boolean(state.tombstones?.[`${summary.round}:${seat}:${hand}:${slot}`]);
  }

  function firstOpen(seat, hand, from = 1, through = slotLimit) {
    const used = new Set(current.filter(row => row.seat === seat && row.hand === hand).map(row => row.slot));
    for (let slot = from; slot <= through; slot++) {
      if (!used.has(slot) && !isTombstone(seat, hand, slot)) return slot;
    }
    return null;
  }

  function nextOpen({ seat, hand, slot }) {
    return firstOpen(seat, hand, slot + 1) ?? firstOpen(seat, hand, 1, slot - 1);
  }

  function select(seat, hand = 0, slot) {
    const index = splitSeat(seat) && hand === 1 ? 1 : 0;
    const next = { seat, hand: index, slot: slot ?? firstOpen(seat, index) ?? slotLimit };
    if (!samePlace(next, target)) justSeen.checked = false;
    target = next;
    render();
  }

  function setState(next) {
    if (next.round !== summary.round || next.shoe !== summary.shoe) {
      openingStates = [];
      unreadOpeners.clear();
    }
    state = next;
    current = observer.rows(state);
    summary = observer.summary(state);
    if (saveTimer === null) saveTimer = setTimeout(saveState, 150);
  }

  function act(event, success, afterChange) {
    try {
      const next = observer.apply(state, event);
      const changed = next !== state;
      if (changed) {
        setState(next);
        afterChange?.();
        if (success) editorMessage(success);
        render();
      }
      return changed;
    } catch (error) {
      editorMessage(error.message, true);
      return false;
    }
  }

  function writeRank(rank) {
    if (!cssRanks.has(rank)) return;
    const position = target;
    const row = selectedRow();
    const deleted = isTombstone(position.seat, position.hand, position.slot);
    const fresh = !row && !deleted;
    const event = { type: 'card', ...position, rank, source: 'manual', time: row?.time ?? Date.now() / 1000, observed: fresh && justSeen.checked };
    const action = row?.source === 'auto' && row.rank === rank ? '人工确认' : row ? '更正' : deleted ? '补回' : '录入';
    if (!act(event, `${positionName(position)}已${action}为 ${rank}。`, () => {
      justSeen.checked = false;
      const next = fresh && $('live-auto-next').checked ? nextOpen(position) : null;
      if (next !== null) target = { ...position, slot: next };
    })) return;
    if (position.hand === 0) capture?.lock(position.seat, position.slot);
  }

  function deleteRank() {
    if (!selectedRow()) return;
    const position = target;
    if (act({ type: 'delete', ...position }, `${positionName(position)}已删除。可重新录入或撤销。`)) {
      if (position.hand === 0) capture?.lock(position.seat, position.slot);
    }
  }

  function syncLocks() {
    if (!capture || !source) return;
    for (const row of current) if (row.hand === 0 && !splitSeat(row.seat)) capture.lock(row.seat, row.slot);
    for (const saved of Object.keys(state.tombstones ?? {})) {
      const [round, seat, hand, slot] = saved.split(':').map(Number);
      if (round === summary.round && hand === 0 && !splitSeat(seat)) capture.lock(seat, slot);
    }
    for (const seat of projection.seats) if (seat.hands.length === 2) capture.suppressSeat(seat.seat);
  }

  function undoEdit() {
    const before = current;
    const beforeRound = summary.round;
    const beforeShoe = summary.shoe;
    const splitBefore = projection.seats.filter(seat => seat.hands.length === 2).map(seat => seat.seat);
    if (!act({ type: 'undo' }, '已撤销最近一次人工修改。')) return;
    if (summary.shoe !== beforeShoe || summary.round !== beforeRound) {
      capture?.restoreRound();
    } else {
      for (const row of before) {
        if (row.hand === 0 && !current.some(next => samePlace(next, row)) && !isTombstone(row.seat, row.hand, row.slot)) {
          capture?.reopen(row.seat, row.slot);
        }
      }
      for (const seat of splitBefore) if (!splitSeat(seat)) capture?.unsuppressSeat(seat);
    }
    syncLocks();
  }

  function ask(title, text, callback) {
    setText('live-confirm-title', title);
    setText('live-confirm-copy', text);
    pendingConfirm = callback;
    confirm.returnValue = 'cancel';
    confirm.showModal();
  }

  function startShoe(mode) {
    const full = mode === 'complete';
    const title = full ? '确认已经洗牌' : '从中途开始新记录';
    const detail = full ? '旧牌已收走且新牌靴尚未发牌时再确认。此操作会清空本靴牌面，另起完整记录。' : '将开启新的中途记录并清空当前牌面。若只是当前牌靴漏记了牌，请改用「标记漏牌」保留本靴记录。';
    ask(title, detail, () => {
      if (act({ type: 'shoe', mode }, full ? '完整牌靴已开始，等待第一张牌。' : '已开启中途记录。')) {
        capture?.startShoe?.(mode);
        select(summary.mySeat);
      }
    });
  }

  function incompleteRound() {
    return projection.dealer.cards.length > 0 && !current.some(row => row.seat === 0 && row.slot === 2)
      || projection.seats.some(seat => seat.hands.some(hand => hand.cards.length === 1))
      || [...unreadOpeners].some(seat => !current.some(row => row.seat === seat && row.slot === 1));
  }

  function nextRound() {
    const gap = summary.mode === 'complete' && incompleteRound();
    const message = gap ? '上一局有未录全的手牌，已保留本靴记录并改为部分跑数。' : '已开启下一局，同一牌靴的已录牌继续累计。';
    if (act({ type: 'round', gap }, message)) {
      capture?.nextRound();
      select(target.seat);
    }
  }

  function markGap(message, source = 'manual') {
    if (summary.mode !== 'complete') return;
    act({ type: 'gap', source }, message);
  }

  function handRows(seat, hand) {
    return current.filter(row => row.seat === seat && row.hand === hand).sort((a, b) => a.slot - b.slot);
  }

  function cardMarkup(row) {
    const { seat, hand, slot, rank, source } = row;
    const label = `${positionName(row)} · ${rank ?? '未知底牌'}`;
    return `<button type="button" class="card live-card-button${rank === 'A' ? ' ace' : ''}${rank ? '' : ' placeholder'}" data-source="${source ?? 'unknown'}" data-live-seat="${seat}" data-live-hand="${hand}" data-live-slot="${slot}" aria-pressed="${samePlace(row, target)}" aria-label="${label}" title="${label}">${rank ?? '◆'}</button>`;
  }

  function handLabel(hand) {
    if (!hand.cards.length) return '';
    const score = `${hand.soft ? '软 ' : ''}${hand.total} 点`;
    const status = statusName(hand.status) || (hand.total > 21 ? '爆牌' : '');
    if (hand.cards.length === 2 && hand.total === 21 && !hand.splitHand) return 'Blackjack';
    return status ? `${score} · ${status}` : score;
  }

  function seatPosition(seat, count) {
    if (count === 7) return '';
    const position = count === 1 ? 0.5 : (seat - 1) / (count - 1);
    const x = 91 - 82 * position;
    const y = 43 + 27 * (1 - (2 * position - 1) ** 2);
    const width = count > 1 ? Math.min(26, 82 / (count - 1) - 1.2) : 26;
    return ` data-layout-position style="--seat-x:${x}%;--seat-y:${y}%;--layout-seat-width:${width}%"`;
  }

  function paintTable() {
    const focus = felt.contains(document.activeElement) ? document.activeElement.dataset : null;
    const { dealer, seats } = projection;
    const dealerTotal = dealer.cards.length > 1 ? ` · ${dealer.total} 点` : '';
    const dealerRows = handRows(0, 0);
    if (dealerRows[0]?.slot === 1 && dealerRows[1]?.slot !== 2) dealerRows.splice(1, 0, { seat: 0, hand: 0, slot: 2 });
    $('live-dealer').classList.toggle('is-selected', target.seat === 0);
    $('live-dealer').innerHTML = `<button type="button" class="seat-label" data-live-seat="0" aria-pressed="${target.seat === 0}"><span class="seat-number">D</span><span class="seat-name">庄家${dealerTotal}</span></button><div class="hand"><span class="cards">${dealerRows.map(cardMarkup).join('')}</span></div>`;
    $('live-seats').innerHTML = seats.map(seat => {
      const selected = target.seat === seat.seat;
      const own = summary.mySeat === seat.seat;
      const label = own ? '关注' : seatName(seat.seat);
      const hands = seat.hands.filter(hand => hand.cards.length || hand.splitHand).map(hand => {
        const active = selected && target.hand === hand.hand;
        const label = `${hand.splitHand ? `手 ${hand.hand + 1} · ` : ''}${handLabel(hand) || '待录牌'}`;
        return `<div class="hand${active ? ' is-active' : ''}"><span class="cards">${handRows(seat.seat, hand.hand).map(cardMarkup).join('')}</span><button type="button" class="hand-meta live-hand-button" data-live-seat="${seat.seat}" data-live-hand="${hand.hand}" aria-pressed="${active}">${label}</button></div>`;
      }).join('');
      return `<div class="seat${own ? ' is-mine' : ''}${selected ? ' is-selected' : ''}"${seatPosition(seat.seat, seats.length)}><button type="button" class="seat-label" data-live-seat="${seat.seat}" aria-pressed="${selected}"><span class="seat-number">${seat.seat}</span><span class="seat-name">${label}</span></button><div class="seat-hands">${hands}<small id="live-opening-${seat.seat}" class="live-seat-opening" hidden></small></div></div>`;
    }).join('');
    if (focus) Array.from(felt.querySelectorAll('button[data-live-seat]')).find(({ dataset }) =>
      dataset.liveSeat === focus.liveSeat && dataset.liveHand === focus.liveHand && dataset.liveSlot === focus.liveSlot)?.focus({ preventScroll: true });
    paintSeatStatus();
  }

  function paintSeatStatus() {
    const openingDealt = current.some(row => row.seat === 0 && row.slot === 1) &&
      current.some(row => row.seat > 0 && row.hand === 0 && row.slot === 2);
    const recordedFirst = new Set(current.filter(row => row.slot === 1).map(row => row.seat));
    const layout = layoutStatus();
    const marked = new Set(layout.seats.filter(seat => seat.points.includes(1)).map(seat => seat.seat));
    for (const seat of projection.seats) {
      const field = $(`live-opening-${seat.seat}`);
      const reading = openingStates[seat.seat];
      const unread = reading === 'unread' && !recordedFirst.has(seat.seat);
      const noCards = seat.hands.every(hand => hand.cards.length === 0);
      const blank = reading === 'blank' && noCards;
      const manualOnly = !layout.builtin && !marked.has(seat.seat);
      field.textContent = manualOnly ? '未标位置 · 可手录' : unread ? '首牌点数待核对' : blank ? (openingDealt ? '疑似空位' : '暂未见牌') : '';
      field.hidden = !manualOnly && !unread && !blank;
      field.classList.toggle('is-unread', unread);
    }
  }

  function paintLedger() {
    const focused = document.activeElement?.dataset?.liveEdit;
    ledger.replaceChildren();
    if (!current.length) {
      const cell = ledger.insertRow().insertCell();
      cell.colSpan = 6;
      cell.textContent = '本局还没有牌。可选座位手动录入，或连接窗口识牌。';
      return;
    }
    const rows = [...current].sort((a, b) => a.seat - b.seat || a.hand - b.hand || a.slot - b.slot);
    for (const row of rows) {
      const element = ledger.insertRow();
      element.classList.toggle('is-target', samePlace(row, target));
      const sourceName = row.source === 'manual' ? '人工' : row.templateSource === 'fallback'
        ? '自动 · 公开样本' : row.initial ? '自动 · 快照' : '自动 · 新出现';
      [seatName(row.seat), row.seat ? row.hand + 1 : '—', row.slot, row.rank, sourceName].forEach(value => { element.insertCell().textContent = value; });
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'button compact';
      edit.dataset.liveEdit = placeKey(row);
      edit.textContent = '编辑';
      edit.setAttribute('aria-label', `编辑${seatName(row.seat)}第 ${row.hand + 1} 手牌位 ${row.slot}`);
      element.insertCell().append(edit);
      if (focused === edit.dataset.liveEdit) edit.focus({ preventScroll: true });
    }
  }

  function paintForecast() {
    const targetName = target.seat ? `${seatName(target.seat)} · 手 ${target.hand + 1}` : '庄家';
    setText('live-distribution-label', target.seat === 0 && target.slot === 2 ? '庄家底牌分布' : `${targetName} · 下一张分布`);
    const list = $('live-forecasts');
    const focused = document.activeElement?.dataset?.liveAdviceSeat;
    list.innerHTML = projection.seats.map(seat => {
      const details = seat.hands.map(hand => {
        let decision = '';
        if (hand.advice) {
          const { action, difference } = hand.advice;
          decision = `<b class="live-action-advice" data-action="${action}">建议${action === 'hit' ? '要牌' : '停牌'}</b>${Math.abs(difference) < 0.01 ? '<span>两种结果接近</span>' : ''}`;
        } else if (hand.cards.length && hand.incomplete && hand.status === 'playing') {
          decision = '<span>等牌录齐</span>';
        }
        return `<small class="live-advice-hand">${seat.hands.length > 1 ? `手 ${hand.hand + 1} · ` : ''}${handLabel(hand) || '—'}${decision}</small>`;
      });
      const selected = seat.seat === target.seat;
      return `<div class="live-forecast-row${seat.isMine ? ' is-mine' : ''}${selected ? ' is-selected' : ''}">
        <button type="button" class="button compact live-advice-seat" data-live-advice-seat="${seat.seat}" aria-pressed="${selected}">${seatName(seat.seat)}${seat.isMine ? ' · 关注' : ''}</button>
        <div class="live-advice-hands">${details.join('')}</div></div>`;
    }).join('');
    if (focused) list.querySelector(`[data-live-advice-seat="${focused}"]`)?.focus({ preventScroll: true });
    function distribution(rows) {
      return rows.map(row => `<span><b>${row.rank}</b>${percent(row.probability)}</span>`).join('');
    }
    $('live-distribution').innerHTML = distribution(projection.ranks);
    $('live-learned-distribution').innerHTML = distribution(projection.learnedRanks ?? []);
    const complete = summary.mode === 'complete';
    const phaseNote = {
      waiting: '等待庄家明牌。',
      dealer: projection.dealer.peek === 'blackjack' ? '庄家查牌已确认 Blackjack。' : '庄家已经亮出底牌。',
      unavailable: '当前牌账的未知牌不足以比较。',
      players: `庄家明牌 ${projection.dealer.cards[0]}。${projection.dealer.cards[0] === 'A' && projection.dealer.peek === 'unknown' ? '庄家查牌无 Blackjack 时适用。' : ''}`,
    }[projection.advicePhase];
    setText('live-forecast-note', `${phaseNote}用已记录的牌近似比较要牌和停牌。${complete ? '' : '中途入桌，先前未见的牌和剩余深度未知。'}`);
    const scores = summary.metrics;
    setText('live-evaluated', scores.predictions.toLocaleString('zh-CN'));
    setText('live-accuracy', scores.predictions ? `${scores.topHits}/${scores.predictions} · ${percent(scores.topAccuracy)}` : '—');
    setText('live-score', scores.predictions ? `${scores.logLoss.toFixed(3)} / ${scores.brier.toFixed(3)}` : '—');
    const learning = summary.learning?.[summary.mode];
    setText('live-learning-updates', `${learning?.updates?.toLocaleString('zh-CN') ?? '0'} 张`);
    setText('live-learning-score', learning?.predictions && Number.isFinite(learning.logLoss) && Number.isFinite(learning.baselineLogLoss)
      ? `${learning.logLoss.toFixed(3)} / ${learning.baselineLogLoss.toFixed(3)}` : '—');
  }

  function paintStats() {
    const full = summary.mode === 'complete';
    setText('live-mode', full ? '完整牌靴' : '中途入桌');
    $('live-full-shoe').setAttribute('aria-pressed', String(full));
    $('live-mid-shoe').setAttribute('aria-pressed', String(!full));
    $('live-gap').disabled = !full;
    setText('live-shoe-note', full ? '从确认洗牌后开始跟踪，真数依赖每张可见牌准确录入。发现漏牌后可保留牌面并改为部分跑数。' : '实际剩余深度未知，只显示已经观察到的跑数。');
    setText('live-seen', summary.seen.toLocaleString('zh-CN'));
    setText('live-round-seen', `本局 ${current.length} 张 · 第 ${summary.shoe} 靴`);
    setText('live-running-label', full ? 'Hi‑Lo 跑数' : 'Hi‑Lo 部分跑数');
    setText('live-running', signed(summary.running));
    setText('live-true-count', Number.isFinite(summary.trueCount) ? signed(summary.trueCount, 2) : '—');
    setText('live-depth-note', full ? '跑数 ÷ 剩余未知牌副数' : '中途入桌时未知');
    setText('live-remaining', summary.remaining ?? '未知');
    setText('live-round-label', `ROUND ${String(summary.round).padStart(2, '0')}`);
  }

  function paintEntryPositions(rows) {
    const selectedSeat = seatShortcuts.contains(document.activeElement) ? document.activeElement.dataset.liveSeat : null;
    const shortcuts = [0, ...projection.seats.map(seat => seat.seat).reverse()];
    seatShortcuts.innerHTML = shortcuts.map(seat => `<button type="button" class="button compact live-seat-choice${summary.mySeat === seat ? ' is-mine' : ''}" data-live-seat="${seat}" aria-pressed="${target.seat === seat}" aria-label="${seatName(seat)}${summary.mySeat === seat ? '，关注座位' : ''}">${seat || '庄家'}</button>`).join('');
    if (selectedSeat !== null) seatShortcuts.querySelector(`[data-live-seat="${selectedSeat}"]`)?.focus({ preventScroll: true });

    const selectedSlot = slotStrip.contains(document.activeElement) ? document.activeElement.dataset.liveSlot : null;
    const ranks = new Map(rows.map(row => [row.slot, row.rank]));
    const deleted = new Set();
    for (let slot = 1; slot <= slotLimit; slot++) {
      if (isTombstone(target.seat, target.hand, slot)) deleted.add(slot);
    }
    const length = Math.min(slotLimit, Math.max(3, target.slot, Math.max(0, ...ranks.keys(), ...deleted) + 1));
    slotStrip.innerHTML = Array.from({ length }, (_, index) => {
      const slot = index + 1;
      const rank = ranks.get(slot);
      const kind = rank ? 'recorded' : deleted.has(slot) ? 'deleted' : 'empty';
      const label = `第 ${slot} 张 · ${rank ?? (kind === 'deleted' ? '已删除，可重新录入' : '空位')}`;
      return `<button type="button" class="button compact live-slot-chip" data-kind="${kind}" data-live-slot="${slot}" aria-pressed="${target.slot === slot}" aria-label="${label}"><span>${slot}</span><b>${rank ?? (kind === 'deleted' ? '×' : '–')}</b></button>`;
    }).join('');
    if (selectedSlot !== null) slotStrip.querySelector(`[data-live-slot="${selectedSlot}"]`)?.focus({ preventScroll: true });
  }

  function paintEditor() {
    const row = selectedRow();
    const hand = selectedHand();
    const deleted = isTombstone(target.seat, target.hand, target.slot);
    const entryState = $('live-entry-state');
    entryState.dataset.kind = row ? 'edit' : deleted ? 'deleted' : 'add';
    entryState.textContent = row ? `更正 · ${row.rank}` : deleted ? '已删除 · 可补回' : '录入新牌';
    seatPicker.value = String(target.seat);
    handPicker.value = String(target.hand + 1);
    handPicker.disabled = !splitSeat(target.seat);
    slotPicker.value = String(target.slot);
    setText('live-editor-target', positionName(target));
    $('live-next-slot').disabled = nextOpen(target) === null;
    paintEntryPositions(handRows(target.seat, target.hand));
    for (const key of rankKeys.children) key.dataset.current = String(key.dataset.liveRank === row?.rank);
    $('live-delete').disabled = !row;
    $('live-undo').disabled = !summary.canUndo;
    justSeen.disabled = Boolean(row) || deleted;
    if (justSeen.disabled) justSeen.checked = false;
    $('live-my-seat').disabled = target.seat === 0 || target.seat === summary.mySeat;
    $('live-split').disabled = !hand || hand.splitHand || hand.cards.length !== 2;
    $('live-stand').disabled = !hand || !hand.cards.length || hand.status === 'stood';
    $('live-double').disabled = !hand || !hand.cards.length || hand.status === 'doubled';
    $('live-peek').disabled = projection.dealer.cards[0] !== 'A' || projection.dealer.cards.length > 1;
    $('live-peek').setAttribute('aria-pressed', String(projection.dealer.peek === 'clear'));
    const learn = $('live-learn');
    learn.disabled = !canLearn(row);
    learn.title = row?.source === 'auto' ? '请先核对窗口，再点选正确牌点。这样可避免把误识存成训练样本。' : '';
  }

  function canLearn(row) {
    return row?.source === 'manual' && capture && aligned && target.hand === 0 && !splitSeat(target.seat);
  }

  function render() {
    const start = performance.now();
    const layout = layoutStatus();
    const seatCount = seatLimit(layout);
    projection = observer.forecast(state, target, { seatCount });
    if (target.hand === 1 && !splitSeat(target.seat)) {
      target = { ...target, hand: 0 };
      projection = observer.forecast(state, target, { seatCount });
    }
    setText('live-forecast-time', ms(performance.now() - start, 2));
    setText('live-table-title', `${seatCount} 座牌桌`);
    setText('live-seat-note', layout.builtin ? '座位从右向左编号。点桌上已有的牌可直接更正。'
      : '座位从右向左编号。未校准的座位也可手录，牌靴推算按 8 副牌计算。');
    paintTable();
    paintLedger();
    paintForecast();
    paintStats();
    paintEditor();
  }

  function resetTimings() {
    frameCount = 0;
    previewFrames = 0;
    autoConfirmed = 0;
    autoWritten = 0;
    publicConfirmed = 0;
    scanDiagnostics = null;
    openingStates = [];
    frameDeliveryMs = null;
    totalTimes = [];
    lastPreviewAt = -Infinity;
    lastMetricsAt = -Infinity;
    lastDiagnosticsAt = -Infinity;
    lastConfirmationMs = null;
    for (const id of ['live-frame-time', 'live-pipeline-time', 'live-confirmation-time', 'live-last-detection']) setText(id, '—');
    setText('live-frames', '0');
    paintCaptureStage();
  }

  function onTiming(metrics) {
    if (Number.isFinite(metrics?.frameIntervalMs)) frameDeliveryMs = metrics.frameIntervalMs;
    if (!aligned || !source || !metrics) return;
    frameCount++;
    if (Number.isFinite(metrics.totalMs)) {
      totalTimes.push(metrics.totalMs);
      if (totalTimes.length > 300) totalTimes.shift();
    }
    if (Number.isFinite(metrics.confirmationMs) && metrics.confirmationMs > 0) lastConfirmationMs = metrics.confirmationMs;
    const now = performance.now();
    if (now - lastMetricsAt < 250) return;
    lastMetricsAt = now;
    const sorted = totalTimes.slice().sort((a, b) => a - b);
    setText('live-frames', frameCount.toLocaleString('zh-CN'));
    setText('live-frame-time', `${ms(metrics.captureMs)} / ${ms(metrics.recognitionMs, 2)}`);
    setText('live-pipeline-time', ms(sorted[Math.ceil(sorted.length * 0.95) - 1]));
    setText('live-confirmation-time', ms(lastConfirmationMs));
  }

  function onFrame({ events = [], roundClear = false, possibleGap = false, diagnostics = null, width, height }) {
    if (!source) return;
    previewFrames++;
    let openingChanged = false;
    if (aligned) {
      autoConfirmed += events.length;
      if (diagnostics) {
        if (Number.isInteger(diagnostics.fallbackAccepted) && diagnostics.fallbackAccepted > 0) publicConfirmed += diagnostics.fallbackAccepted;
        scanDiagnostics = diagnostics;
        for (const { seat, state: reading } of diagnostics.opening ?? []) {
          if (reading === 'unread') unreadOpeners.add(seat);
          if (openingStates[seat] === reading) continue;
          openingStates[seat] = reading;
          openingChanged = true;
        }
      }
    }
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && (width !== source.width || height !== source.height)) {
      source = { ...source, width, height };
      setText('live-source-size', `${width} × ${height}`);
      paintCrop();
    }
    const now = performance.now();
    if (now - lastPreviewAt >= 250) {
      lastPreviewAt = now;
      if (capture.drawPreview(preview) !== false) {
        const firstPreview = preview.hidden;
        preview.hidden = false;
        $('live-preview-empty').hidden = true;
        if (firstPreview) paintCaptureControls();
        drawOverlay();
      }
    }
    const updateDiagnostics = events.length || now - lastDiagnosticsAt >= 250;
    if (updateDiagnostics) {
      lastDiagnosticsAt = now;
    }

    if (possibleGap) markGap('捕获可能中断，已保留牌面并改为部分跑数。', 'auto');
    if (!aligned) {
      if (updateDiagnostics) paintCaptureStage();
      return;
    }
    let next = state;
    try {
      const hasDeleted = Object.keys(state.tombstones ?? {}).some(key => key.startsWith(`${summary.round}:`));
      if (roundClear && (current.length || hasDeleted)) {
        const gap = next.mode === 'complete' && incompleteRound();
        next = observer.apply(next, { type: 'round', source: 'auto', gap });
        target = { seat: target.seat, hand: 0, slot: 1 };
        editorMessage(gap ? '画面已清空。上一局有未录全的手牌，已改为部分跑数。' : '画面已清空，开始下一局。');
      }
      for (const event of events) {
        if (!roundClear && splitSeat(event.seat)) continue;
        try {
          const updated = observer.apply(next, { ...event, type: 'card', source: 'auto' });
          if (updated !== next) autoWritten++;
          next = updated;
        } catch (error) {
          captureMessage(`${seatName(event.seat)}第 ${event.slot} 张自动结果需要校正。${error.message}`, true);
          if (next.mode === 'complete') next = observer.apply(next, { type: 'gap', source: 'auto' });
        }
      }
    } catch (error) {
      captureMessage(`自动结果需要校正。${error.message}`, true);
      if (next.mode === 'complete') next = observer.apply(next, { type: 'gap', source: 'auto' });
    }
    if (updateDiagnostics) paintCaptureStage();
    if (next === state) {
      if (openingChanged) paintSeatStatus();
      return;
    }
    setState(next);
    if (events.length) setText('live-last-detection', new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    render();
  }

  function onStatus({ state: value, message }) {
    captureStatus = value;
    const disconnected = ['stopped', 'ended', 'disconnected', 'idle', 'closed', 'error', 'cancelled', 'canceled'].includes(value);
    if (disconnected) clearSource();
    if (['error', 'cancelled', 'canceled', 'unavailable'].includes(value)) choosing = false;
    if (value === 'capturing' && aligned) syncLocks();
    if (value === 'paused' && aligned) markGap('捕获暂时中断，已保留牌面并改为部分跑数。', 'auto');
    const sourceStatus = value === 'waiting' ? '等待清桌' : value === 'paused' ? '捕获暂缓' : '识牌运行中';
    const badge = source ? aligned ? sourceStatus : '仅预览 · 未启动识牌' : choosing ? '等待选择窗口' : '尚未共享窗口';
    setText('live-capture-state', badge);
    if (message) captureMessage(message, value === 'error' || value === 'unavailable');
    paintCaptureControls();
  }

  function onReady(details) {
    const wasAligned = aligned;
    source = details;
    choosing = false;
    captureStatus = 'preview';
    preview.hidden = true;
    $('live-preview-empty').hidden = false;
    if (wasAligned) markGap('捕获画面需要重新校准，已改为部分跑数。', 'auto');
    resetTimings();
    setText('live-source-size', `${source.width} × ${source.height}`);
    const layout = layoutStatus();
    enterAlignment(capture.getCrop() ?? layout.crop ?? wholeWindow);
    captureMessage(layout.id === 'classic-front'
      ? '窗口已连接，目前仅预览。画面只含完整游戏时可点「整窗取景」，再点「应用区域并开始识别」。有浏览器边栏时先框选游戏画面。'
      : layout.builtin ? '窗口已连接，目前仅预览。检查定位框后，点「应用区域并开始识别」。'
      : '窗口已连接。请核对自定义取景和牌点定位，达到启动条件后再开始识牌。');
  }

  function clearSource() {
    if (source && aligned) markGap('捕获已停止。停录期间可能漏记，已保留牌面并改为部分跑数。', 'auto');
    source = null;
    aligned = false;
    choosing = false;
    drag = null;
    clearAnchorDrag();
    anchoring = false;
    captureStatus = 'idle';
    openingStates = [];
    preview.hidden = true;
    preview.classList.remove('is-aligning', 'is-anchoring');
    overlay.hidden = true;
    guideOverlay.hidden = true;
    $('live-preview-empty').hidden = false;
    setText('live-source-size', '—');
    setText('live-capture-state', '尚未共享窗口');
    paintCaptureControls();
    paintEditor();
    paintSeatStatus();
  }

  function paintCaptureControls() {
    const layout = layoutStatus();
    updateSeatPickers(seatLimit(layout));
    $('live-start').disabled = !capture || choosing || Boolean(source);
    const systemAvailable = typeof capture?.chooseSystem === 'function' && (capture.canChooseSystem?.() ?? true);
    $('live-system-start').disabled = !systemAvailable || choosing || Boolean(source);
    $('live-stop').disabled = !capture || (!source && !choosing);
    $('live-align').disabled = !source;
    $('live-full-crop').disabled = !source || aligned || preview.hidden;
    $('live-apply-crop').disabled = !source || aligned || preview.hidden || (!layout.builtin && !layout.canStart);
    $('live-apply-crop').textContent = aligned ? '识别已启动' : layout.builtin || layout.canStart ? '应用区域并开始识别' : '等待标记首牌';
    $('live-show-guide').disabled = !source || preview.hidden;
    $('live-show-guide').setAttribute('aria-pressed', String(showGuide));
    for (const field of fields) cropInputs[field].disabled = !source;
    paintLayoutControls(layout);
    paintAnchorControls(layout);
    paintCaptureStage(layout);
  }

  function paintCaptureStage(layout = layoutStatus()) {
    const isReady = Boolean(source && !preview.hidden);
    $('live-step-capture').dataset.state = isReady ? 'done' : 'current';
    $('live-step-crop').dataset.state = aligned ? 'done' : isReady ? 'current' : '';
    $('live-step-recognition').dataset.state = aligned ? 'current' : '';
    setText('live-step-capture-note', isReady ? '预览已连通' : source ? '等待首帧' : choosing ? '窗口选择中' : '等待选择窗口');
    setText('live-step-crop-note', aligned ? '区域已应用' : isReady ? layout.builtin ? '检查牌点定位框' : '框选牌桌并标记牌点' : '等待预览');
    const scan = scanDiagnostics;
    const waiting = captureStatus === 'waiting';
    const paused = captureStatus === 'paused';
    setText('live-step-recognition-note', !aligned ? isReady ? '仅预览 · 识牌未启动' : '尚未启动'
      : waiting ? '等待旧牌清走' : paused ? '捕获暂缓' : '正在分析画面');
    setText('live-preview-frames', previewFrames.toLocaleString('zh-CN'));
    setText('live-frame-interval', ms(frameDeliveryMs));
    const publicLabel = publicConfirmed ? ` · 公开样本辅助 ${publicConfirmed.toLocaleString('zh-CN')}` : '';
    setText('live-scan-confirmed', `${autoConfirmed.toLocaleString('zh-CN')} · 入账 ${autoWritten.toLocaleString('zh-CN')}${publicLabel}`);
    setText('live-scan-candidates', aligned && scan
      ? `${scan.glyphs}/${scan.checked} 个牌点 · 匹配 ${scan.matched} · 低置信 ${scan.lowConfidence}${scan.blocked ? ` · 等前位 ${scan.blocked}` : ''}` : '—');

    let note = '选择窗口后先检查预览，再应用校准区域。';
    if (source && !aligned) note = !layout.builtin && !layout.canStart
      ? '当前只预览。请框选牌桌，再标记庄家和至少一位玩家的第 1 张牌点。'
      : layout.id === 'classic-front' ? '当前只预览。若窗口里就是完整游戏画面，点「整窗取景」，再点「应用区域并开始识别」。'
        : '先确认定位框围住每座第一张牌的数字或字母。偏离时可在预览中校准，再点「应用区域并开始识别」。';
    else if (aligned && waiting) note = '正在等上一局旧牌清走。清桌后会继续识别。';
    else if (aligned && paused) note = '捕获暂缓。请确认所选窗口仍可见。';
    else if (aligned && !scan) note = '识牌已启动，等待可分析的画面。';
    else if (aligned && scan.checked === 0) note = '当前帧无待扫描的牌位。新一局若仍无结果，请确认已清桌或点「下一局」。';
    else if (aligned && scan.glyphs === 0) {
      note = layout.builtin && layout.id !== 'classic-front' && autoConfirmed === 0 && frameCount >= 8
        ? '已处理画面，仍未确认牌点。若正面全桌画面已有明牌，请点「框选画面」，切换「Classic 全桌 · 牌点自定位」，再应用识别区域。'
        : '当前帧未读到新的牌点。若账本仍漏了明牌，先看对应定位框是否围住牌点。首牌找不到时，后面的牌位可能在等待。';
    }
    else if (aligned && (scan.occupiedUnmatched > 0 || scan.lowConfidence > 0) && scan.matched === 0) note = '框里有牌点，但字形匹配不足。请核对框内是否只包含数字或字母。可手动选择实际牌面，再点「用已核实牌面校准」。';
    else if (aligned && scan.matched > 0) note = '已读到候选牌点。满足连续帧确认的结果会写入本局账本。';
    setText('live-diagnostics-note', note);
  }

  function enterAlignment(rect) {
    if (!source) return;
    if (aligned) markGap('重新校准期间可能漏记，已保留当前跑数。', 'auto');
    capture.beginAlignment?.();
    aligned = false;
    drag = null;
    clearAnchorDrag();
    anchoring = false;
    scanDiagnostics = null;
    openingStates = [];
    captureStatus = 'preview';
    crop = rect;
    $('live-calibration').open = true;
    preview.classList.add('is-aligning');
    preview.classList.remove('is-anchoring');
    setText('live-capture-state', '仅预览 · 未启动识牌');
    paintCrop();
    paintCaptureControls();
    paintEditor();
    paintSeatStatus();
  }

  function paintCrop() {
    if (!source) return;
    const { width, height } = source;
    const left = Math.round(crop.x * width);
    const top = Math.round(crop.y * height);
    cropInputs.x.value = String(left);
    cropInputs.y.value = String(top);
    cropInputs.width.value = String(Math.max(1, Math.round((crop.x + crop.width) * width) - left));
    cropInputs.height.value = String(Math.max(1, Math.round((crop.y + crop.height) * height) - top));
    drawOverlay();
  }

  function drawOverlay() {
    overlay.hidden = !source || aligned || preview.hidden;
    if (!overlay.hidden) placeOverlay(overlay, crop);
    drawGuide();
  }

  function placeOverlay(element, rect) {
    const image = preview.getBoundingClientRect();
    const container = $('live-preview').getBoundingClientRect();
    element.style.left = `${image.left - container.left + rect.x * image.width}px`;
    element.style.top = `${image.top - container.top + rect.y * image.height}px`;
    element.style.width = `${rect.width * image.width}px`;
    element.style.height = `${rect.height * image.height}px`;
  }

  function drawGuide() {
    const regions = showGuide && source && !preview.hidden ? capture?.getGuide?.(aligned ? undefined : crop) ?? [] : [];
    guideOverlay.hidden = !regions.length;
    if (!regions.length) return;
    const image = preview.getBoundingClientRect();
    const selected = anchoring ? Number(anchorSeat.value) : -1;
    const selectedSlot = anchoring ? anchorNumber(layoutStatus()) : 1;
    const nextKey = JSON.stringify([image.left, image.top, image.width, image.height, selected, selectedSlot, regions, openingStates]);
    if (nextKey === guideKey) return;
    guideKey = nextKey;
    guideOverlay.replaceChildren(...regions.map(region => {
      const box = document.createElement('div');
      box.className = 'live-guide-box';
      box.classList.toggle('is-anchor', Boolean(region.anchored));
      box.classList.toggle('is-tracked', Boolean(region.tracked));
      box.classList.toggle('is-selected', region.seat === selected && (region.slot ?? 1) === selectedSlot);
      box.classList.toggle('is-unread', region.slot === 1 && openingStates[region.seat] === 'unread');
      const label = document.createElement('span');
      const place = region.seat === 0 ? 'D' : String(region.seat);
      label.textContent = region.slot ? `${place}·${region.slot}` : place;
      box.append(label);
      placeOverlay(box, region);
      return box;
    }));
  }

  function anchorNumber(layout) {
    return layout.builtin ? 1 : Number(anchorSlot.value || 1);
  }

  function canPickAnchor(layout) {
    return Boolean(source && (layout.builtin || !aligned) && !preview.hidden && capture?.setSeatAnchor);
  }

  function paintAnchorControls(layout = layoutStatus()) {
    const available = canPickAnchor(layout);
    const custom = !layout.builtin;
    const seat = Number(anchorSeat.value);
    const slot = anchorNumber(layout);
    const seatPoints = layout.seats.find(row => row.seat === seat)?.points ?? [];
    anchorSeat.disabled = !available;
    anchorSlot.disabled = !available || !custom;
    $('live-anchor-slot-field').hidden = !custom;
    $('live-anchor-orientation').hidden = !custom;
    anchorFlip.disabled = anchorInvert.disabled = !available || !custom;
    $('live-anchor-pick').disabled = !available;
    $('live-anchor-pick').setAttribute('aria-pressed', String(anchoring));
    $('live-anchor-pick').textContent = anchoring ? '取消点选' : custom ? `点选第 ${slot} 张牌点` : '点选首张牌点';
    $('live-anchor-remove').hidden = !custom || !capture?.removeSeatAnchor;
    $('live-anchor-remove').disabled = !available || !seatPoints.includes(slot);
    $('live-anchor-reset').disabled = !available || !(custom ? layout.seats.length : capture?.getGuide?.(crop)?.some(region => region.anchored));
    preview.classList.toggle('is-anchoring', anchoring);
    setText('live-anchor-note', anchoring
      ? `在预览里标记${seatName(seat)}第 ${slot} 张牌左上角的数字或字母。${custom ? '可点击中心，或拖框标尺寸并留一点白边。' : '点击字形中心。'}`
      : custom ? aligned ? '要调整自定义定位，先点「框选画面」暂停识牌。' : '选择庄家或实际座位，再选牌位。点击牌点中心，或围住数字或字母拖框。校准点只用于布局。'
        : '如果定位框偏离牌点，先选座位，再点该座第一张可见牌左上角的数字或字母中心。');
  }

  function pickAnchor() {
    if (!canPickAnchor(layoutStatus())) return;
    anchoring = !anchoring;
    if (!anchoring) clearAnchorDrag();
    if (anchoring) showGuide = true;
    paintCaptureControls();
    drawGuide();
  }

  function setAnchor(point) {
    const seat = Number(anchorSeat.value);
    const layout = layoutStatus();
    const slot = anchorNumber(layout);
    if (!layout.builtin) Object.assign(point, { flip: anchorFlip.checked, invert: anchorInvert.checked });
    const result = capture.setSeatAnchor(seat, point, slot, crop);
    if (result?.ok) anchoring = false;
    captureMessage(result?.message || `${seatName(seat)}第 ${slot} 张牌点已校准。`, !result?.ok);
    paintCaptureControls();
    drawGuide();
    paintSeatStatus();
  }

  function clearAnchorDrag() {
    anchorDrag = null;
    anchorOverlay.hidden = true;
  }

  function anchorBox(point) {
    return { x: Math.min(anchorDrag.x, point.x), y: Math.min(anchorDrag.y, point.y),
      width: Math.abs(anchorDrag.x - point.x), height: Math.abs(anchorDrag.y - point.y) };
  }

  function showAnchorBox(event) {
    const box = anchorBox(relativePoint(event));
    anchorOverlay.hidden = box.width < 2 / source.width || box.height < 2 / source.height;
    if (!anchorOverlay.hidden) placeOverlay(anchorOverlay, box);
  }

  function finishAnchor(event) {
    const point = relativePoint(event);
    const box = anchorBox(point);
    clearAnchorDrag();
    if (box.width >= 2 / source.width && box.height >= 2 / source.height) {
      setAnchor({ x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height });
    } else setAnchor(point);
  }

  function clearAnchors(action) {
    const result = action();
    if (!result) return;
    anchoring = false;
    clearAnchorDrag();
    const layout = layoutStatus();
    if (result.ok && aligned && !layout.builtin && !layout.canStart) enterAlignment(crop);
    captureMessage(result.message, !result.ok);
    paintCaptureControls();
    syncAnchorOrientation(layout);
    drawGuide();
    paintSeatStatus();
  }

  function relativePoint(event) {
    const rect = preview.getBoundingClientRect();
    const clamp = value => Math.max(0, Math.min(1, value));
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  }

  function dragCrop(event) {
    if (!drag) return;
    const { x, y } = relativePoint(event);
    const width = Math.abs(x - drag.x);
    const height = Math.abs(y - drag.y);
    if (width < 0.025 || height < 0.025) return;
    crop = { x: Math.min(x, drag.x), y: Math.min(y, drag.y), width, height };
    paintCrop();
  }

  function cropFromInputs() {
    const values = Object.fromEntries(fields.map(field => [field, Number(cropInputs[field].value)]));
    const { x, y, width, height } = values;
    if (!source || !Object.values(values).every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > source.width || y + height > source.height) return null;
    return { x: x / source.width, y: y / source.height, width: width / source.width, height: height / source.height };
  }

  function applyCrop(event) {
    event.preventDefault();
    if (!source) return;
    const rect = cropFromInputs();
    if (!rect) {
      captureMessage('区域必须完整落在所选窗口内。', true);
      return;
    }
    try {
      const layout = layoutStatus(rect);
      if (!layout.builtin && !layout.canStart) throw new Error(layout.message || '请先标记庄家和至少一位玩家的第 1 张牌点。');
      const result = capture.setCrop(rect, { mode: summary.mode });
      if (result === false || result?.ok === false) throw new Error(result?.message || '所选区域无法应用。');
      crop = rect;
      aligned = true;
      anchoring = false;
      captureStatus = 'capturing';
      preview.classList.remove('is-aligning');
      overlay.hidden = true;
      $('live-calibration').open = false;
      setText('live-capture-state', '识牌运行中');
      captureMessage(layout.builtin ? '识牌已启动。定位框应围住牌左上角的数字或字母，扫描状态见右侧诊断。'
        : '自定义识牌已启动。请核对定位框，未覆盖的座位或牌位可手动录入。');
      syncLocks();
      paintCaptureControls();
      drawOverlay();
      paintEditor();
    } catch (error) {
      captureMessage(error.message, true);
    }
  }

  async function chooseWindow(system = false) {
    if (!capture || choosing || source) return;
    choosing = true;
    setText('live-capture-state', '等待选择窗口');
    paintCaptureControls();
    try {
      const opened = await (system ? capture.chooseSystem() : capture.choose());
      if (opened === false && choosing) {
        choosing = false;
        setText('live-capture-state', '尚未共享窗口');
        captureMessage(system ? '系统选择器未开始捕获。请选择单个窗口。' : '窗口捕获需要 Windows 桌面版。仍可在牌桌手动录牌。', true);
        paintCaptureControls();
      }
    } catch (error) {
      choosing = false;
      setText('live-capture-state', '尚未共享窗口');
      captureMessage(error.message, true);
      paintCaptureControls();
    }
  }

  function listen(id, action) { $(id).addEventListener('click', action); }

  for (let slot = 1; slot <= slotLimit; slot++) {
    const option = document.createElement('option');
    option.value = String(slot);
    option.textContent = String(slot);
    slotPicker.append(option);
  }
  for (const rank of cssRanks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button rank-key';
    button.dataset.liveRank = rank;
    button.textContent = rank;
    button.setAttribute('aria-keyshortcuts', rank === '10' ? 'T 0' : rank);
    rankKeys.append(button);
  }

  listen('live-start', () => chooseWindow());
  listen('live-system-start', () => chooseWindow(true));
  layoutPicker.addEventListener('change', () => useLayout(() => capture.selectLayout(layoutPicker.value)));
  listen('live-layout-new', () => useLayout(() => capture.newLayout(layoutName.value.trim() || undefined)));
  listen('live-layout-save', saveLayout);
  layoutSeatCount.addEventListener('change', resizeLayout);
  layoutPublicGlyphs.addEventListener('change', togglePublicGlyphs);
  listen('live-stop', () => { capture?.stop(); clearSource(); });
  listen('live-align', () => enterAlignment(capture?.getCrop() ?? crop));
  listen('live-full-crop', () => {
    if (!source || aligned) return;
    crop = wholeWindow;
    paintCrop();
    paintCaptureControls();
  });
  listen('live-show-guide', () => {
    showGuide = !showGuide;
    $('live-show-guide').setAttribute('aria-pressed', String(showGuide));
    drawGuide();
  });
  listen('live-anchor-pick', pickAnchor);
  listen('live-anchor-reset', () => clearAnchors(() => capture?.clearSeatAnchors?.()));
  listen('live-anchor-remove', () => clearAnchors(() => capture?.removeSeatAnchor?.(Number(anchorSeat.value), anchorNumber(layoutStatus()))));
  anchorSeat.addEventListener('change', () => {
    syncAnchorOrientation();
    paintAnchorControls();
    drawGuide();
  });
  anchorSlot.addEventListener('change', () => { paintAnchorControls(); drawGuide(); });
  listen('live-full-shoe', () => startShoe('complete'));
  listen('live-mid-shoe', () => startShoe('mid'));
  listen('live-gap', () => markGap('已标记漏牌，保留本靴牌面和部分跑数。'));
  listen('live-next', nextRound);
  listen('live-next-slot', () => {
    const slot = nextOpen(target);
    if (slot !== null) select(target.seat, target.hand, slot);
  });
  listen('live-delete', deleteRank);
  listen('live-undo', undoEdit);
  listen('live-my-seat', () => act({ type: 'mySeat', seat: target.seat }, `${seatName(target.seat)}已设为关注座位。`));
  listen('live-split', () => {
    const seat = target.seat;
    if (act({ type: 'split', seat }, `${seatName(seat)}已分牌。分牌后的两手请分别手动录入。`)) {
      capture?.suppressSeat(seat);
      select(seat);
    }
  });
  listen('live-stand', () => act({ type: 'status', seat: target.seat, hand: target.hand, status: 'stood' }, '已标记停牌。'));
  listen('live-double', () => act({ type: 'status', seat: target.seat, hand: target.hand, status: 'doubled' }, '已标记加倍。'));
  listen('live-peek', () => act({ type: 'peek', value: projection.dealer.peek === 'clear' ? 'unknown' : 'clear' }, '已更新庄家查牌状态。'));
  listen('live-learn', () => {
    const row = selectedRow();
    if (!canLearn(row)) return;
    const result = capture.learn(target.seat, target.slot, row.rank);
    if (result) {
      editorMessage(result.message, !result.ok);
      if (result.ok) paintLayoutControls(layoutStatus());
    }
  });
  confirm.addEventListener('close', () => {
    const callback = pendingConfirm;
    pendingConfirm = null;
    if (confirm.returnValue === 'confirm') callback?.();
  });
  $('live-crop-form').addEventListener('submit', applyCrop);
  for (const field of fields) cropInputs[field].addEventListener('change', () => {
    const draft = cropFromInputs();
    if (!draft || aligned) return;
    crop = draft;
    drawOverlay();
    paintCaptureControls();
  });
  preview.addEventListener('pointerdown', event => {
    if (!source || event.button !== 0) return;
    if (anchoring) {
      if (layoutStatus().builtin) setAnchor(relativePoint(event));
      else {
        anchorDrag = relativePoint(event);
        preview.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (aligned) return;
    drag = relativePoint(event);
    preview.setPointerCapture(event.pointerId);
  });
  preview.addEventListener('pointermove', event => { if (anchorDrag) showAnchorBox(event); else dragCrop(event); });
  preview.addEventListener('pointerup', event => {
    if (anchorDrag) finishAnchor(event);
    else { dragCrop(event); drag = null; }
  });
  preview.addEventListener('pointercancel', () => { drag = null; clearAnchorDrag(); });
  window.addEventListener('resize', drawOverlay);
  window.addEventListener('pagehide', () => {
    capture?.stop();
    saveState();
  });
  seatPicker.addEventListener('change', () => select(Number(seatPicker.value)));
  handPicker.addEventListener('change', () => select(target.seat, Number(handPicker.value) - 1));
  slotPicker.addEventListener('change', () => select(target.seat, target.hand, Number(slotPicker.value)));
  seatShortcuts.addEventListener('click', event => {
    const button = event.target.closest('button[data-live-seat]');
    if (button) select(Number(button.dataset.liveSeat));
  });
  $('live-forecasts').addEventListener('click', event => {
    const button = event.target.closest('button[data-live-advice-seat]');
    if (button) select(Number(button.dataset.liveAdviceSeat));
  });
  slotStrip.addEventListener('click', event => {
    const button = event.target.closest('button[data-live-slot]');
    if (button) select(target.seat, target.hand, Number(button.dataset.liveSlot));
  });
  rankKeys.addEventListener('click', event => {
    const button = event.target.closest('button[data-live-rank]');
    if (button) writeRank(button.dataset.liveRank);
  });
  function openCardEditor(seat, hand, slot) {
    select(seat, hand, slot);
    const key = rankKeys.querySelector('[data-current="true"]') ?? rankKeys.firstElementChild;
    key?.focus({ preventScroll: true });
    rankKeys.scrollIntoView({ block: 'nearest' });
  }

  felt.addEventListener('click', event => {
    const button = event.target.closest('button[data-live-seat]');
    if (!button) return;
    const seat = Number(button.dataset.liveSeat);
    const hand = Number(button.dataset.liveHand ?? 0);
    if (button.dataset.liveSlot) openCardEditor(seat, hand, Number(button.dataset.liveSlot));
    else select(seat, hand);
  });
  ledger.addEventListener('click', event => {
    const button = event.target.closest('button[data-live-edit]');
    if (!button) return;
    const [seat, hand, slot] = button.dataset.liveEdit.split(':').map(Number);
    openCardEditor(seat, hand, slot);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && anchoring) {
      anchoring = false;
      clearAnchorDrag();
      paintAnchorControls();
      drawGuide();
      event.preventDefault();
      return;
    }
    if (confirm.open || event.repeat || event.isComposing || event.defaultPrevented || event.target.closest?.('input, select, textarea, [contenteditable]')) return;
    const key = event.key.toUpperCase();
    if ((event.ctrlKey || event.metaKey) && key === 'Z' && !event.shiftKey) undoEdit();
    else if (event.ctrlKey || event.metaKey || event.altKey) return;
    else if (event.shiftKey && /^Digit[1-9]$/.test(event.code) && Number(event.code.slice(-1)) <= seatLimit()) select(Number(event.code.slice(-1)));
    else if (key === 'D') select(0);
    else if (key === 'N') nextRound();
    else if (key === 'DELETE') deleteRank();
    else if (!event.shiftKey && (cssRanks.has(key) || key === 'T' || key === '0')) writeRank(key === 'T' || key === '0' ? '10' : key);
    else return;
    event.preventDefault();
  });
  const initialLayout = layoutStatus();
  switchLedger(initialLayout.id, false);
  fitFocus(seatLimit(initialLayout));
  layoutName.value = initialLayout.builtin ? '' : initialLayout.name;
  paintCaptureControls();
  syncAnchorOrientation(initialLayout);
  render();
  if (saveMigratedSeats) saveState();
})();
