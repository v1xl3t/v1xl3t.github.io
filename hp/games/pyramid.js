/* ============================================================
   Pyramid for HACKING PARADISE.

   Twenty eight cards stacked seven rows deep, and every pair that
   adds up to thirteen comes off. The king is thirteen on its own,
   so it leaves alone, which is the only card in any of these games
   that needs nothing but itself.

   The board is the reason this one is last of the solitaires. Every
   other game on this table is columns in a grid, and sol-core.css
   draws those. A pyramid overlaps in two directions at once and a
   card is only reachable when BOTH of the cards resting on it have
   gone, so the positions are worked out in JS from the same --cw
   and --ch every other board uses. The shared table still measures
   it, drags for it, remembers it and speaks for it. Only the shape
   is local.

   Indexing is a flat run of twenty eight. Row r starts at
   r(r+1)/2 and holds r+1 cards, and the two cards covering (r, c)
   are (r+1, c) and (r+1, c+1). Every reachability question in the
   file is that one sentence.
   ============================================================ */
(function () {
  'use strict';

  var C = window.HPCards;
  var K = window.HPSolCore;
  var ROWS = 7;
  var SLOTS = 28;             /* 1 + 2 + 3 + 4 + 5 + 6 + 7 */
  var ACROSS = 7;             /* the widest row, and what the board is measured in */
  var TARGET = 13;

  var store = K.Store('hp-pyramid-v1', 1);
  var undoStack = K.Undo(80);
  var S = null;
  var sel = null;
  var els = {};
  var say = function () {};
  var hint = null;

  /* ---------- the shape ---------- */
  function rowOf(i) {
    var r = 0;
    while ((r + 1) * (r + 2) / 2 <= i) r++;
    return r;
  }
  function colOf(i) { return i - rowOf(i) * (rowOf(i) + 1) / 2; }
  function indexAt(r, c) { return r * (r + 1) / 2 + c; }
  function childrenOf(i) {
    var r = rowOf(i);
    if (r === ROWS - 1) return null;
    var c = colOf(i);
    return [indexAt(r + 1, c), indexAt(r + 1, c + 1)];
  }

  /* ============================================================
     STATE
     ============================================================ */
  function freshState(seed, passes) {
    var deck = K.shuffled(seed);
    return {
      seed: seed,
      passes: passes,           /* how many times through the deck, one or three */
      used: 0,                  /* how many of those are spent */
      pyr: deck.slice(0, SLOTS),
      stock: deck.slice(SLOTS),
      waste: [],
      moves: 0,
      won: false
    };
  }

  function snapshot() {
    return {
      pyr: S.pyr.slice(), stock: S.stock.slice(), waste: S.waste.slice(),
      used: S.used, moves: S.moves, won: S.won
    };
  }

  function restore(o) {
    S.pyr = o.pyr.slice();
    S.stock = o.stock.slice();
    S.waste = o.waste.slice();
    S.used = o.used;
    S.moves = o.moves;
    S.won = !!o.won;
  }

  /* ============================================================
     RULES

     Everything takes the board it judges. The game and the check for
     whether a deal is finished read one rulebook.
     ============================================================ */
  function freeIn(B, i) {
    if (!B.pyr[i]) return false;
    var kids = childrenOf(i);
    if (!kids) return true;                       /* the bottom row rests on nothing */
    return !B.pyr[kids[0]] && !B.pyr[kids[1]];
  }

  function wasteTopIn(B) { return B.waste.length ? B.waste[B.waste.length - 1] : null; }

  function isKing(id) { return K.valOf(id) === TARGET; }

  function pairsIn(B, a, b) { return K.valOf(a) + K.valOf(b) === TARGET; }

  /* Every removal a board offers right now. A king on its own is one
     of them, which is why this returns a list of moves rather than a
     list of pairs. */
  function removalsIn(B) {
    var out = [];
    var free = [];
    for (var i = 0; i < SLOTS; i++) if (freeIn(B, i)) free.push(i);

    free.forEach(function (i) {
      if (isKing(B.pyr[i])) out.push({ kind: 'king', a: { p: 'pyr', i: i } });
    });
    var top = wasteTopIn(B);
    if (top && isKing(top)) out.push({ kind: 'king', a: { p: 'waste' } });

    for (var x = 0; x < free.length; x++) {
      for (var y = x + 1; y < free.length; y++) {
        if (pairsIn(B, B.pyr[free[x]], B.pyr[free[y]])) {
          out.push({ kind: 'pair', a: { p: 'pyr', i: free[x] }, b: { p: 'pyr', i: free[y] } });
        }
      }
      if (top && pairsIn(B, B.pyr[free[x]], top)) {
        out.push({ kind: 'pair', a: { p: 'pyr', i: free[x] }, b: { p: 'waste' } });
      }
    }
    return out;
  }

  function canDrawIn(B) { return B.stock.length > 0; }
  /* Turning the pile back over spends one of your passes, and the last
     pass has no turn back at the end of it. */
  function canRecycleIn(B) { return !B.stock.length && B.waste.length > 0 && B.used < B.passes - 1; }

  function free(i) { return freeIn(S, i); }
  function removals() { return removalsIn(S); }
  function canDraw() { return canDrawIn(S); }
  function canRecycle() { return canRecycleIn(S); }
  function anyMove() { return removals().length > 0 || canDraw() || canRecycle(); }

  /* Every legal move either takes a card off the board for good or
     spends a finite amount of deck, so nothing here can shuffle
     forever and the question is only whether anything is legal. Same
     shape as Golf, and the same reason there is no search in this
     file. */
  function deadEnd() {
    if (S.won) return null;
    return anyMove() ? null : 'none';
  }

  function leftOnPyramid() {
    var n = 0;
    for (var i = 0; i < SLOTS; i++) if (S.pyr[i]) n++;
    return n;
  }

  function checkWin() {
    if (leftOnPyramid() === 0 && !S.won) {
      S.won = true;
      els.winbar.hidden = false;
      say('The pyramid is gone. Cleared.');
    }
    return S.won;
  }

  /* ============================================================
     MOVES
     ============================================================ */
  function takeIn(B, ref) {
    if (ref.p === 'waste') B.waste.pop();
    else B.pyr[ref.i] = null;
  }

  function legal(move) {
    if (!move) return false;
    if (move.kind === 'king') {
      var id = move.a.p === 'waste' ? wasteTopIn(S) : S.pyr[move.a.i];
      if (!id || !isKing(id)) return false;
      return move.a.p === 'waste' || free(move.a.i);
    }
    if (move.kind === 'pair') {
      if (move.a.p === 'waste' && move.b.p === 'waste') return false;
      if (move.a.p === 'pyr' && move.b.p === 'pyr' && move.a.i === move.b.i) return false;
      var ia = move.a.p === 'waste' ? wasteTopIn(S) : S.pyr[move.a.i];
      var ib = move.b.p === 'waste' ? wasteTopIn(S) : S.pyr[move.b.i];
      if (!ia || !ib) return false;
      if (move.a.p === 'pyr' && !free(move.a.i)) return false;
      if (move.b.p === 'pyr' && !free(move.b.i)) return false;
      return pairsIn(S, ia, ib);
    }
    return false;
  }

  function apply(move) {
    if (S.won || !legal(move)) return false;
    undoStack.push(snapshot());
    takeIn(S, move.a);
    if (move.kind === 'pair') takeIn(S, move.b);
    S.moves++;
    sel = null;
    hint.clear();
    checkWin();
    return true;
  }

  function draw() {
    if (S.won || !canDraw()) return false;
    undoStack.push(snapshot());
    S.waste.push(S.stock.pop());
    S.moves++;
    sel = null;
    hint.clear();
    return true;
  }

  function recycle() {
    if (S.won || !canRecycle()) return false;
    undoStack.push(snapshot());
    S.stock = S.waste.slice().reverse();
    S.waste = [];
    S.used++;
    S.moves++;
    sel = null;
    hint.clear();
    return true;
  }

  function undo() {
    var snap = undoStack.pop();
    if (!snap) return false;
    restore(snap);
    sel = null;
    S.won = false;
    els.winbar.hidden = true;
    hint.clear();
    return true;
  }

  /* ============================================================
     THE HINT

     A pair that frees another card is worth more than a pair that
     does not, and a pair taken off the pyramid is worth more than one
     that only clears the waste, because the waste is not what you are
     trying to empty. Everything else is a draw.
     ============================================================ */
  function wouldFree(move) {
    var n = { pyr: S.pyr.slice(), waste: S.waste.slice(), stock: S.stock, used: S.used, passes: S.passes };
    takeIn(n, move.a);
    if (move.kind === 'pair') takeIn(n, move.b);
    var before = 0, after = 0;
    for (var i = 0; i < SLOTS; i++) {
      if (freeIn(S, i)) before++;
      if (freeIn(n, i)) after++;
    }
    return after - before;
  }

  function scoreMove(m) {
    var score = 10;
    var onPyr = (m.a.p === 'pyr' ? 1 : 0) + (m.kind === 'pair' && m.b.p === 'pyr' ? 1 : 0);
    score += onPyr * 20;
    score += wouldFree(m) * 15;
    /* The row a card sits in is how deep it is buried, and digging is
       the whole game, so a deeper card breaks the tie. */
    if (m.a.p === 'pyr') score += (ROWS - rowOf(m.a.i));
    return score;
  }

  function bestMove() {
    var moves = removals();
    if (!moves.length) {
      if (canDraw()) return { kind: 'draw' };
      if (canRecycle()) return { kind: 'recycle' };
      return null;
    }
    var best = moves[0], bestScore = -1e9;
    moves.forEach(function (m) {
      var sc = scoreMove(m);
      if (sc > bestScore) { bestScore = sc; best = m; }
    });
    return best;
  }

  function keyOf(ref) { return ref.p === 'waste' ? 'waste' : 'pyr:' + ref.i; }

  function nameOf(ref) {
    var id = ref.p === 'waste' ? wasteTopIn(S) : S.pyr[ref.i];
    return C.label(K.card(id));
  }

  function showHint() {
    if (S.won) return;
    var dead = deadEnd();
    if (dead) { paintStuck(dead); return; }
    var m = bestMove();
    if (!m) return;
    if (m.kind === 'draw') {
      hint.show('stock', 'waste');
      say('Nothing pairs up. Turn one over.');
      return;
    }
    if (m.kind === 'recycle') {
      hint.show('stock', 'stock');
      say('Turn the pile back over and go through it again.');
      return;
    }
    if (m.kind === 'king') {
      hint.show(keyOf(m.a), keyOf(m.a));
      say('The ' + nameOf(m.a) + ' is thirteen on its own. Take it.');
      return;
    }
    hint.show(keyOf(m.a), keyOf(m.b));
    say('The ' + nameOf(m.a) + ' and the ' + nameOf(m.b) + ' make thirteen.');
  }

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  function save() { store.write({ seed: S.seed, passes: S.passes, s: snapshot(), u: undoStack.all() }); }

  function load() {
    var o = store.read();
    if (!o || !o.s) return false;
    S = { seed: o.seed || 0, passes: o.passes === 3 ? 3 : 1 };
    try { restore(o.s); } catch (e) { return false; }
    if (!S.pyr || S.pyr.length !== SLOTS) return false;
    undoStack.load(o.u);
    return true;
  }

  function newGame(passes, seed) {
    hint && hint.clear();
    S = freshState(seed != null ? seed : (Date.now() ^ Math.floor(Math.random() * 0xffffff)) >>> 0,
      passes != null ? passes : (S ? S.passes : 3));
    undoStack.clear();
    sel = null;
    els.winbar.hidden = true;
    render(); save();
  }

  /* How many times you may go through the deck decides whether a deal
     was ever winnable, so changing it mid game would rewrite the board
     you are looking at. */
  function setPasses(n) {
    if (S.passes === n) return;
    if (S.moves > 0 && !window.confirm(
      'Playing ' + (n === 1 ? 'one pass' : 'three passes') + ' through the deck starts a new game. Carry on?')) return;
    newGame(n);
    say(n === 1 ? 'One pass through the deck. New game dealt.' : 'Three passes through the deck. New game dealt.');
  }

  /* ============================================================
     RENDER

     The only board on this table whose positions are arithmetic
     rather than a grid. Row r holds r + 1 cards and is centered under
     the widest row, so it starts (7 minus its own width) halves of a
     card in from the left.
     ============================================================ */
  /* ---------- sizing ----------
     The only board here that is as tall as it is wide, so it is the
     only one that has to be measured both ways. sol-core sizes to the
     WIDTH, which is the right answer for seven columns and the wrong
     one for a seven row pyramid with a deck under it: at a desktop
     width the cards come out at their maximum and the deck ends up
     below the fold, on the game where every card is on screen at once
     and looking at the whole shape is the point.

     So take the width answer, work out how tall that makes the whole
     board, and if it does not fit, shrink until it does. Height is
     six overlaps plus a card for the pyramid, a gap, and one more
     card for the deck row. */
  var OVERLAP = 0.52;

  function sizeFor() {
    var size = K.sizeBoard(els.board, ACROSS);
    var top = els.board.getBoundingClientRect().top;
    var avail = Math.max(340, window.innerHeight - top - 28);
    var tall = function (ch) { return Math.round((ROWS - 1) * ch * OVERLAP) + ch + 24 + ch; };
    if (tall(size.ch) <= avail) return size;
    var ch = Math.floor((avail - 24) / ((ROWS - 1) * OVERLAP + 2));
    ch = Math.max(46, ch);
    var cw = Math.max(30, Math.min(size.cw, Math.round(ch / 1.4)));
    ch = Math.round(cw * 1.4);
    els.board.style.setProperty('--cw', cw + 'px');
    els.board.style.setProperty('--ch', ch + 'px');
    return { cw: cw, ch: ch, gap: size.gap };
  }

  function render() {
    var size = sizeFor();
    var cw = size.cw, ch = size.ch, gap = size.gap;
    var pitch = cw + gap;
    var rowStep = Math.round(ch * OVERLAP);     /* rows overlap by just under half */

    els.pyr.innerHTML = '';
    els.pyr.style.height = ((ROWS - 1) * rowStep + ch) + 'px';
    for (var i = 0; i < SLOTS; i++) {
      var r = rowOf(i), c = colOf(i);
      var id = S.pyr[i];
      var host = document.createElement('div');
      host.className = 'pile pyrslot';
      host.dataset.pile = 'pyr:' + i;
      host.style.left = (((ACROSS - (r + 1)) / 2) * pitch + c * pitch) + 'px';
      host.style.top = (r * rowStep) + 'px';
      /* A card nearer the bottom of the pyramid is drawn over the one
         it rests on, which is what makes the overlap read as a stack
         rather than a grid of half cards. */
      host.style.zIndex = String(r + 1);
      if (id) {
        var node = C.play(K.card(id));
        if (free(i)) node.classList.add('free');
        else node.classList.add('covered');
        if (sel && sel.p === 'pyr' && sel.i === i) node.classList.add('sel');
        host.appendChild(node);
      } else {
        host.classList.add('gone');
      }
      els.pyr.appendChild(host);
    }

    els.stock.innerHTML = '';
    els.stock.classList.toggle('dead', !S.stock.length && !canRecycle());
    if (S.stock.length) {
      els.stock.appendChild(C.back({ label: 'Deck, ' + S.stock.length + ' left. Tap to turn one over.' }));
    } else if (canRecycle()) {
      els.stock.appendChild(C.slot('↻', { label: 'Deck is empty. Tap to turn the pile back over.' }));
    } else {
      els.stock.appendChild(C.slot('☆', { label: 'The deck is finished.' }));
    }

    els.waste.innerHTML = '';
    var top = wasteTopIn(S);
    if (top) {
      var w = C.play(K.card(top));
      w.dataset.top = '1';
      w.classList.add('free');
      if (sel && sel.p === 'waste') w.classList.add('sel');
      els.waste.appendChild(w);
    } else {
      els.waste.appendChild(C.slot('', { label: 'Nothing turned over' }));
    }

    els.moves.textContent = String(S.moves);
    els.left.textContent = String(leftOnPyramid());
    els.deck.textContent = String(S.stock.length);
    els.pass.textContent = (S.used + 1) + ' of ' + S.passes;
    els.undoBtn.disabled = undoStack.depth() === 0;
    els.pass1.setAttribute('aria-pressed', String(S.passes === 1));
    els.pass3.setAttribute('aria-pressed', String(S.passes === 3));

    var dead = S.won ? null : deadEnd();
    paintStuck(dead);
    els.hintBtn.disabled = !!dead || S.won;
  }

  function paintStuck(dead) {
    if (!dead) { els.stuckbar.hidden = true; return; }
    els.stuckbar.hidden = false;
    els.stuckWhy.textContent = 'The deck is finished and nothing left uncovered adds up to thirteen. ' +
      leftOnPyramid() + ' card' + (leftOnPyramid() === 1 ? '' : 's') +
      ' still on the pyramid. Walk a few moves back, or take a fresh deal.';
    say('No moves left.');
  }

  /* ============================================================
     INPUT

     Tap one card, tap the other, and if they make thirteen they both
     go. A king goes on the first tap, because waiting for a second
     one it does not need would be a rule the game invented.
     ============================================================ */
  function refFrom(target) {
    var pileEl = target.closest ? target.closest('[data-pile]') : null;
    if (!pileEl) return null;
    var key = pileEl.dataset.pile;
    if (key === 'stock') return { p: 'stock' };
    if (key === 'waste') return S.waste.length ? { p: 'waste' } : { p: 'wasteEmpty' };
    if (key.indexOf('pyr:') === 0) return { p: 'pyr', i: parseInt(key.slice(4), 10) };
    return null;
  }

  function sameRef(a, b) {
    if (!a || !b || a.p !== b.p) return false;
    return a.p !== 'pyr' || a.i === b.i;
  }

  function idOf(ref) { return ref.p === 'waste' ? wasteTopIn(S) : S.pyr[ref.i]; }

  function handleTap(ref) {
    if (!ref || S.won) return;

    if (ref.p === 'stock') {
      if (draw()) { render(); save(); return; }
      if (recycle()) { render(); save(); say('Pile turned back over.'); return; }
      say(S.waste.length
        ? 'That was your last pass through the deck.'
        : 'The deck is finished.');
      return;
    }
    if (ref.p === 'wasteEmpty') { sel = null; render(); return; }

    if (ref.p === 'pyr' && !S.pyr[ref.i]) { sel = null; render(); return; }
    if (ref.p === 'pyr' && !free(ref.i)) {
      sel = null;
      say('The ' + C.label(K.card(S.pyr[ref.i])) + ' still has cards resting on it.');
      render();
      return;
    }

    var id = idOf(ref);
    if (isKing(id)) {
      if (apply({ kind: 'king', a: ref })) { render(); save(); say('King taken.'); return; }
    }

    if (sel && sameRef(sel, ref)) { sel = null; render(); return; }

    if (sel) {
      var move = { kind: 'pair', a: sel, b: ref };
      if (apply(move)) { render(); save(); say('Thirteen.'); return; }
      say('The ' + C.label(K.card(idOf(sel))) + ' and the ' + C.label(K.card(id)) +
        ' make ' + (K.valOf(idOf(sel)) + K.valOf(id)) + ', not thirteen.');
      sel = ref;
      render();
      return;
    }

    sel = ref;
    say(C.label(K.card(id)) + ' picked. Needs a ' + rankNeeded(id) + '.');
    render();
  }

  /* The rank objects carry `word`, not `name`. `name` is the suit's.
     Reading the wrong one said "Needs a undefined" out loud, in the
     one sentence in this game whose whole job is to tell a player what
     to look for. */
  function rankNeeded(id) {
    var want = TARGET - K.valOf(id);
    var deck = C.deck();
    for (var i = 0; i < deck.length; i++) {
      if (deck[i].v === want) return C.rank(deck[i].r).word.toLowerCase();
    }
    return 'card worth ' + want;
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function boot() {
    els.board = document.getElementById('board');
    els.pyr = document.getElementById('pyramid');
    els.stock = document.querySelector('[data-pile="stock"]');
    els.waste = document.querySelector('[data-pile="waste"]');
    els.live = document.getElementById('live');
    els.moves = document.getElementById('moves');
    els.left = document.getElementById('left');
    els.deck = document.getElementById('deck');
    els.pass = document.getElementById('pass');
    els.newBtn = document.getElementById('newBtn');
    els.undoBtn = document.getElementById('undoBtn');
    els.hintBtn = document.getElementById('hintBtn');
    els.pass1 = document.getElementById('pass1');
    els.pass3 = document.getElementById('pass3');
    els.winbar = document.getElementById('winbar');
    els.winNew = document.getElementById('winNew');
    els.stuckbar = document.getElementById('stuckbar');
    els.stuckWhy = document.getElementById('stuckWhy');
    els.stuckNew = document.getElementById('stuckNew');
    els.stuckUndo = document.getElementById('stuckUndo');

    say = K.Speaker(els.live);
    hint = K.Hint(els.board);

    if (!load()) newGame();
    else { els.winbar.hidden = !S.won; render(); }

    /* No drag layer here. There is nowhere to drag TO in Pyramid, a
       card is either taken or it is not, so a ghost following a finger
       would be a gesture that promises a destination the game does not
       have. Taps only, on purpose. */
    els.board.addEventListener('click', function (e) {
      handleTap(refFrom(e.target));
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sel) { sel = null; render(); }
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (undo()) { render(); save(); }
      }
    });

    els.newBtn.addEventListener('click', function () { newGame(); say('New game dealt.'); });
    els.undoBtn.addEventListener('click', function () { if (undo()) { render(); save(); say('Move undone.'); } });
    els.hintBtn.addEventListener('click', showHint);
    els.pass1.addEventListener('click', function () { setPasses(1); });
    els.pass3.addEventListener('click', function () { setPasses(3); });
    els.winNew.addEventListener('click', function () { newGame(); });
    els.stuckNew.addEventListener('click', function () { newGame(); say('New game dealt.'); });
    els.stuckUndo.addEventListener('click', function () { if (undo()) { render(); save(); say('Move undone.'); } });

    var rt = null;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(render, 120); });
  }

  window.HPPyramid = {
    get state() { return S; },
    deal: function (seed, passes) { newGame(passes, seed); },
    forceState: function (o) {
      if (o.pyr) S.pyr = o.pyr.slice();
      if (o.stock) S.stock = o.stock.slice();
      if (o.waste) S.waste = o.waste.slice();
      if (typeof o.used === 'number') S.used = o.used;
      if (o.passes) S.passes = o.passes;
      S.won = false;
      els.winbar.hidden = true;
      undoStack.clear();
      sel = null;
      checkWin();
      render(); save();
    },
    take: function (move) { var r = apply(move); if (r) { render(); save(); } return r; },
    draw: function () { var r = draw(); if (r) { render(); save(); } return r; },
    recycle: function () { var r = recycle(); if (r) { render(); save(); } return r; },
    undo: function () { var r = undo(); if (r) { render(); save(); } return r; },
    free: free,
    removals: removals,
    canDraw: canDraw,
    canRecycle: canRecycle,
    anyMove: anyMove,
    deadEnd: deadEnd,
    bestMove: bestMove,
    leftOnPyramid: leftOnPyramid,
    rowOf: rowOf, colOf: colOf, indexAt: indexAt, childrenOf: childrenOf,
    clearSave: function () { store.clear(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
