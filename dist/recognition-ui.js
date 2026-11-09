(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const video = $('recording');
  const reference = window.BlackjackRecognitionProfile;
  const recognition = window.BlackjackRecognition;
  const capture = window.BlackjackLiveCapture;
  const glyphBank = window.BlackjackGlyphBank;
  const layoutPicker = $('replay-layout');
  const roundMode = $('replay-round-mode');
  const learnedGlyphs = $('replay-learned-glyphs');
  const logRound = $('replay-log-round');
  const startTime = $('replay-start-time');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const useVideoFrames = typeof video.requestVideoFrameCallback === 'function';
  const eventBody = $('recognition-events');
  const fileInput = $('recording-file');
  const startButton = $('play-recognition');
  const restartButton = $('restart-recognition');
  const exportButton = $('export-recognition');
  const speed = $('replay-rate');
  const manualSeat = $('manual-seat');
  const manualSlot = $('manual-slot');
  const manualTime = $('manual-time');
  const manualTimeField = $('manual-time-field');
  const manualSeatKeys = $('manual-seat-keys');
  const manualRanks = $('manual-ranks');
  const manualDelete = $('manual-delete');
  const manualUndo = $('manual-undo');
  const manualNext = $('manual-next');
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const slotLimit = 21;
  const timingWindow = 1800;
  let fileUrl = '';
  let validFile = false;
  let phase = 'empty';
  let revision = 0;
  let frameRequest = null;
  let engine = null;
  let profile = reference;
  let startedAt = 0;
  let continuous = false;
  let clearAt = null;
  let rounds = [makeRound(1, 0)];
  let target = { seat: 4, slot: 1 };
  let stats = emptyStats();

  function makeRound(id, start) {
    return { id, start, end: null, records: new Map(), edits: [] };
  }

  function activeRound() {
    return rounds.at(-1);
  }

  function viewedRound() {
    return rounds[Number(logRound.value) - 1] ?? activeRound();
  }

  function appendRoundOption(round) {
    const option = document.createElement('option');
    option.value = String(round.id);
    option.textContent = `第 ${round.id} 局`;
    logRound.append(option);
  }

  function emptyStats() {
    return {
      frames: 0,
      skipped: 0,
      engineMs: 0,
      captureMs: 0,
      pipeline: [],
      lastTime: -1,
      lastPresented: null,
      lastPaint: 0,
    };
  }

  function formatTime(seconds) {
    const milliseconds = Math.round(Math.max(0, seconds) * 1000);
    const minutes = Math.floor(milliseconds / 60000);
    const withinMinute = Math.floor(milliseconds / 1000) % 60;
    return `${String(minutes).padStart(2, '0')}:${String(withinMinute).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
  }

  function phaseTo(value, message) {
    phase = value;
    startButton.textContent = {
      running: '暂停', paused: '继续', complete: '重新识别', failed: '重试识别',
    }[value] || '开始识别';
    startButton.disabled = !validFile;
    restartButton.disabled = !validFile || value === 'ready';
    startTime.disabled = !validFile || value === 'running';
    layoutPicker.disabled = value === 'running';
    roundMode.disabled = value === 'running';
    learnedGlyphs.disabled = value === 'running';
    const status = $('recognition-status');
    status.textContent = message;
    status.classList.toggle('error', value === 'failed');
    paintManual();
  }

  function cancelFrame() {
    if (frameRequest === null) return;
    if (useVideoFrames) video.cancelVideoFrameCallback(frameRequest);
    else cancelAnimationFrame(frameRequest);
    frameRequest = null;
  }

  function pauseRecognition() {
    revision++;
    cancelFrame();
    clearAt = null;
    phaseTo('paused', '已暂停，继续时会从当前位置识别。');
    video.pause();
    paintMetrics(true);
  }

  function fail(message) {
    revision++;
    cancelFrame();
    phaseTo('failed', message);
    video.pause();
    paintMetrics(true);
  }

  function resetMetrics() {
    rounds = [makeRound(1, startedAt)];
    clearAt = null;
    logRound.length = 1;
    logRound.value = 'current';
    appendRoundOption(activeRound());
    manualTime.value = '';
    target = { ...target, slot: 1 };
    stats = emptyStats();
    paintEvents();
    $('video-position').textContent = formatTime(startedAt);
    $('pipeline-time').textContent = '—';
    $('manual-status').textContent = '选择座位和牌位，再选择牌面。';
    paintMetrics();
    paintManual();
  }

  function paintMetrics(includeP95 = false) {
    const rows = visibleRecords();
    const initial = rows.filter(row => row.initial).length;
    const running = rows.reduce((sum, row) => sum + hilo(row.rank), 0);
    $('card-count').textContent = rows.length.toLocaleString('zh-CN');
    $('card-breakdown').textContent = `${initial} 张开头已有 · ${rows.length - initial} 张新出现`;
    $('running-count').textContent = `${running > 0 ? '+' : ''}${running}`;
    $('replay-current-round').textContent = engine && validFile ? `第 ${activeRound().id} 局` : '—';
    $('frame-count').textContent = stats.frames.toLocaleString('zh-CN');
    $('frame-detail').textContent = validFile ? (useVideoFrames ? '按视频呈现帧取样' : '兼容取帧 · 时间为估计') : '等待录像';
    $('recognition-time').textContent = stats.frames ? `${(stats.engineMs / stats.frames).toFixed(2)} ms` : '—';
    $('capture-time').textContent = stats.frames ? `${(stats.captureMs / stats.frames).toFixed(1)} ms / 帧` : '—';
    $('skipped-frames').textContent = stats.frames && useVideoFrames ? stats.skipped.toLocaleString('zh-CN') : '—';
    if (includeP95 && stats.pipeline.length) {
      const sorted = stats.pipeline.slice().sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
      $('pipeline-time').textContent = `${p95.toFixed(1)} ms`;
    }
  }

  function hilo(rank) {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;
    if (['10', 'T', 'J', 'Q', 'K', 'A'].includes(rank)) return -1;
    return 0;
  }

  function key({ seat, slot }) {
    return `${seat}:${slot}`;
  }

  function visibleRecords(round) {
    if (round) return Array.from(round.records.values()).filter(row => !row.deleted);
    return rounds.flatMap(item => visibleRecords(item));
  }

  function orderedRecords(round) {
    return visibleRecords(round).sort((a, b) => a.round - b.round || a.time - b.time || a.seat - b.seat || a.slot - b.slot);
  }

  function seatName(seat) {
    return seat === 0 ? '庄家' : `座位 ${seat}`;
  }

  function editControl(event, role) {
    const button = document.createElement('button');
    const asCard = role === 'rank';
    const eventKey = key(event);
    const selected = eventKey === key(target);
    button.type = 'button';
    button.className = asCard
      ? `card card-edit${event.rank === 'A' ? ' ace' : ''}${selected ? ' is-target-card' : ''}`
      : 'button compact';
    button.dataset.editKey = eventKey;
    button.dataset.editRole = role;
    button.dataset.round = String(event.round);
    button.textContent = asCard ? event.rank : '编辑';
    button.disabled = !canEdit();
    button.setAttribute('aria-label', `校正${seatName(event.seat)}牌位 ${event.slot} 的 ${event.rank}`);
    button.setAttribute('aria-pressed', String(selected));
    return button;
  }

  function paintEvents() {
    const round = viewedRound();
    const rows = orderedRecords(round);
    const focused = document.activeElement?.dataset;
    eventBody.replaceChildren();
    exportButton.disabled = !rounds.some(item => visibleRecords(item).length);
    if (!rows.length) {
      const cell = eventBody.insertRow().insertCell();
      cell.colSpan = 9;
      cell.className = 'event-empty';
      cell.textContent = '还没有识牌记录。';
      return;
    }

    for (const event of rows) {
      const row = eventBody.insertRow();
      const eventKey = key(event);
      row.classList.toggle('is-target', eventKey === key(target));
      const fields = [
        formatTime(event.time), event.round, seatName(event.seat), event.slot, event.rank,
        Number.isFinite(event.confidence) ? event.confidence.toFixed(3) : '—',
        event.initial ? '开头已有' : '新出现', event.source === 'automatic' ? '自动识牌' : '人工',
      ];
      fields.forEach((value, index) => {
        const cell = row.insertCell();
        if (index === 4) {
          const card = editControl(event, 'rank');
          cell.append(card);
          if (focused?.round === card.dataset.round && eventKey === focused.editKey && focused.editRole === 'rank') card.focus({ preventScroll: true });
        } else {
          cell.textContent = value;
        }
        if (index === 6) cell.className = 'event-kind';
      });
      const button = editControl(event, 'button');
      row.insertCell().append(button);
      if (focused?.round === button.dataset.round && eventKey === focused.editKey && focused.editRole === 'button') button.focus({ preventScroll: true });
    }
  }

  function recordAutomatic(events) {
    const round = activeRound();
    let changed = false;
    for (const event of events) {
      const eventKey = key(event);
      // A visible row or deletion tombstone owns this exact seat and slot.
      if (round.records.has(eventKey)) continue;
      round.records.set(eventKey, { ...event, round: round.id, initial: event.initial && round.id === 1, source: 'automatic' });
      changed = true;
    }
    if (changed && viewedRound() === round) {
      paintEvents();
      paintManual();
    } else if (changed) {
      exportButton.disabled = false;
    }
    return changed;
  }

  function canEdit() {
    return Boolean(engine && validFile && ['running', 'paused', 'complete', 'failed'].includes(phase));
  }

  function paintManual() {
    const enabled = canEdit();
    const round = viewedRound();
    const targetKey = key(target);
    const entry = round.records.get(targetKey);
    const record = entry?.deleted ? null : entry;
    const needsTime = round.end !== null && !entry;
    logRound.disabled = !enabled || rounds.length < 2;
    manualSeat.value = String(target.seat);
    manualSlot.value = String(target.slot);
    manualSeat.disabled = !enabled;
    manualSlot.disabled = !enabled;
    manualTimeField.hidden = !needsTime;
    manualTime.disabled = !enabled || !needsTime;
    manualTime.min = String(round.start);
    manualTime.max = round.end === null ? '' : String(round.end);
    manualDelete.disabled = !enabled || !record;
    manualUndo.disabled = !enabled || !round.edits.length;
    manualNext.disabled = !enabled || nextOpenSlot(target.seat) === null;
    for (const button of manualSeatKeys.children) {
      button.disabled = !enabled;
      button.setAttribute('aria-pressed', String(Number(button.dataset.manualSeat) === target.seat));
    }
    for (const button of manualRanks.children) button.disabled = !enabled;
    const suffix = record ? ` · 当前 ${record.rank}` : entry?.deleted ? ' · 已删除' : ' · 空位';
    const mode = $('manual-mode');
    mode.textContent = record ? '校正牌面' : '录入牌面';
    mode.classList.toggle('is-correction', Boolean(record));
    $('manual-target').textContent = `第 ${round.id} 局 · ${seatName(target.seat)} · 牌位 ${target.slot}${suffix}`;
  }

  function nextOpenSlot(seat, after = 0) {
    const { records } = viewedRound();
    for (let slot = after + 1; slot <= slotLimit; slot++) {
      if (!records.has(key({ seat, slot }))) return slot;
    }
    return null;
  }

  function setTarget(seat, slot = nextOpenSlot(seat) ?? 1) {
    target = { seat, slot };
    manualTime.value = '';
    paintManual();
    paintEvents();
  }

  function selectNext() {
    const slot = nextOpenSlot(target.seat);
    if (slot !== null) setTarget(target.seat, slot);
  }

  function refreshManual(message) {
    $('manual-status').textContent = message;
    paintEvents();
    paintMetrics();
    paintManual();
  }

  function editRank(rank) {
    if (!canEdit() || !ranks.includes(rank)) return;
    const round = viewedRound();
    const position = target;
    const positionKey = key(position);
    const previous = round.records.get(positionKey);
    const time = previous?.time ?? (round.end === null ? Math.max(round.start, video.currentTime) : manualTime.valueAsNumber);
    if (!Number.isFinite(time) || time < round.start || (round.end !== null && time > round.end)) {
      $('manual-status').textContent = `请输入第 ${round.id} 局内的录像时间（${formatTime(round.start)} 至 ${formatTime(round.end)}）。`;
      manualTime.focus();
      return;
    }
    round.edits.push({ position, previous });
    round.records.set(positionKey, {
      ...position, round: round.id, rank, time, confidence: null,
      initial: previous?.initial ?? (round.id === 1 && time - round.start <= (profile.openingSeconds ?? 0.2)), source: 'manual',
    });
    if (round === activeRound()) engine.setManual(position.seat, position.slot);
    manualTime.value = '';
    if (previous === undefined) {
      const next = nextOpenSlot(position.seat, position.slot) ?? nextOpenSlot(position.seat);
      if (next !== null) target = { ...position, slot: next };
    }
    refreshManual(`第 ${round.id} 局${seatName(position.seat)}牌位 ${position.slot} 已${previous && !previous.deleted ? '校正' : '录入'}为 ${rank}。`);
  }

  function deleteRank() {
    const round = viewedRound();
    const previous = round.records.get(key(target));
    if (!canEdit() || !previous || previous.deleted) return;
    round.edits.push({ position: target, previous });
    round.records.set(key(target), { ...previous, deleted: true });
    if (round === activeRound()) engine.setManual(target.seat, target.slot);
    refreshManual(`${seatName(target.seat)}牌位 ${target.slot} 已删除并屏蔽本次自动识牌。`);
  }

  function undoEdit() {
    const round = viewedRound();
    if (!canEdit() || !round.edits.length) return;
    const { position, previous } = round.edits.pop();
    if (previous === undefined) {
      round.records.delete(key(position));
      if (round === activeRound()) engine.reopen(position.seat, position.slot);
    } else {
      round.records.set(key(position), previous);
      if (round === activeRound()) engine.setManual(position.seat, position.slot);
    }
    target = position;
    refreshManual(`已撤销对${seatName(position.seat)}牌位 ${position.slot} 的修改。`);
  }

  function advanceRound(seconds) {
    const previous = activeRound();
    previous.end = seconds;
    const next = makeRound(previous.id + 1, seconds);
    rounds.push(next);
    appendRoundOption(next);
    engine.reset();
    clearAt = null;
    if (logRound.value === 'current') {
      target = { ...target, slot: 1 };
      manualTime.value = '';
      $('manual-status').textContent = `已清桌，开始记录第 ${next.id} 局。`;
      paintEvents();
    }
    paintManual();
  }

  function processFrame(seconds, presented) {
    if (phase !== 'running' || video.seeking || video.readyState < 2 || !Number.isFinite(seconds) ||
        seconds < startedAt || seconds <= stats.lastTime) return;
    if (Number.isFinite(presented)) {
      if (stats.lastPresented === presented) return;
      if (useVideoFrames && stats.lastPresented !== null) stats.skipped += Math.max(0, presented - stats.lastPresented - 1);
      stats.lastPresented = presented;
    } else if (!useVideoFrames && seconds - stats.lastTime < 0.031) return;

    const mediaMs = seconds * 1000;
    if (mediaMs - stats.lastTime * 1000 > capture.clearFrameGap) clearAt = null;
    stats.lastTime = seconds;
    try {
      const started = performance.now();
      const { x, y, width, height } = engine.crop;
      const scaleX = video.videoWidth / profile.width;
      const scaleY = video.videoHeight / profile.height;
      context.drawImage(video, x * scaleX, y * scaleY, width * scaleX, height * scaleY, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const captured = performance.now();
      const round = activeRound();
      const empty = continuous && round.records.size > 0 && capture.isTableClear(engine, pixels);
      clearAt = empty ? clearAt ?? mediaMs : null;
      const advanced = clearAt !== null && mediaMs - clearAt >= capture.autoClearDuration - 1e-6;
      const events = advanced ? [] : engine.read(pixels, seconds - round.start).events;
      const done = performance.now();
      if (advanced) advanceRound(seconds);

      stats.frames++;
      stats.engineMs += done - captured;
      stats.captureMs += captured - started;
      stats.pipeline[(stats.frames - 1) % timingWindow] = done - started;
      const changed = recordAutomatic(events.map(event => ({ ...event, time: seconds })));
      if (advanced || changed || done - stats.lastPaint >= 250) {
        $('video-position').textContent = formatTime(seconds);
        paintMetrics();
        stats.lastPaint = done;
      }
    } catch (error) {
      fail(`处理画面失败。${error.message || '请换一段同布局的录像。'}`);
    }
  }

  function scheduleFrame() {
    if (phase !== 'running' || frameRequest !== null) return;
    if (useVideoFrames) {
      frameRequest = video.requestVideoFrameCallback((_now, metadata) => {
        frameRequest = null;
        processFrame(metadata.mediaTime, metadata.presentedFrames);
        scheduleFrame();
      });
    } else {
      frameRequest = requestAnimationFrame(() => {
        frameRequest = null;
        const presented = video.getVideoPlaybackQuality?.().totalVideoFrames || undefined;
        processFrame(video.currentTime, presented);
        scheduleFrame();
      });
    }
  }

  function selectedProfile() {
    if (!['classic-close', 'classic-front'].includes(layoutPicker.value)) return reference;
    const live = window.BlackjackLiveProfile;
    const augment = glyphBank.augment;
    const factory = layoutPicker.value === 'classic-front' ? live.forFrontCapture : live.forCloseCapture;
    return factory(live.forCapture(reference, augment), augment, window.BlackjackPublicGlyphs?.templates?.['10']);
  }

  async function playRecognition(fromStart = false) {
    if (!validFile) return;
    if (phase === 'running' && !fromStart) {
      pauseRecognition();
      return;
    }

    const fresh = fromStart || phase !== 'paused';
    const start = startTime.valueAsNumber;
    if (fresh && (!Number.isFinite(start) || start < 0 || start >= video.duration)) {
      const status = $('recognition-status');
      status.textContent = '录像起点需要落在录像时长内。';
      status.classList.add('error');
      return;
    }
    const attempt = ++revision;
    cancelFrame();
    if (fresh) {
      try {
        profile = selectedProfile();
        engine = recognition.create(profile);
        let loadedGlyphs = 0;
        if (learnedGlyphs.checked) {
          for (const [rank, samples] of Object.entries(glyphBank.load())) {
            for (const sample of samples) {
              if (engine.addTemplate(rank, sample)) loadedGlyphs++;
            }
          }
        }
        $('replay-glyph-count').textContent = String(loadedGlyphs);
        continuous = roundMode.value === 'auto';
        canvas.width = engine.crop.width;
        canvas.height = engine.crop.height;
        context.imageSmoothingEnabled = false;
        startedAt = start;
        video.currentTime = startedAt;
        $('active-replay-layout').textContent = layoutPicker.selectedOptions[0].textContent;
        $('profile-size').textContent = `${profile.width} × ${profile.height}`;
        resetMetrics();
      } catch (error) {
        fail(`无法初始化识牌器。${error.message || ''}`);
        return;
      }
    }

    video.muted = true;
    video.playbackRate = Number(speed.value);
    $('pipeline-time').textContent = '暂停或结束后统计';
    phaseTo('running', continuous ? '正在连续识牌，清桌后自动换局。' : '正在按画面顺序识别本局。');
    scheduleFrame();
    try {
      await video.play();
    } catch (error) {
      if (attempt === revision) fail(`浏览器无法播放此录像。${error.message || ''}`);
    }
  }

  function loadFile(file) {
    if (!file) return;
    revision++;
    cancelFrame();
    validFile = false;
    engine = null;
    $('replay-glyph-count').textContent = '—';
    startedAt = 0;
    startTime.value = '0';
    phaseTo('loading', '正在读取本地录像…');
    video.pause();
    video.hidden = true;
    $('video-placeholder').hidden = false;
    resetMetrics();
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(file);
    video.src = fileUrl;
    video.load();
  }

  video.addEventListener('loadedmetadata', () => {
    if (!fileUrl || video.src !== fileUrl) return;
    const { videoWidth, videoHeight } = video;
    const relativeAspect = (videoWidth / videoHeight) / (reference.width / reference.height);
    if (videoWidth < 1280 || videoHeight < 720 || Math.abs(relativeAspect - 1) > 0.015) {
      fail(`录像为 ${videoWidth} × ${videoHeight}。请选择同布局的横向完整牌桌录像，分辨率至少 1280 × 720。`);
      return;
    }
    validFile = true;
    video.hidden = false;
    $('video-placeholder').hidden = true;
    phaseTo('ready', `已读到 ${videoWidth} × ${videoHeight} 的横向录像。若画面正面拍到完整桌面，请选「Classic 全桌 · 牌点自定位」。`);
    paintMetrics();
  });

  video.addEventListener('ended', () => {
    if (phase !== 'running') return;
    cancelFrame();
    if (Number.isFinite(video.duration)) {
      activeRound().end = video.duration;
      $('video-position').textContent = formatTime(video.duration);
    }
    const played = rounds.filter(round => visibleRecords(round).length);
    const count = visibleRecords().length;
    if (logRound.value === 'current' && played.length && played.at(-1) !== activeRound()) {
      logRound.value = String(played.at(-1).id);
      target = { ...target, slot: nextOpenSlot(target.seat) ?? 1 };
      paintEvents();
    }
    const emptyMessage = layoutPicker.value === 'classic-front'
      ? '识别结束，未确认牌面。请核对录像是否为完整游戏画面，并从有发牌的时间开始重扫。'
      : '识别结束，未确认牌面。正面全桌画面可切换「Classic 全桌 · 牌点自定位」后从起点重扫。';
    phaseTo('complete', count ? `识别结束，记录 ${played.length} 局、${count} 张牌。` : emptyMessage);
    paintMetrics(true);
  });

  video.addEventListener('pause', () => {
    if (phase === 'running' && video.paused && !video.ended) pauseRecognition();
  });

  video.addEventListener('error', () => {
    if (!fileUrl || !video.error) return;
    validFile = false;
    fail('无法读取此录像。请确认浏览器支持文件格式，或改用常见的 H.264 MP4 文件。');
  });

  function exportCsv() {
    const rows = orderedRecords();
    if (!rows.length) return;
    const lines = [`time_seconds,seat,slot,rank,confidence,appearance,source${continuous ? ',round' : ''}`];
    for (const event of rows) {
      const fields = [
        event.time.toFixed(3), event.seat, event.slot, event.rank,
        Number.isFinite(event.confidence) ? event.confidence.toFixed(4) : '',
        event.initial ? 'opening_snapshot' : 'newly_visible', event.source,
      ];
      if (continuous) fields.push(event.round);
      lines.push(fields.join(','));
    }
    const blob = new Blob(['\uFEFF', lines.join('\r\n'), '\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'blackjack-recognition.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function handleShortcut(event) {
    if (!canEdit() || event.repeat || event.defaultPrevented) return;
    if (event.target.closest?.('input, select, textarea, [contenteditable]')) return;
    const keyName = event.key.toUpperCase();
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && keyName === 'Z') {
      event.preventDefault();
      undoEdit();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const shortcutSeat = /^Digit([1-7])$/.exec(event.code)?.[1];
    const rank = keyName === 'T' || keyName === '0' ? '10' : keyName;
    if (event.shiftKey && shortcutSeat) setTarget(Number(shortcutSeat));
    else if (keyName === 'D') setTarget(0);
    else if (!event.shiftKey && ranks.includes(rank)) editRank(rank);
    else if (keyName === 'DELETE') deleteRank();
    else if (keyName === 'ESCAPE') selectNext();
    else return;
    event.preventDefault();
  }

  if (!profile || !recognition || !capture?.isTableClear || !glyphBank || !context) {
    fileInput.disabled = true;
    phaseTo('failed', '无法载入识牌配置或画布，请确认识牌文件完整。');
    return;
  }

  $('profile-size').textContent = `${profile.width} × ${profile.height}`;
  for (let slot = 1; slot <= slotLimit; slot++) {
    const option = document.createElement('option');
    option.value = String(slot);
    option.textContent = String(slot);
    manualSlot.append(option);
  }
  for (const seat of [0, 7, 6, 5, 4, 3, 2, 1]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button compact entry-seat-key';
    button.dataset.manualSeat = String(seat);
    button.textContent = seatName(seat);
    manualSeatKeys.append(button);
  }
  for (const rank of ranks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button rank-key';
    button.dataset.rank = rank;
    button.textContent = rank;
    manualRanks.append(button);
  }
  paintManual();
  fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
  startButton.addEventListener('click', () => playRecognition());
  restartButton.addEventListener('click', () => playRecognition(true));
  exportButton.addEventListener('click', exportCsv);
  logRound.addEventListener('change', () => setTarget(target.seat));
  for (const control of [layoutPicker, roundMode, learnedGlyphs, startTime]) {
    control.addEventListener('change', () => {
      if (phase === 'paused') $('recognition-status').textContent = '点「从起点重扫」应用刚修改的识牌设置。';
    });
  }
  speed.addEventListener('change', () => { video.playbackRate = Number(speed.value); });
  manualSeat.addEventListener('change', () => setTarget(Number(manualSeat.value)));
  manualSlot.addEventListener('change', () => setTarget(target.seat, Number(manualSlot.value)));
  manualSeatKeys.addEventListener('click', event => {
    const button = event.target.closest('button[data-manual-seat]');
    if (button) setTarget(Number(button.dataset.manualSeat));
  });
  manualNext.addEventListener('click', selectNext);
  manualRanks.addEventListener('click', event => {
    const button = event.target.closest('button[data-rank]');
    if (button) editRank(button.dataset.rank);
  });
  manualDelete.addEventListener('click', deleteRank);
  manualUndo.addEventListener('click', undoEdit);
  eventBody.addEventListener('click', event => {
    const button = event.target.closest('button[data-edit-key]');
    if (!button) return;
    const row = viewedRound().records.get(button.dataset.editKey);
    if (row) setTarget(row.seat, row.slot);
  });
  document.addEventListener('keydown', handleShortcut);
  window.addEventListener('pagehide', event => {
    if (!event.persisted && fileUrl) URL.revokeObjectURL(fileUrl);
  });
})();
