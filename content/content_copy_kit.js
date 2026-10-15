// content/content_copy_kit.js - the scaffolding the "copy link" buttons of X, Instagram, TikTok and YouTube share (UA-02/UA-05 sweep). Loaded before each of those scripts; it
// reaches them through globalThis.MediaLatchCopyKit. A site script keeps what is its own: the hosts it may copy, how a post is found and what its button looks like.
(() => {
  // The user's share host (chrome.storage.local[key]), kept current while the page lives. Only one of `allowed` is ever used: a stored value outside it is the default, and an
  // invalid change is ignored unless `resetOnInvalid`. get()/set() read and replace the cached choice.
  function shareHost(key, allowed, fallback, resetOnInvalid = false) {
    let host = fallback;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ [key]: fallback }, (res) => {
          if (chrome.runtime && chrome.runtime.lastError) return;
          host = res && allowed.includes(res[key]) ? res[key] : fallback;
        });
      }
    } catch (_) {}
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local' || !changes || !changes[key]) return;
          const next = changes[key].newValue;
          if (allowed.includes(next)) host = next;
          else if (resetOnInvalid) host = fallback;
        });
      }
    } catch (_) {}
    return { get: () => host, set: (value) => { host = value; } };
  }

  // A scan that runs at most once per frame (50 ms without animation frames). A request for another root while one is pending widens the scan to the whole document.
  function scheduler(scan) {
    let pending = false;
    let pendingRoot = null;
    return function request(root = null) {
      if (pending) {
        if (!root || pendingRoot !== root) pendingRoot = null;
        return;
      }
      pending = true;
      pendingRoot = root || null;
      const run = () => {
        pending = false;
        const target = pendingRoot || (typeof document !== 'undefined' ? document : null);
        pendingRoot = null;
        scan(target);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 50);
    };
  }

  // The page watcher: init() prepares the styles, scans once and (re)starts one MutationObserver on the body that asks for a scan when nodes are added or, with `ownClass`,
  // when the button's own wrapper was removed. It returns the observer.
  function observer({ prepare, scan, request, ownClass = '' }) {
    let current = null;
    return function init() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return null;
      prepare();
      scan();
      if (current) {
        try { current.disconnect(); } catch (_) {}
      }
      current = new MutationObserver((mutations) => {
        let wanted = false;
        for (const m of mutations) {
          if (m.addedNodes && m.addedNodes.length > 0) { wanted = true; break; }
          if (ownClass && m.removedNodes && m.removedNodes.length > 0) {
            for (const n of m.removedNodes) {
              if (n.classList && (n.classList.contains(ownClass) || (n.querySelector && n.querySelector('.' + ownClass)))) { wanted = true; break; }
            }
            if (wanted) break;
          }
        }
        if (wanted) request();
      });
      const target = document.body || document.documentElement;
      if (target) current.observe(target, { childList: true, subtree: true });
      return current;
    };
  }

  // Single-page navigation: a back/forward step and every history.pushState/replaceState ask for a scan.
  function navigation(request) {
    if (typeof window === 'undefined') return;
    window.addEventListener('popstate', () => request());
    if (typeof history === 'undefined') return;
    for (const name of ['pushState', 'replaceState']) {
      if (typeof history[name] !== 'function') continue;
      const original = history[name];
      history[name] = function (...args) {
        const result = original.apply(this, args);
        request();
        return result;
      };
    }
  }

  // Run once the document can be queried: now, or when it has been parsed.
  function whenReady(start) {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { start(); }, { once: true });
    else start();
  }

  // Writes text to the clipboard: the async API, else a hidden textarea and execCommand with the copy event shielded from page handlers. Resolves { copied, method }.
  async function copyText(text) {
    let copied = false;
    let method = 'none';
    const nav = (typeof window !== 'undefined' && window.navigator) ? window.navigator : (typeof navigator !== 'undefined' ? navigator : null);
    try {
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(text);
        copied = true;
        method = 'writeText';
      }
    } catch (_) {}

    if (!copied && typeof document !== 'undefined') {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';

        // Shield copy event against page-level capture/bubble interference
        const copyShield = (ce) => {
          if (ce && ce.clipboardData && typeof ce.clipboardData.setData === 'function') {
            ce.clipboardData.setData('text/plain', text);
            if (typeof ce.preventDefault === 'function') ce.preventDefault();
          }
          if (ce && typeof ce.stopImmediatePropagation === 'function') {
            ce.stopImmediatePropagation();
          } else if (ce && typeof ce.stopPropagation === 'function') {
            ce.stopPropagation();
          }
        };
        if (typeof ta.addEventListener === 'function') {
          ta.addEventListener('copy', copyShield, { capture: true });
        }

        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        copied = document.execCommand('copy');
        if (typeof ta.removeEventListener === 'function') {
          ta.removeEventListener('copy', copyShield, { capture: true });
        }
        document.body.removeChild(ta);
        if (copied) {
          method = 'execCommand_shielded';
        }
      } catch (_) {}
    }
    return { copied, method };
  }

  // isLabel(element, field, key, fallback, vars): text or an attribute that follows the interface language (lib/i18n.js); without the catalogue it is the plain fallback.
  function labeler() {
    const i18n = globalThis.ImageSaverI18n;
    const labels = i18n && typeof chrome !== 'undefined' ? i18n.follow(chrome, typeof navigator !== 'undefined' ? navigator : null, () => {}) : null;
    return (element, field, key, fallback, vars) => {
      if (labels) labels.label(element, field, key, vars, fallback);
      else if (field === 'textContent') element.textContent = fallback;
      else if (fallback === null) element.removeAttribute(field);
      else element.setAttribute(field, fallback);
    };
  }

  globalThis.MediaLatchCopyKit = { shareHost, scheduler, observer, navigation, whenReady, labeler, copyText };
})();
