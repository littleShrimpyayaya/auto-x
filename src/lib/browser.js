/**
 * Cross-browser API shim — Chrome / Edge / Firefox / Opera.
 * Prefer `browser` (Firefox WebExtensions promise API), fall back to `chrome`.
 */
(function (root) {
  const api = typeof browser !== "undefined" ? browser : chrome;

  // Some older Firefox builds expose browser without storage.session etc.
  // All our call sites use promise-capable methods available on both.
  root.autoxBrowser = api;
  // Also expose as global for scripts that prefer a short name
  if (typeof root.browser === "undefined" && typeof chrome !== "undefined") {
    try {
      root.browser = chrome;
    } catch {
      /* ignore */
    }
  }
})(typeof self !== "undefined" ? self : globalThis);
