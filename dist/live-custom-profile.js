(function (root) {
  'use strict';

  const lastPlayerSeat = 9;
  const cardLimit = 7;

  function within(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function record(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function point(value, label) {
    if (!record(value) || ![value.x, value.y].every(coordinate =>
      Number.isFinite(coordinate) && coordinate >= 0 && coordinate < 1)) {
      throw new Error(label + '须在牌桌区域内。');
    }
    return { x: value.x, y: value.y };
  }

  function delta(value, label) {
    if (!record(value) || ![value.x, value.y].every(coordinate =>
      Number.isFinite(coordinate) && Math.abs(coordinate) < 1) || (!value.x && !value.y)) {
      throw new Error(label + '须有有效的后续牌位间距。');
    }
    return { x: value.x, y: value.y };
  }

  function difference(end, start) {
    return { x: end.x - start.x, y: end.y - start.y };
  }

  function advance(start, step, distance = 1) {
    return { x: start.x + distance * step.x, y: start.y + distance * step.y };
  }

  function count(value, label) {
    if (!Number.isInteger(value) || value < 1 || value > cardLimit) {
      throw new Error(label + '可设置 1 至 ' + cardLimit + ' 个牌位。');
    }
    return value;
  }

  function patchSettings(value, label) {
    if (value == null) return {};
    if (!record(value)) throw new Error(label + '的字形框设置无效。');
    return value;
  }

  function patchGeometry(width, height, step, settings, label) {
    const edge = Math.min(width, height);
    const normalW = within(Math.round(edge * 0.032), 16, 52);
    const normalH = within(Math.round(edge * 0.025), 14, 40);
    const distance = step ? Math.hypot(step.x * width, step.y * height) : null;
    const defaultW = distance ? within(Math.round(distance * 0.90), Math.max(16, Math.round(normalW * 0.8)), Math.round(normalW * 1.24)) : normalW;
    const defaultH = distance ? within(Math.round(distance * 0.64), Math.max(14, Math.round(normalH * 0.8)), Math.round(normalH * 1.24)) : normalH;
    function extent(normalized, span, fallback, maximum) {
      if (normalized === undefined) return fallback;
      const pixels = Math.round(normalized * span);
      if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 0.20 || pixels < 9 || pixels > maximum) {
        throw new Error(label + '的字形框尺寸不适用，请缩小或扩大框选区域。');
      }
      return pixels;
    }
    const { u = 0, v = 0, flip = false, invert = false } = settings;
    if (![u, v].every(value => Number.isFinite(value) && Math.abs(value) <= 2) ||
        typeof flip !== 'boolean' || typeof invert !== 'boolean') {
      throw new Error(label + '的斜切、旋转或反色设置无效。');
    }
    return {
      w: extent(settings.width, width, defaultW, 180),
      h: extent(settings.height, height, defaultH, 140),
      u, v, flip, invert,
    };
  }

  function seatLabel(seat) {
    return seat === 0 ? '庄家' : '座位 ' + seat;
  }

  function slotView(seat, slot, center, patch, width, height, marked) {
    return {
      seat, slot, x: center.x * width, y: center.y * height, ...patch,
      minScore: marked ? 0.87 : 0.90,
      minMargin: marked ? 0.13 : 0.16,
    };
  }

  function fits(view, width, height) {
    const { x, y, w, h, u, v } = view;
    const halfX = (w - 1 + Math.abs(v) * (h - 1)) / 2;
    const halfY = (h - 1 + Math.abs(u) * (w - 1)) / 2;
    return Math.round(x - halfX) >= 0 && Math.round(x + halfX) < width &&
      Math.round(y - halfY) >= 0 && Math.round(y + halfY) < height;
  }

  function tooClose(first, second) {
    const minX = Math.max(5, (first.w + second.w) * 0.26);
    const minY = Math.max(5, (first.h + second.h) * 0.30);
    return ((first.x - second.x) / minX) ** 2 + ((first.y - second.y) / minY) ** 2 < 1;
  }

  function templateSet(templates) {
    if (!record(templates)) throw new Error('字形模板无效。');
    return Object.fromEntries(Object.entries(templates)
      .filter(([rank, samples]) => /^(?:A|[2-9]|10|J|Q|K)$/.test(rank) && Array.isArray(samples))
      .map(([rank, samples]) => [rank, samples.filter(rows =>
        Array.isArray(rows) && rows.length === 20 && rows.some(Boolean) &&
        rows.every(row => Number.isInteger(row) && row >= 0 && row <= 65535)).map(rows => rows.slice())])
      .filter(([, samples]) => samples.length));
  }

  function seatPlan(seat, settings, { width, height, patch, maxCards }) {
    const label = seatLabel(seat);
    if (!record(settings)) throw new Error(label + '的牌位标记无效。');
    const capacity = count(settings.maxCards ?? maxCards, label);
    const first = point(settings.first, label + '第一张牌');
    const step = settings.step == null ? null : delta(settings.step, label);
    const explicitSecond = settings.second == null ? null : point(settings.second, label + '第二张牌');
    const third = settings.third == null ? null : point(settings.third, label + '第三张牌');
    if ((explicitSecond && capacity < 2) || (third && capacity < 3)) {
      throw new Error(label + '的牌位数少于已经标记的牌。');
    }
    const second = explicitSecond ?? (step ? advance(first, step) : null);
    if (third && !second) throw new Error('请先标记' + label + '第二张牌。');
    const continuation = step ?? (third ? difference(third, second) : second ? difference(second, first) : null);
    const geometry = patchGeometry(width, height, continuation, { ...patch, ...patchSettings(settings.patch, label) }, label);
    const mandatory = [first];
    if (explicitSecond || third) mandatory.push(second);
    if (third) mandatory.push(third);
    return { seat, label, capacity, geometry, mandatory, second, third, continuation, limit: mandatory.length };
  }

  function inferredPoint(plan, number) {
    if (number === 2) return plan.second;
    if (!plan.continuation) return null;
    return plan.third
      ? advance(plan.third, plan.continuation, number - 3)
      : advance(plan.second, plan.continuation, number - 2);
  }

  function build(input = {}) {
    try {
      const { width, height, seats, templates = {}, patch, maxCards = cardLimit, seatCount = 7 } = input;
      if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 8192)) {
        throw new Error('请选择有效的牌桌画面尺寸。');
      }
      if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > lastPlayerSeat) {
        throw new Error('请选择 1 至 ' + lastPlayerSeat + ' 个玩家座位。');
      }
      if (!record(seats) || !Object.keys(seats).length) {
        throw new Error('至少标记一个座位或庄家的第一张牌。');
      }
      const common = { width, height, patch: patchSettings(patch, '牌桌'), maxCards: count(maxCards, '牌桌') };
      const plans = Object.entries(seats).map(([key, settings]) => {
        if (!/^[0-9]$/.test(key) || Number(key) > seatCount) {
          throw new Error('请选择庄家或 1 至 ' + seatCount + ' 号座位。');
        }
        return seatPlan(Number(key), settings, common);
      });
      const slots = [];
      const truncated = [];

      // Reserve every explicitly marked position before estimating the fan.
      // An inferred slot can never push a real anchor to a different ID.
      for (const plan of plans) {
        plan.mandatory.forEach((center, index) => {
          const view = slotView(plan.seat, index + 1, center, plan.geometry, width, height, true);
          if (!fits(view, width, height)) {
            throw new Error(plan.label + '第 ' + view.slot + ' 张牌过于靠近区域边缘。');
          }
          const conflict = slots.find(other => tooClose(view, other));
          if (conflict) throw new Error(plan.label + '与' + seatLabel(conflict.seat) + '的牌位太近，请核对标记。');
          slots.push(view);
        });
      }

      const stopped = new Set();
      for (let number = 2; number <= cardLimit; number++) {
        for (const plan of plans) {
          if (number <= plan.limit || number > plan.capacity || stopped.has(plan.seat)) continue;
          const center = inferredPoint(plan, number);
          if (!center) continue;
          const view = slotView(plan.seat, number, center, plan.geometry, width, height, false);
          const reason = !fits(view, width, height) ? 'outside'
            : slots.some(other => tooClose(view, other)) ? 'collision' : null;
          if (reason) {
            stopped.add(plan.seat);
            truncated.push({ seat: plan.seat, afterSlot: number - 1, reason });
          } else {
            slots.push(view);
          }
        }
      }

      const radius = within(Math.round(Math.min(width, height) * 0.008), 2, 8);
      const offsets = [[-radius, 0], [radius, 0], [0, -radius], [0, radius],
        [-radius, -radius], [radius, -radius], [-radius, radius], [radius, radius]];
      return {
        ok: true,
        profile: {
          width, height, seatCount, slots: slots.sort((a, b) => a.seat - b.seat || a.slot - b.slot),
          templates: templateSet(templates),
          liveSearch: { offsets, minScore: 0.87, minMargin: 0.13 },
          maxFrameGapSeconds: 0.42, openingSeconds: 0.38,
        },
        truncated,
      };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  const api = { build, cardLimit, lastPlayerSeat };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackCustomLiveProfile = api;
}(globalThis));
