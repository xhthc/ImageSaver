// lib/reddit_hls.mjs - one complete MP4 from a Reddit v.redd.it HLS (CMAF) post video, with its audio.
//
// Layout supported (verified on the reproducer, nothing else is attempted): a finite, unencrypted VOD where the master playlist offers H264 video variants
// plus a separate AAC audio group, and each selected track's init segment and media segments are byte ranges of ONE declared fMP4 resource.
// Every URL is taken from the playlists themselves (never guessed), must be https://v.redd.it/<same asset>/..., and every fetch refuses redirects.
// The two declared resources are fetched whole (bounded) and parsed with the pinned MP4Box 2.4.1 (lib/vendor/mp4box/2.4.1). The result is one regular,
// seekable (non-fragmented) MP4: ftyp, moov with both tracks and their ordinary sample tables, one mdat. Every sample payload, DTS/CTS/duration/sync flag,
// the codec configuration and the edit lists are carried over unchanged, nothing is re-encoded; the library writes the boxes (track headers, sample
// description, stts/ctts/stsz/stss/stsc/stco), this module only plans the interleaved chunks and fills the tables.
//
// Peak buffers (see the handoff): the two source resources are held whole (sum <= limits.inputBytes); the payload reaches the output Blob in parts of
// about limits.blobPartBytes taken as views of those buffers, so besides the sources the heap holds only the tables; the browser's Blob storage holds
// up to limits.outputBytes. The output size is known from the tables before any payload is copied and is refused beyond the limit.

export const LIMITS = Object.freeze({
  playlistBytes: 256 * 1024,
  inputBytes: 128 * 1024 * 1024,
  outputBytes: 160 * 1024 * 1024,
  headerMs: 30000,
  inactivityMs: 60000,
  totalMs: 600000,
  maxSegments: 10000,
  maxSegmentSeconds: 60,
  maxDurationSeconds: 36000,
  toleranceSeconds: 1,
  groupSeconds: 2,
  groupBytes: 8 * 1024 * 1024,
  blobPartBytes: 4 * 1024 * 1024,
  maxLayouts: 6
});

export class HlsError extends Error {
  constructor(code, detail = '', extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'HlsError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Codes that mean "this source cannot be saved by this feature" (the feedback category unsupported_source), as against failures of an attempt.
export const UNSUPPORTED_CODES = Object.freeze(['UNSUPPORTED_LAYOUT', 'UNSUPPORTED_CODEC', 'UNSUPPORTED_ENCRYPTED', 'UNSUPPORTED_TIMING', 'TOO_LARGE']);

// ---- addresses -------------------------------------------------------------------------------------------------------------------------------------

const ASSET = /^[A-Za-z0-9_-]{1,64}$/;

function parseUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'v.redd.it' && !u.username && !u.password && !u.port ? u : null;
  } catch (_) {
    return null;
  }
}

// The master playlist address of a post video: https://v.redd.it/<asset>/HLSPlaylist.m3u8 (a query, if the page declares one, is kept as declared)
export function redditHlsMaster(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  const u = parseUrl(raw);
  const m = u && u.pathname.match(/^\/([A-Za-z0-9_-]{1,64})\/HLSPlaylist\.m3u8$/);
  return m && ASSET.test(m[1]) && !u.hash ? { url: u.href, assetId: m[1] } : null;
}

// A child address declared by a playlist: same host, same asset directory, the expected extension
function childUrl(uri, base, assetId, ext) {
  if (typeof uri !== 'string' || !uri || uri.length > 2048) throw new HlsError('UNSUPPORTED_LAYOUT', 'bad playlist URI');
  let u;
  try { u = new URL(uri, base); } catch (_) { throw new HlsError('UNSUPPORTED_LAYOUT', 'bad playlist URI'); }
  const ok = parseUrl(u.href);
  const m = ok && ok.pathname.match(/^\/([A-Za-z0-9_-]{1,64})\/([^/]+)$/);
  if (!m || m[1] !== assetId || !m[2].toLowerCase().endsWith(ext)) throw new HlsError('FOREIGN_SOURCE', 'playlist address outside the asset');
  return ok.href;
}

// ---- playlists -------------------------------------------------------------------------------------------------------------------------------------

function attrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

const lines = (text) => String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

// Master: the variants and the audio renditions it declares. Encryption anywhere refuses the whole source.
export function parseMasterPlaylist(text) {
  const ls = lines(text);
  if (ls[0] !== '#EXTM3U') throw new HlsError('UNSUPPORTED_LAYOUT', 'not a playlist');
  const variants = [];
  const audio = [];
  for (let i = 1; i < ls.length; i++) {
    const l = ls[i];
    if (/^#EXT-X-(?:SESSION-)?KEY\b/.test(l)) throw new HlsError('UNSUPPORTED_ENCRYPTED', 'key declared');
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(l.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) audio.push({ group: a['GROUP-ID'] || '', uri: a.URI, isDefault: a.DEFAULT === 'YES', name: a.NAME || '' });
    } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(l.slice(18));
      const uri = ls[i + 1] && !ls[i + 1].startsWith('#') ? ls[i + 1] : '';
      const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
      variants.push({
        uri,
        bandwidth: Number(a.BANDWIDTH) || 0,
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        codecs: (a.CODECS || '').split(',').map((c) => c.trim()).filter(Boolean),
        audioGroup: a.AUDIO || ''
      });
    }
  }
  return { variants, audio };
}

// The best supported variant: H264 + AAC-LC, the largest picture, then the larger bandwidth (which names the better audio rendition when the video
// playlist is the same), and its own declared audio rendition. Declared audio is never dropped; unknown audio is never called silent.
export function rankLayouts(master) {
  const supported = master.variants.filter((v) => v.uri && v.width > 0 && v.height > 0 && v.audioGroup &&
    v.codecs.some((c) => /^avc1\./i.test(c)) && v.codecs.some((c) => /^mp4a\.40\.2$/i.test(c)));
  if (!supported.length) {
    const anyCodec = master.variants.some((v) => v.codecs.length);
    throw new HlsError(anyCodec ? 'UNSUPPORTED_CODEC' : 'UNSUPPORTED_LAYOUT', 'no H264 + AAC variant with a declared audio rendition');
  }
  supported.sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.bandwidth - a.bandwidth);
  // one entry per video + audio playlist pair. The best variant must have its declared audio rendition (else the source is refused, never swapped for a
  // lower one); a lower variant without one is not a complete layout and is not a candidate.
  const layouts = [];
  supported.forEach((video, i) => {
    const renditions = master.audio.filter((a) => a.group === video.audioGroup);
    if (!renditions.length) {
      if (i === 0) throw new HlsError('UNSUPPORTED_LAYOUT', 'declared audio group has no rendition');
      return;
    }
    const audio = renditions.find((a) => a.isDefault) || renditions[0];
    if (!layouts.some((l) => l.video.uri === video.uri && l.audio.uri === audio.uri)) layouts.push({ video, audio });
  });
  return layouts;
}

export const selectLayout = (master) => rankLayouts(master)[0];

// Media playlist: a finite unencrypted VOD of byte ranges of ONE fMP4 resource, with its init byte range.
export function parseMediaPlaylist(text, limits = LIMITS) {
  const ls = lines(text);
  if (ls[0] !== '#EXTM3U') throw new HlsError('UNSUPPORTED_LAYOUT', 'not a playlist');
  let map = null;
  let endlist = false;
  let pendingDuration = null;
  let pendingRange = null;
  let next = 0;
  const segments = [];
  const parseRange = (value) => {
    const m = /^(\d{1,12})(?:@(\d{1,12}))?$/.exec(value || '');
    if (!m) throw new HlsError('UNSUPPORTED_LAYOUT', 'bad byte range');
    return { length: Number(m[1]), offset: m[2] === undefined ? null : Number(m[2]) };
  };
  for (let i = 1; i < ls.length; i++) {
    const l = ls[i];
    if (endlist) break;
    if (/^#EXT-X-(?:KEY|SESSION-KEY)\b/.test(l)) {
      if (/METHOD=NONE\b/.test(l)) continue;
      throw new HlsError('UNSUPPORTED_ENCRYPTED', 'key declared');
    }
    if (/^#EXT-X-(?:DISCONTINUITY|DISCONTINUITY-SEQUENCE|I-FRAMES-ONLY|PART|PRELOAD-HINT|SERVER-CONTROL|DEFINE|DATERANGE)\b/.test(l)) {
      throw new HlsError('UNSUPPORTED_LAYOUT', l.slice(0, 40));
    }
    if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      if (l.slice(21).trim() !== 'VOD') throw new HlsError('UNSUPPORTED_LAYOUT', 'not a VOD');
    } else if (l.startsWith('#EXT-X-MAP:')) {
      if (map || segments.length) throw new HlsError('UNSUPPORTED_LAYOUT', 'more than one init segment');
      const a = attrs(l.slice(11));
      const r = parseRange(a.BYTERANGE);
      if (!a.URI || r.offset === null) throw new HlsError('UNSUPPORTED_LAYOUT', 'init segment without a byte range');
      map = { uri: a.URI, offset: r.offset, length: r.length };
    } else if (l.startsWith('#EXTINF:')) {
      const d = Number(l.slice(8).split(',')[0]);
      if (!Number.isFinite(d) || d <= 0 || d > limits.maxSegmentSeconds) throw new HlsError('UNSUPPORTED_TIMING', 'bad segment duration');
      pendingDuration = d;
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseRange(l.slice(17).trim());
    } else if (l === '#EXT-X-ENDLIST') {
      endlist = true;
    } else if (!l.startsWith('#')) {
      if (pendingDuration === null || !pendingRange) throw new HlsError('UNSUPPORTED_LAYOUT', 'segment without duration or byte range');
      const offset = pendingRange.offset === null ? next : pendingRange.offset;
      next = offset + pendingRange.length;
      segments.push({ uri: l, offset, length: pendingRange.length, duration: pendingDuration });
      pendingDuration = null;
      pendingRange = null;
      if (segments.length > limits.maxSegments) throw new HlsError('TOO_LARGE', 'too many segments');
    }
  }
  if (!endlist) throw new HlsError('UNSUPPORTED_LAYOUT', 'not finite (no ENDLIST)');
  if (!map || segments.length === 0) throw new HlsError('UNSUPPORTED_LAYOUT', 'no init segment or segments');
  if (segments.some((s) => s.uri !== map.uri)) throw new HlsError('UNSUPPORTED_LAYOUT', 'more than one resource');
  let end = map.offset + map.length;
  for (const s of segments) {
    if (s.length <= 0 || s.offset < end) throw new HlsError('UNSUPPORTED_LAYOUT', 'overlapping or empty ranges');
    end = s.offset + s.length;
    if (!Number.isSafeInteger(end)) throw new HlsError('TOO_LARGE', 'unsafe declared range');
  }
  const durationSec = segments.reduce((a, s) => a + s.duration, 0);
  if (!(durationSec > 0) || durationSec > limits.maxDurationSeconds) throw new HlsError('UNSUPPORTED_TIMING', 'bad total duration');
  const parsed = { map, segments, durationSec, resourceUri: map.uri, endOffset: end };
  // The byte budget is judged last, after every other invariant held: the refusal carries the fully validated playlist, so a caller may still check what
  // it declares (its resource address, the pair's duration) before it lets the budget decide a fallback.
  if (end > limits.inputBytes) throw new HlsError('TOO_LARGE', 'declared range beyond the input limit', { budget: true, playlist: parsed });
  return parsed;
}

// ---- bounded network -------------------------------------------------------------------------------------------------------------------------------

// One request: response headers within headerMs, no silence longer than inactivityMs, no redirect, only the exact declared address, a counted body.
// `bytes` mode reads the declared Content-Length into one preallocated buffer (never more, never less); text mode is capped at maxBytes.
async function request(ctx, url, { mode, maxBytes, minBytes = 0, accept, typeOk, alloc }) {
  if (ctx.signal.aborted) throw ctx.signal.reason instanceof HlsError ? ctx.signal.reason : new HlsError('ABORTED');
  const abort = new AbortController();
  const onAbort = () => abort.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const fail = (e) => { throw ctx.signal.aborted && ctx.signal.reason instanceof HlsError ? ctx.signal.reason : (e instanceof HlsError ? e : new HlsError('NETWORK', e && e.name ? e.name : 'request failed')); };
  let timer = setTimeout(() => abort.abort(new HlsError('TIMEOUT', 'response headers')), ctx.limits.headerMs);
  const rearm = (ms, what) => { clearTimeout(timer); timer = setTimeout(() => abort.abort(new HlsError('TIMEOUT', what)), ms); };
  try {
    let res;
    try {
      res = await ctx.fetchImpl(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: accept }, signal: abort.signal });
    } catch (e) {
      if (abort.signal.aborted && abort.signal.reason instanceof HlsError) throw abort.signal.reason;
      return fail(e);
    }
    clearTimeout(timer);
    if (res.redirected === true || (res.url && res.url !== url)) throw new HlsError('FOREIGN_SOURCE', 'redirected');
    if (res.status !== 200) throw new HlsError('HTTP_ERROR', String(res.status), { status: res.status });
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (!typeOk(type)) throw new HlsError(mode === 'bytes' ? 'INVALID_MEDIA' : 'UNSUPPORTED_LAYOUT', 'unexpected content type');
    let target = null;
    let buffer = null;
    let at = 0;
    const chunks = [];
    if (mode === 'bytes') {
      const enc = String(res.headers.get('content-encoding') || '').trim().toLowerCase();
      if (enc && enc !== 'identity') throw new HlsError('INVALID_MEDIA', 'encoded body');
      const len = Number(res.headers.get('content-length'));
      if (!Number.isSafeInteger(len) || len <= 0) throw new HlsError('INVALID_MEDIA', 'no declared length');
      if (len < minBytes) throw new HlsError('INCOMPLETE', 'shorter than the playlist range');
      if (len > maxBytes) throw new HlsError('TOO_LARGE', 'resource beyond the input limit');
      buffer = alloc(len);
      target = new Uint8Array(buffer);
    }
    const reader = res.body.getReader();
    for (;;) {
      rearm(ctx.limits.inactivityMs, 'no data');
      const { value, done } = await reader.read();
      clearTimeout(timer);
      if (done) break;
      if (mode === 'bytes') {
        if (at + value.length > target.length) { abort.abort(new HlsError('INVALID_MEDIA', 'more bytes than declared')); throw abort.signal.reason; }
        ctx.inputBytes += value.length;
        if (ctx.inputBytes > ctx.limits.inputBytes) { abort.abort(new HlsError('TOO_LARGE', 'input limit')); throw abort.signal.reason; }
        target.set(value, at);
        at += value.length;
      } else {
        at += value.length;
        if (at > maxBytes) { abort.abort(new HlsError('TOO_LARGE', 'playlist beyond its limit')); throw abort.signal.reason; }
        chunks.push(value);
      }
    }
    if (mode === 'bytes') {
      if (at !== target.length) throw new HlsError('INCOMPLETE', 'body ended early');
      return { buffer, view: target };
    }
    const joined = new Uint8Array(at);
    let o = 0;
    for (const c of chunks) { joined.set(c, o); o += c.length; }
    return new TextDecoder('utf-8').decode(joined);
  } catch (e) {
    try { abort.abort(); } catch (_) {}
    if (e instanceof HlsError) throw e;
    return fail(e);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

const isPlaylistType = (t) => /mpegurl|text\/plain|octet-stream/.test(t);
const isMp4Type = (t) => /^video\/mp4\b|^application\/octet-stream\b/.test(t);

// ---- the pinned muxer ------------------------------------------------------------------------------------------------------------------------------

let mp4boxPromise = null;
export function loadMp4box() {
  if (!mp4boxPromise) mp4boxPromise = import('./vendor/mp4box/2.4.1/mp4box.all.mjs');
  return mp4boxPromise;
}

// The resource was received straight into a library buffer (no second copy). The file is parsed with discardMdatData: the library builds the sample
// tables (offset, size, DTS, CTS, duration, sync) and keeps no copy of the payload; the payload is read from the received bytes by offset.
function parseResource(M, received, label) {
  const file = M.createFile(false);
  let info = null;
  let error = null;
  file.onReady = (i) => { info = i; };
  file.onError = (e) => { error = e; };
  received.buffer.fileStart = 0;
  try {
    file.appendBuffer(received.buffer, true);
  } catch (e) {
    error = e;
  }
  if (error || !info || !file.moov) throw new HlsError('INVALID_MEDIA', `${label}: container not parseable`);
  return { file, info, bytes: received.view };
}

// What the resource really contains against what its playlist declared. Anything else is a refusal, never a partial save.
function checkResource(res, spec, limits) {
  const { file, info, bytes } = res;
  const label = spec.kind;
  if (info.isFragmented !== true || info.tracks.length !== 1) throw new HlsError('UNSUPPORTED_LAYOUT', `${label}: not a single-track fragmented file`);
  if (file.moov.boxes.some((b) => b.type === 'pssh')) throw new HlsError('UNSUPPORTED_ENCRYPTED', `${label}: protection system box`);
  const trak = file.moov.traks[0];
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  if (!entry || (entry.boxes || []).some((b) => b.type === 'sinf') || !/^(avc1|mp4a)$/.test(entry.type)) throw new HlsError('UNSUPPORTED_ENCRYPTED', `${label}: sample entry ${entry && entry.type}`);
  const track = info.tracks[0];
  if (spec.kind === 'video' && !(entry.type === 'avc1' && /^avc1\./.test(track.codec || ''))) throw new HlsError('UNSUPPORTED_CODEC', `${label}: ${track.codec}`);
  if (spec.kind === 'audio' && !(entry.type === 'mp4a' && track.codec === 'mp4a.40.2')) throw new HlsError('UNSUPPORTED_CODEC', `${label}: ${track.codec}`);
  const ts = trak.mdia.mdhd.timescale;
  if (!(ts > 0)) throw new HlsError('INVALID_MEDIA', `${label}: no timescale`);
  // the playlist's ranges are the fragments
  const segs = spec.playlist.segments;
  const moofs = file.moofs;
  const mdats = file.mdats;
  if (moofs.length !== segs.length || mdats.length !== segs.length) throw new HlsError('INCOMPLETE', `${label}: ${moofs.length} fragments of ${segs.length} declared`);
  for (let k = 0; k < segs.length; k++) {
    if (moofs[k].start !== segs[k].offset || mdats[k].start !== moofs[k].start + moofs[k].size || mdats[k].start + mdats[k].size !== segs[k].offset + segs[k].length) {
      throw new HlsError('INCOMPLETE', `${label}: fragment ${k} does not match its declared range`);
    }
  }
  const initEnd = spec.playlist.map.offset + spec.playlist.map.length;
  if (file.moov.start + file.moov.size > initEnd) throw new HlsError('INVALID_MEDIA', `${label}: init segment shorter than the movie box`);
  // samples: complete, ordered, in the file
  const samples = trak.samples;
  if (!samples.length) throw new HlsError('INCOMPLETE', `${label}: no samples`);
  let prev = -1;
  let sum = 0;
  for (const s of samples) {
    if (!(s.size > 0) || !(s.duration > 0) || s.dts <= prev || s.offset + s.size > bytes.length) throw new HlsError('INVALID_MEDIA', `${label}: sample table`);
    prev = s.dts;
    sum += s.duration;
  }
  if (samples[0].dts !== 0) throw new HlsError('UNSUPPORTED_TIMING', `${label}: timeline does not start at zero`);
  const last = samples[samples.length - 1];
  if (last.dts + last.duration !== sum) throw new HlsError('INVALID_MEDIA', `${label}: gaps in the timeline`);
  const durationSec = sum / ts;
  if (Math.abs(durationSec - spec.playlist.durationSec) > limits.toleranceSeconds) throw new HlsError('INCOMPLETE', `${label}: ${durationSec.toFixed(1)} s of ${spec.playlist.durationSec.toFixed(1)} s declared`);
  // edit list: none, or one plain edit that skips the priming at the start (media_time >= 0, rate 1)
  const edits = (trak.edts && trak.edts.elst && trak.edts.elst.entries) || [];
  let mediaTime = 0;
  if (edits.length) {
    const e = edits[0];
    if (edits.length !== 1 || !(e.media_time >= 0) || e.media_rate_integer !== 1 || e.media_rate_fraction !== 0 || e.media_time >= sum) throw new HlsError('UNSUPPORTED_TIMING', `${label}: edit list`);
    mediaTime = e.media_time;
  }
  const out = { file, trak, entry, samples, ts, sum, durationSec, mediaTime, track, bytes };
  if (spec.kind === 'video') {
    if (!(track.track_width > 0 && track.track_height > 0 && track.track_width <= 16384 && track.track_height <= 16384)) throw new HlsError('INVALID_MEDIA', 'video: picture size');
  } else if (!(entry.channel_count > 0 && entry.samplerate > 0)) {
    throw new HlsError('INVALID_MEDIA', 'audio: sample entry');
  }
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Both tracks into one regular (non-fragmented) MP4: ftyp, moov with ordinary sample tables, one mdat. The library writes every box; this function chooses
// the interleaving (chunks of ~groupSeconds of video from a sync sample, with the audio up to that time) and fills the tables from the samples exactly as
// parsed: stts/ctts/stsz/stss, stsc/stco for the chunks, the same edit list per track. The moov precedes the mdat, so a player can start without the tail.
async function remux(M, v, a, ctx) {
  const B = M.BoxParser.box;
  const { limits } = ctx;
  const movieTs = 1000;
  const tracks = [{ id: 1, kind: 'video', src: v }, { id: 2, kind: 'audio', src: a }];
  for (const t of tracks) {
    t.presentation = Math.max(0, t.src.sum - t.src.mediaTime);
    t.movieDuration = Math.round(t.presentation / t.src.ts * movieTs);
  }
  const movieDuration = Math.max(tracks[0].movieDuration, tracks[1].movieDuration);
  const [vt, at] = tracks;
  const vS = vt.src.samples;
  const aS = at.src.samples;

  // 1. the plan: chunks (a video chunk, then the audio chunk up to the next video chunk), by counts only
  const groups = [];
  let vi = 0;
  let ai = 0;
  while (vi < vS.length || ai < aS.length) {
    if (ctx.signal.aborted) throw ctx.signal.reason instanceof HlsError ? ctx.signal.reason : new HlsError('ABORTED');
    // the video part of the group: ~groupSeconds from a sync sample, never beyond groupBytes
    let vEnd = vi;
    let dur = 0;
    let bytes = 0;
    while (vEnd < vS.length) {
      const s = vS[vEnd];
      if (vEnd > vi && ((dur >= limits.groupSeconds * vt.src.ts && s.is_sync) || bytes + s.size > limits.groupBytes)) break;
      dur += s.duration;
      bytes += s.size;
      vEnd++;
    }
    const boundary = vEnd < vS.length ? vS[vEnd].dts / vt.src.ts : Infinity;
    let aEnd = ai;
    let abytes = 0;
    while (aEnd < aS.length && aS[aEnd].dts / at.src.ts < boundary && abytes < limits.groupBytes) { abytes += aS[aEnd].size; aEnd++; }
    groups.push({ vFrom: vi, vTo: vEnd, aFrom: ai, aTo: aEnd });
    vi = vEnd;
    ai = aEnd;
  }
  const payloadBytes = vS.reduce((n, s) => n + s.size, 0) + aS.reduce((n, s) => n + s.size, 0);

  // 2. the movie box: the tracks as the source declared them, with their sample tables filled
  const out = M.createFile();
  out.init({ brands: ['isom', 'iso2', 'avc1', 'mp41'], timescale: movieTs, duration: movieDuration });
  out.moov.mvhd.volume = 1;
  for (const t of tracks) {
    const se = t.src.entry;
    const common = { id: t.id, timescale: t.src.ts, language: 'und', duration: t.movieDuration, media_duration: t.src.sum, description_boxes: se.boxes || [] };
    if (t.kind === 'video') {
      out.addTrack({ ...common, type: 'avc1', width: se.width, height: se.height, hdlr: 'vide', name: 'VideoHandler' });
    } else {
      out.addTrack({ ...common, type: 'mp4a', hdlr: 'soun', name: 'SoundHandler', channel_count: se.channel_count, samplesize: se.samplesize, samplerate: se.samplerate });
    }
    t.trak = out.getTrackById(t.id);
    t.entry = t.trak.mdia.minf.stbl.stsd.entries[0];
    t.trak.tkhd.volume = t.kind === 'audio' ? 1 : 0;
    if (t.kind === 'audio') {
      t.trak.tkhd.width = 0;
      t.trak.tkhd.height = 0;
    } else {
      for (const k of ['horizresolution', 'vertresolution', 'frame_count', 'compressorname', 'depth']) if (se[k] !== undefined) t.entry[k] = se[k];
      t.trak.tkhd.width = t.src.trak.tkhd.width;
      t.trak.tkhd.height = t.src.trak.tkhd.height;
    }
    // presentation offsets: the same single edit (media time in this track's own timescale), its length in the movie timescale
    if (t.src.mediaTime > 0) {
      const edts = new B.edts();
      const elst = new B.elst();
      elst.version = 0;
      elst.flags = 0;
      elst.entries = [{ segment_duration: t.movieDuration, media_time: t.src.mediaTime, media_rate_integer: 1, media_rate_fraction: 0 }];
      edts.addBox(elst);
      t.trak.addBox(edts);
      // the edit box belongs between the track header and the media box (addBox appends it last)
      t.trak.boxes = [t.trak.tkhd, edts, ...t.trak.boxes.filter((b) => b !== t.trak.tkhd && b !== edts)];
    }
    // addTrack adds a language box with a placeholder; the source has none
    const mdia = t.trak.mdia;
    mdia.boxes = mdia.boxes.filter((b) => b.type !== 'elng');
    mdia.elng = undefined;

    // the ordinary sample tables
    const stbl = t.trak.mdia.minf.stbl;
    const samples = t.src.samples;
    const chunks = groups.map((g) => (t === vt ? [g.vFrom, g.vTo] : [g.aFrom, g.aTo])).filter(([from, to]) => to > from);
    t.chunks = chunks;
    const runs = (values) => { // [value, count] runs
      const r = [];
      for (const x of values) { if (r.length && r[r.length - 1][0] === x) r[r.length - 1][1]++; else r.push([x, 1]); }
      return r;
    };
    const stts = stbl.stts;
    const durations = runs(samples.map((s) => s.duration));
    stts.sample_counts = durations.map((r) => r[1]);
    stts.sample_deltas = durations.map((r) => r[0]);
    stbl.stsz.sample_size = 0;
    stbl.stsz.sample_sizes = samples.map((s) => s.size);
    const perChunk = runs(chunks.map(([from, to]) => to - from));
    const stsc = stbl.stsc;
    stsc.first_chunk = [];
    stsc.samples_per_chunk = perChunk.map((r) => r[0]);
    stsc.sample_description_index = perChunk.map(() => 1);
    let chunkNo = 1;
    for (const r of perChunk) { stsc.first_chunk.push(chunkNo); chunkNo += r[1]; }
    stbl.stco.chunk_offsets = chunks.map(() => 0); // the real offsets once the movie box has its size
    const offsets = runs(samples.map((s) => s.cts - s.dts));
    const extra = [];
    if (t.kind === 'video' && samples.some((s) => !s.is_sync)) {
      const stss = new B.stss();
      stss.sample_numbers = [];
      samples.forEach((s, i) => { if (s.is_sync) stss.sample_numbers.push(i + 1); });
      extra.push(stss);
    }
    if (offsets.some((r) => r[0] !== 0)) {
      const ctts = new B.ctts();
      ctts.sample_counts = offsets.map((r) => r[1]);
      ctts.sample_offsets = offsets.map((r) => r[0]);
      extra.push(ctts);
    }
    for (const b of extra) stbl.addBox(b);
    const order = ['stsd', 'stts', 'stss', 'ctts', 'stsc', 'stsz', 'stco'];
    stbl.boxes = order.map((type) => stbl.boxes.find((b) => b.type === type)).filter(Boolean);
  }
  // a regular file has no mvex (addTrack needed it for its trex), and mvhd leads the movie box (init puts the fragment extension box first)
  out.moov.boxes = out.moov.boxes.filter((b) => b.type !== 'mvex');
  out.moov.mvex = undefined;
  const head = () => { const s = out.getBuffer(); return new Uint8Array(s.buffer, 0, s.byteLength).slice(); };
  const sized = head();
  // the media data follows the movie box and the 8-byte mdat header; the offsets are inside the output bounds before any payload is read
  const total = sized.length + 8 + payloadBytes;
  if (total > limits.outputBytes) throw new HlsError('TOO_LARGE', 'output beyond its limit');
  let at0 = sized.length + 8;
  for (const g of groups) {
    for (const t of tracks) {
      const range = t === vt ? [g.vFrom, g.vTo] : [g.aFrom, g.aTo];
      if (range[1] <= range[0]) continue;
      t.offsets = t.offsets || [];
      t.offsets.push(at0);
      for (let i = range[0]; i < range[1]; i++) at0 += t.src.samples[i].size;
    }
  }
  for (const t of tracks) t.trak.mdia.minf.stbl.stco.chunk_offsets = t.offsets;
  const initBytes = head();
  if (initBytes.length !== sized.length) throw new HlsError('INVALID_MEDIA', 'movie box size changed');
  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, 8 + payloadBytes);
  mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4);

  // 3. the payload, chunk by chunk, in Blob parts (the source bytes are viewed, not copied, until a part is closed)
  let parts = [];
  let partBytes = 0;
  const blobs = [];
  const emitted = { video: 0, audio: 0 };
  for (const g of groups) {
    if (ctx.signal.aborted) throw ctx.signal.reason instanceof HlsError ? ctx.signal.reason : new HlsError('ABORTED');
    for (const t of tracks) {
      const [from, to] = t === vt ? [g.vFrom, g.vTo] : [g.aFrom, g.aTo];
      for (let i = from; i < to; i++) {
        const s = t.src.samples[i];
        const data = t.src.bytes.subarray(s.offset, s.offset + s.size);
        if (data.byteLength !== s.size) throw new HlsError('INCOMPLETE', `${t.kind}: sample ${i} data missing`);
        parts.push(data);
        partBytes += s.size;
        emitted[t.kind]++;
        if (partBytes >= limits.blobPartBytes) { blobs.push(new Blob(parts)); parts = []; partBytes = 0; }
      }
    }
    await tick();
  }
  if (parts.length) blobs.push(new Blob(parts));
  if (emitted.video !== vS.length || emitted.audio !== aS.length) throw new HlsError('INCOMPLETE', 'not every sample was written');
  const blob = new Blob([initBytes, mdatHeader, ...blobs], { type: 'video/mp4' });
  if (blob.size !== total) throw new HlsError('INVALID_MEDIA', 'output size differs from its plan');
  return {
    blob, size: blob.size, durationSec: movieDuration / movieTs, fragments: 0,
    video: { codec: vt.src.track.codec, width: vt.src.track.track_width, height: vt.src.track.track_height, samples: vS.length },
    audio: { codec: at.src.track.codec, sampleRate: at.src.entry.samplerate, channels: at.src.entry.channel_count, samples: aS.length }
  };
}

// ---- the whole assembly ----------------------------------------------------------------------------------------------------------------------------

let active = false;
export const isAssembling = () => active;

// Test-only access (evidence on an actual saved file whose two tracks share one resource): the packaging step itself, nothing else.
export const __packagingForTests = remux;

/**
 * options: { masterUrl, fetchImpl?, signal?, limits? (partial override, tests only), mp4box? (loader) }
 * Resolves { blob, size, durationSec, fragments, video, audio }; rejects with an HlsError. Only one assembly runs at a time ('BUSY').
 */
export async function assembleRedditHls(options = {}) {
  const limits = Object.freeze({ ...LIMITS, ...(options.limits || {}) });
  const master = redditHlsMaster(options.masterUrl);
  if (!master) throw new HlsError('FOREIGN_SOURCE', 'not a Reddit HLS master address');
  if (active) throw new HlsError('BUSY');
  active = true;
  const total = new AbortController();
  const outer = options.signal;
  const onOuter = () => total.abort(outer.reason instanceof HlsError ? outer.reason : new HlsError('ABORTED'));
  if (outer) { if (outer.aborted) onOuter(); else outer.addEventListener('abort', onOuter, { once: true }); }
  const deadline = setTimeout(() => total.abort(new HlsError('TIMEOUT', 'total deadline')), limits.totalMs);
  const ctx = { fetchImpl: options.fetchImpl || globalThis.fetch.bind(globalThis), signal: total.signal, limits, inputBytes: 0 };
  try {
    const text = (url) => request(ctx, url, { mode: 'text', maxBytes: limits.playlistBytes, accept: 'application/vnd.apple.mpegurl, */*', typeOk: isPlaylistType });
    const layouts = rankLayouts(parseMasterPlaylist(await text(master.url))).slice(0, limits.maxLayouts);
    // Each playlist is read and parsed once (a refusal is remembered too). A layout is fully validated first (both playlists, their resource addresses, the
    // pair's duration); only then may a byte-budget overflow (a declared range or the video + audio sum beyond the input limit) move on to the next best
    // complete layout. Every other failure ends the save, whatever layout it concerns. No media body is requested before a valid fitting layout is chosen.
    const seen = new Map();
    const playlist = (url) => {
      if (!seen.has(url)) seen.set(url, text(url).then((t) => parseMediaPlaylist(t, limits)).then((v) => ({ v }), (e) => ({ e })));
      return seen.get(url).then((r) => { if (r.e) throw r.e; return r.v; });
    };
    let chosen = null;
    for (const layout of layouts) {
      const vUrl = childUrl(layout.video.uri, master.url, master.assetId, '.m3u8');
      const aUrl = childUrl(layout.audio.uri, master.url, master.assetId, '.m3u8');
      // a budget refusal still hands over the validated playlist; anything else ends the save here
      const inspect = (url) => playlist(url).then((p) => ({ p, over: false }), (e) => {
        if (e instanceof HlsError && e.budget === true && e.playlist) return { p: e.playlist, over: true };
        throw e;
      });
      const v = await inspect(vUrl);
      const vResource = childUrl(v.p.resourceUri, vUrl, master.assetId, '.mp4'); // an address check needs no request: before the audio playlist is read
      const a = await inspect(aUrl);
      const aResource = childUrl(a.p.resourceUri, aUrl, master.assetId, '.mp4');
      if (Math.abs(v.p.durationSec - a.p.durationSec) > limits.toleranceSeconds) throw new HlsError('INCOMPLETE', 'video and audio playlists differ in length');
      if (v.over || a.over || v.p.endOffset + a.p.endOffset > limits.inputBytes) continue;
      chosen = { vPlaylist: v.p, aPlaylist: a.p, vResource, aResource };
      break;
    }
    if (!chosen) throw new HlsError('TOO_LARGE', 'no supported layout fits the input limit');
    const { vPlaylist, aPlaylist, vResource, aResource } = chosen;
    const M = await (options.mp4box || loadMp4box)();
    const bytes = (url, minBytes) => request(ctx, url, { mode: 'bytes', maxBytes: limits.inputBytes - ctx.inputBytes, minBytes, accept: 'video/mp4, */*', typeOk: isMp4Type, alloc: (n) => new M.MP4BoxBuffer(n) });
    let video = checkResource(parseResource(M, await bytes(vResource, vPlaylist.endOffset), 'video'), { kind: 'video', playlist: vPlaylist }, limits);
    let audio = checkResource(parseResource(M, await bytes(aResource, aPlaylist.endOffset), 'audio'), { kind: 'audio', playlist: aPlaylist }, limits);
    if (Math.abs(video.durationSec - audio.durationSec) > limits.toleranceSeconds) throw new HlsError('INCOMPLETE', 'video and audio differ in length');
    const result = await remux(M, video, audio, ctx);
    video = audio = null;
    return result;
  } catch (e) {
    if (e instanceof HlsError) throw e;
    if (total.signal.aborted && total.signal.reason instanceof HlsError) throw total.signal.reason;
    throw new HlsError('INVALID_MEDIA', e && e.message ? String(e.message).slice(0, 80) : 'muxer failure');
  } finally {
    clearTimeout(deadline);
    if (outer) outer.removeEventListener('abort', onOuter);
    total.abort(new HlsError('ABORTED', 'finished'));
    active = false;
  }
}
