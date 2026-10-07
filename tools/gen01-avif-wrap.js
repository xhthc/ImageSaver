'use strict';
// Fixture tooling only (never loaded by the extension). Wraps one AV1 temporal unit, as produced by a WebCodecs
// VideoEncoder('av01.0.04M.08') key frame (see tools/gen01-fixtures/avif/README.md), into a still-image AVIF file:
//   node tools/gen01-avif-wrap.js <in.av1tu> <out.avif> <width> <height>
// The container is written by hand (ftyp 'avif', meta{hdlr,pitm,iloc,iinf,iprp{ispe,pixi,av1C,colr,ipma}}, mdat); the AV1
// payload is the encoder's own output (temporal delimiter dropped, still_picture set in the sequence header).
const fs = require('fs');

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const full = (type, version, flags, ...parts) => box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

const leb128 = (buf, pos) => {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = buf[pos + i];
    value |= (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return { value, length: i + 1 };
  }
  throw new Error('bad leb128');
};

// OBUs with a size field (the low-overhead format WebCodecs emits).
const parseObus = (tu) => {
  const out = [];
  for (let p = 0; p < tu.length;) {
    const header = tu[p];
    if (!(header & 2)) throw new Error('OBU without size field');
    const ext = (header >> 2) & 1;
    const { value, length } = leb128(tu, p + 1 + ext);
    const start = p + 1 + ext + length;
    out.push({ type: (header >> 3) & 15, raw: tu.subarray(p, start + value), payload: tu.subarray(start, start + value), headerLength: start - p });
    p = start + value;
  }
  return out;
};

const bits = (buf) => {
  let pos = 0;
  return { read: (n) => { let v = 0; for (let i = 0; i < n; i++, pos++) v = v * 2 + ((buf[pos >> 3] >> (7 - (pos & 7))) & 1); return v; } };
};

function wrap(tu, width, height) {
  const obus = parseObus(tu);
  const seq = obus.find((o) => o.type === 1);
  const frames = obus.filter((o) => o.type === 6 || o.type === 3 || o.type === 4);
  if (!seq || frames.length === 0) throw new Error('no sequence header or frame OBU');
  // sequence header: profile(3) still_picture(1) reduced_still_picture_header(1) ...
  const seqPayload = Buffer.from(seq.payload);
  const r = bits(seqPayload);
  const profile = r.read(3);
  const still = r.read(1);
  const reduced = r.read(1);
  if (reduced) throw new Error('reduced still picture header is not expected from the video encoder');
  const timing = r.read(1);
  if (timing) throw new Error('timing info not expected');
  r.read(1); // initial_display_delay_present_flag
  if (r.read(5) !== 0) throw new Error('several operating points not expected');
  r.read(12); // operating_point_idc[0]
  const level = r.read(5);
  const tier = level > 7 ? r.read(1) : 0;
  if (!still) seqPayload[0] |= 0x10; // a single key frame: mark the sequence as a still picture
  const seqObu = Buffer.concat([seq.raw.subarray(0, seq.headerLength), seqPayload]);
  const itemData = Buffer.concat([seqObu, ...frames.map((o) => o.raw)]);

  const av1C = box('av1C', Buffer.from([0x81, (profile << 5) | level, (tier << 7) | 0x0c, 0x00]), seqObu);
  const ispe = full('ispe', 0, 0, u32(width), u32(height));
  const pixi = full('pixi', 0, 0, Buffer.from([3, 8, 8, 8]));
  const colr = box('colr', Buffer.from('nclx', 'latin1'), u16(1), u16(13), u16(1), Buffer.from([0x00])); // sRGB primaries/transfer, BT.709 matrix, limited range
  const ipco = box('ipco', ispe, pixi, av1C, colr);
  // item 1 is associated with ispe(1), pixi(2), av1C(3, essential) and colr(4)
  const ipma = full('ipma', 0, 0, u32(1), u16(1), Buffer.from([4, 0x01, 0x02, 0x83, 0x04]));
  const iprp = box('iprp', ipco, ipma);
  const iinf = full('iinf', 0, 0, u16(1), full('infe', 2, 0, u16(1), u16(0), Buffer.from('av01', 'latin1'), Buffer.from([0])));
  const hdlr = full('hdlr', 0, 0, u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(12), Buffer.from([0]));
  const pitm = full('pitm', 0, 0, u16(1));
  const ftyp = box('ftyp', Buffer.from('avif', 'latin1'), u32(0), Buffer.from('avifmif1miaf', 'latin1'));
  const ilocFor = (offset) => full('iloc', 0, 0, Buffer.from([0x44, 0x00]), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(itemData.length));
  const metaSize = box('meta', Buffer.alloc(4), hdlr, pitm, ilocFor(0), iinf, iprp).length;
  const offset = ftyp.length + metaSize + 8;
  const meta = full('meta', 0, 0, hdlr, pitm, ilocFor(offset), iinf, iprp);
  const mdat = box('mdat', itemData);
  const file = Buffer.concat([ftyp, meta, mdat]);
  if (file.length !== offset + itemData.length) throw new Error('layout mismatch');
  return file;
}

module.exports = { wrap, parseObus };

if (require.main === module) {
  const [, , input, output, w, h] = process.argv;
  if (!input || !output || !w || !h) throw new Error('usage: node tools/gen01-avif-wrap.js <in.av1tu> <out.avif> <width> <height>');
  fs.writeFileSync(output, wrap(fs.readFileSync(input), Number(w), Number(h)));
  console.log('wrote', output);
}
