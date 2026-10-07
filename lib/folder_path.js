// folder_path.js - shared download-folder rules (FOLDER-01).
// Loaded by background.js (importScripts) and popup.html so the popup preview/validation
// and the runtime download path use exactly the same normalization.
(function (root) {
  const DEFAULT_ROOT = 'SavedImages';
  // Documented limits (README): the root is user input, site/type segments are derived.
  const LIMITS = Object.freeze({
    rootLength: 120,     // total characters of the normalized root, separators included
    rootDepth: 8,        // nested folder levels in the root
    siteLength: 50,      // derived <owning-site> segment
    relativePath: 240    // whole <root>/<site>/<type>/<filename>; only the file basename is shortened
  });
  // Windows device names are reserved with or without an extension (CON, con.txt, NUL.com); clock$ too (Chromium base::IsReservedNameOnWindows),
  // and these exact names of the Windows shell and console.
  const RESERVED_BASENAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|clock\$)$/i;
  const RESERVED_NAMES = new Set(['desktop.ini', 'thumbs.db', 'conin$', 'conout$']);
  // chrome.downloads accepts a path only when every component is portable (Chromium net::IsSafePortablePathComponent): control (Cc, DEL and
  // C1 included) and format characters (Cf, e.g. zero-width joiner, bidi overrides) and noncharacters are refused anywhere; whitespace, '.'
  // and '~' at either end; and a shell-integrated extension (.local .lnk .scf .url, or a {CLSID}) in any component, directories included.
  const INVISIBLE = /[\p{Cf}\p{Noncharacter_Code_Point}]/gu;
  const SHELL_EXTENSION = /\.(?:local|lnk|scf|url|\{[^.]*\})$/i;

  /** On Windows a name that could be an 8.3 short name must not contain '~' (Chromium IllegalCharacters::CouldBeInvalidShortName). */
  function isTildeShortName(name) {
    if (typeof name !== 'string' || name.length > 12 || !name.includes('~') || /[\s"\\/[\]:+|<>=;?,*]/.test(name)) return false;
    const dot = name.indexOf('.');
    if (dot === -1) return name.length <= 8;
    return dot === name.lastIndexOf('.') && dot > 0 && dot <= 8 && dot + 4 >= name.length;
  }

  /** One folder name: forbidden and invisible characters removed, no dots/spaces/'~' at either end, reserved names suffixed. */
  function normalizeSegment(segment) {
    if (typeof segment !== 'string') return '';
    let s = segment.replace(/[<>:"/\\|?*\p{Cc}]/gu, '').replace(INVISIBLE, '').replace(/^[\s.~]+|[\s.~]+$/g, '');
    if (!s) return ''; // also drops "." and ".." (all-dot names)
    const m = /^([^.]*)(\..*)?$/.exec(s);
    if (m && RESERVED_BASENAME.test(m[1].trim())) s = `${m[1]}_${m[2] || ''}`;
    if (RESERVED_NAMES.has(s.toLowerCase()) || SHELL_EXTENSION.test(s)) s = `${s}_`;
    if (isTildeShortName(s)) s = s.replace(/~/g, '_');
    return s;
  }

  /**
   * Normalizes the user's root. Internal dots ("My..Archive") and nested levels are preserved;
   * whole "." / ".." levels are dropped and a level loses dots at its ends. error: null | 'too_long' | 'too_deep'.
   */
  function normalizeRoot(input) {
    if (typeof input !== 'string') return { root: '', changed: false, error: null };
    const segments = input.replace(/\\/g, '/').split('/')
      .map((s) => normalizeSegment(s)).filter(Boolean);
    const normalized = segments.join('/');
    let error = null;
    if (segments.length > LIMITS.rootDepth) error = 'too_deep';
    else if (normalized.length > LIMITS.rootLength) error = 'too_long';
    return { root: normalized, changed: normalized !== input.trim(), error };
  }

  /**
   * Root used for downloads. Missing/non-string -> default root; an empty string stays the
   * Downloads root; an over-limit stored root falls back to the default (reported by onInvalid).
   */
  function resolveRoot(value, onInvalid) {
    if (typeof value !== 'string') return DEFAULT_ROOT;
    const { root, error } = normalizeRoot(value);
    if (error) {
      if (typeof onInvalid === 'function') onInvalid(error);
      return DEFAULT_ROOT;
    }
    return root;
  }

  /** Derived <owning-site> folder. A cut at the length limit is normalized again (its new end, a split surrogate pair). */
  function normalizeSite(site, fallback = 'unknown-site') {
    let s = normalizeSegment(site);
    if (s.length > LIMITS.siteLength) s = normalizeSegment(s.substring(0, LIMITS.siteLength).replace(/[\uD800-\uDBFF]$/, ''));
    return s || fallback;
  }

  /** Joins directory parts and filename; shortens only the filename base when over budget. */
  function joinPath(dirParts, filename) {
    const dir = dirParts.filter(Boolean).join('/');
    const prefix = dir ? `${dir}/` : '';
    let name = filename;
    const budget = LIMITS.relativePath - prefix.length;
    if (name.length > budget) {
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 && name.length - dot <= 10 ? name.substring(dot) : '';
      const base = name.substring(0, name.length - ext.length)
        .substring(0, Math.max(1, budget - ext.length)).replace(/[\uD800-\uDBFF]$/, '').replace(/[\s.~]+$/, '');
      name = `${base || 'file'}${ext}`;
    }
    return `${prefix}${name}`;
  }

  root.ImageSaverFolderPath = Object.freeze({
    DEFAULT_ROOT, LIMITS, INVISIBLE, isTildeShortName, normalizeSegment, normalizeRoot, resolveRoot, normalizeSite, joinPath
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
