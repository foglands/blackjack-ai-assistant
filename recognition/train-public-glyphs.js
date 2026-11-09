'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { inflateSync } = require('node:zlib');
const path = require('node:path');
const { parseArgs } = require('node:util');
const recognition = require('../dist/recognition-engine');
const replay = require('../dist/recognition-profile');
const live = require('../dist/live-recognition-profile');
const bank = require('../dist/glyph-bank');

const ranks = bank.ranks;
const width = 90;
const height = 70;
const slot = { seat: 0, slot: 1, x: 44, y: 34, w: 46, h: 40, u: 0, v: 0, minScore: 0.87, minMargin: 0.13 };
const roi = recognition.compile(slot, width);
const trainingViews = [
  [17, 0, 245, 233], [19, 0.05, 244, 215], [21, -0.08, 238, 228], [23, 0, 246, 240],
  [26, 0.10, 228, 214], [27, -0.12, 240, 200], [21, 0.14, 229, 206], [24, -0.04, 247, 235],
];
const testViews = [
  [18, 0, 234, 228], [22, 0.07, 242, 232], [25, -0.10, 237, 230], [28, 0.03, 232, 238],
  [20, -0.14, 249, 206], [23, 0.16, 228, 215], [16, -0.03, 225, 245], [24, 0, 248, 216],
];

function renderGlyph(sample, [glyphHeight, shear, background, contrast], offset = 0) {
  const data = new Uint8Array(width * height).fill(38);
  for (const position of roi.pixels) data[position] = background;
  const glyphWidth = sample.width * glyphHeight / sample.height;
  const pixels = sample.pixels;
  for (const index of roi.pixels) {
    const y = Math.floor(index / width) - slot.y;
    const x = index % width - slot.x - offset - shear * y;
    const sourceY = (y + glyphHeight / 2) * sample.height / glyphHeight - 0.5;
    const sourceX = (x + glyphWidth / 2) * sample.width / glyphWidth - 0.5;
    const left = Math.floor(sourceX);
    const top = Math.floor(sourceY);
    if (left < 0 || top < 0 || left >= sample.width - 1 || top >= sample.height - 1) continue;
    const dx = sourceX - left;
    const dy = sourceY - top;
    const start = top * sample.width + left;
    const a = pixels[start] * (1 - dx) + pixels[start + 1] * dx;
    const b = pixels[start + sample.width] * (1 - dx) + pixels[start + sample.width + 1] * dx;
    const ink = 1 - (a * (1 - dy) + b * dy) / 255;
    data[index] = Math.max(0, Math.round(background - ink * contrast));
  }
  return { data, width, height, channels: 1 };
}

function similarities(rows) {
  const templates = rows.map((sample, index) => [[String(index), [{ rows: sample, area: recognition.glyphArea(sample) }]]]);
  return rows.map((sample, i) => templates.map((template, j) => i === j ? 1 : recognition.classify(sample, template).score));
}

function fitRank(samples) {
  const shapes = [];
  for (const sample of samples) {
    for (const view of trainingViews) {
      const frame = renderGlyph(sample, view);
      const rows = recognition.normalizeFallback(frame, roi, sample.rank === '10');
      if (rows && !shapes.some(existing => existing.every((row, i) => row === rows[i]))) shapes.push(rows);
    }
  }
  const scores = similarities(shapes);
  const coverage = shapes.map(() => 0);
  const chosen = [];
  while (chosen.length < Math.min(8, shapes.length)) {
    const gain = scores.map(row => row.reduce((total, score, i) => total + Math.max(0, score - coverage[i]), 0));
    const winner = gain.indexOf(Math.max(...gain));
    if (gain[winner] <= 0.001) break;
    chosen.push(shapes[winner]);
    scores[winner].forEach((score, i) => { coverage[i] = Math.max(coverage[i], score); });
  }
  return chosen;
}

function detection(detector, frame) {
  detector.reset();
  for (const time of [0, 0.05, 0.10]) {
    const { events } = detector.read(frame, time);
    if (events.length) return events[0];
  }
  return null;
}

function blankOrMark(kind, index) {
  const data = new Uint8Array(width * height).fill(kind === 0 ? 38 + index : 244);
  for (const position of roi.pixels) {
    const x = position % width - slot.x;
    const y = Math.floor(position / width) - slot.y;
    const radius = 6 + index % 5;
    const distance = Math.hypot(x, y);
    const mark = kind === 1 ? distance <= radius
      : kind === 2 ? Math.abs(distance - radius) < 1.5
        : kind === 3 ? Math.abs(x - y / 2) < 1.5 && Math.abs(y) < radius
          : kind === 4 && Math.abs(x) + Math.abs(y) < radius;
    if (mark) data[position] = 18;
  }
  return { data, width, height, channels: 1 };
}

function measure(detector, cases) {
  const result = { total: cases.length, correct: 0, wrong: 0, rejected: 0, falsePositive: 0, fallback: 0 };
  const wrong = {};
  for (const { frame, rank } of cases) {
    const event = detection(detector, frame);
    if (event?.templateSource === 'fallback') result.fallback++;
    if (!rank) {
      if (event) result.falsePositive++;
      else result.correct++;
    } else if (!event) result.rejected++;
    else if (event.rank === rank) result.correct++;
    else {
      result.wrong++;
      const key = rank + '→' + event.rank;
      wrong[key] = (wrong[key] ?? 0) + 1;
    }
  }
  if (result.wrong) result.confusions = wrong;
  return result;
}

function main() {
  const { values } = parseArgs({ options: {
    output: { type: 'string' }, score: { type: 'string' }, margin: { type: 'string' }, calibrate: { type: 'boolean' },
  } });
  if (values.output && values.calibrate) throw new Error('Calibration mode does not write a model');
  const search = { fallbackMinScore: Number(values.score ?? '0.78'), fallbackMinMargin: Number(values.margin ?? '0.07') };
  if (!(search.fallbackMinScore >= 0.76 && search.fallbackMinScore <= 1 &&
      search.fallbackMinMargin >= 0.07 && search.fallbackMinMargin <= 1)) throw new Error('Invalid fallback thresholds');
  const input = JSON.parse(readFileSync(path.join(__dirname, 'public-rank-samples.json'), 'utf8'));
  const samples = input.samples.map(sample => ({
    ...sample, pixels: inflateSync(Buffer.from(sample.gray, 'base64')),
  }));
  for (const sample of samples) {
    if (!ranks.includes(sample.rank) || sample.pixels.length !== sample.width * sample.height) throw new Error('Invalid source image');
  }
  const train = samples.filter(sample => sample.split === 'train');
  const templates = Object.fromEntries(ranks.map(rank => [rank, fitRank(train.filter(sample => sample.rank === rank))]));
  if (ranks.some(rank => !templates[rank].length)) throw new Error('At least one rank has no usable training view');
  const base = live.forCapture(replay, bank.augment);
  const profile = { width, height, slots: [slot], templates: base.templates, liveSearch: base.liveSearch, maxFrameGapSeconds: 0.42 };
  const existing = recognition.create(profile);
  const candidate = recognition.create({ ...profile, liveSearch: { ...profile.liveSearch, ...search }, fallbackTemplates: templates });
  const groupSamples = values.calibrate ? samples.filter(sample => sample.split === 'sameDesignHoldout')
    : samples.filter(sample => sample.split !== 'train');
  const groups = Object.groupBy(groupSamples, sample => sample.split);
  const holdouts = Object.fromEntries(Object.entries(groups).map(([name, group]) => [
    name, group.flatMap(sample => testViews.map((view, index) => ({
      rank: sample.rank, frame: renderGlyph(sample, view, [0, 2, -2, 0, 1, -1, 0, 3][index]),
    }))),
  ]));
  holdouts.nonRank = Array.from({ length: 5 }, (_, kind) =>
    Array.from({ length: 12 }, (_, index) => ({ frame: blankOrMark(kind, index) }))).flat();
  const scores = Object.fromEntries(Object.entries(holdouts).map(([name, cases]) =>
    [name, { baseline: measure(existing, cases), trained: measure(candidate, cases) }]));
  const report = { sourceImages: samples.length, trainingImages: train.length, ranks: ranks.length, search,
    samplesByRank: Object.fromEntries(ranks.map(rank => [rank, templates[rank].length])), scores };
  console.log(JSON.stringify(report, null, 2));

  if (values.output) {
    const lines = ranks.map(rank => '  ' + JSON.stringify(rank) + ': ' + JSON.stringify(templates[rank])).join(',\n');
    const moduleText = "'use strict';\n\n// Generated by recognition/train-public-glyphs.js from public-rank-samples.json.\n" +
      "(function (root) {\n  const templates = {\n" + lines + "\n  };\n" +
      '  const model = { templates, search: ' + JSON.stringify(search) + ' };\n' +
      "  if (typeof module === 'object' && module.exports) module.exports = model;\n" +
      "  else root.BlackjackPublicGlyphs = model;\n}(globalThis));\n";
    writeFileSync(values.output, moduleText, 'utf8');
  }
}

main();
