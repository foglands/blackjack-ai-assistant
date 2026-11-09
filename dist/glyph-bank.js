(function (root) {
  'use strict';

  const storageKey = 'blackjack-lab:live-glyphs:v1';
  const limit = 12;
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  function valid(rows) {
    return Array.isArray(rows) && rows.length === 20 && rows.some(Boolean) &&
      rows.every(row => Number.isInteger(row) && row >= 0 && row <= 65535);
  }

  function load(key = storageKey) {
    try {
      const stored = JSON.parse(root.localStorage.getItem(key));
      return Object.fromEntries(ranks.filter(rank => Array.isArray(stored?.[rank]))
        .map(rank => [rank, stored[rank].filter(valid).slice(0, limit)]));
    } catch {
      return {};
    }
  }

  function add(bank, rank, rows, key = storageKey) {
    if (!ranks.includes(rank) || !valid(rows)) return { ok: false, message: '需要一个有效牌点和清晰的字形。' };
    const list = bank[rank] ?? [];
    if (list.some(sample => sample.every((row, index) => row === rows[index]))) {
      return { ok: true, duplicate: true, message: '这份字形已经记住。' };
    }
    if (list.length >= limit) return { ok: false, message: `牌点 ${rank} 已有 ${limit} 份用户样本。` };
    bank[rank] = [...list, rows.slice()];
    try {
      root.localStorage.setItem(key, JSON.stringify(bank));
      return { ok: true, saved: true, message: `已把 ${rank} 的字形保存到本机。` };
    } catch {
      return { ok: true, saved: false, message: `已学习 ${rank} 的字形，本次运行有效。` };
    }
  }

  function augment(templates) {
    return Object.fromEntries(Object.entries(templates).map(([rank, samples]) => [rank, [
      ...samples,
      ...samples.flatMap(rows => [-2, 2].map(lean => rows.map((row, y) => {
        const shift = Math.round(lean * (y - 9.5) / 9.5);
        return shift < 0 ? row >>> -shift : (row << shift) & 0xffff;
      }))),
    ]]));
  }

  const api = { storageKey, ranks, load, add, augment };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackGlyphBank = api;
}(globalThis));
