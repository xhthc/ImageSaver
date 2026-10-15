// A content script as the manifest loads it into its isolated world: the copy-link kit first for the four sites that share it, then the script itself. A vm sandbox runs this one string.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const WITH_KIT = new Set(['content_x.js', 'content_instagram.js', 'content_tiktok.js', 'content_youtube.js']);

exports.source = (name) => (WITH_KIT.has(name) ? `${read('content/content_copy_kit.js')}\n` : '') + read(`content/${name}`);
