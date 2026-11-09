'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { defaultExecutable, probe, recognize } = require('./benchmark');
const { createProjection, loadProfile } = require('./evaluate-heldout');
const recognition = require('../dist/recognition-engine');

const usage = `Usage: node recognition/train-video.js --video <local-training-video> --truth <training-labels.json> --profile <profile.json> --output <new-profile.json>
Optional: --settle-ms <nonnegative> (80), --max-per-rank <1..100> (12), --ffmpeg <exe>, --ffprobe <exe>
Labels use {events:[{round,seat,hand?,slot,rank,time,initial?,sampleTime?}],roundStarts?:[{round,time}]}.
Dealer is seat 0. Player seats increase right to left without renumbering empty positions. Slots start at 1.
The primary hand is 0. The second split hand (1) is reported as unsupported and is not sampled.
Times are seconds relative to the first decoded presentation timestamp. The output keeps training clip SHA-256 hashes.
Use a separate source clip and truth file for evaluation.`;
const rankPattern = /^(?:A|[2-9]|10|J|Q|K)$/;

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function json(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function parseTruth(truth) {
  if (typeof truth?.role === 'string' && /^(?:holdout|test|evaluation)$/i.test(truth.role)) {
    throw new Error('The supplied truth is marked as evaluation data. Supply training labels only.');
  }
  let raw = Array.isArray(truth) ? truth : truth?.events;
  if (!raw && Array.isArray(truth?.initial) && Array.isArray(truth?.newCards)) {
    raw = [...truth.initial.map(row => ({ ...row, initial: true })), ...truth.newCards];
  }
  if (!Array.isArray(raw) || !raw.length) throw new Error('Training truth must contain at least one labeled event.');

  const starts = new Map();
  if (truth.roundStarts != null && !Array.isArray(truth.roundStarts)) throw new Error('roundStarts must be an array.');
  for (const { round, time } of truth.roundStarts ?? []) {
    if (!Number.isInteger(round) || round < 1 || !Number.isFinite(time) || time < 0 || starts.has(round)) {
      throw new Error('Invalid or duplicate round start.');
    }
    starts.set(round, time);
  }
  const keys = new Set();
  const rows = raw.map((row, index) => {
    const { round = 1, seat, hand = 0, slot, sampleTime } = row ?? {};
    const rank = String(row?.rank).trim().toUpperCase().replace(/^T$/, '10');
    const time = row?.time ?? (row?.initial ? 0 : undefined);
    const label = `Training label ${index + 1}`;
    if (!Number.isInteger(round) || round < 1 || !Number.isInteger(seat) || seat < 0 || seat > 9 ||
        ![0, 1].includes(hand) || (seat === 0 && hand !== 0) || !Number.isInteger(slot) || slot < 1 || slot > 21 ||
        !rankPattern.test(rank) || !Number.isFinite(time) || time < 0 ||
        (sampleTime != null && (!Number.isFinite(sampleTime) || sampleTime < time))) {
      throw new Error(`${label} has invalid round, seat, hand, slot, rank or time.`);
    }
    const key = `${round}:${seat}:${hand}:${slot}`;
    if (keys.has(key)) throw new Error(`${label} duplicates round/seat/hand/slot ${key}.`);
    keys.add(key);
    if (time < (starts.get(round) ?? 0) || time >= (starts.get(round + 1) ?? Infinity)) {
      throw new Error(`${label} falls outside its annotated round.`);
    }
    return { round, seat, hand, slot, rank, time, sampleTime, initial: Boolean(row?.initial) };
  }).sort((a, b) => a.time - b.time || a.round - b.round || a.seat - b.seat || a.hand - b.hand || a.slot - b.slot);
  return { rows, starts };
}

function lowerBound(values, target) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (values[middle] < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function scheduleSamples(labels, slots, timestamps, settleSeconds, missed) {
  const byFrame = new Map();
  const supported = new Set(slots.map(slot => `${slot.seat}:${slot.slot}`));
  for (const row of labels.rows) {
    if (row.hand !== 0 || !supported.has(`${row.seat}:${row.slot}`)) {
      missed(row, row.hand !== 0 ? 'split-hand-not-mapped' : 'position-not-calibrated');
      continue;
    }
    const nextAtSeat = labels.rows.find(candidate => candidate.time > row.time &&
      candidate.round === row.round && candidate.seat === row.seat && candidate.hand === row.hand)?.time ?? Infinity;
    const nextRound = labels.starts.get(row.round + 1) ?? labels.rows.find(candidate => candidate.round > row.round)?.time ?? Infinity;
    const expires = row.sampleTime == null ? Math.min(nextRound, nextAtSeat) : nextRound;
    const preferred = row.sampleTime ?? row.time + settleSeconds;
    let index = lowerBound(timestamps, preferred - 1e-9);
    if (row.sampleTime == null && (index >= timestamps.length || timestamps[index] >= expires)) {
      index = lowerBound(timestamps, row.time - 1e-9);
    }
    if (index >= timestamps.length || timestamps[index] >= expires) {
      missed(row, 'no-frame-in-sample-window');
      continue;
    }
    const group = byFrame.get(index) ?? [];
    group.push(row);
    byFrame.set(index, group);
  }
  return byFrame;
}

function tallyPosition(rows) {
  return rows.reduce((counts, row) => {
    counts[row.seat] = (counts[row.seat] ?? 0) + 1;
    return counts;
  }, {});
}

async function train({ video, truth, profile, output, settleMs, limit, ffmpeg, ffprobe }) {
  const [rawTruth, rawProfile, metadata, videoSha256] = await Promise.all([
    fs.readFile(truth, 'utf8'), fs.readFile(profile, 'utf8'), probe(video, ffprobe), hashFile(video),
  ]);
  const labels = parseTruth(json(rawTruth));
  const supplied = loadProfile(json(rawProfile));
  // Calibrated views only. Disable shifted search to avoid extracting a neighbor's glyph.
  // A live sampler also preserves both components of the 10 glyph.
  const sampleProfile = { ...supplied, liveSearch: { ...supplied.liveSearch, offsets: [] } };
  const sampler = recognition.create(sampleProfile);
  const validator = recognition.create(sampleProfile);
  const project = createProjection(supplied, sampler.crop, metadata.width, metadata.height);
  const timestamps = metadata.pts.map(pts => pts - metadata.pts[0]);
  const skipped = [];
  const missed = (row, reason) => skipped.push({ round: row.round, seat: row.seat, hand: row.hand, slot: row.slot, rank: row.rank, reason });
  const plan = scheduleSamples(labels, supplied.slots, timestamps, settleMs / 1000, missed);
  const samples = [];
  const addedByRank = {};
  const templates = { ...supplied.templates };
  let frameIndex = 0;

  await recognize(video, ffmpeg, metadata, { read(frame, seconds) {
    const index = frameIndex++;
    const group = plan.get(index);
    if (!group) return { events: [] };
    const cropped = project(frame);
    for (const row of group) {
      const rows = sampler.sampleGlyph(cropped, row.seat, row.slot, row.rank);
      if (!rows) {
        missed(row, 'no-clear-glyph');
        continue;
      }
      const existing = templates[row.rank] ?? [];
      if (existing.some(sample => sample.every((bits, i) => bits === rows[i]))) {
        missed(row, 'duplicate-template');
        continue;
      }
      if ((addedByRank[row.rank] ?? 0) >= limit) {
        missed(row, 'rank-limit');
        continue;
      }
      if (!validator.addTemplate(row.rank, rows)) {
        missed(row, 'invalid-template');
        continue;
      }
      templates[row.rank] = [...existing, rows];
      addedByRank[row.rank] = (addedByRank[row.rank] ?? 0) + 1;
      samples.push({ round: row.round, seat: row.seat, hand: row.hand, slot: row.slot, rank: row.rank,
        labelTime: row.time, sampleTime: seconds, sourcePts: metadata.pts[index], frameIndex: index });
    }
    return { events: [] };
  } });

  const report = {
    videoSha256,
    truthSha256: createHash('sha256').update(rawTruth).digest('hex'),
    width: metadata.width,
    height: metadata.height,
    firstPts: metadata.pts[0],
    frameCount: timestamps.length,
    timeBasis: 'FFmpeg presentation seconds relative to the first decoded frame',
    settleMs,
    labels: labels.rows.length,
    added: samples.length,
    addedByRank,
    addedBySeat: tallyPosition(samples),
    samples,
    skipped,
  };
  const previousClips = Array.isArray(supplied.training?.clips) ? supplied.training.clips : [];
  const result = { ...supplied, templates, training: { version: 1, clips: [...previousClips, report] } };
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return { output, ...report, skipped: skipped.reduce((counts, row) => ({ ...counts, [row.reason]: (counts[row.reason] ?? 0) + 1 }), {}), samples: undefined };
}

async function main() {
  const { values } = parseArgs({ options: {
    video: { type: 'string' }, truth: { type: 'string' }, profile: { type: 'string' }, output: { type: 'string' },
    'settle-ms': { type: 'string', default: '80' }, 'max-per-rank': { type: 'string', default: '12' },
    ffmpeg: { type: 'string' }, ffprobe: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return console.log(usage);
  if (!values.video || !values.truth || !values.profile || !values.output) throw new Error(usage);
  const inputs = Object.fromEntries(['video', 'truth', 'profile', 'output'].map(key => [key, path.resolve(values[key])]));
  const settleMs = Number(values['settle-ms']);
  const limit = Number(values['max-per-rank']);
  if (!Number.isFinite(settleMs) || settleMs < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid settle time or per-rank sample limit.');
  }
  const files = await Promise.all(['video', 'truth', 'profile'].map(key => fs.stat(inputs[key])));
  if (files.some(info => !info.isFile())) throw new Error('Training video, truth and profile must be local files.');
  if (await fs.access(inputs.output).then(() => true, () => false)) throw new Error('Output already exists. Choose a new filename.');
  const report = await train({ ...inputs, settleMs, limit,
    ffmpeg: values.ffmpeg ?? defaultExecutable('ffmpeg'), ffprobe: values.ffprobe ?? defaultExecutable('ffprobe') });
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseTruth, scheduleSamples, train };
