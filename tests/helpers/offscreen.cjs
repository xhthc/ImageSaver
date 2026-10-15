// The offscreen document as offscreen.html loads it: lib/media_guard.js first, then offscreen.js. A vm sandbox of that document runs this one script string.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

exports.source = () => `${read('lib/media_guard.js')}\n${read('offscreen.js')}`;
