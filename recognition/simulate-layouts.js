'use strict';

// Exercise the browser modules with in-memory storage and a mocked native bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dist = path.join(__dirname, '..', 'dist');
const scripts = ['recognition-profile', 'recognition-engine', 'glyph-bank', 'live-layout', 'live-recognition-profile',
  'live-custom-profile', 'public-trained-glyphs', 'live-capture'];
const store = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const near = (a, b, description) => assert.ok(Math.abs(a - b) < 0.001, `${description}: ${a} vs ${b}`);
const ok = (result, description) => assert.equal(result?.ok ?? result, true, `${description}: ${result?.message ?? ''}`);
const rejected = (result, description) => assert.equal(result?.ok ?? result, false, description);

function createHarness() {
  const listeners = new Map();
  const timers = new Map();
  const messages = [];
  const ready = [];
  const statuses = [];
  const received = [];
  const profiles = [];
  const reads = [];
  let now = 0;
  let timer = 0;
  let released = 0;
  const bridge = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(message) { messages.push(message.type); },
    releaseBuffer() { released++; },
  };
  const context = vm.createContext({
    chrome: { webview: bridge },
    localStorage: {
      getItem: key => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    performance: { now: () => now },
    setTimeout(callback) {
      const id = ++timer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: id => timers.delete(id),
  });
  for (const script of scripts) {
    const file = path.join(dist, script + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  const { create } = context.BlackjackRecognition;
  context.BlackjackRecognition.create = profile => {
    const instance = create(profile);
    profiles.push(clone(profile));
    const { read } = instance;
    instance.read = (frame, seconds) => {
      reads.push({ width: frame.width, height: frame.height, seconds });
      return read(frame, seconds);
    };
    return instance;
  };
  const api = context.BlackjackLiveCapture.create({
    onReady: event => ready.push(clone(event)),
    onStatus: event => statuses.push(clone(event)),
    onFrame: event => received.push(clone(event)),
  });
  return {
    api, profiles, reads, ready, statuses, received,
    get released() { return released; },
    open(width, height, title) {
      assert.equal(api.choose(), true);
      assert.equal(messages.at(-1), 'capture:choose');
      listeners.get('message')({ data: { type: 'capture:ready', width, height, title } });
      assert.equal(ready.at(-1).width, width);
      assert.equal(ready.at(-1).height, height);
    },
    frame(width, height, pixels = new Uint8Array(width * height * 4), elapsedMs = 50) {
      const [id, request] = timers.entries().next().value ?? [];
      assert.ok(request, 'capture did not schedule a frame request');
      timers.delete(id);
      request();
      assert.equal(messages.at(-1), 'capture:frame');
      now += elapsedMs;
      listeners.get('sharedbufferreceived')({
        getBuffer: () => pixels.buffer,
        additionalData: { type: 'capture:frame', pixelFormat: 'BGRA', width, height, capturedAtMs: 1000000 + now },
      });
      assert.equal(statuses.filter(status => status.state === 'error').length, 0, JSON.stringify(statuses));
    },
  };
}

const a = {
  name: 'Synthetic Arc', publicGlyphs: true, crop: { x: 0.10, y: 0.12, width: 0.80, height: 0.75 },
  points: [
    [0, 1, { x: 0.49, y: 0.30, width: 0.028, height: 0.037 }],
    [0, 2, { x: 0.55, y: 0.31 }],
    [1, 1, { x: 0.73, y: 0.57, width: 0.028, height: 0.04 }],
    [1, 2, { x: 0.70, y: 0.61 }],
    [4, 1, { x: 0.36, y: 0.67 }],
  ],
};
const b = {
  name: 'Synthetic Portrait Rows', seatCount: 9, crop: { x: 0.05, y: 0.08, width: 0.90, height: 0.82 },
  points: [
    [0, 1, { x: 0.62, y: 0.68, width: 0.037, height: 0.045 }],
    [2, 1, { x: 0.84, y: 0.41, width: 0.028, height: 0.04 }],
    [2, 2, { x: 0.87, y: 0.39 }],
    [7, 1, { x: 0.39, y: 0.41 }],
    [7, 2, { x: 0.41, y: 0.39 }],
    [9, 1, { x: 0.16, y: 0.50, width: 0.065, height: 0.035, invert: true }],
    [9, 2, { x: 0.22, y: 0.48 }],
  ],
};

function assertGuides(api, config) {
  const guide = clone(api.getGuide(config.crop));
  const expected = new Set(config.points.map(([seat, slot]) => `${seat}:${slot}`));
  const configuredSeats = [...new Set(config.points.map(([seat]) => seat))].sort((x, y) => x - y);
  assert.deepEqual([...new Set(guide.map(region => region.seat))].sort((x, y) => x - y), configuredSeats);
  for (const [seat, slot, point] of config.points) {
    const region = guide.find(region => region.seat === seat && region.slot === slot);
    assert.ok(region, `missing guide for ${seat}:${slot}, ${JSON.stringify(guide)}`);
    assert.ok(expected.has(`${region.seat}:${region.slot}`));
    near(region.x + region.width / 2, point.x, `${seat}:${slot} normalized center x`);
    near(region.y + region.height / 2, point.y, `${seat}:${slot} normalized center y`);
  }
}

function assertProfile(profile, config) {
  const expected = [...new Set(config.points.map(([seat]) => seat))].sort((x, y) => x - y);
  assert.equal(profile.seatCount, config.seatCount ?? 7);
  assert.deepEqual([...new Set(profile.slots.map(slot => slot.seat))].sort((x, y) => x - y), expected);
  for (const [seat, slot, point] of config.points) {
    const region = profile.slots.find(candidate => candidate.seat === seat && candidate.slot === slot);
    assert.ok(region, `${seat}:${slot} was never installed`);
    near(config.crop.x + region.x / profile.width * config.crop.width, point.x, `installed ${seat}:${slot} normalized x`);
    near(config.crop.y + region.y / profile.height * config.crop.height, point.y, `installed ${seat}:${slot} normalized y`);
    if (point.invert !== undefined) assert.equal(region.invert, point.invert);
  }
}

function cardFrame(harness, config, width, height, seat, invert, publicRank, number) {
  const profile = harness.profiles.at(-1);
  const region = profile.slots.find(slot => slot.seat === seat && slot.slot === number);
  const frame = new Uint8Array(width * height * 4);
  frame.fill(120);
  const crop = config.crop;
  const x = Math.round((crop.x + region.x * crop.width / profile.width) * width);
  const y = Math.round((crop.y + region.y * crop.height / profile.height) * height);
  const halfW = Math.round(region.w * crop.width * width / profile.width / 2) + 3;
  const halfH = Math.round(region.h * crop.height * height / profile.height / 2) + 3;
  function gray(col, row, value) {
    const offset = (row * width + col) * 4;
    frame.fill(value, offset, offset + 3);
  }
  for (let dy = -halfH; dy <= halfH; dy++) {
    for (let dx = -halfW; dx <= halfW; dx++) gray(x + dx, y + dy, invert ? 10 : 245);
  }
  const rank = publicRank ?? 'A';
  const rows = publicRank ? profile.fallbackTemplates[rank][0] : profile.templates[rank][0];
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < 16; dx++) {
      if (row & (1 << (15 - dx))) gray(x + dx - 8, y + dy - 10, invert ? 238 : 17);
    }
  });
  return { frame, region, rank };
}

function assertCard(harness, config, width, height, seat, invert = false, publicRank = null, number = 1) {
  const { frame, region, rank } = cardFrame(harness, config, width, height, seat, invert, publicRank, number);
  harness.frame(width, height, frame);
  assert.equal(harness.received.at(-1).events.length, 0, 'unstable frame must not emit an event');
  harness.frame(width, height, frame);
  if (publicRank) {
    assert.equal(harness.received.at(-1).events.length, 0, 'public match requires a third frame');
    harness.frame(width, height, frame);
  }
  assert.deepEqual(harness.received.at(-1).events.map(event => [event.seat, event.slot, event.rank]), [[seat, number, rank]],
    `synthetic glyph: ${JSON.stringify(region)} ${JSON.stringify(harness.received.at(-1).diagnostics)}`);
  assert.equal(harness.received.at(-1).events[0].templateSource, publicRank ? 'fallback' : undefined);
  assert.equal(harness.received.at(-1).diagnostics.opening.length, config.seatCount ?? 7);
  return harness.received.at(-1).events[0];
}

function createLayout(harness, config) {
  const { api } = harness;
  ok(api.newLayout(config.name), 'new layout');
  if (config.seatCount) ok(api.setLayoutSeatCount(config.seatCount), 'set custom seat count');
  if (config.publicGlyphs) ok(api.setLayoutPublicGlyphs(true), 'enable public model for the current layout');
  let state = api.layoutStatus(config.crop);
  const id = state.id;
  assert.equal(state.builtin, false);
  assert.equal(state.seatCount, config.seatCount ?? 7);
  assert.equal(state.canStart, false);
  assert.deepEqual(clone(state.seats), []);
  assert.deepEqual(clone(api.getGuide(config.crop)), []);
  rejected(api.setCrop(config.crop), 'unconfigured custom layout cannot start');
  const [first, ...rest] = config.points;
  ok(api.setSeatAnchor(first[0], first[2], first[1], config.crop), 'place dealer first');
  assert.equal(api.layoutStatus(config.crop).canStart, false, 'dealer only must not start');
  for (const [seat, slot, point] of rest) {
    ok(api.setSeatAnchor(seat, point, slot, config.crop), `place ${seat}:${slot}`);
  }
  state = api.layoutStatus(config.crop);
  assert.equal(state.canStart, true);
  assert.equal(state.canSave, true);
  assert.equal(state.name, config.name);
  assert.ok(state.seats.some(row => row.seat > 0 && row.points.includes(1)));
  assertGuides(api, config);
  ok(api.setCrop(config.crop), 'start custom capture');
  assertProfile(harness.profiles.at(-1), config);
  assert.equal(Boolean(harness.profiles.at(-1).fallbackTemplates), Boolean(config.publicGlyphs));
  ok(api.saveLayout(config.name, config.crop), 'persist custom layout');
  const saved = api.layoutStatus(config.crop);
  assert.equal(saved.dirty, false);
  assert.ok(saved.id ?? id, 'custom layout has no ID');
  return saved.id ?? id;
}

const first = createHarness();
const observer = require(path.join(dist, 'observer-core.js'));
if (typeof first.api.newLayout !== 'function') {
  console.log('Named capture API not present yet.');
  process.exit(2);
}
first.open(1600, 900, 'Synthetic window 1');
const aId = createLayout(first, a);
const publicCard = assertCard(first, a, 1600, 900, 1, false, '3');
const observed = observer.apply(observer.create(), { ...publicCard, type: 'card', source: 'auto' });
assert.equal(observer.rows(observed)[0].templateSource, 'fallback');
const corrected = observer.apply(observed, { type: 'card', source: 'manual', seat: 1, slot: 1, rank: '5' });
assert.equal(observer.rows(corrected)[0].templateSource, undefined);
assert.equal(first.reads.length, 3);
assert.equal(first.released, 3);
first.open(900, 1600, 'Synthetic portrait 1');
const bId = createLayout(first, b);
assert.notEqual(aId, bId);
assertCard(first, b, 900, 1600, 9, true);
assert.equal(first.reads.length, 5);
assert.equal(first.released, 5);

const second = createHarness();
const available = clone(second.api.listLayouts());
assert.ok(available.some(layout => layout.id === aId && layout.name === a.name));
assert.ok(available.some(layout => layout.id === bId && layout.name === b.name));
assert.ok(available.some(layout => layout.builtin));
second.open(1280, 720, 'Synthetic window 2');
ok(second.api.selectLayout(aId), 'restore first layout in new instance');
assert.equal(second.api.layoutStatus().publicGlyphs, true);
assert.deepEqual(clone(second.api.getCrop()), a.crop);
assertGuides(second.api, a);
ok(second.api.setCrop(second.api.getCrop()), 'start restored layout');
assertProfile(second.profiles.at(-1), a);
assertCard(second, a, 1280, 720, 1);
assert.equal(second.released, 2);
assert.equal(second.reads.length, 2);
second.open(720, 1280, 'Synthetic portrait 2');
ok(second.api.selectLayout(bId), 'restore differently shaped layout');
const portrait = second.api.layoutStatus();
assert.equal(portrait.seatCount, 9);
assert.equal(portrait.publicGlyphs, false);
assert.equal(portrait.seats.find(row => row.seat === 9).invert, true);
assert.deepEqual(clone(second.api.getCrop()), b.crop);
assertGuides(second.api, b);
ok(second.api.setCrop(second.api.getCrop()), 'start restored alternate layout');
assertProfile(second.profiles.at(-1), b);
const inverted = assertCard(second, b, 720, 1280, 9, true);
const ledger = observer.apply(observer.create(), { ...inverted, type: 'card', source: 'auto' });
const forecast = observer.forecast(ledger, {}, { seatCount: 9 });
assert.equal(forecast.seats.length, 9);
assert.deepEqual(forecast.seats.find(row => row.seat === 9).hands[0].cards, ['A']);
rejected(second.api.removeSeatAnchor(2, 2), 'active capture geometry must remain immutable');
second.api.beginAlignment();
ok(second.api.removeSeatAnchor(2, 2), 'remove optional second anchor');
assert.equal(second.api.layoutStatus(b.crop).canStart, true);
assert.ok(!second.api.layoutStatus(b.crop).seats.find(row => row.seat === 2).points.includes(2));
ok(second.api.removeSeatAnchor(0, 1), 'remove necessary dealer anchor');
assert.equal(second.api.layoutStatus(b.crop).canStart, false);
rejected(second.api.setCrop(b.crop), 'layout without dealer cannot restart');

const reference = createHarness();
reference.open(2332, 1308, 'Classic close capture');
const full = { x: 0, y: 0, width: 1, height: 1 };
const wideCrop = { x: 0.01, y: 0.02, width: 0.98, height: 0.96 };
ok(reference.api.selectLayout('classic'), 'choose original Classic layout');
ok(reference.api.setCrop(wideCrop), 'save original Classic crop');
reference.api.beginAlignment();
ok(reference.api.selectLayout('classic-close'), 'choose close Classic layout');
assert.equal(reference.api.getCrop(), null, 'close preset must not inherit the wide crop');
ok(reference.api.setCrop(full), 'apply close reference');
const closeDealer = reference.profiles.at(-1).slots.find(slot => slot.seat === 0 && slot.slot === 1);
near(closeDealer.variants[0].x / reference.profiles.at(-1).width, 1306 / 2332, 'initial position for moving dealer card');
const restored = createHarness();
restored.open(2332, 1308, 'Restarted Classic capture');
assert.equal(restored.api.layoutStatus().id, 'classic-close');
assert.deepEqual(clone(restored.api.getCrop()), full);
ok(restored.api.selectLayout('classic'), 'return to original Classic layout');
assert.deepEqual(clone(restored.api.getCrop()), wideCrop);

const front = createHarness();
front.open(2330, 1306, 'Classic full-table capture');
ok(front.api.selectLayout('classic-front'), 'select the full-table preset');
assert.equal(front.api.getCrop(), null, 'the full-table preset must not inherit a saved crop');
front.frame(2330, 1306);
assert.equal(front.received.length, 1, 'preview receives a captured frame');
assert.equal(front.reads.length, 0, 'preview alone must not report a processed recognition frame');
ok(front.api.setCrop(full), 'apply the entire window for full-table capture');
assert.equal(front.api.getGuide().length, 8, 'all seven opening seats and the dealer can be scanned');
front.frame(2330, 1306);
assert.equal(front.reads.length, 1, 'the selected crop starts actual recognition');
const frontRestored = createHarness();
frontRestored.open(2330, 1306, 'Restarted full-table capture');
assert.equal(frontRestored.api.layoutStatus().id, 'classic-front');
assert.deepEqual(clone(frontRestored.api.getCrop()), full);
ok(frontRestored.api.selectLayout('classic'), 'switch back to the original wide preset');
assert.deepEqual(clone(frontRestored.api.getCrop()), wideCrop);

const rollover = createHarness();
const rolloverLayout = { name: 'Synthetic rollover', crop: full, points: [
  [0, 1, { x: 0.58, y: 0.56, width: 0.07, height: 0.08 }],
  [1, 1, { x: 0.76, y: 0.76, width: 0.07, height: 0.08 }],
  [1, 2, { x: 0.76, y: 0.64 }],
  [1, 3, { x: 0.76, y: 0.52 }],
  [2, 1, { x: 0.28, y: 0.75, width: 0.07, height: 0.08 }],
] };
rollover.open(600, 400, 'Synthetic rollover window');
createLayout(rollover, rolloverLayout);
assertCard(rollover, rolloverLayout, 600, 400, 0);
assertCard(rollover, rolloverLayout, 600, 400, 1);
const emptyFrame = new Uint8Array(600 * 400 * 4).fill(55);
const unreadFrame = emptyFrame.slice();
for (let y = 283; y <= 317; y++) unreadFrame.fill(245, (y * 600 + 145) * 4, (y * 600 + 192) * 4);
for (let i = 0; i < 22; i++) rollover.frame(600, 400, unreadFrame);
assert.equal(rollover.received.some(frame => frame.roundClear), false, 'unread card elsewhere on the table prevents auto clear');
for (let i = 0; i < 8; i++) rollover.frame(600, 400, emptyFrame);
rollover.frame(600, 400, emptyFrame, 700);
assert.equal(rollover.received.some(frame => frame.roundClear), false, 'capture gap must break a clear streak');
for (let i = 0; i < 20; i++) rollover.frame(600, 400, emptyFrame);
assert.equal(rollover.received.filter(frame => frame.roundClear).length, 1, 'advance after clearing even when dealer hole was missed');
assertCard(rollover, rolloverLayout, 600, 400, 1);

const beforeSplit = rollover.received.length;
rollover.api.lock(1, 2);
rollover.api.suppressSeat(1);
const splitHit = cardFrame(rollover, rolloverLayout, 600, 400, 1, false, null, 3).frame;
for (let i = 0; i < 4; i++) rollover.frame(600, 400, splitHit);
rollover.api.unsuppressSeat(1);
const retainedCard = cardFrame(rollover, rolloverLayout, 600, 400, 1, false, null, 2).frame;
for (let i = 0; i < 4; i++) rollover.frame(600, 400, retainedCard);
assert.deepEqual(rollover.received.slice(beforeSplit).flatMap(frame => frame.events), [], 'split stays manual and undo retains prior locks');
assertCard(rollover, rolloverLayout, 600, 400, 1, false, null, 3);

const moving = createHarness();
const width = 2328, height = 1302;
moving.open(width, height, 'Classic close seat relocation');
ok(moving.api.selectLayout('classic-close'), 'enable automatic seat relocation');
ok(moving.api.setCrop(full), 'start relocation without manual anchors');
const movingProfile = moving.profiles.at(-1);
const clean = new Uint8Array(width * height * 4).fill(55);

function shiftedCards(positions) {
  const frame = clean.slice();
  for (const [seat, shiftX, shiftY] of positions) {
    const slot = movingProfile.slots.find(item => item.seat === seat && item.slot === 1);
    const x = Math.round(slot.x + shiftX), y = Math.round(slot.y + shiftY);
    const glyph = movingProfile.templates.A[0];
    const determinant = 1 - slot.u * slot.v;
    for (let row = -24; row <= 24; row++) {
      for (let col = -28; col <= 28; col++) {
        const dx = Math.round((col - slot.v * row) / determinant) + 8;
        const dy = Math.round((row - slot.u * col) / determinant) + 10;
        const ink = dx >= 0 && dx < 16 && dy >= 0 && dy < 20 && (glyph[dy] & (1 << (15 - dx)));
        const index = ((y + row) * width + x + col) * 4;
        frame.fill(ink ? 18 : 245, index, index + 3);
      }
    }
  }
  return frame;
}

const firstMoved = shiftedCards([[4, 25, 16], [5, -21, 16]]);
for (let i = 0; i < 7; i++) moving.frame(width, height, firstMoved);
const firstGuide = moving.api.getGuide().find(box => box.seat === 4);
assert.equal(firstGuide.tracked, true, 'guide follows the observed opening card');
assert.deepEqual(moving.received.flatMap(frame => frame.events).map(event => event.seat).sort(), [4, 5]);

moving.api.nextRound();
assert.equal(moving.statuses.at(-1).state, 'waiting', 'manual advance waits while old cards are visible');
moving.api.restoreRound();
assert.equal(moving.statuses.at(-1).state, 'capturing', 'undo resumes the current physical round');
assert.deepEqual(moving.api.getGuide().find(box => box.seat === 4), firstGuide, 'undo preserves measured opening positions');

const markedFelt = clean.slice();
const nominal = movingProfile.slots.find(slot => slot.seat === 4 && slot.slot === 1);
for (let y = Math.round(nominal.y) - 5; y <= Math.round(nominal.y) + 5; y++) {
  const center = y * width + Math.round(nominal.x);
  markedFelt.fill(245, (center - 23) * 4, (center + 24) * 4);
}
for (let i = 0; i < 22; i++) moving.frame(width, height, markedFelt);
assert.equal(moving.received.filter(frame => frame.roundClear).length, 1);
assert.equal(moving.api.getGuide().some(box => box.tracked), false, 'clear removes last round’s positions');
const nextFrameIndex = moving.received.length;
const nextMoved = shiftedCards([[4, -23, 19]]);
for (let i = 0; i < 7; i++) moving.frame(width, height, nextMoved);
const nextGuide = moving.api.getGuide().find(box => box.seat === 4);
assert.equal(nextGuide.tracked, true, 'next round reacquires a shifted opening card');
assert.ok(firstGuide.x - nextGuide.x > 35 / width, 'new location differs from last round');
assert.deepEqual(moving.received.slice(nextFrameIndex).flatMap(frame => frame.events)
  .map(event => [event.seat, event.slot, event.rank]), [[4, 1, 'A']]);

const dealer = createHarness();
dealer.open(width, height, 'Classic close dealer reveal');
ok(dealer.api.selectLayout('classic-close'), 'select dealer reveal layout');
ok(dealer.api.setCrop(full), 'start dealer reveal capture');
const dealerProfile = dealer.profiles.at(-1);
const upcard = dealerProfile.slots.find(slot => slot.seat === 0 && slot.slot === 1);
const hole = dealerProfile.slots.find(slot => slot.seat === 0 && slot.slot === 2);
const revealView = hole.variants.find(view => view.holeReveal && !view.pairedOnly);
assert.ok(revealView, 'close capture has a guarded dealer reveal view');
const up = { x: Math.round(upcard.x), y: Math.round(upcard.y) };
const corner = { x: Math.round(revealView.x), y: Math.round(revealView.y) + 1 };

function paintDealer(frame, x, y, w, h, tone) {
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const index = ((y + row) * width + x + col) * 4;
      frame.fill(tone(col, row), index, index + 3);
    }
  }
}

function paintDealerGlyph(frame, { x, y }, glyph, w, h, upsideDown = false) {
  paintDealer(frame, x - Math.floor(w / 2), y - Math.floor(h / 2), w, h, (col, row) => {
    const gx = Math.floor((upsideDown ? w - 1 - col : col) * 16 / w);
    const gy = Math.floor((upsideDown ? h - 1 - row : row) * 20 / h);
    return glyph[gy] & (1 << (15 - gx)) ? 18 : 245;
  });
}

function paintDealerRank(frame, center, letter, w, h, upsideDown) {
  paintDealerGlyph(frame, center, dealerProfile.templates[letter][0], w, h, upsideDown);
}

function paintDealerUpcard(frame, { x, y }) {
  paintDealer(frame, x - 15, y - 12, 75, 51, () => 245);
  // Use the same index mask at both ends of a card. The upper-left reads as 9.
  paintDealerRank(frame, { x, y }, '6', 18, 14, true);
}

function paintDealerBack(frame, x, y) {
  paintDealer(frame, x, y, 70, 48, (col, row) =>
    col < 2 || col >= 68 || row < 2 || row >= 46 ? 226 : 115 + (col + row) % 3 * 12);
}

function readDealerFrames(frame, count) {
  const start = dealer.received.length;
  for (let i = 0; i < count; i++) dealer.frame(width, height, frame, 70);
  return dealer.received.slice(start).flatMap(read => read.events).map(event => [event.seat, event.slot, event.rank]);
}

const players = shiftedCards([[4, 0, 0]]);
const faceDown = players.slice();
paintDealerUpcard(faceDown, up);
paintDealerBack(faceDown, corner.x - 11, up.y - 12);
const openings = [[0, 1, '9'], [4, 1, 'A']];
assert.deepEqual(readDealerFrames(faceDown, 8), openings, 'a card back must not emit a rank');

const crossing = players.slice();
const slid = { x: corner.x - 48, y: corner.y - 28 };
paintDealerUpcard(crossing, slid);
paintDealerBack(crossing, slid.x + 60, slid.y - 12);
paintDealerRank(crossing, corner, '6', 16, 20);
assert.deepEqual(readDealerFrames(crossing, 8), [], 'the moving upcard’s opposite index must not fill slot 2');

const pairedReveal = hole.variants.find(view => view.holeReveal && view.pairedOnly);
assert.ok(pairedReveal, 'close capture has a paired dealer reveal view');
// The left three columns and the right ten columns of this public ten
// are its separate 1 and 0. Hold each half in the reveal zone long enough
// that a mistaken match would get confirmed before painting both digits.
const ten = dealerProfile.templates['10'].find(rows => rows[0] === 496 && rows[1] === 58360);
assert.ok(ten, 'a public ten with separated digit columns is available');
const tenCorner = { x: Math.round(pairedReveal.x), y: Math.round(pairedReveal.y) };
function paintDealerTen(mask, upright = true) {
  const frame = faceDown.slice();
  const { x, y } = tenCorner;
  paintDealer(frame, x - (upright ? 26 : 68), y - (upright ? 22 : 53), 86, 65, () => 245);
  paintDealerGlyph(frame, tenCorner, ten.map(row => row & mask), 24, 16);
  return frame;
}
assert.deepEqual(readDealerFrames(paintDealerTen(0xffff, false), 8), [], 'a pair with the card face above it must not fill the dealer hole');
assert.deepEqual(readDealerFrames(paintDealerTen(0xfc00), 8), [], 'a lone 1 must not fill the dealer hole');
assert.deepEqual(readDealerFrames(paintDealerTen(0x03ff), 8), [], 'a lone 0 must not fill the dealer hole');
assert.deepEqual(readDealerFrames(paintDealerTen(0xffff), 14), [[0, 2, '10']], 'the complete dealer ten emits exactly once');

assert.deepEqual(readDealerFrames(clean, 22), [], 'clearing the felt must not emit cards');
assert.equal(dealer.received.filter(frame => frame.roundClear).length, 1, 'dealer reveal must still allow automatic round rollover');
assert.deepEqual(readDealerFrames(faceDown, 8), openings, 'the next round reacquires both opening cards');

const faceUp = faceDown.slice();
paintDealer(faceUp, up.x - 13, up.y - 9, 26, 18, () => 148);
paintDealer(faceUp, corner.x - 12, corner.y - 14, 72, 47, () => 245);
paintDealerRank(faceUp, corner, 'J', 16, 20);
assert.deepEqual(readDealerFrames(faceUp, 14), [[0, 2, 'J']], 'the revealed card is recognized once with its upcard index occluded');

console.log('Named capture layouts passed VM integration for landscape and 9-seat portrait windows at two sizes each.');
