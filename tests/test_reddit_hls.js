'use strict';

/**
 * test_reddit_hls.js - REDDIT-HLS-01: one complete MP4 (video + audio) from a Reddit v.redd.it HLS (CMAF) post video.
 *
 * The production module lib/reddit_hls.mjs runs unchanged with the REAL pinned MP4Box 2.4.1 (lib/vendor/mp4box/2.4.1); nothing of the muxer is mocked.
 * Only the network is replaced, by a server that serves tiny controlled but complete fMP4 resources in the layout verified on the reproducer (ftyp, moov with
 * edts after mdia and mvex(mehd, trex), sidx, interleaved-by-track moof/mdat with tfhd defaults) plus the playlists that declare them. Every success case
 * reparses the output with the real library and compares tracks, timescales, edit lists, every sample's DTS/CTS/duration/size/sync flag and payload, the index
 * and the fragment layout. Node results do not prove browser playback, audio or seeking; those stay native checks.
 */

const REPO_ROOT = require('node:path').resolve(__dirname, '..');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const assert = require('assert/strict');

const ROOT = REPO_ROOT;
let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });

// =============================================================================================================================================
// Tiny controlled fMP4 resources
// =============================================================================================================================================
const u8 = (...n) => Uint8Array.from(n);
const be = (v, bytes) => { const o = []; for (let i = bytes - 1; i >= 0; i--) o.push(Math.floor(v / 2 ** (8 * i)) & 0xff); return Uint8Array.from(o); };
const cat = (...parts) => { const flat = parts.flat(Infinity); let len = 0; for (const p of flat) len += p.length; const out = new Uint8Array(len); let at = 0; for (const p of flat) { out.set(p, at); at += p.length; } return out; };
const str = (s) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
const box = (type, ...payload) => { const body = cat(payload); return cat(be(8 + body.length, 4), str(type), body); };
const full = (type, version, flags, ...payload) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
const zeros = (n) => new Uint8Array(n);
const MATRIX = cat(be(0x10000, 4), zeros(12), be(0x10000, 4), zeros(12), be(0x40000000, 4));

function avc1Entry(width, height) {
  const sps = u8(0x67, 0x4d, 0x40, 0x1f, 0xe8, 0x80);
  const pps = u8(0x68, 0xee, 0x3c, 0x80);
  const avcC = box('avcC', u8(1, 0x4d, 0x40, 0x1f, 0xff, 0xe1), be(sps.length, 2), sps, u8(1), be(pps.length, 2), pps);
  return box('avc1', zeros(6), be(1, 2), zeros(16), be(width, 2), be(height, 2), be(0x480000, 4), be(0x480000, 4), zeros(4), be(1, 2), zeros(32), be(0x18, 2), be(0xffff, 2), avcC);
}

function mp4aEntry(rate, channels) {
  const dsi = u8(0x11, 0x90);
  const dec = cat(u8(0x04, 13 + 2 + 2), u8(0x40, 0x15), zeros(3), be(128000, 4), be(128000, 4), u8(0x05, dsi.length), dsi);
  const es = cat(u8(0x03, 3 + dec.length + 3), be(2, 2), u8(0), dec, u8(0x06, 1, 0x02));
  return box('mp4a', zeros(6), be(1, 2), zeros(8), be(channels, 2), be(16, 2), zeros(4), be(rate * 65536, 4), full('esds', 0, 0, es));
}

const defaultPayload = (video) => (i, size) => cat(be(i, 4), new Uint8Array(Math.max(0, size - 4)).fill(((i * 7) + (video ? 1 : 2)) & 255));

/**
 * spec: { kind, timescale, mediaTime (single edit; omit/undefined with noEdts), width, height, rate, channels, samples: [{ size, duration, cts?, sync? }],
 *         perFragment, dtsStart?, edits?: [[segment_duration, media_time, rate_int]], pssh?, noEdts?, noSidx? }
 */
function buildFmp4(spec) {
  const video = spec.kind === 'video';
  const ts = spec.timescale;
  const samples = spec.samples;
  const total = samples.reduce((a, s) => a + s.duration, 0);
  const payloadOf = spec.payload || defaultPayload(video);
  const entry = video ? avc1Entry(spec.width || 64, spec.height || 48) : mp4aEntry(spec.rate || 48000, spec.channels || 2);
  const edits = spec.edits || [[0, spec.mediaTime || 0, 1]];
  const trak = box('trak',
    full('tkhd', 0, 3, be(0, 4), be(0, 4), be(1, 4), be(0, 4), be(0, 4), zeros(8), be(0, 2), be(0, 2), be(video ? 0 : 0x0100, 2), be(0, 2), MATRIX, be((video ? spec.width || 64 : 0) * 65536, 4), be((video ? spec.height || 48 : 0) * 65536, 4)),
    box('mdia',
      full('mdhd', 0, 0, be(0, 4), be(0, 4), be(ts, 4), be(0, 4), be(0x55c4, 2), be(0, 2)),
      full('hdlr', 0, 0, be(0, 4), str(video ? 'vide' : 'soun'), zeros(12), str(video ? 'VideoHandler' : 'SoundHandler'), u8(0)),
      box('minf',
        video ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4)),
        box('dinf', full('dref', 0, 0, be(1, 4), full('url ', 0, 1))),
        box('stbl', full('stsd', 0, 0, be(1, 4), entry), full('stts', 0, 0, be(0, 4)), full('stsc', 0, 0, be(0, 4)), full('stsz', 0, 0, be(0, 4), be(0, 4)), full('stco', 0, 0, be(0, 4))))),
    spec.noEdts ? new Uint8Array(0) : box('edts', full('elst', 0, 0, be(edits.length, 4), edits.map((e) => cat(be(e[0], 4), be(e[1], 4), be(e[2], 2), be(0, 2))))));
  const moov = box('moov',
    full('mvhd', 0, 0, be(0, 4), be(0, 4), be(ts, 4), be(0, 4), be(0x10000, 4), be(0x0100, 2), zeros(10), MATRIX, zeros(24), be(2, 4)),
    trak,
    box('mvex', full('mehd', 0, 0, be(total, 4)), full('trex', 0, 0, be(1, 4), be(1, 4), be(0, 4), be(0, 4), be(0, 4))),
    spec.pssh ? box('pssh', zeros(24)) : new Uint8Array(0));
  const ftyp = box('ftyp', str('isom'), be(0, 4), str('mp41'), str('iso8'), str('isom'), str('dash'), str('cmfc'));
  const init = cat(ftyp, moov);

  const base = spec.dtsStart || 0;
  const dtsAt = [];
  let acc = base;
  for (const s of samples) { dtsAt.push(acc); acc += s.duration; }
  const frags = [];
  let seq = 0;
  for (let i = 0; i < samples.length; i += spec.perFragment) {
    const part = samples.slice(i, i + spec.perFragment);
    const payloads = part.map((s, k) => payloadOf(i + k, s.size));
    const duration = part.reduce((a, s) => a + s.duration, 0);
    const trunBody = (dataOffset) => cat(be(part.length, 4), be(dataOffset, 4), part.map((s, k) => cat(be(payloads[k].length, 4),
      video ? cat(be(s.sync === false ? 0x01010000 : 0x02000000, 4), be(Math.max(0, (s.cts === undefined ? dtsAt[i + k] : s.cts) - dtsAt[i + k]), 4)) : new Uint8Array(0))));
    const build = (dataOffset) => box('moof', full('mfhd', 0, 0, be(++seq, 4)),
      box('traf', full('tfhd', 0, video ? 0x02000a : 0x02002a, be(1, 4), be(1, 4), be(part[0].duration, 4), video ? new Uint8Array(0) : be(0x02000000, 4)),
        full('tfdt', 0, 0, be(dtsAt[i], 4)),
        full('trun', 0, video ? 0x000e01 : 0x000201, trunBody(dataOffset))));
    const probe = build(0); seq--;
    const moof = build(probe.length + 8);
    frags.push({ bytes: cat(moof, box('mdat', ...payloads)), duration });
  }
  const sidx = spec.noSidx ? new Uint8Array(0) : full('sidx', 0, 0, be(1, 4), be(ts, 4), be(0, 4), be(0, 4), be(0, 2), be(frags.length, 2), frags.map((f) => cat(be(f.bytes.length, 4), be(f.duration, 4), be(0x90000000, 4))));
  const head = cat(init, sidx);
  let offset = head.length;
  const segments = frags.map((f) => { const sg = { offset, length: f.bytes.length, duration: f.duration / ts }; offset += f.bytes.length; return sg; });
  return { bytes: cat(head, frags.map((f) => f.bytes)), map: { offset: 0, length: init.length }, segments, ticks: total, seconds: total / ts, spec, payloadOf };
}

// the reproducer's shape at a tiny scale: 4:3 B-frame style composition offsets, a sync sample every 12 frames; AAC frames of 1024 samples at 48 kHz
function videoSpec(over = {}) {
  const n = over.count || 36;
  const samples = [];
  for (let i = 0; i < n; i++) samples.push({ size: 24 + (i % 5) * 3, duration: 512, cts: i * 512 + [1024, 2048, 1536][i % 3], sync: i % 12 === 0 });
  return { kind: 'video', timescale: 15360, mediaTime: 1024, width: 64, height: 48, samples, perFragment: 12, ...over };
}
function audioSpec(over = {}) {
  const n = over.count || 60;
  const samples = [];
  for (let i = 0; i < n; i++) samples.push({ size: 9 + (i % 7), duration: 1024 });
  return { kind: 'audio', timescale: 48000, mediaTime: 1024, rate: 48000, channels: 2, samples, perFragment: 20, ...over };
}

// =============================================================================================================================================
// Playlists and the server
// =============================================================================================================================================
const BASE = 'https://v.redd.it/x1/';
const MASTER_URL = BASE + 'HLSPlaylist.m3u8';

function mediaPlaylist(res, name, over = {}) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:5', '#EXT-X-PLAYLIST-TYPE:VOD'];
  if (over.extra) lines.push(...over.extra);
  if (!over.noMap) lines.push(`#EXT-X-MAP:URI="${name}",BYTERANGE="${res.map.length}@0"`);
  (over.segments || res.segments).forEach((s, i) => {
    lines.push(`#EXTINF:${s.duration},`, `#EXT-X-BYTERANGE:${s.length}@${s.offset}`, over.uriOf ? over.uriOf(i, name) : name);
  });
  if (!over.noEnd) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

// the master of the reproducer: two audio groups, the best video playlist listed once per group, smaller pictures too
function masterPlaylist(over = {}) {
  return (over.lines || [
    '#EXTM3U', '#EXT-X-VERSION:4',
    '#EXT-X-MEDIA:URI="CMAF_AUDIO_64.m3u8",TYPE=AUDIO,GROUP-ID="6",NAME="audio 0",DEFAULT=YES,AUTOSELECT=YES',
    '#EXT-X-MEDIA:URI="CMAF_AUDIO_128.m3u8",TYPE=AUDIO,GROUP-ID="7",NAME="audio 0",DEFAULT=YES,AUTOSELECT=YES',
    '#EXT-X-STREAM-INF:PROGRAM-ID=0,CLOSED-CAPTIONS=NONE,BANDWIDTH=1357086,AVERAGE-BANDWIDTH=829912,RESOLUTION=853x480,FRAME-RATE=30,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="7"', 'CMAF_480.m3u8',
    '#EXT-X-STREAM-INF:PROGRAM-ID=0,CLOSED-CAPTIONS=NONE,BANDWIDTH=2271415,AVERAGE-BANDWIDTH=1335341,RESOLUTION=1280x720,FRAME-RATE=30,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="6"', 'CMAF_720.m3u8',
    '#EXT-X-STREAM-INF:PROGRAM-ID=0,CLOSED-CAPTIONS=NONE,BANDWIDTH=2340050,AVERAGE-BANDWIDTH=1398356,RESOLUTION=1280x720,FRAME-RATE=30,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="7"', 'CMAF_720.m3u8'
  ]).join('\n') + '\n';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bodyReader(bytes, { chunk = 4096, delayMs = 0, stallAfter = Infinity, signal } = {}) {
  let at = 0;
  return {
    async read() {
      if (signal && signal.aborted) throw signal.reason;
      if (at >= bytes.length) return { done: true };
      if (at >= stallAfter) await new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(signal.reason), { once: true }); });
      if (delayMs) { await sleep(delayMs); if (signal && signal.aborted) throw signal.reason; }
      const end = Math.min(bytes.length, at + chunk);
      const value = bytes.subarray(at, end);
      at = end;
      return { done: false, value };
    },
    cancel() {}
  };
}

// files: pathname -> { body, type, status?, headers?, length?, redirected?, url?, chunk?, delayMs?, stallAfter?, hook?, respondAfterAbort? }
function makeServer(files) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url, init, pathname: u.pathname });
    const f = files[u.pathname];
    if (!f) return { status: 404, headers: { get: () => '' }, body: { getReader: () => bodyReader(new Uint8Array(0)) }, redirected: false, url };
    if (f.hook) await f.hook(init, u);
    if (f.never) await new Promise((_, rej) => { if (init.signal) init.signal.addEventListener('abort', () => rej(init.signal.reason), { once: true }); });
    const bytes = typeof f.body === 'string' ? str(f.body) : f.body;
    const headers = { 'content-type': f.type, ...(f.noLength || typeof f.body === 'string' ? {} : { 'content-length': String(f.length === undefined ? bytes.length : f.length) }), ...(f.headers || {}) };
    return {
      status: f.status || 200,
      headers: { get: (k) => (headers[k.toLowerCase()] !== undefined ? headers[k.toLowerCase()] : null) },
      body: { getReader: () => bodyReader(bytes, { chunk: f.chunk, delayMs: f.delayMs, stallAfter: f.stallAfter, signal: init.signal }) },
      redirected: Boolean(f.redirected),
      url: f.url || url
    };
  };
  return { fetchImpl, calls };
}

// the standard asset: video + audio resources, their playlists and the master
function standardFiles(v, a, over = {}) {
  return {
    '/x1/HLSPlaylist.m3u8': { body: over.master || masterPlaylist(), type: 'application/x-mpegurl' },
    '/x1/CMAF_720.m3u8': { body: over.vPlaylist || mediaPlaylist(v, 'CMAF_720.mp4'), type: 'application/x-mpegurl' },
    '/x1/CMAF_AUDIO_128.m3u8': { body: over.aPlaylist || mediaPlaylist(a, 'CMAF_AUDIO_128.mp4'), type: 'application/x-mpegurl' },
    // the other renditions the master lists (only their playlists exist here; a lower layout is read only after a byte-budget refusal)
    '/x1/CMAF_AUDIO_64.m3u8': { body: mediaPlaylist(a, 'CMAF_AUDIO_64.mp4'), type: 'application/x-mpegurl' },
    '/x1/CMAF_480.m3u8': { body: mediaPlaylist(v, 'CMAF_480.mp4'), type: 'application/x-mpegurl' },
    '/x1/CMAF_720.mp4': { body: v.bytes, type: 'video/mp4', ...(over.vFile || {}) },
    '/x1/CMAF_AUDIO_128.mp4': { body: a.bytes, type: 'video/mp4', ...(over.aFile || {}) }
  };
}

// =============================================================================================================================================
// Reading the output back with the real library
// =============================================================================================================================================
let H;
let M;

async function reparse(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const file = M.createFile(true);
  let info = null;
  file.onReady = (i) => { info = i; };
  file.onError = (e) => { throw new Error('reparse: ' + e); };
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  file.appendBuffer(M.MP4BoxBuffer.fromArrayBuffer(ab, 0), true);
  assert.ok(info, 'the output parses');
  return { file, info, bytes };
}

const fourcc = (bytes, at) => String.fromCharCode(...bytes.slice(at + 4, at + 8));

function expectedSamples(res) {
  const out = [];
  // the output tables start every track at zero: a source that starts later is shifted, its start is presented by an empty edit (assertEdits)
  const start = res.spec.dtsStart || 0;
  let dts = 0;
  res.spec.samples.forEach((s, i) => {
    out.push({ dts, cts: s.cts === undefined ? dts : s.cts - start, duration: s.duration, size: res.payloadOf(i, s.size).length, sync: res.spec.kind === 'video' ? s.sync !== false : true, payload: res.payloadOf(i, s.size) });
    dts += s.duration;
  });
  return out;
}

// everything the output must keep of one source track
function assertTrack(out, id, res, label) {
  const trak = out.file.getTrackById(id);
  assert.ok(trak, `${label}: track ${id}`);
  const want = expectedSamples(res);
  assert.equal(trak.samples.length, want.length, `${label}: every sample`);
  const ts = trak.mdia.mdhd.timescale;
  assert.equal(ts, res.spec.timescale, `${label}: the media timescale is the source's`);
  want.forEach((w, i) => {
    const s = trak.samples[i];
    assert.deepEqual([s.dts, s.cts, s.duration, s.size, s.is_sync], [w.dts, w.cts, w.duration, w.size, w.sync], `${label}: sample ${i} timing, size and sync flag`);
    const got = out.file.getSample(trak, i);
    assert.ok(got && got.data, `${label}: sample ${i} readable`);
    assert.deepEqual(Array.from(got.data), Array.from(w.payload), `${label}: sample ${i} payload`);
    out.file.releaseSample(trak, i);
  });
  return trak;
}

const mediaTimeOf = (spec) => (spec.noEdts ? 0 : (spec.edits ? spec.edits[0][1] : spec.mediaTime || 0));
// against the source's absolute media time: the ticks before the first sample (an empty edit) and the media time the output edit keeps
const leadOf = (spec) => Math.max(0, (spec.dtsStart || 0) - mediaTimeOf(spec));
const skipOf = (spec) => Math.max(0, mediaTimeOf(spec) - (spec.dtsStart || 0));
const hasEdit = (spec) => Math.round(leadOf(spec) / spec.timescale * 1000) > 0 || skipOf(spec) > 0;

function assertEdits(trak, res, movieTs, label) {
  const mt = skipOf(res.spec);
  const lead = Math.round(leadOf(res.spec) / res.spec.timescale * movieTs);
  let entries = (trak.edts && trak.edts.elst && trak.edts.elst.entries) || [];
  if (!mt && !lead) { assert.equal(entries.length, 0, `${label}: no edit when the source had none`); return; }
  if (lead) {
    assert.equal(entries.length, 2, `${label}: an empty edit, then the media`);
    assert.deepEqual([entries[0].segment_duration, entries[0].media_time, entries[0].media_rate_integer], [lead, -1, 1], `${label}: the start after zero is an empty edit of that length`);
    entries = entries.slice(1);
  } else assert.equal(entries.length, 1, `${label}: one edit`);
  assert.deepEqual([entries[0].media_time, entries[0].media_rate_integer, entries[0].media_rate_fraction], [mt, 1, 0], `${label}: the media time is the source's, in this track's own timescale`);
  const presentation = (res.ticks - mt) / res.spec.timescale;
  assert.ok(Math.abs(entries[0].segment_duration / movieTs - presentation) <= 1 / movieTs, `${label}: the edit lasts as long as the presentation (${entries[0].segment_duration} for ${presentation} s)`);
}

// ---- an independent reader of the output bytes: no library, only the ISO box layout (size, type, children) and the fixed fields of the sample tables ----
function boxesIn(bytes, start, end) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const list = [];
  let at = start;
  while (at < end) {
    assert.ok(at + 8 <= end, 'a box header fits');
    const size = dv.getUint32(at);
    assert.ok(size >= 8 && at + size <= end, `box size ${size} at ${at} stays inside its parent`);
    list.push({ type: fourcc(bytes, at), start: at, size, body: at + 8, end: at + size });
    at += size;
  }
  assert.equal(at, end, 'boxes tile their parent exactly');
  return list;
}
const child = (bytes, box, type) => boxesIn(bytes, box.body, box.end).filter((b) => b.type === type);
const only = (bytes, box, type) => { const l = child(bytes, box, type); assert.equal(l.length, 1, `exactly one ${type}`); return l[0]; };

function rawTables(bytes, trak) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stbl = only(bytes, only(bytes, only(bytes, trak, 'mdia'), 'minf'), 'stbl');
  const t = {};
  t.order = boxesIn(bytes, stbl.body, stbl.end).map((b) => b.type);
  const u32 = (at) => dv.getUint32(at);
  const i32 = (at) => dv.getInt32(at);
  const entries = (box, width, fn) => { const n = u32(box.body + 4); const o = []; for (let k = 0; k < n; k++) o.push(fn(box.body + 8 + k * width)); assert.equal(box.body + 8 + n * width, box.end, `${box.type} is exactly its entries`); return o; };
  const stts = only(bytes, stbl, 'stts');
  t.stts = entries(stts, 8, (p) => [u32(p), u32(p + 4)]);
  const ctts = child(bytes, stbl, 'ctts')[0];
  t.ctts = ctts ? entries(ctts, 8, (p) => [u32(p), i32(p + 4)]) : null;
  const stss = child(bytes, stbl, 'stss')[0];
  t.stss = stss ? entries(stss, 4, (p) => u32(p)) : null;
  const stsc = only(bytes, stbl, 'stsc');
  t.stsc = entries(stsc, 12, (p) => [u32(p), u32(p + 4), u32(p + 8)]);
  const stsz = only(bytes, stbl, 'stsz');
  assert.equal(u32(stsz.body + 4), 0, 'no constant sample size');
  const count = u32(stsz.body + 8);
  t.sizes = []; for (let k = 0; k < count; k++) t.sizes.push(u32(stsz.body + 12 + k * 4));
  assert.equal(stsz.body + 12 + count * 4, stsz.end);
  const stco = only(bytes, stbl, 'stco');
  t.stco = entries(stco, 4, (p) => u32(p));
  return t;
}

// every sample's place in the file from the raw tables alone: chunk by chunk, samples back to back inside a chunk
function rawSamplePlaces(tb) {
  const places = [];
  let sample = 0;
  tb.stsc.forEach(([first, per], k) => {
    const lastChunk = k + 1 < tb.stsc.length ? tb.stsc[k + 1][0] - 1 : tb.stco.length;
    for (let chunk = first; chunk <= lastChunk; chunk++) {
      let at = tb.stco[chunk - 1];
      for (let j = 0; j < per; j++) { places.push({ chunk, offset: at, size: tb.sizes[sample] }); at += tb.sizes[sample]; sample++; }
    }
  });
  assert.equal(sample, tb.sizes.length, 'the chunks hold every sample');
  return places;
}

// the structure of a whole output: a regular MP4 (ftyp, moov, mdat), both complete tracks, ordinary tables that tile the media data, interleaving
async function assertOutput(result, v, a, label = 'output') {
  const out = await reparse(result.blob);
  const { file, info, bytes } = out;
  assert.equal(result.size, bytes.length, `${label}: reported size`);
  assert.equal(result.fragments, 0, `${label}: not fragmented`);
  assert.deepEqual(file.boxes.map((b) => b.type), ['ftyp', 'moov', 'mdat'], `${label}: ftyp, moov before the media data, one mdat`);
  assert.equal(info.isFragmented, false);
  assert.equal(file.moov.mvex, undefined, `${label}: no fragment extension`);
  assert.equal(info.tracks.length, 2, `${label}: both declared tracks`);
  assert.deepEqual(info.tracks.map((t) => [t.id, t.type, t.codec]), [[1, 'video', 'avc1.4d401f'], [2, 'audio', 'mp4a.40.2']], `${label}: ids, kinds, codecs`);
  assert.equal(file.moov.mvhd.timescale, 1000);
  const vt = assertTrack(out, 1, v, `${label} video`);
  const at = assertTrack(out, 2, a, `${label} audio`);
  assert.deepEqual([info.tracks[0].track_width, info.tracks[0].track_height], [v.spec.width || 64, v.spec.height || 48], `${label}: picture size`);
  assert.deepEqual([info.tracks[1].audio.sample_rate, info.tracks[1].audio.channel_count, info.tracks[1].audio.sample_size], [a.spec.rate || 48000, a.spec.channels || 2, 16], `${label}: audio parameters`);
  assert.deepEqual([info.tracks[0].volume, info.tracks[1].volume], [0, 1], `${label}: volume`);
  assertEdits(vt, v, 1000, `${label} video`);
  assertEdits(at, a, 1000, `${label} audio`);
  const pres = (r) => Math.round(leadOf(r.spec) / r.spec.timescale * 1000) + Math.round(Math.max(0, r.ticks - skipOf(r.spec)) / r.spec.timescale * 1000);
  const movie = Math.max(pres(v), pres(a));
  assert.equal(file.moov.mvhd.duration, movie, `${label}: movie duration`);
  assert.equal(vt.mdia.mdhd.duration, v.ticks);
  assert.equal(at.mdia.mdhd.duration, a.ticks);
  assert.equal(result.durationSec, movie / 1000);

  // --- the bytes, read without the library ---
  const top = boxesIn(bytes, 0, bytes.length);
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
  const mdat = top[2];
  const moov = top[1];
  const moovKids = boxesIn(bytes, moov.body, moov.end);
  assert.deepEqual(moovKids.map((b) => b.type), ['mvhd', 'trak', 'trak'], `${label}: mvhd leads the movie box; two tracks; no mvex`);
  const traks = moovKids.filter((b) => b.type === 'trak');
  traks.forEach((trak, k) => assert.deepEqual(boxesIn(bytes, trak.body, trak.end).map((b) => b.type), hasEdit(k === 0 ? v.spec : a.spec) ? ['tkhd', 'edts', 'mdia'] : ['tkhd', 'mdia'], `${label}: track box order (the edit box sits between the header and the media)`));
  for (const trak of traks) assert.deepEqual(boxesIn(bytes, only(bytes, trak, 'mdia').body, only(bytes, trak, 'mdia').end).map((b) => b.type), ['mdhd', 'hdlr', 'minf'], `${label}: ordinary media box`);
  const tables = [v, a].map((res, k) => {
    const tb = rawTables(bytes, traks[k]);
    const want = expectedSamples(res);
    assert.deepEqual(tb.order.filter((t) => t !== 'ctts' && t !== 'stss'), ['stsd', 'stts', 'stsc', 'stsz', 'stco'], `${label}: sample table boxes`);
    // time-to-sample, composition offsets and sync samples against the source
    const durations = []; for (const [n, d] of tb.stts) for (let i = 0; i < n; i++) durations.push(d);
    assert.deepEqual(durations, want.map((w) => w.duration), `${label} track ${k + 1}: stts`);
    const ctts = []; if (tb.ctts) for (const [n, d] of tb.ctts) for (let i = 0; i < n; i++) ctts.push(d);
    const wantCtts = want.map((w) => w.cts - w.dts);
    if (wantCtts.some((x) => x !== 0)) assert.deepEqual(ctts, wantCtts, `${label} track ${k + 1}: ctts`); else assert.equal(tb.ctts, null, `${label} track ${k + 1}: no ctts when every offset is zero`);
    if (k === 0) {
      const syncs = want.map((w, i) => (w.sync ? i + 1 : 0)).filter(Boolean);
      if (syncs.length === want.length) assert.equal(tb.stss, null); else assert.deepEqual(tb.stss, syncs, `${label}: stss lists the sync samples`);
    } else assert.equal(tb.stss, null, `${label}: audio has no sync table`);
    assert.deepEqual(tb.sizes, want.map((w) => w.size), `${label} track ${k + 1}: stsz`);
    assert.ok(tb.stsc.every((e) => e[2] === 1) && tb.stsc[0][0] === 1, `${label}: stsc starts at chunk 1`);
    assert.ok(tb.stsc.every((e, i) => i === 0 || (e[0] > tb.stsc[i - 1][0] && e[1] !== tb.stsc[i - 1][1])), `${label}: stsc runs are minimal and ordered`);
    // every sample sits inside the media data and carries the source payload
    const places = rawSamplePlaces(tb);
    places.forEach((p, i) => {
      assert.ok(p.offset >= mdat.body && p.offset + p.size <= mdat.end, `${label} track ${k + 1}: sample ${i} lies inside the mdat`);
      assert.deepEqual(Array.from(bytes.subarray(p.offset, p.offset + p.size)), Array.from(want[i].payload), `${label} track ${k + 1}: sample ${i} payload at its table offset`);
    });
    return { tb, places };
  });
  // the chunks of both tracks tile the media data exactly: no gap, no overlap, nothing unreferenced
  const chunks = [];
  tables.forEach(({ tb, places }, k) => {
    const byChunk = new Map();
    for (const p of places) { const c = byChunk.get(p.chunk) || { track: k, offset: p.offset, size: 0 }; c.size += p.size; byChunk.set(p.chunk, c); }
    chunks.push(...byChunk.values());
  });
  chunks.sort((x, y) => x.offset - y.offset);
  let cursor = mdat.body;
  for (const c of chunks) { assert.equal(c.offset, cursor, `${label}: chunks follow one another`); cursor += c.size; }
  assert.equal(cursor, mdat.end, `${label}: the chunks fill the mdat exactly`);
  // interleaving: strictly alternating video, audio, video, ... chunks, and the audio of a pair starts before the next video chunk does
  const kinds = chunks.map((c) => c.track);
  assert.ok(kinds.every((t, i) => (i % 2 === 0 ? t === 0 : t === 1)) || kinds.every((t, i) => t === 0 || kinds[i - 1] === 0), `${label}: video chunks first in every pair, audio never twice in a row`);
  const startTime = (k, res, chunkOffset) => {
    const { places } = tables[k];
    const i = places.findIndex((p) => p.offset === chunkOffset);
    const w = expectedSamples(res)[i];
    return w.dts / res.spec.timescale;
  };
  chunks.forEach((c, i) => {
    if (c.track !== 1) return;
    const nextVideo = chunks.slice(i + 1).find((x) => x.track === 0);
    if (nextVideo) assert.ok(startTime(1, a, c.offset) < startTime(0, v, nextVideo.offset), `${label}: an audio chunk starts before the next video chunk`);
  });
  out.chunks = { video: chunks.filter((c) => c.track === 0).length, audio: chunks.filter((c) => c.track === 1).length };
  out.tables = tables.map((t) => t.tb);
  return out;
}

const tickAsync = () => new Promise((r) => setImmediate(r));

// =============================================================================================================================================
// Success
// =============================================================================================================================================
test('vendor: the pinned MP4Box 2.4.1 is byte-identical to its provenance record and carries its license', async () => {
  const dir = path.join(ROOT, 'lib', 'vendor', 'mp4box', '2.4.1');
  const prov = JSON.parse(fs.readFileSync(path.join(dir, 'PROVENANCE.json'), 'utf8'));
  assert.equal(prov.package, 'mp4box');
  assert.equal(prov.version, '2.4.1');
  assert.equal(prov.license, 'BSD-3-Clause');
  assert.deepEqual(prov.files.map((f) => f.path).sort(), ['LICENSE', 'mp4box.all.mjs', 'rolldown-runtime-w6R9maHv.mjs', 'styp-9TIZZDLN.mjs']);
  for (const f of prov.files) {
    const b = fs.readFileSync(path.join(dir, f.path));
    assert.equal(b.length, f.bytes, `${f.path}: size`);
    assert.equal(crypto.createHash('sha256').update(b).digest('hex'), f.sha256, `${f.path}: sha256`);
    assert.equal('sha512-' + crypto.createHash('sha512').update(b).digest('base64'), f.integrity, `${f.path}: integrity`);
  }
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), /BSD|Redistribution/i);
  assert.equal(M.ISOFile.name, 'ISOFile', 'the real library is loaded');
});

test('the whole path: master, playlists, resources, remux; both tracks, timing, payloads, index and layout come back exactly', async () => {
  const v = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  const server = makeServer(standardFiles(v, a));
  const result = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl });
  await assertOutput(result, v, a, 'standard');
  // what was asked: the master, the two playlists named by the master (the best picture, its own audio group), then the two declared resources, once each
  assert.deepEqual(server.calls.map((c) => c.pathname), ['/x1/HLSPlaylist.m3u8', '/x1/CMAF_720.m3u8', '/x1/CMAF_AUDIO_128.m3u8', '/x1/CMAF_720.mp4', '/x1/CMAF_AUDIO_128.mp4']);
  for (const c of server.calls) {
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.redirect, 'error');
    assert.equal(c.init.method, 'GET');
    assert.ok(c.init.signal, 'every request is cancellable');
  }
  assert.equal(result.video.codec, 'avc1.4d401f');
  assert.equal(result.audio.codec, 'mp4a.40.2');
  assert.equal(H.isAssembling(), false);
});

test('timing across timescales: different edit lists (priming) are kept in each track\'s own timescale; no edit stays no edit', async () => {
  const cases = {
    'video 1024 @15360, audio 2048 @48000': [videoSpec({ mediaTime: 1024 }), audioSpec({ mediaTime: 2048 })],
    'video without an edit, audio 1024': [videoSpec({ noEdts: true, mediaTime: 0, samples: videoSpec().samples.map((s) => ({ ...s, cts: s.cts - 1024 })) }), audioSpec({ mediaTime: 1024 })],
    'neither track has an edit': [videoSpec({ noEdts: true, mediaTime: 0 }), audioSpec({ noEdts: true, mediaTime: 0 })],
    'an edit with a segment duration set (the source states it)': [videoSpec({ edits: [[2345, 1024, 1]] }), audioSpec({ edits: [[1111, 1024, 1]] })]
  };
  for (const [name, [vs, as]] of Object.entries(cases)) {
    const v = buildFmp4(vs);
    const a = buildFmp4(as);
    const result = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl });
    await assertOutput(result, v, a, name);
    // presentation alignment: the first picture and the first audible sample start where the source's edit lists put them
    const out = await reparse(result.blob);
    const startOf = (id, spec, firstOf) => { const t = out.file.getTrackById(id); const e = t.edts && t.edts.elst.entries[0]; return (firstOf(t) - (e ? e.media_time : 0)) / spec.timescale; };
    const srcStart = (spec, firstOf) => (firstOf({ samples: spec.samples.map((s, i) => ({ cts: s.cts === undefined ? 0 : s.cts, dts: 0 })) }) - mediaTimeOf(spec)) / spec.timescale;
    assert.equal(startOf(1, v.spec, (t) => Math.min(...t.samples.map((s) => s.cts))), srcStart(v.spec, (t) => Math.min(...t.samples.map((s) => s.cts))), `${name}: the first picture's presentation start`);
    assert.equal(startOf(2, a.spec, (t) => t.samples[0].cts), (0 - mediaTimeOf(a.spec)) / a.spec.timescale, `${name}: the audio's presentation start`);
  }
});

// BUGFIX-MULTISITE-01: the layout observed on v.redd.it/xbd04viqf9uh1 (r/SipsTea): video at 15360 ticks with an edit of media time 1024 and a first
// decode time of 0; AAC at 48000 ticks WITHOUT an edit list whose first decode time is 48 (tfdt 48, sidx earliest presentation time 48). Before the fix
// the assembly refused it as UNSUPPORTED_TIMING. Now the audio's start is presented exactly where the source puts it: an empty edit of 1 ms.
test('a track that starts after zero (observed SipsTea layout): kept in sync by an initial empty edit, every sample and payload unchanged', async () => {
  const cases = {
    'observed: video edit 1024 @15360 from 0, audio from 48 @48000 without an edit': [videoSpec({ mediaTime: 1024 }), audioSpec({ noEdts: true, mediaTime: 0, dtsStart: 48 })],
    'audio from 48 with its own priming edit 1024': [videoSpec({ mediaTime: 1024 }), audioSpec({ mediaTime: 1024, dtsStart: 48 })],
    'video from 512 with an edit of 1024 (the edit lies inside the media)': [videoSpec({ mediaTime: 1024, dtsStart: 512, samples: videoSpec().samples.map((s) => ({ ...s, cts: s.cts + 512 })) }), audioSpec({ mediaTime: 1024 })],
    'both tracks start late (video 0.5 s, audio 0.25 s)': [videoSpec({ noEdts: true, mediaTime: 0, dtsStart: 7680, samples: videoSpec().samples.map((s) => ({ ...s, cts: s.cts - 1024 + 7680 })) }), audioSpec({ noEdts: true, mediaTime: 0, dtsStart: 12000 })]
  };
  for (const [name, [vs, as]] of Object.entries(cases)) {
    const v = buildFmp4(vs);
    const a = buildFmp4(as);
    const result = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl });
    await assertOutput(result, v, a, name);
    // presentation alignment against the source: a sample presented at (cts - edit media time) / timescale in the source is presented at the same time
    const out = await reparse(result.blob);
    const presentedAt = (trak, ts, cts) => {
      const e = (trak.edts && trak.edts.elst.entries) || [];
      const empty = e.length && e[0].media_time === -1 ? e[0].segment_duration / 1000 : 0;
      const media = e.find((x) => x.media_time >= 0);
      return empty + (cts - (media ? media.media_time : 0)) / ts;
    };
    const srcAt = (spec, cts) => (cts - mediaTimeOf(spec)) / spec.timescale;
    const vt = out.file.getTrackById(1);
    const at = out.file.getTrackById(2);
    const vFirst = Math.min(...vt.samples.map((x) => x.cts));
    const vSrcFirst = Math.min(...vs.samples.map((x) => x.cts));
    assert.ok(Math.abs(presentedAt(vt, vs.timescale, vFirst) - srcAt(vs, vSrcFirst)) < 0.0005, `${name}: the first picture is presented where the source presents it`);
    assert.ok(Math.abs(presentedAt(at, as.timescale, at.samples[0].cts) - srcAt(as, as.dtsStart || 0)) < 0.0005, `${name}: the first audio sample is presented where the source presents it (${presentedAt(at, as.timescale, at.samples[0].cts)} s)`);
    assert.equal(at.samples.length, as.samples.length, `${name}: no audio sample dropped`);
  }
});

test('several interleaved chunks: chunks follow sync samples and carry the audio between them; the tables cover every chunk', async () => {
  const v = buildFmp4(videoSpec({ count: 120, perFragment: 12 }));
  const a = buildFmp4(audioSpec({ count: 200, perFragment: 20 }));
  const result = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl, limits: { groupSeconds: 0.5, blobPartBytes: 600 } });
  assert.equal(result.fragments, 0);
  const out = await assertOutput(result, v, a, 'chunks');
  assert.ok(out.chunks.video >= 4 && out.chunks.audio >= 4, 'several chunks: ' + JSON.stringify(out.chunks));
  assert.equal(out.tables[0].stco.length, out.chunks.video);
  assert.equal(out.tables[1].stco.length, out.chunks.audio);
  // the video chunks begin at the sync samples (every 12th frame) of the source
  const video = out.file.getTrackById(1);
  const firstOfChunk = new Set(rawSamplePlaces(out.tables[0]).filter((p, i, all) => i === 0 || all[i - 1].chunk !== p.chunk).map((p) => p.offset));
  const syncOffsets = new Set(video.samples.filter((s) => s.is_sync).map((s) => s.offset));
  assert.ok([...firstOfChunk].every((o) => syncOffsets.has(o)), 'every chunk begins at a sync sample');
  // seeking: the sync table points at samples whose chunks can start playback
  assert.deepEqual(out.tables[0].stss, video.samples.map((s, i) => (s.is_sync ? i + 1 : 0)).filter(Boolean));
});

test('chunks bounded by bytes: a chunk never exceeds the byte limit even without a sync sample; the tables still tile the media data', async () => {
  const vs = videoSpec({ count: 48, perFragment: 12 });
  vs.samples = vs.samples.map((s, i) => ({ ...s, size: 200, sync: i === 0 }));
  const v = buildFmp4(vs);
  const a = buildFmp4(audioSpec());
  const result = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl, limits: { groupBytes: 1000 } });
  const out = await assertOutput(result, v, a, 'bytes');
  assert.ok(out.chunks.video >= 8, 'bounded chunks: ' + out.chunks.video);
  const places = rawSamplePlaces(out.tables[0]);
  const perChunk = new Map();
  for (const p of places) perChunk.set(p.chunk, (perChunk.get(p.chunk) || 0) + p.size);
  assert.ok([...perChunk.values()].every((n) => n <= 1000), 'no video chunk beyond groupBytes');
  assert.deepEqual(out.tables[0].stss, [1], 'only the first sample is a sync sample, and the table says so');
});

test('the best supported variant: largest picture, then the larger bandwidth (the better audio group); every address is the declared one', async () => {
  const master = H.parseMasterPlaylist(masterPlaylist());
  const layout = H.selectLayout(master);
  assert.equal(layout.video.uri, 'CMAF_720.m3u8');
  assert.equal(layout.video.audioGroup, '7');
  assert.equal(layout.audio.uri, 'CMAF_AUDIO_128.m3u8');
  // other layouts of the same shape pick by the same rules
  const other = H.selectLayout(H.parseMasterPlaylist(masterPlaylist({ lines: [
    '#EXTM3U',
    '#EXT-X-MEDIA:URI="a_en.m3u8",TYPE=AUDIO,GROUP-ID="aud",NAME="en"',
    '#EXT-X-MEDIA:URI="a_def.m3u8",TYPE=AUDIO,GROUP-ID="aud",NAME="main",DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"', 'v1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=9999,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"', 'v360.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x1080,CODECS="avc1.640028",URI="i.m3u8"'
  ] })));
  assert.equal(other.video.uri, 'v1080.m3u8');
  assert.equal(other.audio.uri, 'a_def.m3u8', 'the default rendition of the declared group');
});

// =============================================================================================================================================
// Refusals: the master and the media playlists
// =============================================================================================================================================
test('refused masters: no audio group, a group without a rendition, no H264, no AAC-LC, encrypted, not a playlist', async () => {
  const sel = (lines) => H.selectLayout(H.parseMasterPlaylist(lines.join('\n') + '\n'));
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  const V = (extra = '', codecs = 'avc1.4d401f,mp4a.40.2') => `#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360,CODECS="${codecs}"${extra}`;
  const A = '#EXT-X-MEDIA:URI="a.m3u8",TYPE=AUDIO,GROUP-ID="g",NAME="a",DEFAULT=YES';
  assert.equal(code(() => sel(['#EXTM3U', V(), 'v.m3u8'])), 'UNSUPPORTED_CODEC', 'video only: audio is never assumed silent (no declared audio group)');
  assert.equal(code(() => sel(['#EXTM3U', A, V(',AUDIO="missing"'), 'v.m3u8'])), 'UNSUPPORTED_LAYOUT', 'declared group without a rendition');
  assert.equal(code(() => sel(['#EXTM3U', A, V(',AUDIO="g"', 'hvc1.1.6.L93.B0,mp4a.40.2'), 'v.m3u8'])), 'UNSUPPORTED_CODEC', 'not H264');
  assert.equal(code(() => sel(['#EXTM3U', A, V(',AUDIO="g"', 'avc1.4d401f,mp4a.40.5'), 'v.m3u8'])), 'UNSUPPORTED_CODEC', 'not AAC-LC');
  assert.equal(code(() => sel(['#EXTM3U', A, '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360,AUDIO="g"', 'v.m3u8'])), 'UNSUPPORTED_LAYOUT', 'no codecs declared: unknown stays unknown');
  assert.equal(code(() => sel(['#EXTM3U', '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="k"', A, V(',AUDIO="g"'), 'v.m3u8'])), 'UNSUPPORTED_ENCRYPTED');
  assert.equal(code(() => H.parseMasterPlaylist('<html></html>')), 'UNSUPPORTED_LAYOUT');
});

test('media playlists: the finite unencrypted single-resource byte-range VOD is accepted; every other shape is refused by name', async () => {
  const v = buildFmp4(videoSpec());
  const good = H.parseMediaPlaylist(mediaPlaylist(v, 'CMAF_720.mp4'));
  assert.equal(good.segments.length, 3);
  assert.equal(good.map.length, v.map.length);
  assert.ok(Math.abs(good.durationSec - v.seconds) < 1e-6);
  assert.equal(good.endOffset, v.bytes.length);
  const code = (text, limits) => { try { H.parseMediaPlaylist(text, limits); } catch (e) { return e.code; } return null; };
  const m = mediaPlaylist(v, 'CMAF_720.mp4');
  assert.equal(code(m.replace('#EXT-X-ENDLIST\n', '')), 'UNSUPPORTED_LAYOUT', 'not finite (no ENDLIST)');
  assert.equal(code(m.replace('PLAYLIST-TYPE:VOD', 'PLAYLIST-TYPE:EVENT')), 'UNSUPPORTED_LAYOUT', 'live/event');
  assert.equal(code(mediaPlaylist(v, 'CMAF_720.mp4', { extra: ['#EXT-X-KEY:METHOD=AES-128,URI="https://v.redd.it/x1/k"'] })), 'UNSUPPORTED_ENCRYPTED');
  assert.equal(code(mediaPlaylist(v, 'CMAF_720.mp4', { extra: ['#EXT-X-KEY:METHOD=NONE'] })) , null, 'an explicit METHOD=NONE is no encryption');
  assert.equal(code(mediaPlaylist(v, 'CMAF_720.mp4', { extra: ['#EXT-X-DISCONTINUITY'] })), 'UNSUPPORTED_LAYOUT');
  assert.equal(code(mediaPlaylist(v, 'CMAF_720.mp4', { extra: ['#EXT-X-I-FRAMES-ONLY'] })), 'UNSUPPORTED_LAYOUT');
  assert.equal(code(mediaPlaylist(v, 'CMAF_720.mp4', { noMap: true })), 'UNSUPPORTED_LAYOUT', 'no init segment');
  assert.equal(code(mediaPlaylist(v, 'CMAF_720.mp4', { uriOf: (i, n) => (i === 1 ? 'OTHER.mp4' : n) })), 'UNSUPPORTED_LAYOUT', 'more than one resource');
  assert.equal(code(m.replace(/#EXT-X-BYTERANGE:\d+@\d+\n/, '')), 'UNSUPPORTED_LAYOUT', 'a segment without its byte range');
  assert.equal(code(m.replace('#EXT-X-BYTERANGE:' + v.segments[1].length + '@' + v.segments[1].offset, '#EXT-X-BYTERANGE:' + v.segments[1].length + '@' + (v.segments[0].offset + 1))), 'UNSUPPORTED_LAYOUT', 'overlapping ranges');
  assert.equal(code(m.replace(/#EXTINF:[\d.]+,/, '#EXTINF:0,')), 'UNSUPPORTED_TIMING');
  assert.equal(code(m.replace(/#EXTINF:[\d.]+,/, '#EXTINF:NaN,')), 'UNSUPPORTED_TIMING');
  assert.equal(code(m.replace(/#EXTINF:[\d.]+,/, '#EXTINF:3600,')), 'UNSUPPORTED_TIMING', 'a segment longer than the bound');
  assert.equal(code(m, { ...H.LIMITS, inputBytes: 100 }), 'TOO_LARGE', 'a declared range beyond the input limit');
  assert.equal(code(m.replace(/BYTERANGE:(\d+)@(\d+)/, 'BYTERANGE:$1@999999999999')), 'UNSUPPORTED_LAYOUT', 'a first range that the next ones overlap is a layout error before any budget judgement');
  const last = v.segments.at(-1);
  assert.equal(code(m.replace('#EXT-X-BYTERANGE:' + last.length + '@' + last.offset, '#EXT-X-BYTERANGE:' + last.length + '@999999999999')), 'TOO_LARGE', 'a last range far beyond the input limit');
  assert.equal(code(m.replace('BYTERANGE="' + v.map.length + '@0"', 'BYTERANGE="' + v.map.length + '"')), 'UNSUPPORTED_LAYOUT', 'an init range without an offset');
});

test('addresses: only https://v.redd.it/<asset>/HLSPlaylist.m3u8; every playlist address stays in the asset', async () => {
  for (const ok of ['https://v.redd.it/abc123/HLSPlaylist.m3u8', 'https://v.redd.it/abc_-1/HLSPlaylist.m3u8?x=1&y=%2F']) assert.ok(H.redditHlsMaster(ok), ok);
  assert.equal(H.redditHlsMaster('https://v.redd.it/abc123/HLSPlaylist.m3u8').assetId, 'abc123');
  for (const bad of ['http://v.redd.it/a/HLSPlaylist.m3u8', 'https://evil.example/a/HLSPlaylist.m3u8', 'https://v.redd.it.evil.example/a/HLSPlaylist.m3u8', 'https://user:pw@v.redd.it/a/HLSPlaylist.m3u8',
    'https://v.redd.it:8443/a/HLSPlaylist.m3u8', 'https://v.redd.it/a/b/HLSPlaylist.m3u8', 'https://v.redd.it/HLSPlaylist.m3u8', 'https://v.redd.it/a/CMAF_720.m3u8', 'https://v.redd.it/a/DASHPlaylist.mpd',
    'https://v.redd.it/a/HLSPlaylist.m3u8#x', 'blob:https://www.reddit.com/x', '', null, 'https://v.redd.it/' + 'a'.repeat(70) + '/HLSPlaylist.m3u8']) {
    assert.equal(H.redditHlsMaster(bad), null, String(bad));
  }
  // addresses declared by the playlists: foreign host, another asset, an absolute address, a path escape, the wrong extension
  const v = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  const refuse = async (over, expectCode, what) => {
    const server = makeServer(standardFiles(v, a, over));
    await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl }), { code: expectCode }, what);
    assert.ok(!server.calls.some((c) => /\.mp4$/.test(c.pathname)) || /mp4/.test(what), `${what}: no resource was requested before the address was refused`);
    assert.equal(H.isAssembling(), false);
  };
  await refuse({ master: masterPlaylist().replaceAll('CMAF_720.m3u8', 'https://evil.example/x1/CMAF_720.m3u8') }, 'FOREIGN_SOURCE', 'a foreign playlist host');
  await refuse({ master: masterPlaylist().replaceAll('CMAF_720.m3u8', '/x2/CMAF_720.m3u8') }, 'FOREIGN_SOURCE', 'another asset');
  await refuse({ master: masterPlaylist().replaceAll('CMAF_720.m3u8', '../x2/CMAF_720.m3u8') }, 'FOREIGN_SOURCE', 'a path escape');
  await refuse({ master: masterPlaylist().replaceAll('CMAF_720.m3u8', 'CMAF_720.mp4') }, 'FOREIGN_SOURCE', 'the wrong extension');
  await refuse({ vPlaylist: mediaPlaylist(v, 'https://evil.example/x1/CMAF_720.mp4') }, 'FOREIGN_SOURCE', 'a foreign resource host (mp4)');
  await refuse({ vPlaylist: mediaPlaylist(v, '/x2/CMAF_720.mp4') }, 'FOREIGN_SOURCE', 'a resource of another asset (mp4)');
  await refuse({ vPlaylist: mediaPlaylist(v, 'CMAF_720.m3u8') }, 'FOREIGN_SOURCE', 'a resource that is a playlist (mp4)');
});

// =============================================================================================================================================
// Refusals: the resources and the network
// =============================================================================================================================================
async function refusal(v, a, over, expected, what, limits) {
  const server = makeServer(standardFiles(v, a, over));
  let err = null;
  try {
    await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl, limits });
  } catch (e) { err = e; }
  assert.ok(err, `${what}: refused`);
  assert.equal(err.code, expected, `${what}: ${err.message}`);
  assert.equal(H.isAssembling(), false, `${what}: nothing stays busy`);
  return { err, server };
}

test('network refusals: status, redirect, content type, encoding, missing or wrong lengths, truncation and excess', async () => {
  const v = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  const r403 = await refusal(v, a, { vFile: { status: 403 } }, 'HTTP_ERROR', 'HTTP 403');
  assert.equal(r403.err.status, 403);
  assert.equal((await refusal(v, a, { aFile: { status: 404 } }, 'HTTP_ERROR', 'HTTP 404')).err.status, 404);
  await refusal(v, a, { vFile: { redirected: true } }, 'FOREIGN_SOURCE', 'a redirected response');
  await refusal(v, a, { vFile: { url: 'https://v.redd.it/other/CMAF_720.mp4' } }, 'FOREIGN_SOURCE', 'a response of another address');
  await refusal(v, a, { vFile: { type: 'text/html' } }, 'INVALID_MEDIA', 'a page instead of the video');
  await refusal(v, a, { vFile: { headers: { 'content-encoding': 'gzip' } } }, 'INVALID_MEDIA', 'an encoded body');
  await refusal(v, a, { vFile: { noLength: true } }, 'INVALID_MEDIA', 'no declared length');
  await refusal(v, a, { vFile: { length: v.bytes.length - 10 } }, 'INCOMPLETE', 'a resource shorter than its playlist range');
  await refusal(v, a, { aFile: { length: a.bytes.length - 1 } }, 'INCOMPLETE', 'the audio resource shorter than its range');
  await refusal(v, a, { vFile: { length: v.bytes.length + 5 } }, 'INCOMPLETE', 'fewer bytes than declared (body ends early)');
  await refusal(v, a, { vFile: { length: v.bytes.length - 0, body: cat(v.bytes, u8(1, 2, 3)) } }, 'INVALID_MEDIA', 'more bytes than declared');
  await refusal(v, a, { master: 'not a playlist' }, 'UNSUPPORTED_LAYOUT', 'a master that is not a playlist');
  await refusal(v, a, { master: masterPlaylist(), vPlaylist: 'x'.repeat(300 * 1024) }, 'TOO_LARGE', 'a playlist beyond its limit');
});

test('resource refusals: truncated media, a missing fragment, foreign length, protection, timeline, edits, codecs and declared lengths', async () => {
  const v = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  // the playlist declares one more fragment than the file holds
  const extra = { ...v.segments[2] };
  const longer = { ...v, segments: [...v.segments, { offset: extra.offset + extra.length, length: 40, duration: 0.4 }] };
  await refusal(v, a, { vPlaylist: mediaPlaylist(longer, 'CMAF_720.mp4') }, 'INCOMPLETE', 'a declared fragment that is not in the file', undefined);
  // the playlist declares a different position for a fragment
  const shifted = { ...v, segments: v.segments.map((s, i) => (i === 1 ? { ...s, offset: s.offset + 4, length: s.length - 4 } : s)) };
  await refusal(v, a, { vPlaylist: mediaPlaylist(shifted, 'CMAF_720.mp4') }, 'INCOMPLETE', 'a fragment that is not at its declared range');
  // the durations the playlist declares are not the file's
  await refusal(v, a, { vPlaylist: mediaPlaylist({ ...v, segments: v.segments.map((s) => ({ ...s, duration: s.duration + 2 })) }, 'CMAF_720.mp4') }, 'INCOMPLETE', 'a playlist longer than its video');
  await refusal(v, a, { aPlaylist: mediaPlaylist({ ...a, segments: a.segments.map((s) => ({ ...s, duration: s.duration + 2 })) }, 'CMAF_AUDIO_128.mp4') }, 'INCOMPLETE', 'video and audio playlists that differ in length');
  // the file is shorter than the playlist says although its length header agrees (a cut tail with consistent header)
  const cut = buildFmp4(videoSpec({ brokenTail: 0 }));
  const cutBytes = cut.bytes.slice(0, cut.bytes.length - 20);
  await refusal(cut, a, { vFile: { body: cutBytes, length: cutBytes.length }, vPlaylist: mediaPlaylist(cut, 'CMAF_720.mp4') }, 'INCOMPLETE', 'a truncated last fragment');
  // protection and unsupported content
  await refusal(buildFmp4(videoSpec({ pssh: true })), a, {}, 'UNSUPPORTED_ENCRYPTED', 'a protection system box');
  await refusal(buildFmp4(videoSpec({ dtsStart: 15360 * 2 })), a, {}, 'UNSUPPORTED_TIMING', 'a timeline that starts later than the tolerance (2 s)');
  await refusal(v, buildFmp4(audioSpec({ dtsStart: 48000 + 48, noEdts: true, mediaTime: 0 })), {}, 'UNSUPPORTED_TIMING', 'an audio timeline that starts later than the tolerance');
  await refusal(buildFmp4(videoSpec({ edits: [[100, 1024, 1], [100, 2048, 1]] })), a, {}, 'UNSUPPORTED_TIMING', 'two edits');
  await refusal(buildFmp4(videoSpec({ edits: [[0, 1024, 2]] })), a, {}, 'UNSUPPORTED_TIMING', 'an edit with a rate that is not 1');
  await refusal(buildFmp4(videoSpec({ edits: [[0, 999999, 1]] })), a, {}, 'UNSUPPORTED_TIMING', 'an edit beyond the media');
  // lengths against the declared bounds
  await refusal(v, a, {}, 'TOO_LARGE', 'resources beyond the input limit', { inputBytes: v.bytes.length + a.bytes.length - 1 });
  await refusal(v, a, {}, 'TOO_LARGE', 'an output beyond its limit', { outputBytes: 200 });
  // the encrypted/DASH/TS look-alikes in the master are refused before any resource is requested
  const enc = await refusal(v, a, { vPlaylist: mediaPlaylist(v, 'CMAF_720.mp4', { extra: ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"'] }) }, 'UNSUPPORTED_ENCRYPTED', 'an encrypted video playlist');
  assert.ok(!enc.server.calls.some((c) => /\.mp4$/.test(c.pathname)), 'nothing was downloaded for an encrypted source');
});

test('the audio is never dropped or invented: a declared audio group whose resource is not AAC is refused, not saved silent', async () => {
  const v = buildFmp4(videoSpec());
  // the "audio" resource is another video track
  const notAudio = buildFmp4(videoSpec({ count: 60 }));
  await refusal(v, notAudio, {}, 'UNSUPPORTED_CODEC', 'an audio group that holds video');
});

// =============================================================================================================================================
// Deadlines, abort, busy, cleanup
// =============================================================================================================================================
test('deadlines: no response headers, no data for too long, a total deadline; each is TIMEOUT, cancels the request and frees the assembler', async () => {
  const v = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  const noHeaders = await refusal(v, a, { vFile: { never: true } }, 'TIMEOUT', 'no response headers', { headerMs: 30 });
  assert.ok(noHeaders.server.calls.at(-1).init.signal.aborted, 'the stalled request was cancelled');
  const stall = await refusal(v, a, { vFile: { stallAfter: 100, chunk: 50 } }, 'TIMEOUT', 'no data', { inactivityMs: 30 });
  assert.ok(stall.server.calls.at(-1).init.signal.aborted);
  const slow = await refusal(v, a, { vFile: { delayMs: 15, chunk: 64 } }, 'TIMEOUT', 'a total deadline', { totalMs: 100, inactivityMs: 1000 });
  assert.ok(slow.server.calls.at(-1).init.signal.aborted);
  const text = await refusal(v, a, { vPlaylist: undefined, master: masterPlaylist() }, 'TIMEOUT', 'a playlist that never answers', { headerMs: 25 }).catch((e) => e);
  assert.ok(text);
});

test('abort: the caller\'s signal cancels the running request, rejects with ABORTED and frees the assembler for the next one', async () => {
  const v = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  let reached = null;
  const files = standardFiles(v, a, { vFile: { stallAfter: 100, chunk: 50, hook: () => { reached(); } } });
  const server = makeServer(files);
  const ac = new AbortController();
  const waiting = new Promise((r) => { reached = r; });
  const p = H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl, signal: ac.signal });
  await waiting;
  await sleep(20);
  assert.equal(H.isAssembling(), true);
  ac.abort();
  await assert.rejects(p, { code: 'ABORTED' });
  assert.equal(H.isAssembling(), false);
  assert.ok(server.calls.at(-1).init.signal.aborted, 'the request was cancelled');
  // an already aborted signal never starts a request
  const done = makeServer(standardFiles(v, a));
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: done.fetchImpl, signal: pre.signal }), { code: 'ABORTED' });
  assert.equal(done.calls.length, 0);
  assert.equal(H.isAssembling(), false);
  // and the assembler works again
  const ok = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl });
  assert.ok(ok.size > 0);
});

test('one assembly at a time: a second request is BUSY while the first runs, and the first is not disturbed', async () => {
  const v = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = makeServer(standardFiles(v, a, { vFile: { hook: () => gate } }));
  const first = H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: slow.fetchImpl });
  await sleep(30);
  assert.equal(H.isAssembling(), true);
  const other = makeServer(standardFiles(v, a));
  await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: other.fetchImpl }), { code: 'BUSY' });
  assert.equal(other.calls.length, 0, 'the busy request touched nothing');
  release();
  const result = await first;
  await assertOutput(result, v, a, 'the first assembly');
  assert.equal(H.isAssembling(), false);
});

test('an address that is not a Reddit HLS master is refused before anything is requested', async () => {
  const server = makeServer({});
  for (const bad of ['https://v.redd.it/x1/CMAF_720.m3u8', 'https://example.com/x1/HLSPlaylist.m3u8', '', undefined]) {
    await assert.rejects(H.assembleRedditHls({ masterUrl: bad, fetchImpl: server.fetchImpl }), { code: 'FOREIGN_SOURCE' });
  }
  assert.equal(server.calls.length, 0);
  assert.equal(H.isAssembling(), false);
});

test('every failure releases everything: after any refusal the assembler is idle and the next valid assembly is complete', async () => {
  const v = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  for (const over of [{ vFile: { status: 500 } }, { aFile: { type: 'text/html' } }, { vPlaylist: mediaPlaylist(v, 'CMAF_720.mp4', { noEnd: true }) }]) {
    await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a, over)).fetchImpl }));
    assert.equal(H.isAssembling(), false);
  }
  const ok = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl });
  await assertOutput(ok, v, a, 'after failures');
});

test('memory shape: the result is one Blob and the module holds no state between assemblies', async () => {
  const v = buildFmp4(videoSpec({ count: 240, perFragment: 24 }));
  const a = buildFmp4(audioSpec({ count: 400, perFragment: 40 }));
  const before = process.memoryUsage().arrayBuffers;
  const result = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl });
  assert.ok(result.blob instanceof Blob);
  assert.deepEqual(Object.keys(result).sort(), ['audio', 'blob', 'durationSec', 'fragments', 'size', 'video']);
  await assertOutput(result, v, a, 'larger');
  await tickAsync();
  assert.ok(process.memoryUsage().arrayBuffers - before < 50 * 1024 * 1024, 'no large retained buffers for a tiny assembly');
});

// =============================================================================================================================================
// R1: the best complete layout that fits the input budget (the native 1080p master of post 1sqccda is ~188 MiB with its audio, the 720p one ~110 MiB)
// =============================================================================================================================================
const MASTER_1080 = masterPlaylist({ lines: [
  '#EXTM3U', '#EXT-X-VERSION:4',
  '#EXT-X-MEDIA:URI="CMAF_AUDIO_64.m3u8",TYPE=AUDIO,GROUP-ID="6",NAME="audio 0",DEFAULT=YES,AUTOSELECT=YES',
  '#EXT-X-MEDIA:URI="CMAF_AUDIO_128.m3u8",TYPE=AUDIO,GROUP-ID="7",NAME="audio 0",DEFAULT=YES,AUTOSELECT=YES',
  '#EXT-X-STREAM-INF:BANDWIDTH=4331012,RESOLUTION=1920x1080,FRAME-RATE=30,CODECS="avc1.640028,mp4a.40.2",AUDIO="7"', 'CMAF_1080.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2271415,RESOLUTION=1280x720,FRAME-RATE=30,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="6"', 'CMAF_720.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2340050,RESOLUTION=1280x720,FRAME-RATE=30,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="7"', 'CMAF_720.m3u8'
] });

// a 1080p video resource far larger than the 720p one (same duration), plus the shared audio
function budgetFiles() {
  const big = videoSpec({ width: 96, height: 72 });
  big.samples = big.samples.map((s) => ({ ...s, size: 600 }));
  const v1080 = buildFmp4(big);
  const v720 = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  const files = standardFiles(v720, a, { master: MASTER_1080 });
  files['/x1/CMAF_1080.m3u8'] = { body: mediaPlaylist(v1080, 'CMAF_1080.mp4'), type: 'application/x-mpegurl' };
  files['/x1/CMAF_1080.mp4'] = { body: v1080.bytes, type: 'video/mp4' };
  return { v1080, v720, a, files };
}
const paths = (server) => server.calls.map((c) => c.pathname.replace('/x1/', ''));

test('R1 the best layout wins when it fits: 1080p is assembled with the default budget and nothing lower is looked at', async () => {
  const { v1080, a, files } = budgetFiles();
  const server = makeServer(files);
  const result = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl });
  await assertOutput(result, v1080, a, '1080 fits');
  assert.deepEqual(paths(server), ['HLSPlaylist.m3u8', 'CMAF_1080.m3u8', 'CMAF_AUDIO_128.m3u8', 'CMAF_1080.mp4', 'CMAF_AUDIO_128.mp4']);
});

test('R1 an oversized 1080p resource falls back to the complete 720p + declared audio layout; the 1080p body is never fetched', async () => {
  const { v1080, v720, a, files } = budgetFiles();
  assert.ok(v1080.bytes.length > v720.bytes.length + 8000, 'the fixture 1080p is the larger resource');
  const server = makeServer(files);
  const inputBytes = v720.bytes.length + a.bytes.length + 64;
  const result = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl, limits: { inputBytes } });
  await assertOutput(result, v720, a, '720 fallback');
  assert.deepEqual(paths(server), ['HLSPlaylist.m3u8', 'CMAF_1080.m3u8', 'CMAF_AUDIO_128.m3u8', 'CMAF_720.m3u8', 'CMAF_720.mp4', 'CMAF_AUDIO_128.mp4'], 'the oversized layout is validated with its audio, each playlist once, no 1080p resource');
});

test('R1 aggregate overflow (video fits alone, video + audio does not) also falls back; the shared audio playlist is read once', async () => {
  const { v1080, v720, a, files } = budgetFiles();
  const server = makeServer(files);
  const inputBytes = v1080.bytes.length + a.bytes.length - 1;
  assert.ok(inputBytes >= v720.bytes.length + a.bytes.length, 'the 720p layout fits, the 1080p one overflows by one byte');
  const result = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl, limits: { inputBytes } });
  await assertOutput(result, v720, a, 'aggregate fallback');
  assert.deepEqual(paths(server), ['HLSPlaylist.m3u8', 'CMAF_1080.m3u8', 'CMAF_AUDIO_128.m3u8', 'CMAF_720.m3u8', 'CMAF_720.mp4', 'CMAF_AUDIO_128.mp4']);
});

test('R1 when every supported layout is oversized: TOO_LARGE, no playlist read twice, no MP4 body fetched, assembler idle', async () => {
  const { v720, a, files } = budgetFiles();
  const server = makeServer(files);
  await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl, limits: { inputBytes: v720.bytes.length + a.bytes.length - 1 } }), { code: 'TOO_LARGE' });
  assert.ok(!paths(server).some((p) => p.endsWith('.mp4')), 'no media resource was requested');
  const counts = {};
  for (const p of paths(server)) counts[p] = (counts[p] || 0) + 1;
  assert.ok(Object.values(counts).every((n) => n === 1), 'no playlist is fetched twice: ' + JSON.stringify(counts));
  assert.equal(H.isAssembling(), false);
});

test('R1 only a byte-budget refusal permits a lower layout: encryption, HTTP, foreign, layout, timing and integrity failures are not masked', async () => {
  const { v1080, a, files } = budgetFiles();
  const lowerSeen = (server) => paths(server).some((p) => p === 'CMAF_720.m3u8' || p === 'CMAF_720.mp4');
  const pl = (res, name, over) => ({ body: mediaPlaylist(res, name, over), type: 'application/x-mpegurl' });
  const cases = [
    ['encrypted 1080p playlist', { '/x1/CMAF_1080.m3u8': pl(v1080, 'CMAF_1080.mp4', { extra: ['#EXT-X-KEY:METHOD=AES-128,URI="https://v.redd.it/x1/k"'] }) }, 'UNSUPPORTED_ENCRYPTED', undefined],
    ['1080p playlist HTTP 403', { '/x1/CMAF_1080.m3u8': { body: '', type: 'application/x-mpegurl', status: 403 } }, 'HTTP_ERROR', undefined],
    ['1080p playlist is not finite', { '/x1/CMAF_1080.m3u8': pl(v1080, 'CMAF_1080.mp4', { noEnd: true }) }, 'UNSUPPORTED_LAYOUT', undefined],
    ['1080p resource of another asset', { '/x1/CMAF_1080.m3u8': pl(v1080, '/x2/CMAF_1080.mp4') }, 'FOREIGN_SOURCE', undefined],
    ['1080p bad duration', { '/x1/CMAF_1080.m3u8': { body: mediaPlaylist(v1080, 'CMAF_1080.mp4').replace(/#EXTINF:[\d.]+,/, '#EXTINF:0,'), type: 'application/x-mpegurl' } }, 'UNSUPPORTED_TIMING', undefined],
    ['1080p and audio playlists differ in length', { '/x1/CMAF_1080.m3u8': pl({ ...v1080, segments: v1080.segments.map((s) => ({ ...s, duration: s.duration + 2 })) }, 'CMAF_1080.mp4') }, 'INCOMPLETE', undefined],
    ['too many segments (a layout bound, not bytes)', {}, 'TOO_LARGE', { maxSegments: 2 }],
    ['the audio playlist is encrypted', { '/x1/CMAF_AUDIO_128.m3u8': pl(a, 'CMAF_AUDIO_128.mp4', { extra: ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"'] }) }, 'UNSUPPORTED_ENCRYPTED', undefined]
  ];
  for (const [name, patch, code, limits] of cases) {
    const server = makeServer({ ...files, ...patch });
    await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl, limits }), { code }, name);
    assert.ok(!lowerSeen(server), `${name}: no lower layout was tried (${paths(server).join(', ')})`);
    assert.equal(H.isAssembling(), false, name);
  }
  // a media body failure of the chosen layout is final: no body is downloaded again, no other layout is fetched
  for (const [name, vFile, code] of [['1080p body HTTP 403', { status: 403 }, 'HTTP_ERROR'], ['1080p body truncated', { length: v1080.bytes.length - 5 }, 'INCOMPLETE']]) {
    const server = makeServer({ ...files, '/x1/CMAF_1080.mp4': { ...files['/x1/CMAF_1080.mp4'], ...vFile } });
    await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl }), { code }, name);
    assert.equal(paths(server).filter((p) => p.endsWith('.mp4')).length, 1, `${name}: one body request at most`);
    assert.ok(!lowerSeen(server), name);
  }
});

test('R1 a better variant without its declared audio rendition is a layout error, never replaced silently; layout order is stable', async () => {
  const noAudio = masterPlaylist({ lines: [
    '#EXTM3U',
    '#EXT-X-MEDIA:URI="CMAF_AUDIO_128.m3u8",TYPE=AUDIO,GROUP-ID="7",NAME="audio 0",DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=4331012,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="9"', 'CMAF_1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2340050,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="7"', 'CMAF_720.m3u8'
  ] });
  const { files } = budgetFiles();
  const server = makeServer({ ...files, '/x1/HLSPlaylist.m3u8': { body: noAudio, type: 'application/x-mpegurl' } });
  await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl }), { code: 'UNSUPPORTED_LAYOUT' });
  assert.deepEqual(paths(server), ['HLSPlaylist.m3u8']);
  const ranked = H.rankLayouts(H.parseMasterPlaylist(MASTER_1080));
  assert.deepEqual(ranked.map((l) => [l.video.uri, l.audio.uri]), [['CMAF_1080.m3u8', 'CMAF_AUDIO_128.m3u8'], ['CMAF_720.m3u8', 'CMAF_AUDIO_128.m3u8'], ['CMAF_720.m3u8', 'CMAF_AUDIO_64.m3u8']], 'resolution, then bandwidth; one entry per video + audio playlist pair');
  assert.deepEqual(H.selectLayout(H.parseMasterPlaylist(MASTER_1080)), ranked[0]);
});

// R1-F1: a byte overflow is judged only after the candidate layout is fully valid. The better layout is oversized AND invalid in the same time; the lower
// layout's playlist answers 404, so a fallback to it would hide the real error behind HTTP_ERROR 404.
test('R1-F1 oversized + invalid is never a fallback: foreign resource, overlap, total duration, encrypted or failed audio, foreign audio, pair duration; no lower layout, no media body', async () => {
  const { v1080, v720, a, files } = budgetFiles();
  delete files['/x1/CMAF_720.m3u8']; // the lower layout is unreadable: reaching it would turn every case into HTTP_ERROR 404
  const inputBytes = v720.bytes.length + a.bytes.length + 64; // the 1080p resource is oversized in every case
  const pl = (res, name, over) => ({ body: mediaPlaylist(res, name, over), type: 'application/x-mpegurl' });
  const longer = (extra) => ({ ...v1080, segments: v1080.segments.map((s) => ({ ...s, duration: s.duration + extra })) });
  const overlapping = { ...v1080, segments: [...v1080.segments.slice(0, -1), { ...v1080.segments.at(-1), offset: v1080.segments.at(-2).offset + 1 }] };
  const cases = [
    ['a foreign-asset resource', { '/x1/CMAF_1080.m3u8': pl(v1080, '/x2/CMAF_1080.mp4') }, 'FOREIGN_SOURCE', {}],
    ['a resource that is another kind of file', { '/x1/CMAF_1080.m3u8': pl(v1080, 'CMAF_1080.m3u8') }, 'FOREIGN_SOURCE', {}],
    ['overlapping ranges after the oversized one', { '/x1/CMAF_1080.m3u8': pl(overlapping, 'CMAF_1080.mp4') }, 'UNSUPPORTED_LAYOUT', {}],
    ['a total duration beyond the bound', { '/x1/CMAF_1080.m3u8': pl(longer(1), 'CMAF_1080.mp4') }, 'UNSUPPORTED_TIMING', { maxDurationSeconds: 3 }],
    ['an encrypted audio playlist', { '/x1/CMAF_AUDIO_128.m3u8': pl(a, 'CMAF_AUDIO_128.mp4', { extra: ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"'] }) }, 'UNSUPPORTED_ENCRYPTED', {}],
    ['a failed audio playlist', { '/x1/CMAF_AUDIO_128.m3u8': { body: '', type: 'application/x-mpegurl', status: 403 } }, 'HTTP_ERROR', {}],
    ['an audio resource of another asset', { '/x1/CMAF_AUDIO_128.m3u8': pl(a, '/x2/CMAF_AUDIO_128.mp4') }, 'FOREIGN_SOURCE', {}],
    ['a video/audio pair of different length', { '/x1/CMAF_1080.m3u8': pl(longer(2), 'CMAF_1080.mp4') }, 'INCOMPLETE', {}]
  ];
  for (const [name, patch, code, limits] of cases) {
    const server = makeServer({ ...files, ...patch });
    await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: server.fetchImpl, limits: { inputBytes, ...limits } }), { code }, name);
    assert.ok(!paths(server).includes('CMAF_720.m3u8'), `${name}: the lower layout was not inspected (${paths(server).join(', ')})`);
    assert.ok(!paths(server).some((p) => p.endsWith('.mp4')), `${name}: no media body was requested`);
    assert.equal(H.isAssembling(), false, name);
  }
});

test('R1-F1 a valid oversized layout still falls back, and a lower layout that is itself oversized or invalid is judged the same way', async () => {
  const { v720, a, files } = budgetFiles();
  const inputBytes = v720.bytes.length + a.bytes.length + 64;
  // valid + oversized: fallback to the lower complete layout (the existing behavior)
  const ok = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(files).fetchImpl, limits: { inputBytes } });
  await assertOutput(ok, v720, a, 'valid fallback');
  // the lower layout is invalid (a foreign resource): that error ends the save, no media body requested
  const bad = makeServer({ ...files, '/x1/CMAF_720.m3u8': { body: mediaPlaylist(v720, '/x2/CMAF_720.mp4'), type: 'application/x-mpegurl' } });
  await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: bad.fetchImpl, limits: { inputBytes } }), { code: 'FOREIGN_SOURCE' });
  assert.ok(!paths(bad).some((p) => p.endsWith('.mp4')));
  // every layout oversized but valid: TOO_LARGE with only playlists requested
  const all = makeServer(files);
  await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: all.fetchImpl, limits: { inputBytes: 100 } }), { code: 'TOO_LARGE' });
  assert.ok(!paths(all).some((p) => p.endsWith('.mp4')));
});

test('R2 output bound and cancellation of the packaging: the exact size passes, one byte less is TOO_LARGE before any payload is copied; an abort while packaging rejects ABORTED and frees the assembler', async () => {
  const v = buildFmp4(videoSpec());
  const a = buildFmp4(audioSpec());
  const ok = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl });
  await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl, limits: { outputBytes: ok.size - 1 } }), { code: 'TOO_LARGE' });
  const exact = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl, limits: { outputBytes: ok.size } });
  assert.equal(exact.size, ok.size);
  assert.equal(H.isAssembling(), false);
  // the third createFile call is the output file of the packaging step (the two before parse the sources)
  const ac = new AbortController();
  let calls = 0;
  const loader = async () => ({ ...M, createFile: (...args) => { const f = M.createFile(...args); if (++calls === 3) ac.abort(); return f; } });
  await assert.rejects(H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl, signal: ac.signal, mp4box: loader }), { code: 'ABORTED' });
  assert.equal(calls, 3);
  assert.equal(H.isAssembling(), false);
  const again = await H.assembleRedditHls({ masterUrl: MASTER_URL, fetchImpl: makeServer(standardFiles(v, a)).fetchImpl });
  await assertOutput(again, v, a, 'after the abort');
});

// =============================================================================================================================================
(async () => {
  H = await import(pathToFileURL(path.join(ROOT, 'lib', 'reddit_hls.mjs')).href);
  M = await import(pathToFileURL(path.join(ROOT, 'lib', 'vendor', 'mp4box', '2.4.1', 'mp4box.all.mjs')).href);
  for (const t of queue) {
    try {
      await t.fn();
      passed++;
      console.log(`[PASS] ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`[FAIL] ${t.name}: ${err && err.message}`);
      if (process.env.DEBUG) console.error(err);
    }
  }
  console.log('\n========================================');
  console.log(`Summary: ${passed}/${passed + failed} tests passed (${failed} failed)`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
})();
