/* ============================================================
   sol-core.js — the parts every HACKING PARADISE card game needs
   and none of the parts that make one game the game it is.

   Written 2026-08-27, pulled out while building FreeCell rather
   than invented up front, so every function in here has at least
   one real caller and none of it is speculative.

   The split is deliberate and it is not "shared code good". A
   solitaire is two things bolted together:

     the RULES     what may sit on what, what counts as winning,
                   what a hint should suggest. Different in every
                   game, and the interesting half.

     the TABLE     measuring a board, dragging a stack of cards
                   under a finger, remembering the last eighty
                   moves, writing it all to localStorage, telling
                   a screen reader what happened.

   The table is identical in all of them and it is where the
   fiddly bugs live, so it lives here once. The rules stay in the
   game's own file where they can be read straight through.

   Nothing here knows what a foundation is. Piles are addressed by
   the string in data-pile and the game decides what those mean.

   NOTE, 2026-08-27. Klondike (solitaire.js) predates this file and
   still carries its own copies. That is debt, not a second system,
   and it is on the board. Do not fork this file to fix it, move
   Klondike onto this one.
   ============================================================ */
(function (root) {
  'use strict';

  var C = root.HPCards;

  /* ---------- cards ----------
     A card id is a suit letter and a rank, 'SA' or 'HT'. Everything
     in here reads that format and nothing else stores card state. */
  function suitOf(id) { return id.charAt(0); }
  function rankOf(id) { return id.slice(1); }
  function valOf(id) { return C.rank(rankOf(id)).v; }
  function isRed(id) { return C.suit(suitOf(id)).red; }
  function card(id) { return { id: id, s: suitOf(id), r: rankOf(id), v: valOf(id) }; }

  /* Is this actually a card id, rather than merely a string.
     Only matters where cards arrive from somewhere this browser does
     not control, which today means a message from another player. The
     rank lookups take an id on trust and throw on anything else, so an
     unchecked id from the wire is a crashed page rather than a bad
     move. */
  var CARD_RE = /^[SHCD][A2-9TJQK]$/;
  function isCardId(id) { return typeof id === 'string' && CARD_RE.test(id); }

  /* A repeatable shuffle, handed back as ids rather than card objects.
     HPCards.deck() yields objects because that is what the card painter
     wants, but a game's state should hold the smallest thing that
     survives JSON, and an id is that. The seed is kept by the game so a
     deal can be named, reported in a bug, and dealt again exactly. */
  function shuffled(seed) {
    return C.shuffle(C.deck(), C.rngFrom(seed)).map(function (c) { return c.id; });
  }

  /* ---------- persistence ----------
     Every write is wrapped. A browser in private mode throws on
     localStorage, and a game that will not deal because it cannot
     save is a worse game than one that forgets. */
  function Store(key, version) {
    return {
      write: function (payload) {
        try {
          localStorage.setItem(key, JSON.stringify({ v: version, d: payload }));
        } catch (e) { /* private mode or full. The game still plays. */ }
      },
      read: function () {
        var raw;
        try { raw = localStorage.getItem(key); } catch (e) { return null; }
        if (!raw) return null;
        try {
          var o = JSON.parse(raw);
          return (o && o.v === version) ? o.d : null;
        } catch (e) { return null; }
      },
      clear: function () { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
    };
  }

  /* ---------- undo ----------
     Snapshots, not an inverse move log. Fifty two cards is small
     enough that a snapshot costs nothing, and a snapshot cannot
     drift out of sync with the board the way an inverse log can. */
  function Undo(max) {
    var stack = [];
    return {
      push: function (snap) { stack.push(snap); if (stack.length > max) stack.shift(); },
      pop: function () { return stack.length ? stack.pop() : null; },
      clear: function () { stack = []; },
      depth: function () { return stack.length; },
      all: function () { return stack.slice(); },
      load: function (a) { stack = Array.isArray(a) ? a.slice(-max) : []; }
    };
  }

  /* ---------- measuring ----------
     Done in JS because a cascade of nineteen cards has to shrink its
     own overlap to fit the screen, and CSS cannot measure a pile.
     Writes the custom properties every board rule is expressed in. */
  var MIN_READABLE = 34;

  function sizeBoard(board, cols) {
    var w = board.clientWidth;
    var gap = Math.max(4, Math.min(10, Math.round(w * 0.014)));
    var cw = Math.floor((w - gap * (cols - 1)) / cols);
    /* Take the space out of the gaps before taking it out of the cards.
       Ten columns on a 390px phone spend 45px on gaps, which is enough
       to push the cards under the width their rank stops reading at, and
       clamping the card without shrinking the gap does not make it fit,
       it makes the board wider than the screen. */
    while (cw < MIN_READABLE && gap > 2) {
      gap--;
      cw = Math.floor((w - gap * (cols - 1)) / cols);
    }
    cw = Math.max(30, Math.min(104, cw));
    var ch = Math.round(cw * 1.4);
    board.style.setProperty('--cw', cw + 'px');
    board.style.setProperty('--ch', ch + 'px');
    board.style.setProperty('--gap', gap + 'px');
    board.style.setProperty('--fan', Math.round(cw * 0.3) + 'px');
    return { cw: cw, ch: ch, gap: gap };
  }

  /* ---------- saying things out loud ----------
     One live region, and it refuses to repeat itself, because a
     screen reader that reads the same sentence twice sounds broken
     and a player stops trusting it. */
  function Speaker(el) {
    var last = '';
    return function say(msg) {
      if (msg === last) return;
      last = msg;
      el.textContent = msg;
    };
  }

  /* ---------- the hint ring ----------
     An outline rather than a border so it cannot move a card by a
     pixel. Cleared on any board change, because a hint that outlives
     the position it described points at the wrong card. */
  function Hint(board) {
    var timer = null;
    function clear() {
      if (timer) { clearTimeout(timer); timer = null; }
      board.querySelectorAll('.pile.hint-src, .pile.hint-dst').forEach(function (n) {
        n.classList.remove('hint-src', 'hint-dst');
      });
    }
    return {
      clear: clear,
      show: function (srcKey, dstKey, ms) {
        clear();
        var a = board.querySelector('[data-pile="' + srcKey + '"]');
        var b = board.querySelector('[data-pile="' + dstKey + '"]');
        if (a) a.classList.add('hint-src');
        if (b) b.classList.add('hint-dst');
        timer = setTimeout(clear, ms || 4000);
      },
      lit: function () {
        return board.querySelectorAll('.pile.hint-src, .pile.hint-dst').length > 0;
      }
    };
  }

  /* ---------- dragging ----------
     Pointer events, so a mouse and a finger run the same code. The
     ghost is a separate fixed layer rather than the real cards, so
     nothing in the board moves until a drop is accepted.

     Two bugs are designed out here, both found in Klondike:

       the destination is read BEFORE the ghost is torn down, because
       reading it after meant every drop asked a null drag where it
       had landed, threw, and silently did nothing while the
       highlight during the drag looked perfect.

       the layer is hidden for exactly one elementFromPoint call, so
       the ghost cannot answer "what is under the finger" with
       itself. */
  function Table(opts) {
    var board = opts.board;
    var layer = opts.layer;
    var slop = opts.slop == null ? 7 : opts.slop;
    var drag = null, down = null;

    function ghostUp(src, ids, e, rect) {
      var cs = getComputedStyle(board);
      var cw = parseInt(cs.getPropertyValue('--cw'), 10);
      var ch = parseInt(cs.getPropertyValue('--ch'), 10);
      layer.style.setProperty('--dcw', cw + 'px');
      layer.style.setProperty('--dch', ch + 'px');
      layer.innerHTML = '';
      var step = Math.round(ch * 0.28);
      ids.forEach(function (id, i) {
        var n = C.play(card(id));
        n.style.top = (i * step) + 'px';
        n.style.left = '0px';
        n.style.zIndex = String(i + 1);
        layer.appendChild(n);
      });
      drag = { src: src, ids: ids, dx: e.clientX - rect.left, dy: e.clientY - rect.top, hover: null };
      layer.hidden = false;
      document.body.classList.add('dragging');
    }

    function ghostTo(e) {
      var x = e.clientX - drag.dx, y = e.clientY - drag.dy;
      var kids = layer.children;
      for (var i = 0; i < kids.length; i++) {
        kids[i].style.transform = 'translate(' + x + 'px,' + y + 'px)';
      }
    }

    /* Takes the drag explicitly rather than reading the closed over
       one, because the teardown nulls that before the drop is
       resolved. */
    function under(e, d) {
      if (!d) return null;
      var was = layer.hidden;
      layer.hidden = true;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      layer.hidden = was;
      if (!el || !el.closest) return null;
      return opts.destOf(el, d);
    }

    function paint(dest) {
      board.querySelectorAll('.hpc.drop').forEach(function (n) { n.classList.remove('drop'); });
      if (dest == null) return;
      var host = opts.hostFor(dest);
      if (host && host.lastElementChild) host.lastElementChild.classList.add('drop');
    }

    function finish(e, commit) {
      var d = drag; drag = null;
      var dest = (d && commit) ? under(e, d) : null;
      document.body.classList.remove('dragging');
      layer.hidden = true;
      layer.innerHTML = '';
      paint(null);
      if (!d) return;
      opts.onDrop(d, dest);
    }

    board.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      if (opts.frozen && opts.frozen()) return;
      var picked = opts.onDown(e);
      if (!picked) { down = null; return; }
      down = { x: e.clientX, y: e.clientY, id: e.pointerId,
               rect: picked.rect, ids: picked.ids, src: picked.src, tap: picked.tap };
      if (picked.ids && picked.rect) {
        // capture, so a fast drag that outruns the card still reaches us
        try { board.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
    });

    board.addEventListener('pointermove', function (e) {
      if (!down || e.pointerId !== down.id) return;
      if (!drag) {
        var dist = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
        if (dist < slop || !down.ids || !down.rect) return;
        ghostUp(down.src, down.ids, e, down.rect);
      }
      e.preventDefault();
      ghostTo(e);
      var t = under(e, drag);
      if (t !== drag.hover) { drag.hover = t; paint(t); }
    });

    board.addEventListener('pointerup', function (e) {
      if (!down || e.pointerId !== down.id) return;
      var d = down; down = null;
      try { board.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (drag) { finish(e, true); return; }
      opts.onTap(d.tap);
    });

    board.addEventListener('pointercancel', function (e) {
      if (!down || e.pointerId !== down.id) return;
      down = null;
      if (drag) finish(e, false);
    });

    /* There is deliberately no dblclick listener. Pointer events already
       fire for a mouse, so the second tap path covers a double click too,
       and running both meant the dblclick handler acted on an index the
       first handler had already moved a card out of, which silently moved
       the wrong card. */

    return { dragging: function () { return !!drag; } };
  }

  /* ---------- can this deal still get anywhere ----------
     The question a stuck detector has to ask is NOT "are there legal
     moves". A board can have legal moves and be over, because sliding
     a card between two columns and back is a step, not an answer.

     So walk the moves that only rearrange, depth first, and look for
     any state where something real happens. What counts as real is the
     game's call, which is why isProgress is passed in.

     The cap matters and the two games read it in OPPOSITE directions,
     on purpose:

       Klondike hits the cap almost never, and when a deal is that
       tangled it is usually finished, so the cap reports stuck. Being
       wrong that way raises a bar with an Undo on it.

       FreeCell has a far larger shuffle space and long games routinely
       blow past any sane cap while very much alive, so the cap reports
       UNKNOWN and the game says nothing. Crying wolf at a player who is
       fine is worse than staying quiet at one who is stuck.

     Returns true, false, or null for "ran out of budget, no idea". */
  function reachable(start, successors, isProgress, cap) {
    var seen = {};
    var stack = [start];
    var nodes = 0;
    seen[start.key] = 1;
    while (stack.length) {
      if (++nodes > cap) return null;
      var here = stack.pop();
      var next = successors(here);
      for (var i = 0; i < next.length; i++) {
        var n = next[i];
        if (isProgress(n)) return true;
        if (!seen[n.key]) { seen[n.key] = 1; stack.push(n); }
      }
    }
    return false;
  }

  root.HPSolCore = {
    suitOf: suitOf, rankOf: rankOf, valOf: valOf, isRed: isRed, card: card,
    isCardId: isCardId,
    shuffled: shuffled,
    Store: Store, Undo: Undo, Speaker: Speaker, Hint: Hint, Table: Table,
    sizeBoard: sizeBoard, reachable: reachable
  };
})(window);
