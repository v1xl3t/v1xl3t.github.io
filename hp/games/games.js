/* ============================================================
   Shared chrome behavior for the HACKING PARADISE games pages.

   One job, the Abyss / Paradise theme switch, which is the same
   two ends the index page falls between. The choice is stored so
   it survives a reload and carries across the games pages.

   The theme attribute is written on <html> before paint by a tiny
   inline snippet in each page, so there is no flash of the wrong
   theme. This file only handles the button.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'hp-games-theme';

  function current() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode, fine */ }
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.textContent = theme === 'light' ? 'Abyss' : 'Paradise';
      b.setAttribute('aria-label', theme === 'light'
        ? 'Switch to the dark Abyss theme'
        : 'Switch to the bright Paradise theme');
    }
  }

  function init() {
    apply(current());
    document.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-theme-toggle]') : null;
      if (!b) return;
      e.preventDefault();
      apply(current() === 'light' ? 'dark' : 'light');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.HPGamesTheme = { apply: apply, current: current, KEY: KEY };
})();
