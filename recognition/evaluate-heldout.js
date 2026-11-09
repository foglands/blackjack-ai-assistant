'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { performance } = require('node:perf_hooks');
const { defaultExecutable, distribution, probe, recognize } = require('./benchmark');
const capture = require('../dist/live-capture');
const recognition = require('../dist/recognition-engine');
const observer = require('../dist/observer-core');

const usage = 'Usage: node recognition/evaluate-heldout.js --video <local video> --profile <runtime profile.json> --truth <annotations.json> [--round-mode auto|annotated|single] [--sample-ms 48] [--from seconds] [--to seconds] [--csv <new file>] [--json]';
const fullFrame = { x: 0, y: 0, width: 1, height: 1 };

function printHelp() {
  console.log(usage);
  console.log('Profile JSON is flat: {width,height,slots,templates,liveSearch?,fallbackTemplates?,sourceRect?}.');
  console.log('sourceRect is normalized {x,y,width,height} within the source video. The default is the whole frame.');
  console.log('Truth JSON: {events:[{round,seat,hand?,slot,rank,time,initial?}],roundStarts?:[{round,time}]}.');
  console.log('Use elapsed source PTS in seconds and fixed IDs. Dealer is 0, player seats are 1–9, hand defaults to 0, and slots begin at 1.');
  console.log('Add rounds:[{round,occupied:[seat,...],empty:[seat,...]}] for explicitly annotated player occupancy. Omit unobservable seats.');
  console.log('Auto mode uses observed table clearance. Annotated mode supplies round reset times. Single mode never resets.');
  console.log('Set --sample-ms 0 for every decoded frame, or --skip-decoder-baseline to omit the separate decoder-only pass.');
}

async function readJson(filename) {
  return JSON.parse((await fs.readFile(path.resolve(filename), 'utf8')).replace(/^\uFEFF/, ''));
}

async function videoHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function finite(value, label, min, max = Infinity) {
  const number = Number(value);
  if (value == null || value === '' || !Number.isFinite(number) || number < min || number > max) {
    throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
  }
  return number;
}

function integer(value, label, min, max) {
  const number = finite(value, label, min, max);
  if (!Number.isInteger(number)) throw new Error(label + ' must be an integer.');
  return number;
}

function place(row, label) {
  const round = integer(row.round ?? 1, label + ' round', 1, Number.MAX_SAFE_INTEGER);
  const seat = integer(row.seat, label + ' seat', 0, 9);
  const hand = integer(row.hand ?? 0, label + ' hand', 0, seat === 0 ? 0 : 1);
  const slot = integer(row.slot, label + ' slot', 1, 21);
  return { round, seat, hand, slot };
}

function key({ round, seat, hand, slot }) {
  return [round, seat, hand, slot].join(':');
}

function readOccupancy(rows) {
  if (!Array.isArray(rows)) throw new Error('Truth rounds must be an array.');
  const seen = new Set();
  return rows.filter(row => row.occupied != null || row.empty != null).map(row => {
    const round = integer(row.round, 'Occupancy round', 1, Number.MAX_SAFE_INTEGER);
    if (seen.has(round)) throw new Error('Duplicate occupancy for round ' + round + '.');
    seen.add(round);
    const seats = new Set();
    function playerSeats(values) {
      if (!Array.isArray(values)) throw new Error('Occupancy seat lists must be arrays.');
      return values.map(value => {
        const seat = integer(value, 'Occupancy seat', 1, 9);
        if (seats.has(seat)) throw new Error('Duplicate occupancy for round ' + round + ', seat ' + seat + '.');
        seats.add(seat);
        return seat;
      });
    }
    return { round, occupied: playerSeats(row.occupied ?? []), empty: playerSeats(row.empty ?? []) };
  });
}

function readTruth(input) {
  const rows = Array.isArray(input) ? input : input?.events;
  if (!Array.isArray(rows)) throw new Error('Truth needs an events array.');
  const occupancy = readOccupancy(input.rounds ?? []);
  if (!rows.length && !occupancy.some(row => row.empty.length)) throw new Error('Truth needs visible cards or annotated empty seats.');
  const empty = new Map(occupancy.map(row => [row.round, new Set(row.empty)]));
  const used = new Set();
  const events = rows.map((row, index) => {
    const label = 'Truth event ' + (index + 1);
    const position = place(row, label);
    const identity = key(position);
    if (used.has(identity)) throw new Error('Duplicate annotation for ' + identity + '. Use a new round or hand ID.');
    if (empty.get(position.round)?.has(position.seat)) throw new Error(label + ' is in an annotated empty seat.');
    used.add(identity);
    const rank = String(row.rank).trim().toUpperCase().replace(/^T$/, '10');
    if (!/^(?:A|[2-9]|10|J|Q|K)$/.test(rank)) throw new Error(label + ' has an invalid rank.');
    return { ...position, rank, time: finite(row.time ?? (row.initial ? 0 : null), label + ' time', 0), initial: Boolean(row.initial) };
  });
  const starts = input.roundStarts ?? (Array.isArray(input.rounds) && Number.isFinite(input.fps)
    ? input.rounds.map(row => ({ round: row.round, time: row.startFrame / input.fps }))
    : []);
  if (!Array.isArray(starts)) throw new Error('roundStarts must be an array.');
  const roundStarts = starts.map((row, index) => {
    if (row.round !== index + 1) throw new Error('roundStarts must list consecutive round IDs beginning with 1.');
    return { round: row.round, time: finite(row.time, 'Round start time', 0) };
  });
  if (roundStarts.some((row, index) => index > 0 && row.time <= roundStarts[index - 1].time)) {
    throw new Error('roundStarts must have strictly increasing times.');
  }
  return { events, roundStarts, occupancy };
}

function loadProfile(input) {
  if (!input || !Array.isArray(input.slots) || !input.slots.length || !input.templates || typeof input.templates !== 'object') {
    throw new Error('Profile requires width, height, slots and a template map.');
  }
  const width = integer(input.width, 'Profile width', 1, 8192);
  const height = integer(input.height, 'Profile height', 1, 8192);
  const seatCount = integer(input.seatCount ?? 7, 'Profile seat count', 1, 9);
  const slots = input.slots.map(row => ({
    ...row,
    seat: integer(row.seat, 'Profile seat', 0, seatCount),
    slot: integer(row.slot, 'Profile slot', 1, 21),
    x: finite(row.x, 'Profile x', 0, width - 1),
    y: finite(row.y, 'Profile y', 0, height - 1),
    w: integer(row.w, 'Profile patch width', 1, width),
    h: integer(row.h, 'Profile patch height', 1, height),
    u: finite(row.u ?? 0, 'Profile vertical shear', -3, 3),
    v: finite(row.v ?? 0, 'Profile horizontal shear', -3, 3),
  }));
  return { ...input, width, height, seatCount, slots };
}

function createProjection(profile, bounds, sourceWidth, sourceHeight) {
  const rect = profile.sourceRect ?? fullFrame;
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
      rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) {
    throw new Error('Profile sourceRect must fit inside normalized video coordinates.');
  }
  const mapped = capture.makeMap(bounds, profile, rect, sourceWidth, sourceHeight);
  const rows = Int32Array.from(mapped.rows, value => value / 4);
  const columns = Int32Array.from(mapped.columns, value => value / 4);
  const frame = { width: bounds.width, height: bounds.height, channels: 1, data: new Uint8Array(bounds.width * bounds.height) };
  return function project(source) {
    let index = 0;
    for (const row of rows) {
      for (const column of columns) frame.data[index++] = source.data[row + column];
    }
    return frame;
  };
}

function simulation(profile, metadata, options) {
  const recognizer = recognition.create(profile);
  const project = createProjection(profile, recognizer.crop, metadata.width, metadata.height);
  const timings = { extraction: [], recognition: [], ledger: [], total: [] };
  const resetEvents = [];
  let state = observer.create({ mode: 'mid' });
  let round = 1, nextSample = options.from, scanStarted = null, clearAt = null, lastSample = null, hasLockedCard = false;
  let roundIndex = 0, rejected = 0;

  function reset(seconds, reason) {
    recognizer.reset();
    scanStarted = clearAt = null;
    hasLockedCard = false;
    round++;
    state = observer.apply(state, { type: 'round', source: 'auto' });
    resetEvents.push({ round, time: seconds, reason });
  }

  function read(source, seconds) {
    if (seconds < options.from || seconds > options.to) return { events: [] };
    if (options.roundMode === 'annotated' && seconds < options.roundStarts[0].time) return { events: [] };
    if (options.sampleMs && seconds + 1e-9 < nextSample) return { events: [] };
    if (options.sampleMs) {
      const period = options.sampleMs / 1000;
      nextSample += period * (Math.floor((seconds - nextSample + 1e-9) / period) + 1);
    }
    const start = performance.now();
    const frame = project(source);
    const extracted = performance.now();
    if (options.roundMode === 'annotated') {
      while (roundIndex + 1 < options.roundStarts.length && seconds >= options.roundStarts[roundIndex + 1].time) {
        reset(seconds, 'annotated');
        roundIndex++;
      }
    }
    let scanned;
    if (lastSample === null || seconds - lastSample > capture.clearFrameGap / 1000) clearAt = null;
    lastSample = seconds;
    if (options.roundMode === 'auto' && hasLockedCard) {
      const empty = capture.isTableClear(recognizer, frame);
      clearAt = empty ? clearAt ?? seconds : null;
      if (clearAt !== null && seconds - clearAt >= capture.autoClearDuration / 1000 - 1e-9) {
        reset(seconds, 'auto');
        scanned = { events: [], processingMs: 0 };
      }
    }
    scanStarted ??= seconds;
    scanned ??= recognizer.read(frame, seconds - scanStarted);
    const recognized = performance.now();
    const events = scanned.events.map(card => {
      const event = { ...card, round, hand: card.hand ?? 0, initial: card.initial && round === 1, time: seconds };
      hasLockedCard = true;
      let ledgerAccepted = false, ledgerError = null;
      try {
        const next = observer.apply(state, { ...event, type: 'card', source: 'auto' });
        ledgerAccepted = next !== state;
        state = next;
      } catch (error) {
        ledgerError = error.message;
      }
      if (!ledgerAccepted) rejected++;
      return { ...event, ledgerAccepted, ...(ledgerError ? { ledgerError } : {}) };
    });
    if (events.some(event => event.ledgerAccepted)) observer.forecast(state, {}, { seatCount: profile.seatCount });
    const finished = performance.now();
    timings.extraction.push(extracted - start);
    timings.recognition.push(recognized - extracted);
    timings.ledger.push(finished - recognized);
    timings.total.push(finished - start);
    return { events, processingMs: scanned.processingMs };
  }

  function metrics() {
    return {
      sampledFrames: timings.total.length,
      resetEvents,
      ledgerRejected: rejected,
      sampleRuntimeMs: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, distribution(values)])),
    };
  }
  return { read, metrics };
}

function counts(rows, earlyToleranceMs) {
  const number = status => rows.filter(row => row.status === status).length;
  const delays = rows.filter(row => row.status === 'correct').map(row => row.delayMs);
  const timely = delay => delay >= -earlyToleranceMs;
  const correct = number('correct'), wrong = number('wrong-rank'), missed = number('missed');
  const extra = number('extra'), duplicates = number('duplicate');
  return {
    expected: correct + wrong + missed, detected: correct + wrong + extra + duplicates,
    correct, wrong, missed, extra, duplicates,
    earlyBeyondTolerance: delays.filter(delay => !timely(delay)).length,
    emptySeatFalsePositives: rows.filter(row => row.annotatedEmptySeat).length,
    confirmationDelayMs: distribution(delays.filter(timely)),
    newConfirmationDelayMs: distribution(rows.filter(row => row.status === 'correct' && row.phase === 'new' && timely(row.delayMs))
      .map(row => row.delayMs)),
  };
}

function comparePositions(truth, detections, { seatCount = 7, earlyToleranceMs = 67, occupancy = [], openingSeats } = {}) {
  const expected = new Map(truth.map(row => [key(row), row]));
  const occupancyByRound = new Map(occupancy.map(row => [row.round, row]));
  const seen = new Set();
  const rows = [];
  for (const found of detections.slice().sort((a, b) => a.detectedAt - b.detectedAt)) {
    const position = place(found, 'Detection');
    const identity = key(position);
    const known = expected.get(identity);
    const repeated = seen.has(identity);
    const status = repeated ? 'duplicate' : !known ? 'extra' : known.rank === found.rank ? 'correct' : 'wrong-rank';
    const annotatedEmptySeat = occupancyByRound.get(position.round)?.empty.includes(position.seat) ?? false;
    seen.add(identity);
    rows.push({
      ...position, status, phase: known?.initial ? 'initial' : known ? 'new' : found.initial ? 'initial' : 'new',
      expectedRank: known?.rank ?? null, detectedRank: found.rank, readableSeconds: known?.time ?? null,
      confirmationSeconds: found.detectedAt, delayMs: known ? (found.detectedAt - known.time) * 1000 : null,
      confidence: found.confidence ?? null, templateSource: found.templateSource ?? null, annotatedEmptySeat,
    });
  }
  for (const [identity, known] of expected) {
    if (seen.has(identity)) continue;
    const { rank, time, initial, ...position } = known;
    rows.push({ ...position, status: 'missed', phase: initial ? 'initial' : 'new',
      expectedRank: rank, detectedRank: null, readableSeconds: time, confirmationSeconds: null, delayMs: null });
  }
  const maximum = occupancy.reduce((max, row) => Math.max(max, ...row.occupied, ...row.empty),
    rows.reduce((max, row) => Math.max(max, row.seat), seatCount));
  return {
    totals: counts(rows, earlyToleranceMs),
    perSeat: Array.from({ length: maximum + 1 }, (_, seat) => {
      const seatRows = rows.filter(row => row.seat === seat);
      return {
        seat,
        openingSlotMapped: openingSeats?.has(seat) ?? null,
        annotatedOccupiedRounds: occupancy.filter(row => row.occupied.includes(seat)).length,
        annotatedEmptyRounds: occupancy.filter(row => row.empty.includes(seat)).length,
        ...counts(seatRows, earlyToleranceMs),
      };
    }),
    initial: counts(rows.filter(row => row.phase === 'initial'), earlyToleranceMs),
    new: counts(rows.filter(row => row.phase === 'new'), earlyToleranceMs),
    rows,
  };
}

function encodeCsv(rows) {
  const columns = ['round', 'seat', 'hand', 'slot', 'status', 'phase', 'expectedRank', 'detectedRank',
    'readableSeconds', 'confirmationSeconds', 'delayMs', 'confidence', 'templateSource', 'annotatedEmptySeat'];
  const escape = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  return [columns, ...rows.map(row => columns.map(name => row[name]))]
    .map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}

async function measure(video, ffmpeg, metadata, detector) {
  const start = performance.now();
  const result = await recognize(video, ffmpeg, metadata, detector);
  const wallMs = performance.now() - start;
  return { ...result, wallMs, decodedFramesPerSecond: metadata.pts.length * 1000 / wallMs };
}

function print(result) {
  const { video, offline, delivered, raw } = result;
  const ms = value => value == null ? '—' : value.toFixed(2);
  console.log(video.frames + ' video frames · source ' + video.sourceFps + ' fps · round mode ' + offline.roundMode + ' · sample interval ' + offline.sampleMs + ' ms');
  console.log('Decoder + gray pipe FPS ' + ms(offline.decoderPipeFps) + ' · simulated pipeline FPS ' + ms(offline.simulationFps) +
    ' · sampled extraction + recognition + ledger/forecast p95 ' + ms(offline.sampleRuntimeMs.total?.p95) + ' ms');
  console.log('New-card delay uses recorded presentation timestamps. Opening snapshots and premature confirmations are excluded.');
  console.log('Seat  Mapped  Expected  Correct  Wrong  Missed  Extra  Duplicate  Early  Empty rounds  Empty FP  Delay n  P50 ms  P95 ms');
  for (const row of delivered.perSeat) {
    const delay = row.newConfirmationDelayMs;
    console.log([row.seat, row.openingSlotMapped ? 'yes' : 'no', row.expected, row.correct, row.wrong, row.missed, row.extra, row.duplicates,
      row.earlyBeyondTolerance, row.annotatedEmptyRounds, row.emptySeatFalsePositives,
      delay?.count ?? 0, ms(delay?.p50), ms(delay?.p95)].join('  '));
  }
  console.log('Raw detector extra ' + raw.totals.extra + ' · duplicate ' + raw.totals.duplicates +
    ' · ledger rejected ' + offline.ledgerRejected + ' · early correct > tolerance ' + delivered.totals.earlyBeyondTolerance);
}

async function main() {
  const { values } = parseArgs({ options: {
    video: { type: 'string' }, profile: { type: 'string' }, truth: { type: 'string' }, csv: { type: 'string' },
    ffmpeg: { type: 'string' }, ffprobe: { type: 'string' }, 'round-mode': { type: 'string' },
    'sample-ms': { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, 'early-ms': { type: 'string' },
    'skip-decoder-baseline': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return printHelp();
  if (!values.video || !values.profile || !values.truth) throw new Error(usage);
  const video = path.resolve(values.video);
  if (!(await fs.stat(video)).isFile()) throw new Error('The source must be a local video file.');
  const ffmpeg = values.ffmpeg ?? defaultExecutable('ffmpeg');
  const ffprobe = values.ffprobe ?? defaultExecutable('ffprobe');
  const [profile, truth, metadata, sha256] = await Promise.all([
    readJson(values.profile).then(loadProfile), readJson(values.truth).then(readTruth), probe(video, ffprobe), videoHash(video),
  ]);
  if (Array.isArray(profile.training?.clips) && profile.training.clips.some(clip => clip.videoSha256 === sha256)) {
    throw new Error('This video was used to train the selected profile. Use an independently held-out clip.');
  }
  const roundMode = values['round-mode'] ?? 'auto';
  if (!['auto', 'annotated', 'single'].includes(roundMode)) throw new Error('Invalid --round-mode.');
  if (roundMode === 'annotated' && !truth.roundStarts.length) throw new Error('Annotated round mode requires roundStarts.');
  const sampleMs = finite(values['sample-ms'] ?? 48, 'Sample interval', 0, 1000);
  const earlyToleranceMs = finite(values['early-ms'] ?? 67, 'Early tolerance', 0, 1000);
  const duration = metadata.pts.at(-1) - metadata.pts[0];
  const from = finite(values.from ?? 0, 'Evaluation start', 0, duration);
  const to = finite(values.to ?? duration, 'Evaluation end', from, duration);
  const expected = truth.events.filter(row => row.time >= from && row.time <= to);
  const labelledRounds = new Set(expected.map(row => row.round));
  const occupancy = truth.occupancy.filter(({ round }) => {
    if (from === 0 && to === duration) return true;
    const start = truth.roundStarts[round - 1]?.time;
    const end = truth.roundStarts[round]?.time ?? Infinity;
    return start != null ? start <= to && end > from : labelledRounds.has(round) || roundMode === 'single' && round === 1;
  });
  if (!expected.length && !occupancy.some(row => row.empty.length)) {
    throw new Error('No independently annotated readable cards or empty seats inside the evaluation interval.');
  }
  const decoder = values['skip-decoder-baseline'] ? null
    : await measure(video, ffmpeg, metadata, { read: () => ({ events: [] }) });
  const detector = simulation(profile, metadata, { roundMode, roundStarts: truth.roundStarts, sampleMs, from, to });
  const result = await measure(video, ffmpeg, metadata, detector);
  const openingSeats = new Set(profile.slots.filter(slot => slot.slot === 1).map(slot => slot.seat));
  const compare = { seatCount: profile.seatCount, earlyToleranceMs, occupancy, openingSeats };
  const delivered = comparePositions(expected, result.events.filter(event => event.ledgerAccepted), compare);
  const raw = comparePositions(expected, result.events, compare);
  const frameIntervals = metadata.pts.slice(1).map((pts, index) => (pts - metadata.pts[index]) * 1000);
  const report = {
    video: { frames: metadata.pts.length, width: metadata.width, height: metadata.height,
      sourceFps: metadata.avg_frame_rate, frameIntervalMs: distribution(frameIntervals), sha256,
      firstPts: metadata.pts[0], lastPts: metadata.pts.at(-1), interval: { from, to } },
    occupancy,
    offline: {
      roundMode, sampleMs, earlyToleranceMs,
      decoderPipeFps: decoder?.decodedFramesPerSecond ?? null, simulationFps: result.decodedFramesPerSecond,
      decoderWallMs: decoder?.wallMs ?? null, simulationWallMs: result.wallMs, ...detector.metrics(),
      timingBasis: 'Confirmation delay is sampled media PTS minus first readable media PTS. Local sample runtime measures extraction, recognition, ledger and forecast after gray decode. Live capture transport and browser painting are excluded.',
    },
    delivered, raw,
  };
  if (values.csv) await fs.writeFile(path.resolve(values.csv), encodeCsv(delivered.rows), { flag: 'wx' });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else print(report);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { comparePositions, createProjection, loadProfile, readTruth, simulation };
