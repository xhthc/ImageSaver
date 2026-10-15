// The service worker's importScripts for a vm sandbox: each script of the extension (path relative to the repository root, as background.js names it) runs in the sandbox.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');

exports.importScripts = (sandbox) => {
  sandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  return sandbox;
};
