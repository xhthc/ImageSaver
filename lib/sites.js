// The supported sites, one record each, in the order the statistics menu lists them (UA-05).
//   id       the persistent identity: a statistics bucket and a download-folder name. Never renamed or reordered without a counter migration.
//   domains  registrable domains (the host itself or a subdomain, never a suffix of an unrelated name) whose pages and media CDNs the folder lookup maps to this id;
//            a record without domains is a statistics id only (its folder is named after the page host).
//   booru    the statistics view groups these ids under "Booru" (a view only: the buckets and the ledger stay individual).
// This is naming, not authority: which hosts a resolver may fetch from stays with its own explicit allowlist (worker/booru_resolvers.js, worker/site_resolvers.js).
// A classic script: importScripts in the worker, imported for its global by the UI bundle, require() in Node tests.
(function (root) {
  const SITES = Object.freeze([
    { id: 'x', domains: ['x.com', 'twitter.com', 'twimg.com'] }, // includes the media CDN, so a direct CDN tab is canonicalized to x
    { id: 'reddit', domains: ['reddit.com', 'redd.it'] },
    { id: 'pixiv', domains: ['pixiv.net', 'pximg.net'] },
    { id: 'redgifs', domains: ['redgifs.com'] },
    { id: 'pawchive' },
    { id: 'zerochan', domains: ['zerochan.net'] },
    { id: 'anime-pictures', domains: ['anime-pictures.net'] },
    { id: 'danbooru', domains: ['donmai.us'], booru: true },
    { id: 'rule34', domains: ['rule34.xxx'], booru: true },
    { id: 'safebooru', domains: ['safebooru.org'], booru: true },
    { id: 'gelbooru', domains: ['gelbooru.com'], booru: true },
    { id: 'realbooru', domains: ['realbooru.com'], booru: true },
    { id: 'xbooru', domains: ['xbooru.com'], booru: true },
    { id: 'hypnohub', domains: ['hypnohub.net'], booru: true },
    { id: 'tbib', domains: ['tbib.org'], booru: true },
    { id: 'curveybooru', domains: ['curveybooru.com'], booru: true },
    { id: 'inkbooru', domains: ['inkbooru.com'], booru: true },
    { id: 'mspabooru', domains: ['mspabooru.com'], booru: true },
    { id: 'scatbooru', domains: ['scatbooru.com'], booru: true },
    { id: 'yakui', domains: ['yakui.ru'], booru: true },
    { id: 'e621', domains: ['e621.net', 'e926.net', 'e6ai.net'], booru: true },
    { id: 'yande.re', domains: ['yande.re'], booru: true },
    { id: 'konachan', domains: ['konachan.com', 'konachan.net'], booru: true },
    { id: 'e-shuushuu', domains: ['e-shuushuu.net'] },
    { id: 'sankaku', domains: ['sankakucomplex.com'], booru: true },
    { id: 'tenor', domains: ['tenor.com'] },
    { id: 'giphy', domains: ['giphy.com'] },
    { id: 'wikimedia', domains: ['wikimedia.org', 'wikipedia.org'] }
  ].map(Object.freeze));
  root.MediaLatchSites = Object.freeze({ SITES });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MediaLatchSites;
})(typeof globalThis !== 'undefined' ? globalThis : self);
