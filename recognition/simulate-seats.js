'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const engine = require('../dist/recognition-engine');
const replay = require('../dist/recognition-profile');
const live = require('../dist/live-recognition-profile');
const glyphs = require('../dist/glyph-bank');
const layout = require('../dist/live-layout');
const capture = require('../dist/live-capture');
const observer = require('../dist/observer-core');

const seats = [1, 2, 3, 4, 5, 6, 7];
const ranks = ['A', '2', '4', '7', '8', '9', 'J', 'Q'];
const profile = live.forCapture(replay, glyphs.augment);
const tableRect = { x: 0, y: 0, width: 1, height: 1 };

function positionKey(seat, slot) {
  return seat + ':' + slot;
}

function createSource(view) {
  const { width, height } = view;
  const bgra = new Uint8Array(width * height * 4);
  const positions = new Map(view.slots.map(slot => [positionKey(slot.seat, slot.slot), slot]));
  const detector = engine.create(view);
  const bounds = detector.crop;
  const map = capture.makeMap(bounds, view, tableRect, width, height);
  const frame = { width: bounds.width, height: bounds.height, channels: 1, data: new Uint8Array(bounds.width * bounds.height) };

  function paint(seat, slot, shape, shiftX = 0, shiftY = 0) {
    const position = positions.get(positionKey(seat, slot));
    assert.ok(position, 'Missing simulated card position');
    const { w, h, u, v, flip } = position;
    const x = position.x + shiftX;
    const y = position.y + shiftY;
    const glyphWidth = Math.min(17, w - 6);
    const glyphHeight = Math.min(20, h - 4);
    const boundX = w / 2 + Math.abs(v) * h / 2;
    const boundY = h / 2 + Math.abs(u) * w / 2;
    const determinant = 1 - u * v;
    const direction = flip ? -1 : 1;
    for (let row = Math.ceil(y - boundY); row <= Math.floor(y + boundY); row++) {
      for (let col = Math.ceil(x - boundX); col <= Math.floor(x + boundX); col++) {
        const dx = (col - x - v * (row - y)) / determinant * direction;
        const dy = (row - y - u * (col - x)) / determinant * direction;
        if (Math.abs(dx) > w / 2 || Math.abs(dy) > h / 2) continue;
        const sx = Math.floor(16 * (dx / glyphWidth + 0.5));
        const sy = Math.floor(20 * (dy / glyphHeight + 0.5));
        const ink = shape && sx >= 0 && sx < 16 && sy >= 0 && sy < 20 && (shape[sy] & (1 << (15 - sx)));
        const offset = (row * width + col) * 4;
        bgra[offset] = bgra[offset + 1] = bgra[offset + 2] = ink ? 20 : 245;
      }
    }
  }

  function read(seconds) {
    capture.extract(bgra, map, frame.data);
    return detector.read(frame, seconds);
  }

  function reset() {
    bgra.fill(24);
    detector.reset();
  }

  return { detector, paint, read, reset };
}

function openingState(result, seat) {
  return result.diagnostics.opening.find(row => row.seat === seat)?.state;
}

function addCard(state, event) {
  return observer.apply(state, { ...event, type: 'card', source: 'auto' });
}

function p95(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function runOccupancy(variedRanks = false) {
  const source = createSource(profile);
  const totals = {
    patterns: 128, expected: 0, recognized: 0, matched: 0, missed: 0,
    falsePositives: 0, duplicates: 0, openingMismatches: 0, unreadOpenings: 0,
  };
  const failures = [];
  const missesByPosition = {};
  const engineTimes = [];
  const pipelineTimes = [];

  for (let mask = 0; mask < totals.patterns; mask++) {
    source.reset();
    const players = seats.filter(seat => mask & (1 << (seat - 1)));
    const visible = new Map();
    const accepted = new Map();
    let state = observer.create({ mode: 'complete' });
    let seconds = 0;

    function issue(type, value) {
      if (failures.length < 20) failures.push({ mask: mask.toString(2).padStart(7, '0'), type, value });
    }

    function sample() {
      const started = performance.now();
      const result = source.read(seconds);
      pipelineTimes.push(performance.now() - started);
      engineTimes.push(result.processingMs);
      seconds += 0.05;
      for (const event of result.events) {
        totals.recognized++;
        const key = positionKey(event.seat, event.slot);
        if (accepted.has(key)) {
          totals.duplicates++;
          issue('duplicate', event);
          continue;
        }
        accepted.set(key, event.rank);
        if (visible.get(key) !== event.rank) {
          totals.falsePositives++;
          issue('false or premature event', event);
        } else {
          totals.matched++;
        }
        state = addCard(state, event);
      }
      return result;
    }

    function deal(seat, slot, rank) {
      visible.set(positionKey(seat, slot), rank);
      source.paint(seat, slot, profile.templates[rank][0]);
      sample();
    }

    const empty = sample();
    assert.ok(empty.diagnostics.opening.every(row => row.state === 'unknown'));
    if (players.length) {
      // Fixed seat IDs run screen-right to screen-left. Vacancies never
      // compress the identifiers passed to the detector or observer.
      for (const seat of players) deal(seat, 1, variedRanks ? ranks[(seat + mask) % ranks.length] : 'A');
      deal(0, 1, 'Q');
      for (const seat of players) deal(seat, 2, variedRanks ? ranks[(seat + mask + 3) % ranks.length] : seat === 3 ? '4' : 'A');
    }
    for (let index = 0; index < 4; index++) sample();
    const final = sample();
    totals.expected += visible.size;
    for (const [key, rank] of visible) {
      if (accepted.get(key) !== rank) {
        totals.missed++;
        const position = key + ' ' + rank;
        missesByPosition[position] = (missesByPosition[position] ?? 0) + 1;
        issue('miss', { key, rank });
      }
    }
    for (const seat of seats) {
      const expected = players.includes(seat) ? 'occupied' : players.length ? 'blank' : 'unknown';
      const actual = openingState(final, seat);
      if (expected === 'occupied' && actual === 'unread') {
        totals.unreadOpenings++;
        continue;
      }
      if (actual !== expected) {
        totals.openingMismatches++;
        issue('opening status', { seat, expected, actual });
      }
    }
    const summary = observer.summary(state);
    assert.equal(summary.seen, accepted.size);
    const recognizedRanks = [...accepted.values()];
    assert.deepEqual(summary.counts, observer.ranks.map(rank => 32 - recognizedRanks.filter(value => value === rank).length));
    const running = recognizedRanks.reduce((sum, rank) => sum +
      ('23456'.includes(rank) ? 1 : ['A', '10', 'J', 'Q', 'K'].includes(rank) ? -1 : 0), 0);
    assert.equal(summary.running, running);
    const probabilities = observer.forecast(state).ranks;
    assert.ok(Math.abs(probabilities.reduce((sum, rank) => sum + rank.probability, 0) - 1) < 1e-10);
  }

  return {
    ...totals, frames: engineTimes.length, engineP95Ms: p95(engineTimes),
    extractionAndEngineP95Ms: p95(pipelineTimes), missesByPosition, failures,
  };
}

function runSpecialCases() {
  const source = createSource(profile);
  const first = profile.templates.A[0];
  const unknown = Array.from({ length: 20 }, (_, y) => y < 3 || y > 16 ? 65535 : 49155);
  source.reset();
  source.paint(1, 1, first);
  source.paint(5, 1, unknown);
  source.paint(5, 2, first);
  source.paint(7, 1, first);
  const outputs = [0, 0.05, 0.10, 0.15, 0.20].map(source.read);
  assert.deepEqual(outputs.flatMap(item => item.events.map(event => positionKey(event.seat, event.slot))).sort(), ['1:1', '5:2', '7:1']);
  assert.equal(openingState(outputs.at(-1), 5), 'unread');
  assert.equal(openingState(outputs.at(-1), 4), 'blank');

  source.reset();
  source.detector.setSeatEmpty(4);
  source.paint(4, 1, first);
  source.paint(7, 1, first);
  assert.equal(source.read(0).events.length, 0);
  const suppressed = source.read(0.05);
  assert.deepEqual(suppressed.events.map(event => event.seat), [7]);
  assert.deepEqual(suppressed.diagnostics.opening.find(row => row.seat === 4), { seat: 4, state: 'blank', explicit: true });
  source.detector.setSeatEmpty(4, false);
  assert.equal(source.read(0.10).events.length, 0);
  assert.deepEqual(source.read(0.15).events.map(event => event.seat), [4]);

  source.reset();
  source.paint(7, 1, first);
  assert.equal(source.read(0).events.length, 0);
  assert.equal(source.read(0.70).events.length, 0);
  assert.deepEqual(source.read(0.75).events.map(event => event.seat), [7]);

  const anchors = Object.fromEntries([1, 7].map(seat => {
    const slot = profile.slots.find(position => position.seat === seat && position.slot === 1);
    return [seat, { x: slot.x * 0.96 + 33, y: slot.y * 0.96 - 25 }];
  }));
  const remapped = layout.transform(profile, anchors);
  assert.equal(remapped.ok, true);
  const shifted = createSource(remapped.profile);
  shifted.reset();
  shifted.paint(1, 1, first, 7, -6);
  shifted.paint(7, 1, first, 7, -6);
  const offsetFrames = [0, 0.05, 0.10].map(shifted.read);
  assert.deepEqual(offsetFrames.flatMap(item => item.events.map(event => event.seat)).sort(), [1, 7]);
  assert.ok(offsetFrames.some(item => item.diagnostics.shiftedMatches > 0));
  return { unreadPredecessor: true, explicitEmptyReopen: true, gapRejectsPending: true, affineAnchorWithLocalDrift: true };
}

function runUndoCases() {
  const record = (events, state = observer.create()) => events.reduce(observer.apply, state);
  const undo = state => observer.apply(state, { type: 'undo' });
  const splitWithLaterAuto = hand => record([
    { type: 'mySeat', seat: 3 },
    { type: 'card', seat: 1, slot: 1, rank: '8' },
    { type: 'card', seat: 1, slot: 2, rank: '8', source: 'auto' },
    { type: 'split', seat: 1 },
    { type: 'card', seat: 1, hand, slot: 2, rank: '3', source: 'auto' },
  ]);
  for (const hand of [0, 1]) {
    const split = splitWithLaterAuto(hand);
    assert.equal(observer.summary(split).canUndo, true);
    const undone = undo(split);
    assert.equal(observer.summary(undone).mySeat, 4, 'Undo skips edits needed by the split');
    assert.deepEqual(observer.rows(undone), observer.rows(split), 'Undo preserves all cards from both hands');
    assert.equal(observer.summary(undone).canUndo, false);
    assert.equal(undo(undone), undone);
  }

  const complete = observer.create({ mode: 'complete' });
  const fullRank = record(Array.from({ length: 32 }, (_, index) => ({
    type: 'card', source: 'auto', seat: index < 16 ? 1 : 2, slot: index % 16 + 1, rank: '8',
  })), complete);
  const corrected = record([{ type: 'card', seat: 1, slot: 1, rank: '9' }], fullRank);
  assert.deepEqual(observer.rows(undo(corrected)), observer.rows(fullRank), 'Undo restores an unconflicted correction');
  const refilled = record([{ type: 'card', source: 'auto', seat: 3, slot: 1, rank: '8' }], corrected);
  assert.equal(observer.summary(refilled).canUndo, false, 'Undo cannot create a 33rd copy of a rank');
  assert.equal(undo(refilled), refilled);
  assert.equal(observer.summary(refilled).counts[observer.ranks.indexOf('8')], 0);
  return { dependentSplitUndo: true, rankCapacityUndo: true };
}

const occupancy = runOccupancy();
console.log(JSON.stringify({ occupancy }, null, 2));
assert.equal(occupancy.missed + occupancy.falsePositives + occupancy.duplicates + occupancy.openingMismatches + occupancy.unreadOpenings, 0);
console.log(JSON.stringify({ specialCases: runSpecialCases() }, null, 2));
console.log(JSON.stringify({ undoCases: runUndoCases() }, null, 2));
const varied = runOccupancy(true);
const { failures, ...stress } = varied;
console.log(JSON.stringify({ variedRankStress: stress }, null, 2));
assert.equal(varied.missed + varied.falsePositives + varied.duplicates + varied.openingMismatches + varied.unreadOpenings,
  0, JSON.stringify(failures));
