'use strict';
// Manual acceptance fixture for GEN-01 (A: frame ownership, B: selected image/page-metadata/relative URLs, C: direct video,
// CSS: CSS backgrounds and simple overlays that have no <img>/<video> menu context).
// Standalone, zero dependencies, loopback only; not loaded by the extension.
//
//   start : node tools/gen01-frame-acceptance-server.js [port]        (default 8765; Ctrl+C stops it)
//   stop  : node tools/gen01-frame-acceptance-server.js --stop [port]  (or Ctrl+C in the server window)
//   check : node tools/gen01-frame-acceptance-server.js --self-check [--fault=wrong-mime|bad-body]
//           validates every asset body, routes and the case traps; non-zero exit on any failure (hard 30 s limit)
//
// Open http://localhost:<port>/ in the Chrome profile that has the extension loaded.
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === name || a.startsWith(name + '='));
const SELF_CHECK = Boolean(flag('--self-check'));
const STOP = Boolean(flag('--stop'));
const FAULT = (flag('--fault') || '').split('=')[1] || '';
const positional = args.filter((a) => !a.startsWith('--'));
let PORT = Number(positional[0] || process.env.PORT || (SELF_CHECK ? 0 : 8765));
let ORIGIN = `http://localhost:${PORT}`;
let CROSS = `http://127.0.0.1:${PORT}`;
const FIXTURES = path.join(__dirname, 'gen01-fixtures');

// ---- tiny 5x7 bitmap font (letters, digits and space) ----
const FONT = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110', J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110', P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  1: '00100 01100 00100 00100 00100 00100 01110', 2: '01110 10001 00001 00010 00100 01000 11111',
  3: '11110 00001 00001 01110 00001 00001 11110', 4: '00010 00110 01010 10010 11111 00010 00010',
  ' ': '00000 00000 00000 00000 00000 00000 00000'
};

// Indexed bitmap: background index `bg`, text index `fg`; text is centred and scaled to fit.
function raster(width, height, text, bg, fg) {
  const px = new Uint8Array(width * height).fill(bg);
  const cols = text.length * 6 - 1;
  const scale = Math.max(1, Math.floor(Math.min((width * 0.9) / cols, (height * 0.5) / 7)));
  const x0 = Math.floor((width - cols * scale) / 2);
  const y0 = Math.floor((height - 7 * scale) / 2);
  [...text].forEach((ch, n) => {
    const rows = (FONT[ch] || FONT[' ']).split(' ');
    rows.forEach((row, ry) => [...row].forEach((bit, rx) => {
      if (bit !== '1') return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const x = x0 + (n * 6 + rx) * scale + dx;
        const y = y0 + ry * scale + dy;
        if (x >= 0 && x < width && y >= 0 && y < height) px[y * width + x] = fg;
      }
    }));
  });
  return px;
}

// ---- PNG (RGB) ----
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
function png(width, height, text, bgRgb, fgRgb = [255, 255, 255]) {
  const idx = raster(width, height, text, 0, 1);
  const pal = [bgRgb, fgRgb];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pal[idx[y * width + x]], y * (width * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- animated GIF89a (4-colour palette, LZW as in common encoders) ----
function lzw(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1, table = new Map(), cur = 0, bits = 0;
  const out = [];
  const emit = (code) => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (prefix << 8) | k;
    if (table.has(key)) { prefix = table.get(key); continue; }
    emit(prefix);
    if (next === 4096) { emit(clear); size = minCode + 1; next = eoi + 1; table = new Map(); }
    else { if (next >= (1 << size)) size++; table.set(key, next++); }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return Buffer.from(out);
}
function gif(width, height, text, bgColors) {
  const palette = [...bgColors, [255, 255, 255]]; // index 3 = white text
  const head = Buffer.alloc(13);
  head.write('GIF89a'); head.writeUInt16LE(width, 6); head.writeUInt16LE(height, 8); head[10] = 0x80 | 1;
  const parts = [head, Buffer.from(palette.flat()), Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0])];
  bgColors.forEach((_, i) => {
    const gce = Buffer.from([0x21, 0xf9, 4, 0, 50, 0, 0, 0]);
    const desc = Buffer.alloc(10); desc[0] = 0x2c; desc.writeUInt16LE(width, 5); desc.writeUInt16LE(height, 7);
    const data = lzw(raster(width, height, text, i, 3), 2);
    const blocks = [];
    for (let p = 0; p < data.length; p += 255) blocks.push(Buffer.from([Math.min(255, data.length - p)]), data.subarray(p, p + 255));
    parts.push(gce, desc, Buffer.from([2]), ...blocks, Buffer.from([0]));
  });
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// ---- assets: path -> { type, body, kind } ----
const RED = [200, 30, 30], BLUE = [30, 60, 200], GREEN = [20, 140, 50], GRAY = [90, 90, 90], ORANGE = [210, 110, 20],
  TEAL = [20, 130, 130], YELLOW = [150, 130, 10], PURPLE = [120, 60, 150], NAVY = [40, 50, 110];
const ASSETS = {};
const addPng = (p, label, bg, w = 1200, h = 800) => { ASSETS[p] = { type: 'image/png', body: png(w, h, label, bg), kind: 'png' }; };
const addFile = (p, file, type, kind) => { ASSETS[p] = { type, body: fs.readFileSync(path.join(FIXTURES, file)), kind }; };

// A: frame ownership (same preview URL in top page and both frames)
addPng('/preview.png', 'PREVIEW', GRAY, 240, 160);
addPng('/original/top-red.png', 'TOP RED', RED);
addPng('/original/frame-blue.png', 'IFRAME BLUE', BLUE);
addPng('/original/cross-green.png', 'CROSS GREEN', GREEN);
addPng('/plain.png', 'PLAIN', PURPLE, 480, 320);
ASSETS['/anim-top.gif'] = { type: 'image/gif', body: gif(240, 160, 'GIF TOP', [RED, [200, 120, 20], [120, 20, 120]]), kind: 'gif' };
ASSETS['/anim-frame.gif'] = { type: 'image/gif', body: gif(240, 160, 'GIF FRAME', [BLUE, [20, 140, 140], [20, 80, 20]]), kind: 'gif' };
// B1: repeated preview in one frame, page-wide metadata
addPng('/b/shared-preview.png', 'SHARED PREVIEW', GRAY, 240, 160);
addPng('/b/orig-card-one.png', 'CARD ONE', ORANGE);
addPng('/b/orig-card-two.png', 'CARD TWO', TEAL);
addPng('/b/og-banner.png', 'OG BANNER', YELLOW);
[1, 2, 3, 4].forEach((k) => addPng(`/b/gal-${k}.png`, `GALLERY ${k}`, NAVY, 240, 160));
addPng('/b/single-preview.png', 'SINGLE PREVIEW', GRAY, 480, 320);
addPng('/b/single-full.png', 'SINGLE FULL', GREEN);
[1, 2, 3].forEach((k) => addPng(`/b/tiny-${k}.png`, String(k), GRAY, 48, 32));
// B2: ordinary layouts
addPng('/b/pic-small.png', 'PICTURE 400', GRAY, 240, 160);
addFile('/b/pic-large.webp', 'pic-large.webp', 'image/webp', 'webp');
addPng('/b/lazy-preview.png', 'LAZY PREVIEW', GRAY, 240, 160);
addPng('/b/lazy-full.png', 'LAZY FULL', TEAL);
addPng('/b/link-preview.png', 'LINK PREVIEW', GRAY, 240, 160);
addFile('/b/link-full.jpg', 'link-full.jpg', 'image/jpeg', 'jpeg');
addPng('/b/htmllink-preview.png', 'HTML LINK PREVIEW', GRAY, 240, 160);
addPng('/b/signed-preview.png', 'SIGNED PREVIEW', GRAY, 240, 160);
addPng('/b/signed-full.png', 'SIGNED OK', GREEN);
addPng('/b/rel-preview.png', 'REL PREVIEW', GRAY, 240, 160);
addPng('/b/rel/frame-original.png', 'REL FRAME OK', BLUE);
addPng('/rel/frame-original.png', 'REL TOP WRONG', RED);
addPng('/b/base-preview.png', 'BASE PREVIEW', GRAY, 240, 160);
addPng('/b/base/orig.png', 'BASE OK', GREEN);
addPng('/b/orig.png', 'BASE WRONG', RED);
// C: direct video (real MediaRecorder output; see tools/gen01-fixtures)
addFile('/v/video-a.mp4', 'video-a.mp4', 'video/mp4', 'mp4');
addFile('/v/video-b.webm', 'video-b.webm', 'video/webm', 'webm');
addFile('/v/silent-loop.mp4', 'silent-loop.mp4', 'video/mp4', 'mp4');
addPng('/v/poster-a.png', 'POSTER A', RED, 320, 180);
addPng('/v/poster-b.png', 'POSTER B', BLUE, 320, 180);
// Same bytes behind two behaviours of real CDNs: HEAD refused with 503 / generic binary extensionless URL
ASSETS['/v/head-blocked.mp4'] = { type: 'video/mp4', body: ASSETS['/v/video-a.mp4'].body, kind: 'mp4', head503: true };
ASSETS['/v/stream/42'] = { type: 'application/octet-stream', body: ASSETS['/v/silent-loop.mp4'].body, kind: 'mp4' };
// CSS: backgrounds and overlays (page /css.html and its frame /css-frame.html)
addPng('/css/card-a.png', 'CSS CARD A', RED);
addPng('/css/card-b.png', 'CSS CARD B', BLUE);
addPng('/css/ov-preview.png', 'OVERLAY PREVIEW', GRAY, 240, 160);
addPng('/css/ov-full-one.png', 'OVERLAY ONE', ORANGE);
addPng('/css/ov-full-two.png', 'OVERLAY TWO', TEAL);
addPng('/css/ov-bg.png', 'OVERLAY BG', GREEN);
addPng('/css/frame-bg.png', 'FRAME CSS', PURPLE);
addPng('/css/amb-1.png', 'AMBIGUOUS 1', YELLOW);
addPng('/css/amb-2.png', 'AMBIGUOUS 2', NAVY);
addPng('/css/span-left.png', 'LEFT IMAGE', ORANGE, 400, 300);
addPng('/css/span-right.png', 'RIGHT IMAGE', TEAL, 400, 300);
// AVIF: real AV1 still pictures (see tools/gen01-fixtures/avif/README.md for origin, licence and SHA-256); previews are PNG
for (const n of ['direct', 'pic-small', 'pic-large', 'card-one', 'card-two', 'lazy', 'link']) addFile(`/avif/avif-${n}.avif`, `avif/avif-${n}.avif`, 'image/avif', 'avif');
addFile('/avif/rel/avif-frame-rel.avif', 'avif/avif-frame-rel.avif', 'image/avif', 'avif'); // the frame document's own relative target
addFile('/rel/avif-frame-rel.avif', 'avif/avif-wrong-rel.avif', 'image/avif', 'avif'); // what the TOP page's base would resolve to (wrong)
addPng('/avif/pic-fallback.png', 'PICTURE FALLBACK', GRAY, 240, 160);
addPng('/avif/prev-lazy.png', 'LAZY PREVIEW', GRAY, 240, 160);
addPng('/avif/prev-link.png', 'LINK PREVIEW', GRAY, 240, 160);
addPng('/avif/prev-shared.png', 'SHARED PREVIEW', GRAY, 240, 160);
addPng('/avif/prev-swap.png', 'SWAP PREVIEW', GRAY, 240, 160);
addPng('/avif/prev-html.png', 'HTML PREVIEW', GRAY, 240, 160);
addPng('/avif/prev-missing.png', 'MISSING PREVIEW', GRAY, 240, 160);
addPng('/avif/rel-preview.png', 'REL PREVIEW', GRAY, 240, 160);
// an "original" that is really an HTML page served with 200 (and image/avif never claimed); a missing one is simply not served (404)
ASSETS['/avif/html-original.avif'] = { type: 'text/html', body: Buffer.from('<!doctype html><title>not an image</title><p>HTML, not AVIF</p>'), kind: 'html' };
const NOT_SERVED = new Set(['/avif/missing-original.avif', '/dl/missing.png']);
const SPECIAL = new Set(['/dl/error-500.png', '/dl/hang.png', '/dl/ignore-range.png']); // behaviours, not files: checked by their own assertions
// DL: shared-download resilience. A CDN that refuses HEAD but serves AVIF to a bounded GET; bodies that are not media
// (HTML 200, JSON, an error status, a request that never answers) behind an image or video URL; extensionless video URLs.
addFile('/dl/head-blocked.avif', 'avif/avif-direct.avif', 'image/avif', 'avif');
ASSETS['/dl/head-blocked.avif'].head503 = true;
ASSETS['/dl/html-200.png'] = { type: 'text/html', body: Buffer.from('<!doctype html><title>sign in</title><p>please sign in</p>'), kind: 'html' };
ASSETS['/dl/json.png'] = { type: 'application/json', body: Buffer.from('{"error":"forbidden","status":403}'), kind: 'json' };
['html', 'json', '500', 'hang', 'missing', 'range', 'head'].forEach((n) => addPng(`/dl/prev-${n}.png`, `DL PREVIEW ${n.toUpperCase()}`, GRAY, 240, 160));
addFile('/v/stream/43', 'video-b.webm', 'application/octet-stream', 'webm'); // extensionless WebM served as a generic binary
ASSETS['/v/stream/44'] = { type: 'application/octet-stream', body: Buffer.from('<!doctype html><title>not a video</title><p>HTML behind a binary type</p>'), kind: 'html' };
ASSETS['/v/html-video.mp4'] = { type: 'text/html', body: Buffer.from('<!doctype html><title>not a video</title><p>HTML behind an mp4 name</p>'), kind: 'html' };
const IGNORE_RANGE_BYTES = 2 * 1024 * 1024; // /dl/ignore-range.png: HEAD refused, GET ignores Range and streams this much, slowly
const hung = [];
const SIGNED_PATH = '/b/signed-full.png';

// ---- pages: every URL is absolute except the deliberate relative cases (B2) ----
const css = '<style>body{font:14px system-ui;margin:12px;max-width:980px}img,video{display:block;margin:6px 0;border:1px solid #888}iframe{width:300px;height:340px;border:2px dashed #888}.box{margin:10px 0;padding:8px;background:#f4f4f4}.row{display:flex;gap:12px;flex-wrap:wrap}table{border-collapse:collapse}td,th{border:1px solid #999;padding:3px 6px;font-size:13px}</style>';
const page = (title, body, head = '') => `<!doctype html><meta charset="utf-8"><title>${title}</title>${head}${css}${body}`;
const pages = () => {
  const P = `${ORIGIN}/preview.png`;
  const S = `${ORIGIN}/b/shared-preview.png`;
  const ogHead = `<meta property="og:image" content="${ORIGIN}/b/og-banner.png"><meta name="twitter:image" content="${ORIGIN}/b/og-banner.png">`;
  return {
    '/': page('GEN-01 acceptance', `<h3>GEN-01 acceptance pages</h3>
<ul><li><a href="/a.html">A: frame ownership</a></li><li><a href="/b1.html">B1: repeated preview + page metadata (gallery)</a>, <a href="/b1-single.html">single-subject page</a></li>
<li><a href="/b2.html">B2: ordinary image layouts, relative URLs</a></li><li><a href="/c.html">C: direct video</a></li><li><a href="/css.html">CSS background and overlay entry points</a></li><li><a href="/guard.html">GUARD: selected target and availability of the save item</a></li><li><a href="/avif.html">AVIF: real AVIF originals and their nearest negatives</a></li><li><a href="/dl.html">DL: servers that refuse, lie or hang</a></li><li><a href="/menu.html">MENU: the save item is absent outside media and its label follows the click</a></li></ul>
<p>Right-click the media and use the extension's save item. Each page lists the expected file for every click; the console of this server logs every request.</p>`),
    '/a.html': page('GEN-01 A', `<h3>A: frame ownership</h3>
<div class="box"><b>A1. Top page preview (same URL as in the frames)</b><img src="${P}" data-original="${ORIGIN}/original/top-red.png" width="240" height="160"></div>
<div class="box"><b>A2. Same-origin iframe: same preview URL, different original</b><iframe src="${ORIGIN}/frame-same.html"></iframe></div>
<div class="box"><b>A3. Cross-origin iframe (127.0.0.1): same preview URL, different original</b><iframe src="${CROSS}/frame-cross.html"></iframe></div>
<div class="box"><b>A4. Plain image (no original)</b><img src="${ORIGIN}/plain.png" width="240" height="160"></div>
<div class="box"><b>A5. Native GIF on the top page</b><img src="${ORIGIN}/anim-top.gif" width="240" height="160"></div>
<table><tr><th>#</th><th>Right-click</th><th>Expected file</th></tr>
<tr><td>A1</td><td>top preview</td><td>top-red.png (red, TOP RED)</td></tr><tr><td>A2</td><td>preview in same-origin frame</td><td>frame-blue.png (blue)</td></tr>
<tr><td>A3</td><td>preview in cross-origin frame</td><td>cross-green.png (green)</td></tr><tr><td>A4</td><td>plain image</td><td>plain.png (purple)</td></tr>
<tr><td>A5</td><td>top GIF</td><td>anim-top.gif (3 frames)</td></tr><tr><td>A6</td><td>GIF in same-origin frame (below its preview)</td><td>anim-frame.gif (3 frames)</td></tr></table>`),
    '/frame-same.html': page('same-origin frame', `<img src="${P}" data-original="${ORIGIN}/original/frame-blue.png" width="240" height="160">
<img src="${ORIGIN}/anim-frame.gif" width="120" height="80"><div>(frame: preview, then native GIF)</div>`),
    '/frame-cross.html': page('cross-origin frame', `<img src="${P}" data-original="${ORIGIN}/original/cross-green.png" width="240" height="160">`),
    '/b1.html': page('GEN-01 B1 gallery', `<h3>B1: several cards, page-wide og:image</h3>
<div class="box"><b>B1.1/B1.2 Two cards, the SAME preview URL, different originals</b><div class="row">
<div class="box"><img src="${S}" data-original="${ORIGIN}/b/orig-card-one.png" width="240" height="160">card 1</div>
<div class="box"><img src="${S}" data-original="${ORIGIN}/b/orig-card-two.png" width="240" height="160">card 2</div></div></div>
<div class="box"><b>B1.3 Four equal gallery cards (distinct previews, no originals); page og:image/twitter:image is OG BANNER</b><div class="row">
${[1, 2, 3, 4].map((k) => `<img src="${ORIGIN}/b/gal-${k}.png" width="200" height="130">`).join('')}</div></div>
<table><tr><th>#</th><th>Right-click</th><th>Expected file</th><th>Wrong</th></tr>
<tr><td>B1.1</td><td>card 1 preview</td><td>orig-card-one.png (orange)</td><td>orig-card-two.png / og-banner.png</td></tr>
<tr><td>B1.2</td><td>card 2 preview</td><td>orig-card-two.png (teal)</td><td>orig-card-one.png (first card) / og-banner.png</td></tr>
<tr><td>B1.3</td><td>gallery card 3</td><td>gal-3.png (GALLERY 3)</td><td>og-banner.png (yellow OG BANNER)</td></tr></table>
<p>The extension keeps the element of the real right-click (not :hover, which the native menu clears), so B1.1/B1.2 must give each card's own original even after the pointer left the card. Saving shared-preview.png means the capture was not available (tab opened before the extension was reloaded: refresh this tab); saving the other card's original is a failure.</p>`, ogHead),
    '/b1-single.html': page('GEN-01 B1 single subject', `<h3>B1 control: single-subject page (og:image describes this image)</h3>
<img src="${ORIGIN}/b/single-preview.png" width="480" height="320">
<div class="row">${[1, 2, 3].map((k) => `<img src="${ORIGIN}/b/tiny-${k}.png" width="48" height="32">`).join('')}</div>
<table><tr><th>#</th><th>Right-click</th><th>Expected file</th></tr><tr><td>B1.4</td><td>the large preview</td><td>single-full.png (green SINGLE FULL, from og:image)</td></tr></table>`,
      `<meta property="og:image" content="${ORIGIN}/b/single-full.png">`),
    '/b2.html': page('GEN-01 B2 layouts', `<h3>B2: ordinary image layouts</h3>
<div class="row">
<div class="box"><b>B2.1 picture/srcset</b><picture><source srcset="${ORIGIN}/b/pic-small.png 400w, ${ORIGIN}/b/pic-large.webp 1600w" sizes="240px"><img src="${ORIGIN}/b/pic-small.png" width="240" height="160"></picture></div>
<div class="box"><b>B2.2 lazy original attribute</b><img src="${ORIGIN}/b/lazy-preview.png" data-original="${ORIGIN}/b/lazy-full.png" width="240" height="160"></div>
<div class="box"><b>B2.3 link to full JPEG</b><a href="${ORIGIN}/b/link-full.jpg"><img src="${ORIGIN}/b/link-preview.png" width="240" height="160"></a></div>
<div class="box"><b>B2.4 link to an HTML page</b><a href="${ORIGIN}/b/view-page.html"><img src="${ORIGIN}/b/htmllink-preview.png" width="240" height="160"></a></div>
<div class="box"><b>B2.5 signed original (403 without sig)</b><img src="${ORIGIN}/b/signed-preview.png" data-original="${ORIGIN}${SIGNED_PATH}?sig=abc%2Fdef&exp=4102444800" width="240" height="160"></div></div>
<div class="row"><div class="box"><b>B2.6 relative data-original inside an iframe</b><iframe src="${ORIGIN}/b/frame-relative.html"></iframe></div>
<div class="box"><b>B2.7 document with &lt;base href&gt;</b><iframe src="${ORIGIN}/b/base-page.html"></iframe></div></div>
<table><tr><th>#</th><th>Right-click</th><th>Expected file</th><th>Wrong</th></tr>
<tr><td>B2.1</td><td>picture image</td><td>pic-large.webp (purple, real WebP)</td><td>pic-small.png</td></tr>
<tr><td>B2.2</td><td>lazy image</td><td>lazy-full.png (teal)</td><td>lazy-preview.png</td></tr>
<tr><td>B2.3</td><td>linked image</td><td>link-full.jpg (orange, real JPEG)</td><td>link-preview.png</td></tr>
<tr><td>B2.4</td><td>HTML-linked image</td><td>htmllink-preview.png (the image, not the page)</td><td>view-page.html</td></tr>
<tr><td>B2.5</td><td>signed image</td><td>signed-full.png (green SIGNED OK)</td><td>signed-preview.png; log shows ?sig=abc%2Fdef kept</td></tr>
<tr><td>B2.6</td><td>image in relative frame</td><td>frame-original.png (blue REL FRAME OK)</td><td>red REL TOP WRONG</td></tr>
<tr><td>B2.7</td><td>image in base-href frame</td><td>orig.png (green BASE OK)</td><td>red BASE WRONG</td></tr></table>
<p>Not covered here (pending): AVIF (no real AVIF encoder available for the fixture). CSS backgrounds and transparent overlays are on <a href="/css.html">/css.html</a>.</p>`),
    '/b/view-page.html': page('view page', '<p>This is an HTML page, not an image.</p>'),
    '/b/frame-relative.html': page('relative frame', `<img src="rel-preview.png" data-original="rel/frame-original.png" width="240" height="160">`),
    '/b/base-page.html': page('base frame', `<img src="${ORIGIN}/b/base-preview.png" data-original="orig.png" width="240" height="160">`, '<base href="/b/base/">'),
    '/c.html': page('GEN-01 C video', `<h3>C: accessible direct video</h3>
<div class="row">
<div class="box"><b>C1 player A (MP4, audio)</b><video controls preload="metadata" width="320" height="180" poster="${ORIGIN}/v/poster-a.png" src="${ORIGIN}/v/video-a.mp4"></video></div>
<div class="box"><b>C2 player B (WebM, audio, relative source)</b><video controls preload="metadata" width="320" height="180" poster="${ORIGIN}/v/poster-b.png"><source src="/v/video-b.webm" type="video/webm"></video></div>
<div class="box"><b>C3 silent looping MP4</b><video controls muted loop autoplay width="320" height="180" src="${ORIGIN}/v/silent-loop.mp4"></video></div>
<div class="box"><b>C4 CDN that refuses HEAD with 503</b><video controls preload="metadata" width="320" height="180" src="${ORIGIN}/v/head-blocked.mp4"></video></div>
<div class="box"><b>C5 extensionless generic-binary URL</b><video controls preload="metadata" width="320" height="180" src="${ORIGIN}/v/stream/42"></video></div></div>
<table><tr><th>#</th><th>Right-click &rarr; save video</th><th>Expected file</th><th>Wrong</th></tr>
<tr><td>C1</td><td>player A</td><td>video-a.mp4 (red, 440 Hz tone)</td><td>poster-a.png, video-b.webm</td></tr>
<tr><td>C2</td><td>player B</td><td>video-b.webm (blue, 880 Hz tone)</td><td>poster-b.png, video-a.mp4</td></tr>
<tr><td>C3</td><td>silent loop</td><td>silent-loop.mp4 (green, no audio), a video not a GIF</td><td>any .gif</td></tr>
<tr><td>C4</td><td>HEAD-503 player</td><td>head-blocked.mp4 (same picture as C1)</td><td>no download</td></tr>
<tr><td>C5</td><td>extensionless player</td><td>42.mp4 (same picture as C3)</td><td>no download</td></tr></table>
<p>Open each saved video: C1/C2 must carry audio, C3 must not. Not covered (pending, out of scope): blob/MSE, HLS/DASH, DRM players.</p>`),
    '/css.html': page('GEN-01 CSS and overlay', `<style>.cbox{width:240px;height:160px;background-size:cover;border:1px solid #888}.ovc{position:relative;width:240px;height:160px}.ovc img{display:block;margin:0;border:0;width:240px;height:160px}.ov{position:absolute;left:0;top:0;width:240px;height:160px;display:block}.ovc .cbox{border:0}</style>
<h3>CSS backgrounds and simple overlays</h3>
<p>These have no image/video context in the native menu. Right-click, choose <b>Image Saver: Save image</b>. Reload the extension and refresh this page first (the capture script is injected at page load).</p>
<div class="box"><b>CSS1/CSS2 two CSS cards (neighbours)</b><div class="row">
<div><div class="cbox" style="background-image:url(${ORIGIN}/css/card-a.png)"></div>card A</div>
<div><div class="cbox" style="background-image:url(${ORIGIN}/css/card-b.png)"></div>card B</div></div></div>
<div class="box"><b>CSS3/CSS4 transparent overlay over an image; both cards share ONE preview URL (3: overlay is a link, 4: a plain div)</b><div class="row">
<div class="ovc"><img src="${ORIGIN}/css/ov-preview.png" data-original="${ORIGIN}/css/ov-full-one.png"><a class="ov" href="${ORIGIN}/css/item-1"></a></div>
<div class="ovc"><img src="${ORIGIN}/css/ov-preview.png" data-original="${ORIGIN}/css/ov-full-two.png"><div class="ov"></div></div></div></div>
<div class="box"><b>CSS5 transparent overlay over a CSS-background element</b><div class="ovc"><div class="cbox" style="background-image:url(${ORIGIN}/css/ov-bg.png)"></div><div class="ov"></div></div></div>
<div class="box"><b>CSS6 CSS card inside an iframe</b><iframe src="${ORIGIN}/css-frame.html" style="height:200px"></iframe></div>
<div class="box"><b>CSS7 two backgrounds on one element (ambiguous)</b><div class="cbox" style="background-image:url(${ORIGIN}/css/amb-1.png),url(${ORIGIN}/css/amb-2.png)"></div></div>
<div class="box"><b>CSS8 background that changes right after the right-click</b><div class="cbox" id="swap" style="background-image:url(${ORIGIN}/css/card-a.png)"></div></div>
<div class="box"><b>CSS9 overlay card whose original changes right after the right-click</b><div class="ovc" id="swapov"><img src="${ORIGIN}/css/ov-preview.png" data-original="${ORIGIN}/css/ov-full-one.png"><div class="ov"></div></div></div>
<div class="box"><b>CSS12 transparent overlay over a native video whose URL has no extension</b><div class="ovc" style="width:320px;height:180px"><video muted preload="metadata" width="320" height="180" style="display:block;margin:0;border:0" src="${ORIGIN}/v/stream/42"></video><div class="ov" style="width:320px;height:180px"></div></div></div>
<div class="box"><b>CSS13 ONE overlay (400x150) over TWO adjacent images (200x150 each)</b><div class="ovc" style="width:400px;height:150px"><img src="${ORIGIN}/css/span-left.png" style="position:absolute;left:0;top:0;width:200px;height:150px"><img src="${ORIGIN}/css/span-right.png" style="position:absolute;left:200px;top:0;width:200px;height:150px"><div class="ov" style="width:400px;height:150px"></div></div></div>
<div class="box"><b>CSS14 CSS card that moves away right after the right-click</b><div class="cbox" id="mover" style="background-image:url(${ORIGIN}/css/card-a.png)"></div></div>
<div class="box"><b>CSS10 card with a background and a caption inside it</b><div class="cbox" style="background-image:url(${ORIGIN}/css/card-b.png);padding:8px"><span style="background:#fff">caption inside the card</span></div></div>
<div class="box"><b>CSS11 plain area</b><p>Just text, no media: right-click here or on the empty page margin.</p></div>
<table><tr><th>#</th><th>Right-click</th><th>Expected</th><th>Wrong</th></tr>
<tr><td>CSS1</td><td>card A</td><td>card-a.png (red CSS CARD A)</td><td>card-b.png</td></tr>
<tr><td>CSS2</td><td>card B</td><td>card-b.png (blue CSS CARD B)</td><td>card-a.png</td></tr>
<tr><td>CSS3</td><td>overlay of the left card (link)</td><td>ov-full-one.png (orange OVERLAY ONE)</td><td>ov-full-two.png, ov-preview.png</td></tr>
<tr><td>CSS4</td><td>overlay of the right card (div)</td><td>ov-full-two.png (teal OVERLAY TWO)</td><td>ov-full-one.png, ov-preview.png</td></tr>
<tr><td>CSS5</td><td>the overlay</td><td>ov-bg.png (green OVERLAY BG)</td><td>nothing else</td></tr>
<tr><td>CSS6</td><td>the card in the frame</td><td>frame-bg.png (purple FRAME CSS)</td><td>card-a.png / card-b.png</td></tr>
<tr><td>CSS7</td><td>the two-background box</td><td><b>no file</b>, the badge shows ERR</td><td>amb-1.png or amb-2.png</td></tr>
<tr><td>CSS8</td><td>the box (it turns into card B about 0.4 s later)</td><td><b>no file</b> (the target changed), ERR</td><td>card-a.png or card-b.png</td></tr>
<tr><td>CSS9</td><td>the overlay (the image's original flips about 0.4 s later)</td><td><b>no file</b>, ERR</td><td>ov-full-one.png or ov-full-two.png</td></tr>
<tr><td>CSS12</td><td>the overlay over the video</td><td>42.mp4 (a video, same green picture as C3; no extension in the URL)</td><td>no download, or a non-video file</td></tr>
<tr><td>CSS13</td><td>left half, then right half of the overlay</td><td><b>no file</b>, ERR, both times</td><td>span-left.png or span-right.png</td></tr>
<tr><td>CSS14</td><td>the box (it slides far to the right about 0.4 s later)</td><td><b>no file</b> (it is no longer under the click point), ERR</td><td>card-a.png</td></tr>
<tr><td>CSS10</td><td>the caption text</td><td><b>no file</b> (the card's background belongs to an ancestor), ERR</td><td>card-b.png</td></tr>
<tr><td>CSS10b</td><td>the card's padding, not the caption</td><td>card-b.png (blue)</td><td>-</td></tr>
<tr><td>CSS11</td><td>plain text or empty margin</td><td><b>no file</b>, ERR (and no request in the server console)</td><td>any download</td></tr></table>
<p>On x.com / twitter.com this page entry is hidden (X keeps its own entry). The server console must show NO request for the file a case calls wrong.</p>
<script>
(function () {
  var sw = document.getElementById('swap');
  sw.addEventListener('contextmenu', function () {
    sw.style.backgroundImage = 'url(${ORIGIN}/css/card-a.png)';
    setTimeout(function () { sw.style.backgroundImage = 'url(${ORIGIN}/css/card-b.png)'; }, 400);
  });
  var mv = document.getElementById('mover');
  mv.addEventListener('contextmenu', function () {
    mv.style.transform = 'none';
    setTimeout(function () { mv.style.transform = 'translateX(3000px)'; }, 400);
  });
  var ov = document.getElementById('swapov');
  ov.addEventListener('contextmenu', function () {
    var im = ov.querySelector('img');
    im.setAttribute('data-original', '${ORIGIN}/css/ov-full-one.png');
    setTimeout(function () { im.setAttribute('data-original', '${ORIGIN}/css/ov-full-two.png'); }, 400);
  });
})();
</script>`),
    '/guard.html': page('GEN-01 guard', `<style>.cbox{width:240px;height:160px;background-size:cover;border:1px solid #888}.card{width:260px;padding:24px;background:#eef;border:1px solid #88a}.card img{display:block;width:260px;height:120px}.stack{position:relative;width:240px;height:160px}.stack video,.stack img{position:absolute;left:0;top:0;width:240px;height:160px}</style>
<h3>GUARD: what counts as the selected media</h3>
<p>Relative URLs on purpose: open this page as <b>http://localhost:${PORT}/guard.html</b> and again as <b>http://127.0.0.1:${PORT}/guard.html</b>; every result below must be the same on both. Reload the extension and refresh the page first. Chrome has no event before its menu opens, so the save item should be <b>absent</b> (not greyed out) where nothing is selected (best effort); if it is offered and you choose it, it must refuse (ERR) and save nothing.</p>
<div class="box"><b>GD1 caption text</b><p>A caption under a picture. Right-click this sentence.</p></div>
<div class="box"><b>GD2 ordinary navigation link</b><a href="/css/item-1">Read the full article (a page, not a file)</a></div>
<div class="box"><b>GD3 text link straight to an image file</b><a href="/css/ov-full-one.png">Download the picture (a file)</a></div>
<div class="box"><b>GD4 container with an image inside</b><div class="card" id="gd4"><img src="/plain.png" alt="">container padding around the picture</div></div>
<div class="box"><b>GD5 a photo lying above a video</b><div class="stack"><video muted preload="metadata" src="/v/video-a.mp4"></video><img src="/plain.png" alt=""></div></div>
<div class="box"><b>GD6 empty area</b><div style="height:60px"></div></div>
<div class="box"><b>GD8 ordinary image that is removed right after the right-click</b><img id="gd8" src="/plain.png" width="240" height="160" alt=""></div>
<div class="box"><b>GD9 text link to an image file that is removed right after the right-click</b><span id="gd9w"><a id="gd9" href="/css/ov-full-two.png">Download the second picture (a file)</a></span></div>
<div class="box"><b>GD7 background card that is removed right after the right-click</b><div class="cbox" id="gd7" style="background-image:url(/css/card-a.png)"></div></div>
<table><tr><th>#</th><th>Right-click</th><th>Expected</th><th>Wrong</th></tr>
<tr><td>GD1</td><td>the sentence</td><td>save item <b>absent</b> (never greyed out); if chosen: <b>no file</b>, ERR</td><td>any download</td></tr>
<tr><td>GD2</td><td>the link text</td><td>save item <b>absent</b> (never greyed out); if chosen: <b>no file</b>, ERR, no request</td><td>item-1 or any file</td></tr>
<tr><td>GD3</td><td>the link text</td><td>ov-full-one.png (orange OVERLAY ONE), item available</td><td>no download</td></tr>
<tr><td>GD4</td><td>the padding around the picture</td><td><b>no file</b>, ERR (the container is not the target)</td><td>plain.png</td></tr>
<tr><td>GD4b</td><td>the picture itself</td><td>plain.png (purple)</td><td>-</td></tr>
<tr><td>GD5</td><td>the picture above the video</td><td>plain.png (purple), never video-a.mp4</td><td>video-a.mp4</td></tr>
<tr><td>GD6</td><td>the empty area or page margin</td><td>save item <b>absent</b> (never greyed out); if chosen: <b>no file</b>, ERR</td><td>any download</td></tr>
<tr><td>GD7</td><td>the card (it disappears about 0.4 s later; wait at least one second, then choose Save)</td><td><b>no file</b>, ERR</td><td>card-a.png or any other file</td></tr>
<tr><td>GD8</td><td>the picture (it disappears about 0.4 s later; wait at least one second, then choose Save image)</td><td><b>no file</b>, ERR, no request for plain.png</td><td>plain.png</td></tr>
<tr><td>GD9</td><td>the link text (it disappears about 0.4 s later; wait at least one second, then choose Save)</td><td><b>no file</b>, ERR, no request for ov-full-two.png</td><td>ov-full-two.png</td></tr></table>
<p>The server console must show no request for a file a case calls wrong. Not covered here: provider pages (Reddit, X, Pixiv); the shared guard is the same on every host.</p>
<script>
(function () {
  var c = document.getElementById('gd7');
  c.addEventListener('contextmenu', function () { setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 400); });
  ['gd8', 'gd9'].forEach(function (id) {
    var n = document.getElementById(id);
    n.addEventListener('contextmenu', function () { setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 400); });
  });
})();
</script>`),
    '/avif.html': page('GEN-01 AVIF', `<style>.ovc{position:relative}.ovc img{position:absolute;top:0}.ov{position:absolute;left:0;top:0;display:block}</style>
<h3>AVIF: real AV1 still pictures</h3>
<p>Every <code>.avif</code> here is real AVIF (Chromium decodes it); previews are PNG. Reload the extension and refresh this page first. The server console must show no request for a file a case calls wrong.</p>
<div class="row">
<div class="box"><b>AV1 direct AVIF</b><img src="${ORIGIN}/avif/avif-direct.avif" width="240" height="160"></div>
<div class="box"><b>AV2 picture / srcset (AVIF sources, PNG fallback)</b><picture><source type="image/avif" srcset="${ORIGIN}/avif/avif-pic-small.avif 240w, ${ORIGIN}/avif/avif-pic-large.avif 480w" sizes="240px"><img src="${ORIGIN}/avif/pic-fallback.png" width="240" height="160"></picture></div>
<div class="box"><b>AV3 PNG preview with a lazy AVIF original</b><img src="${ORIGIN}/avif/prev-lazy.png" data-original="${ORIGIN}/avif/avif-lazy.avif" width="240" height="160"></div>
<div class="box"><b>AV4 PNG preview linking to the AVIF original</b><a href="${ORIGIN}/avif/avif-link.avif"><img src="${ORIGIN}/avif/prev-link.png" width="240" height="160"></a></div></div>
<div class="box"><b>AV5/AV6 two cards, the SAME preview URL, different AVIF originals</b><div class="row">
<div class="box"><img src="${ORIGIN}/avif/prev-shared.png" data-original="${ORIGIN}/avif/avif-card-one.avif" width="240" height="160">card 1</div>
<div class="box"><img src="${ORIGIN}/avif/prev-shared.png" data-original="${ORIGIN}/avif/avif-card-two.avif" width="240" height="160">card 2</div></div></div>
<div class="box"><b>AV7 AVIF inside an iframe, relative original URL</b><iframe src="${ORIGIN}/avif/frame.html"></iframe></div>
<div class="row">
<div class="box"><b>AV8 ONE overlay (400x150) over TWO adjacent AVIF images</b><div class="ovc" style="width:400px;height:150px"><img src="${ORIGIN}/avif/avif-pic-small.avif" style="left:0;width:200px;height:150px"><img src="${ORIGIN}/avif/avif-direct.avif" style="left:200px;width:200px;height:150px"><div class="ov" style="width:400px;height:150px"></div></div></div>
<div class="box"><b>AV9 AVIF original that changes right after the right-click</b><img id="avswap" src="${ORIGIN}/avif/prev-swap.png" data-original="${ORIGIN}/avif/avif-card-one.avif" width="240" height="160"></div>
<div class="box"><b>AV10 original that is an HTML page (200)</b><img src="${ORIGIN}/avif/prev-html.png" data-original="${ORIGIN}/avif/html-original.avif" width="240" height="160"></div>
<div class="box"><b>AV11 original that is missing (404)</b><img src="${ORIGIN}/avif/prev-missing.png" data-original="${ORIGIN}/avif/missing-original.avif" width="240" height="160"></div></div>
<table><tr><th>#</th><th>Right-click</th><th>Expected</th><th>Wrong</th></tr>
<tr><td>AV1</td><td>the image</td><td>avif-direct.avif (teal AVIF DIRECT), a real .avif</td><td>a .png/.jpg/.mp4 or no file</td></tr>
<tr><td>AV2</td><td>the picture image</td><td>avif-pic-large.avif (dark purple AVIF PIC LARGE, 480 wide)</td><td>avif-pic-small.avif, pic-fallback.png</td></tr>
<tr><td>AV3</td><td>the preview</td><td>avif-lazy.avif (pink AVIF LAZY ORIGINAL)</td><td>prev-lazy.png</td></tr>
<tr><td>AV4</td><td>the preview</td><td>avif-link.avif (olive AVIF LINK ORIGINAL)</td><td>prev-link.png</td></tr>
<tr><td>AV5</td><td>card 1 preview</td><td>avif-card-one.avif (orange)</td><td>avif-card-two.avif, prev-shared.png</td></tr>
<tr><td>AV6</td><td>card 2 preview</td><td>avif-card-two.avif (green)</td><td>avif-card-one.avif (first card), prev-shared.png</td></tr>
<tr><td>AV7</td><td>the frame image</td><td>avif-frame-rel.avif (blue AVIF FRAME REL, from /avif/rel/)</td><td>avif-wrong-rel.avif (red AVIF WRONG TOP, from /rel/)</td></tr>
<tr><td>AV8</td><td>left half, then right half of the overlay</td><td><b>no file</b>, ERR, both times</td><td>avif-pic-small.avif or avif-direct.avif</td></tr>
<tr><td>AV9</td><td>the image (wait at least one second after the click, then choose Save)</td><td><b>no file</b> (the owner changed), ERR</td><td>avif-card-one.avif, avif-card-two.avif or prev-swap.png</td></tr>
<tr><td>AV10</td><td>the image</td><td>prev-html.png (the selected image; never an .avif made of HTML)</td><td>html-original.avif</td></tr>
<tr><td>AV11</td><td>the image</td><td>prev-missing.png (the selected image, not labelled as an original)</td><td>no file at all, or a file from another card</td></tr></table>
<script>
(function () {
  var im = document.getElementById('avswap');
  im.addEventListener('contextmenu', function () {
    im.setAttribute('data-original', '${ORIGIN}/avif/avif-card-one.avif');
    setTimeout(function () { im.setAttribute('data-original', '${ORIGIN}/avif/avif-card-two.avif'); }, 400);
  });
})();
</script>`),
    '/dl.html': page('GEN-01 download resilience', `<h3>Shared download: servers that refuse, lie or hang</h3>
<p>Previews are PNG; where a case has an original it is a <code>data-original</code> that fails in the stated way. Reload the extension and refresh first. The server console shows every request and, for DL2, when the extension closed the connection.</p>
<div class="row">
<div class="box"><b>DL1 AVIF whose server refuses HEAD (503)</b><img src="${ORIGIN}/dl/head-blocked.avif" width="240" height="160"></div>
<div class="box"><b>DL2 image whose server refuses HEAD and ignores Range (2 MiB, slow)</b><img src="${ORIGIN}/dl/prev-range.png" data-original="${ORIGIN}/dl/ignore-range.png" width="240" height="160"></div>
<div class="box"><b>DL3 original is an HTML page (200)</b><img src="${ORIGIN}/dl/prev-html.png" data-original="${ORIGIN}/dl/html-200.png" width="240" height="160"></div>
<div class="box"><b>DL4 original is JSON</b><img src="${ORIGIN}/dl/prev-json.png" data-original="${ORIGIN}/dl/json.png" width="240" height="160"></div>
<div class="box"><b>DL5 original answers 500</b><img src="${ORIGIN}/dl/prev-500.png" data-original="${ORIGIN}/dl/error-500.png" width="240" height="160"></div>
<div class="box"><b>DL6 original never answers (the probe times out)</b><img src="${ORIGIN}/dl/prev-hang.png" data-original="${ORIGIN}/dl/hang.png" width="240" height="160"></div>
<div class="box"><b>DL7 original is missing (404)</b><img src="${ORIGIN}/dl/prev-missing.png" data-original="${ORIGIN}/dl/missing.png" width="240" height="160"></div></div>
<div class="row">
<div class="box"><b>DL8 signed original (403 without the signature)</b><img src="${ORIGIN}/b/signed-preview.png" data-original="${ORIGIN}${SIGNED_PATH}?sig=abc%2Fdef&exp=4102444800" width="240" height="160"></div>
<div class="box"><b>DL9 extensionless MP4 (generic binary)</b><video controls preload="metadata" width="240" height="135" src="${ORIGIN}/v/stream/42"></video></div>
<div class="box"><b>DL10 extensionless WebM (generic binary)</b><video controls preload="metadata" width="240" height="135" src="${ORIGIN}/v/stream/43"></video></div>
<div class="box"><b>DL11 binary URL that serves HTML</b><video controls preload="metadata" width="240" height="135" src="${ORIGIN}/v/stream/44"></video></div>
<div class="box"><b>DL12 .mp4 URL that serves HTML</b><video controls preload="metadata" width="240" height="135" src="${ORIGIN}/v/html-video.mp4"></video></div></div>
<table><tr><th>#</th><th>Right-click</th><th>Expected</th><th>Wrong</th></tr>
<tr><td>DL1</td><td>the image</td><td>head-blocked.avif (a real AVIF); console: HEAD 503, then GET range=bytes=0-0</td><td>no file</td></tr>
<tr><td>DL2</td><td>the preview</td><td>ignore-range.png, saved; console: GET range=bytes=0-0 and "client closed the connection after N of 2097152 bytes" (N far below 2097152)</td><td>the connection streams to the end</td></tr>
<tr><td>DL3, DL4, DL5, DL6, DL7</td><td>the preview</td><td>the selected preview itself (prev-html.png, prev-json.png, prev-500.png, prev-hang.png after about 4 s, prev-missing.png); never the failing original</td><td>html-200.png, json.png, error-500.png, hang.png, missing.png</td></tr>
<tr><td>DL8</td><td>the image</td><td>signed-full.png (green SIGNED OK); console shows ?sig=abc%2Fdef kept</td><td>signed-preview.png, or a request without the query</td></tr>
<tr><td>DL9</td><td>the video</td><td>42.mp4 (a video)</td><td>no file</td></tr>
<tr><td>DL10</td><td>the video</td><td><b>no file</b>, ERR (the existing rule: only the MP4 signature admits an extensionless generic-binary URL, so WebM there is refused conservatively; the console shows one Range 0-511 request)</td><td>any file, a poster</td></tr>
<tr><td>DL11, DL12</td><td>the video</td><td><b>no file</b>, ERR</td><td>any file, a poster</td></tr></table>`),
    '/menu.html': page('GEN-01 menu state', `<style>.cbox{width:240px;height:160px;background-size:cover;border:1px solid #888}x-empty{display:block;padding:40px;border:1px dashed #aaa}</style>
<h3>MENU: absent outside media, and the label follows the current click</h3>
<p>Reload the extension and refresh this page. Outside a picture, GIF or video the save item must be <b>absent</b> from the menu (not greyed out). Chrome has no event before its menu opens, so the very first menu right after a fast move may still show the previous state (best effort); pause the pointer for half a second before the right-click. Then run the <b>sequence</b> below without reloading: MS2, MS1, MS3, MS4, MS1.</p>
<div class="row">
<div class="box"><b>MS1 ordinary image</b><img src="/plain.png" width="240" height="160" alt=""></div>
<div class="box"><b>MS2 native GIF</b><img src="/anim-top.gif" width="240" height="160" alt=""></div>
<div class="box"><b>MS3 video</b><video controls muted preload="metadata" width="240" height="135" src="/v/video-a.mp4"></video></div></div>
<div class="box"><b>MS4 empty area</b><div style="height:60px"></div></div>
<div class="box"><b>MS5 empty custom element with a shadow root</b><x-empty id="ms5">(padding of an empty shadow container)</x-empty></div>
<div class="box"><b>MS6 custom element with a real video in its shadow root</b><x-shell id="ms6"></x-shell></div>
<div class="box"><b>MS7 caption text</b><p>A sentence next to the pictures. Right-click it.</p></div>
<div class="box"><b>MS8 ordinary navigation link</b><a href="/css/item-1">Read the article (a page, not a file)</a></div>
<div class="box"><b>MS9 text link straight to a GIF file</b><a href="/anim-top.gif">Download the animation (a file)</a></div>
<div class="box"><b>MS10 background card (type of its asset not known)</b><div class="cbox" style="background-image:url(/css/card-a.png)"></div></div>
<table><tr><th>#</th><th>Right-click</th><th>Expected</th><th>Wrong</th></tr>
<tr><td>MS1</td><td>the image</td><td>one item "Image Saver: Save image"; plain.png</td><td>a GIF/video label, a submenu</td></tr>
<tr><td>MS2</td><td>the GIF</td><td>one item "Image Saver: Save GIF"; anim-top.gif (native, 3 frames)</td><td>"Save image", a still frame</td></tr>
<tr><td>MS3</td><td>the video</td><td>one item "Image Saver: Save video"; video-a.mp4</td><td>"Save GIF", a poster</td></tr>
<tr><td>MS4, MS7, MS8</td><td>the empty area, the sentence, the link text</td><td><b>no Image Saver item</b> in the menu</td><td>a greyed-out item, or an item with the previous label</td></tr>
<tr><td>MS5</td><td>inside the dashed empty container</td><td><b>no Image Saver item</b></td><td>any item (an empty container is not media)</td></tr>
<tr><td>MS6</td><td>the video inside the shadow root</td><td>one item "Image Saver: Save video"; video-b.webm</td><td>no item (a real shadow-DOM player is a target)</td></tr>
<tr><td>MS9</td><td>the link text</td><td>one item "Image Saver: Save GIF"; anim-top.gif</td><td>no item, "Save image"</td></tr>
<tr><td>MS10</td><td>the card</td><td>one item "Image Saver: Save media under cursor" (neutral: the asset's type is unknown); card-a.png</td><td>"Save image", "Save GIF"</td></tr>
<tr><td>sequence</td><td>MS2, MS1, MS3, MS4, MS1 without reload</td><td>Save GIF, Save image, Save video, absent, Save image</td><td>any label from an earlier step</td></tr></table>
<script>
(function () {
  var e = document.getElementById('ms5');
  e.attachShadow({ mode: 'open' }).innerHTML = '<span>shadow content: text only</span>';
  var s = document.getElementById('ms6').attachShadow({ mode: 'open' });
  s.innerHTML = '<video controls muted preload="metadata" width="240" height="135" src="/v/video-b.webm"></video>';
})();
</script>`),
    '/avif/frame.html': page('avif frame', `<img src="rel-preview.png" data-original="rel/avif-frame-rel.avif" width="240" height="160"><div>(frame: relative preview and relative AVIF original)</div>`),
    '/css-frame.html': page('css frame', `<style>.cbox{width:240px;height:160px;background-size:cover}</style><div class="cbox" style="background-image:url(${ORIGIN}/css/frame-bg.png)"></div>`),
    '/css/item-1': page('item 1', '<p>Item page (link target of the CSS3 overlay).</p>')
  };
};

// ---- HTTP ----
const requests = [];
let seq = 0;
function serve(req, res) {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  if (p.startsWith('/__')) return control(req, res, p, url);
  requests.push({ seq: ++seq, method: req.method, path: p + (url.search || ''), range: req.headers.range || '' });
  if (requests.length > 500) requests.shift();
  if (!SELF_CHECK) console.log(`${new Date().toISOString().slice(11, 19)} #${seq} ${req.method} ${p}${url.search}${req.headers.range ? ' range=' + req.headers.range : ''}`);
  // The three non-asset behaviours of the DL cases (they are exactly what a probe must survive)
  if (p === '/dl/ignore-range.png') {
    if (req.method === 'HEAD') { res.writeHead(405, { 'Content-Type': 'text/plain', 'Content-Length': 2 }); res.end('no'); return; }
    const entry = requests[requests.length - 1];
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': IGNORE_RANGE_BYTES, 'Cache-Control': 'no-store' });
    const chunk = Buffer.alloc(16 * 1024, 7);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(chunk);
    let sent = 0;
    const timer = setInterval(() => { if (sent >= IGNORE_RANGE_BYTES) { clearInterval(timer); res.end(); return; } sent += chunk.length; res.write(chunk); }, 15);
    res.on('close', () => { clearInterval(timer); if (entry) { entry.sent = sent; entry.complete = sent >= IGNORE_RANGE_BYTES; } if (!SELF_CHECK) console.log(`        (/dl/ignore-range.png: the client closed the connection after ${sent} of ${IGNORE_RANGE_BYTES} bytes)`); });
    return;
  }
  if (p === '/dl/error-500.png') { res.writeHead(500, { 'Content-Type': 'text/plain', 'Content-Length': 5 }); res.end(req.method === 'HEAD' ? undefined : 'error'); return; }
  if (p === '/dl/hang.png') { hung.push(res); return; } // never answers: the caller's own timeout must end it
  const asset = ASSETS[p];
  const html = pages()[p];
  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (html !== undefined) return send(200, 'text/html; charset=utf-8', Buffer.from(html));
  if (!asset) return send(404, 'text/plain', Buffer.from('not found'));
  if (p === SIGNED_PATH && !(url.searchParams.get('sig') === 'abc/def' && url.searchParams.get('exp'))) return send(403, 'text/plain', Buffer.from('signature required'));
  if (asset.head503 && req.method === 'HEAD') return send(503, 'text/html', Buffer.alloc(592, 32));
  let type = asset.type;
  let body = asset.body;
  if (FAULT === 'wrong-mime' && p === '/v/video-a.mp4') type = 'text/html';
  if (FAULT === 'bad-body' && p === '/b/orig-card-two.png') body = Buffer.from('<!doctype html><title>not a png</title>');
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range && /^video\//.test(type)) {
    const start = Number(range[1]);
    const end = Math.min(range[2] === '' ? body.length - 1 : Number(range[2]), body.length - 1);
    if (start > end) return send(416, 'text/plain', Buffer.from(''), { 'Content-Range': `bytes */${body.length}` });
    return send(206, type, body.subarray(start, end + 1), { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Accept-Ranges': 'bytes' });
  }
  return send(200, type, body, { 'Accept-Ranges': 'bytes' });
}

let servers = [];
function shutdown(code = 0) {
  process.exitCode = code;
  for (const r of hung) { try { r.destroy(); } catch (e) { /* already gone */ } }
  for (const s of servers) { try { s.close(); if (s.closeAllConnections) s.closeAllConnections(); } catch (e) { /* already closed */ } }
  setTimeout(() => process.exit(code), 100).unref();
}
function control(req, res, p, url) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  // Custom header forces a CORS preflight, so a web page cannot trigger these; only a local client can.
  if (!local || req.headers['x-fixture-control'] !== '1') { res.writeHead(403); res.end(); return; }
  if (p === '/__shutdown' && req.method === 'POST') { res.writeHead(200); res.end('bye'); console.log('shutdown requested'); shutdown(0); return; }
  if (p === '/__requests') { const since = Number(url.searchParams.get('since') || 0); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(requests.filter((r) => r.seq > since))); return; }
  res.writeHead(404); res.end();
}

function listen() {
  return new Promise((resolve, reject) => {
    const s4 = http.createServer(serve);
    s4.on('error', reject);
    s4.listen(PORT, '127.0.0.1', () => {
      PORT = s4.address().port;
      ORIGIN = `http://localhost:${PORT}`;
      CROSS = `http://127.0.0.1:${PORT}`;
      servers.push(s4);
      // `localhost` may resolve to ::1 first: serve it too when IPv6 loopback exists (loopback only, never all interfaces).
      const s6 = http.createServer(serve);
      s6.on('error', () => { console.log('note: IPv6 loopback unavailable; use http://127.0.0.1:' + PORT + '/ if localhost fails'); resolve(); });
      s6.listen(PORT, '::1', () => { servers.push(s6); resolve(); });
    });
  });
}

// ---- body validators (used by --self-check): they inspect bytes, never trust the Content-Type ----
function checkPng(buf) {
  if (buf.length < 33 || buf.compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 0, 8, 0, 8) !== 0) return 'bad PNG signature';
  let off = 8, w = 0, h = 0, idat = [], end = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    if (off + 12 + len > buf.length) return 'truncated chunk ' + type;
    if (buf.readUInt32BE(off + 8 + len) !== crc32(buf.subarray(off + 4, off + 8 + len))) return 'bad CRC in ' + type;
    if (type === 'IHDR') { w = buf.readUInt32BE(off + 8); h = buf.readUInt32BE(off + 12); }
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') end = true;
    off += 12 + len;
  }
  if (!end || !w || !h) return 'missing IHDR/IEND';
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return raw.length === h * (w * 3 + 1) ? { w, h } : `IDAT size ${raw.length} != ${h * (w * 3 + 1)}`;
}
function checkGif(buf) {
  if (buf.toString('ascii', 0, 6) !== 'GIF89a') return 'bad GIF header';
  const w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
  let off = 13 + ((buf[10] & 0x80) ? 3 * (1 << ((buf[10] & 7) + 1)) : 0), frames = 0;
  const skipBlocks = () => { while (buf[off] !== 0) { if (off >= buf.length) throw new Error('truncated'); off += buf[off] + 1; } off++; };
  try {
    while (off < buf.length && buf[off] !== 0x3b) {
      if (buf[off] === 0x21) { off += 2; skipBlocks(); }
      else if (buf[off] === 0x2c) { const flags = buf[off + 9]; off += 10 + ((flags & 0x80) ? 3 * (1 << ((flags & 7) + 1)) : 0) + 1; skipBlocks(); frames++; }
      else return 'unexpected block ' + buf[off];
    }
  } catch (e) { return e.message; }
  return buf[off] === 0x3b && frames >= 2 ? { w, h, frames } : `frames=${frames} trailer=${buf[off]}`;
}
function checkJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return 'bad SOI/EOI';
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return 'marker sync';
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xc2) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return 'no SOF';
}
function checkWebp(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return 'bad RIFF/WEBP';
  if (buf.readUInt32LE(4) !== buf.length - 8) return 'RIFF size mismatch';
  const fourcc = buf.toString('ascii', 12, 16);
  return ['VP8 ', 'VP8L', 'VP8X'].includes(fourcc) ? { fourcc } : 'unknown chunk ' + fourcc;
}
// AVIF still picture: the container (ftyp 'avif', one av01 item with ispe/av1C, extent inside the file) and the AV1
// payload (sequence header with still_picture set, then a frame OBU). Chromium decoding is checked by hand, see README.md.
function checkAvif(buf) {
  const boxes = (start, end) => { const out = []; for (let o = start; o + 8 <= end;) { const size = buf.readUInt32BE(o); const type = buf.toString('latin1', o + 4, o + 8); if (size < 8 || o + size > end) throw new Error('bad box ' + type); out.push({ type, start: o + 8, end: o + size }); o += size; } return out; };
  const top = boxes(0, buf.length);
  const ftyp = top[0];
  if (!ftyp || ftyp.type !== 'ftyp' || buf.toString('latin1', ftyp.start, ftyp.start + 4) !== 'avif') return 'no ftyp avif';
  const meta = top.find((b) => b.type === 'meta');
  const mdat = top.find((b) => b.type === 'mdat');
  if (!meta || !mdat) return 'no meta/mdat';
  const m = boxes(meta.start + 4, meta.end);
  const has = (t) => m.find((b) => b.type === t);
  if (buf.toString('latin1', has('hdlr').start + 8, has('hdlr').start + 12) !== 'pict') return 'handler is not pict';
  const iprp = has('iprp');
  const ipco = boxes(iprp.start, iprp.end).find((b) => b.type === 'ipco');
  const pl = boxes(ipco.start, ipco.end);
  const ispe = pl.find((b) => b.type === 'ispe');
  if (!ispe || !pl.find((b) => b.type === 'av1C')) return 'missing ispe/av1C';
  const w = buf.readUInt32BE(ispe.start + 4), h = buf.readUInt32BE(ispe.start + 8);
  const iloc = has('iloc');
  const off = buf.readUInt32BE(iloc.start + 4 + 2 + 2 + 2 + 2 + 2), len = buf.readUInt32BE(iloc.start + 4 + 2 + 2 + 2 + 2 + 2 + 4);
  if (off < mdat.start || off + len > mdat.end) return 'item extent outside mdat';
  const item = buf.subarray(off, off + len);
  const obu = (p) => { const hd = item[p]; let v = 0; let i = 0; for (; i < 8; i++) { v |= (item[p + 1 + i] & 0x7f) * 2 ** (7 * i); if (!(item[p + 1 + i] & 0x80)) break; } return { type: (hd >> 3) & 15, start: p + 2 + i, size: v }; };
  const first = obu(0);
  if (first.type !== 1) return 'first OBU is not a sequence header';
  if (!(item[first.start] & 0x10)) return 'still_picture not set';
  const second = obu(first.start + first.size);
  if (second.type !== 6 && second.type !== 3) return 'no frame OBU after the sequence header';
  return { w, h, bytes: buf.length };
}
function mp4Tracks(buf) {
  const boxes = (start, end) => { const out = []; for (let o = start; o + 8 <= end;) { let size = buf.readUInt32BE(o); const type = buf.toString('ascii', o + 4, o + 8); if (size === 0) size = end - o; if (size < 8 || o + size > end) throw new Error('bad box ' + type); out.push({ type, start: o + 8, end: o + size }); o += size; } return out; };
  const top = boxes(0, buf.length);
  if (!top.length || top[0].type !== 'ftyp') throw new Error('no ftyp first');
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('no moov');
  const kinds = [];
  const walk = (b) => { for (const c of boxes(b.start, b.end)) { if (c.type === 'hdlr') kinds.push(buf.toString('ascii', c.start + 8, c.start + 12)); else if (['trak', 'mdia'].includes(c.type)) walk(c); } };
  for (const c of boxes(moov.start, moov.end)) if (c.type === 'trak') walk(c);
  return { video: kinds.filter((k) => k === 'vide').length, audio: kinds.filter((k) => k === 'soun').length };
}
function webmTracks(buf) {
  const readVint = (o, keepMarker) => { const first = buf[o]; let len = 1; while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++; if (len > 8) throw new Error('bad vint'); let v = keepMarker ? first : first & (0xff >> len); for (let i = 1; i < len; i++) v = v * 256 + buf[o + i]; return { v, len, unknown: !keepMarker && v === Math.pow(2, 7 * len) - 1 }; };
  const children = (start, end, cb) => { for (let o = start; o < end;) { const id = readVint(o, true); const sz = readVint(o + id.len, false); const ds = o + id.len + sz.len; const de = sz.unknown ? end : Math.min(end, ds + sz.v); cb(id.v, ds, de); o = de; } };
  if (buf.readUInt32BE(0) !== 0x1a45dfa3) throw new Error('no EBML header');
  const found = { video: 0, audio: 0 };
  children(0, buf.length, (id, ds, de) => {
    if (id !== 0x18538067) return; // Segment
    children(ds, de, (cid, cs, ce) => {
      if (cid !== 0x1654ae6b) return; // Tracks
      children(cs, ce, (tid, ts, te) => { if (tid === 0xae) children(ts, te, (fid, fs2, fe) => { if (fid === 0x83) { const t = buf[fs2]; if (t === 1) found.video++; if (t === 2) found.audio++; } }); });
    });
  });
  return found;
}

// ---- self-check: explicit assertions, hard timeout, non-zero exit on any failure ----
async function selfCheck() {
  const failures = [];
  let count = 0;
  const check = (name, cond, detail = '') => { count++; if (!cond) { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); } else console.log('ok   ' + name); };
  const toLoop = (u) => u.replace('//localhost:', '//127.0.0.1:');
  const get = (u, o = {}) => fetch(toLoop(u), { signal: AbortSignal.timeout(5000), cache: 'no-store', ...o });
  const pageMap = pages();
  const hashes = {};
  for (const [p, a] of Object.entries(ASSETS)) {
    const r = await get(ORIGIN + p);
    const body = Buffer.from(await r.arrayBuffer());
    hashes[p] = crypto.createHash('sha256').update(body).digest('hex');
    if (p === SIGNED_PATH) { check(`${p} without signature is refused (403)`, r.status === 403); continue; }
    const typeOk = (r.headers.get('content-type') || '') === a.type;
    check(`${p} 200 and Content-Type ${a.type}`, r.status === 200 && typeOk, `status ${r.status} type ${r.headers.get('content-type')}`);
    let res;
    try {
      res = { json: (b) => { try { JSON.parse(b.toString()); return { json: true }; } catch (e) { return 'not json'; } }, avif: checkAvif, html: (b) => (/^<!doctype html>/i.test(b.toString('latin1', 0, 15)) ? { html: true } : 'not html'), png: checkPng, gif: checkGif, jpeg: checkJpeg, webp: checkWebp, mp4: (b) => { const t = mp4Tracks(b); return t.video >= 1 ? t : 'no video track'; }, webm: (b) => { const t = webmTracks(b); return t.video >= 1 ? t : 'no video track'; } }[a.kind](body);
    } catch (e) { res = String(e.message || e); }
    check(`${p} body decodes as ${a.kind}`, typeof res === 'object', String(res));
    const h = await get(ORIGIN + p, { method: 'HEAD' });
    if (a.head503) check(`${p} HEAD answers 503 text/html while GET works`, h.status === 503 && /text\/html/.test(h.headers.get('content-type') || '') && r.status === 200);
    else check(`${p} HEAD 200 with Content-Length`, h.status === 200 && Number(h.headers.get('content-length')) === body.length);
  }
  const signed = await get(`${ORIGIN}${SIGNED_PATH}?sig=abc%2Fdef&exp=4102444800`);
  check('signed original served with its query', signed.status === 200 && typeof checkPng(Buffer.from(await signed.arrayBuffer())) === 'object');
  // Real media facts the expectations rely on
  const a = mp4Tracks(ASSETS['/v/video-a.mp4'].body), s = mp4Tracks(ASSETS['/v/silent-loop.mp4'].body), w = webmTracks(ASSETS['/v/video-b.webm'].body);
  check('video-a.mp4 has video and audio tracks', a.video >= 1 && a.audio >= 1, JSON.stringify(a));
  check('video-b.webm has video and audio tracks', w.video >= 1 && w.audio >= 1, JSON.stringify(w));
  check('silent-loop.mp4 has video and no audio track', s.video >= 1 && s.audio === 0, JSON.stringify(s));
  const rng = await get(ORIGIN + '/v/video-a.mp4', { headers: { Range: 'bytes=0-0' } });
  check('video Range request answered 206 with Content-Range', rng.status === 206 && /^bytes 0-0\/\d+$/.test(rng.headers.get('content-range') || ''));
  // Distinct, recognisable files for every case pair
  const distinct = (x, y) => hashes[x] && hashes[y] && hashes[x] !== hashes[y];
  check('relative decoys differ (frame doc vs top page)', distinct('/b/rel/frame-original.png', '/rel/frame-original.png'));
  check('base decoys differ', distinct('/b/base/orig.png', '/b/orig.png'));
  check('card originals, og banner and previews are all different files', new Set(['/b/orig-card-one.png', '/b/orig-card-two.png', '/b/og-banner.png', '/b/shared-preview.png', '/original/top-red.png', '/original/frame-blue.png', '/original/cross-green.png'].map((x) => hashes[x])).size === 7);
  check('video-a and video-b are different files', distinct('/v/video-a.mp4', '/v/video-b.webm'));
  // Page traps and reference integrity
  const text = (p) => pageMap[p];
  check('A page: same preview URL on the top page and in both frames', text('/a.html').includes('/preview.png') && text('/frame-same.html').includes('/preview.png') && text('/frame-cross.html').includes('/preview.png'));
  check('B1 page: the same preview URL appears in two cards with different originals', text('/b1.html').split('/b/shared-preview.png"').length - 1 === 2 && text('/b1.html').includes('orig-card-one.png') && text('/b1.html').includes('orig-card-two.png'));
  check('B1 page: og:image and twitter:image point to the OG banner', text('/b1.html').includes('property="og:image"') && text('/b1.html').includes('twitter:image') && text('/b1.html').includes('/b/og-banner.png'));
  check('relative frame page resolves to a different file than the top page would', new URL('rel/frame-original.png', ORIGIN + '/b/frame-relative.html').pathname === '/b/rel/frame-original.png' && new URL('rel/frame-original.png', ORIGIN + '/b2.html').pathname === '/rel/frame-original.png');
  check('<base href> page resolves to a different file than the document URL would', new URL('orig.png', new URL('/b/base/', ORIGIN)).pathname === '/b/base/orig.png' && new URL('orig.png', ORIGIN + '/b/base-page.html').pathname === '/b/orig.png');
  // CSS / overlay page: every wrong-file decoy must be a different file, and the traps must really be in the markup
  const cssFiles = ['/css/card-a.png', '/css/card-b.png', '/css/ov-preview.png', '/css/ov-full-one.png', '/css/ov-full-two.png', '/css/ov-bg.png', '/css/frame-bg.png', '/css/amb-1.png', '/css/amb-2.png', '/css/span-left.png', '/css/span-right.png'];
  const cssPage = text('/css.html');
  check('CSS files are all different (every wrong file is distinguishable)', new Set(cssFiles.map((x) => hashes[x])).size === cssFiles.length);
  check('CSS page: two neighbouring cards with different backgrounds', cssPage.includes('background-image:url(' + ORIGIN + '/css/card-a.png)"></div>card A') && cssPage.includes('background-image:url(' + ORIGIN + '/css/card-b.png)"></div>card B'));
  check('CSS page: overlay cards share one preview URL with different originals', (cssPage.match(/css\/ov-preview\.png"/g) || []).length === 3 && cssPage.includes('data-original="' + ORIGIN + '/css/ov-full-one.png"') && cssPage.includes('data-original="' + ORIGIN + '/css/ov-full-two.png"'));
  check('CSS page: six transparent overlays (link and div over images, over a background, over a video, over two images)', (cssPage.match(/class="ov"/g) || []).length === 6 && cssPage.includes('<a class="ov" href='));
  check('CSS page: the video under an overlay has an extensionless URL that serves an MP4 container', /<video[^>]*src="[^"]*\/v\/stream\/42"/.test(cssPage) && ASSETS['/v/stream/42'].kind === 'mp4' && ASSETS['/v/stream/42'].type === 'application/octet-stream');
  check('CSS page: one 400x150 overlay over two adjacent 200x150 images with different files', /width:400px;height:150px"><img src="[^"]*span-left\.png"[^>]*left:0[^>]*width:200px;height:150px"><img src="[^"]*span-right\.png"[^>]*left:200px[^>]*width:200px;height:150px"><div class="ov" style="width:400px;height:150px">/.test(cssPage));
  check('CSS page: the moving-card script slides the background card far away after the right-click', /getElementById\('mover'\)[\s\S]*translateX\(3000px\)/.test(cssPage));
  check('CSS page: one element carries two backgrounds (ambiguous case)', /url\([^)]*amb-1\.png\),url\([^)]*amb-2\.png\)/.test(cssPage));
  check('CSS page: the frame case points to a frame page with its own background', cssPage.includes('/css-frame.html') && text('/css-frame.html').includes('/css/frame-bg.png'));
  check('CSS page: changing-owner cases swap the background and the original shortly after the right-click', /contextmenu[\s\S]*setTimeout\(function \(\) \{ sw\.style\.backgroundImage = 'url\([^)]*card-b\.png\)'/.test(cssPage) && /setAttribute\('data-original', '[^']*ov-full-two\.png'\)/.test(cssPage));
  const guardPage = text('/guard.html');
  check('GUARD page: relative URLs only, so the same markup runs under localhost and 127.0.0.1', !/(?:src|href)="https?:/i.test(guardPage) && !guardPage.includes('url(http') && guardPage.includes('/css/ov-full-one.png') && guardPage.includes('/plain.png'));
  check('GUARD page: caption, navigation link, media link, container with image, photo above video, empty area and a card that is removed', ['GD1', 'GD2', 'GD3', 'GD4', 'GD5', 'GD6', 'GD7', 'GD8', 'GD9'].every((k) => guardPage.includes('<b>' + k + ' ')) && /class="stack"><video[^>]*><\/video><img/.test(guardPage) && /class="card" id="gd4"><img/.test(guardPage) && /removeChild\(c\)/.test(guardPage));
  check('GUARD page: an image and a media link are removed shortly after the right-click', /id="gd8" src="\/plain\.png"/.test(guardPage) && /id="gd9" href="\/css\/ov-full-two\.png"/.test(guardPage) && /\['gd8', 'gd9'\]\.forEach/.test(guardPage));
  check('GUARD page: the index links to it', text('/').includes('/guard.html'));
  const menuPage = text('/menu.html');
  check('MENU page: ordinary image, GIF, video, empty area, empty and real shadow containers, text, links and a card; relative URLs only', ['MS1', 'MS2', 'MS3', 'MS4', 'MS5', 'MS6', 'MS7', 'MS8', 'MS9', 'MS10'].every((k) => menuPage.includes('<b>' + k + ' ')) && !/(?:src|href)="https?:/i.test(menuPage) && menuPage.includes('/anim-top.gif') && menuPage.includes('/v/video-b.webm') && /attachShadow\(\{ mode: 'open' \}\)\.innerHTML = '<span>/.test(menuPage) && /innerHTML = '<video controls/.test(menuPage));
  check('MENU page: the index links to it and the sequence is listed', text('/').includes('/menu.html') && menuPage.includes('Save GIF, Save image, Save video, absent, Save image'));
  check('CSS page: a card with a background and a caption inside it (ancestor background case)', /css\/card-b\.png\);padding:8px"><span/.test(cssPage));
  let cssMissing = [];
  let cssUrls = 0;
  for (const [p, html] of Object.entries(pageMap)) {
    for (const m of html.matchAll(/url\(\s*['"]?([^)'"]+)['"]?\s*\)/g)) {
      const abs = new URL(m[1], ORIGIN + p).href;
      if (!abs.startsWith(ORIGIN)) continue;
      cssUrls++;
      const r = await get(abs);
      await r.arrayBuffer();
      if (r.status !== 200) cssMissing.push(p + ' -> ' + abs + ' ' + r.status);
    }
  }
  check('every CSS url() on the pages is served (200)', cssUrls >= 9 && cssMissing.length === 0, cssMissing.join('; ') || ('urls found: ' + cssUrls));
  const refRe = /(?:src|href|poster|data-original|content)="([^"]+)"|srcset="([^"]+)"/g;
  let missing = [];
  for (const [p, html] of Object.entries(pageMap)) {
    const base = p === '/b/base-page.html' ? ORIGIN + '/b/base/' : ORIGIN + p;
    for (const m of html.replace(/<base [^>]*>/g, '').matchAll(refRe)) {
      const raw = m[1] ? [m[1]] : m[2].split(',').map((x) => x.trim().split(/\s+/)[0]);
      for (const u of raw) {
        if (!/^(https?:\/\/|\/|[a-z0-9._\/-]+\.(png|jpg|webp|gif|mp4|webm|html)$)/i.test(u)) continue;
        const abs = new URL(u, base).href;
        if (!abs.startsWith(ORIGIN) && !abs.startsWith(CROSS)) continue;
        if (SPECIAL.has(new URL(abs).pathname)) continue;
        const r = await get(abs);
        await r.arrayBuffer();
        if (NOT_SERVED.has(new URL(abs).pathname)) { if (r.status !== 404) missing.push(p + ' -> ' + abs + ' should be 404 but is ' + r.status); continue; }
        if (r.status !== 200) missing.push(p + ' -> ' + abs + ' ' + r.status);
      }
    }
  }
  // AVIF page: real AVIF files, distinct bytes, the cases are in the markup, and the traps really are traps
  const avifFiles = ['/avif/avif-direct.avif', '/avif/avif-pic-small.avif', '/avif/avif-pic-large.avif', '/avif/avif-card-one.avif', '/avif/avif-card-two.avif', '/avif/avif-lazy.avif', '/avif/avif-link.avif', '/avif/rel/avif-frame-rel.avif', '/rel/avif-frame-rel.avif'];
  const avifPage = text('/avif.html');
  check('AVIF files are all different real AVIF (not a renamed PNG/JPEG)', new Set(avifFiles.map((x) => hashes[x])).size === avifFiles.length && avifFiles.every((x) => ASSETS[x].kind === 'avif' && ASSETS[x].body.toString('latin1', 4, 12) === 'ftypavif'));
  const sums = Object.fromEntries(fs.readFileSync(path.join(FIXTURES, 'avif', 'SHA256SUMS'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { const m = /^([0-9a-f]{64}) \*?(.+)$/.exec(l); return [m[2], m[1]]; }));
  check('AVIF files match SHA256SUMS (provenance record)', fs.readdirSync(path.join(FIXTURES, 'avif')).filter((n) => n.endsWith('.avif')).every((n) => sums[n] === crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURES, 'avif', n))).digest('hex')) && Object.keys(sums).length === 9);
  check('AVIF pic-large is bigger than pic-small and the other AVIFs decode to their own sizes', checkAvif(ASSETS['/avif/avif-pic-large.avif'].body).w === 480 && checkAvif(ASSETS['/avif/avif-pic-small.avif'].body).w === 240 && checkAvif(ASSETS['/avif/avif-direct.avif'].body).h === 160);
  check('AVIF page: direct image, picture/srcset with AVIF sources, lazy original, linked original', avifPage.includes('src="' + ORIGIN + '/avif/avif-direct.avif"') && /<source type="image\/avif" srcset="[^"]*avif-pic-small\.avif 240w, [^"]*avif-pic-large\.avif 480w"/.test(avifPage) && avifPage.includes('data-original="' + ORIGIN + '/avif/avif-lazy.avif"') && avifPage.includes('<a href="' + ORIGIN + '/avif/avif-link.avif">'));
  check('AVIF page: two cards share ONE preview URL with different AVIF originals', (avifPage.match(/avif\/prev-shared\.png"/g) || []).length === 2 && avifPage.includes('avif-card-one.avif') && avifPage.includes('avif-card-two.avif'));
  check('AVIF page: the frame resolves a relative AVIF to a different file than the top page would', text('/avif/frame.html').includes('data-original="rel/avif-frame-rel.avif"') && new URL('rel/avif-frame-rel.avif', ORIGIN + '/avif/frame.html').pathname === '/avif/rel/avif-frame-rel.avif' && new URL('rel/avif-frame-rel.avif', ORIGIN + '/avif.html').pathname === '/rel/avif-frame-rel.avif');
  check('AVIF page: the negatives exist (overlay over two AVIF images, a swapping original, an HTML original, a missing original)', /<div class="ov" style="width:400px;height:150px">/.test(avifPage) && /id="avswap"[\s\S]*setTimeout\(function \(\) \{ im\.setAttribute\('data-original', '[^']*avif-card-two\.avif'\)/.test(avifPage) && avifPage.includes('html-original.avif') && avifPage.includes('missing-original.avif'));
  check('AVIF page: the HTML original is HTML served with 200 and the missing original is 404', ASSETS['/avif/html-original.avif'].type === 'text/html' && !ASSETS['/avif/missing-original.avif'] && (await get(ORIGIN + '/avif/missing-original.avif')).status === 404);
  // DL page: the three behaviours that are not files, observed on the wire
  const dlPage = text('/dl.html');
  check('DL page: every case is in the markup and the originals fail in the stated way', ['DL1', 'DL2', 'DL3', 'DL4', 'DL5', 'DL6', 'DL7', 'DL8', 'DL9', 'DL10', 'DL11', 'DL12'].every((k) => dlPage.includes('<b>' + k + ' ')) && dlPage.includes('data-original="' + ORIGIN + '/dl/html-200.png"') && dlPage.includes('/dl/ignore-range.png') && dlPage.includes('/dl/hang.png') && dlPage.includes('/dl/missing.png') && dlPage.includes('?sig=abc%2Fdef&exp=4102444800'));
  const ir = await get(ORIGIN + '/dl/ignore-range.png', { headers: { Range: 'bytes=0-0' } });
  const reader = ir.body.getReader();
  const first = await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 200));
  const reqLog = await (await get(CROSS + '/__requests', { headers: { 'X-Fixture-Control': '1' } })).json();
  const irEntry = reqLog.filter((r) => r.path === '/dl/ignore-range.png' && r.range === 'bytes=0-0').at(-1);
  check('DL: /dl/ignore-range.png refuses HEAD (405), ignores Range (200, 2 MiB) and the server sees the client closing early', (await get(ORIGIN + '/dl/ignore-range.png', { method: 'HEAD' })).status === 405 && ir.status === 200 && Number(ir.headers.get('content-length')) === IGNORE_RANGE_BYTES && first.value && first.value[0] === 137 && irEntry && irEntry.complete === false && irEntry.sent < IGNORE_RANGE_BYTES, JSON.stringify(irEntry));
  check('DL: /dl/error-500.png answers 500', (await get(ORIGIN + '/dl/error-500.png')).status === 500);
  let hangAborted = false;
  try { await fetch(toLoop(ORIGIN + '/dl/hang.png'), { signal: AbortSignal.timeout(600) }); } catch (e) { hangAborted = true; }
  check('DL: /dl/hang.png never answers (the caller times out)', hangAborted);
  check('DL: /dl/missing.png is 404 and the failing originals have their own preview files', (await get(ORIGIN + '/dl/missing.png')).status === 404 && ['html', 'json', '500', 'hang', 'missing', 'range', 'head'].every((n) => ASSETS['/dl/prev-' + n + '.png'] && ASSETS['/dl/prev-' + n + '.png'].kind === 'png'));
  check('DL: extensionless WebM and MP4 are generic binaries; the HTML ones really are HTML', ASSETS['/v/stream/43'].type === 'application/octet-stream' && ASSETS['/v/stream/43'].kind === 'webm' && ASSETS['/v/stream/42'].kind === 'mp4' && ASSETS['/v/stream/44'].kind === 'html' && ASSETS['/v/html-video.mp4'].type === 'text/html');
  check('every URL referenced by the pages is served (200)', missing.length === 0, missing.join('; '));
  const log = await get(CROSS + '/__requests', { headers: { 'X-Fixture-Control': '1' } });
  check('request log reachable only by a local control client', log.status === 200 && Array.isArray(await log.json()));
  const denied = await get(CROSS + '/__requests');
  check('control endpoint refuses requests without the control header', denied.status === 403);
  console.log(`\nself-check: ${count - failures.length}/${count} passed${FAULT ? ' (fault injected: ' + FAULT + ')' : ''}`);
  return failures.length === 0;
}

// ---- main ----
async function main() {
  if (STOP) {
    const port = Number(positional[0] || 8765);
    const r = await fetch(`http://127.0.0.1:${port}/__shutdown`, { method: 'POST', headers: { 'X-Fixture-Control': '1' }, signal: AbortSignal.timeout(3000) });
    console.log('stop request answered', r.status);
    return;
  }
  await listen();
  if (SELF_CHECK) {
    const watchdog = setTimeout(() => { console.error('self-check timed out after 30 s'); shutdown(3); }, 30000);
    let ok = false;
    try { ok = await selfCheck(); } catch (e) { console.error('self-check error:', e.message); }
    clearTimeout(watchdog);
    shutdown(ok ? 0 : 1);
    return;
  }
  console.log(`GEN-01 acceptance fixture: ${ORIGIN}/   (cross-origin frames via ${CROSS}; loopback only)`);
  console.log(`stop: Ctrl+C, or: node tools/gen01-frame-acceptance-server.js --stop ${PORT}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('\nstopping'); shutdown(0); });
}
main().catch((e) => { console.error(e.message); process.exit(1); });
