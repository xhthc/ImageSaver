// test_booru_engines.js - BOORU-ENGINE-01: selected preview/post -> declared original across the Danbooru, Gelbooru and Moebooru
// families, on the public metadata/page shapes recorded from gelbooru.com, safebooru.org, yande.re, konachan.net and
// www.sakugabooru.com (local-notes/checks/booru-engine01/evidence*), plus Danbooru's documented posts.json shape (its pages are
// behind a challenge in an isolated profile). Hashes/ids are the recorded public ones or synthetic; no credentials or tokens.
// Covers ownership (md5/sha1, post id, host), absent/blocked/rate-limited metadata, image/GIF/video and the exact declared URL.
'use strict';
const assert = require('node:assert/strict'), vm = require('node:vm');
const { createTestEnv } = require('./test_context_target_avatar');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}

// --- recorded shapes (trimmed to the parts the resolvers read) ---------------------------------------------------------------
const GEL = { md5: '55d5b37907a06f9e1b76085f2a43cfa4', id: '15081681' };
const gelThumb = `https://img4.gelbooru.com/thumbnails/55/d5/thumbnail_${GEL.md5}.jpg`;
const gelPost = `https://gelbooru.com/index.php?page=post&s=view&id=${GEL.id}&tags=rating%3Ageneral`;
const gelOriginal = `https://img4.gelbooru.com/images/55/d5/${GEL.md5}.jpg`;
const gelHtml = `<img alt="" id="image" class="fit-width" src="https://img4.gelbooru.com//samples/55/d5/sample_${GEL.md5}.jpg">
<li><a href="${gelOriginal}" target="_blank" rel="noopener" style="font-weight: bold;">Original image</a><br></li>`;
const GELV = { md5: '6518d194b0490c8529197592e5bb4507', id: '15080456' };
const gelVideoHtml = `<video width="1280" height="720" id="gelcomVideoPlayer" class="gelcomVideoPlayer" poster="https://img4.gelbooru.com/images/65/18/${GELV.md5}.jpg" controls="" loop="">
				<source src="https://img4.gelbooru.com/images/65/18/${GELV.md5}.mp4" type="video/mp4">
				<source src="https://img4.gelbooru.com/images/65/18/${GELV.md5}.webm" type="video/webm">
			</video>`;
const GELG = { md5: '2c768eb7d64d89d65cd605e2f7e12192', id: '15079786' };
const gelGifHtml = `<li><a href="https://img4.gelbooru.com//images/2c/76/${GELG.md5}.gif" target="_blank" rel="noopener" style="font-weight: bold;">Original image</a><br></li>`;
const SB = { sha1: 'f1026dee73ec4fa90caeb96adf50849a65b09e7b', id: '7228683' };
const sbThumb = `https://safebooru.org/thumbnails/340/thumbnail_${SB.sha1}.jpg?${SB.id}`;
const sbSample = `https://safebooru.org//samples/340/sample_${SB.sha1}.jpg?${SB.id}`;
const sbPost = `https://safebooru.org/index.php?page=post&s=view&id=${SB.id}`;
const sbOriginal = `https://safebooru.org//images/340/${SB.sha1}.png?${SB.id}`;
const sbHtml = `<li><a href="${sbOriginal}" onclick="if (!window.__cfRLUnblockHandlers) return false; Post.highres(); $('resized_notice').hide(); Note.sample=false; return false;" style="font-weight: bold;">
                Original image
            </a></li>`;
const YAN = { md5: '2dda02e2cc28ceb19e9540fd5a54527e', id: 1270116 };
const yanOriginal = `https://files.yande.re/image/${YAN.md5}/yande.re%201270116%20alia_%28otosaba%29%20armor%20weapon.jpg`;
const yanPost = { id: YAN.id, md5: YAN.md5, file_ext: 'jpg', file_url: yanOriginal, jpeg_url: yanOriginal,
  preview_url: `https://assets.yande.re/data/preview/2d/da/${YAN.md5}.jpg`, sample_url: `https://files.yande.re/sample/${YAN.md5}/yande.re%201270116%20sample%20alia_%28otosaba%29%20armor%20weapon.jpg` };
const KON = { md5: '3726c83606efff1bed4bdea5b5c4131f', id: 409426 };
const konTitle = 'Konachan.com%20-%20409426%20autumn%20black_hair%20original%20yukata';
const konPost = { id: KON.id, md5: KON.md5, file_ext: 'png', file_url: `https://konachan.net/image/${KON.md5}/${konTitle}.png`,
  jpeg_url: `https://konachan.net/jpeg/${KON.md5}/${konTitle}.jpg`, preview_url: `https://konachan.net/data/preview/37/26/${KON.md5}.jpg`,
  sample_url: `https://konachan.net/sample/${KON.md5}/Konachan.com%20-%20409426%20sample%20autumn%20black_hair%20original%20yukata.jpg` };
const SAK = { md5: 'cc3d021965a56ace9af9d38c2e621d1d', id: 318965 };
const sakPost = { id: SAK.id, md5: SAK.md5, file_ext: 'mp4', file_url: `https://www.sakugabooru.com/data/${SAK.md5}.mp4`,
  preview_url: `https://www.sakugabooru.com/data/preview/${SAK.md5}.jpg`, sample_url: `https://www.sakugabooru.com/data/${SAK.md5}.mp4` };
// Danbooru posts.json (documented fields; synthetic id/md5): large_file_url is the sample, media_asset variants name the original
const DAN = { md5: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', id: 7000001 };
const danOriginal = `https://cdn.donmai.us/original/a1/b2/${DAN.md5}.png`;
const danSample = `https://cdn.donmai.us/sample/a1/b2/sample-${DAN.md5}.jpg`;
const danThumb = `https://cdn.donmai.us/180x180/a1/b2/${DAN.md5}.jpg`;
const danPost = { id: DAN.id, md5: DAN.md5, file_ext: 'png', file_url: danOriginal, large_file_url: danSample,
  media_asset: { md5: DAN.md5, file_ext: 'png', variants: [{ type: '180x180', url: danThumb }, { type: 'sample', url: danSample }, { type: 'original', url: danOriginal }] } };

// --- harness ------------------------------------------------------------------------------------------------------------------
function harness(routes) {
  const env = createTestEnv(), s = env.bgSandbox, gets = [], heads = [];
  s.TextDecoder = TextDecoder;
  s.fetch = async (url, o = {}) => {
    url = String(url);
    if (o.method === 'HEAD') { heads.push(url); const h = routes.head?.(url); return h || { ok: false, status: 404, headers: new Headers() }; }
    gets.push(url);
    const hit = (routes.get || []).find(([re]) => re.test(url));
    if (!hit) return { ok: false, status: 404, headers: new Headers(), body: null };
    const [, answer] = hit;
    if (typeof answer === 'number') return { ok: false, status: answer, headers: new Headers(), body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }), cancel: async () => {} } };
    const bytes = new TextEncoder().encode(typeof answer === 'string' ? answer : JSON.stringify(answer));
    let done = false;
    return { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })), cancel: async () => {} }), cancel: async () => {} } };
  };
  const engine = (name) => vm.runInContext(`[...KNOWN_SITE_RESOLVERS,...BOORU_ENGINE_RESOLVERS].find(e=>e.name===${JSON.stringify(name)})`, env.bgContext);
  return {
    gets, heads, env,
    async run(name, src, page, link) {
      const e = engine(name), u = new URL(src);
      assert(e.match(u, page, link), `${name} matches ${src}`);
      const out = await e.resolve(u, page, link);
      // host-realm copies: the resolver's arrays come from the VM realm
      return Array.from(out, (c) => (typeof c === 'string' ? { url: c } : { url: c.url, tier: c.tier, score: c.score, allowVideo: c.allowVideo }));
    },
  };
}
const originals = (cands) => cands.filter((c) => c.tier === 'original').map((c) => c.url);
const urls = (cands) => cands.map((c) => c.url);

(async () => {
  // ===== Gelbooru family: gelbooru.com, safebooru.org (HTML post page "Original image") ==================================
  await test('gelbooru feed photo: the selected post page declares the original', async () => {
    const h = harness({ get: [[/page=post&s=view&id=15081681/, gelHtml]] });
    const c = await h.run('GelbooruEngine', gelThumb, 'https://gelbooru.com/index.php?page=post&s=list', gelPost);
    assert.deepEqual(originals(c), [gelOriginal]);
  });
  await test('gelbooru feed video: the player source is the original MP4 and may be a video', async () => {
    const h = harness({ get: [[/id=15080456/, gelVideoHtml]] });
    const c = await h.run('GelbooruEngine', `https://img4.gelbooru.com/thumbnails/65/18/thumbnail_${GELV.md5}.jpg`, 'https://gelbooru.com/index.php?page=post&s=list', `https://gelbooru.com/index.php?page=post&s=view&id=${GELV.id}`);
    const o = c.filter((x) => x.tier === 'original');
    assert.equal(o.length, 1);
    assert.equal(o[0].url, `https://img4.gelbooru.com/images/65/18/${GELV.md5}.mp4`);
    assert.equal(o[0].allowVideo, true);
  });
  await test('gelbooru feed GIF: the declared GIF original, exactly as written', async () => {
    const h = harness({ get: [[/id=15079786/, gelGifHtml]] });
    const c = await h.run('GelbooruEngine', `https://img4.gelbooru.com/thumbnails/2c/76/thumbnail_${GELG.md5}.jpg`, 'https://gelbooru.com/index.php?page=post&s=list', `https://gelbooru.com/index.php?page=post&s=view&id=${GELG.id}`);
    assert.deepEqual(originals(c), [`https://img4.gelbooru.com//images/2c/76/${GELG.md5}.gif`]);
  });
  await test('safebooru.org feed: whitespace-wrapped "Original image" is read; the declared URL keeps its //images/ path and ?id query', async () => {
    const h = harness({ get: [[/safebooru\.org\/index\.php\?page=post&s=view&id=7228683/, sbHtml]] });
    const c = await h.run('GelbooruEngine', sbThumb, 'https://safebooru.org/index.php?page=post&s=list', sbPost);
    assert.deepEqual(originals(c), [sbOriginal]);
  });
  await test('safebooru.org opened post: the sample on the post page resolves through the page itself', async () => {
    const h = harness({ get: [[/id=7228683/, sbHtml]] });
    const c = await h.run('GelbooruEngine', sbSample, sbPost, null);
    assert.deepEqual(originals(c), [sbOriginal]);
  });
  await test('gelbooru: a post page declaring another file (md5) is refused', async () => {
    const other = 'ffffffffffffffffffffffffffffffff';
    const h = harness({ get: [[/id=15081681/, gelHtml.replace(`/images/55/d5/${GEL.md5}`, `/images/ff/ff/${other}`)]] });
    const c = await h.run('GelbooruEngine', gelThumb, 'https://gelbooru.com/index.php?page=post&s=list', gelPost);
    assert.deepEqual(originals(c), []);
    assert(!urls(c).some((u) => u.includes(other)));
  });
  await test('safebooru.org: a post page declaring another file (sha1 name) is refused', async () => {
    const h = harness({ get: [[/id=7228683/, sbHtml.replace(SB.sha1, '0'.repeat(40))]] });
    const c = await h.run('GelbooruEngine', sbThumb, 'https://safebooru.org/index.php?page=post&s=list', sbPost);
    assert.deepEqual(originals(c), []);
  });
  await test('safebooru.org: a link to another post than the preview\'s own id is not read (cross-post link)', async () => {
    const h = harness({ get: [[/id=999/, sbHtml]] });
    const c = await h.run('GelbooruEngine', sbThumb, 'https://safebooru.org/index.php?page=post&s=list', 'https://safebooru.org/index.php?page=post&s=view&id=999');
    assert.deepEqual(originals(c), []);
    assert.equal(h.gets.length, 0, 'no post page of another post is fetched');
  });
  await test('gelbooru: a post page without a declared original yields no original-tier candidate', async () => {
    const h = harness({ get: [[/id=15081681/, '<img id="image" src="x.jpg">']] });
    const c = await h.run('GelbooruEngine', gelThumb, 'https://gelbooru.com/index.php?page=post&s=list', gelPost);
    assert.deepEqual(originals(c), []);
  });
  for (const status of [401, 403, 429, 503]) {
    await test(`gelbooru: post page HTTP ${status} yields no original-tier candidate`, async () => {
      const h = harness({ get: [[/id=15081681/, status]] });
      const c = await h.run('GelbooruEngine', gelThumb, 'https://gelbooru.com/index.php?page=post&s=list', gelPost);
      assert.deepEqual(originals(c), []);
    });
  }

  // ===== Moebooru family: yande.re, konachan.net, www.sakugabooru.com (post.json?tags=md5:) =================================
  await test('yande.re feed preview: the md5 answer\'s file_url is the original', async () => {
    const h = harness({ get: [[/^https:\/\/yande\.re\/post\.json\?tags=md5:2dda02e2cc28ceb19e9540fd5a54527e$/, [yanPost]]] });
    const c = await h.run('MoebooruEngine', yanPost.preview_url, 'https://yande.re/post', 'https://yande.re/post/show/1270116');
    assert.deepEqual(originals(c), [yanOriginal]);
  });
  await test('yande.re opened post: the sample shown on the post resolves through the md5 answer, not only by renaming', async () => {
    const h = harness({ get: [[/yande\.re\/post\.json\?tags=md5:2dda/, [yanPost]]] });
    const c = await h.run('MoebooruEngine', yanPost.sample_url, 'https://yande.re/post/show/1270116', null);
    assert.equal(c[0].url, yanOriginal);
    assert.equal(c[0].tier, 'original');
  });
  await test('konachan opened post: the sample of a PNG post resolves to the PNG original', async () => {
    const h = harness({ get: [[/^https:\/\/konachan\.net\/post\.json\?tags=md5:3726c83606efff1bed4bdea5b5c4131f$/, [konPost]]] });
    const c = await h.run('MoebooruEngine', konPost.sample_url, 'https://konachan.net/post/show/409426', null);
    assert.deepEqual(originals(c), [konPost.file_url]);
  });
  await test('konachan "larger version" (/jpeg/) resolves to the PNG original, never keeping the JPEG version', async () => {
    const h = harness({ get: [[/konachan\.net\/post\.json\?tags=md5:3726/, [konPost]]] });
    const c = await h.run('MoebooruEngine', konPost.jpeg_url, 'https://konachan.net/post/show/409426', null);
    assert.deepEqual(originals(c), [konPost.file_url]);
    assert(!urls(c).includes(konPost.jpeg_url));
  });
  await test('sakugabooru feed preview: the MP4 original from the www API, allowed as video', async () => {
    const h = harness({ get: [[/^https:\/\/www\.sakugabooru\.com\/post\.json\?tags=md5:cc3d021965a56ace9af9d38c2e621d1d$/, [sakPost]]] });
    const c = await h.run('MoebooruEngine', sakPost.preview_url, 'https://www.sakugabooru.com/post', 'https://www.sakugabooru.com/post/show/318965');
    const o = c.filter((x) => x.tier === 'original');
    assert.deepEqual(o.map((x) => x.url), [sakPost.file_url]);
    assert.equal(o[0].allowVideo, true);
  });
  await test('moebooru: an answer about another md5 (late owner change / cross-post) is refused', async () => {
    const h = harness({ get: [[/post\.json/, [{ ...konPost, md5: 'ffffffffffffffffffffffffffffffff' }]]] });
    const c = await h.run('MoebooruEngine', konPost.sample_url, 'https://konachan.net/post/show/409426', null);
    assert.deepEqual(originals(c), []);
  });
  await test('moebooru: a file_url on a foreign host is refused', async () => {
    const h = harness({ get: [[/post\.json/, [{ ...konPost, file_url: `https://evil.example/image/${KON.md5}/x.png` }]]] });
    const c = await h.run('MoebooruEngine', konPost.preview_url, 'https://konachan.net/post', null);
    assert.deepEqual(originals(c), []);
    assert(!urls(c).some((u) => u.includes('evil.example')));
  });
  for (const answer of [[], 429, 503, 401]) {
    await test(`moebooru: ${Array.isArray(answer) ? 'empty answer' : 'HTTP ' + answer} yields no original-tier candidate`, async () => {
      const h = harness({ get: [[/post\.json/, answer]] });
      const c = await h.run('MoebooruEngine', konPost.sample_url, 'https://konachan.net/post/show/409426', null);
      assert.deepEqual(originals(c), []);
    });
  }

  // ===== yande.re site resolver (KNOWN_SITE_RESOLVERS) ========================================================================
  await test('yande.re resolver: an id answer about another file (related thumbnail on a post page) is refused', async () => {
    const other = { ...yanPost, id: 1, md5: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', file_url: 'https://files.yande.re/image/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/other.jpg' };
    const h = harness({ get: [[/post\.json\?tags=id:/, [other]], [/post\.json\?tags=md5:/, []]], head: () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '50000' }) }) });
    const c = await h.run('YandereImagesEngine', yanPost.preview_url, 'https://yande.re/post/show/1', 'https://yande.re/post/show/1');
    assert(!urls(c).includes(other.file_url));
  });
  await test('yande.re resolver: jpeg_url (the JPEG version) is never offered when file_url fails', async () => {
    const png = { ...yanPost, file_ext: 'png', file_url: yanOriginal.replace('.jpg', '.png'), jpeg_url: `https://files.yande.re/jpeg/${YAN.md5}/yande.re%201270116.jpg` };
    const h = harness({ get: [[/post\.json/, [png]]], head: (u) => (u === png.jpeg_url ? { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': '50000' }) } : null) });
    const c = await h.run('YandereImagesEngine', yanPost.preview_url, 'https://yande.re/post', 'https://yande.re/post/show/1270116');
    assert(!urls(c).includes(png.jpeg_url));
  });

  // ===== Danbooru family (documented posts.json shape) =======================================================================
  await test('danbooru feed preview: only the declared original (file_url / original variant), never the sample', async () => {
    const h = harness({ get: [[/^https:\/\/danbooru\.donmai\.us\/posts\.json\?tags=md5:a1b2c3d4e5f60718293a4b5c6d7e8f90$/, [danPost]]] });
    const c = await h.run('DanbooruEngine', danThumb, 'https://danbooru.donmai.us/posts', 'https://danbooru.donmai.us/posts/7000001');
    assert.deepEqual(originals(c), [danOriginal]);
    assert(!urls(c).includes(danSample));
  });
  await test('danbooru: a post without file_url (restricted) does not promote large_file_url', async () => {
    const restricted = { ...danPost, file_url: undefined, media_asset: { md5: DAN.md5, variants: [{ type: 'sample', url: danSample }] } };
    const h = harness({ get: [[/posts\.json/, [restricted]]] });
    const c = await h.run('DanbooruEngine', danThumb, 'https://danbooru.donmai.us/posts', null);
    assert.deepEqual(originals(c), []);
    assert(!urls(c).includes(danSample));
  });
  await test('danbooru: an answer about another md5 is refused', async () => {
    const h = harness({ get: [[/posts\.json/, [{ ...danPost, md5: 'ffffffffffffffffffffffffffffffff', media_asset: { md5: 'ffffffffffffffffffffffffffffffff', variants: [] } }]]] });
    const c = await h.run('DanbooruEngine', danThumb, 'https://danbooru.donmai.us/posts', null);
    assert.deepEqual(originals(c), []);
  });
  await test('danbooru: a file_url outside donmai.us is refused', async () => {
    const h = harness({ get: [[/posts\.json/, [{ ...danPost, file_url: `https://evil.example/original/${DAN.md5}.png`, media_asset: { md5: DAN.md5, variants: [] } }]]] });
    const c = await h.run('DanbooruEngine', danThumb, 'https://danbooru.donmai.us/posts', null);
    assert.deepEqual(originals(c), []);
  });
  for (const status of [403, 429, 503]) {
    await test(`danbooru: posts.json HTTP ${status} yields no original-tier candidate`, async () => {
      const h = harness({ get: [[/posts\.json/, status]] });
      const c = await h.run('DanbooruEngine', danThumb, 'https://danbooru.donmai.us/posts', null);
      assert.deepEqual(originals(c), []);
    });
  }

  // ===== whole pipeline: verified MIME decides =================================================================================
  await test('pipeline: safebooru.org feed preview saves the exact declared PNG once its MIME is verified', async () => {
    const h = harness({ get: [[/id=7228683/, sbHtml]], head: (u) => (u === sbOriginal ? { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png', 'content-length': '900000' }) } : null) });
    const winner = await vm.runInContext('resolveOriginalImageUrl', h.env.bgContext)({ srcUrl: sbThumb, linkUrl: sbPost, pageUrl: 'https://safebooru.org/index.php?page=post&s=list' });
    assert.equal(winner, sbOriginal);
  });
  await test('pipeline: a declared Moebooru original that answers with HTML is not saved as the original', async () => {
    const h = harness({ get: [[/post\.json/, [konPost]]], head: (u) => (u === konPost.file_url ? { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html', 'content-length': '900' }) } : null) });
    const winner = await vm.runInContext('resolveOriginalImageUrl', h.env.bgContext)({ srcUrl: konPost.sample_url, pageUrl: 'https://konachan.net/post/show/409426' });
    assert.notEqual(winner, konPost.file_url);
  });

  // ===== follow-up: explicit file/asset hash conflicts in an otherwise matching answer =============================================
  const OTHER = 'ffffffffffffffffffffffffffffffff';
  await test('moebooru: matching post md5 with a file_url naming another hash is refused', async () => {
    const h = harness({ get: [[/post\.json/, [{ ...konPost, file_url: `https://konachan.net/image/${OTHER}/other.png` }]]] });
    const c = await h.run('MoebooruEngine', konPost.preview_url, 'https://konachan.net/post/show/409426', null);
    assert.deepEqual(originals(c), []);
  });
  await test('moebooru: an own-host file_url naming no hash (opaque) is kept exactly', async () => {
    const opaque = 'https://konachan.net/image/download?id=409426&sig=EXACT%2Bsig';
    const h = harness({ get: [[/post\.json/, [{ ...konPost, file_url: opaque }]]] });
    const c = await h.run('MoebooruEngine', konPost.preview_url, 'https://konachan.net/post/show/409426', null);
    assert.deepEqual(originals(c), [opaque]);
  });
  await test('danbooru: matching post md5 with a file_url naming another hash is refused', async () => {
    const h = harness({ get: [[/posts\.json/, [{ ...danPost, file_url: `https://cdn.donmai.us/original/ff/ff/${OTHER}.png`, media_asset: { md5: DAN.md5, variants: [] } }]]] });
    const c = await h.run('DanbooruEngine', danThumb, 'https://danbooru.donmai.us/posts', null);
    assert.deepEqual(originals(c), []);
  });
  await test('danbooru: matching post md5 with media_asset.md5 of another file is refused (post/asset conflict)', async () => {
    const h = harness({ get: [[/posts\.json/, [{ ...danPost, file_url: undefined, media_asset: { md5: OTHER, variants: [{ type: 'original', url: `https://cdn.donmai.us/original/ff/ff/${OTHER}.png` }] } }]]] });
    const c = await h.run('DanbooruEngine', danThumb, 'https://danbooru.donmai.us/posts', null);
    assert.deepEqual(originals(c), []);
  });
  await test('danbooru: matching post md5 with an original variant naming another hash is refused, file_url still offered', async () => {
    const h = harness({ get: [[/posts\.json/, [{ ...danPost, media_asset: { md5: DAN.md5, variants: [{ type: 'original', url: `https://cdn.donmai.us/original/ff/ff/${OTHER}.png` }] } }]]] });
    const c = await h.run('DanbooruEngine', danThumb, 'https://danbooru.donmai.us/posts', null);
    assert.deepEqual(originals(c), [danOriginal]);
  });

  // ===== follow-up: complete resolver entry (resolveOriginalMediaPlan): engine refusal stays a refusal ===========================
  const ok = (mime, size = '900000') => ({ ok: true, status: 200, headers: new Headers({ 'content-type': mime, 'content-length': size }) });
  const plan = async (h, args) => {
    const p = await vm.runInContext('resolveOriginalMediaPlan', h.env.bgContext)(args);
    return { url: p?.primaryUrl || null, error: p?.error || null, tier: p?.tier || null };
  };
  // HEAD answers available in every scenario: the selected rendition, the PNG original and a foreign-hash file all answer as images
  const konHeads = (u) => (u === konPost.jpeg_url || u === konPost.sample_url ? ok('image/jpeg') : u === `https://konachan.net/image/${OTHER}/other.png` ? ok('image/png') : null);
  const KON_SCENARIOS = [
    ['metadata 403', 403],
    ['metadata 429', 429],
    ['metadata 503', 503],
    ['absent original', [{ id: KON.id, md5: KON.md5, jpeg_url: konPost.jpeg_url }]],
    ['wrong md5', [{ id: 1, md5: OTHER, file_ext: 'png', file_url: `https://konachan.net/image/${OTHER}/other.png` }]],
    ['matching md5, file of another hash', [{ ...konPost, file_url: `https://konachan.net/image/${OTHER}/other.png` }]],
  ];
  for (const selected of ['jpeg_url', 'sample_url', 'preview_url']) for (const [label, answer] of KON_SCENARIOS) {
    await test(`pipeline: konachan ${selected} with ${label} is refused (no rendition, no other file)`, async () => {
      // every md5/post endpoint (the engine's and any generic lookup) gets the same answer
      const h = harness({ get: [[/konachan\.net\/(?:post|posts|index)/, answer]], head: konHeads });
      const r = await plan(h, { srcUrl: konPost[selected], pageUrl: 'https://konachan.net/post/show/409426' });
      assert.equal(r.error, 'NOT_FOUND', JSON.stringify(r));
      assert(!h.gets.some((u) => /posts\.json|page=dapi/.test(u)), 'the unbound generic md5 lookup is not used for a booru rendition');
    });
  }
  await test('pipeline: konachan declared PNG answering HTML is refused, never the JPEG version', async () => {
    const h = harness({ get: [[/post\.json/, [konPost]]], head: (u) => (u === konPost.file_url ? ok('text/html', '900') : konHeads(u)) });
    const r = await plan(h, { srcUrl: konPost.jpeg_url, pageUrl: 'https://konachan.net/post/show/409426' });
    assert.equal(r.error, 'NOT_FOUND');
  });
  await test('pipeline: gelbooru thumbnail with post page 503 and no original is refused, not saved as the thumbnail', async () => {
    const h = harness({ get: [[/id=15081681/, 503]], head: (u) => (u === gelThumb ? ok('image/jpeg', '9000') : null) });
    const r = await plan(h, { srcUrl: gelThumb, linkUrl: gelPost, pageUrl: 'https://gelbooru.com/index.php?page=post&s=list' });
    assert.equal(r.error, 'NOT_FOUND');
  });
  await test('pipeline: danbooru preview whose answer is about another file is refused', async () => {
    const other = `https://cdn.donmai.us/original/ff/ff/${OTHER}.png`;
    const h = harness({ get: [[/posts\.json/, [{ ...danPost, md5: OTHER, file_url: other, media_asset: { md5: OTHER, variants: [] } }]]], head: (u) => (u === other || u === danThumb ? ok('image/png') : null) });
    const r = await plan(h, { srcUrl: danThumb, pageUrl: 'https://danbooru.donmai.us/posts' });
    assert.equal(r.error, 'NOT_FOUND');
  });
  // success controls
  await test('control: konachan sample with a valid answer saves the declared PNG', async () => {
    const h = harness({ get: [[/post\.json/, [konPost]]], head: (u) => (u === konPost.file_url ? ok('image/png') : konHeads(u)) });
    const r = await plan(h, { srcUrl: konPost.sample_url, pageUrl: 'https://konachan.net/post/show/409426' });
    assert.deepEqual(r, { url: konPost.file_url, error: null, tier: 'original' });
  });
  await test('control: konachan /jpeg/ with a valid answer saves the declared PNG', async () => {
    const h = harness({ get: [[/post\.json/, [konPost]]], head: (u) => (u === konPost.file_url ? ok('image/png') : konHeads(u)) });
    const r = await plan(h, { srcUrl: konPost.jpeg_url, pageUrl: 'https://konachan.net/post/show/409426' });
    assert.equal(r.url, konPost.file_url);
    assert.equal(r.error, null);
  });
  await test('control: gelbooru thumbnail with the declared original saves it', async () => {
    const h = harness({ get: [[/id=15081681/, gelHtml]], head: (u) => (u === gelOriginal ? ok('image/jpeg') : null) });
    const r = await plan(h, { srcUrl: gelThumb, linkUrl: gelPost, pageUrl: 'https://gelbooru.com/index.php?page=post&s=list' });
    assert.equal(r.url, gelOriginal);
    assert.equal(r.error, null);
  });
  await test('control: danbooru preview with metadata 403 still saves a same-hash original path that verifies', async () => {
    const h = harness({ get: [[/posts\.json/, 403]], head: (u) => (u === danOriginal ? ok('image/png') : null) });
    const r = await plan(h, { srcUrl: danThumb, pageUrl: 'https://danbooru.donmai.us/posts' });
    assert.equal(r.url, danOriginal);
    assert.equal(r.error, null);
  });
  await test('control: a directly selected konachan original is saved as itself even when metadata fails', async () => {
    const h = harness({ get: [[/post\.json/, 503]], head: (u) => (u === konPost.file_url ? ok('image/png') : null) });
    const r = await plan(h, { srcUrl: konPost.file_url, pageUrl: 'https://konachan.net/post/show/409426' });
    assert.equal(r.url, konPost.file_url);
    assert.equal(r.error, null);
  });
  await test('control: a non-booru preview path keeps the generic initial-source fallback', async () => {
    const src = 'https://example.com/preview/picture.jpg';
    const h = harness({ get: [], head: (u) => (u === src ? ok('image/jpeg') : null) });
    const r = await plan(h, { srcUrl: src, pageUrl: 'https://example.com/gallery' });
    assert.equal(r.url, src);
    assert.equal(r.error, null);
  });

  console.log(`\n${passed}/${passed + failed} booru engine checks passed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
