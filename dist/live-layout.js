(function (root) {
  'use strict';

  const minScale = 0.55;
  const maxScale = 1.65;

  function fitScale(points, axis, extent) {
    const reference = points.map(point => point.reference[axis]);
    // Nearby seats do not provide a stable scale estimate.
    if (Math.max(...reference) - Math.min(...reference) < Math.max(64, extent * 0.1)) return null;
    const referenceMean = reference.reduce((sum, value) => sum + value, 0) / points.length;
    const anchorMean = points.reduce((sum, point) => sum + point.anchor[axis], 0) / points.length;
    let variance = 0;
    let covariance = 0;
    for (const { reference, anchor } of points) {
      const delta = reference[axis] - referenceMean;
      variance += delta * delta;
      covariance += delta * (anchor[axis] - anchorMean);
    }
    return covariance / variance;
  }

  function project(view, sx, sy, offset) {
    return {
      x: view.x * sx + offset.x,
      y: view.y * sy + offset.y,
      w: Math.max(1, Math.round(view.w * sx)),
      h: Math.max(1, Math.round(view.h * sy)),
      // compile() expresses each shear relative to the scaled patch axes.
      u: (view.u ?? 0) * sy / sx,
      v: (view.v ?? 0) * sx / sy,
    };
  }

  function fits(view, width, height) {
    const { x, y, w, h, u, v } = view;
    const halfX = (w - 1 + Math.abs(v) * (h - 1)) / 2;
    const halfY = (h - 1 + Math.abs(u) * (w - 1)) / 2;
    return w >= 9 && h >= 9 && Math.round(x - halfX) >= 0 && Math.round(x + halfX) < width
      && Math.round(y - halfY) >= 0 && Math.round(y + halfY) < height;
  }

  function transform(baseProfile, anchors = {}) {
    const { width, height, slots } = baseProfile ?? {};
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || !Array.isArray(slots)
        || !slots.length || slots.some(slot => !slot || !Number.isInteger(slot.seat) || !Number.isInteger(slot.slot))) {
      return { ok: false, message: '识牌布局无效。' };
    }
    if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)) return { ok: false, message: '锚点无效。' };

    const points = [];
    for (const [key, anchor] of Object.entries(anchors)) {
      const seat = Number(key);
      const reference = /^[0-7]$/.test(key) && slots.find(slot => slot.seat === seat && slot.slot === 1);
      if (!reference || !Number.isFinite(reference.x) || !Number.isFinite(reference.y) || !anchor
          || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)
          || anchor.x < 0 || anchor.x >= width || anchor.y < 0 || anchor.y >= height) {
        return { ok: false, message: '请选择画面内的第一张牌点数字，并核对座位。' };
      }
      points.push({ seat, reference, anchor });
    }
    if (!points.length) return { ok: true, profile: baseProfile };

    const fitX = fitScale(points, 'x', width);
    const fitY = fitScale(points, 'y', height);
    if ((fitX !== null && fitX <= 0) || (fitY !== null && fitY <= 0)) {
      return { ok: false, message: '锚点的相对位置与桌面布局不符，请核对座位编号。' };
    }
    const limit = scale => Math.min(maxScale, Math.max(minScale, scale));
    const sx = limit(fitX ?? fitY ?? 1);
    const sy = limit(fitY ?? fitX ?? 1);
    const offsets = new Map(points.map(({ seat, reference, anchor }) => [seat, {
      x: anchor.x - reference.x * sx,
      y: anchor.y - reference.y * sy,
    }]));
    const global = { x: 0, y: 0 };
    for (const offset of offsets.values()) {
      global.x += offset.x / points.length;
      global.y += offset.y / points.length;
    }

    const remapped = [];
    const previousSlots = new Map();
    for (const slot of [...slots].sort((a, b) => a.seat - b.seat || a.slot - b.slot)) {
      if (slot.slot !== (previousSlots.get(slot.seat) ?? 0) + 1) continue;
      const offset = offsets.get(slot.seat) ?? global;
      const main = { ...slot, ...project(slot, sx, sy, offset) };
      const variants = (slot.variants ?? []).map(variant => ({
        ...variant, ...project({ ...slot, ...variant }, sx, sy, offset),
      })).filter(variant => fits(variant, width, height));

      if (!fits(main, width, height)) {
        if (slot.slot === 1 && offsets.has(slot.seat)) {
          return { ok: false, message: '锚点靠近画面边缘。请选完整牌点数字，或扩大校准范围。' };
        }
        if (!variants.length) continue;
        Object.assign(main, variants.shift());
      }
      if (slot.variants) main.variants = variants;
      previousSlots.set(slot.seat, slot.slot);
      remapped.push(main);
    }
    return { ok: true, profile: { ...baseProfile, slots: remapped } };
  }

  const api = { transform };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackLiveLayout = api;
}(globalThis));
