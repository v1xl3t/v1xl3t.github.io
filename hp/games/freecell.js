/* ============================================================
   FreeCell for HACKING PARADISE.

   The table underneath this file is sol-core.js. What lives here
   is only what makes FreeCell FreeCell, which is a shorter list
   than it looks:

     nothing is hidden      every card is face up from the first
                            second, so there is no luck left after
                            the deal and a loss is genuinely yours

     four cells             one card each, and they are the whole
                            game. Everything hard about FreeCell is
                            the arithmetic of how many you can
                            afford to fill

     the supermove          you may only ever move ONE card. Moving
                            a run of five is the game doing five
                            single moves through the free cells on
                            your behalf, which is why the number it
                            will carry depends on how many cells and
                            empty columns you have left

   Two input models, both always live, because this has to work on
   a phone and on a desktop without a mode switch. Drag and drop,
   and tap to tap. A second tap on the same card sends it home if
   it can go.

   Undo is snapshot based and the whole game is written to
   localStorage after every change, both inherited from sol-core.
   ============================================================ */
(function () {
  'use strict';

  var C = window.HPCards;
  var K = window.HPSolCore;
  var SUITS = ['S', 'H', 'C', 'D'];
  var COLS = 8;
  var CELLS = 4;

  var store = K.Store('hp-freecell-v1', 1);
  var undoStack = K.Undo(80);
  var S = null;
  var sel = null;
  var lastTap = { id: null, at: 0 };
  var els = {};
  var race = null;
  var keys = null;
  var say = function () {};
  var hint = null;
  var autoTimer = null;

  /* ============================================================
     STATE
     ============================================================ */
  function freshState(seed) {
    var deck = K.shuffled(seed);
    var t = [];
    for (var c = 0; c < COLS; c++) t.push([]);
    /* Round robin, so the first four columns take seven cards and the
       last four take six. Dealing straight down the columns instead
       would produce a different, and much easier, distribution. */
    for (var i = 0; i < deck.length; i++) t[i % COLS].push(deck[i]);
    return {
      seed: seed,
      free: [null, null, null, null],
      f: { S: [], H: [], C: [], D: [] },
      t: t,
      moves: 0,
      won: false
    };
  }

  function snapshot() {
    return {
      free: S.free.slice(),
      f: { S: S.f.S.slice(), H: S.f.H.slice(), C: S.f.C.slice(), D: S.f.D.slice() },
      t: S.t.map(function (col) { return col.slice(); }),
      moves: S.moves,
      won: S.won
    };
  }

  function restore(o) {
    S.free = o.free.slice();
    S.f = { S: o.f.S.slice(), H: o.f.H.slice(), C: o.f.C.slice(), D: o.f.D.slice() };
    S.t = o.t.map(function (col) { return col.slice(); });
    S.moves = o.moves;
    S.won = !!o.won;
  }

  /* ============================================================
     RULES

     Every helper takes the board it is judging rather than reading
     the live one, so the game and the analysis that decides whether
     a deal is finished share exactly one rulebook and cannot drift
     apart. The wrappers below read the live board for the rest of
     the file.
     ============================================================ */
  function canFoundIn(B, id, s) {
    return K.suitOf(id) === s && K.valOf(id) === B.f[s].length + 1;
  }
  function foundationForIn(B, id) {
    var s = K.suitOf(id);
    return canFoundIn(B, id, s) ? s : null;
  }
  function canStackIn(B, id, col) {
    var pile = B.t[col];
    if (!pile.length) return true;
    var top = pile[pile.length - 1];
    return K.valOf(id) === K.valOf(top) - 1 && K.isRed(id) !== K.isRed(top);
  }
  /* A run is descending and alternating. Anything else cannot travel
     together no matter how many cells are free. */
  function runFromIn(B, col, idx) {
    var pile = B.t[col];
    if (idx < 0 || idx >= pile.length) return null;
    for (var i = idx; i < pile.length - 1; i++) {
      var a = pile[i], b = pile[i + 1];
      if (K.valOf(b) !== K.valOf(a) - 1 || K.isRed(b) === K.isRed(a)) return null;
    }
    return pile.slice(idx);
  }
  function openCellsIn(B) {
    var n = 0;
    for (var i = 0; i < CELLS; i++) if (B.free[i] === null) n++;
    return n;
  }
  function emptyColsIn(B) {
    var n = 0;
    for (var i = 0; i < COLS; i++) if (!B.t[i].length) n++;
    return n;
  }
  /* How many cards a move may carry. You are only ever moving one card,
     so this is the count of single moves the cells and the empty
     columns can stage for you.

     The destination is excluded from the empty column count when it is
     itself empty, because you cannot use a column as a staging post and
     land on it in the same move. Getting that wrong is the classic
     FreeCell bug, and it is generous in the direction that lets a
     player make a move the rules forbid. */
  function maxMoveIn(B, destCol) {
    var empties = emptyColsIn(B);
    if (destCol != null && !B.t[destCol].length) empties -= 1;
    if (empties < 0) empties = 0;
    return (openCellsIn(B) + 1) * Math.pow(2, empties);
  }

  function canFound(id, s) { return canFoundIn(S, id, s); }
  function foundationFor(id) { return foundationForIn(S, id); }
  function canStack(id, col) { return canStackIn(S, id, col); }
  function runFrom(col, idx) { return runFromIn(S, col, idx); }
  function openCells() { return openCellsIn(S); }
  function emptyCols() { return emptyColsIn(S); }
  function maxMove(destCol) { return maxMoveIn(S, destCol); }

  /* ============================================================
     MOVES
     ============================================================ */
  function srcIdsIn(B, src) {
    if (!src) return null;
    if (src.kind === 'free') return B.free[src.i] ? [B.free[src.i]] : null;
    if (src.kind === 'found') {
      var pile = B.f[src.s];
      return pile.length ? [pile[pile.length - 1]] : null;
    }
    if (src.kind === 'tab') return runFromIn(B, src.col, src.idx);
    return null;
  }
  function srcIds(src) { return srcIdsIn(S, src); }

  function legalIn(B, src, dest) {
    var ids = srcIdsIn(B, src);
    if (!ids || !ids.length || !dest) return false;
    if (src.kind === 'tab' && dest.kind === 'tab' && src.col === dest.col) return false;
    if (dest.kind === 'free') {
      return ids.length === 1 && dest.i >= 0 && dest.i < CELLS && B.free[dest.i] === null;
    }
    if (dest.kind === 'found') {
      return ids.length === 1 && canFoundIn(B, ids[0], dest.s);
    }
    if (dest.kind === 'tab') {
      if (!canStackIn(B, ids[0], dest.col)) return false;
      return ids.length <= maxMoveIn(B, dest.col);
    }
    return false;
  }

  function applyIn(B, src, dest) {
    if (!legalIn(B, src, dest)) return false;
    var ids = srcIdsIn(B, src);
    if (src.kind === 'free') B.free[src.i] = null;
    else if (src.kind === 'found') B.f[src.s].pop();
    else B.t[src.col].length = B.t[src.col].length - ids.length;

    if (dest.kind === 'free') B.free[dest.i] = ids[0];
    else if (dest.kind === 'found') B.f[dest.s].push(ids[0]);
    else Array.prototype.push.apply(B.t[dest.col], ids);
    return true;
  }

  function checkWin() {
    var total = 0;
    SUITS.forEach(function (k) { total += S.f[k].length; });
    if (total === 52 && !S.won) {
      S.won = true;
      els.winbar.hidden = false;
      say('Every card is home. Cleared.');
    }
    return S.won;
  }

  function apply(src, dest) {
    if (!legalIn(S, src, dest)) return false;
    undoStack.push(snapshot());
    applyIn(S, src, dest);
    S.moves++;
    hint.clear();
    checkWin();
    return true;
  }

  function undo() {
    var snap = undoStack.pop();
    if (!snap) return false;
    stopAuto();
    restore(snap);
    sel = null;
    S.won = false;
    els.winbar.hidden = true;
    hint.clear();
    return true;
  }

  function sendHome(src) {
    var ids = srcIds(src);
    if (!ids || ids.length !== 1) return false;
    var s = foundationFor(ids[0]);
    return s ? apply(src, { kind: 'found', s: s }) : false;
  }

  /* ============================================================
     AUTO FINISH

     A card is safe to send up on its own only when no lower card of
     the other color could still need it. Send a black six while a
     red four is buried and you have taken away the square that four
     had to land on. The test is the standard one, and the two and
     the ace are always safe because nothing can ever need them.
     ============================================================ */
  function safeToSend(B, id) {
    var v = K.valOf(id);
    if (v <= 2) return true;
    var red = K.isRed(id);
    var lowOther = 99, lowSame = 99;
    SUITS.forEach(function (k) {
      if (k === K.suitOf(id)) return;
      var h = B.f[k].length;
      if (C.suit(k).red === red) lowSame = Math.min(lowSame, h);
      else lowOther = Math.min(lowOther, h);
    });
    return lowOther >= v - 1 && lowSame >= v - 2;
  }

  function oneAutoMove() {
    for (var i = 0; i < CELLS; i++) {
      var fid = S.free[i];
      if (fid && foundationFor(fid) && safeToSend(S, fid)) {
        return apply({ kind: 'free', i: i }, { kind: 'found', s: K.suitOf(fid) });
      }
    }
    for (var c = 0; c < COLS; c++) {
      var pile = S.t[c];
      if (!pile.length) continue;
      var id = pile[pile.length - 1];
      if (foundationFor(id) && safeToSend(S, id)) {
        return apply({ kind: 'tab', col: c, idx: pile.length - 1 }, { kind: 'found', s: K.suitOf(id) });
      }
    }
    return false;
  }

  function autoAvailable() {
    if (S.won) return false;
    var save = snapshot();
    var depth = undoStack.depth();
    var any = oneAutoMove();
    if (any) { restore(save); while (undoStack.depth() > depth) undoStack.pop(); }
    return any;
  }

  function stopAuto() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  }

  function autoFinish(instant) {
    stopAuto();
    sel = null;
    function step() {
      if (!oneAutoMove()) { autoTimer = null; render(); save(); return; }
      render(); save();
      if (instant) { step(); return; }
      autoTimer = setTimeout(step, 70);
    }
    step();
  }

  /* ============================================================
     IS THIS DEAL FINISHED

     FreeCell hides nothing, so the only thing that counts as getting
     somewhere is a card reaching a foundation. Shuffling between
     columns and cells is a step, not an answer.

     Read the cap comment in sol-core before changing the direction
     this is wrong in. A cap hit here means UNKNOWN and the game says
     nothing, which is the opposite of Klondike, because a long
     FreeCell game routinely explores more positions than any sane cap
     while being perfectly alive. Telling a player who is fine that
     she is stuck is the worse mistake.
     ============================================================ */
  var SEARCH_CAP = 6000;

  function stateKey(B) {
    return B.t.map(function (col) { return col.join(''); }).join('|') +
      '#' + B.free.slice().sort().join(',');
  }

  function anyFoundMove(B) {
    for (var i = 0; i < CELLS; i++) {
      if (B.free[i] && foundationForIn(B, B.free[i])) return true;
    }
    for (var c = 0; c < COLS; c++) {
      var pile = B.t[c];
      if (pile.length && foundationForIn(B, pile[pile.length - 1])) return true;
    }
    return false;
  }

  /* Every move that only rearranges. Foundation moves are left out on
     purpose, they are the thing being searched FOR, and moves back off
     a foundation are left out because they only ever undo progress and
     they multiply the space for nothing. */
  function shuffles(B) {
    var out = [];
    function clone() {
      return {
        free: B.free.slice(),
        f: { S: B.f.S.slice(), H: B.f.H.slice(), C: B.f.C.slice(), D: B.f.D.slice() },
        t: B.t.map(function (col) { return col.slice(); }),
        moves: B.moves, won: B.won
      };
    }
    function push(src, dest) {
      var n = clone();
      if (!applyIn(n, src, dest)) return;
      n.key = stateKey(n);
      out.push(n);
    }
    var c, i, idx;
    for (c = 0; c < COLS; c++) {
      var pile = B.t[c];
      for (idx = 0; idx < pile.length; idx++) {
        if (!runFromIn(B, c, idx)) continue;
        for (var d = 0; d < COLS; d++) {
          if (d === c) continue;
          /* One empty column is worth exactly as much as any other, so
             only the first is tried. Without this the search spends its
             whole budget permuting identical positions. */
          if (!B.t[d].length && emptyColsIn(B) > 1 && d !== firstEmpty(B)) continue;
          push({ kind: 'tab', col: c, idx: idx }, { kind: 'tab', col: d });
        }
      }
      if (pile.length) {
        for (i = 0; i < CELLS; i++) {
          if (B.free[i] === null) { push({ kind: 'tab', col: c, idx: pile.length - 1 }, { kind: 'free', i: i }); break; }
        }
      }
    }
    for (i = 0; i < CELLS; i++) {
      if (!B.free[i]) continue;
      for (c = 0; c < COLS; c++) push({ kind: 'free', i: i }, { kind: 'tab', col: c });
    }
    return out;
  }

  function firstEmpty(B) {
    for (var i = 0; i < COLS; i++) if (!B.t[i].length) return i;
    return -1;
  }

  function boardMoves() {
    var out = [];
    var c, i, idx;
    for (c = 0; c < COLS; c++) {
      var pile = S.t[c];
      for (idx = 0; idx < pile.length; idx++) {
        if (!runFrom(c, idx)) continue;
        var src = { kind: 'tab', col: c, idx: idx };
        for (var d = 0; d < COLS; d++) {
          if (legalIn(S, src, { kind: 'tab', col: d })) out.push({ src: src, dest: { kind: 'tab', col: d } });
        }
        if (idx === pile.length - 1) {
          SUITS.forEach(function (k) {
            if (legalIn(S, src, { kind: 'found', s: k })) out.push({ src: src, dest: { kind: 'found', s: k } });
          });
          for (i = 0; i < CELLS; i++) {
            if (legalIn(S, src, { kind: 'free', i: i })) { out.push({ src: src, dest: { kind: 'free', i: i } }); break; }
          }
        }
      }
    }
    for (i = 0; i < CELLS; i++) {
      if (!S.free[i]) continue;
      var fsrc = { kind: 'free', i: i };
      for (c = 0; c < COLS; c++) {
        if (legalIn(S, fsrc, { kind: 'tab', col: c })) out.push({ src: fsrc, dest: { kind: 'tab', col: c } });
      }
      SUITS.forEach(function (k) {
        if (legalIn(S, fsrc, { kind: 'found', s: k })) out.push({ src: fsrc, dest: { kind: 'found', s: k } });
      });
    }
    return out;
  }

  function anyMove() { return boardMoves().length > 0; }

  /* null alive or unknown, 'none' no legal move at all, 'nowhere' the
     moves exist and none of them lead anywhere. */
  function deadEnd() {
    if (S.won) return null;
    if (!anyMove()) return 'none';
    if (anyFoundMove(S)) return null;
    var start = {
      free: S.free.slice(),
      f: { S: S.f.S.slice(), H: S.f.H.slice(), C: S.f.C.slice(), D: S.f.D.slice() },
      t: S.t.map(function (col) { return col.slice(); }),
      moves: S.moves, won: S.won
    };
    start.key = stateKey(start);
    var got = K.reachable(start, shuffles, anyFoundMove, SEARCH_CAP);
    if (got === null) return null;      // out of budget, so say nothing
    return got ? null : 'nowhere';
  }

  /* ---------- when the verdict is paid for ----------
     deadEnd() walks up to six thousand positions, and it ran on every
     single render. Measured over five hundred random moves that cost
     10ms on average and 68ms at worst on a desktop, which on a phone is
     a third of a second of nothing happening after a tap. A move has to
     feel instant, so the paint no longer waits for the search.

     What renders immediately is the part that is cheap and certain,
     which is "no legal move at all". The expensive question, "these
     moves exist but do any of them lead anywhere", is answered just
     after the paint and raises the bar a frame later. A newer board
     cancels an older pending answer, and answers are kept by position
     so walking back and forth over the same board pays once. */
  var deepCache = {};
  var deepKeys = [];
  var deepToken = 0;

  function cheapVerdict() {
    if (S.won) return null;
    if (!anyMove()) return 'none';
    if (anyFoundMove(S)) return null;
    var k = stateKey(S);
    return Object.prototype.hasOwnProperty.call(deepCache, k) ? deepCache[k] : 'pending';
  }

  function rememberDeep(k, v) {
    if (!Object.prototype.hasOwnProperty.call(deepCache, k)) {
      deepKeys.push(k);
      if (deepKeys.length > 200) delete deepCache[deepKeys.shift()];
    }
    deepCache[k] = v;
  }

  function scheduleDeep() {
    var k = stateKey(S);
    var mine = ++deepToken;
    setTimeout(function () {
      if (mine !== deepToken) return;
      var v = deadEnd();
      rememberDeep(k, v);
      if (mine !== deepToken) return;
      paintStuck(v);
      els.hintBtn.disabled = !!v || S.won;
    }, 0);
  }

  /* ============================================================
     THE HINT

     Ordered by what actually helps rather than by what is legal.
     A cell is always available and is almost never the right idea,
     so it comes last and only when there is nothing else.
     ============================================================ */
  function bestMove() {
    var moves = boardMoves();
    if (!moves.length) return null;
    var best = null, bestScore = -1e9;
    moves.forEach(function (m) {
      var ids = srcIds(m.src);
      var score = 0;
      if (m.dest.kind === 'found') {
        score = safeToSend(S, ids[0]) ? 100 : 60;
      } else if (m.dest.kind === 'tab') {
        score = 40 + ids.length * 2;
        // emptying a column outright is worth more than any run length
        if (m.src.kind === 'tab' && m.src.idx === 0 && S.t[m.src.col].length === ids.length) score += 25;
        // landing a run on a real card beats parking it in an empty column
        if (!S.t[m.dest.col].length) score -= 15;
      } else {
        score = 5 - (4 - openCells());
      }
      if (m.src.kind === 'found') score = -50;
      if (score > bestScore) { bestScore = score; best = m; }
    });
    return best;
  }

  function pileKey(x) {
    if (x.kind === 'free') return 'free:' + x.i;
    if (x.kind === 'found') return 'found:' + x.s;
    return 'tab:' + x.col;
  }

  function nameAt(x) {
    if (x.kind === 'free') return 'free cell ' + (x.i + 1);
    if (x.kind === 'found') return C.suit(x.s).name + ' foundation';
    return 'column ' + (x.col + 1);
  }

  function showHint() {
    if (S.won) return;
    var dead = deadEnd();
    if (dead) { paintStuck(dead); return; }
    var m = bestMove();
    if (!m) return;
    var ids = srcIds(m.src);
    hint.show(pileKey(m.src), pileKey(m.dest));
    var what = C.label(K.card(ids[0]));
    if (ids.length > 1) what = what + ' and the ' + (ids.length - 1) + ' under it';
    if (m.dest.kind === 'found') say('Send the ' + what + ' home.');
    else say('Move the ' + what + ' to ' + nameAt(m.dest) + '.');
  }

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  function save() {
    store.write({ seed: S.seed, s: snapshot(), u: undoStack.all() });
  }

  function load() {
    var o = store.read();
    if (!o || !o.s) return false;
    S = { seed: o.seed || 0 };
    try {
      restore(o.s);
    } catch (e) { return false; }
    if (!S.t || S.t.length !== COLS || !S.f || !S.free) return false;
    undoStack.load(o.u);
    return true;
  }

  function newGame(seed) {
    stopAuto();
    if (hint) hint.clear();
    S = freshState(seed != null ? seed : (Date.now() ^ Math.floor(Math.random() * 0xffffff)) >>> 0);
    undoStack.clear();
    sel = null;
    els.winbar.hidden = true;
    render(); save();
  }

  /* ============================================================
     RENDER
     ============================================================ */
  function render() {
    K.sizeBoard(els.board, COLS);

    for (var i = 0; i < CELLS; i++) {
      var host = els.free[i];
      host.innerHTML = '';
      var id = S.free[i];
      if (!id) {
        host.appendChild(C.slot('☆', { label: 'Free cell ' + (i + 1) + ', empty' }));
      } else {
        var fc = C.play(K.card(id));
        fc.dataset.top = '1';
        if (sel && sel.kind === 'free' && sel.i === i) fc.classList.add('sel');
        host.appendChild(fc);
      }
    }

    SUITS.forEach(function (k) {
      var host = els.found[k];
      host.innerHTML = '';
      var pile = S.f[k];
      if (!pile.length) {
        host.appendChild(C.slot(C.suit(k).pip, { label: C.suit(k).name + ' foundation, empty' }));
      } else {
        var node = C.play(K.card(pile[pile.length - 1]));
        node.dataset.top = '1';
        if (sel && sel.kind === 'found' && sel.s === k) node.classList.add('sel');
        host.appendChild(node);
      }
    });

    var boardH = parseInt(getComputedStyle(els.board).getPropertyValue('--ch'), 10);

    /* ---------- how far apart the cards in a column sit ----------
       One step for the whole board, not one per column, or the eight
       columns fan by different amounts and the board looks broken.

       Measured against the SCREEN, never against the board's own
       height. The board's height is a result of the step, so reading
       it here asks a question whose answer depends on the answer, and
       what it did in practice was collapse every column to the minimum
       while two thirds of a phone screen sat empty.

       The floor is about a fifth of a card, which is where the rank in
       the corner stops being readable. If a column is long enough to
       need less than that, the board grows past the fold and the page
       scrolls, which is honest. Lying about how much it can show is
       not. */
    var longest = 1;
    for (var li = 0; li < COLS; li++) longest = Math.max(longest, S.t[li].length);
    var tabTop = els.tab.getBoundingClientRect().top;
    var room = Math.max(240, window.innerHeight - tabTop - 56);
    var step = Math.floor((room - boardH) / Math.max(1, longest - 1));
    /* The ceiling is half a card rather than the third Klondike uses. In
       Klondike the fan only has to show a rank in a corner, because a
       buried card can never be picked up. In FreeCell any card that
       heads a run can, so the exposed strip is a tap target, and on a
       phone a 20px strip is not one. Half a card is as far as it goes
       before short columns start wasting the screen. */
    step = Math.min(Math.round(boardH * 0.5), step);
    step = Math.max(Math.round(boardH * 0.19), step);

    for (var c = 0; c < COLS; c++) {
      var col = els.cols[c];
      col.innerHTML = '';
      var pile = S.t[c];
      if (!pile.length) {
        col.appendChild(C.slot('', { label: 'Column ' + (c + 1) + ', empty' }));
        col.style.height = '';
        continue;
      }
      for (var j = 0; j < pile.length; j++) {
        var node = C.play(K.card(pile[j]));
        node.style.top = (j * step) + 'px';
        node.dataset.idx = String(j);
        if (j === pile.length - 1) node.dataset.top = '1';
        if (sel && sel.kind === 'tab' && sel.col === c && j >= sel.idx) node.classList.add('sel');
        if (!runFrom(c, j)) node.classList.add('stuckcard');
        col.appendChild(node);
      }
      col.style.height = ((pile.length - 1) * step + boardH) + 'px';
    }

    els.moves.textContent = String(S.moves);
    els.cells.textContent = String(openCells());
    var home = 0;
    SUITS.forEach(function (k) { home += S.f[k].length; });
    els.home.textContent = String(home);

    els.undoBtn.disabled = undoStack.depth() === 0;
    els.autoBtn.hidden = !autoAvailable();

    var dead = cheapVerdict();
    if (dead === 'pending') {
      deepToken++;                 /* whatever was pending described an older board */
      paintStuck(null);
      els.hintBtn.disabled = S.won;
      scheduleDeep();
    } else {
      deepToken++;
      paintStuck(dead);
      els.hintBtn.disabled = !!dead || S.won;
    }
  }

  /* Paint the verdict without waiting a frame for it. Only the test hook
     and the Hint button use this, because both are answering a question
     somebody asked out loud and can afford the search. */
  function renderSettled() {
    render();
    deepToken++;
    var v = deadEnd();
    rememberDeep(stateKey(S), v);
    paintStuck(v);
    els.hintBtn.disabled = !!v || S.won;
  }

  function paintStuck(dead) {
    if (!dead) { els.stuckbar.hidden = true; return; }
    els.stuckbar.hidden = false;
    if (dead === 'none') {
      els.stuckTitle.textContent = 'No moves left';
      els.stuckWhy.textContent = 'Every cell is full and nothing will sit anywhere. Walk a few moves back, or take a fresh deal.';
      say('No moves left.');
    } else {
      els.stuckTitle.textContent = 'Nothing left that goes anywhere';
      els.stuckWhy.textContent = 'You can still shuffle cards about, but nothing can reach a foundation from here. That is the deal, not your play.';
      say('Nothing left that goes anywhere.');
    }
  }

  /* ============================================================
     INPUT
     ============================================================ */
  function infoFrom(target) {
    var pileEl = target.closest ? target.closest('[data-pile]') : null;
    if (!pileEl) return null;
    var key = pileEl.dataset.pile;
    var cardEl = target.closest('.hpc');
    var out = { pileEl: pileEl, cardEl: cardEl };
    if (key.indexOf('free:') === 0) { out.kind = 'free'; out.i = parseInt(key.slice(5), 10); }
    else if (key.indexOf('found:') === 0) { out.kind = 'found'; out.s = key.slice(6); }
    else if (key.indexOf('tab:') === 0) {
      out.kind = 'tab';
      out.col = parseInt(key.slice(4), 10);
      out.idx = cardEl && cardEl.dataset.idx != null ? parseInt(cardEl.dataset.idx, 10) : -1;
    }
    return out;
  }

  function srcFromInfo(info) {
    if (!info) return null;
    if (info.kind === 'free' && S.free[info.i]) return { kind: 'free', i: info.i };
    if (info.kind === 'found' && S.f[info.s].length) return { kind: 'found', s: info.s };
    if (info.kind === 'tab' && info.idx >= 0 && runFrom(info.col, info.idx)) {
      return { kind: 'tab', col: info.col, idx: info.idx };
    }
    return null;
  }

  function destFromInfo(info) {
    if (!info) return null;
    if (info.kind === 'tab') return { kind: 'tab', col: info.col };
    if (info.kind === 'found') return { kind: 'found', s: info.s };
    if (info.kind === 'free') return { kind: 'free', i: info.i };
    return null;
  }

  function topCardId(src) {
    var ids = srcIds(src);
    return ids ? ids[0] : null;
  }

  function handleTap(info) {
    if (!info || S.won) return;
    var src = srcFromInfo(info);
    var dest = destFromInfo(info);

    if (src) {
      var id = topCardId(src);
      var now = Date.now();
      var same = (info.cardEl && info.cardEl.dataset.card === id);
      if (same && lastTap.id === id && now - lastTap.at < 450) {
        lastTap = { id: null, at: 0 };
        sel = null;
        if (sendHome(src)) { render(); save(); return; }
        render(); return;
      }
      if (same) lastTap = { id: id, at: now };
    }

    if (sel && dest) {
      if (sel.kind === 'tab' && dest.kind === 'tab' && sel.col === dest.col) { sel = null; render(); return; }
      if (apply(sel, dest)) { sel = null; render(); save(); return; }
      /* A run that will not travel is the single most confusing thing in
         FreeCell, so it says the arithmetic out loud rather than just
         refusing. */
      var ids = srcIds(sel);
      if (ids && ids.length > 1 && dest.kind === 'tab' && canStack(ids[0], dest.col)) {
        var n = maxMove(dest.col);
        say('That run is ' + ids.length + ' cards and you can only move ' + n +
            ' right now. Free a cell or empty a column.');
        render(); return;
      }
    }

    if (!src) { sel = null; render(); return; }

    if (sel && sel.kind === src.kind && sel.col === src.col && sel.idx === src.idx &&
        sel.s === src.s && sel.i === src.i) {
      sel = null;
    } else {
      sel = src;
      var picked = srcIds(src);
      say(C.label(K.card(picked[0])) + (picked.length > 1 ? ' and ' + (picked.length - 1) + ' more' : '') + ' picked up');
    }
    render();
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function boot() {
    els.board = document.getElementById('board');
    els.free = [];
    for (var i = 0; i < CELLS; i++) els.free.push(document.querySelector('[data-pile="free:' + i + '"]'));
    els.found = {};
    SUITS.forEach(function (k) { els.found[k] = document.querySelector('[data-pile="found:' + k + '"]'); });
    els.tab = document.getElementById('tableau');
    els.cols = [];
    for (var c = 0; c < COLS; c++) els.cols.push(document.querySelector('[data-pile="tab:' + c + '"]'));
    els.dragLayer = document.getElementById('draglayer');
    els.live = document.getElementById('live');
    els.moves = document.getElementById('moves');
    els.cells = document.getElementById('cells');
    els.home = document.getElementById('home');
    els.newBtn = document.getElementById('newBtn');
    els.undoBtn = document.getElementById('undoBtn');
    els.hintBtn = document.getElementById('hintBtn');
    els.autoBtn = document.getElementById('autoBtn');
    els.winbar = document.getElementById('winbar');
    els.winNew = document.getElementById('winNew');
    els.stuckbar = document.getElementById('stuckbar');
    els.stuckTitle = document.getElementById('stuckTitle');
    els.stuckWhy = document.getElementById('stuckWhy');
    els.stuckNew = document.getElementById('stuckNew');
    els.stuckUndo = document.getElementById('stuckUndo');

    say = K.Speaker(els.live);
    hint = K.Hint(els.board);

    if (!load()) newGame();
    else { els.winbar.hidden = !S.won; render(); }

    K.Table({
      board: els.board,
      layer: els.dragLayer,
      frozen: function () { return S.won; },
      onDown: function (e) {
        stopAuto();
        var info = infoFrom(e.target);
        if (!info) return null;
        var src = srcFromInfo(info);
        return {
          tap: info, src: src,
          ids: src ? srcIds(src) : null,
          rect: info.cardEl ? info.cardEl.getBoundingClientRect() : null
        };
      },
      destOf: function (el, d) {
        var dest = destFromInfo(infoFrom(el));
        if (!dest) return null;
        return legalIn(S, d.src, dest) ? dest : null;
      },
      hostFor: function (dest) {
        if (dest.kind === 'free') return els.free[dest.i];
        if (dest.kind === 'found') return els.found[dest.s];
        return els.cols[dest.col];
      },
      onDrop: function (d, dest) {
        var moved = dest ? apply(d.src, dest) : false;
        if (moved) { sel = null; render(); save(); }
        else render();
      },
      onTap: function (info) { handleTap(info); }
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
    els.autoBtn.addEventListener('click', function () { autoFinish(false); });
    els.winNew.addEventListener('click', function () { newGame(); });
    els.stuckNew.addEventListener('click', function () { newGame(); say('New game dealt.'); });
    els.stuckUndo.addEventListener('click', function () { if (undo()) { render(); save(); say('Move undone.'); } });

    /* ---------- racing ----------
       The whole feature rests on something that was already here for
       the tests: this game deals the same board twice from the same
       seed. race.js never looks at a card, it only asks for a deal and
       for one number saying how far along we are. */
    race = window.HPRace.create({
      game: 'freecell',
      total: 52,
      label: 'cards home',
      variant: function () { return 0; },
      deal: function (seed, variant) { newGame(seed); },
      progress: function () {
        return {
          main: (function () { var n = 0; SUITS.forEach(function (k) { n += S.f[k].length; }); return n; })(),
          moves: S.moves,
          done: !!S.won,
          /* Exactly what the player can see, rather than running the
             dead-end search again on the race's account. */
          stuck: !!(els.stuckbar && !els.stuckbar.hidden)
        };
      },
      say: say,
      onResize: render,
      els: {
        toggle: document.getElementById('raceBtn'),
        panel: document.getElementById('racepanel'),
        start: document.getElementById('raceStart'),
        host: document.getElementById('raceHostRow'),
        join: document.getElementById('raceJoinRow'),
        live: document.getElementById('raceLive'),
        status: document.getElementById('raceStatus'),
        code: document.getElementById('raceCode'),
        codeIn: document.getElementById('raceCodeIn'),
        hostBtn: document.getElementById('raceHostBtn'),
        joinShowBtn: document.getElementById('raceJoinShow'),
        joinBtn: document.getElementById('raceJoinBtn'),
        copyBtn: document.getElementById('raceCopy'),
        hostCancel: document.getElementById('raceHostCancel'),
        joinCancel: document.getElementById('raceJoinCancel'),
        leaveBtn: document.getElementById('raceLeave'),
        againBtn: document.getElementById('raceAgain'),
        strip: document.getElementById('racestrip')
      }
    });

    /* Every board change already goes through render, so the race reads
       it there instead of being remembered at forty call sites. */
    var baseRender = render;
    render = function () { baseRender(); if (race) race.tick(); };

    /* ---------- playing without a pointer ----------
       This adds a way to POINT, not a way to play. The game already
       works by tapping a card and then tapping where it goes, so the
       keyboard hands that same handler whatever it is pointing at,
       parsed by the game's own parser. Nothing about the rules is
       written twice. */
    keys = window.HPKeys.attach({
      board: els.board,
      say: say,
      activate: function (key, idx, pileEl, cardEl) {
        handleTap(infoFrom(cardEl || pileEl));
      },
      cancel: function () { sel = null; render(); },
      shortcuts: {
        n: function () { newGame(); say('New game dealt.'); },
        u: function () { if (undo()) { render(); save(); say('Move undone.'); } },
        h: function () { showHint(); },
        r: function () { document.getElementById('raceBtn').click(); },
        a: function () { if (!els.autoBtn.hidden) autoFinish(false); },
      },
      helpBtn: document.getElementById('keysBtn'),
      help: [
        { keys: ['Arrow keys'], what: 'Move around the board. Up and down walk the cards inside a column before leaving it' },
        { keys: ['Enter', 'Space'], what: 'Pick a card up, or put down what you are holding. The same thing a tap does' },
        { keys: ['Esc'], what: 'Put down what you are holding' },
        { keys: ['Home', 'End'], what: 'Jump to the first or last pile in the row' },
        { keys: ['N'], what: 'New game' },
        { keys: ['U'], what: 'Undo' },
        { keys: ['H'], what: 'Hint' },
        { keys: ['R'], what: 'Race a friend' },
        { keys: ['A'], what: 'Finish the deal when everything can go home' },
        { keys: ['?'], what: 'This list' }
      ]
    });

    /* The ring has to be redrawn whenever the board is, or it points at
       a card that has moved. */
    var beforeKeys = render;
    render = function () { beforeKeys(); if (keys) keys.repaint(); };

    var rt = null;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(render, 120); });
  }

  /* The test hooks. Everything the suite needs and nothing that lets a
     player cheat without meaning to, because forcing a state is only
     reachable from a console. */
  window.HPFreeCell = {
    get state() { return S; },
    deal: function (seed) { newGame(seed); },
    forceState: function (o) {
      if (o.free) S.free = o.free.slice();
      if (o.f) SUITS.forEach(function (k) { if (o.f[k]) S.f[k] = o.f[k].slice(); });
      if (o.t) S.t = o.t.map(function (col) { return col.slice(); });
      S.won = false;
      els.winbar.hidden = true;
      undoStack.clear();
      sel = null;
      checkWin();
      renderSettled(); save();
    },
    move: function (src, dest) { var r = apply(src, dest); if (r) { render(); save(); } return r; },
    undo: function () { var r = undo(); if (r) { render(); save(); } return r; },
    boardMoves: boardMoves,
    anyMove: anyMove,
    deadEnd: deadEnd,
    bestMove: bestMove,
    maxMove: maxMove,
    openCells: openCells,
    emptyCols: emptyCols,
    runFrom: runFrom,
    safeToSend: function (id) { return safeToSend(S, id); },
    autoAvailable: autoAvailable,
    autoFinish: autoFinish,
    clearSave: function () { store.clear(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
