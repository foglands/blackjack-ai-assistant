(function (root) {
  'use strict';

  const glyphWidth = 16;
  const glyphHeight = 20;
  const maxPlayerSeat = 9;
  const defaultOffsets = [[-8, 0], [8, 0], [0, -8], [0, 8], [-8, -8], [8, -8], [-8, 8], [8, 8]];
  const blankConfirmations = 3;
  const fallbackSampleLimit = 8;
  const fallbackViewLimit = 3;
  const fallbackProbeLimit = 5;
  const relocationWidth = 40;
  const relocationHeight = 34;
  const relocationPadding = 22;
  const relocationMargin = 72;
  const relocationInterval = 0.08;
  const relocationShifts = [[0, 0], [-4, 0], [4, 0], [0, -4], [0, 4]];
  const relocationShears = [[0, 0], [-0.14, 0], [0, 0.24], [0, -0.24]];
  const extraRelocationShifts = [[-4, -4], [-4, 4], [4, -4], [4, 4]];
  const combinedRelocationShear = [-0.14, 0.24];

  function compile(slot, width) {
    const { x, y, w, h, u, v } = slot;
    const direction = slot.flip ? -1 : 1;
    const pixels = new Int32Array(w * h);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const dx = (col + 0.5 - w / 2) * direction;
        const dy = (row + 0.5 - h / 2) * direction;
        pixels[row * w + col] = Math.round(y + u * dx + dy) * width + Math.round(x + dx + v * dy);
      }
    }
    return { ...slot, pixels, imageWidth: width, patch: new Uint8Array(w * h), queue: new Int32Array(w * h) };
  }

  function gray(frame, offset, invert) {
    const i = offset * 4;
    const light = frame.channels === 1 ? frame.data[offset]
      : (77 * frame.data[i] + 150 * frame.data[i + 1] + 29 * frame.data[i + 2]) >> 8;
    return invert ? 255 - light : light;
  }

  function normalize(frame, slot, locate = false, paired = false, fallback = false, shift = 0) {
    const { w, h, pixels, patch, queue } = slot;
    const inkCutoff = slot.inkCeiling ?? (fallback ? 152 : 130);
    const whiteFloor = slot.whiteFloor ?? 188;
    const minimumWidth = paired ? 2 : fallback ? 4 : 7;
    let bright = 0;
    for (let i = 0; i < pixels.length; i++) {
      const light = gray(frame, pixels[i] + shift, slot.invert);
      patch[i] = Number(light <= inkCutoff);
      bright += Number(light >= whiteFloor);
    }
    if (bright < pixels.length * (slot.minBright ?? 0.46)) return null;

    let largest = null;
    const components = paired ? [] : null;
    for (let seed = 0; seed < patch.length; seed++) {
      if (patch[seed] !== 1) continue;
      let end = 1;
      let left = w, right = -1, top = h, bottom = -1;
      patch[seed] = 2;
      queue[0] = seed;
      for (let i = 0; i < end; i++) {
        const index = queue[i];
        const col = index % w;
        const row = (index - col) / w;
        left = Math.min(left, col);
        right = Math.max(right, col);
        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
        for (let dy = -1; dy <= 1; dy++) {
          const nextRow = row + dy;
          if (nextRow < 0 || nextRow >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nextCol = col + dx;
            if (nextCol < 0 || nextCol >= w) continue;
            const next = nextRow * w + nextCol;
            if (patch[next] !== 1) continue;
            patch[next] = 2;
            queue[end++] = next;
          }
        }
      }

      const width = right - left + 1;
      const height = bottom - top + 1;
      if (width < minimumWidth || height < 7 || end < (paired ? 12 : 24) || end > patch.length * 0.56) continue;
      if (left === 0 || right === w - 1 || top === 0 || bottom === h - 1) continue;
      const centerDistance = Math.hypot((left + right + 1) / 2 - w / 2, (top + bottom + 1) / 2 - h / 2);
      const score = end / (1 + centerDistance / 6);
      if (!paired && largest && score <= largest.score) continue;

      const mask = new Uint8Array(width * height);
      for (let i = 0; i < end; i++) {
        const index = queue[i];
        const col = index % w;
        const row = (index - col) / w;
        mask[(row - top) * width + col - left] = 1;
      }
      const component = { mask, width, height, score, left, top };
      if (paired) components.push({ ...component, right, bottom, ink: end });
      else largest = component;
    }
    if (paired) largest = combineTen(components, w, h, fallback ? 4 : 5);
    if (!largest) return null;

    const rows = [];
    for (let y = 0; y < glyphHeight; y++) {
      const sourceY = Math.floor((y + 0.5) * largest.height / glyphHeight);
      let bits = 0;
      for (let x = 0; x < glyphWidth; x++) {
        const sourceX = Math.floor((x + 0.5) * largest.width / glyphWidth);
        bits = (bits << 1) | largest.mask[sourceY * largest.width + sourceX];
      }
      rows.push(bits);
    }
    if (!locate) return rows;
    const column = largest.left + Math.floor(largest.width / 2);
    const row = largest.top + Math.floor(largest.height / 2);
    const index = pixels[row * w + column] + shift;
    const x = index % slot.imageWidth;
    return { rows, x: x + (slot.cropX ?? 0), y: (index - x) / slot.imageWidth + (slot.cropY ?? 0) };
  }

  function enclosesHole({ mask, width, height }) {
    const filled = mask.slice();
    const queue = new Int32Array(mask.length);
    let end = 0;
    function enqueue(index) {
      if (filled[index]) return;
      filled[index] = 2;
      queue[end++] = index;
    }
    for (let x = 0; x < width; x++) {
      enqueue(x);
      enqueue((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      enqueue(y * width);
      enqueue(y * width + width - 1);
    }
    for (let cursor = 0; cursor < end; cursor++) {
      const index = queue[cursor];
      const x = index % width;
      if (x > 0) enqueue(index - 1);
      if (x + 1 < width) enqueue(index + 1);
      if (index >= width) enqueue(index - width);
      if (index + width < mask.length) enqueue(index + width);
    }
    return filled.reduce((total, value) => total + Number(value === 0), 0) >= 3;
  }

  function combineTen(components, patchWidth, patchHeight, minZeroWidth) {
    if (components.length < 2) return null;
    let best = null;
    const rings = components.filter(component => component.width >= minZeroWidth && enclosesHole(component));
    for (const zero of rings) {
      for (const one of components) {
        const gap = zero.left - one.right - 1;
        const shortest = Math.min(one.height, zero.height);
        const tallest = Math.max(one.height, zero.height);
        const overlap = Math.min(one.bottom, zero.bottom) - Math.max(one.top, zero.top) + 1;
        if (gap < 1 || gap > zero.height * 0.50 || one.width > zero.width * 0.85 ||
            one.height < one.width * 1.25 || shortest < tallest * 0.68 || overlap < shortest * 0.75) continue;
        const left = one.left;
        const top = Math.min(one.top, zero.top);
        const width = zero.right - left + 1;
        const height = Math.max(one.bottom, zero.bottom) - top + 1;
        const distance = Math.hypot(left + width / 2 - patchWidth / 2, top + height / 2 - patchHeight / 2);
        const score = (one.ink + zero.ink) / (1 + distance / 6);
        if (!best || score > best.score) best = { one, zero, left, top, width, height, score };
      }
    }
    if (!best) return null;
    const { one, zero, left, top, width, height } = best;
    const mask = new Uint8Array(width * height);
    for (const component of [one, zero]) {
      for (let row = 0; row < component.height; row++) {
        const source = row * component.width;
        const target = (row + component.top - top) * width + component.left - left;
        mask.set(component.mask.subarray(source, source + component.width), target);
      }
    }
    return { mask, left, top, width, height };
  }

  function pairedRows(rows) {
    const columns = rows.reduce((used, row) => used | row, 0);
    for (let index = 2; index <= 12; index++) {
      const separator = 1 << (15 - index);
      if (columns & separator) continue;
      const left = 65535 ^ (separator * 2 - 1);
      const right = separator - 1;
      if (rows.reduce((ink, row) => ink + bitCount(row & left), 0) >= 12 &&
          rows.reduce((ink, row) => ink + bitCount(row & right), 0) >= 12) return true;
    }
    return false;
  }

  function normalizeTen(frame, slot, locate = false) {
    const pair = normalize(frame, slot, locate, true);
    return pair && pairedRows(locate ? pair.rows : pair) ? pair : null;
  }

  function normalizeFallback(frame, slot, paired = false, locate = false) {
    const glyph = normalize(frame, slot, locate, paired, true);
    return glyph && (!paired || pairedRows(locate ? glyph.rows : glyph)) ? glyph : null;
  }

  function bitCount(value) {
    value -= (value >>> 1) & 0x5555;
    value = (value & 0x3333) + ((value >>> 2) & 0x3333);
    value = (value + (value >>> 4)) & 0x0f0f;
    return (value + (value >>> 8)) & 0x1f;
  }

  function glyphArea(rows) {
    return rows.reduce((total, row) => total + bitCount(row), 0);
  }

  function similarity(rows, area, template) {
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        let overlap = 0;
        for (let y = 0; y < glyphHeight; y++) {
          const bits = rows[y + dy] ?? 0;
          const shifted = dx === -1 ? bits >>> 1 : dx === 1 ? (bits << 1) & 0xffff : bits;
          overlap += bitCount(shifted & template.rows[y]);
        }
        best = Math.max(best, 2 * overlap / (area + template.area));
      }
    }
    return best;
  }

  function classify(rows, templates, area = glyphArea(rows)) {
    const ranked = templates.map(([rank, samples]) => ({
      rank, score: Math.max(...samples.map(template => similarity(rows, area, template))),
    })).sort((a, b) => b.score - a.score);
    const [best, next] = ranked;
    return { rank: best.rank, score: best.score, margin: best.score - (next?.score ?? 0) };
  }

  function getCrop(slots, width, height, padding = 0) {
    let left = width, right = 0, top = Infinity, bottom = 0;
    for (const slot of slots) {
      for (const view of slot.views) {
        for (const index of view.pixels) {
          const x = index % width;
          const y = (index - x) / width;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    const x = Math.max(0, left - padding);
    const y = Math.max(0, top - padding);
    return { x, y, width: Math.min(width, right + padding + 1) - x, height: Math.min(height, bottom + padding + 1) - y };
  }

  function liveOptions(config) {
    if (!config) return null;
    const offsets = (config.offsets ?? defaultOffsets).filter(offset => Array.isArray(offset) &&
      offset.length === 2 && offset.every(value => Number.isInteger(value) && Math.abs(value) <= 16) &&
      (offset[0] || offset[1])).slice(0, 8);
    const explicitFallbackScore = Number.isFinite(config.fallbackMinScore);
    return {
      offsets, relocate: config.relocate === true, minScore: config.minScore ?? 0.83, minMargin: config.minMargin ?? 0.10,
      fallbackMinScore: explicitFallbackScore ? Math.max(0.76, Math.min(1, config.fallbackMinScore)) : 0.91,
      fallbackPairedMinScore: explicitFallbackScore ? 0.81 : 0.93,
      fallbackMinMargin: Number.isFinite(config.fallbackMinMargin) ? Math.max(0.07, Math.min(1, config.fallbackMinMargin)) : 0.15,
    };
  }

  function templateSample(rows) {
    return Array.isArray(rows) && rows.length === glyphHeight &&
      rows.every(row => Number.isInteger(row) && row >= 0 && row <= 65535) && glyphArea(rows) > 0;
  }

  function fallbackGroups(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const groups = Object.entries(input).filter(([rank, samples]) =>
      /^(?:A|[2-9]|10|J|Q|K)$/.test(rank) && Array.isArray(samples))
      .map(([rank, samples]) => {
        const unique = new Map();
        for (const rows of samples.slice(0, fallbackSampleLimit)) {
          if (!templateSample(rows) || (rank === '10' && !pairedRows(rows))) continue;
          unique.set(rows.join(','), { rows: rows.slice(), area: glyphArea(rows) });
        }
        return [rank, [...unique.values()]];
      })
      .filter(([, samples]) => samples.length);
    if (!groups.length) return null;
    return { singles: groups.filter(([rank]) => rank !== '10'), tens: groups.filter(([rank]) => rank === '10') };
  }

  function fits(view, profile) {
    const halfW = (view.w - 1) / 2;
    const halfH = (view.h - 1) / 2;
    const x = halfW + Math.abs(view.v) * halfH;
    const y = halfH + Math.abs(view.u) * halfW;
    return Math.round(view.x - x) >= 0 && Math.round(view.x + x) < profile.width &&
      Math.round(view.y - y) >= 0 && Math.round(view.y + y) < profile.height;
  }

  function plan(profile, crop, live) {
    return profile.slots.map(slot => {
      const bases = [slot, ...(slot.variants ?? []).map(variant => ({ ...slot, ...variant }))];
      const displaced = live ? bases.filter(view => !view.holeReveal && !view.fixedView).flatMap(view => live.offsets.map(([dx, dy]) => ({
        ...view, x: view.x + dx, y: view.y + dy, shifted: true,
      })).filter(view => fits(view, profile))) : [];
      const samplePhase = live && Number.isFinite(slot.rankPhaseY) && Math.abs(slot.rankPhaseY) <= 0.5 && slot.rankPhaseY !== 0
        ? { ...slot, y: slot.y + slot.rankPhaseY, phaseFallback: true,
          minScore: Math.max(0.86, slot.minScore ?? 0), minMargin: Math.max(0.12, slot.minMargin ?? 0) }
        : null;
      const phaseViews = samplePhase && fits(samplePhase, profile) ? [samplePhase] : [];
      const views = [...bases, ...displaced, ...phaseViews].map(view => compile({
        ...view, x: view.x - crop.x, y: view.y - crop.y, cropX: crop.x, cropY: crop.y,
      }, crop.width));
      return { ...slot, views, bases, crop, key: `${slot.seat}:${slot.slot}` };
    });
  }

  function match(frame, slot, templates) {
    let best = null;
    for (const view of slot.views) {
      const rows = normalize(frame, view);
      if (!rows) continue;
      const guess = classify(rows, templates);
      if (guess.score < (view.minScore ?? 0.72) || guess.margin < (view.minMargin ?? 0.075)) continue;
      if (!best || guess.score > best.score) best = guess;
    }
    return best;
  }

  function distanceSquared(a, b) {
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  }

  function anchorDistance(glyph, slot) {
    let closest = Infinity;
    for (const base of slot.bases) closest = Math.min(closest, distanceSquared(glyph, base));
    return closest;
  }

  function whiteShare(frame, view, stride) {
    let bright = 0, samples = 0;
    for (let index = 0; index < view.pixels.length; index += stride) {
      bright += Number(gray(frame, view.pixels[index], view.invert) >= (view.whiteFloor ?? 188));
      samples++;
    }
    return bright / samples;
  }

  function hasLight(frame, view) {
    return whiteShare(frame, view, 17) >= (view.minBright ?? 0.46) - 0.17;
  }

  function ownsGlyph(glyph, distance, slot, slots, centers) {
    for (const [key, center] of centers) {
      if (key !== slot.key && distanceSquared(glyph, center) <= 49) return false;
    }
    // A moved search window must not claim a neighboring slot's rank.
    if (distance <= 4) return true;
    const threshold = (Math.sqrt(distance) - 2) ** 2;
    return !slots.some(other => other.key !== slot.key &&
      anchorDistance(glyph, other) < threshold);
  }

  function paperAround(frame, x, y, crop) {
    let white = 0, total = 0;
    for (let row = Math.max(0, y - 12); row <= Math.min(crop.height - 1, y + 12); row += 3) {
      for (let col = Math.max(0, x - 13); col <= Math.min(crop.width - 1, x + 13); col += 3) {
        white += Number(gray(frame, row * crop.width + col) >= 188);
        total++;
      }
    }
    return total ? white / total : 0;
  }

  function rankPoints(frame, x, y, crop, scratch) {
    const left = Math.max(0, x - relocationWidth - relocationPadding);
    const right = Math.min(crop.width - 1, x + relocationWidth + relocationPadding);
    const top = Math.max(0, y - relocationHeight - relocationPadding);
    const bottom = Math.min(crop.height - 1, y + relocationHeight + relocationPadding);
    // A zero-valued border lets the flood fill use direct neighbor indices.
    const width = right - left + 3;
    const height = bottom - top + 3;
    if (width < 7 || height < 7) return [];
    const { lights, ink, queue } = scratch;
    let hasPaper = false;
    for (let row = Math.max(top + 12, y - relocationHeight); row <= Math.min(bottom - 12, y + relocationHeight) && !hasPaper; row += 16) {
      for (let col = Math.max(left + 13, x - relocationWidth); col <= Math.min(right - 13, x + relocationWidth); col += 16) {
        if (paperAround(frame, col, row, crop) >= 0.30) {
          hasPaper = true;
          break;
        }
      }
    }
    if (!hasPaper) return [];
    let bright = 0;
    for (let row = 1; row < height - 1; row++) {
      const offset = (top + row - 1) * crop.width + left - 1;
      for (let col = 1; col < width - 1; col++) {
        const light = gray(frame, offset + col);
        lights[row * width + col] = light;
        bright += Number(light >= 188);
      }
    }
    if (bright < 130) return [];
    const points = [];
    const neighbors = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
    for (const threshold of [130, 152]) {
      ink.fill(0, 0, width * height);
      for (let row = 1; row < height - 1; row++) {
        for (let col = 1; col < width - 1; col++) {
          const index = row * width + col;
          ink[index] = Number(lights[index] <= threshold);
        }
      }
      for (let seed = 0; seed < width * height; seed++) {
        if (!ink[seed]) continue;
        ink[seed] = 0;
        queue[0] = seed;
        let size = 1;
        let minX = width, maxX = -1, minY = height, maxY = -1;
        for (let head = 0; head < size; head++) {
          const index = queue[head];
          const col = index % width;
          const row = (index - col) / width;
          minX = Math.min(minX, col);
          maxX = Math.max(maxX, col);
          minY = Math.min(minY, row);
          maxY = Math.max(maxY, row);
          for (const delta of neighbors) {
            const neighbor = index + delta;
            if (!ink[neighbor]) continue;
            ink[neighbor] = 0;
            queue[size++] = neighbor;
          }
        }
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        if (size < 28 || size > 525 || w < 7 || w > 40 || h < 7 || h > 37 ||
            minX === 1 || minY === 1 || maxX === width - 2 || maxY === height - 2) continue;
        const px = Math.round(left - 1 + (minX + maxX) / 2);
        const py = Math.round(top - 1 + (minY + maxY) / 2);
        if (Math.abs(px - x) > relocationWidth || Math.abs(py - y) > relocationHeight ||
            points.some(point => distanceSquared(point, { x: px, y: py }) < 9)) continue;
        if (paperAround(frame, px, py, crop) >= 0.41) points.push({ x: px, y: py, threshold });
      }
    }
    return points;
  }

  function onFan(point, fan) {
    return !fan || (point && point.y <= fan.previous.y - 12 && distanceSquared(point, fan.expected) <= 32 ** 2);
  }

  function verificationPatch(view, paired, x = view.x + view.cropX, y = view.y + view.cropY) {
    const { w, h, u, v, flip, invert, inkCeiling, minBright, whiteFloor } = view;
    return { x, y, w, h, u, v, flip, invert, inkCeiling, minBright, whiteFloor, paired };
  }

  function recoverGlyph(frame, slot, slots, centers, offset, singles, scratch, fan) {
    if (!singles.length || slot.invert) return { evidence: null, guess: null };
    const crop = slot.crop;
    const baseKeys = new Set();
    const scores = new Map();
    const othersWithCenters = [...centers].filter(([other]) => other !== slot.key).map(([, center]) => center);
    const others = fan ? [] : slots.filter(other => other.seat === slot.seat && other.key !== slot.key);
    const shifts = slot.slot > 1 ? [...relocationShifts, ...extraRelocationShifts] : relocationShifts;
    let best = null, evidence = null, rival = null;
    for (const base of slot.bases) {
      if (base.pairedOnly || base.invert || base.fixedView) continue;
      const key = `${base.x}:${base.y}`;
      if (baseKeys.has(key)) continue;
      baseKeys.add(key);
      const x = Math.round(base.x + offset.x - crop.x);
      const y = Math.round(base.y + offset.y - crop.y);
      const points = rankPoints(frame, x, y, crop, scratch);
      if (!points.length) continue;
      points.sort((a, b) => distanceSquared(a, { x, y }) - distanceSquared(b, { x, y }));
      const expected = { x: x + crop.x, y: y + crop.y };
      const views = relocationViews(base, crop, scratch);
      for (const point of points.slice(0, 5)) {
        const pointInProfile = { x: point.x + crop.x, y: point.y + crop.y };
        if (!onFan(pointInProfile, fan) || othersWithCenters.some(center => distanceSquared(pointInProfile, center) < 100)) continue;
        for (const [dx, dy] of shifts) {
          for (const { view, halfWidth, halfHeight, combined } of views) {
              if (combined && slot.slot === 1) continue;
              const px = point.x + dx;
              const py = point.y + dy;
              if (Math.round(px - halfWidth) < 0 || Math.round(px + halfWidth) >= crop.width ||
                  Math.round(py - halfHeight) < 0 || Math.round(py + halfHeight) >= crop.height) continue;
              view.inkCeiling = point.threshold;
              const glyph = normalize(frame, view, true, false, false, py * crop.width + px);
              if (!glyph || !onFan(glyph, fan) || distanceSquared(point, { x: glyph.x - crop.x, y: glyph.y - crop.y }) > 64) continue;
              const distance = distanceSquared(glyph, expected);
              if (othersWithCenters.some(center => distanceSquared(glyph, center) < 144) ||
                  others.some(other => !centers.has(other.key) && anchorDistance({ x: glyph.x - offset.x, y: glyph.y - offset.y }, other) <
                    (Math.max(0, Math.sqrt(distance) - 4)) ** 2)) continue;
              const area = glyphArea(glyph.rows);
              if (area < 32 || area > 288) continue;
              const signature = glyph.rows.join(',');
              const known = scores.get(signature) ?? classify(glyph.rows, singles, area);
              scores.set(signature, known);
              const strength = known.score + known.margin * 0.25 - Math.sqrt(distance) * 0.0015;
              const found = { ...glyph, ...known, area, distance, strength, shifted: true, relocated: true,
                verification: verificationPatch(view, false, px + crop.x, py + crop.y) };
              if (!evidence || found.strength > evidence.strength) evidence = found;
              if (found.score < 0.78 || found.margin < 0.072) continue;
              if (!best || found.strength > best.strength) {
                if (best && best.rank !== found.rank) rival = best;
                best = found;
              } else if (found.rank !== best.rank && (!rival || found.strength > rival.strength)) {
                rival = found;
              }
          }
        }
      }
    }
    if (best && rival && rival.rank !== best.rank && best.strength - rival.strength < 0.022) best = null;
    return { evidence: best ?? evidence, guess: best };
  }

  function relocationViews(base, crop, scratch) {
    let views = scratch.views.get(base);
    if (views) return views;
    views = [];
    const shears = [...relocationShears, combinedRelocationShear];
    for (const scale of [1, 1.16]) {
      for (const [du, dv] of shears) {
        const view = compile({
          ...base, x: 0, y: 0, cropX: crop.x, cropY: crop.y,
          w: Math.round(base.w * scale), h: Math.round(base.h * scale),
          u: base.u + du, v: base.v + dv, minBright: 0.41,
        }, crop.width);
        const w = (view.w - 1) / 2;
        const h = (view.h - 1) / 2;
        views.push({ view, halfWidth: w + Math.abs(view.v) * h, halfHeight: h + Math.abs(view.u) * w,
          combined: du === combinedRelocationShear[0] && dv === combinedRelocationShear[1] });
      }
    }
    scratch.views.set(base, views);
    return views;
  }

  function inspectLive(frame, slot, slots, centers, singles, tens, options, bypass, keepScores) {
    let evidence = null;
    let best = null;
    let rival = null;
    let tenEvidence = null;
    let bestTen = null;
    const priorScores = keepScores ? new Map() : null;
    for (const view of slot.views) {
      if (view.holeReveal && bypass) continue;
      // The alternate pixel grid only rescues unread single ranks. Keep a
      // normal match or evidence of a two-digit rank ahead of this retry.
      if (view.phaseFallback && (best || bestTen || tenEvidence || !hasLight(frame, view))) continue;
      // Direct calibrated variants take priority. A cheap light check
      // prevents the displacement search from scanning blank felt fully.
      const pairOnly = view.shifted && best && !best.shifted;
      if (view.shifted && ((bestTen && !bestTen.shifted) || (pairOnly && !tens.length))) break;
      if (view.shifted && !hasLight(frame, view)) continue;
      const pair = tens.length && !view.phaseFallback ? normalizeTen(frame, view, true) : null;
      const glyph = pair ?? (pairOnly || view.pairedOnly ? null : normalize(frame, view, true));
      if (!glyph) continue;
      // On an upright reveal, the card face extends below and to the right of
      // its leading rank. The paired rank's center is farther into the card.
      if (view.holeReveal) {
        const [dx, dy] = view.pairedOnly ? [10, 22] : [18, 17];
        if (paperAround(frame, glyph.x - slot.crop.x + dx, glyph.y - slot.crop.y + dy, slot.crop) < 0.55) continue;
      }
      const area = glyphArea(glyph.rows);
      if (area < 32 || area > 288) continue;
      const distance = anchorDistance(glyph, slot);
      if (!ownsGlyph(glyph, distance, slot, slots, centers)) continue;
      if (options.relocate) glyph.verification = verificationPatch(view, Boolean(pair));
      if (pair) {
        const shape = { ...glyph, area, distance };
        if (!tenEvidence || distance < tenEvidence.distance) tenEvidence = shape;
        const score = Math.max(...tens.map(template => similarity(glyph.rows, area, template)));
        const floor = view.pairedOnly ? Math.max(0.81, view.minPairedScore ?? 0.86) : Math.max(0.86, view.minScore ?? 0, options.minScore);
        if (score < floor) continue;
        const candidate = { ...shape, rank: '10', score, shifted: Boolean(view.shifted) };
        if (!bestTen || score > bestTen.score || (score === bestTen.score && distance < bestTen.distance)) bestTen = candidate;
        continue;
      }
      if (!evidence || distance < evidence.distance) evidence = { ...glyph, area, distance };
      if (!singles.length) continue;
      const signature = priorScores ? glyph.rows.join(',') : null;
      const guess = priorScores?.get(signature) ?? classify(glyph.rows, singles, area);
      priorScores?.set(signature, guess);
      const strict = view.shifted || view.phaseFallback || bypass;
      const scoreFloor = Math.max(view.minScore ?? 0.72, strict ? options.minScore : 0);
      const marginFloor = Math.max(view.minMargin ?? 0.075, strict ? options.minMargin : 0);
      if (guess.score < scoreFloor || guess.margin < marginFloor) continue;
      const candidate = { ...glyph, ...guess, shifted: Boolean(view.shifted), area, distance };
      if (!best || candidate.score > best.score || (candidate.score === best.score && distance < best.distance)) {
        if (best && candidate.rank !== best.rank) rival = best;
        best = candidate;
      } else if (candidate.rank !== best.rank && (!rival || candidate.score > rival.score)) {
        rival = candidate;
      }
    }
    if (bestTen) return { evidence: bestTen, guess: bestTen };
    if (tenEvidence && (!best || distanceSquared(tenEvidence, best) <= 144)) {
      return { evidence: tenEvidence, guess: null, priorScores, pairedEvidence: true };
    }
    if (best?.shifted && rival && best.rank !== rival.rank && best.score - rival.score < 0.04) best = null;
    return { evidence: best ?? evidence, guess: best, priorScores };
  }

  function inspectFallback(frame, slot, slots, centers, singles, tens, fallback, options, priorScores) {
    let best = null;
    let rival = null;
    const checked = new Set();
    for (const view of slot.views.slice(0, fallbackProbeLimit)) {
      if (view.holeReveal || view.phaseFallback) continue;
      if (!hasLight(frame, view)) continue;
      const pair = tens.length || fallback.tens.length ? normalizeFallback(frame, view, true, true) : null;
      const group = pair ? fallback.tens : fallback.singles;
      if (!group.length) continue;
      const glyph = pair ?? (view.pairedOnly ? null : normalizeFallback(frame, view, false, true));
      if (!glyph) continue;
      const area = glyphArea(glyph.rows);
      if (area < 32 || area > 288) continue;
      const distance = anchorDistance(glyph, slot);
      if (!ownsGlyph(glyph, distance, slot, slots, centers)) continue;
      const signature = glyph.rows.join(',');
      if (checked.has(signature)) continue;
      checked.add(signature);

      const guess = classify(glyph.rows, group, area);
      const inferred = view.inferred === true || (view.inferred !== false && (view.minScore ?? 0) >= 0.90);
      const cautious = view.shifted || inferred;
      const floor = Math.max(options.fallbackMinScore, cautious ? 0.86 : 0, pair ? options.fallbackPairedMinScore : 0);
      let primaryLead = Infinity;
      let requiredPrimaryLead = 0;
      if (!pair && singles.length) {
        const prior = priorScores?.get(signature) ?? classify(glyph.rows, singles, area);
        const otherRank = prior.rank === guess.rank ? prior.score - prior.margin : prior.score;
        primaryLead = guess.score - otherRank;
        requiredPrimaryLead = Math.max(options.fallbackMinMargin, prior.score >= 0.80 ? 0.12 : 0.07);
      }
      const publicMargin = Math.max(options.fallbackMinMargin, cautious ? 0.10 : 0.07);
      if (guess.score >= floor && guess.margin >= publicMargin && primaryLead >= requiredPrimaryLead) {
        const candidate = { ...glyph, ...guess, area, distance, shifted: Boolean(view.shifted), fallback: true };
        if (!best || candidate.score > best.score || (candidate.score === best.score && distance < best.distance)) {
          if (best && candidate.rank !== best.rank) rival = best;
          best = candidate;
        } else if (candidate.rank !== best.rank && (!rival || candidate.score > rival.score)) {
          rival = candidate;
        }
      }
      if (checked.size >= fallbackViewLimit) break;
    }
    return best && (!rival || best.rank === rival.rank || best.score - rival.score >= options.fallbackMinMargin / 2)
      ? best : null;
  }

  function create(profile) {
    const live = liveOptions(profile.liveSearch);
    const seatCount = profile.seatCount ?? 7;
    if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > maxPlayerSeat) {
      throw new Error('识牌配置可包含 1 至 ' + maxPlayerSeat + ' 个玩家座位。');
    }
    const full = plan(profile, { x: 0, y: 0, width: profile.width, height: profile.height }, live);
    const crop = getCrop(full, profile.width, profile.height, live?.relocate ? relocationMargin : 0);
    const cropped = plan(profile, crop, live);
    const relocationSize = (2 * (relocationWidth + relocationPadding) + 3) *
      (2 * (relocationHeight + relocationPadding) + 3);
    const relocationScratch = live?.relocate ? {
      lights: new Uint8Array(relocationSize), ink: new Uint8Array(relocationSize), queue: new Uint16Array(relocationSize),
      views: new WeakMap(),
    } : null;
    const templates = Object.entries(profile.templates).map(([rank, samples]) => [rank,
      samples.map(rows => ({ rows, area: glyphArea(rows) }))]);
    const singles = templates.filter(([rank]) => rank !== '10');
    const tens = (templates.find(([rank]) => rank === '10')?.[1] ?? []).filter(sample => pairedRows(sample.rows));
    const fallback = live ? fallbackGroups(profile.fallbackTemplates) : null;
    const frameGap = profile.maxFrameGapSeconds ?? Infinity;
    const opening = profile.openingSeconds ?? 0.2;
    let accepted, pending, lastTime, occupied, locations, emptySeats, blankHistory, recoveryTimes, frameNumber;

    function reset() {
      accepted = new Set();
      pending = new Map();
      occupied = new Map();
      locations = new Map();
      emptySeats = new Set();
      blankHistory = new Map();
      recoveryTimes = new Map();
      frameNumber = 0;
      lastTime = -1;
    }

    function manualKey(seat, slot) {
      if (!Number.isInteger(seat) || seat < 0 || seat > maxPlayerSeat || !Number.isInteger(slot) || slot < 1 || slot > 21) {
        throw new Error('请选择有效的座位和牌位。');
      }
      return `${seat}:${slot}`;
    }

    function setManual(seat, slot) {
      const key = manualKey(seat, slot);
      const shape = occupied.get(key);
      if (shape?.stable) locations.set(key, shape);
      accepted.add(key);
      pending.delete(key);
    }

    function reopen(seat, slot) {
      const key = manualKey(seat, slot);
      accepted.delete(key);
      pending.delete(key);
      occupied.delete(key);
      locations.delete(key);
      recoveryTimes.delete(key);
    }

    function setSeatEmpty(seat, empty = true) {
      if (!Number.isInteger(seat) || seat < 1 || seat > seatCount) throw new Error('请选择 1 到 ' + seatCount + ' 号座位。');
      if (!live) return;
      if (!empty) {
        emptySeats.delete(seat);
        return;
      }
      emptySeats.add(seat);
      blankHistory.delete(seat);
      for (const slot of full) {
        if (slot.seat !== seat) continue;
        pending.delete(slot.key);
        occupied.delete(slot.key);
        recoveryTimes.delete(slot.key);
      }
    }

    function framePlan(frame) {
      if (frame.width === profile.width && frame.height === profile.height) return full;
      if (frame.width === crop.width && frame.height === crop.height) return cropped;
      throw new Error('画面分辨率与校准配置不一致。');
    }

    function addTemplate(rank, rows) {
      if (!/^(A|[2-9]|10|J|Q|K)$/.test(rank) || !templateSample(rows)) return false;
      if (live && rank === '10' && !pairedRows(rows)) return false;
      let group = templates.find(([name]) => name === rank);
      if (!group) {
        group = [rank, []];
        templates.push(group);
        if (rank !== '10') singles.push(group);
      }
      if (group[1].some(shape => shape.rows.every((row, index) => row === rows[index]))) return true;
      const sample = { rows: rows.slice(), area: glyphArea(rows) };
      group[1].push(sample);
      if (live && rank === '10') tens.push(sample);
      return true;
    }

    function sampleGlyph(frame, seat, number, rank) {
      const slot = framePlan(frame).find(candidate => candidate.seat === seat && candidate.slot === number);
      if (!slot) return null;
      const pixels = { data: frame.data, channels: frame.channels ?? 4 };
      const extract = live && rank === '10' ? normalizeTen : normalize;
      const samples = slot.views.filter(view => rank === '10' || !view.pairedOnly)
        .map(view => extract(pixels, view)).filter(Boolean);
      if (!samples.length) return null;
      const known = templates.find(([name]) => name === rank);
      if (!known) return samples[0];
      const score = rows => Math.max(...known[1].map(template => similarity(rows, glyphArea(rows), template)));
      return samples.reduce((best, rows) => score(rows) > score(best) ? rows : best);
    }

    function invertedOpeningVisible(pixels, view) {
      // A solid dark felt patch becomes uniformly bright after inversion.
      // Require glyph ink as well so it cannot hold the clear-table gate.
      return Boolean(normalize(pixels, view) || (tens.length && normalizeTen(pixels, view)) ||
        (fallback && (normalizeFallback(pixels, view) || (fallback.tens.length && normalizeFallback(pixels, view, true)))));
    }

    function trackedVisible(pixels, slot) {
      const position = locations.get(slot.key) ?? occupied.get(slot.key);
      if (!relocationScratch || !position || slot.invert) return false;
      const paper = paperAround(pixels, position.x - slot.crop.x, position.y - slot.crop.y, slot.crop);
      if (paper >= 0.58) return true;
      const sample = position.verification;
      if (paper < 0.33 || !sample) return false;
      if (sample.crop !== slot.crop) {
        const projected = { ...sample, x: sample.x - slot.crop.x, y: sample.y - slot.crop.y };
        if (!fits(projected, slot.crop)) return false;
        sample.view = compile(projected, slot.crop.width);
        sample.crop = slot.crop;
      }
      const rows = sample.paired ? normalizeTen(pixels, sample.view) : normalize(pixels, sample.view);
      return Boolean(rows && similarity(rows, glyphArea(rows), position) >= 0.76);
    }

    function visibleOpeningSlots(frame) {
      const pixels = { data: frame.data, channels: frame.channels ?? 4 };
      let checked = 0, visible = 0;
      for (const slot of framePlan(frame)) {
        if (slot.slot !== 1 || emptySeats.has(slot.seat) ||
            (!accepted.has(slot.key) && !occupied.get(slot.key)?.stable)) continue;
        checked++;
        // After measuring an opening rank, the nominal frame can cover white
        // felt lettering. Verify the measured card at its actual position.
        const tracked = relocationScratch && (locations.has(slot.key) || occupied.get(slot.key)?.stable);
        const present = tracked ? trackedVisible(pixels, slot) : slot.views.some(view => {
          if (view.invert) return invertedOpeningVisible(pixels, view);
          return whiteShare(pixels, view, 4) >= (view.minBright ?? 0.46);
        });
        if (present) visible++;
      }
      return { checked, visible };
    }

    function hasMappedCard(frame) {
      const pixels = { data: frame.data, channels: frame.channels ?? 4 };
      return framePlan(frame).some(slot => !emptySeats.has(slot.seat) && (trackedVisible(pixels, slot) || slot.views.some(view => {
        if (view.shifted || view.pairedOnly) return false;
        if (view.invert) return invertedOpeningVisible(pixels, view);
        return whiteShare(pixels, view, 4) >= Math.max(0.58, view.minBright ?? 0.46);
      })));
    }

    function openingStatus(slots, pixels, seconds) {
      const readings = new Map();
      for (const slot of slots) {
        if (slot.slot !== 1 || emptySeats.has(slot.seat)) continue;
        const bright = trackedVisible(pixels, slot) ||
          slot.views.some(view => view.invert ? invertedOpeningVisible(pixels, view) : hasLight(pixels, view));
        const recognized = locations.has(slot.key);
        const stable = Boolean(occupied.get(slot.key)?.stable);
        const later = slots.some(other => other.seat === slot.seat && other.slot > 1 && locations.has(other.key));
        const state = recognized || (bright && accepted.has(slot.key)) ? 'occupied'
          : stable || later ? 'unread' : 'unknown';
        readings.set(slot.seat, { state, bright });
      }
      const hasReference = [...readings.values()].some(item => item.bright && item.state !== 'unknown');
      return Array.from({ length: seatCount }, (_, index) => {
        const seat = index + 1;
        if (emptySeats.has(seat)) return { seat, state: 'blank', explicit: true };
        const reading = readings.get(seat);
        if (!reading || reading.state !== 'unknown' || reading.bright || !hasReference) {
          blankHistory.delete(seat);
          return { seat, state: reading?.state ?? 'unknown' };
        }
        const previous = blankHistory.get(seat);
        const count = previous && seconds - previous.time <= frameGap ? previous.count + 1 : 1;
        blankHistory.set(seat, { count, time: seconds });
        // An observed blank is a diagnostic only. It never disables a seat.
        return { seat, state: count >= blankConfirmations ? 'blank' : 'unknown' };
      });
    }

    function offsetBefore(slot, active) {
      for (let number = slot.slot - 1; number >= 1; number--) {
        const key = `${slot.seat}:${number}`;
        const evidence = occupied.get(key);
        const observed = locations.get(key) ?? (evidence?.stable ? evidence : null);
        if (!observed) continue;
        const previous = active.find(other => other.key === key);
        if (!previous) continue;
        const base = previous.bases.filter(view => !view.pairedOnly)
          .reduce((best, view) => distanceSquared(view, observed) < distanceSquared(best, observed) ? view : best, previous);
        const x = observed.x - base.x;
        const y = observed.y - base.y;
        if (Math.abs(x) <= relocationWidth && Math.abs(y) <= relocationHeight) return { x, y };
      }
      return { x: 0, y: 0 };
    }

    function playerFan(slot) {
      if (slot.seat === 0 || slot.slot <= 2 || slot.followFan === false) return null;
      const previous = locations.get(`${slot.seat}:${slot.slot - 1}`);
      const earlier = locations.get(`${slot.seat}:${slot.slot - 2}`);
      if (!previous || !earlier) return null;
      const stepX = previous.x - earlier.x;
      const stepY = previous.y - earlier.y;
      if (Math.abs(stepX) > 105 || stepY > -10 || stepY < -75) return null;
      return { previous, expected: { x: previous.x + stepX, y: previous.y + stepY } };
    }

    function mayRelocate(slot, seconds) {
      const previous = recoveryTimes.get(slot.key);
      if (previous == null && (frameNumber + slot.seat + slot.slot) % 2 === 0) return false;
      if (previous != null && seconds - previous + 1e-9 < relocationInterval) return false;
      recoveryTimes.set(slot.key, seconds);
      return true;
    }

    function openingLocations() {
      return full.filter(slot => slot.slot === 1 && !emptySeats.has(slot.seat) && locations.has(slot.key))
        .map(slot => {
          const { x, y } = locations.get(slot.key);
          return { seat: slot.seat, x, y };
        });
    }

    function readLive(slots, pixels, seconds, started) {
      frameNumber++;
      const events = [];
      const active = emptySeats.size ? slots.filter(slot => !emptySeats.has(slot.seat)) : slots;
      const centers = new Map(active.filter(slot => locations.has(slot.key)).map(slot => [slot.key, locations.get(slot.key)]));
      const diagnostics = {
        checked: 0, glyphs: 0, matched: 0, lowConfidence: 0,
        blocked: 0, shiftedMatches: 0, occupiedUnmatched: 0, fallbackMatches: 0, fallbackAccepted: 0,
        relocatedMatches: 0, relocatedAccepted: 0,
      };
      for (const slot of active) {
        const { key } = slot;
        if (accepted.has(key)) continue;
        const predecessor = `${slot.seat}:${slot.slot - 1}`;
        const bypass = slot.slot > 1 && !accepted.has(predecessor);
        if (bypass && ((relocationScratch && slot.seat > 0 && slot.slot > 2) || !occupied.get(predecessor)?.stable)) {
          diagnostics.blocked++;
          occupied.delete(key);
          pending.delete(key);
          continue;
        }
        diagnostics.checked++;
        let { evidence, guess, priorScores, pairedEvidence } = inspectLive(pixels, slot, active, centers, singles, tens, live, bypass, fallback);
        const fan = relocationScratch ? playerFan(slot) : null;
        if (!onFan(evidence, fan)) {
          evidence = guess = null;
          pairedEvidence = false;
        }
        if (!guess && fallback) {
          guess = inspectFallback(pixels, slot, active, centers, singles, tens, fallback, live, priorScores);
          if (!onFan(guess, fan)) guess = null;
          evidence = guess ?? evidence;
        }
        const maySearch = slot.slot === 1 || (slot.seat > 0 && (slot.slot === 2 || fan));
        if (!guess && !pairedEvidence && relocationScratch && maySearch) {
          // The ordinary scan still runs every frame. Keep the last tentative
          // location until the next expensive search can verify it.
          if (!mayRelocate(slot, seconds)) continue;
          const offset = fan ? { x: fan.expected.x - slot.x, y: fan.expected.y - slot.y } : offsetBefore(slot, active);
          const recovered = recoverGlyph(pixels, slot, active, centers, offset, singles, relocationScratch, fan);
          guess = recovered.guess;
          evidence = recovered.evidence ?? evidence;
        }
        if (evidence) {
          diagnostics.glyphs++;
          const prior = occupied.get(key);
          const stable = Boolean(prior && seconds - prior.time <= frameGap &&
            distanceSquared(prior, evidence) <= 49 &&
            similarity(evidence.rows, evidence.area, prior) >= 0.80);
          occupied.set(key, { ...evidence, stable, time: seconds });
          centers.set(key, evidence);
          if (!guess) {
            diagnostics.lowConfidence++;
            if (stable) diagnostics.occupiedUnmatched++;
          }
        } else {
          occupied.delete(key);
        }
        if (!guess) {
          pending.delete(key);
          continue;
        }
        diagnostics.matched++;
        diagnostics.shiftedMatches += Number(guess.shifted);
        diagnostics.fallbackMatches += Number(Boolean(guess.fallback));
        diagnostics.relocatedMatches += Number(Boolean(guess.relocated));
        const previous = pending.get(key);
        if (previous?.rank !== guess.rank || previous.fallback !== guess.fallback || seconds - previous.time > frameGap ||
            distanceSquared(previous, guess) > 49) {
          pending.set(key, { ...guess, time: seconds, firstTime: seconds, confirmations: 1 });
          continue;
        }
        if ((guess.fallback || guess.relocated) && previous.confirmations < 2) {
          pending.set(key, { ...guess, time: seconds, firstTime: previous.firstTime,
            score: Math.min(previous.score, guess.score), confirmations: previous.confirmations + 1 });
          continue;
        }
        accepted.add(key);
        locations.set(key, guess);
        pending.delete(key);
        const event = { seat: slot.seat, slot: slot.slot, rank: guess.rank, time: seconds,
          confidence: Math.min(previous.score, guess.score), initial: previous.firstTime <= opening,
          confirmationMs: (seconds - previous.firstTime) * 1000 };
        if (guess.fallback) {
          event.templateSource = 'fallback';
          diagnostics.fallbackAccepted++;
        }
        if (guess.relocated) diagnostics.relocatedAccepted++;
        events.push(event);
      }
      diagnostics.opening = openingStatus(slots, pixels, seconds);
      return { events, diagnostics, processingMs: performance.now() - started };
    }

    function read(frame, seconds) {
      const started = performance.now();
      const slots = framePlan(frame);
      if (!Number.isFinite(seconds) || seconds <= lastTime) return { events: [], processingMs: 0 };
      lastTime = seconds;
      const pixels = { data: frame.data, channels: frame.channels ?? 4 };
      if (live) return readLive(slots, pixels, seconds, started);
      const events = [];
      for (const slot of slots) {
        const key = `${slot.seat}:${slot.slot}`;
        if (accepted.has(key) || (slot.slot > 1 && !accepted.has(`${slot.seat}:${slot.slot - 1}`))) continue;

        const guess = match(pixels, slot, templates);
        if (!guess) {
          pending.delete(key);
          continue;
        }

        const previous = pending.get(key);
        if (previous?.rank !== guess.rank || seconds - previous.time > frameGap) {
          pending.set(key, { rank: guess.rank, confidence: guess.score, time: seconds });
          continue;
        }

        accepted.add(key);
        pending.delete(key);
        events.push({ seat: slot.seat, slot: slot.slot, rank: guess.rank, time: seconds,
          confidence: Math.min(previous.confidence, guess.score), initial: previous.time <= opening,
          confirmationMs: (seconds - previous.time) * 1000 });
      }
      return { events, processingMs: performance.now() - started };
    }

    reset();
    return { read, reset, crop, setManual, reopen, setSeatEmpty, sampleGlyph, addTemplate, visibleOpeningSlots, hasMappedCard, openingLocations };
  }

  const api = { create, classify, normalize, normalizeTen, normalizeFallback, compile, glyphArea };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackRecognition = api;
}(globalThis));
