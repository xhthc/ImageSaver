'use strict';
// REFACTOR-UNIVERSAL-01 / UA-01: provider routing is decided by the parsed host at a domain-label boundary, never by a domain word anywhere in a URL.
// The real resolver table, candidate scoring and plan construction of lib/ run in the worker context; metadata fetches are a local stub (no network).
// Negative lookalike/query inputs must neither match a provider nor reach its metadata/candidate construction; legitimate hosts (CDN, page, country domains) still do.
const assert = require('node:assert/strict'), vm = require('node:vm');
const { createTestEnv } = require('./test_context_target_avatar');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name); console.error(e.stack || e.message || e); } }

(async () => {
  const env = createTestEnv(), s = env.bgSandbox;
  const table = vm.runInContext('KNOWN_SITE_RESOLVERS', env.bgContext), engine = (name) => table.find((e) => e.name === name);
  const routes = (name, src, page, link) => engine(name).match(new URL(src), page, link);

  console.log('\n--- UA-01: matchers of the resolver table ---');
  await test('Pixiv: the CDN and the site match; a foreign suffix, a prefix word, and the domain in a path/query of the page or link do not', () => {
    const E = 'PixivEngine';
    assert.equal(routes(E, 'https://i.pximg.net/img-master/img/2026/10/12/00/00/00/123_p0_master1200.jpg', 'https://www.pixiv.net/artworks/123', undefined), true);
    assert.equal(routes(E, 'https://example.org/a.jpg', 'https://www.pixiv.net/artworks/123', undefined), true, 'a page on pixiv.net');
    assert.equal(routes(E, 'https://example.org/a.jpg', 'https://example.org/', 'https://www.pixiv.net/artworks/123'), true, 'a link to a Pixiv artwork');
    for (const [src, page, link] of [
      ['https://pximg.net.example.org/123_p0.jpg', 'https://example.org/', undefined],
      ['https://notpximg.net/123_p0.jpg', 'https://example.org/', undefined],
      ['https://example.org/a.jpg', 'https://example.org/?next=pixiv.net', undefined],
      ['https://example.org/a.jpg', 'https://pixiv.net.example.org/artworks/123', undefined],
      ['https://example.org/a.jpg', 'https://example.org/', 'https://example.org/go?to=pixiv.net'],
      ['https://example.org/a.jpg', 'https://example.org/', 'https://example.org/pximg.net/x.jpg']
    ]) assert.equal(routes(E, src, page, link), false, [src, page, link].join(' | '));
  });
  await test('Wikimedia: the project hosts match at a label boundary; "notwikimedia.org" does not', () => {
    const E = 'WikimediaEngine', thumb = 'a/thumb/b/c/200px-c';
    for (const h of ['upload.wikimedia.org', 'commons.wikimedia.org', 'en.wikipedia.org', 'wikipedia.org', 'fr.wiktionary.org']) assert.equal(routes(E, `https://${h}/${thumb}`), true, h);
    for (const h of ['notwikimedia.org', 'fakewikipedia.org', 'wikimedia.org.example.net', 'example.org']) assert.equal(routes(E, `https://${h}/${thumb}`), false, h);
  });
  await test('Google Images: country domains are explicit; a lookalike page or image host is not Google', () => {
    const E = 'GoogleImagesEngine', thumb = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ABC';
    for (const page of ['https://www.google.com/search?tbm=isch', 'https://www.google.co.uk/search?udm=2', 'https://www.google.com.br/search?tbm=isch', 'https://google.de/search?tbm=isch']) assert.equal(routes(E, thumb, page), true, page);
    for (const page of ['https://google.evil.example/search?tbm=isch', 'https://notgoogle.com/search?tbm=isch', 'https://example.org/?q=google.com&tbm=isch']) assert.equal(routes(E, thumb, page), false, page);
    assert.equal(routes(E, 'https://notgstatic.com/images?q=tbn:ABC', 'https://www.google.com/search?tbm=isch'), false, 'a lookalike thumbnail host');
    assert.equal(routes(E, 'https://www.google.fr/imgres?imgurl=https%3A%2F%2Fa.example%2Fx.jpg'), true);
    assert.equal(routes(E, 'https://google.evil.example/imgres?imgurl=https%3A%2F%2Fa.example%2Fx.jpg'), false);
  });
  await test('Yandex Images: yandex.* country domains and ya.ru match; a domain word in a host, path or query does not', () => {
    const E = 'YandexImagesEngine';
    for (const [src, page] of [['https://avatars.mds.yandex.net/get-images/1/x/orig', 'https://yandex.ru/images/search'], ['https://example.org/a.jpg', 'https://yandex.com.tr/gorsel/search'], ['https://example.org/a.jpg', 'https://ya.ru/'], ['https://example.org/a.jpg', 'https://yandex.by/images/']]) assert.equal(routes(E, src, page), true, page);
    for (const [src, page] of [['https://example.org/a.jpg', 'https://notyandex.ru/'], ['https://example.org/a.jpg', 'https://yandex.evil.example/images'], ['https://example.org/a.jpg', 'https://example.org/?q=yandex.ru'], ['https://example.org/a.jpg', 'https://notya.ru/']]) assert.equal(routes(E, src, page), false, page);
  });
  await test('Anime-Pictures: the CDN and site match; a lookalike host or a page alone does not', () => {
    const E = 'AnimePicturesEngine', img = 'https://oimages.anime-pictures.net/4a6/x.jpg';
    assert.equal(routes(E, img, 'https://example.org/'), true); assert.equal(routes(E, 'https://example.org/a.jpg', 'https://example.org/', 'https://anime-pictures.net/posts/1'), true);
    assert.equal(routes(E, 'https://anime-pictures.net.example.org/x.jpg', 'https://example.org/'), false); assert.equal(routes(E, 'https://example.org/a.jpg', 'https://anime-pictures.net/posts/1'), false, 'the page alone never activates it');
    assert.equal(routes(E, 'https://example.org/a.jpg', 'https://example.org/', 'https://anime-pictures.net.example.org/posts/1'), false);
  });

  console.log('\n--- UA-01: downstream candidate construction ---');
  const plan = async (srcUrl, pageUrl, linkUrl, fetched) => {
    s.TextDecoder = TextDecoder; s.console.info = () => {};
    s.fetch = async (url, o = {}) => {
      fetched.push(String(url));
      if (/\/ajax\/illust\/\d+\/pages$/.test(url)) return new Response(JSON.stringify({ error: false, body: [{ urls: { original: 'https://i.pximg.net/img-original/audit/123_p0.png?signature=audit-only' } }] }), { headers: { 'content-type': 'application/json' } });
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
    };
    return s.resolveOriginalMediaPlan({ srcUrl, pageUrl, linkUrl, allowPostMedia: false });
  };
  // the production loop of resolveOriginalMediaPlan over the real table: every engine that matches builds its candidates
  const built = async (srcUrl, pageUrl, linkUrl, fetched) => {
    s.TextDecoder = TextDecoder; s.console.info = () => {};
    s.fetch = async (url) => {
      fetched.push(String(url));
      if (/\/ajax\/illust\/\d+\/pages$/.test(url)) return new Response(JSON.stringify({ error: false, body: [{ urls: { original: 'https://i.pximg.net/img-original/audit/123_p0.png?signature=audit-only' } }] }), { headers: { 'content-type': 'application/json' } });
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
    };
    const urlObj = new URL(srcUrl), out = [];
    for (const site of table) if (site.match(urlObj, pageUrl, linkUrl)) out.push(site.name, ...(await site.resolve(urlObj, pageUrl, linkUrl)).map((c) => (typeof c === 'string' ? c : c.url)));
    return out;
  };
  await test('Yandex: absent page/link context never invents the fallback host or promotes a query image', async () => {
    for (const value of [undefined, null, '']) {
      const src = 'https://example.org/selected.jpg?img_url=https%3A%2F%2Fother.example%2Fother.jpg';
      assert.equal(routes('YandexImagesEngine', src, value, value), false, 'no Yandex ownership for absent context');
      const fetched = [], result = await built(src, value, value, fetched);
      assert(!result.includes('YandexImagesEngine') && !result.includes('https://other.example/other.jpg'), 'no unrelated decoded candidate');
      assert.equal(fetched.length, 0, 'no provider metadata request');
    }
    assert.equal(routes('YandexImagesEngine', 'https://example.org/a.jpg', 'https://example.org/', '//yandex.ru/images/search'), true, 'a network-relative Yandex link remains supported');
    assert.equal(s.urlHostOf('../images/search', 'https://yandex.ru/images/'), 'yandex.ru', 'a path-relative address still uses its supplied base');
  });
  await test('Pixiv lookalikes make no Pixiv metadata request and build no Pixiv candidate; the real CDN still does', async () => {
    for (const [src, page] of [['https://pximg.net.example.org/123_p0.jpg', 'https://example.org/'], ['https://example.org/123_p0_master1200.jpg', 'https://example.org/?from=pixiv.net/artworks/123']]) {
      const fetched = [], out = await built(src, page, '', fetched);
      assert(!out.includes('PixivEngine') && !fetched.some((u) => /pixiv\.net\/ajax/.test(u)), `no routing and no metadata request for ${src} (${out} ${fetched})`);
      assert(!JSON.stringify(out).includes('img-original/audit'), 'no Pixiv-promoted candidate');
    }
    const fetched = [], real = await built('https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/10/12/00/00/00/123_p0_square1200.jpg', 'https://www.pixiv.net/artworks/123', 'https://www.pixiv.net/artworks/123', fetched);
    assert(fetched.some((u) => /pixiv\.net\/ajax\/illust\/123\/pages$/.test(u)), 'the real CDN asks the artwork metadata');
    assert(real.some((u) => /img-original\/audit\/123_p0\.png/.test(u)), 'and builds its declared original');
    // a lookalike page cannot lend its artwork id to a Pixiv-CDN-looking name either
    const lookalikeLink = [], viaLink = await built('https://i.pximg.net/img-master/img/2026/10/12/00/00/00/beef_master1200.jpg', 'https://example.org/', 'https://example.org/artworks/999?x=pixiv.net', lookalikeLink);
    assert(!lookalikeLink.some((u) => /ajax\/illust\/999/.test(u)), 'an artwork id in an unrelated link is not Pixiv ownership');
  });
  await test('a lookalike Wikimedia host is not rewritten to upload.wikimedia.org; the real thumbnail is', async () => {
    const fake = await built('https://notwikimedia.org/a/thumb/b/c/200px-c', 'https://example.org/', '', []);
    assert(!fake.includes('WikimediaEngine') && !JSON.stringify(fake).includes('upload.wikimedia.org'), 'no rewritten candidate for the lookalike: ' + fake);
    const real = await built('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/F.jpg/200px-F.jpg', 'https://commons.wikimedia.org/wiki/File:F.jpg', '', []);
    assert(real.includes('https://upload.wikimedia.org/wikipedia/commons/a/ab/F.jpg'), 'the real thumbnail resolves to its original: ' + real);
  });
  await test('transport and thumbnail rules read the parsed host: pximg.net / gstatic.com / redd.it words elsewhere in a URL change nothing', () => {
    assert.equal(s.inferTransportForUrl('https://i.pximg.net/img-original/a/1_p0.png'), 'pixiv');
    for (const u of ['https://pximg.net.example.org/a.png', 'https://example.org/a.png?src=pximg.net', 'https://example.org/pximg.net/a.png']) assert.equal(s.inferTransportForUrl(u), 'direct', u);
    assert.equal(s.isThumbnailUrl('https://encrypted-tbn0.gstatic.com/images?q=tbn:ABC'), true);
    assert.equal(s.isThumbnailUrl('https://gstatic.com.example.org/images?q=tbn:ABC'), false);
    assert.equal(s.isThumbnailUrl('https://i.pximg.net/img-master/img/2026/10/12/00/00/00/1_p0_master1200.jpg'), true);
    assert.equal(s.isThumbnailUrl('https://pximg.net.example.org/img-master/1_p0_master1200.jpg'), false);
    assert.equal(s.isThumbnailUrl('https://preview.redd.it/abc.jpg?width=640'), true);
    assert.equal(s.isThumbnailUrl('https://notpreview.redd.it.example.org/abc.jpg'), false);
    assert.equal(s.isThumbnailUrl('https://www.zerochan.net.example.org/240/15/27/4728645.avif'), false); assert.equal(s.isThumbnailUrl('https://s3.zerochan.net/240/15/27/4728645.avif'), true);
  });
  await test('the search-engine host predicates the folder rule uses are the ones the resolvers use', () => {
    assert.equal(s.isGoogleHost('www.google.co.uk'), true); assert.equal(s.isGoogleHost('google.evil.example'), false);
    assert.equal(s.isYandexHost('yandex.com.tr'), true); assert.equal(s.isYandexHost('ya.ru'), true); assert.equal(s.isYandexHost('notya.ru'), false);
    assert.equal(s.getKnownFolderSite('www.google.com.au'), 'google'); assert.equal(s.getKnownFolderSite('images.yandex.ru'), 'yandex'); assert.equal(s.getKnownFolderSite('notyandex.ru'), '');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
