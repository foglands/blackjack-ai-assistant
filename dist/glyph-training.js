(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const bankApi = window.BlackjackGlyphBank;
  const recognition = window.BlackjackRecognition;
  const input = $('glyph-file');
  const video = $('glyph-video');
  const freeze = $('glyph-freeze');
  const frame = $('glyph-frame');
  const stage = $('glyph-frame-stage');
  const overlay = $('glyph-selection');
  const regionPreview = $('glyph-region-preview');
  const mask = $('glyph-mask');
  const label = $('glyph-label');
  const correction = $('glyph-correction');
  const rotation = $('glyph-rotate');
  const verified = $('glyph-verified');
  const save = $('glyph-save');
  const zoom = $('glyph-zoom');
  const keys = ['x', 'y', 'width', 'height'];
  const fields = Object.fromEntries(keys.map(key => [key, $(`glyph-${key}`)]));
  const patch = document.createElement('canvas');
  let fileUrl = '';
  let frozen = false;
  let drag = null;
  let selection = null;
  let shape = null;
  let memoryOnly = false;

  function message(id, text, error = false) {
    const element = $(id);
    element.textContent = text;
    element.classList.toggle('error', error);
  }

  if (!bankApi || !recognition || !frame.getContext('2d')) {
    input.disabled = true;
    message('glyph-video-status', '字形组件无法加载，请检查应用文件。', true);
    return;
  }

  const baseProfile = window.BlackjackRecognitionProfile;
  const reference = baseProfile && (window.BlackjackLiveProfile?.fromReplay(baseProfile) ?? baseProfile);
  const openingSlots = new Map((reference?.slots ?? []).filter(slot => slot.slot === 1).map(slot => [slot.seat, slot]));
  let bank = bankApi.load();

  function formatTime(seconds) {
    const milliseconds = Math.round(Math.max(0, seconds) * 1000);
    const minutes = Math.floor(milliseconds / 60000);
    const withinMinute = Math.floor(milliseconds / 1000) % 60;
    return `${String(minutes).padStart(2, '0')}:${String(withinMinute).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
  }

  function paintBank() {
    const counts = bankApi.ranks.map(rank => [rank, bank[rank]?.length ?? 0]);
    $('glyph-bank-total').textContent = `${counts.reduce((sum, [, count]) => sum + count, 0)} 份`;
    $('glyph-bank-counts').innerHTML = counts.map(([rank, count]) => `<span><b>${rank}</b>${count}</span>`).join('');
  }

  function updateControls() {
    zoom.disabled = !frozen;
    for (const key of keys) fields[key].disabled = !frozen;
    correction.disabled = !frozen || !openingSlots.size;
    rotation.disabled = !frozen;
    label.disabled = !selection;
    verified.disabled = !shape || !label.value;
    save.disabled = !shape || !label.value || !verified.checked;
  }

  function resetPreview() {
    shape = null;
    verified.checked = false;
    regionPreview.hidden = true;
    $('glyph-region-empty').hidden = false;
    mask.hidden = true;
    $('glyph-mask-empty').hidden = false;
    updateControls();
  }

  function clearFrame() {
    frozen = false;
    drag = null;
    selection = null;
    stage.hidden = true;
    overlay.hidden = true;
    $('glyph-frame-empty').hidden = false;
    $('glyph-frame-time').textContent = '等待冻结';
    // Release the pixels retained by the previous video's canvas.
    frame.width = frame.height = 1;
    regionPreview.width = regionPreview.height = 1;
    patch.width = patch.height = 1;
    mask.getContext('2d').clearRect(0, 0, mask.width, mask.height);
    for (const key of keys) fields[key].value = '';
    label.value = '';
    resetPreview();
    message('glyph-frame-status', '字形太小时可以放大冻结帧再框选。');
    message('glyph-save-status', '选择清晰的牌点，确认右侧字形与原图一致。');
  }

  function selectFile() {
    const file = input.files[0];
    if (!file) return;
    video.pause();
    freeze.disabled = true;
    video.hidden = true;
    $('glyph-video-empty').hidden = false;
    $('glyph-video-size').textContent = '—';
    clearFrame();
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(file);
    video.src = fileUrl;
    video.muted = true;
    video.load();
    message('glyph-video-status', '正在读取本地录像。');
  }

  function freezeFrame() {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.seeking) {
      message('glyph-video-status', '请等画面显示后再冻结。', true);
      return;
    }
    video.pause();
    clearFrame();
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    frame.getContext('2d').drawImage(video, 0, 0);
    frozen = true;
    stage.hidden = false;
    $('glyph-frame-empty').hidden = true;
    $('glyph-frame-time').textContent = formatTime(video.currentTime);
    updateControls();
    message('glyph-frame-status', '拖动框选单张牌角上的数字或字母，留一点白边。');
    message('glyph-video-status', '已冻结当前画面，可在下方框选。');
  }

  function setBox(rect) {
    overlay.hidden = !rect || rect.width < 1 || rect.height < 1;
    if (overlay.hidden) return;
    overlay.style.left = `${rect.x * 100 / frame.width}%`;
    overlay.style.top = `${rect.y * 100 / frame.height}%`;
    overlay.style.width = `${rect.width * 100 / frame.width}%`;
    overlay.style.height = `${rect.height * 100 / frame.height}%`;
  }

  function framePoint(event) {
    const bounds = frame.getBoundingClientRect();
    const coordinate = (mouse, start, size, pixels) => Math.max(0, Math.min(pixels, Math.round((mouse - start) * pixels / size)));
    return { x: coordinate(event.clientX, bounds.left, bounds.width, frame.width), y: coordinate(event.clientY, bounds.top, bounds.height, frame.height) };
  }

  function dragBox(point) {
    return { x: Math.min(drag.x, point.x), y: Math.min(drag.y, point.y), width: Math.abs(point.x - drag.x), height: Math.abs(point.y - drag.y) };
  }

  function chooseRegion(rect) {
    selection = null;
    if (!Object.values(rect).every(Number.isInteger) || rect.x < 0 || rect.y < 0 || rect.width < 5 || rect.height < 5 ||
      rect.x + rect.width > frame.width || rect.y + rect.height > frame.height) {
      setBox(null);
      resetPreview();
      message('glyph-frame-status', '框选区域太小或超出画面，请重新圈住完整牌点。', true);
      return;
    }
    if (Math.max(rect.width, rect.height) > 220) {
      setBox(rect);
      resetPreview();
      message('glyph-frame-status', '请缩小框选，只保留牌点和少量白边。', true);
      return;
    }
    selection = rect;
    for (const key of keys) fields[key].value = String(rect[key]);
    setBox(rect);
    processSelection();
  }

  function extractShape(rect) {
    const perspective = correction.value === 'none' ? null : openingSlots.get(Number(correction.value));
    const u = perspective?.u ?? 0;
    const v = perspective?.v ?? 0;
    // Keep a white border for deskew sampling and enlarge tiny glyphs without smoothing their edges.
    const scale = Math.min(3, Math.max(1, 25 / Math.min(rect.width, rect.height)), 260 / Math.max(rect.width, rect.height));
    const width = Math.round(rect.width * scale);
    const height = Math.round(rect.height * scale);
    const w = width + 4;
    const h = height + 4;
    const padX = Math.ceil(5 + Math.abs(v) * h / 2);
    const padY = Math.ceil(5 + Math.abs(u) * w / 2);
    patch.width = width + 2 * padX;
    patch.height = height + 2 * padY;
    const ctx = patch.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, patch.width, patch.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height, padX, padY, width, height);
    const slot = recognition.compile({
      x: padX + width / 2 - 0.5, y: padY + height / 2 - 0.5, w, h, u, v, flip: rotation.checked,
    }, patch.width);
    const pixels = ctx.getImageData(0, 0, patch.width, patch.height);
    return label.value === '10' ? recognition.normalizeTen(pixels, slot) : recognition.normalize(pixels, slot);
  }

  function showRegion(rect) {
    const scale = Math.min(8, 120 / Math.max(rect.width, rect.height));
    regionPreview.width = Math.max(1, Math.round(rect.width * scale));
    regionPreview.height = Math.max(1, Math.round(rect.height * scale));
    const ctx = regionPreview.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, regionPreview.width, regionPreview.height);
    regionPreview.hidden = false;
    $('glyph-region-empty').hidden = true;
  }

  function showShape(rows) {
    const ctx = mask.getContext('2d');
    ctx.fillStyle = '#fffaf0';
    ctx.fillRect(0, 0, 16, 20);
    ctx.fillStyle = '#142132';
    rows.forEach((bits, y) => {
      for (let x = 0; x < 16; x++) if (bits & (1 << (15 - x))) ctx.fillRect(x, y, 1, 1);
    });
    mask.hidden = false;
    $('glyph-mask-empty').hidden = true;
  }

  function processSelection() {
    if (!selection) return;
    resetPreview();
    try {
      showRegion(selection);
      shape = extractShape(selection);
      if (!shape) {
        message('glyph-frame-status', label.value === '10' ? '请同时圈住 1 和 0，留少量白边，或换到更清楚的一帧。' :
          '这块画面未提取出清晰字形。试试更紧的框、白色边缘，或换一帧。', true);
        return;
      }
      showShape(shape);
      message('glyph-frame-status', `已框选 ${selection.width} × ${selection.height} 像素。`);
      message('glyph-save-status', '请核对字形，再选择原图中实际的牌点。');
      updateControls();
    } catch (error) {
      shape = null;
      message('glyph-frame-status', `无法读取框选像素。${error.message}`, true);
    }
  }

  function saveShape() {
    if (!shape || !label.value || !verified.checked) return;
    if (!memoryOnly) bank = bankApi.load();
    const result = bankApi.add(bank, label.value, shape);
    if (result.ok) {
      if (!result.duplicate) memoryOnly = result.saved === false;
      paintBank();
      verified.checked = false;
      updateControls();
    }
    message('glyph-save-status', result.message, !result.ok);
  }

  for (const rank of bankApi.ranks) {
    const option = document.createElement('option');
    option.value = option.textContent = rank;
    label.append(option);
  }
  input.addEventListener('change', selectFile);
  video.addEventListener('loadedmetadata', () => {
    if (video.src !== fileUrl) return;
    video.hidden = false;
    $('glyph-video-empty').hidden = true;
    $('glyph-video-size').textContent = `${video.videoWidth} × ${video.videoHeight}`;
    message('glyph-video-status', '找到牌点清晰的一帧，再点「冻结当前帧」。');
  });
  video.addEventListener('loadeddata', () => { if (video.src === fileUrl) freeze.disabled = false; });
  video.addEventListener('seeking', () => { freeze.disabled = true; });
  video.addEventListener('seeked', () => { freeze.disabled = video.readyState < 2; });
  video.addEventListener('canplay', () => { if (video.src === fileUrl && !video.seeking) freeze.disabled = false; });
  video.addEventListener('error', () => {
    freeze.disabled = true;
    message('glyph-video-status', '无法播放此录像，请尝试此浏览器支持的 MP4 或 WebM。', true);
  });
  freeze.addEventListener('click', freezeFrame);
  zoom.addEventListener('change', () => { stage.style.width = `${Number(zoom.value) * 100}%`; });
  frame.addEventListener('pointerdown', event => {
    if (!frozen || event.button !== 0) return;
    drag = framePoint(event);
    frame.setPointerCapture(event.pointerId);
    resetPreview();
    setBox(null);
  });
  frame.addEventListener('pointermove', event => { if (drag) setBox(dragBox(framePoint(event))); });
  frame.addEventListener('pointerup', event => {
    if (!drag) return;
    const rect = dragBox(framePoint(event));
    drag = null;
    chooseRegion(rect);
  });
  frame.addEventListener('pointercancel', () => { drag = null; setBox(selection); processSelection(); });
  for (const field of Object.values(fields)) {
    field.addEventListener('change', () => {
      if (frozen) chooseRegion(Object.fromEntries(keys.map(key => [key, Number(fields[key].value)])));
    });
  }
  correction.addEventListener('change', processSelection);
  rotation.addEventListener('change', processSelection);
  label.addEventListener('change', processSelection);
  verified.addEventListener('change', updateControls);
  save.addEventListener('click', saveShape);
  window.addEventListener('pagehide', event => { if (!event.persisted && fileUrl) URL.revokeObjectURL(fileUrl); });
  paintBank();
  updateControls();
})();
