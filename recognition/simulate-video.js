'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { defaultExecutable, probe, recognize } = require('./benchmark');
const recognition = require('../dist/recognition-engine');
const replay = require('../dist/recognition-profile');
const { forCapture } = require('../dist/live-recognition-profile');
const { augment } = require('../dist/glyph-bank');

const slotKey = card => card.seat + ':' + card.slot;

function evaluate(events, expected) {
  const matched = new Set();
  const falseDetections = [];
  for (const event of events) {
    const key = slotKey(event);
    const target = expected.get(key);
    if (target?.rank === event.rank && event.frameIndex >= target.frame && !matched.has(key)) matched.add(key);
    else falseDetections.push({ seat: event.seat, slot: event.slot, rank: event.rank, time: event.detectedAt });
  }
  return {
    matched: matched.size,
    misses: [...expected].filter(([key]) => !matched.has(key)).map(([, { seat, slot, rank }]) => ({ seat, slot, rank })),
    falseDetections,
  };
}

async function main() {
  const { values } = parseArgs({ options: { ffmpeg: { type: 'string' }, ffprobe: { type: 'string' } } });
  const ffmpeg = values.ffmpeg ?? defaultExecutable('ffmpeg');
  const ffprobe = values.ffprobe ?? defaultExecutable('ffprobe');
  const video = path.join(__dirname, 'synthetic-seven-seat.webm');
  const truth = JSON.parse(await readFile(path.join(__dirname, 'synthetic-seven-seat-truth.json'), 'utf8'));
  const metadata = await probe(video, ffprobe);
  const profile = forCapture(replay, augment);
  if (metadata.pts.length !== truth.frames || metadata.width !== profile.width || metadata.height !== profile.height) {
    throw new Error('Synthetic video and truth do not match the recognition geometry or frame count.');
  }

  const supported = new Set(profile.slots.map(slotKey));
  const testRound = truth.rounds.at(-1);
  const testCards = truth.events.filter(card => card.round === testRound.round);
  const expected = new Map(testCards.filter(card => supported.has(slotKey(card))).map(card => [slotKey(card), card]));
  const unsupported = testCards.filter(card => !supported.has(slotKey(card)));
  const trainingByFrame = new Map(truth.events.filter(card => card.round < testRound.round && supported.has(slotKey(card)))
    .map(card => [card.frame + 2, card]));
  const baseline = recognition.create(profile);
  const trained = recognition.create(profile);
  const sampleCounts = {};
  const baselineEvents = [];
  let index = 0;
  const result = await recognize(video, ffmpeg, metadata, { read(frame, seconds) {
    const frameIndex = index++;
    const card = trainingByFrame.get(frameIndex);
    if (card) {
      const rows = trained.sampleGlyph(frame, card.seat, card.slot, card.rank);
      if (rows && trained.addTemplate(card.rank, rows)) sampleCounts[card.rank] = (sampleCounts[card.rank] ?? 0) + 1;
    }
    if (frameIndex < testRound.startFrame) return { events: [] };
    for (const event of baseline.read(frame, seconds).events) {
      baselineEvents.push({ ...event, frameIndex, detectedAt: seconds });
    }
    return trained.read(frame, seconds);
  }});
  console.log(JSON.stringify({
    frames: index,
    trainingRounds: truth.rounds.length - 1,
    sampleCounts,
    evaluatedRound: testRound.round,
    expected: expected.size,
    unsupported: unsupported.map(({ seat, slot, rank }) => ({ seat, slot, rank })),
    baseline: evaluate(baselineEvents, expected),
    trained: evaluate(result.events, expected),
  }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
