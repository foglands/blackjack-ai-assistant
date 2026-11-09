(function (root) {
  'use strict';

  const layoutStorage = 'blackjack-lab:layout:v1';
  const presetStorage = 'blackjack-lab:table-layouts:v1';
  const classic = { id: 'classic', name: 'Classic 参考桌型', builtin: true, seatCount: 7 };
  const classicClose = { id: 'classic-close', name: 'Classic 近景校准（试用）', builtin: true, seatCount: 7 };
  const builtins = [classic, classicClose];
  const anchorNames = ['first', 'second', 'third'];
  const maxPresets = 24;

  function presetSeatCount(preset) {
    return Number.isInteger(preset.seatCount) && preset.seatCount >= 1 && preset.seatCount <= 9 ? preset.seatCount : 7;
  }

  function validRect(rect) {
    const { x, y, width, height } = rect ?? {};
    return [x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 &&
      x + width <= 1.00001 && y + height <= 1.00001;
  }
  const frameInterval = 48;
  const clearDuration = 650;
  const autoClearDuration = 1000;
  const clearFrameGap = 420;

  function isTableClear(recognition, frame) {
    const presence = recognition.visibleOpeningSlots(frame);
    return presence.visible === 0 && presence.checked >= 2 && !recognition.hasMappedCard(frame);
  }

  function makeMap(bounds, profile, rect, width, height) {
    const columns = new Int32Array(bounds.width);
    const rows = new Int32Array(bounds.height);
    for (let x = 0; x < columns.length; x++) {
      const ratio = rect.x + (bounds.x + x + 0.5) * rect.width / profile.width;
      columns[x] = 4 * Math.min(width - 1, Math.floor(ratio * width));
    }
    for (let y = 0; y < rows.length; y++) {
      const ratio = rect.y + (bounds.y + y + 0.5) * rect.height / profile.height;
      rows[y] = 4 * width * Math.min(height - 1, Math.floor(ratio * height));
    }
    return { rows, columns };
  }

  function extract(bgra, map, output) {
    let position = 0;
    for (const row of map.rows) {
      for (const col of map.columns) {
        const i = row + col;
        output[position++] = (77 * bgra[i + 2] + 150 * bgra[i + 1] + 29 * bgra[i]) >> 8;
      }
    }
  }

  function previewSize(width, height, scanning) {
    const scale = scanning ? Math.min(1, 640 / width) : Math.min(1, 1440 / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  function previewFrame(bgra, width, height, { width: previewWidth, height: previewHeight }) {
    const data = new Uint8ClampedArray(previewWidth * previewHeight * 4);
    let at = 0;
    for (let y = 0; y < previewHeight; y++) {
      const row = Math.floor(y * height / previewHeight) * width;
      for (let x = 0; x < previewWidth; x++) {
        const i = (row + Math.floor(x * width / previewWidth)) * 4;
        data[at++] = bgra[i + 2];
        data[at++] = bgra[i + 1];
        data[at++] = bgra[i];
        data[at++] = 255;
      }
    }
    return { data, width: previewWidth, height: previewHeight };
  }

  function layoutKey(preset) {
    return preset.id === classicClose.id ? `${layoutStorage}:${preset.id}` : layoutStorage;
  }

  function loadLayout(preset) {
    try {
      const value = JSON.parse(root.localStorage.getItem(layoutKey(preset)));
      if (Number.isFinite(value?.aspect) && value.aspect > 0 && validRect(value.crop) &&
          value.anchors && typeof value.anchors === 'object' && !Array.isArray(value.anchors)) return value;
    } catch {
      // An unsaved layout can always be aligned again.
    }
    return null;
  }

  function loadPresets() {
    try {
      const value = JSON.parse(root.localStorage.getItem(presetStorage));
      const presets = Array.isArray(value?.presets) ? value.presets.filter(item =>
        typeof item?.id === 'string' && /^custom-[a-z0-9-]+$/.test(item.id) &&
        typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 60 &&
        item.seats && typeof item.seats === 'object' && !Array.isArray(item.seats)).slice(0, maxPresets) : [];
      return { presets, selected: [...builtins, ...presets].some(item => item.id === value?.selected) ? value.selected : classic.id };
    } catch {
      return { presets: [], selected: classic.id };
    }
  }

  function create({ onReady = () => {}, onStatus = () => {}, onFrame = () => {}, onTiming = () => {} } = {}) {
    const host = root.chrome?.webview;
    const bank = root.BlackjackGlyphBank;
    const layout = root.BlackjackLiveLayout;
    const custom = root.BlackjackCustomLiveProfile;
    const publicModel = root.BlackjackPublicGlyphs;
    const publicGlyphsAvailable = Boolean(publicModel?.templates && Object.keys(publicModel.templates).length);
    const referenceProfile = root.BlackjackLiveProfile.forCapture(root.BlackjackRecognitionProfile, bank.augment);
    const closeProfile = root.BlackjackLiveProfile.forCloseCapture(referenceProfile, bank.augment, publicModel?.templates?.['10']);
    let profile, recognition, sampled;
    const sharedGlyphs = bank.load();
    const { presets, selected } = loadPresets();
    let preset = [...builtins, ...presets].find(item => item.id === selected) ?? classic;
    let baseProfile = preset.id === classicClose.id ? closeProfile : referenceProfile;
    let dirty = false;
    let customProjection = null;
    const glyphKey = () => preset.builtin ? bank.storageKey : `${bank.storageKey}:${preset.id}`;
    const presetGlyphs = new Map();
    function learnedGlyphs() {
      if (preset.builtin) return sharedGlyphs;
      if (!presetGlyphs.has(preset.id)) presetGlyphs.set(preset.id, bank.load(glyphKey()));
      return presetGlyphs.get(preset.id);
    }
    const locks = new Set();
    const suppressed = new Set();
    let savedLayout = loadLayout(preset);
    let anchors = {};
    let draftAnchors = null;
    let active = false, paused = false, choosing = false;
    let dimensions = null, crop = null, map = null, preview = null;
    let timer = null, requested = null, previewAt = -Infinity;
    let lastFrameAt = null, lastSampleAt = null, scanStarted = null, clearAt = null, recoveryUntil = null;
    let waitingForClear = false, allowOpening = true;
    let usingSystem = false, system = null, selection = 0, nativePaused = false;

    function installProfile(next) {
      profile = next;
      recognition = root.BlackjackRecognition.create(profile);
      for (const glyphs of preset.builtin ? [sharedGlyphs] : [sharedGlyphs, learnedGlyphs()]) {
        for (const [rank, samples] of Object.entries(glyphs)) samples.forEach(rows => recognition.addTemplate(rank, rows));
      }
      const { width, height } = recognition.crop;
      sampled = { width, height, channels: 1, data: new Uint8Array(width * height) };
      if (system) {
        system.canvas.width = width;
        system.canvas.height = height;
        system.context.imageSmoothingEnabled = false;
      }
      map = crop && dimensions ? makeMap(recognition.crop, profile, crop, dimensions.width, dimensions.height) : null;
      for (const key of locks) recognition.setManual(...key.split(':').map(Number));
      for (const seat of suppressed) suppressSeat(seat);
      scanStarted = null;
      clearAt = null;
      lastSampleAt = null;
    }

    function compatibleLayout() {
      return savedLayout && dimensions && Math.abs(dimensions.width / dimensions.height / savedLayout.aspect - 1) <= 0.06;
    }

    function saveLayout() {
      if (!crop || !dimensions) return;
      savedLayout = { crop, anchors, aspect: dimensions.width / dimensions.height };
      try { root.localStorage.setItem(layoutKey(preset), JSON.stringify(savedLayout)); } catch { /* in-memory calibration */ }
    }

    function persistPresets() {
      const selected = preset.builtin || presets.some(item => item.id === preset.id) ? preset.id : classic.id;
      try {
        root.localStorage.setItem(presetStorage, JSON.stringify({ presets, selected }));
        return true;
      } catch {
        return false;
      }
    }

    function listLayouts() {
      const list = [...builtins, ...presets];
      if (!list.some(item => item.id === preset.id)) list.push(preset);
      return list.map(({ id, name, builtin = false }) => ({ id, name, builtin }));
    }

    function changePreset(next) {
      if (preset.id === next.id) return;
      preset = next;
      baseProfile = preset.id === classicClose.id ? closeProfile : referenceProfile;
      savedLayout = loadLayout(preset);
      dirty = !next.builtin && !presets.some(item => item.id === next.id);
      crop = map = null;
      anchors = {};
      draftAnchors = null;
      clearScan();
      allowOpening = true;
      recoveryUntil = null;
      persistPresets();
    }

    function selectLayout(id) {
      if (map && id !== preset.id) return { ok: false, message: '请先暂停识牌，再切换桌型。' };
      const next = [...builtins, ...presets].find(item => item.id === id);
      if (!next) return { ok: false, message: '此桌型尚未保存或已不可用。' };
      changePreset(next);
      return { ok: true, message: `已选择「${preset.name}」。请核对预览中的牌点位置。` };
    }

    function newLayout(name) {
      if (!custom) return { ok: false, message: '自定义桌型组件未加载。' };
      if (map) return { ok: false, message: '请先暂停识牌，再新建桌型。' };
      if (presets.length >= maxPresets) return { ok: false, message: `本机已保存 ${maxPresets} 个桌型。` };
      const label = String(name ?? '').trim() || '自定义桌型';
      if (label.length > 60) return { ok: false, message: '桌型名称最多 60 个字符。' };
      const id = 'custom-' + (root.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      changePreset({ id, name: label, seats: {}, seatCount: 7 });
      return { ok: true, message: `已建立「${label}」。请在预览中标记实际牌点。` };
    }

    function getCrop() {
      if (crop) return { ...crop };
      if (preset.builtin) return compatibleLayout() ? { ...savedLayout.crop } : null;
      const saved = preset.crop;
      return validRect(saved) && dimensions && Number.isFinite(preset.aspect) && preset.aspect > 0 &&
        Math.abs(dimensions.width / dimensions.height / preset.aspect - 1) <= 0.06 ? { ...saved } : null;
    }

    function customProfile(rect, seats = preset.seats) {
      if (!custom || !dimensions || !rect) return { ok: false, message: '请先连接窗口并框选牌桌。' };
      if (!validRect(rect)) return { ok: false, message: '识别区域须落在预览画面内。' };
      const pixelsWide = rect.width * dimensions.width;
      const pixelsHigh = rect.height * dimensions.height;
      if (pixelsWide < 96 || pixelsHigh < 72) return { ok: false, message: '请扩大框选范围或放大牌桌窗口。' };
      const scale = Math.min(1, 2328 / Math.max(pixelsWide, pixelsHigh));
      const width = Math.round(pixelsWide * scale);
      const height = Math.round(pixelsHigh * scale);
      const seatCount = presetSeatCount(preset);
      const usePublic = publicGlyphsAvailable && preset.publicGlyphs === true;
      if (customProjection?.seats === seats && customProjection.width === width && customProjection.height === height &&
          customProjection.seatCount === seatCount && customProjection.usePublic === usePublic) return customProjection.result;
      const result = custom.build({ width, height, seats, seatCount, templates: baseProfile.templates });
      if (result.ok && usePublic) {
        result.profile.fallbackTemplates = publicModel.templates;
        result.profile.liveSearch = { ...result.profile.liveSearch, ...publicModel.search };
      }
      customProjection = { seats, width, height, seatCount, usePublic, result };
      return result;
    }

    function layoutStatus(rect = getCrop()) {
      const localGlyphs = learnedGlyphs();
      const missingPrimaryRanks = bank.ranks.filter(rank => !baseProfile.templates[rank]?.length &&
        !sharedGlyphs[rank]?.length && !localGlyphs[rank]?.length);
      if (preset.builtin) return { ...preset, canStart: true, canSave: false, dirty: false, maxSlot: 1, seats: [], message: '', missingPrimaryRanks };
      const seatCount = presetSeatCount(preset);
      const seats = Object.entries(preset.seats).filter(([seat, item]) => /^\d$/.test(seat) && Number(seat) <= seatCount && item)
        .map(([seat, item]) => ({ seat: Number(seat), points: anchorNames.flatMap((key, index) => item[key] ? [index + 1] : []),
          flip: Boolean(item.patch?.flip), invert: Boolean(item.patch?.invert) }));
      const ready = seats.some(item => item.seat === 0 && item.points.includes(1)) &&
        seats.some(item => item.seat > 0 && item.points.includes(1));
      const built = ready ? customProfile(rect) : null;
      const canStart = Boolean(built?.ok);
      const coverage = built?.profile?.slots ?? [];
      const message = !ready ? '至少标记庄家和一个玩家的第一张牌点。' : !canStart ? built.message :
        `已校准 ${seats.length} 个位置，覆盖 ${coverage.length} 个牌位。只标首牌的位置只扫描首牌。`;
      return { id: preset.id, name: preset.name, builtin: false, canStart, canSave: canStart, dirty, maxSlot: 3,
        seatCount, seats, coverage: coverage.map(({ seat, slot }) => ({ seat, slot })), message, missingPrimaryRanks,
        publicGlyphsAvailable, publicGlyphs: publicGlyphsAvailable && preset.publicGlyphs === true };
    }

    function setLayoutPublicGlyphs(enabled) {
      if (!publicGlyphsAvailable || preset.builtin || map || typeof enabled !== 'boolean') {
        return { ok: false, message: '请在自定义桌型的校准阶段设置公开样本辅助识牌。' };
      }
      if (enabled !== Boolean(preset.publicGlyphs)) {
        preset = { ...preset, publicGlyphs: enabled };
        dirty = true;
      }
      return { ok: true, message: enabled ? '已启用公开样本辅助识牌。' : '已关闭公开样本辅助识牌。' };
    }

    function setLayoutSeatCount(count) {
      if (preset.builtin || map || !Number.isInteger(count) || count < 1 || count > 9) {
        return { ok: false, message: '请暂停识牌，并为自定义桌型选择 1 至 9 个玩家位置。' };
      }
      if (Object.keys(preset.seats).some(seat => Number(seat) > count)) {
        return { ok: false, message: '请先移除超出新座位数的标记。' };
      }
      if (count !== presetSeatCount(preset)) {
        preset = { ...preset, seatCount: count };
        dirty = true;
      }
      return { ok: true, message: `已设为 ${count} 个玩家位置。` };
    }

    function savePreset(name, rect = getCrop()) {
      const status = layoutStatus(rect);
      if (!status.canSave) return { ok: false, message: status.message || '此桌型无需另存。' };
      const label = String(name ?? preset.name).trim();
      if (!label || label.length > 60) return { ok: false, message: '请输入 1 至 60 个字符的桌型名称。' };
      const saved = { ...preset, name: label, crop: { ...rect }, aspect: dimensions.width / dimensions.height };
      const index = presets.findIndex(item => item.id === saved.id);
      if (index < 0 && presets.length >= maxPresets) return { ok: false, message: `本机已保存 ${maxPresets} 个桌型。` };
      if (index < 0) presets.push(saved);
      else presets[index] = saved;
      preset = saved;
      dirty = false;
      const stored = persistPresets();
      return { ok: true, saved: stored, message: stored ? `桌型「${label}」已保存到本机。` : '本机存储不可用，此桌型仅在本次运行有效。' };
    }

    function projectAnchors(points, rect) {
      const converted = {};
      for (const [seat, point] of Object.entries(points)) {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
        const x = (point.x - rect.x) / rect.width;
        const y = (point.y - rect.y) / rect.height;
        if (x > 0 && x < 1 && y > 0 && y < 1) converted[seat] = { x: x * baseProfile.width, y: y * baseProfile.height };
      }
      return layout.transform(baseProfile, converted);
    }

    function send(type) {
      host.postMessage({ type });
    }

    function schedule(delay = frameInterval) {
      if (!active || paused || timer !== null || requested !== null) return;
      timer = root.setTimeout(() => {
        timer = null;
        if (!active || paused) return;
        if (system) return systemFrame();
        requested = performance.now();
        send('capture:frame');
      }, delay);
    }

    function cancel() {
      if (timer !== null) root.clearTimeout(timer);
      timer = null;
    }

    function clearScan() {
      recognition.reset();
      locks.clear();
      suppressed.clear();
      scanStarted = null;
      clearAt = null;
      waitingForClear = false;
      lastSampleAt = null;
    }

    function closeState() {
      selection++;
      if (system) {
        const { video, stream } = system;
        system = null;
        video.srcObject = null;
        stream.getTracks().forEach(track => track.stop());
      }
      usingSystem = false;
      nativePaused = false;
      active = paused = choosing = false;
      cancel();
      requested = null;
      dimensions = crop = map = preview = null;
      anchors = {};
      draftAnchors = null;
      lastFrameAt = null;
      recoveryUntil = null;
      previewAt = -Infinity;
      clearScan();
      allowOpening = true;
    }

    function choose() {
      if (!host || choosing) return false;
      if (active) closeState();
      choosing = true;
      send('capture:choose');
      return true;
    }

    function canChooseSystem() {
      return Boolean(host && root.navigator?.mediaDevices?.getDisplayMedia);
    }

    function chooseSystem() {
      if (!canChooseSystem() || choosing) return false;
      if (active) stop();
      usingSystem = choosing = true;
      const attempt = ++selection;
      root.navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'window', frameRate: { ideal: 30, max: 30 } },
        audio: false, monitorTypeSurfaces: 'exclude', selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude', systemAudio: 'exclude',
      }).then(async stream => {
        const track = stream.getVideoTracks()[0];
        if (attempt !== selection || track?.getSettings().displaySurface !== 'window') {
          stream.getTracks().forEach(item => item.stop());
          if (attempt === selection) throw new Error('请选择窗口选项卡里的牌桌窗口。');
          return;
        }

        const video = root.document.createElement('video');
        const canvas = root.document.createElement('canvas');
        const previewCanvas = root.document.createElement('canvas');
        canvas.width = recognition.crop.width;
        canvas.height = recognition.crop.height;
        system = { video, stream, track, canvas, previewCanvas, time: -1, frames: -1,
          context: canvas.getContext('2d', { willReadFrequently: true }),
          previewContext: previewCanvas.getContext('2d', { willReadFrequently: true }) };
        system.context.imageSmoothingEnabled = false;
        track.addEventListener('ended', () => {
          if (system?.track !== track) return;
          closeState();
          onStatus({ state: 'stopped', message: '系统窗口共享已结束。' });
        }, { once: true });
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        if (attempt !== selection) return;
        if (!video.videoWidth || !video.videoHeight) throw new Error('窗口没有提供可读取画面。');
        choosing = false;
        active = true;
        dimensions = { width: video.videoWidth, height: video.videoHeight };
        onReady({ title: track.label || '系统选定窗口', ...dimensions, needsCrop: true });
        schedule(0);
      }).catch(error => {
        if (attempt !== selection) return;
        closeState();
        const cancelled = error.name === 'NotAllowedError' || error.name === 'AbortError';
        onStatus({ state: cancelled ? 'cancelled' : 'error', message: cancelled
          ? '未开始系统窗口共享。可以重新选择窗口。' : error.message });
      });
      return true;
    }

    function stop() {
      if (host && !usingSystem && (active || choosing)) send('capture:stop');
      closeState();
    }

    function pause() {
      if (!active || paused) return;
      paused = true;
      clearAt = null;
      cancel();
    }

    function resume() {
      if (!active || !paused) return;
      paused = false;
      schedule(0);
    }

    function setCrop(rect, { mode } = {}) {
      if (!active || !dimensions || !rect) return { ok: false, message: '请先选择窗口。' };
      if (!preset.builtin) {
        const status = layoutStatus(rect);
        if (!status.canStart) return { ok: false, message: status.message };
        const result = customProfile(rect);
        crop = { ...rect };
        if (locks.size || mode === 'complete') allowOpening = false;
        installProfile(result.profile);
        return { ok: true, message: status.message };
      }
      const { x, y, width, height } = rect;
      if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 0.2 || height < 0.2 ||
          x + width > 1.00001 || y + height > 1.00001) {
        return { ok: false, message: '请在窗口预览内圈出完整牌桌画面。' };
      }
      const ratio = width * dimensions.width / (height * dimensions.height);
      if (ratio < 1 || ratio > 3.4) return { ok: false, message: '请选择横向的完整牌桌画面，并排除浏览器边框。' };
      const nextCrop = { x, y, width, height };
      let nextAnchors = draftAnchors ?? (compatibleLayout() ? savedLayout.anchors : {});
      let adjusted = projectAnchors(nextAnchors, nextCrop);
      if (!adjusted.ok) {
        nextAnchors = {};
        adjusted = layout.transform(baseProfile, {});
      }
      if (!adjusted.ok) return adjusted;
      crop = nextCrop;
      anchors = nextAnchors;
      draftAnchors = null;
      if (locks.size || mode === 'complete') allowOpening = false;
      installProfile(adjusted.profile);
      saveLayout();
      return { ok: true, message: '区域已对齐，开始识别可见牌。' };
    }

    function getGuide(rect = getCrop()) {
      if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return [];
      if (!preset.builtin) {
        const result = customProfile(rect);
        if (!result.ok) return [];
        return guideFor(result.profile, rect, result.profile.slots, slot => Boolean(preset.seats[slot.seat]?.[anchorNames[slot.slot - 1]]));
      }
      const points = crop ? anchors : draftAnchors ?? (compatibleLayout() ? savedLayout.anchors : {});
      const projected = projectAnchors(points, rect);
      const geometry = projected.ok ? projected.profile : baseProfile;
      const openings = geometry.slots.filter(slot => slot.slot === 1);
      const located = new Map((map && preset.id === classicClose.id ? recognition.openingLocations?.() ?? [] : [])
        .map(point => [point.seat, point]));
      const guides = openings.map(slot => located.has(slot.seat) ? { ...slot, ...located.get(slot.seat) } : slot);
      return guideFor(geometry, rect, guides, slot => {
        const point = points[slot.seat];
        return Boolean(!located.has(slot.seat) && projected.ok && point && point.x > rect.x && point.x < rect.x + rect.width &&
          point.y > rect.y && point.y < rect.y + rect.height);
      }).map(guide => located.has(guide.seat) ? { ...guide, tracked: true } : guide);
    }

    function guideFor(geometry, rect, slots, anchored) {
      return slots.map(slot => {
        const width = (slot.w + Math.abs(slot.v ?? 0) * slot.h) * rect.width / geometry.width;
        const height = (slot.h + Math.abs(slot.u ?? 0) * slot.w) * rect.height / geometry.height;
        return { seat: slot.seat, slot: slot.slot, width, height,
          x: rect.x + slot.x * rect.width / geometry.width - width / 2,
          y: rect.y + slot.y * rect.height / geometry.height - height / 2,
          anchored: anchored(slot),
        };
      });
    }

    function setSeatAnchor(seat, point, slot = 1, rect = getCrop()) {
      if (!preset.builtin) return setCustomAnchor(seat, point, slot, rect);
      rect = crop ?? rect;
      if (!active || !validRect(rect)) return { ok: false, message: '请先连接窗口并框选牌桌。' };
      const { x, y } = point ?? {};
      if (!Number.isInteger(seat) || seat < 0 || seat > 7 || !Number.isFinite(x) || !Number.isFinite(y) ||
          x <= rect.x || y <= rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) {
        return { ok: false, message: '请点击识别区域内该座位第一张牌的点数。' };
      }
      const points = crop ? anchors : draftAnchors ?? (compatibleLayout() ? savedLayout.anchors : {});
      const next = { ...points, [seat]: { x, y } };
      const adjusted = projectAnchors(next, rect);
      if (!adjusted.ok) return adjusted;
      const label = seat === 0 ? '庄家' : `座位 ${seat}`;
      if (!crop) {
        draftAnchors = next;
        return { ok: true, message: `${label}的首牌位置已标记。核对定位框后应用区域。` };
      }
      anchors = next;
      installProfile(adjusted.profile);
      saveLayout();
      return { ok: true, message: `${label}的首牌位置已保存。` };
    }

    function setCustomAnchor(seat, point, slot, rect) {
      if (!active || !dimensions || !rect) return { ok: false, message: '请先连接窗口并框选牌桌。' };
      if (map) return { ok: false, message: '请先进入「框选画面」暂停识牌，再修改桌型。' };
      const key = anchorNames[slot - 1];
      const x = (point?.x - rect.x) / rect.width;
      const y = (point?.y - rect.y) / rect.height;
      if (!Number.isInteger(seat) || seat < 0 || seat > presetSeatCount(preset) || !Number.isInteger(slot) || !key ||
          !(x > 0 && x < 1 && y > 0 && y < 1)) return { ok: false, message: '请点选识别区域内对应牌点的中心。' };
      const item = { ...preset.seats[seat], [key]: { x, y } };
      if (slot > 1 && !item[anchorNames[slot - 2]]) return { ok: false, message: '请先标记这个位置的上一张牌。' };
      if (Number.isFinite(point.width) && Number.isFinite(point.height) && point.width > 0 && point.height > 0) {
        item.patch = { ...item.patch, width: point.width / rect.width, height: point.height / rect.height };
      }
      for (const option of ['flip', 'invert']) {
        if (typeof point[option] === 'boolean') item.patch = { ...item.patch, [option]: point[option] };
      }
      const seats = { ...preset.seats, [seat]: item };
      const result = customProfile(rect, seats);
      if (!result.ok) return { ok: false, message: result.message };
      preset = { ...preset, seats };
      dirty = true;
      return { ok: true, message: `已标记${seat === 0 ? '庄家' : `座位 ${seat}`}的第 ${slot} 张牌点。` };
    }

    function removeSeatAnchor(seat, slot = 1) {
      if (preset.builtin || map || !Number.isInteger(seat) || seat < 0 || seat > presetSeatCount(preset) ||
          !Number.isInteger(slot) || !anchorNames[slot - 1]) {
        return { ok: false, message: '请在自定义桌型的校准阶段移除牌点。' };
      }
      const seats = { ...preset.seats };
      if (slot === 1) delete seats[seat];
      else if (seats[seat]) {
        const item = { ...seats[seat] };
        for (const key of anchorNames.slice(slot - 1)) delete item[key];
        seats[seat] = item;
      }
      preset = { ...preset, seats };
      dirty = true;
      return { ok: true, message: '已移除该牌点及其后的标记。' };
    }

    function clearSeatAnchors() {
      if (!preset.builtin) {
        if (map) return { ok: false, message: '请先进入「框选画面」暂停识牌。' };
        preset = { ...preset, seats: {} };
        dirty = true;
        return { ok: true, message: '已清除当前草稿的全部牌点。' };
      }
      anchors = {};
      draftAnchors = null;
      if (savedLayout) savedLayout = { ...savedLayout, anchors: {} };
      if (!crop && savedLayout) {
        try { root.localStorage.setItem(layoutKey(preset), JSON.stringify(savedLayout)); } catch { /* in-memory calibration */ }
      }
      installProfile(baseProfile);
      saveLayout();
      return { ok: true, message: '已清除座位定位，使用参考识别框。' };
    }

    function beginAlignment() {
      crop = map = null;
      lastSampleAt = null;
      clearAt = null;
      previewAt = -Infinity;
    }

    function lock(seat, slot) {
      recognition.setManual(seat, slot);
      locks.add(`${seat}:${slot}`);
    }

    function reopen(seat, slot) {
      locks.delete(`${seat}:${slot}`);
      if (!suppressed.has(seat)) recognition.reopen(seat, slot);
    }

    function suppressSeat(seat) {
      suppressed.add(seat);
      profile.slots.filter(slot => slot.seat === seat).forEach(slot => recognition.setManual(seat, slot.slot));
    }

    function unsuppressSeat(seat) {
      if (!suppressed.delete(seat)) return;
      for (const slot of profile.slots) {
        if (slot.seat === seat && !locks.has(`${seat}:${slot.slot}`)) recognition.reopen(seat, slot.slot);
      }
    }

    function nextRound() {
      const presence = map && lastSampleAt !== null ? recognition.visibleOpeningSlots(sampled) : null;
      allowOpening = false;
      if (presence?.visible) {
        waitingForClear = true;
        clearAt = null;
        onStatus({ state: 'waiting', message: '等旧牌从画面清走后，再开始识别下一局。' });
      } else clearScan();
    }

    function restoreRound() {
      if (!waitingForClear) {
        clearScan();
        return;
      }
      // Undo can restore the round that is still on screen. Keep its tracked positions.
      waitingForClear = false;
      clearAt = null;
      onStatus({ state: 'capturing', message: '已恢复本局识牌。' });
    }

    function startShoe(mode) {
      if (mode === 'complete') nextRound();
      else {
        clearScan();
        allowOpening = true;
      }
    }

    function learn(seat, slot, rank) {
      if (!active || !map || lastSampleAt === null || (!paused && performance.now() - lastSampleAt > 2500)) {
        return { ok: false, message: '请在牌面清晰可见时再学习字形。' };
      }
      if (waitingForClear || suppressed.has(seat)) return { ok: false, message: '当前牌位布局尚未校准。' };
      if (!/^(A|[2-9]|10|J|Q|K)$/.test(rank)) return { ok: false, message: '请选择有效牌面。' };
      const shape = recognition.sampleGlyph(sampled, seat, slot, rank);
      if (!shape) return { ok: false, message: '这个位置未读到清晰字形，请核对座位、牌位及裁切。' };
      const result = bank.add(learnedGlyphs(), rank, shape, glyphKey());
      if (result.ok) recognition.addTemplate(rank, shape);
      return result;
    }

    function drawPreview(canvas) {
      if (!preview) return false;
      if (canvas.width !== preview.width || canvas.height !== preview.height) {
        canvas.width = preview.width;
        canvas.height = preview.height;
      }
      canvas.getContext('2d').putImageData(new root.ImageData(preview.data, preview.width, preview.height), 0, 0);
      return true;
    }

    function scanSample(now, capturedAt = Date.now()) {
      if (lastSampleAt === null || now - lastSampleAt > clearFrameGap) clearAt = null;
      lastSampleAt = now;
      // A missed dealer hole card must not leave the last round's slots locked.
      if (waitingForClear || locks.size) {
        const empty = waitingForClear ? recognition.visibleOpeningSlots(sampled).visible === 0 : isTableClear(recognition, sampled);
        clearAt = empty ? clearAt ?? now : null;
        const duration = waitingForClear ? clearDuration : autoClearDuration;
        if (clearAt !== null && now - clearAt >= duration) {
          const needsAdvance = !waitingForClear;
          clearScan();
          allowOpening = false;
          if (!needsAdvance) onStatus({ state: 'capturing', message: '已清桌，继续识别。' });
          return { events: [], roundClear: needsAdvance };
        }
        if (waitingForClear) return { events: [], roundClear: false };
      }
      scanStarted ??= now;
      const { events, diagnostics } = recognition.read(sampled, (now - scanStarted) / 1000);
      for (const event of events) {
        locks.add(`${event.seat}:${event.slot}`);
        event.initial = (event.initial && allowOpening) || (recoveryUntil !== null && now <= recoveryUntil);
        event.time = capturedAt / 1000;
      }
      return { events, diagnostics, roundClear: false };
    }

    function message(event) {
      if (usingSystem) return;
      const data = event.data;
      if (data?.type === 'capture:ready') {
        if (!choosing) return;
        closeState();
        active = true;
        dimensions = { width: data.width, height: data.height };
        onReady({ title: data.title, ...dimensions, needsCrop: true });
        schedule(0);
        return;
      }
      if (data?.type !== 'capture:status') return;
      requested = null;
      if (['stopped', 'cancelled', 'error'].includes(data.state)) closeState();
      else if (active) {
        nativePaused = data.state === 'paused';
        if (nativePaused) clearAt = null;
        schedule(nativePaused ? 220 : 0);
      }
      onStatus({ state: data.state, message: data.message });
    }

    function updateSize(width, height) {
      if (width === dimensions.width && height === dimensions.height) return;
      dimensions = { width, height };
      crop = map = null;
      draftAnchors = null;
      lastSampleAt = null;
      onReady({ ...dimensions, needsCrop: true });
    }

    function publishFrame(scanned, possibleGap, metrics, width, height, start) {
      const beforeUpdate = performance.now();
      metrics.confirmationMs = scanned.events.length ? Math.max(...scanned.events.map(card => card.confirmationMs)) : null;
      metrics.totalMs = beforeUpdate - start;
      onFrame({ ...scanned, possibleGap, metrics, width, height });
      const updated = performance.now();
      onTiming({ ...metrics, updateMs: updated - beforeUpdate, totalMs: updated - start });
    }

    function systemFrame() {
      const start = performance.now();
      const { video, track, canvas, context, previewCanvas, previewContext } = system;
      try {
        const frameCount = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
        if (track.muted || video.readyState < 2) {
          clearAt = null;
          return;
        }
        if (frameCount > 0 ? frameCount === system.frames : video.currentTime === system.time) return;
        system.frames = frameCount;
        system.time = video.currentTime;
        const { videoWidth: width, videoHeight: height } = video;
        updateSize(width, height);
        const frameIntervalMs = lastFrameAt !== null ? start - lastFrameAt : null;
        const possibleGap = Boolean(map && frameIntervalMs > 850);
        if (possibleGap) recoveryUntil = start + 400;
        lastFrameAt = start;
        if (start - previewAt >= (map ? 260 : 100)) {
          const size = previewSize(width, height, Boolean(map));
          previewCanvas.width = size.width;
          previewCanvas.height = size.height;
          previewContext.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
          preview = previewContext.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
          previewAt = start;
        }
        const recognitionStarted = performance.now();
        let scanned = { events: [], roundClear: false };
        if (crop) {
          const bounds = recognition.crop;
          context.drawImage(video, (crop.x + bounds.x * crop.width / profile.width) * width,
            (crop.y + bounds.y * crop.height / profile.height) * height, bounds.width * crop.width * width / profile.width,
            bounds.height * crop.height * height / profile.height, 0, 0, canvas.width, canvas.height);
          const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
            sampled.data[p] = (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2]) >> 8;
          }
          scanned = scanSample(start);
        }
        publishFrame(scanned, possibleGap, { captureMs: null, bridgeMs: null, frameIntervalMs,
          recognitionMs: performance.now() - recognitionStarted, source: 'system' }, width, height, start);
      } catch (error) {
        stop();
        onStatus({ state: 'error', message: error.message });
      } finally {
        schedule(Math.max(0, frameInterval - (performance.now() - start)));
      }
    }

    function shared(event) {
      const buffer = event.getBuffer();
      const arrived = performance.now();
      const start = requested ?? arrived;
      requested = null;
      try {
        if (!active || paused || usingSystem) return;
        const data = typeof event.additionalData === 'string' ? JSON.parse(event.additionalData) : event.additionalData;
        const { width, height } = data;
        if (data.type !== 'capture:frame' || data.pixelFormat !== 'BGRA' || buffer.byteLength !== width * height * 4) {
          throw new Error('捕捉帧格式不匹配。');
        }
        updateSize(width, height);
        const bytes = new Uint8Array(buffer);
        const frameIntervalMs = lastFrameAt !== null ? arrived - lastFrameAt : null;
        const possibleGap = Boolean(map && frameIntervalMs > 850);
        if (possibleGap || nativePaused) recoveryUntil = arrived + 400;
        lastFrameAt = arrived;
        if (nativePaused) {
          nativePaused = false;
          onStatus({ state: 'capturing', message: '窗口画面已恢复。' });
        }
        if (arrived - previewAt >= (map ? 260 : 100)) {
          preview = previewFrame(bytes, width, height, previewSize(width, height, Boolean(map)));
          previewAt = arrived;
        }
        const recognitionStarted = performance.now();
        if (map) extract(bytes, map, sampled.data);
        const scanned = map ? scanSample(arrived, Number.isFinite(data.capturedAtMs) ? data.capturedAtMs : Date.now())
          : { events: [], roundClear: false };
        const afterScan = performance.now();
        const captureMs = Number(data.captureMs) || 0;
        publishFrame(scanned, possibleGap, { captureMs, bridgeMs: Math.max(0, arrived - start - captureMs), frameIntervalMs,
          recognitionMs: afterScan - recognitionStarted, source: 'native' }, width, height, start);
      } catch (error) {
        stop();
        onStatus({ state: 'error', message: error.message });
      } finally {
        host.releaseBuffer(buffer);
        schedule(Math.max(0, frameInterval - (performance.now() - start)));
      }
    }

    installProfile(baseProfile);
    host?.addEventListener('message', message);
    host?.addEventListener('sharedbufferreceived', shared);
    root.addEventListener?.('pagehide', stop);
    return { choose, chooseSystem, canChooseSystem, stop, pause, resume, setCrop, beginAlignment, nextRound, restoreRound, startShoe,
      lock, reopen, suppressSeat, unsuppressSeat, learn, drawPreview, getGuide, setSeatAnchor, clearSeatAnchors,
      getCrop, listLayouts, layoutStatus, newLayout, selectLayout, saveLayout: savePreset, removeSeatAnchor, setLayoutSeatCount,
      setLayoutPublicGlyphs };
  }

  const api = { create, makeMap, extract, isTableClear, autoClearDuration, clearFrameGap };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackLiveCapture = api;
}(globalThis));
