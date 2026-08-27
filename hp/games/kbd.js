/* ============================================================
   kbd.js — playing these games without a pointer.

   Six of the seven card games could only be played by touching
   them. That is not a missing feature, it is a locked door, and
   the people it locks out are the ones who have the least choice
   about it.

   THE IDEA THAT MAKES THIS SMALL

   Every one of these games already has tap to tap. Tap a card to
   pick it up, tap a pile to put it down. That IS the keyboard
   model. So this file does not add a way to play, it adds a way to
   POINT, and then hands the existing tap handler the thing it is
   pointing at. A game that already works by tapping needs to tell
   this file almost nothing.

   IT READS THE BOARD RATHER THAN BEING TOLD ABOUT IT

   The grid is worked out from where the piles actually are on
   screen, by grouping every [data-pile] by its vertical position
   and sorting each row left to right. No game declares its layout,
   which is why the same file drives a seven column Klondike, a ten
   column Spider and a pyramid whose positions are arithmetic. When
   a board changes shape mid game, the grid is simply read again.

   THE KEYS

     arrows        move between piles, and up and down walk the
                   cards inside a column before leaving it, because
                   which card you mean is half the move in most of
                   these games
     enter, space  the same thing a tap does
     escape        put down whatever you are holding
     letters       whatever the game put on its bar

   WHY THE HELP IS A DIALOG AND NOT A TOOLTIP

   A tooltip on hover cannot be reached by the keyboard, and there
   is no hover at all on a phone. Help for people who cannot use a
   pointer must not itself require a pointer. It is a real dialog,
   so Escape closes it and focus is kept inside it without any of
   that being written here.
   ============================================================ */
(function (root) {
  'use strict';

  var HELP_ID = 'hpk-help';

  function attach(opts) {
    var board = opts.board;
    var say = opts.say || function () {};
    var focus = null;              /* { key, idx } */
    var on = false;                /* has the keyboard been used yet */

    /* ---------- reading the board ---------- */
    function pilesNow() {
      var out = [];
      var all = board.querySelectorAll('[data-pile]');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;       /* hidden, spacer, gone */
        if (el.classList.contains('spacer')) continue;
        out.push({ el: el, key: el.dataset.pile, x: r.left, y: r.top, w: r.width });
      }
      return out;
    }

    /* Group by vertical position into rows. A tolerance rather than an
       exact match, because a pyramid row is a few pixels off level and
       a fanned column starts wherever its cards start. */
    function grid() {
      var piles = pilesNow();
      piles.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
      var rows = [];
      piles.forEach(function (p) {
        var row = null;
        for (var i = 0; i < rows.length; i++) {
          if (Math.abs(rows[i][0].y - p.y) < 26) { row = rows[i]; break; }
        }
        if (!row) { row = []; rows.push(row); }
        row.push(p);
      });
      rows.forEach(function (r) { r.sort(function (a, b) { return a.x - b.x; }); });
      return rows;
    }

    function findAt(rows, key) {
      for (var r = 0; r < rows.length; r++) {
        for (var c = 0; c < rows[r].length; c++) {
          if (rows[r][c].key === key) return { r: r, c: c, pile: rows[r][c] };
        }
      }
      return null;
    }

    /* The cards in a pile that can be pointed at. Every game already
       marks them with data-idx, so this needs no cooperation. */
    function cardsIn(pileEl) {
      return pileEl.querySelectorAll('.hpc[data-idx]');
    }

    function clampFocus() {
      var rows = grid();
      if (!rows.length) { focus = null; return rows; }
      if (!focus || !findAt(rows, focus.key)) {
        /* Start at the first pile of the last row, which is the
           tableau in every one of these games, because that is where
           a player's attention already is. */
        var last = rows[rows.length - 1];
        focus = { key: last[0].key, idx: -1 };
      }
      var at = findAt(rows, focus.key);
      var n = cardsIn(at.pile.el).length;
      if (focus.idx >= n) focus.idx = n ? n - 1 : -1;
      if (n === 0) focus.idx = -1;
      return rows;
    }

    /* ---------- painting ---------- */
    function repaint() {
      board.querySelectorAll('.kfocus').forEach(function (n) { n.classList.remove('kfocus'); });
      board.querySelectorAll('.kcard').forEach(function (n) { n.classList.remove('kcard'); });
      if (!on) return;
      var rows = clampFocus();
      if (!rows.length || !focus) return;
      var at = findAt(rows, focus.key);
      if (!at) return;
      at.pile.el.classList.add('kfocus');
      var cards = cardsIn(at.pile.el);
      if (focus.idx >= 0 && cards[focus.idx]) cards[focus.idx].classList.add('kcard');
      else if (cards.length) cards[cards.length - 1].classList.add('kcard');
    }

    /* The vocabulary of pile keys is the same in all of these games,
       so the default description works everywhere and no game has to
       write one. A game may still override it. */
    function pileName(key) {
      if (key === 'stock') return 'the deck';
      if (key === 'waste') return 'the pile';
      if (key.indexOf('found:') === 0) return SUIT_WORD[key.slice(6)] + ' foundation';
      if (key.indexOf('free:') === 0) return 'free cell ' + (parseInt(key.slice(5), 10) + 1);
      if (key.indexOf('tab:') === 0) return 'column ' + (parseInt(key.slice(4), 10) + 1);
      if (key.indexOf('pyr:') === 0) return 'the pyramid';
      return key;
    }
    var SUIT_WORD = { S: 'the spades', H: 'the hearts', C: 'the clubs', D: 'the diamonds' };

    function defaultDescribe(key, idx) {
      var pile = board.querySelector('[data-pile="' + key + '"]');
      if (!pile) return pileName(key);
      var cards = cardsIn(pile);
      var card = cards[idx >= 0 ? idx : cards.length - 1] || pile.querySelector('.hpc');
      var what = card ? (card.getAttribute('aria-label') || '') : '';
      var where = pileName(key);
      if (!what) return where + ', empty';
      /* The deck and the pile already name themselves in their own
         label, and appending "the deck" to "Deck, 24 left" is the kind
         of small doubling that makes a screen reader exhausting. */
      if (key === 'stock' || key === 'waste') return what;
      /* Where in the column, but only when there is more than one, or
         it reads as noise on every single move. */
      if (cards.length > 1) {
        var n = (idx >= 0 ? idx : cards.length - 1) + 1;
        return what + ', ' + n + ' of ' + cards.length + ' in ' + where;
      }
      return what + ', ' + where;
    }

    function announce() {
      if (!focus) return;
      var text = opts.describe ? opts.describe(focus.key, focus.idx) : defaultDescribe(focus.key, focus.idx);
      if (text) say(text);
    }

    /* ---------- moving ---------- */
    function step(dx, dy) {
      var rows = clampFocus();
      if (!rows.length) return;
      var at = findAt(rows, focus.key);
      if (!at) return;

      if (dy !== 0) {
        /* Walk the cards inside a column first. Which card you mean is
           half the move in most of these games, and jumping straight to
           the next row would make the deep cards unreachable. */
        var cards = cardsIn(at.pile.el);
        if (cards.length > 1) {
          var here = focus.idx < 0 ? cards.length - 1 : focus.idx;
          var next = here + dy;
          if (next >= 0 && next < cards.length) {
            focus.idx = next;
            repaint(); announce();
            return;
          }
        }
        var r = at.r + dy;
        if (r < 0) r = rows.length - 1;
        if (r >= rows.length) r = 0;
        var row = rows[r];
        /* Land on whichever pile is nearest across, rather than on the
           same index, because rows here are different lengths. */
        var want = at.pile.x + at.pile.w / 2;
        var best = row[0], bestD = Infinity;
        row.forEach(function (p) {
          var d = Math.abs((p.x + p.w / 2) - want);
          if (d < bestD) { bestD = d; best = p; }
        });
        focus = { key: best.key, idx: -1 };
        repaint(); announce();
        return;
      }

      var c = at.c + dx;
      var line = rows[at.r];
      if (c < 0) c = line.length - 1;
      if (c >= line.length) c = 0;
      focus = { key: line[c].key, idx: -1 };
      repaint(); announce();
    }

    function activate() {
      clampFocus();
      if (!focus) return;
      var rows = grid();
      var at = findAt(rows, focus.key);
      if (!at) return;
      var cards = cardsIn(at.pile.el);
      var idx = focus.idx;
      if (idx < 0 && cards.length) idx = cards.length - 1;
      opts.activate(focus.key, idx, at.pile.el, cards[idx] || null);
      repaint();
    }

    /* ---------- the help dialog ---------- */
    function buildHelp() {
      if (document.getElementById(HELP_ID)) return document.getElementById(HELP_ID);
      var dlg = document.createElement('dialog');
      dlg.id = HELP_ID;
      dlg.className = 'khelp';

      var h = document.createElement('h2');
      h.textContent = 'Playing with a keyboard';
      dlg.appendChild(h);

      var lede = document.createElement('p');
      lede.className = 'khelp-lede';
      lede.textContent = 'Everything here can be played by tapping, clicking or typing. ' +
        'These are the keys. Nothing needs to be turned on, just start pressing them.';
      dlg.appendChild(lede);

      var dl = document.createElement('dl');
      (opts.help || []).forEach(function (row) {
        var dt = document.createElement('dt');
        row.keys.forEach(function (k) {
          var kbd = document.createElement('kbd');
          kbd.textContent = k;
          dt.appendChild(kbd);
        });
        var dd = document.createElement('dd');
        dd.textContent = row.what;
        dl.appendChild(dt);
        dl.appendChild(dd);
      });
      dlg.appendChild(dl);

      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn primary';
      close.textContent = 'Close';
      close.addEventListener('click', function () { dlg.close(); });
      dlg.appendChild(close);

      /* Clicking the backdrop closes it. The dialog fills its own box,
         so a click that lands on the element itself landed outside the
         content. */
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg) dlg.close();
      });
      document.body.appendChild(dlg);
      return dlg;
    }

    function openHelp() {
      var dlg = buildHelp();
      if (dlg.showModal) dlg.showModal();
      else dlg.setAttribute('open', '');
    }

    /* ---------- wiring ---------- */
    if (opts.helpBtn) {
      opts.helpBtn.addEventListener('click', openHelp);
    }

    /* Some games already play by keyboard, or are made of real buttons
       and are reachable by Tab already. They want the help dialog and
       none of the pointing, and installing the key handler anyway would
       fight whatever they already do. */
    if (opts.helpOnly) {
      return { openHelp: openHelp, repaint: function () {}, helpOnly: true,
        focus: function () { return null; }, enable: function () {}, active: function () { return false; } };
    }

    board.setAttribute('tabindex', '0');
    board.addEventListener('focus', function () {
      if (!on) { on = true; repaint(); announce(); }
    });

    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented) return;
      var t = e.target;
      /* Never steal a key from something being typed into. */
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var dlg = document.getElementById(HELP_ID);
      if (dlg && dlg.open) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      var k = e.key;
      if (k === '?' || (k === '/' && e.shiftKey)) { e.preventDefault(); openHelp(); return; }

      var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[k]) {
        e.preventDefault();
        if (!on) { on = true; repaint(); announce(); return; }
        step(arrows[k][0], arrows[k][1]);
        return;
      }
      if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
        /* Space and Enter belong to a focused button first. */
        if (t && (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY')) return;
        e.preventDefault();
        if (!on) { on = true; repaint(); announce(); return; }
        activate();
        return;
      }
      if (k === 'Escape') {
        if (opts.cancel) { opts.cancel(); repaint(); }
        return;
      }
      if (k === 'Home' || k === 'End') {
        e.preventDefault();
        if (!on) { on = true; }
        var rows = clampFocus();
        if (!rows.length) return;
        var at = findAt(rows, focus.key);
        var line = rows[at.r];
        focus = { key: (k === 'Home' ? line[0] : line[line.length - 1]).key, idx: -1 };
        repaint(); announce();
        return;
      }

      var lower = typeof k === 'string' ? k.toLowerCase() : '';
      var fn = opts.shortcuts && opts.shortcuts[lower];
      if (fn) { e.preventDefault(); fn(); repaint(); }
    });

    return {
      repaint: repaint,
      openHelp: openHelp,
      focus: function () { return focus ? { key: focus.key, idx: focus.idx } : null; },
      /* For a suite. Turning it on by hand skips having to move the
         mouse somewhere first. */
      enable: function () { on = true; repaint(); },
      active: function () { return on; }
    };
  }

  root.HPKeys = { attach: attach };
})(window);
