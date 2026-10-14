# AVIF fixtures (GEN-01 acceptance server)

Real AVIF still pictures for `tools/fixtures/generic-media-server.js` (`/avif.html`). They are test data, not part of the
extension runtime, and no dependency was added.

## Origin and licence

- **Content:** synthetic, created for this repository: a flat colour with a white band and a text label (for example
  `AVIF DIRECT`). No third-party picture, photo or font data is included.
- **Encoder:** the browser's own AV1 encoder, `VideoEncoder('av01.0.04M.08')` in Chromium (libaom, BSD-2-Clause with the AOMedia
  patent licence), one key frame per picture. The page that drives it is `tools/fixtures/avif-encode.html`.
- **Container:** written by hand by `tools/fixtures/avif-wrap.js` (`ftyp avif`, one `av01` item with `ispe`, `pixi`, `av1C`,
  `colr`; the temporal delimiter is dropped and `still_picture` is set in the sequence header, the frame OBU is the encoder's).
- **Licence:** the files are produced by this project and distributed with it under the repository's terms; there is no
  separate third-party licence.
- **Not renamed:** none of these is a PNG or JPEG with an `.avif` extension. `--self-check` parses each container and its AV1
  OBUs; the checksums are in `SHA256SUMS` (`sha256sum -c SHA256SUMS`).

## Decoding evidence

All nine files were decoded in Chromium 152 (built-in browser pane) with both `createImageBitmap` and `ImageDecoder`
(`image/avif`) at their declared sizes, and rendered by `<img>` on `/avif.html`; a decoded pixel of each matches its colour.
This is a decode check of the fixture, not an extension acceptance.

| File | Size | Pixels | Label / colour | SHA-256 |
|---|---|---|---|---|
| `avif-direct.avif` | 2077 B | 240x160 | AVIF DIRECT / teal | `de589f69a3a5949153f445cb1b42d39e1d64347304f7bd78d7d96ae442e8c18b` |
| `avif-pic-small.avif` | 2463 B | 240x160 | AVIF PIC SMALL / purple | `037b2010000490e0cc9bdd51e9b12c240bafe81c3ac21e87b59e23bd33fb69aa` |
| `avif-pic-large.avif` | 4254 B | 480x320 | AVIF PIC LARGE / dark purple | `035fac010d66da9f1bff9f7c4b328405ce648edb89f63f9f3f0e778aceb29368` |
| `avif-card-one.avif` | 5504 B | 480x320 | AVIF ORIGINAL ONE / orange | `32bd8311a180da5911735e64e96e85a08158cf1c9ca76e6e50c27f3c079a8bd9` |
| `avif-card-two.avif` | 4847 B | 480x320 | AVIF ORIGINAL TWO / green | `3f873b74d72ef751009ade25c164d6b9b291fbf565d2b44161e9b75277d04db4` |
| `avif-frame-rel.avif` | 4492 B | 480x320 | AVIF FRAME REL / blue | `00ae4e266644ae8d28ff0c4b05224f4dd237d1477c2f0eda0a61240cc4df8319` |
| `avif-lazy.avif` | 5530 B | 480x320 | AVIF LAZY ORIGINAL / pink | `759913091d0dccebd728375ceed231fa5b01c4d23eccdf581d6217908e548df1` |
| `avif-link.avif` | 4559 B | 480x320 | AVIF LINK ORIGINAL / olive | `7a8c7ee8bc4f60037874b1dba3cdc9bad261a927042254009622aec11002289a` |
| `avif-wrong-rel.avif` | 5268 B | 480x320 | AVIF WRONG TOP / red (the decoy) | `21b02252fa80ba0b3e0c3448025e00a19dbac9c22a123e49d6e42944b93961fc` |

## Regenerating

1. Serve the repository over `http://localhost` and open `tools/fixtures/avif-encode.html` in Chromium, press the button, keep the
   nine `<name>.av1tu` downloads.
2. `node tools/fixtures/avif-wrap.js <name>.av1tu tests/fixtures/generic-media/avif/<name>.avif <width> <height>` for each.
3. Update `SHA256SUMS` and the table above. The bytes differ between encoder versions; the tests do not depend on them except
   through `--self-check` (distinct files, valid container and OBUs) and `SHA256SUMS`.
