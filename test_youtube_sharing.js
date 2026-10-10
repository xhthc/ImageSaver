// test_youtube_sharing.js - Focused offline regressions for SHARE-04 (YouTube Shorts sharing)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (condition) {
    passedTests++;
    console.log(`  ✓ ${message}`);
  } else {
    failedTests++;
    console.error(`  ✗ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Lightweight DOM mock for testing content scripts and popup UI
class TestDomElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = Object.assign({}, attributes);
    this.children = [];
    this.parentElement = null;
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.className = attributes.class || '';
    this.classList = {
      _classes: new Set(this.className ? this.className.split(/\s+/).filter(Boolean) : []),
      add: (...cls) => {
        cls.forEach(c => this.classList._classes.add(c));
        this.className = Array.from(this.classList._classes).join(' ');
      },
      remove: (...cls) => {
        cls.forEach(c => this.classList._classes.delete(c));
        this.className = Array.from(this.classList._classes).join(' ');
      },
      contains: (c) => this.classList._classes.has(c)
    };
    this._innerHTML = '';
    this.value = attributes.value || '';
    this._isConnected = true;
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) { this._innerHTML = val; }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') {
      this.className = String(v);
      this.classList._classes = new Set(this.className.split(/\s+/).filter(Boolean));
    }
    if (k === 'title') this.title = String(v);
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase());
      this.dataset[camel] = String(v);
    }
  }

  getAttribute(k) { return this.attributes[k] || null; }
  hasAttribute(k) { return k in this.attributes; }
  removeAttribute(k) {
    delete this.attributes[k];
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase());
      delete this.dataset[camel];
    }
  }

  appendChild(child) {
    child.parentElement = this;
    delete child._isConnected;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    newChild.parentElement = this;
    delete newChild._isConnected;
    if (!refChild) {
      this.children.push(newChild);
      return newChild;
    }
    const idx = this.children.indexOf(refChild);
    if (idx !== -1) {
      this.children.splice(idx, 0, newChild);
    } else {
      this.children.push(newChild);
    }
    return newChild;
  }

  get nextSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    if (idx !== -1 && idx + 1 < this.parentElement.children.length) {
      return this.parentElement.children[idx + 1];
    }
    return null;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
      child._isConnected = false;
    }
    return child;
  }

  get isConnected() {
    if (this._isConnected !== undefined) return this._isConnected;
    let cur = this;
    while (cur.parentElement) cur = cur.parentElement;
    return cur._isConnected !== undefined ? cur._isConnected : true;
  }

  set isConnected(val) {
    this._isConnected = Boolean(val);
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  dispatchEvent(evt) {
    const type = evt && evt.type;
    if (type && this.listeners[type]) {
      for (const fn of this.listeners[type]) {
        fn(evt);
      }
    }
  }

  click() {
    if (this.listeners['click']) {
      for (const fn of this.listeners['click']) {
        fn({
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {}
        });
      }
    }
  }

  focus() {}
  select() {}

  contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  matches(sel) {
    if (!sel) return false;
    if (sel.includes(',')) {
      return sel.split(',').map(s => s.trim()).some(s => this.matches(s));
    }
    if (sel.startsWith('.')) {
      return this.classList.contains(sel.slice(1)) || (this.className || '').includes(sel.slice(1));
    }
    if (sel.startsWith('#')) {
      return this.getAttribute('id') === sel.slice(1);
    }
    const tagAttrMatch = sel.match(/^([a-zA-Z0-9_-]+)?\[([a-zA-Z0-9_-]+)(?:([*~|^$]?=)["']?([^"'\]]*)["']?(?:\s+i)?)?\]$/);
    if (tagAttrMatch) {
      const [, tag, attrName, op, attrVal] = tagAttrMatch;
      if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      if (!attrVal) return this.hasAttribute(attrName);
      const actualVal = this.getAttribute(attrName) || '';
      if (op === '*=') return actualVal.toLowerCase().includes(attrVal.toLowerCase());
      if (op === '^=') return actualVal.startsWith(attrVal);
      if (op === '$=') return actualVal.endsWith(attrVal);
      return actualVal === attrVal;
    }
    if (/^[a-zA-Z0-9_-]+$/.test(sel)) return this.tagName.toLowerCase() === sel.toLowerCase();
    return false;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel) {
    const res = [];
    const parts = sel.split(',').map(s => s.trim());
    function walk(node) {
      for (const ch of node.children) {
        if (parts.some(s => ch.matches(s))) {
          res.push(ch);
        }
        walk(ch);
      }
    }
    walk(this);
    return res;
  }
}

async function runYouTubeSharingTests() {
  console.log('=== MediaLatch: YouTube Shorts Sharing Regressions (SHARE-04) ===\n');

  // Test 1: Manifest Registration
  console.log('--- Suite 1: Manifest.json Registration and Permissions ---');
  {
    const manifestPath = path.resolve(__dirname, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const ytScript = manifest.content_scripts.find(cs => cs.js && cs.js.includes('content_youtube.js'));
    assert(Boolean(ytScript), 'Manifest: content_youtube.js is registered in content_scripts');
    assert(
      ytScript.matches.some(m => m.includes('youtube.com')),
      'Manifest: YouTube pattern matches youtube.com'
    );
    assert(ytScript.run_at === 'document_start', 'Manifest: content_youtube.js runs at document_start');
    assert(
      !manifest.permissions.includes('tabs') && !manifest.permissions.includes('cookies'),
      'Manifest: No excessive or new permissions added'
    );
  }

  // Load content_youtube.js in sandboxed VM
  const ytPath = path.resolve(__dirname, 'content_youtube.js');
  const ytCode = fs.readFileSync(ytPath, 'utf8');

  let clipboardText = '';
  let fallbackCopiedText = '';
  let execCommandShouldFail = false;
  const mockStorageListeners = [];
  const mockLocalStorage = {};

  const mockChrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(defaults, cb) {
          const res = Object.assign({}, defaults, mockLocalStorage);
          if (typeof cb === 'function') cb(res);
          return Promise.resolve(res);
        },
        set(items, cb) {
          Object.assign(mockLocalStorage, items);
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener(cb) { mockStorageListeners.push(cb); }
      }
    }
  };

  const mockDoc = {
    createElement(tag) { return new TestDomElement(tag); },
    getElementById() { return null; },
    head: new TestDomElement('head'),
    body: new TestDomElement('body'),
    documentElement: new TestDomElement('html'),
    readyState: 'complete',
    addEventListener() {},
    querySelectorAll(sel) { return this.body.querySelectorAll(sel); },
    execCommand(cmd) {
      if (execCommandShouldFail) return false;
      if (cmd === 'copy') {
        const ta = mockDoc.body.children[mockDoc.body.children.length - 1];
        if (ta) {
          let interceptedText = null;
          const copyEvt = {
            type: 'copy',
            clipboardData: {
              setData(format, data) {
                if (format === 'text/plain') interceptedText = data;
              }
            },
            preventDefault() {},
            stopPropagation() {},
            stopImmediatePropagation() {}
          };
          if (typeof ta.dispatchEvent === 'function') {
            ta.dispatchEvent(copyEvt);
          }
          fallbackCopiedText = interceptedText !== null ? interceptedText : (ta.value || '');
          return true;
        }
      }
      return false;
    }
  };

  const mockNavigator = {
    clipboard: {
      writeText: async (t) => { clipboardText = t; }
    }
  };

  const ytSandbox = {
    URL,
    chrome: mockChrome,
    window: {
      addEventListener() {},
      location: { href: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' },
      navigator: mockNavigator
    },
    document: mockDoc,
    navigator: mockNavigator,
    console,
    setTimeout,
    clearTimeout
  };

  vm.createContext(ytSandbox);
  vm.runInContext(ytCode, ytSandbox);

  // Test 2: Video ID Validation
  console.log('\n--- Suite 2: Video ID Validation ---');
  {
    const isValid = ytSandbox.__isValidYouTubeVideoId;
    assert(isValid('dQw4w9WgXcQ') === true, 'Standard 11-char alphanumeric ID is valid');
    assert(isValid('a-b_c123456') === true, '11-char ID with hyphen and underscore is valid');
    assert(isValid('12345678901') === true, '11-char purely numeric ID is valid');
    assert(isValid('shortId') === false, 'Too short ID (< 11 chars) is rejected');
    assert(isValid('wayTooLongId123') === false, 'Too long ID (> 11 chars) is rejected');
    assert(isValid('inv@lid_id1') === false, 'Special character @ is rejected');
    assert(isValid('inv/lid_id1') === false, 'Slash in ID is rejected');
    assert(isValid('') === false, 'Empty string is rejected');
    assert(isValid(null) === false, 'Null is rejected');
    assert(isValid(undefined) === false, 'Undefined is rejected');
  }

  // Test 3: URL Parsing & Strict Host Boundaries
  console.log('\n--- Suite 3: URL Parsing and Approved Host Boundaries ---');
  {
    const parse = ytSandbox.__parseYouTubeShortsUrl;

    // Approved YouTube hosts
    assert(parse('https://www.youtube.com/shorts/dQw4w9WgXcQ') === 'dQw4w9WgXcQ', 'Parses www.youtube.com/shorts/{id}');
    assert(parse('https://youtube.com/shorts/dQw4w9WgXcQ') === 'dQw4w9WgXcQ', 'Parses youtube.com/shorts/{id}');
    assert(parse('https://m.youtube.com/shorts/dQw4w9WgXcQ') === 'dQw4w9WgXcQ', 'Parses m.youtube.com/shorts/{id}');

    // Query parameters stripped
    assert(
      parse('https://www.youtube.com/shorts/dQw4w9WgXcQ?si=tracking123&feature=share&utm_source=test') === 'dQw4w9WgXcQ',
      'Strips tracking parameters and queries'
    );

    // Lookalike and foreign hosts rejected
    assert(parse('https://notyoutube.com/shorts/dQw4w9WgXcQ') === null, 'Rejects lookalike notyoutube.com');
    assert(parse('https://youtube.com.attacker.com/shorts/dQw4w9WgXcQ') === null, 'Rejects subdomain hijacking youtube.com.attacker.com');
    assert(parse('https://evil-youtube.com/shorts/dQw4w9WgXcQ') === null, 'Rejects evil-youtube.com');
    assert(parse('https://google.com/shorts/dQw4w9WgXcQ') === null, 'Rejects foreign host google.com');
    assert(parse('javascript:alert(1)') === null, 'Rejects javascript: scheme');
    assert(parse('file:///C:/video.mp4') === null, 'Rejects file:/// scheme');

    // Invalid ID in path
    assert(parse('https://www.youtube.com/shorts/short') === null, 'Rejects URL with invalid short ID');
    assert(parse('https://www.youtube.com/shorts/invalid_characters!') === null, 'Rejects URL with invalid characters');
  }

  // Test 4: Ordinary watch URLs rejected as Shorts evidence
  console.log('\n--- Suite 4: Ordinary Watch URLs Not Incorrectly Treated as Shorts ---');
  {
    const parse = ytSandbox.__parseYouTubeShortsUrl;
    assert(
      parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === null,
      'Ordinary watch URL is NOT treated as a Short'
    );
    assert(
      parse('https://youtu.be/dQw4w9WgXcQ') === null,
      'Standard youtu.be URL is NOT treated as a Short without explicit shorts path'
    );
    assert(
      parse('https://www.youtube.com/@OfficialChannel') === null,
      'Channel URL is rejected'
    );
    assert(
      parse('https://www.youtube.com/playlist?list=PL1234567890') === null,
      'Playlist URL is rejected'
    );
  }

  // Test 5: Target Share URL Formatting Across Allowed Providers
  console.log('\n--- Suite 5: Share URL Formatting Across Providers ---');
  {
    const fmt = ytSandbox.__formatYouTubeShareUrl;

    const def = fmt('dQw4w9WgXcQ', 'youtube.com');
    assert(def === 'https://youtube.com/shorts/dQw4w9WgXcQ', 'Formats original YouTube default share URL');

    const fx = fmt('dQw4w9WgXcQ', 'yfxtube.com');
    assert(fx === 'https://yfxtube.com/shorts/dQw4w9WgXcQ', 'Formats FxYouTube share URL');

    const kout = fmt('dQw4w9WgXcQ', 'koutube.com');
    assert(kout === 'https://koutube.com/shorts/dQw4w9WgXcQ', 'Formats Koutube share URL');

    const disallowed = fmt('dQw4w9WgXcQ', 'attacker.com');
    assert(disallowed === 'https://youtube.com/shorts/dQw4w9WgXcQ', 'Disallowed host safely reverts to youtube.com default');

    const invalidId = fmt('short', 'yfxtube.com');
    assert(invalidId === null, 'Formatting with invalid ID returns null');
  }

  // Test 6: Extraction from DOM & Per-Item Ownership Isolation
  console.log('\n--- Suite 6: DOM Extraction and Per-Item Ownership ---');
  {
    const extract = ytSandbox.__extractShortVideoId;

    // Renderer 1 with inner short link
    const renderer1 = new TestDomElement('ytd-reel-video-renderer');
    const link1 = new TestDomElement('a', { href: '/shorts/VIDEO_ID_11' });
    renderer1.appendChild(link1);

    // Renderer 2 with inner short link
    const renderer2 = new TestDomElement('ytd-reel-video-renderer');
    const link2 = new TestDomElement('a', { href: 'https://www.youtube.com/shorts/VIDEO_ID_22?feature=share' });
    renderer2.appendChild(link2);

    const id1 = extract(renderer1);
    const id2 = extract(renderer2);

    assert(id1 === 'VIDEO_ID_11', 'Extracts correct video ID from renderer 1');
    assert(id2 === 'VIDEO_ID_22', 'Extracts correct video ID from renderer 2');
    assert(id1 !== id2, 'Per-item isolation: renderer 1 and 2 do not cross-contaminate');
  }

  // Test 7: Active Renderer vs Inactive Neighbor Renderer
  console.log('\n--- Suite 7: Active Short vs Inactive Neighbor Page URL Policy ---');
  {
    const extract = ytSandbox.__extractShortVideoId;
    const pageHref = 'https://www.youtube.com/shorts/ACTIVE_VID1';

    // Active renderer without inner link (e.g. initial view before DOM loads metadata)
    const activeRenderer = new TestDomElement('ytd-reel-video-renderer', { 'is-active': '' });
    const activeId = extract(activeRenderer, pageHref);
    assert(activeId === 'ACTIVE_VID1', 'Active renderer with is-active uses page URL');

    // Inactive preloaded neighbor renderer without inner link
    const inactiveRenderer = new TestDomElement('ytd-reel-video-renderer', { 'aria-hidden': 'true' });
    const inactiveId = extract(inactiveRenderer, pageHref);
    assert(inactiveId === null, 'Inactive preloaded neighbor does NOT borrow page URL (fail closed)');
  }

  // Test 8: Ambiguous Ownership Rejection (Conflicting IDs)
  console.log('\n--- Suite 8: Ambiguous Ownership Rejection ---');
  {
    const extract = ytSandbox.__extractShortVideoId;

    // Container with 2 conflicting video links
    const ambiguousRenderer = new TestDomElement('ytd-reel-video-renderer');
    ambiguousRenderer.appendChild(new TestDomElement('a', { href: '/shorts/CONFLICT_ID1' }));
    ambiguousRenderer.appendChild(new TestDomElement('a', { href: '/shorts/CONFLICT_ID2' }));

    const ambId = extract(ambiguousRenderer);
    assert(ambId === null, 'Conflicting video IDs in same container returns null (fail closed)');
  }

  // Test 9: Injection, Duplicate Prevention, and Native Control Preservation
  console.log('\n--- Suite 9: Button Injection and Native Controls Preservation ---');
  {
    const renderer = new TestDomElement('ytd-reel-video-renderer');
    const actions = new TestDomElement('div', { id: 'actions' });
    renderer.appendChild(actions);

    const likeBtn = new TestDomElement('button', { id: 'like-button' });
    actions.appendChild(likeBtn);

    const shareBtn = new TestDomElement('button', { id: 'share-button' });
    actions.appendChild(shareBtn);

    const inj1 = ytSandbox.__injectCopyButtonToYouTubeShort(renderer);
    assert(inj1 === true, 'Copy button successfully injected into actions container');

    const inj2 = ytSandbox.__injectCopyButtonToYouTubeShort(renderer);
    assert(inj2 === false, 'Duplicate injection prevented on second scan');

    // Verify native buttons are intact
    assert(actions.children.includes(likeBtn), 'Native like button is preserved');
    assert(actions.children.includes(shareBtn), 'Native share button is preserved');

    const copyWrap = actions.querySelector('.image-saver-yt-copy-wrap');
    assert(Boolean(copyWrap), 'Copy button wrapper has correct CSS class');
    assert(copyWrap.getAttribute('role') === 'button', 'Button has role="button"');
    assert(copyWrap.getAttribute('tabindex') === '0', 'Button has tabindex="0"');
    assert(copyWrap.getAttribute('aria-label') === 'Copy Short link', 'Button has accessible aria-label');
  }

  // Test 10: Dynamic Re-Resolution at Click Time (Recycled Nodes)
  console.log('\n--- Suite 10: Recycled Nodes and Stale Closure Prevention ---');
  {
    const renderer = new TestDomElement('ytd-reel-video-renderer');
    const actions = new TestDomElement('div', { id: 'actions' });
    renderer.appendChild(actions);
    const link = new TestDomElement('a', { href: '/shorts/INITIAL_ID1' });
    renderer.appendChild(link);

    ytSandbox.__injectCopyButtonToYouTubeShort(renderer);
    const copyWrap = actions.querySelector('.image-saver-yt-copy-wrap');

    ytSandbox.__setCachedYtShareHost('youtube.com');
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(clipboardText === 'https://youtube.com/shorts/INITIAL_ID1', 'Copies initial video ID');

    // Simulate SPA node recycling: link changes to new video
    link.setAttribute('href', '/shorts/UPDATED_ID2');
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(clipboardText === 'https://youtube.com/shorts/UPDATED_ID2', 'Re-resolves dynamically at click time (no stale closure ID)');
  }

  // Test 11: Dynamic Storage Updates
  console.log('\n--- Suite 11: Dynamic Storage Updates ---');
  {
    const renderer = new TestDomElement('ytd-reel-video-renderer');
    const actions = new TestDomElement('div', { id: 'actions' });
    renderer.appendChild(actions);
    renderer.appendChild(new TestDomElement('a', { href: '/shorts/SYNC_TEST_1' }));

    ytSandbox.__injectCopyButtonToYouTubeShort(renderer);
    const copyWrap = actions.querySelector('.image-saver-yt-copy-wrap');

    // Switch to FxYouTube
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'yfxtube.com' } }, 'local'));
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(clipboardText === 'https://yfxtube.com/shorts/SYNC_TEST_1', 'Dynamically updates to yfxtube.com on storage change');

    // Switch to Koutube
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'koutube.com' } }, 'local'));
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(clipboardText === 'https://koutube.com/shorts/SYNC_TEST_1', 'Dynamically updates to koutube.com on storage change');

    // Malicious host rejected, resets to default original youtube.com
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'malicious.com' } }, 'local'));
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(clipboardText === 'https://youtube.com/shorts/SYNC_TEST_1', 'Disallowed host resets to default youtube.com');

    // Switch back to original youtube.com
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'youtube.com' } }, 'local'));
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(clipboardText === 'https://youtube.com/shorts/SYNC_TEST_1', 'Dynamically switches back to youtube.com');
  }

  // Test 12: Clipboard Fallback & Failure Handling
  console.log('\n--- Suite 12: Clipboard Delivery and Fallback Handling ---');
  {
    const renderer = new TestDomElement('ytd-reel-video-renderer');
    const actions = new TestDomElement('div', { id: 'actions' });
    renderer.appendChild(actions);
    renderer.appendChild(new TestDomElement('a', { href: '/shorts/CLIP_TEST_1' }));

    ytSandbox.__injectCopyButtonToYouTubeShort(renderer);
    const copyWrap = actions.querySelector('.image-saver-yt-copy-wrap');

    // Case A: Successful writeText
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(copyWrap.classList.contains('is-success'), 'Applies is-success on successful copy');
    assert(copyWrap.getAttribute('title') === '✓ Ссылка скопирована!', 'Sets success title');

    // Case B: Fallback via shielded execCommand
    const origWriteText = ytSandbox.navigator.clipboard.writeText;
    ytSandbox.navigator.clipboard.writeText = async () => { throw new Error('writeText denied'); };
    fallbackCopiedText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      fallbackCopiedText === 'https://youtube.com/shorts/CLIP_TEST_1',
      'Shielded execCommand copy succeeds when writeText fails'
    );
    assert(copyWrap.classList.contains('is-success'), 'Applies is-success on fallback copy');

    // Case C: Complete clipboard failure
    execCommandShouldFail = true;
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(copyWrap.classList.contains('is-error'), 'Applies is-error when all copy mechanisms fail');

    // Restore
    ytSandbox.navigator.clipboard.writeText = origWriteText;
    execCommandShouldFail = false;
  }

  // Test 13: Keyboard Accessibility
  console.log('\n--- Suite 13: Keyboard Activation ---');
  {
    const renderer = new TestDomElement('ytd-reel-video-renderer');
    const actions = new TestDomElement('div', { id: 'actions' });
    renderer.appendChild(actions);
    renderer.appendChild(new TestDomElement('a', { href: '/shorts/KEYBOARD_ID' }));

    ytSandbox.__injectCopyButtonToYouTubeShort(renderer);
    const copyWrap = actions.querySelector('.image-saver-yt-copy-wrap');

    clipboardText = '';
    copyWrap.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
    await new Promise(r => setTimeout(r, 10));
    assert(clipboardText === 'https://youtube.com/shorts/KEYBOARD_ID', 'Enter key triggers copy');

    clipboardText = '';
    copyWrap.dispatchEvent({ type: 'keydown', key: ' ', preventDefault() {} });
    await new Promise(r => setTimeout(r, 10));
    assert(clipboardText === 'https://youtube.com/shorts/KEYBOARD_ID', 'Space key triggers copy');
  }

  // Test 14: Settings panel and settings integration
  console.log('\n--- Suite 14: Popup Settings Integration ---');
  {
    const popupHtml = fs.readFileSync(path.resolve(__dirname, 'ui/src/components/app/settings-panels.tsx'), 'utf8');
    assert(popupHtml.includes('"youtubeShareHostSelect"'), 'settings panel contains youtubeShareHostSelect');
    assert(popupHtml.includes('["youtube.com",'), 'settings panel contains youtube.com option');
    assert(popupHtml.includes('["yfxtube.com",'), 'settings panel contains yfxtube.com option');
    assert(popupHtml.includes('["koutube.com",'), 'settings panel contains koutube.com option');

    // Check preservation of other settings
    assert(popupHtml.includes('"xShareHostSelect"'), 'Preserves xShareHostSelect in the settings panel');
    assert(popupHtml.includes('"igShareHostSelect"'), 'Preserves igShareHostSelect in the settings panel');
    assert(popupHtml.includes('"ttShareHostSelect"'), 'Preserves ttShareHostSelect in the settings panel');
    assert(popupHtml.includes('id="subfolderInput"'), 'Preserves subfolderInput in the settings panel');
    assert(popupHtml.includes('id="folderModeBySiteType"'), 'Preserves folderModeBySiteType in the settings panel');
  }

  // Test 15: Popup JS Logic & Storage Round-Trip
  console.log('\n--- Suite 15: Popup.js Logic and Storage Round-Trip ---');
  {
    // The page logic is the settings controller (ui/src/core/settings.js) behind the full page
    const settingsMod = await import(require('url').pathToFileURL(path.resolve(__dirname, 'ui/src/core/settings.js')).href);

    let storedSettings = {
      subfolder: 'MyFolder',
      folderOrganizationMode: 'by_site_and_type',
      askEveryTime: true,
      xShareHost: 'fixupx.com',
      igShareHost: 'oginstagram.com',
      ttShareHost: 'tnktok.com',
      youtubeShareHost: 'yfxtube.com'
    };

    const popupMockChrome = {
      storage: {
        local: {
          get(defaults) {
            return Promise.resolve(Object.assign({}, defaults, storedSettings));
          },
          set(items) {
            Object.assign(storedSettings, items);
            return Promise.resolve();
          }
        }
      }
    };

    const controller = settingsMod.createSettings({
      chrome: popupMockChrome,
      FolderPath: {
        DEFAULT_ROOT: 'SavedImages',
        LIMITS: { rootDepth: 8, rootLength: 200 },
        normalizeRoot(raw) { return { root: raw || 'SavedImages', changed: false, error: null }; }
      },
      setTimeout: () => 0,
      clearTimeout() {}
    });
    const quietLog = console.log;
    console.log = () => {};
    try { await controller.load(); } finally { console.log = quietLog; }
    const st = () => controller.store.getState();

    // Verify loaded values
    assert(st().youtubeShareHost === 'yfxtube.com', 'Loads saved youtubeShareHost value');
    assert(st().xShareHost === 'fixupx.com', 'Preserves xShareHost on load');
    assert(st().igShareHost === 'oginstagram.com', 'Preserves igShareHost on load');
    assert(st().ttShareHost === 'tnktok.com', 'Preserves ttShareHost on load');

    // Simulate user selecting koutube.com and clicking Save
    controller.setField('youtubeShareHost', 'koutube.com');
    console.log = () => {};
    try { await controller.save(); } finally { console.log = quietLog; }

    assert(storedSettings.youtubeShareHost === 'koutube.com', 'Saves updated youtubeShareHost to storage');
    assert(storedSettings.xShareHost === 'fixupx.com', 'Preserves xShareHost on save');
    assert(storedSettings.igShareHost === 'oginstagram.com', 'Preserves igShareHost on save');
    assert(storedSettings.ttShareHost === 'tnktok.com', 'Preserves ttShareHost on save');
    assert(storedSettings.subfolder === 'MyFolder', 'Preserves subfolder on save');
    assert(storedSettings.folderOrganizationMode === 'by_site_and_type', 'Preserves folderOrganizationMode on save');

    // Test invalid value sanitation
    controller.setField('youtubeShareHost', 'unauthorized-site.com');
    console.log = () => {};
    try { await controller.save(); } finally { console.log = quietLog; }
    assert(storedSettings.youtubeShareHost === 'youtube.com', 'Sanitizes invalid youtubeShareHost to default youtube.com');
  }

  // Test 16: Deferred Scanning, Scheduling Paths, Throttling & Observer
  console.log('\n--- Suite 16: Deferred Scanning and Lifecycle Execution ---');
  {
    // Path A: requestAnimationFrame path
    let rAfScheduled = false;
    let rAfCallback = null;
    const rAfWin = {
      addEventListener() {},
      location: { href: 'https://www.youtube.com' },
      navigator: mockNavigator,
      requestAnimationFrame: (cb) => {
        rAfScheduled = true;
        rAfCallback = cb;
        return 1;
      }
    };
    const rAfDoc = {
      createElement(tag) { return new TestDomElement(tag); },
      getElementById() { return null; },
      head: new TestDomElement('head'),
      body: new TestDomElement('body'),
      documentElement: new TestDomElement('html'),
      readyState: 'complete',
      addEventListener() {},
      querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
    };
    const rAfSandbox = {
      URL,
      chrome: mockChrome,
      window: rAfWin,
      document: rAfDoc,
      navigator: mockNavigator,
      requestAnimationFrame: rAfWin.requestAnimationFrame,
      console,
      setTimeout,
      clearTimeout
    };
    vm.createContext(rAfSandbox);
    vm.runInContext(ytCode, rAfSandbox);

    const rAfRenderer = new TestDomElement('ytd-reel-video-renderer');
    const rAfActions = new TestDomElement('div', { id: 'actions' });
    rAfRenderer.appendChild(rAfActions);
    rAfRenderer.appendChild(new TestDomElement('a', { href: '/shorts/RAF_SCAN_01' }));
    rAfDoc.body.appendChild(rAfRenderer);

    rAfSandbox.__requestThrottledScan();
    assert(rAfScheduled === true && typeof rAfCallback === 'function', 'Schedules scan via requestAnimationFrame when available');
    rAfCallback();
    const rAfBtn = rAfActions.querySelector('.image-saver-yt-copy-wrap');
    assert(rAfBtn !== null, 'Deferred scan via requestAnimationFrame injects button');

    // Path B: setTimeout path (when requestAnimationFrame is undefined)
    const newRendererB = new TestDomElement('ytd-reel-video-renderer');
    const actionsB = new TestDomElement('div', { id: 'actions' });
    newRendererB.appendChild(actionsB);
    newRendererB.appendChild(new TestDomElement('a', { href: '/shorts/DEFER_SCAN2' }));
    mockDoc.body.appendChild(newRendererB);

    ytSandbox.__requestThrottledScan();
    await new Promise(r => setTimeout(r, 70));
    const btnB = actionsB.querySelector('.image-saver-yt-copy-wrap');
    assert(btnB !== null, 'Deferred scan without arguments injects button via setTimeout path');

    // Throttling and duplicate prevention
    ytSandbox.__requestThrottledScan();
    ytSandbox.__requestThrottledScan();
    await new Promise(r => setTimeout(r, 70));
    const allBtns = actionsB.querySelectorAll('.image-saver-yt-copy-wrap');
    assert(allBtns.length === 1, 'Duplicate injection prevented on repeated deferred scans');

    // Lifecycle: Fresh sandbox with real MutationObserver and SPA navigation
    const windowListeners = {};
    const winEvents = {
      addEventListener(type, handler) {
        if (!windowListeners[type]) windowListeners[type] = [];
        windowListeners[type].push(handler);
      },
      location: { href: 'https://www.youtube.com' }
    };

    let observedTarget = null;
    let observerCallback = null;
    class MockMutationObserver {
      constructor(cb) { observerCallback = cb; }
      observe(target, opts) { observedTarget = target; }
      disconnect() {}
    }

    const lifecycleDoc = {
      createElement(tag) { return new TestDomElement(tag); },
      getElementById() { return null; },
      head: new TestDomElement('head'),
      body: new TestDomElement('body'),
      documentElement: new TestDomElement('html'),
      readyState: 'complete',
      addEventListener() {},
      querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
    };

    const mockHistory = {
      pushState(state, title, url) {},
      replaceState(state, title, url) {}
    };

    const lifecycleSandbox = {
      URL,
      chrome: mockChrome,
      window: winEvents,
      history: mockHistory,
      document: lifecycleDoc,
      MutationObserver: MockMutationObserver,
      console,
      setTimeout,
      clearTimeout
    };

    vm.createContext(lifecycleSandbox);
    vm.runInContext(ytCode, lifecycleSandbox);

    assert(observedTarget === lifecycleDoc.body, 'MutationObserver observes document body on initialization');
    assert(typeof observerCallback === 'function', 'MutationObserver callback registered');
    assert(Array.isArray(windowListeners['yt-navigate-finish']), 'Registers yt-navigate-finish SPA listener');
    assert(Array.isArray(windowListeners['popstate']), 'Registers popstate SPA listener');

    // Add a new renderer to lifecycleDoc.body and trigger MutationObserver callback
    const obsRenderer = new TestDomElement('ytd-reel-video-renderer');
    const obsActions = new TestDomElement('div', { id: 'actions' });
    obsRenderer.appendChild(obsActions);
    obsRenderer.appendChild(new TestDomElement('a', { href: '/shorts/OBS_RENDER_1' }));
    lifecycleDoc.body.appendChild(obsRenderer);

    observerCallback([{ addedNodes: [obsRenderer], removedNodes: [] }]);
    await new Promise(r => setTimeout(r, 70));
    const obsBtn = obsActions.querySelector('.image-saver-yt-copy-wrap');
    assert(obsBtn !== null, 'MutationObserver callback triggers deferred scan and injects button');

    // Trigger SPA navigation via yt-navigate-finish
    const spaRenderer = new TestDomElement('ytd-reel-video-renderer');
    const spaActions = new TestDomElement('div', { id: 'actions' });
    spaRenderer.appendChild(spaActions);
    spaRenderer.appendChild(new TestDomElement('a', { href: '/shorts/SPA_RENDER_1' }));
    lifecycleDoc.body.appendChild(spaRenderer);

    windowListeners['yt-navigate-finish'].forEach(fn => fn());
    await new Promise(r => setTimeout(r, 70));
    const spaBtn = spaActions.querySelector('.image-saver-yt-copy-wrap');
    assert(spaBtn !== null, 'SPA navigation event (yt-navigate-finish) triggers deferred scan and injects button');

    // Trigger history.pushState
    const pushRenderer = new TestDomElement('ytd-reel-video-renderer');
    const pushActions = new TestDomElement('div', { id: 'actions' });
    pushRenderer.appendChild(pushActions);
    pushRenderer.appendChild(new TestDomElement('a', { href: '/shorts/PUSH_RENDER_1' }));
    lifecycleDoc.body.appendChild(pushRenderer);

    mockHistory.pushState(null, '', '/shorts/PUSH_RENDER_1');
    await new Promise(r => setTimeout(r, 70));
    const pushBtn = pushActions.querySelector('.image-saver-yt-copy-wrap');
    assert(pushBtn !== null, 'history.pushState triggers deferred scan and injects button');
  }

  // Test 17: Active Short Identity Conflict (SPA Race)
  console.log('\n--- Suite 17: Active Short Identity Conflict ---');
  {
    const activeRenderer = new TestDomElement('ytd-reel-video-renderer', { 'is-active': '' });
    const actions = new TestDomElement('div', { id: 'actions' });
    activeRenderer.appendChild(actions);
    const link = new TestDomElement('a', { href: '/shorts/INITIAL_ID1' });
    activeRenderer.appendChild(link);

    ytSandbox.__injectCopyButtonToYouTubeShort(activeRenderer);
    const copyWrap = actions.querySelector('.image-saver-yt-copy-wrap');

    // Case A: Conflicting transition - page URL updated to UPDATED_ID2 while DOM link is still INITIAL_ID1
    ytSandbox.window.location.href = 'https://www.youtube.com/shorts/UPDATED_ID2';
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === '' && copyWrap.classList.contains('is-error'),
      'Active Short with conflicting page URL and DOM link fails closed (no clipboard write)'
    );

    // Case B: Conflicting transition reverse - DOM link updated to UPDATED_ID2 while page URL is still INITIAL_ID1
    ytSandbox.window.location.href = 'https://www.youtube.com/shorts/INITIAL_ID1';
    link.setAttribute('href', '/shorts/UPDATED_ID2');
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === '' && copyWrap.classList.contains('is-error'),
      'Active Short with conflicting reverse evidence fails closed (no clipboard write)'
    );

    // Case C: Consistent active evidence - both agree on UPDATED_ID2
    ytSandbox.window.location.href = 'https://www.youtube.com/shorts/UPDATED_ID2';
    link.setAttribute('href', '/shorts/UPDATED_ID2');
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === 'https://youtube.com/shorts/UPDATED_ID2',
      'Active Short with consistent page URL and DOM link copies successfully'
    );

    // Case D: Stale attribute conflict on active container
    activeRenderer.setAttribute('data-video-id', 'STALE_ATTR1');
    clipboardText = '';
    copyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === '' && copyWrap.classList.contains('is-error'),
      'Active Short with stale conflicting attribute fails closed'
    );
    activeRenderer.removeAttribute('data-video-id');

    // Case E: Inactive neighbor card with DOM link is NOT invalidated by active page URL
    const neighborRenderer = new TestDomElement('ytd-reel-video-renderer', { 'aria-hidden': 'true' });
    const neighborActions = new TestDomElement('div', { id: 'actions' });
    neighborRenderer.appendChild(neighborActions);
    neighborRenderer.appendChild(new TestDomElement('a', { href: '/shorts/NEIGHBOR_01' }));

    ytSandbox.__injectCopyButtonToYouTubeShort(neighborRenderer);
    const neighborWrap = neighborActions.querySelector('.image-saver-yt-copy-wrap');

    // Active page is still UPDATED_ID2
    clipboardText = '';
    neighborWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === 'https://youtube.com/shorts/NEIGHBOR_01',
      'Inactive neighbor card copies its own DOM link without being rejected by active page URL'
    );

    // Case F: Inactive neighbor card with NO DOM link does NOT borrow active page URL
    const emptyNeighbor = new TestDomElement('ytd-reel-video-renderer', { 'aria-hidden': 'true' });
    const emptyActions = new TestDomElement('div', { id: 'actions' });
    emptyNeighbor.appendChild(emptyActions);
    ytSandbox.__injectCopyButtonToYouTubeShort(emptyNeighbor);
    const emptyWrap = emptyActions.querySelector('.image-saver-yt-copy-wrap');

    clipboardText = '';
    emptyWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === '' && emptyWrap.classList.contains('is-error'),
      'Inactive neighbor card without DOM link fails closed without borrowing page URL'
    );

    // Case G: Ambiguous ownership in container with multiple conflicting links
    const ambRenderer = new TestDomElement('ytd-reel-video-renderer', { 'is-active': '' });
    const ambActions = new TestDomElement('div', { id: 'actions' });
    ambRenderer.appendChild(ambActions);
    ambRenderer.appendChild(new TestDomElement('a', { href: '/shorts/CONFLICT_A1' }));
    ambRenderer.appendChild(new TestDomElement('a', { href: '/shorts/CONFLICT_B2' }));
    ytSandbox.__injectCopyButtonToYouTubeShort(ambRenderer);
    const ambWrap = ambActions.querySelector('.image-saver-yt-copy-wrap');

    clipboardText = '';
    ambWrap.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === '' && ambWrap.classList.contains('is-error'),
      'Ambiguous container with conflicting links fails closed on click'
    );
  }

  // Test 18: Standalone Owner Layouts on Click
  console.log('\n--- Suite 18: Standalone Owner Layouts on Click ---');
  {
    // Layout A: Standard ytd-reel-video-renderer
    const standardReel = new TestDomElement('ytd-reel-video-renderer');
    const stdActions = new TestDomElement('div', { id: 'actions' });
    standardReel.appendChild(stdActions);
    standardReel.appendChild(new TestDomElement('a', { href: '/shorts/STD_REEL_01' }));
    mockDoc.body.appendChild(standardReel);
    ytSandbox.__scanAndInjectYouTubeCopyButtons(mockDoc.body);
    const stdBtn = stdActions.querySelector('.image-saver-yt-copy-wrap');
    assert(stdBtn !== null, 'Injected into ytd-reel-video-renderer actions');

    ytSandbox.window.location.href = 'https://www.youtube.com/shorts/STD_REEL_01';
    clipboardText = '';
    stdBtn.click();
    await new Promise(r => setTimeout(r, 10));
    assert(clipboardText === 'https://youtube.com/shorts/STD_REEL_01', 'Click on ytd-reel-video-renderer copies short link');

    // Layout B: #shorts-container
    const shortsContainer = new TestDomElement('div', { id: 'shorts-container' });
    const actionsA = new TestDomElement('div', { id: 'actions' });
    shortsContainer.appendChild(actionsA);
    shortsContainer.appendChild(new TestDomElement('a', { href: '/shorts/STANDALONE1' }));

    mockDoc.body.appendChild(shortsContainer);
    ytSandbox.__scanAndInjectYouTubeCopyButtons(mockDoc.body);

    const btnA = actionsA.querySelector('.image-saver-yt-copy-wrap');
    assert(btnA !== null, 'Injected into #shorts-container actions');

    ytSandbox.window.location.href = 'https://www.youtube.com/shorts/STANDALONE1';
    clipboardText = '';
    btnA.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === 'https://youtube.com/shorts/STANDALONE1',
      'Click on button in #shorts-container resolves owner and copies short link'
    );

    // Layout C: ytd-shorts
    const ytdShorts = new TestDomElement('ytd-shorts');
    const actionsB = new TestDomElement('div', { id: 'actions' });
    ytdShorts.appendChild(actionsB);
    ytdShorts.appendChild(new TestDomElement('a', { href: '/shorts/YTD_SHORTS1' }));

    mockDoc.body.appendChild(ytdShorts);
    ytSandbox.__scanAndInjectYouTubeCopyButtons(mockDoc.body);

    const btnB = actionsB.querySelector('.image-saver-yt-copy-wrap');
    assert(btnB !== null, 'Injected into ytd-shorts actions');

    ytSandbox.window.location.href = 'https://www.youtube.com/shorts/YTD_SHORTS1';
    clipboardText = '';
    btnB.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === 'https://youtube.com/shorts/YTD_SHORTS1',
      'Click on button in ytd-shorts resolves owner and copies short link'
    );

    // Layout D: ytd-reel-player-overlay-renderer
    const overlayRenderer = new TestDomElement('ytd-reel-player-overlay-renderer');
    const actionsC = new TestDomElement('div', { id: 'actions' });
    overlayRenderer.appendChild(actionsC);
    overlayRenderer.appendChild(new TestDomElement('a', { href: '/shorts/OVERLAY_VID' }));

    mockDoc.body.appendChild(overlayRenderer);
    ytSandbox.__scanAndInjectYouTubeCopyButtons(mockDoc.body);

    const btnC = actionsC.querySelector('.image-saver-yt-copy-wrap');
    assert(btnC !== null, 'Injected into ytd-reel-player-overlay-renderer actions');

    ytSandbox.window.location.href = 'https://www.youtube.com/shorts/OVERLAY_VID';
    clipboardText = '';
    btnC.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === 'https://youtube.com/shorts/OVERLAY_VID',
      'Click on button in ytd-reel-player-overlay-renderer resolves owner and copies short link'
    );

    // Layout E: Reparented button resolves dynamic new owner
    const newOwnerRenderer = new TestDomElement('ytd-reel-video-renderer');
    const newOwnerActions = new TestDomElement('div', { id: 'actions' });
    newOwnerRenderer.appendChild(newOwnerActions);
    newOwnerRenderer.appendChild(new TestDomElement('a', { href: '/shorts/REPARENT123' }));
    mockDoc.body.appendChild(newOwnerRenderer);

    // Move btnA into newOwnerActions
    actionsA.removeChild(btnA);
    newOwnerActions.appendChild(btnA);

    ytSandbox.window.location.href = 'https://www.youtube.com/shorts/REPARENT123';
    clipboardText = '';
    btnA.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === 'https://youtube.com/shorts/REPARENT123',
      'Reparented button dynamically resolves new enclosing owner'
    );

    // Layout F: Detached button rejected
    newOwnerActions.removeChild(btnA);
    btnA.isConnected = false;
    clipboardText = '';
    btnA.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === '' && btnA.classList.contains('is-error'),
      'Detached button rejects click without copying'
    );
  }

  // Test 19: Storage Change Listener Reset and Isolation
  console.log('\n--- Suite 19: Storage Change Listener Reset and Isolation ---');
  {
    // Set to koutube.com first
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'koutube.com' } }, 'local'));
    assert(ytSandbox.__getCachedYtShareHost() === 'koutube.com', 'Cached host is koutube.com');

    // Deletion: { youtubeShareHost: { oldValue: 'koutube.com' } } -> should reset to youtube.com
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { oldValue: 'koutube.com' } }, 'local'));
    assert(ytSandbox.__getCachedYtShareHost() === 'youtube.com', 'Deleted preference resets to default youtube.com');

    // Re-set to yfxtube.com
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'yfxtube.com' } }, 'local'));
    assert(ytSandbox.__getCachedYtShareHost() === 'yfxtube.com', 'Updated to yfxtube.com');

    // Invalid value: { youtubeShareHost: { newValue: 'malicious.com' } } -> should reset to youtube.com
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'malicious.com' } }, 'local'));
    assert(ytSandbox.__getCachedYtShareHost() === 'youtube.com', 'Invalid host resets to default youtube.com');

    // Storage area isolation: sync change should be ignored
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'koutube.com' } }, 'sync'));
    assert(ytSandbox.__getCachedYtShareHost() === 'youtube.com', 'Non-local (sync) storage change is ignored');

    // Subsequent valid update
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'koutube.com' } }, 'local'));
    assert(ytSandbox.__getCachedYtShareHost() === 'koutube.com', 'Subsequent valid change updates correctly');
    mockStorageListeners.forEach(cb => cb({ youtubeShareHost: { newValue: 'youtube.com' } }, 'local'));
  }

  // Test 20: Modern Lit View-Model Action Rail Layout (reel-action-bar-view-model)
  console.log('\n--- Suite 20: Modern Lit View-Model Action Rail Layout ---');
  {
    // Exact DOM structure observed from live Chromium diagnostic:
    // targetTag: 'ytd-reel-video-renderer', id: 'reel-video-renderer', class: 'style-scope ytd-shorts'
    // Inside it: <div> -> <reel-action-bar-view-model>
    // Children: <like-button-view-model>, <dislike-button-view-model>, <div><share-button-view-model aria-label="Поделиться">
    // Notice: NO is-active attribute on ytd-reel-video-renderer!
    // Notice: NO #actions element!
    const reel = new TestDomElement('ytd-reel-video-renderer', {
      id: 'reel-video-renderer',
      class: 'style-scope ytd-shorts'
    });
    const innerWrapper = new TestDomElement('div');
    const actionBar = new TestDomElement('reel-action-bar-view-model');
    const likeVM = new TestDomElement('like-button-view-model');
    const dislikeVM = new TestDomElement('dislike-button-view-model');
    const shareWrap = new TestDomElement('div', { class: 'yt-spec-button-shape' });
    const shareVM = new TestDomElement('share-button-view-model', { 'aria-label': 'Поделиться' });
    shareWrap.appendChild(shareVM);

    actionBar.appendChild(likeVM);
    actionBar.appendChild(dislikeVM);
    actionBar.appendChild(shareWrap);
    innerWrapper.appendChild(actionBar);
    reel.appendChild(innerWrapper);

    const shortsLink = new TestDomElement('a', { href: '/shorts/OT5pzxRLYwk' });
    reel.appendChild(shortsLink);

    mockDoc.body.appendChild(reel);

    // 1. findShortActionsContainer must discover reel-action-bar-view-model
    const foundContainer = ytSandbox.__findShortActionsContainer(reel);
    assert(
      foundContainer === actionBar,
      'Discovers reel-action-bar-view-model when #actions is absent'
    );

    // 2. injectCopyButtonToYouTubeShort injects button inside reel-action-bar-view-model
    const injected = ytSandbox.__injectCopyButtonToYouTubeShort(reel);
    assert(injected === true, 'Successfully injects copy button into reel-action-bar-view-model');

    const copyBtn = actionBar.querySelector('.image-saver-yt-copy-wrap');
    assert(copyBtn !== null, 'Copy button wrapper exists inside reel-action-bar-view-model');

    // 3. Button placed directly after share button top-level container in action bar
    assert(
      shareWrap.nextSibling === copyBtn,
      'Button is placed directly after share item in action bar'
    );

    // 4. Click resolves video ID from reel and copies target URL
    ytSandbox.window.location.href = 'https://www.youtube.com/shorts/OT5pzxRLYwk';
    clipboardText = '';
    copyBtn.click();
    await new Promise(r => setTimeout(r, 10));
    assert(
      clipboardText === 'https://youtube.com/shorts/OT5pzxRLYwk',
      'Clicking copy button on modern Lit layout copies canonical Short link'
    );
    assert(
      copyBtn.classList.contains('is-success'),
      'Button receives is-success class after copy on modern Lit layout'
    );

    // 5. Cleanup
    mockDoc.body.removeChild(reel);
  }

  // Test 21: Pointer Gesture Shielding (Swipe / Reel Drag Isolation)
  console.log('\n--- Suite 21: Pointer Gesture Shielding (Swipe / Reel Drag Isolation) ---');
  {
    const reel = new TestDomElement('ytd-reel-video-renderer');
    const actions = new TestDomElement('div', { id: 'actions' });
    reel.appendChild(actions);
    mockDoc.body.appendChild(reel);

    ytSandbox.__injectCopyButtonToYouTubeShort(reel);
    const copyWrap = actions.querySelector('.image-saver-yt-copy-wrap');
    assert(Boolean(copyWrap), 'Copy button wrapper injected for pointer gesture test');

    let pointerdownStopped = false;
    copyWrap.dispatchEvent({
      type: 'pointerdown',
      stopPropagation: () => { pointerdownStopped = true; }
    });
    assert(pointerdownStopped, 'pointerdown on copy button stops propagation to shield reel drag');

    let mousedownStopped = false;
    copyWrap.dispatchEvent({
      type: 'mousedown',
      stopPropagation: () => { mousedownStopped = true; }
    });
    assert(mousedownStopped, 'mousedown on copy button stops propagation to shield reel drag');

    mockDoc.body.removeChild(reel);
  }

  // Test 22: Advanced Active Short Resolution (Single Reel & Playing Video Fallbacks)
  console.log('\n--- Suite 22: Advanced Active Short Resolution (Single Reel & Playing Video Fallbacks) ---');
  {
    const pageUrl = 'https://www.youtube.com/shorts/OT5pzxRLYwk';
    mockDoc.body.children = [];

    // Case A: Single reel on page is unconditionally active and borrows active page URL when DOM link is missing
    const singleReel = new TestDomElement('ytd-reel-video-renderer');
    mockDoc.body.appendChild(singleReel);
    assert(
      ytSandbox.__extractShortVideoId(singleReel, pageUrl) === 'OT5pzxRLYwk',
      'Single reel-video-renderer on document is active and resolves ID from active page URL'
    );

    // When a second reel exists, neither is unconditionally active without markers (cannot borrow page URL)
    const secondReel = new TestDomElement('ytd-reel-video-renderer');
    mockDoc.body.appendChild(secondReel);
    assert(
      ytSandbox.__extractShortVideoId(singleReel, pageUrl) === null,
      'First reel is no longer active when multiple reels exist (fails closed without DOM link)'
    );
    assert(
      ytSandbox.__extractShortVideoId(secondReel, pageUrl) === null,
      'Second reel without active markers is not active (fails closed without DOM link)'
    );

    // Case B: Actively playing HTML5 video inside container marks it as active
    const videoActive = new TestDomElement('video');
    videoActive.paused = false;
    videoActive.ended = false;
    secondReel.appendChild(videoActive);
    assert(
      ytSandbox.__extractShortVideoId(secondReel, pageUrl) === 'OT5pzxRLYwk',
      'Container with actively playing video (paused: false, ended: false) is active and resolves page ID'
    );

    // Video paused and ended is not active
    videoActive.paused = true;
    videoActive.ended = true;
    assert(
      ytSandbox.__extractShortVideoId(secondReel, pageUrl) === null,
      'Container with paused and ended video is not active'
    );

    // Video with currentTime > 0 and paused: false is active
    videoActive.paused = false;
    videoActive.ended = false;
    videoActive.currentTime = 5.2;
    assert(
      ytSandbox.__extractShortVideoId(secondReel, pageUrl) === 'OT5pzxRLYwk',
      'Container with video (currentTime > 0, paused: false) is active and resolves page ID'
    );

    mockDoc.body.removeChild(singleReel);
    mockDoc.body.removeChild(secondReel);
  }

  // Test 23: Localized Russian Aria-Label Action Rail Discovery
  console.log('\n--- Suite 23: Localized Russian Aria-Label Action Rail Discovery ---');
  {
    // Case A: Fallback to container of like button with Russian aria-label "Мне нравится"
    const reelA = new TestDomElement('ytd-reel-video-renderer');
    const customBarA = new TestDomElement('div', { class: 'custom-action-cluster' });
    const likeBtnRu = new TestDomElement('button', { 'aria-label': 'Мне нравится' });
    customBarA.appendChild(likeBtnRu);
    reelA.appendChild(customBarA);

    const foundA = ytSandbox.__findShortActionsContainer(reelA);
    assert(
      foundA === customBarA,
      'Discovers action container via button with Russian aria-label "Мне нравится"'
    );

    // Case B: Fallback to container of share button with Russian aria-label "Поделиться"
    const reelB = new TestDomElement('ytd-reel-video-renderer');
    const customBarB = new TestDomElement('div', { class: 'custom-share-cluster' });
    const shareBtnRu = new TestDomElement('button', { 'aria-label': 'Поделиться' });
    customBarB.appendChild(shareBtnRu);
    reelB.appendChild(customBarB);

    const foundB = ytSandbox.__findShortActionsContainer(reelB);
    assert(
      foundB === customBarB,
      'Discovers action container via button with Russian aria-label "Поделиться"'
    );
  }

  // Test 24: Replaced Action Rails & Re-injection Continuity
  console.log('\n--- Suite 24: Replaced Action Rails & Re-injection Continuity ---');
  {
    const reel = new TestDomElement('ytd-reel-video-renderer');
    const actions = new TestDomElement('div', { id: 'actions' });
    reel.appendChild(actions);
    mockDoc.body.appendChild(reel);

    // Initial injection
    const firstInjected = ytSandbox.__injectCopyButtonToYouTubeShort(reel);
    assert(firstInjected === true, 'Initial button injection succeeds');
    assert(actions.children.length === 1, 'Actions has 1 injected button');

    // YouTube framework wipes and replaces action bar DOM
    actions.removeChild(actions.children[0]);
    assert(actions.children.length === 0, 'Actions cluster wiped by SPA rerender');
    assert(reel.getAttribute('data-image-saver-yt-btn') === 'true', 'Reel still retains data attribute marker');

    // Re-injection on scan must succeed despite existing reel attribute marker
    const secondInjected = ytSandbox.__injectCopyButtonToYouTubeShort(reel);
    assert(secondInjected === true, 'Re-injection succeeds after actions rail was wiped');
    assert(actions.children.length === 1, 'Actions cluster has newly injected button');

    // Duplicate injection prevented while button is present
    const dupInjected = ytSandbox.__injectCopyButtonToYouTubeShort(reel);
    assert(dupInjected === false, 'Duplicate injection prevented while button is connected');

    mockDoc.body.removeChild(reel);
  }

  // Test 25: Child Data-Attribute ID Resolution (data-context-item-id & video-id)
  console.log('\n--- Suite 25: Child Data-Attribute ID Resolution (data-context-item-id & video-id) ---');
  {
    // Container without <a> link but with child having data-context-item-id
    const reelA = new TestDomElement('ytd-reel-video-renderer');
    const childA = new TestDomElement('div', { 'data-context-item-id': 'ctx12345678' });
    reelA.appendChild(childA);
    const idA = ytSandbox.__extractShortVideoId(reelA, null);
    assert(idA === 'ctx12345678', 'Extracts valid 11-char ID from child data-context-item-id');

    // Container with child having video-id attribute
    const reelB = new TestDomElement('ytd-reel-video-renderer');
    const childB = new TestDomElement('span', { 'video-id': 'vidAttr1234' });
    reelB.appendChild(childB);
    const idB = ytSandbox.__extractShortVideoId(reelB, null);
    assert(idB === 'vidAttr1234', 'Extracts valid 11-char ID from child video-id attribute');

    // Container with invalid child attribute ID is rejected
    const reelC = new TestDomElement('ytd-reel-video-renderer');
    const childC = new TestDomElement('span', { 'video-id': 'invalid_id!' });
    reelC.appendChild(childC);
    const idC = ytSandbox.__extractShortVideoId(reelC, null);
    assert(idC === null, 'Rejects invalid syntax child video-id attribute (fail closed)');

    // Active container with child attribute conflicting with active page URL fails closed
    const reelD = new TestDomElement('ytd-reel-video-renderer', { 'is-active': 'true' });
    const childD = new TestDomElement('div', { 'data-context-item-id': 'ctx12345678' });
    reelD.appendChild(childD);
    const idD = ytSandbox.__extractShortVideoId(reelD, 'https://www.youtube.com/shorts/CONFLICT999');
    assert(idD === null, 'Active container with child attribute conflicting with page URL fails closed');
  }

  // UI-LOCALIZATION-01: the inline labels follow the interface language when the shared catalogue (lib/i18n.js) runs first, as the
  // manifest loads it: no saved choice -> the browser language; a saved choice wins; existing buttons follow language changes.
  console.log('\n--- Suite L: Inline labels follow the interface language ---');
  {
    const i18nCode = fs.readFileSync(path.resolve(__dirname, 'lib/i18n.js'), 'utf8');
    const settle = () => new Promise((r) => setTimeout(r, 5));
    const labelled = async ({ uiLanguage, saved, deferPreference = false }) => {
      const listeners = [];
      const local = saved === undefined ? {} : { uiLanguage: saved };
      let releaseRead;
      const preferenceReady = deferPreference ? new Promise((r) => { releaseRead = r; }) : Promise.resolve();
      const chromeL = {
        runtime: { lastError: null },
        i18n: { getUILanguage: () => uiLanguage },
        storage: {
          local: { get: async (defaults) => { await preferenceReady; return Object.assign({}, defaults, local); }, set: async (items) => { Object.assign(local, items); } },
          onChanged: { addListener(cb) { listeners.push(cb); } }
        }
      };
      const sb = {
        URL, chrome: chromeL, document: mockDoc, navigator: { language: uiLanguage, clipboard: mockNavigator.clipboard }, console, setTimeout, clearTimeout,
        window: { addEventListener() {}, location: { href: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' }, navigator: mockNavigator }
      };
      vm.createContext(sb);
      vm.runInContext(i18nCode, sb);
      vm.runInContext(ytCode, sb);
      await settle();
      const button = () => {
        const renderer = new TestDomElement('ytd-reel-video-renderer');
        const actions = new TestDomElement('div', { id: 'actions' });
        renderer.appendChild(actions);
        renderer.appendChild(new TestDomElement('a', { href: '/shorts/LANG_TEST_1' }));
        sb.__injectCopyButtonToYouTubeShort(renderer);
        return actions.querySelector('.image-saver-yt-copy-wrap');
      };
      return { button, releaseRead: async () => { releaseRead(); await settle(); }, change: async (value) => { for (const cb of listeners) cb({ uiLanguage: { newValue: value } }, 'local'); await settle(); } };
    };

    const en = await labelled({ uiLanguage: 'en-US' });
    let b = en.button();
    assert(b.getAttribute('title') === 'MediaLatch: Copy Short link' && b.getAttribute('aria-label') === 'Copy Short link', 'L1: an English browser with no saved choice gets English inline labels');
    await en.change('ru');
    assert(b.getAttribute('title') === 'MediaLatch: Скопировать ссылку на Short' && b.getAttribute('aria-label') === 'Скопировать ссылку на Short', 'L2: a language change updates the existing button without reinjection');
    const delayed = await labelled({ uiLanguage: 'en', saved: 'ru', deferPreference: true });
    const early = delayed.button();
    assert(early.getAttribute('title') === 'MediaLatch: Copy Short link', 'L6: the browser language is used while the preference read is pending');
    await delayed.releaseRead();
    assert(early.getAttribute('title') === 'MediaLatch: Скопировать ссылку на Short' && early.getAttribute('aria-label') === 'Скопировать ссылку на Short', 'L7: a delayed saved preference updates an already drawn button');
    const saved = await labelled({ uiLanguage: 'ru-RU', saved: 'en' });
    assert(saved.button().getAttribute('title') === 'MediaLatch: Copy Short link', 'L3: a saved English choice wins over a Russian browser');
    const invalid = await labelled({ uiLanguage: 'ru', saved: 'de' });
    assert(invalid.button().getAttribute('title') === 'MediaLatch: Скопировать ссылку на Short', 'L4: an invalid saved value falls back to the browser language');
    const other = await labelled({ uiLanguage: 'de-DE' });
    assert(other.button().getAttribute('aria-label') === 'Copy Short link', 'L5: a non-Russian browser gets English');
  }

  console.log(`\n======================================================`);
  console.log(`Total tests passed: ${passedTests}`);
  console.log(`Total tests failed: ${failedTests}`);
  console.log(`======================================================\n`);

  if (failedTests > 0) {
    process.exit(1);
  }
}

runYouTubeSharingTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
