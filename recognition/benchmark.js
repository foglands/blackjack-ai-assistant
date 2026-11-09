'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { parseArgs, promisify } = require('node:util');

const run = promisify(execFile);
const usage = 'Usage: node recognition/benchmark.js --video <clip.mp4> [--truth <truth.json>] [--csv <new-file.csv>] [--ffmpeg <exe>] [--ffprobe <exe>] [--json]';

function defaultExecutable(name) { return name; }

async function probe(video, ffprobe) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
    '-show_streams', '-show_frames', '-show_entries',
    'stream=width,height,avg_frame_rate:frame=best_effort_timestamp_time,pts_time',
    '-of', 'json', video,
  ], { windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  const { streams, frames } = JSON.parse(stdout);
  if (streams?.length !== 1 || !frames?.length) throw new Error('No decodable video frames were reported by ffprobe.');
  const pts = frames.map(frame => Number(frame.best_effort_timestamp_time ?? frame.pts_time ?? NaN));
  if (pts.some((value, index) => !Number.isFinite(value) || (index > 0 && value < pts[index - 1]))) {
    throw new Error('The video does not have usable presentation timestamps in display order.');
  }
  return { ...streams[0], pts };
}

function normalizeRow(row, label) {
  if (!row || !['string', 'number'].includes(typeof row.seat) || !['string', 'number'].includes(typeof row.slot)) {
    throw new Error(label + ' needs a seat and slot.');
  }
  const rank = String(row.rank).trim().toUpperCase().replace(/^T$/, '10');
  if (!/^(?:A|[2-9]|10|J|Q|K)$/.test(rank)) throw new Error(label + ' has an invalid rank.');
  const time = row.time == null && row.initial ? 0 : row.time;
  if (!Number.isFinite(time) || time < 0) throw new Error(label + ' needs a nonnegative time in seconds.');
  return { ...row, rank, time, initial: Boolean(row.initial) };
}

async function loadTruth(filename) {
  const parsed = JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
  let rows = Array.isArray(parsed) ? parsed : parsed?.events;
  if (!rows && Array.isArray(parsed?.initial) && Array.isArray(parsed?.newCards)) {
    rows = [
      ...parsed.initial.map(row => ({ ...row, initial: true })),
      ...parsed.newCards.map(row => ({ ...row, initial: false })),
    ];
  }
  if (!Array.isArray(rows)) throw new Error('Truth must be an event array, {events: [...]}, or {initial: [...], newCards: [...]}.');
  return rows.map((row, index) => normalizeRow(row, 'Truth row ' + (index + 1)));
}

function distribution(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  function percentile(fraction) {
    const position = fraction * (sorted.length - 1);
    const low = Math.floor(position);
    return sorted[low] + (position - low) * (sorted[Math.ceil(position)] - sorted[low]);
  }
  return { count: sorted.length, min: sorted[0], p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

async function recognize(video, ffmpeg, metadata, recognizer) {
  const { width, height, pts } = metadata;
  const frame = Buffer.allocUnsafe(width * height);
  const events = [];
  const cpu = [];
  const wall = [];
  const reported = [];
  let offset = 0;
  let frameIndex = 0;
  let stderr = '';
  const child = spawn(ffmpeg, [
    '-v', 'error', '-nostdin', '-noautorotate', '-protocol_whitelist', 'file,pipe',
    '-i', video, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-threads', '1', '-f', 'rawvideo', 'pipe:1',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8000); });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', code => resolve({ code }));
  });

  try {
    for await (const chunk of child.stdout) {
      let cursor = 0;
      while (cursor < chunk.length) {
        const length = Math.min(frame.length - offset, chunk.length - cursor);
        chunk.copy(frame, offset, cursor, cursor + length);
        offset += length;
        cursor += length;
        if (offset !== frame.length) continue;
        if (frameIndex >= pts.length) throw new Error('FFmpeg decoded more frames than ffprobe reported.');

        const seconds = pts[frameIndex] - pts[0];
        const cpuStart = process.cpuUsage();
        const start = performance.now();
        const result = recognizer.read({ data: frame, width, height, channels: 1 }, seconds);
        wall.push(performance.now() - start);
        const used = process.cpuUsage(cpuStart);
        cpu.push((used.user + used.system) / 1000);
        if (!result || !Array.isArray(result.events)) throw new Error('Recognition engine returned no events array.');
        if (Number.isFinite(result.processingMs)) reported.push(result.processingMs);
        for (const event of result.events) {
          events.push({
            ...normalizeRow(event, 'Recognition event at frame ' + frameIndex),
            detectedAt: seconds,
            sourcePts: pts[frameIndex],
            frameIndex,
          });
        }
        frameIndex++;
        offset = 0;
      }
    }
  } catch (error) {
    child.kill();
    await completion;
    throw error;
  }

  const result = await completion;
  if (result.error) throw result.error;
  if (result.code !== 0) throw new Error('FFmpeg exited with code ' + result.code + ': ' + stderr.trim());
  if (offset || frameIndex !== pts.length) {
    throw new Error('Frame/PTS alignment failed: ' + frameIndex + ' decoded frames for ' + pts.length + ' timestamps.');
  }
  return {
    events,
    performance: {
      cpuMs: distribution(cpu),
      wallMs: distribution(wall),
      engineMs: distribution(reported),
      cpuCounterNote: process.platform === 'win32'
        ? 'The Windows process CPU counter can report zero for short calls. Use wallMs for fine-grained synchronous recognition latency.'
        : null,
    },
  };
}

function eventKey(row) {
  return JSON.stringify([String(row.seat), String(row.slot), row.rank]);
}

function comparePhase(truth, detected) {
  const available = new Set(detected);
  const matches = [];
  const missed = [];
  for (const expected of truth.slice().sort((a, b) => a.time - b.time)) {
    const key = eventKey(expected);
    let closest = null;
    let distance = Infinity;
    for (const event of available) {
      if (eventKey(event) !== key) continue;
      const gap = Math.abs(event.detectedAt - expected.time);
      if (gap < distance) {
        closest = event;
        distance = gap;
      }
    }
    if (closest) {
      available.delete(closest);
      matches.push({ expected, event: closest, delayMs: (closest.detectedAt - expected.time) * 1000 });
    } else {
      missed.push(expected);
    }
  }

  const accountedFor = new Set(matches.map(item => eventKey(item.event)));
  const unmatched = [];
  const duplicates = [];
  for (const event of available) {
    const key = eventKey(event);
    if (accountedFor.has(key)) duplicates.push(event);
    else unmatched.push(event);
    accountedFor.add(key);
  }
  return {
    expected: truth.length,
    detected: detected.length,
    matched: matches.length,
    misses: missed.length,
    extras: unmatched.length,
    duplicateCount: duplicates.length,
    delaysMs: distribution(matches.map(item => item.delayMs)),
    matches, missed, unmatched, duplicates,
  };
}

function compare(truth, detected) {
  return {
    initial: comparePhase(truth.filter(row => row.initial), detected.filter(row => row.initial)),
    new: comparePhase(truth.filter(row => !row.initial), detected.filter(row => !row.initial)),
  };
}

function encodeCsv(result) {
  const rows = [[
    'phase', 'status', 'seat', 'slot', 'rank', 'truth_seconds', 'detected_seconds',
    'event_seconds', 'delay_ms', 'confidence', 'source_pts_seconds', 'frame_index',
  ]];
  function add(phase, status, expected, event, delay) {
    const card = event || expected;
    rows.push([
      phase, status, card.seat, card.slot, card.rank, expected?.time, event?.detectedAt,
      event?.time, delay, event?.confidence, event?.sourcePts, event?.frameIndex,
    ]);
  }
  if (result.comparison) {
    for (const [phase, section] of Object.entries(result.comparison)) {
      for (const match of section.matches) add(phase, 'matched', match.expected, match.event, match.delayMs);
      for (const card of section.missed) add(phase, 'missed', card);
      for (const card of section.unmatched) add(phase, 'unmatched', null, card);
      for (const card of section.duplicates) add(phase, 'duplicate', null, card);
    }
  } else {
    for (const card of result.events) add(card.initial ? 'initial' : 'new', 'detected', null, card);
  }
  const escape = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  return rows.map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}

function printSummary(result) {
  const { video, performance: speed, events, comparison } = result;
  console.log(video.frames + ' decoded frames at ' + video.width + '×' + video.height + ' · ' + video.averageFrameRate + ' fps average');
  console.log('Per-frame recognizer latency: p50 ' + speed.wallMs.p50.toFixed(3) + ' ms · p95 ' + speed.wallMs.p95.toFixed(3) + ' ms');
  console.log('Per-frame process CPU counter: p50 ' + speed.cpuMs.p50.toFixed(3) + ' ms · p95 ' + speed.cpuMs.p95.toFixed(3) + ' ms');
  if (speed.cpuCounterNote) console.log(speed.cpuCounterNote);
  for (const [phase, initial] of [['Initial snapshot', true], ['New cards', false]]) {
    const section = comparison?.[initial ? 'initial' : 'new'];
    if (!section) {
      console.log(phase + ': ' + events.filter(event => event.initial === initial).length + ' detected');
      continue;
    }
    console.log(phase + ': ' + section.matched + '/' + section.expected + ' matched, ' +
      section.misses + ' missed, ' + section.extras + ' unmatched, ' + section.duplicateCount + ' duplicate');
    if (section.delaysMs) {
      console.log('  Detection delay: p50 ' + section.delaysMs.p50.toFixed(1) + ' ms · p95 ' + section.delaysMs.p95.toFixed(1) + ' ms');
    }
    for (const { expected, event, delayMs } of section.matches) {
      console.log('  ' + event.seat + '/' + event.slot + ' ' + event.rank + '  ' +
        expected.time.toFixed(3) + ' → ' + event.detectedAt.toFixed(3) + ' s  (' + delayMs.toFixed(1) + ' ms)');
    }
    for (const [status, cards] of [['missed', section.missed], ['unmatched', section.unmatched], ['duplicate', section.duplicates]]) {
      for (const card of cards) {
        const at = card.detectedAt ?? card.time;
        console.log('  ' + status + ' ' + card.seat + '/' + card.slot + ' ' + card.rank + ' at ' + at.toFixed(3) + ' s');
      }
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      video: { type: 'string' }, truth: { type: 'string' }, csv: { type: 'string' },
      ffmpeg: { type: 'string' }, ffprobe: { type: 'string' }, json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.video) throw new Error(usage);
  const video = path.resolve(values.video);
  if (!(await fs.stat(video)).isFile()) throw new Error('The video must be a local file.');
  const ffmpeg = values.ffmpeg || defaultExecutable('ffmpeg');
  const ffprobe = values.ffprobe || defaultExecutable('ffprobe');
  const { create } = require('../dist/recognition-engine.js');
  const profile = require('../dist/recognition-profile.js');
  const [metadata, truth] = await Promise.all([
    probe(video, ffprobe),
    values.truth ? loadTruth(path.resolve(values.truth)) : null,
  ]);
  if (metadata.width !== profile.width || metadata.height !== profile.height) {
    throw new Error('Capture dimensions ' + metadata.width + '×' + metadata.height +
      ' do not match the recognition profile ' + profile.width + '×' + profile.height + '.');
  }
  const output = await recognize(video, ffmpeg, metadata, create(profile));
  const result = {
    video: {
      width: metadata.width,
      height: metadata.height,
      averageFrameRate: metadata.avg_frame_rate,
      frames: metadata.pts.length,
      firstPts: metadata.pts[0],
      lastPts: metadata.pts.at(-1),
      timeBasis: 'ffprobe presentation timestamps relative to the first frame',
    },
    ...output,
    comparison: truth ? compare(truth, output.events) : null,
  };
  if (values.csv) await fs.writeFile(path.resolve(values.csv), encodeCsv(result), { flag: 'wx' });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printSummary(result);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { compare, defaultExecutable, distribution, encodeCsv, loadTruth, probe, recognize };
