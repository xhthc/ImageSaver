'use strict';
const assert = require('node:assert/strict'), vm = require('node:vm');
const { createTestEnv } = require('./test_context_target_avatar');
const hash = '1234567890abcdef1234567890abcdef';
const providers = [
    ['PixivEngine', 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/23/00/00/41/149989236_p0_master1200.jpg', 'https://www.pixiv.net/artworks/149989236', `https://i.pximg.net/img-original/img/2026/09/23/00/00/41/149989236_p0.png`],
    ['YandereImagesEngine', `https://assets.yande.re/data/preview/${hash}.jpg`, 'https://yande.re/post/show/123', `https://files.yande.re/image/${hash}.png`],
    ['EShuushuuImagesEngine', 'https://e-shuushuu.net/thumbs/2026-09-23-123456.jpg', 'https://e-shuushuu.net/images/123456', `https://e-shuushuu.net/fullsize/${hash}.png`],
    ['DanbooruEngine', `https://cdn.donmai.us/180x180/12/34/${hash}.jpg`, 'https://danbooru.donmai.us/posts/123', `https://cdn.donmai.us/original/12/34/${hash}.png`],
    ['GelbooruEngine', `https://gelbooru.com/thumbnails/12/34/thumbnail_${hash}.jpg`, 'https://gelbooru.com/index.php?page=post&s=view&id=123', `https://gelbooru.com/images/12/34/${hash}.png`],
    ['MoebooruEngine', `https://konachan.com/data/preview/${hash}.jpg`, 'https://konachan.com/post/show/123', `https://konachan.com/data/${hash}.png`],
    ['PhilomenaEngine', 'https://derpicdn.net/img/view/2026/9/23/1234567.jpg', 'https://derpibooru.org/images/1234567', `https://derpicdn.net/img/view/2026/9/23/1234567.png`],
    ['E621Engine', `https://static1.e621.net/data/preview/12/34/${hash}.jpg`, 'https://e621.net/posts/123', `https://static1.e621.net/data/12/34/${hash}.png`]
];
let passed = 0, failed = 0;
(async () => {
    for (const [name, src, page, path] of providers)
        for (const mode of ['valid', 'stalled', 'oversized', 'declared oversized', 'malformed', 'HTTP error', 'no stream', 'fetch failure']) {
            const env = createTestEnv(), s = env.bgSandbox, timers = new Set(), signals = [];
            let reads = 0, cancels = 0, unboundedReads = 0;
            const original = path + '?sig=EXACT%2Bsignature&expires=123456&order=2';
            const max = name === 'GelbooruEngine' ? 8 * 1024 * 1024 : 2 * 1024 * 1024;
            const data = name === 'PixivEngine' ? { error: false, body: [{ urls: { original } }] } : name === 'PhilomenaEngine' ? { image: { representations: { full: original } } } : name === 'EShuushuuImagesEngine' ? { url: original } : [{ id: 123, md5: hash, file_url: original, file_ext: 'png', file: { url: original, md5: hash } }];
            const text = name === 'GelbooruEngine' ? `<a href="${original}">Original image</a>` : JSON.stringify(data);
            s.TextDecoder = TextDecoder;
            s.setTimeout = (fn, ms) => { const id = setTimeout(fn, Math.min(ms, 20)); timers.add(id); return id; };
            s.clearTimeout = id => { timers.delete(id); clearTimeout(id); };
            s.fetch = async (url, options = {}) => {
                if (options.method === 'HEAD')
                    return { ok: url === original, status: url === original ? 200 : 404, headers: new Headers({ 'content-type': 'image/png', 'content-length': '50000' }) };
                signals.push(options.signal);
                if (name === 'PixivEngine')
                    assert.equal(options.credentials, 'include');
                if (name === 'GelbooruEngine')
                    assert.equal(options.redirect, 'error');
                if (mode === 'fetch failure')
                    throw Error('network failed');
                let at = 0;
                const chunks = mode === 'oversized' ? [new Uint8Array(max), new Uint8Array(1)] : [new TextEncoder().encode(mode === 'malformed' ? (name === 'GelbooruEngine' ? 'no media here' : '{bad JSON') : text)];
                const reader = { read: async () => { reads++; if (mode === 'stalled')
                        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })); return at < chunks.length ? { done: false, value: chunks[at++] } : { done: true }; }, cancel: async () => { cancels++; } };
                const legacy = async (value) => { unboundedReads++; if (mode === 'stalled')
                    await reader.read(); return value; };
                return { ok: mode !== 'HTTP error', status: mode === 'HTTP error' ? 403 : 200, headers: new Headers(mode === 'declared oversized' ? { 'content-length': String(max + 1) } : {}), body: mode === 'no stream' ? null : { getReader: () => reader, cancel: reader.cancel }, json: () => legacy(data), text: () => legacy(text) };
            };
            try {
                const engine = vm.runInContext(`[...KNOWN_SITE_RESOLVERS,...BOORU_ENGINE_RESOLVERS].find(e=>e.name===${JSON.stringify(name)})`, env.bgContext);
                let done = false;
                const run = engine.resolve(new URL(src), page, page).then(value => { done = true; return value; });
                const raced = await Promise.race([run, new Promise(r => setTimeout(() => r(null), 200))]);
                if (!done)
                    throw Error('resolver body did not finish before test deadline');
                assert(signals.length > 0, 'metadata endpoint must be exercised');
                assert.equal(unboundedReads, 0, 'metadata must be streamed, never json/text read without budget');
                assert(signals.every(signal => signal.aborted), 'request controller released');
                assert.equal(timers.size, 0, 'deadline timers cleared');
                if (mode === 'valid')
                    assert(raced.some(c => (typeof c === 'string' ? c : c.url) === original), 'exact signed original preserved');
                if (mode === 'oversized' || mode === 'stalled')
                    assert(cancels > 0, 'reader cancelled');
                if (mode === 'declared oversized')
                    assert.equal(reads, 0, 'declared size rejected before reading');
                if (mode === 'malformed' || mode === 'HTTP error' || mode === 'no stream' || mode === 'fetch failure')
                    assert(!raced.some(c => (typeof c === 'string' ? c : c.url) === original), 'unverified API original refused');
                passed++;
                console.log('PASS ' + name + ' ' + mode);
            }
            catch (e) {
                failed++;
                console.error('FAIL ' + name + ' ' + mode + ': ' + e.message);
            }
        }
    console.log(`${passed}/${passed + failed} resolver metadata checks passed`);
    if (failed)
        process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
