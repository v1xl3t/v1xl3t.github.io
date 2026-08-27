/* ============================================================
   Klondike solitaire for HACKING PARADISE.

   Vanilla, no framework, no CDN, no build step. Draws its cards
   from hp-cards.js so the game and the member pages share one
   deck.

   Two input models, both always live, because this has to work on
   a phone and on a desktop without a mode switch:

     drag and drop   pointer events, so mouse and touch run the
                     same code path
     tap to tap      tap a card to pick it up, tap a pile to put
                     it down. A second tap on the same card sends
                     it to its foundation if it can go.

   Undo is snapshot based rather than an inverse move log. Fifty
   two cards is small enough that a snapshot costs nothing, and a
   snapshot cannot drift out of sync with the board the way an
   inverse log can.

   The whole game, including the undo stack, is written to
   localStorage after every change, so a reload puts you back
   exactly where you were.
   ============================================================ */
(function () {
  'use strict';

  var C = window.HPCards;
  var KEY = 'hp-solitaire-v1';
  var SUITS = ['S', 'H', 'C', 'D'];
  var UNDO_MAX = 80;

  /* ---------- card helpers ---------- */
  function suitOf(id) { return id.charAt(0); }
  function rankOf(id) { return id.slice(1); }
  function valOf(id) { return C.rank(rankOf(id)).v; }
  function isRed(id) { return C.suit(suitOf(id)).red; }
  function card(id) { return { id: id, s: suitOf(id), r: rankOf(id), v: valOf(id) }; }

  /* ---------- state ---------- */
  var S = null;
  var undoStack = [];
  var sel = null;          // {kind, col, idx, s} plus .ids
  var lastTap = { id: null, at: 0 };
  var autoTimer = null;

  function freshState(draw, seed) {
    var rng = C.rngFrom(seed);
    var d = C.shuffle(C.deck().map(function (c) { return c.id; }), rng);
    var st = {
      v: 1, draw: draw, seed: seed,
      stock: [], waste: [], f: { S: [], H: [], C: [], D: [] },
      t: [[], [], [], [], [], [], []],
      moves: 0, won: false
    };
    for (var col = 0; col < 7; col++) {
      for (var k = 0; k <= col; k++) {
        st.t[col].push({ i: d.pop(), u: k === col });
      }
    }
    st.stock = d;   // whatever is left, end of the array is the top
    return st;
  }

  function snapshot() { return JSON.stringify({ stock: S.stock, waste: S.waste, f: S.f, t: S.t, moves: S.moves, won: S.won }); }
  function restore(json) {
    var o = JSON.parse(json);
    S.stock = o.stock; S.waste = o.waste; S.f = o.f; S.t = o.t; S.moves = o.moves; S.won = o.won;
  }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }

  /* ---------- rules ----------
     Every rule takes the board it is judging as its first argument, so the
     game and the "is this deal finished" analysis can never drift apart. The
     short wrappers underneath each one ask about the board being played, which
     is what the rest of the file wants nearly every time. */
  function canFoundOn(B, id, suitKey) {
    if (suitOf(id) !== suitKey) return false;
    return valOf(id) === B.f[suitKey].length + 1;
  }
  function foundationForIn(B, id) {
    return canFoundOn(B, id, suitOf(id)) ? suitOf(id) : null;
  }
  function canStackOn(B, id, col) {
    var pile = B.t[col];
    if (!pile.length) return valOf(id) === 13;          // only a king opens an empty column
    var top = pile[pile.length - 1];
    if (!top.u) return false;
    return valOf(top.i) === valOf(id) + 1 && isRed(top.i) !== isRed(id);
  }

  /* The face-up run a player can pick up from a tableau index. Face-up runs are
     always valid by construction, but validate anyway. A corrupt save should
     refuse to be picked up rather than teleport cards. */
  function runFromIn(B, col, idx) {
    var pile = B.t[col];
    if (idx < 0 || idx >= pile.length || !pile[idx].u) return null;
    var ids = [pile[idx].i];
    for (var k = idx + 1; k < pile.length; k++) {
      var prev = pile[k - 1], cur = pile[k];
      if (!cur.u) return null;
      if (valOf(prev.i) !== valOf(cur.i) + 1 || isRed(prev.i) === isRed(cur.i)) return null;
      ids.push(cur.i);
    }
    return ids;
  }

  function canFound(id, suitKey) { return canFoundOn(S, id, suitKey); }
  function foundationFor(id) { return foundationForIn(S, id); }
  function canStack(id, col) { return canStackOn(S, id, col); }
  function runFrom(col, idx) { return runFromIn(S, col, idx); }

  /* ---------- moves ---------- */
  function flipIfNeeded(col) {
    var pile = S.t[col];
    if (pile.length && !pile[pile.length - 1].u) pile[pile.length - 1].u = true;
  }

  function drawStock() {
    pushUndo();
    clearHint();
    if (!S.stock.length) {
      if (!S.waste.length) { undoStack.pop(); return false; }
      // recycle: the waste goes back under the stock in the order it came out
      while (S.waste.length) S.stock.push(S.waste.pop());
      S.moves++;
      return true;
    }
    var n = Math.min(S.draw, S.stock.length);
    for (var k = 0; k < n; k++) S.waste.push(S.stock.pop());
    S.moves++;
    return true;
  }

  /* src describes where the cards come from. dest describes where they go.
     Returns true when the board changed. */
  function apply(src, dest) {
    var ids = srcIds(src);
    if (!ids || !ids.length) return false;

    if (dest.kind === 'found') {
      if (ids.length !== 1 || !canFound(ids[0], dest.s)) return false;
    } else if (dest.kind === 'tab') {
      if (!canStack(ids[0], dest.col)) return false;
      if (src.kind === 'tab' && src.col === dest.col) return false;
    } else return false;

    pushUndo();
    clearHint();   // the board is about to change, a stale arrow points at nothing
    // take
    if (src.kind === 'waste') S.waste.pop();
    else if (src.kind === 'found') S.f[src.s].pop();
    else { S.t[src.col].length = src.idx; flipIfNeeded(src.col); }
    // give
    if (dest.kind === 'found') S.f[dest.s].push(ids[0]);
    else ids.forEach(function (id) { S.t[dest.col].push({ i: id, u: true }); });

    S.moves++;
    checkWin();
    return true;
  }

  function srcIds(src) {
    if (src.kind === 'waste') return S.waste.length ? [S.waste[S.waste.length - 1]] : null;
    if (src.kind === 'found') return S.f[src.s].length ? [S.f[src.s][S.f[src.s].length - 1]] : null;
    if (src.kind === 'tab') return runFrom(src.col, src.idx);
    return null;
  }

  function checkWin() {
    S.won = SUITS.every(function (k) { return S.f[k].length === 13; });
    return S.won;
  }

  /* Send a single card to a foundation if one will take it. Used by the second
     tap and by auto finish. */
  function sendToFoundation(src) {
    var ids = srcIds(src);
    if (!ids || ids.length !== 1) return false;
    var f = foundationFor(ids[0]);
    if (!f) return false;
    return apply(src, { kind: 'found', s: f });
  }

  /* Auto finish is offered once nothing is face down in the tableau, which is
     the point where the rest of the game is bookkeeping rather than decisions. */
  function autoAvailable() {
    if (S.won) return false;
    for (var c = 0; c < 7; c++) {
      for (var k = 0; k < S.t[c].length; k++) if (!S.t[c][k].u) return false;
    }
    return oneAutoMove(true);
  }

  function oneAutoMove(dryRun) {
    for (var c = 0; c < 7; c++) {
      var pile = S.t[c];
      if (!pile.length) continue;
      var top = pile[pile.length - 1];
      if (!top.u) continue;
      if (foundationFor(top.i)) {
        if (dryRun) return true;
        return apply({ kind: 'tab', col: c, idx: pile.length - 1 }, { kind: 'found', s: suitOf(top.i) });
      }
    }
    if (S.waste.length) {
      var w = S.waste[S.waste.length - 1];
      if (foundationFor(w)) {
        if (dryRun) return true;
        return apply({ kind: 'waste' }, { kind: 'found', s: suitOf(w) });
      }
    }
    if (S.stock.length || S.waste.length) {
      // nothing on top is playable, but the stock may still hold something
      for (var i = 0; i < S.stock.length; i++) if (foundationFor(S.stock[i])) { if (dryRun) return true; drawStock(); return true; }
      for (var j = 0; j < S.waste.length - 1; j++) if (foundationFor(S.waste[j])) { if (dryRun) return true; drawStock(); return true; }
    }
    return false;
  }

  /* The guard is not paranoia. When the only playable card is buried in the
     waste, the auto mover deals to reach it, and with draw three a card can be
     stepped over on every pass. Without a cap that is an infinite loop. */
  function autoFinish(instant) {
    stopAuto();
    if (instant) {
      var guard = 0;
      while (!S.won && oneAutoMove(false) && guard++ < 400) { /* keep going */ }
      render(); save();
      return;
    }
    var steps = 0;
    autoTimer = setInterval(function () {
      if (S.won || steps++ > 400 || !oneAutoMove(false)) { stopAuto(); render(); save(); return; }
      render(); save();
      if (S.won) { stopAuto(); }
    }, 55);
  }
  function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

  function undo() {
    stopAuto();
    clearHint();
    if (!undoStack.length) return false;
    restore(undoStack.pop());
    sel = null;
    return true;
  }

  /* ============================================================
     WHAT IS STILL ON THE TABLE

     Two questions share one enumeration. "Is anything left" decides
     whether the game is actually over, and "what would you do"
     answers the hint. Building the list once keeps the two answers
     from ever disagreeing, which is the failure that would matter,
     a game calling itself dead while the hint points at a move.

     "Are there legal moves" turns out to be the wrong question, which
     Vi's board on 2026-08-13 proved. It had exactly one move, a six
     of diamonds that could slide onto a seven of spades and back
     again, forever, while nothing turned over and nothing went home.
     Legal, endless, and finished. Counting that as alive would mean
     the game never admits a dead deal.

     So the question asked here is "can this deal still get anywhere",
     and the only two things that count as getting anywhere are a card
     turning face up and a card reaching a foundation. Shuffling
     between columns is not an answer, it is a step, so the shuffles
     get walked to see whether any sequence of them reaches one.

     One legal move is left out of the enumeration entirely, a
     foundation card pulled back down into the tableau. It can always
     be undone and redone, so it would make every search infinite
     while adding nothing a player wants suggested.

     Nothing here mutates the board being played. The walk works on
     copies, so the hint cannot cost you a card.
     ============================================================ */

  /* gain is the ranking, not the rules. Higher is a better hint.
     Turning a face down card over beats everything else, because that
     is the only move that adds information to the board. */
  function movesIn(B) {
    var out = [];
    var c, d, i, pile, ids;

    if (B.waste.length) {
      var w = B.waste[B.waste.length - 1];
      var wf = foundationForIn(B, w);
      if (wf) out.push({ src: { kind: 'waste' }, dest: { kind: 'found', s: wf }, gain: 80 });
      for (c = 0; c < 7; c++) {
        if (canStackOn(B, w, c)) out.push({ src: { kind: 'waste' }, dest: { kind: 'tab', col: c }, gain: 60 });
      }
    }

    for (c = 0; c < 7; c++) {
      pile = B.t[c];
      if (!pile.length) continue;

      var top = pile[pile.length - 1];
      if (top.u) {
        var tf = foundationForIn(B, top.i);
        // sending the last card of a column home opens the column, which is worth more
        if (tf) out.push({
          src: { kind: 'tab', col: c, idx: pile.length - 1 },
          dest: { kind: 'found', s: tf },
          gain: pile.length === 1 ? 85 : 75
        });
      }

      for (i = 0; i < pile.length; i++) {
        if (!pile[i].u) continue;
        ids = runFromIn(B, c, i);
        if (!ids) continue;
        var flips = i > 0 && !pile[i - 1].u;   // moving this run turns a card over
        var wholePile = i === 0;               // nothing underneath, the column empties
        for (d = 0; d < 7; d++) {
          if (d === c || !canStackOn(B, ids[0], d)) continue;
          if (wholePile && !B.t[d].length) continue;   // one empty column into another
          out.push({
            src: { kind: 'tab', col: c, idx: i },
            dest: { kind: 'tab', col: d },
            gain: flips ? 100 : (wholePile ? 55 : 40)
          });
        }
      }
    }
    return out;
  }

  /* Walk the deck the way a player would, one deal at a time, and ask after
     each deal whether the card now showing has anywhere to go. Draw three only
     ever shows every third card, and turning the pile over is what changes
     which third, so simulating the deals is more honest than arithmetic. The
     copies mean the real stock never moves. */
  function deckMoveIn(B) {
    var stock = B.stock.slice(), waste = B.waste.slice();
    var total = stock.length + waste.length;
    if (!total) return false;

    // one full lap is every deal plus the turn over, and two laps covers a
    // starting waste that is mid pass
    var laps = 2 * (Math.ceil(total / Math.max(1, B.draw)) + 2);
    for (var step = 0; step < laps; step++) {
      if (!stock.length) {
        if (!waste.length) return false;
        while (waste.length) stock.push(waste.pop());
      } else {
        var n = Math.min(B.draw, stock.length);
        for (var k = 0; k < n; k++) waste.push(stock.pop());
      }
      if (!waste.length) continue;
      var top = waste[waste.length - 1];
      if (foundationForIn(B, top)) return true;
      for (var c = 0; c < 7; c++) if (canStackOn(B, top, c)) return true;
    }
    return false;
  }

  /* The two things that count as the deal getting somewhere. Note that the
     flipping move is only ever the run starting at a column's first face up
     card, because that is the only run with anything hidden underneath it. */
  function hasProgress(B) {
    var c, pile, i;
    if (B.waste.length && foundationForIn(B, B.waste[B.waste.length - 1])) return true;
    for (c = 0; c < 7; c++) {
      pile = B.t[c];
      if (!pile.length) continue;
      var top = pile[pile.length - 1];
      if (top.u && foundationForIn(B, top.i)) return true;
      for (i = 0; i < pile.length && !pile[i].u; i++) { /* find the first face up card */ }
      if (i === 0 || i >= pile.length) continue;      // nothing hidden under this column
      var ids = runFromIn(B, c, i);
      if (!ids) continue;
      for (var d = 0; d < 7; d++) if (d !== c && canStackOn(B, ids[0], d)) return true;
    }
    return false;
  }

  /* Only the tableau changes during the walk, so the key only has to describe
     the tableau. The deck and the foundations are the same in every state the
     walk can reach. */
  function tabKey(B) {
    var s = '';
    for (var c = 0; c < 7; c++) {
      var p = B.t[c];
      for (var k = 0; k < p.length; k++) s += (p[k].u ? '' : '#') + p[k].i;
      s += '|';
    }
    return s;
  }

  function withTableau(B) {
    return {
      stock: B.stock, waste: B.waste, f: B.f, draw: B.draw,
      t: B.t.map(function (col) { return col.map(function (x) { return { i: x.i, u: x.u }; }); })
    };
  }

  /* Depth first over column-to-column shuffles, looking for any state where
     something finally turns over or goes home. The visited set is what keeps
     the six of diamonds from sliding back and forth forever, and the node cap
     is the backstop. Hitting the cap reports "no", which is the safe direction
     to be wrong in, because the bar it raises has an undo button on it and the
     board underneath is still playable. */
  var WALK_CAP = 4000;

  function progressReachable(B) {
    var seen = Object.create(null);
    var stack = [B];
    var nodes = 0;
    while (stack.length && nodes++ < WALK_CAP) {
      var cur = stack.pop();
      var key = tabKey(cur);
      if (seen[key]) continue;
      seen[key] = true;

      if (hasProgress(cur) || deckMoveIn(cur)) return true;

      var list = movesIn(cur);
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.src.kind !== 'tab' || m.dest.kind !== 'tab') continue;
        var nxt = withTableau(cur);
        var from = nxt.t[m.src.col];
        var ids = from.slice(m.src.idx).map(function (x) { return x.i; });
        from.length = m.src.idx;
        if (from.length && !from[from.length - 1].u) from[from.length - 1].u = true;
        for (var j = 0; j < ids.length; j++) nxt.t[m.dest.col].push({ i: ids[j], u: true });
        stack.push(nxt);
      }
    }
    return false;
  }

  function boardMoves() { return movesIn(S); }
  function deckMove() { return deckMoveIn(S); }

  /* null while the deal is alive, otherwise how it died. The two are told
     apart on the page because they feel different to a player, one is a wall
     and the other is a treadmill. */
  function deadEnd() {
    if (S.won) return null;
    var moves = boardMoves().length;
    if (!moves && !deckMove()) return 'none';
    return progressReachable(S) ? null : 'nowhere';
  }

  function anyMove() { return !S.won && deadEnd() === null; }

  function bestMove() {
    var list = boardMoves();
    if (!list.length) return null;
    list.sort(function (a, b) { return b.gain - a.gain; });
    return list[0];
  }

  /* ---------- the hint ----------
     A hint points, it does not play. It lights the pile a card comes from and
     the pile it can go to, says the same thing out loud for a screen reader,
     and fades on its own so the board does not stay decorated. */
  var hint = null;          // {src:'tab:2', dst:'found:H'}
  var hintTimer = null;

  function pileKey(x) {
    if (x.kind === 'waste') return 'waste';
    if (x.kind === 'stock') return 'stock';
    if (x.kind === 'found') return 'found:' + x.s;
    if (x.kind === 'tab') return 'tab:' + x.col;
    return null;
  }

  function nameAt(src) {
    var ids = srcIds(src);
    return ids && ids.length ? C.label(card(ids[0])) : 'that card';
  }

  function hintWords(m) {
    var who = nameAt(m.src);
    if (m.dest.kind === 'found') return 'Send the ' + who + ' home to its foundation.';
    if (!S.t[m.dest.col].length) return 'Move the ' + who + ' into the empty column.';
    var dp = S.t[m.dest.col];
    return 'Move the ' + who + ' onto the ' + C.label(card(dp[dp.length - 1].i)) + '.';
  }

  function clearHint() {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    hint = null;
  }

  function showHint() {
    stopAuto();
    clearHint();
    var m = bestMove();
    if (m) {
      hint = { src: pileKey(m.src), dst: pileKey(m.dest) };
      say(hintWords(m));
    } else if (deckMove()) {
      hint = { src: 'stock', dst: 'stock' };
      say('Deal from the deck, something in there can be played.');
    } else {
      say('No moves left. Undo, or deal a new game.');
    }
    render();
    hintTimer = setTimeout(function () { hintTimer = null; hint = null; render(); }, 4200);
  }

  /* ---------- persistence ---------- */
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: 1, draw: S.draw, seed: S.seed, s: snapshot(), u: undoStack }));
    } catch (e) { /* private mode or full, the game still plays */ }
  }
  function load() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      var o = JSON.parse(raw);
      if (!o || o.v !== 1 || !o.s) return false;
      S = { v: 1, draw: o.draw === 3 ? 3 : 1, seed: o.seed || 0 };
      restore(o.s);
      undoStack = Array.isArray(o.u) ? o.u.slice(-UNDO_MAX) : [];
      // a save written by a broken run should not brick the page
      if (!S.t || S.t.length !== 7 || !S.f) return false;
      return true;
    } catch (e) { return false; }
  }

  function newGame(draw, seed) {
    stopAuto();
    clearHint();
    S = freshState(draw != null ? draw : (S ? S.draw : 1),
                   seed != null ? seed : (Date.now() ^ Math.floor(Math.random() * 0xffffff)) >>> 0);
    undoStack = [];
    sel = null;
    render(); save();
  }

  /* ============================================================
     RENDER
     ============================================================ */
  var els = {};
  var race = null;

  function pileHost(kind, key) {
    var d = document.createElement('div');
    d.className = 'pile ' + kind;
    d.dataset.pile = key;
    return d;
  }

  function sizeBoard() {
    var board = els.board;
    var w = board.clientWidth;
    var gap = Math.max(4, Math.min(10, Math.round(w * 0.014)));
    var cw = Math.floor((w - gap * 6) / 7);
    cw = Math.max(38, Math.min(104, cw));
    var ch = Math.round(cw * 1.4);
    board.style.setProperty('--cw', cw + 'px');
    board.style.setProperty('--ch', ch + 'px');
    board.style.setProperty('--gap', gap + 'px');
    board.style.setProperty('--fan', Math.round(cw * 0.3) + 'px');
    return { cw: cw, ch: ch, gap: gap };
  }

  function render() {
    var size = sizeBoard();
    var ch = size.ch;

    /* --- stock --- */
    els.stock.innerHTML = '';
    els.stock.classList.toggle('dead', !S.stock.length && !S.waste.length);
    if (S.stock.length) {
      var b = C.back({ label: 'Stock, ' + S.stock.length + ' cards left. Tap to deal.' });
      els.stock.appendChild(b);
    } else {
      els.stock.appendChild(C.slot(S.waste.length ? '↻' : '☆', {
        label: S.waste.length ? 'Stock is empty. Tap to turn the waste over.' : 'Stock and waste are both empty.'
      }));
    }

    /* --- waste, fanning the last three so a draw of three reads --- */
    els.waste.innerHTML = '';
    if (!S.waste.length) {
      els.waste.appendChild(C.slot('', { label: 'Waste is empty' }));
    } else {
      var showN = Math.min(S.draw === 3 ? 3 : 1, S.waste.length);
      var start = S.waste.length - showN;
      for (var wi = start; wi < S.waste.length; wi++) {
        var wc = C.play(card(S.waste[wi]));
        wc.style.left = ((wi - start) * parseInt(getComputedStyle(els.board).getPropertyValue('--fan'), 10)) + 'px';
        wc.style.zIndex = String(wi - start + 1);
        if (wi === S.waste.length - 1) {
          wc.dataset.top = '1';
          if (sel && sel.kind === 'waste') wc.classList.add('sel');
        }
        els.waste.appendChild(wc);
      }
    }

    /* --- foundations --- */
    SUITS.forEach(function (k) {
      var host = els.found[k];
      host.innerHTML = '';
      var pile = S.f[k];
      if (!pile.length) {
        host.appendChild(C.slot(C.suit(k).pip, { label: C.suit(k).name + ' foundation, empty' }));
      } else {
        var fc = C.play(card(pile[pile.length - 1]));
        if (sel && sel.kind === 'found' && sel.s === k) fc.classList.add('sel');
        host.appendChild(fc);
      }
    });

    /* --- tableau --- */
    var laneTop = els.tab.getBoundingClientRect().top;
    var avail = Math.max(200, window.innerHeight - laneTop - 20);
    for (var col = 0; col < 7; col++) {
      var host = els.cols[col];
      host.innerHTML = '';
      var pile = S.t[col];
      if (!pile.length) {
        var slot = C.slot('', { label: 'Empty column ' + (col + 1) + ', only a king can go here' });
        host.appendChild(slot);
        host.style.height = ch + 'px';
        continue;
      }
      var down = 0, up = 0;
      pile.forEach(function (e) { e.u ? up++ : down++; });
      var prefDown = ch * 0.13, prefUp = ch * 0.28;
      var span = down * prefDown + Math.max(0, up - 1) * prefUp;
      var k = 1;
      if (span + ch > avail && span > 0) k = Math.max(0.5, (avail - ch) / span);
      var stepDown = prefDown * k, stepUp = prefUp * k;

      var y = 0;
      for (var j = 0; j < pile.length; j++) {
        var e = pile[j];
        var node = e.u ? C.play(card(e.i)) : C.back();
        node.dataset.idx = String(j);
        node.style.top = Math.round(y) + 'px';
        node.style.zIndex = String(j + 1);
        if (sel && sel.kind === 'tab' && sel.col === col && j >= sel.idx) node.classList.add('sel');
        host.appendChild(node);
        y += (j === pile.length - 1) ? 0 : (e.u ? stepUp : stepDown);
      }
      host.style.height = Math.round(y + ch) + 'px';
    }

    /* --- the hint lights piles, so it has to be wiped every paint --- */
    els.board.querySelectorAll('.hint-src, .hint-dst').forEach(function (n) {
      n.classList.remove('hint-src', 'hint-dst');
    });
    if (hint) {
      var hs = els.board.querySelector('[data-pile="' + hint.src + '"]');
      var hd = els.board.querySelector('[data-pile="' + hint.dst + '"]');
      if (hs) hs.classList.add('hint-src');
      if (hd && hd !== hs) hd.classList.add('hint-dst');
    }

    /* --- chrome --- */
    var dead = deadEnd();
    els.moves.textContent = String(S.moves);
    els.left.textContent = String(S.stock.length + S.waste.length);
    els.undoBtn.disabled = !undoStack.length;
    els.hintBtn.disabled = S.won || !!dead;
    els.autoBtn.hidden = !autoAvailable();
    els.win.hidden = !S.won;
    els.stuck.hidden = !dead;
    els.stuckUndo.disabled = !undoStack.length;
    els.d1.setAttribute('aria-pressed', String(S.draw === 1));
    els.d3.setAttribute('aria-pressed', String(S.draw === 3));
    if (dead) {
      els.stuckTitle.textContent = DEAD[dead].title;
      els.stuckWhy.textContent = DEAD[dead].why;
    }
    if (S.won) say('You cleared the board in ' + S.moves + ' moves.');
    else if (dead) say(DEAD[dead].title + '. ' + DEAD[dead].why);
  }

  /* Two ways a deal ends short, and they do not feel the same. One is a wall,
     you try things and nothing is legal. The other is a treadmill, moves keep
     working and the board never actually changes. The second is the one that
     makes a player doubt themselves, so it gets said plainly. */
  var DEAD = {
    none: {
      title: 'No moves left',
      why: 'Nothing on the board is legal any more, and the deck is out. The deal is finished, not you.'
    },
    nowhere: {
      title: 'Nothing left that goes anywhere',
      why: 'Cards can still slide between columns, but no matter which order you do it in, nothing new turns over and nothing else reaches a foundation. This deal is done. That is the deal, not your play.'
    }
  };

  var lastSaid = '';
  function say(msg) {
    if (msg === lastSaid) return;
    lastSaid = msg;
    els.live.textContent = msg;
  }

  /* ============================================================
     INPUT
     ============================================================ */
  function infoFrom(target) {
    var pileEl = target.closest('[data-pile]');
    if (!pileEl) return null;
    var key = pileEl.dataset.pile;
    var cardEl = target.closest('.hpc');
    var out = { pileEl: pileEl, cardEl: cardEl };
    if (key === 'stock') out.kind = 'stock';
    else if (key === 'waste') { out.kind = 'waste'; out.isTop = !!(cardEl && cardEl.dataset.top); }
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
    if (info.kind === 'waste' && info.isTop) return { kind: 'waste' };
    if (info.kind === 'found' && S.f[info.s].length) return { kind: 'found', s: info.s };
    if (info.kind === 'tab' && info.idx >= 0) {
      var e = S.t[info.col][info.idx];
      if (e && e.u && runFrom(info.col, info.idx)) return { kind: 'tab', col: info.col, idx: info.idx };
    }
    return null;
  }

  function destFromInfo(info) {
    if (!info) return null;
    if (info.kind === 'tab') return { kind: 'tab', col: info.col };
    if (info.kind === 'found') return { kind: 'found', s: info.s };
    return null;
  }

  function topCardId(src) {
    var ids = srcIds(src);
    return ids ? ids[0] : null;
  }

  function handleTap(info) {
    if (!info || S.won) return;

    if (info.kind === 'stock') {
      sel = null;
      if (drawStock()) { render(); save(); }
      return;
    }

    var src = srcFromInfo(info);
    var dest = destFromInfo(info);

    // a second tap on the same card sends it up if it can go
    if (src) {
      var id = topCardId(src);
      var now = Date.now();
      var isSameCard = (info.cardEl && info.cardEl.dataset.card === id);
      if (isSameCard && lastTap.id === id && now - lastTap.at < 450) {
        lastTap = { id: null, at: 0 };
        sel = null;
        if (sendToFoundation(src)) { render(); save(); }
        return;
      }
      if (isSameCard) lastTap = { id: id, at: now };
    }

    // holding something already, try to put it down here
    if (sel && dest) {
      if (sel.kind === 'tab' && dest.kind === 'tab' && sel.col === dest.col) { sel = null; render(); return; }
      if (apply(sel, dest)) { sel = null; render(); save(); return; }
    }

    if (!src) { sel = null; render(); return; }

    // tapping the thing you are already holding puts it back down
    if (sel && sel.kind === src.kind && sel.col === src.col && sel.idx === src.idx && sel.s === src.s) {
      sel = null;
    } else {
      sel = src;
      say(C.label(card(topCardId(src))) + ' picked up');
    }
    render();
  }

  /* ---------- drag ---------- */
  var drag = null;

  function startDrag(src, e, rect) {
    var ids = srcIds(src);
    if (!ids) return;
    var board = els.board;
    var cw = parseInt(getComputedStyle(board).getPropertyValue('--cw'), 10);
    var chh = parseInt(getComputedStyle(board).getPropertyValue('--ch'), 10);
    els.dragLayer.style.setProperty('--dcw', cw + 'px');
    els.dragLayer.style.setProperty('--dch', chh + 'px');
    els.dragLayer.innerHTML = '';
    var step = Math.round(chh * 0.28);
    ids.forEach(function (id, i) {
      var n = C.play(card(id));
      n.style.top = (i * step) + 'px';
      n.style.left = '0px';
      n.style.zIndex = String(i + 1);
      els.dragLayer.appendChild(n);
    });
    drag = {
      src: src, ids: ids,
      dx: e.clientX - rect.left, dy: e.clientY - rect.top,
      hover: null
    };
    els.dragLayer.hidden = false;
    moveGhost(e);
    document.body.classList.add('dragging');
  }

  function moveGhost(e) {
    var x = e.clientX - drag.dx, y = e.clientY - drag.dy;
    var kids = els.dragLayer.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].style.transform = 'translate(' + x + 'px,' + y + 'px)';
    }
  }

  /* Takes the drag explicitly rather than reading the module level one. It used
     to read the module level `drag`, and endDrag nulls that before asking for a
     destination, so every single drop threw and silently did nothing while the
     highlight during the drag looked perfect. */
  function hoverTarget(e, d) {
    if (!d) return null;
    var wasHidden = els.dragLayer.hidden;
    els.dragLayer.hidden = true;
    var under = document.elementFromPoint(e.clientX, e.clientY);
    els.dragLayer.hidden = wasHidden;
    if (!under || !under.closest) return null;
    var dest = destFromInfo(infoFrom(under));
    if (!dest) return null;
    if (dest.kind === 'found') return d.ids.length === 1 && canFound(d.ids[0], dest.s) ? dest : null;
    if (dest.kind === 'tab') {
      if (d.src.kind === 'tab' && d.src.col === dest.col) return null;
      return canStack(d.ids[0], dest.col) ? dest : null;
    }
    return null;
  }

  function paintHover(dest) {
    els.board.querySelectorAll('.hpc.drop').forEach(function (n) { n.classList.remove('drop'); });
    if (!dest) return;
    var host = dest.kind === 'found' ? els.found[dest.s] : els.cols[dest.col];
    var last = host.lastElementChild;
    if (last) last.classList.add('drop');
  }

  function endDrag(e, commit) {
    var d = drag; drag = null;
    var moved = false;
    // ask where it landed BEFORE tearing the ghost down, so the answer and the
    // teardown cannot get tangled up with each other
    var dest = (d && commit) ? hoverTarget(e, d) : null;
    document.body.classList.remove('dragging');
    els.dragLayer.hidden = true;
    els.dragLayer.innerHTML = '';
    if (!d) return false;
    if (dest) moved = apply(d.src, dest);
    paintHover(null);
    if (moved) { sel = null; render(); save(); }
    else render();
    return moved;
  }

  function bind() {
    var down = null;

    els.board.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      if (S.won) return;
      stopAuto();
      var info = infoFrom(e.target);
      if (!info) return;
      var src = srcFromInfo(info);
      down = {
        x: e.clientX, y: e.clientY, info: info, src: src,
        rect: info.cardEl ? info.cardEl.getBoundingClientRect() : null,
        id: e.pointerId
      };
      if (src && info.cardEl) {
        // capture so a fast drag that leaves the card still reaches us
        try { els.board.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
    });

    els.board.addEventListener('pointermove', function (e) {
      if (!down || e.pointerId !== down.id) return;
      if (!drag) {
        var dist = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
        if (dist < 7 || !down.src || !down.rect) return;
        startDrag(down.src, e, down.rect);
      }
      e.preventDefault();
      moveGhost(e);
      var t = hoverTarget(e, drag);
      if (t !== drag.hover) { drag.hover = t; paintHover(t); }
    });

    function up(e) {
      if (!down || e.pointerId !== down.id) return;
      var d = down; down = null;
      try { els.board.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (drag) { endDrag(e, true); return; }
      handleTap(d.info);
    }
    els.board.addEventListener('pointerup', up);
    els.board.addEventListener('pointercancel', function (e) {
      if (!down || e.pointerId !== down.id) return;
      down = null;
      if (drag) endDrag(e, false);
    });

    /* There is deliberately no dblclick listener. Pointer events already fire
       for a mouse, so the second tap path covers double click too, and running
       both meant the dblclick handler acted on an index the first handler had
       already moved a card out of. That silently moved the wrong card. */

    // keyboard: escape drops whatever is held
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sel) { sel = null; render(); }
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (undo()) { render(); save(); }
      }
    });

    els.newBtn.addEventListener('click', function () { newGame(S.draw); say('New game dealt.'); });
    els.undoBtn.addEventListener('click', function () { if (undo()) { render(); save(); say('Move undone.'); } });
    els.hintBtn.addEventListener('click', showHint);
    els.autoBtn.addEventListener('click', function () { autoFinish(false); });
    els.d1.addEventListener('click', function () { setDraw(1); });
    els.d3.addEventListener('click', function () { setDraw(3); });
    els.winNew.addEventListener('click', function () { newGame(S.draw); });
    els.stuckNew.addEventListener('click', function () { newGame(S.draw); say('New game dealt.'); });
    els.stuckUndo.addEventListener('click', function () { if (undo()) { render(); save(); say('Move undone.'); } });

    /* ---------- racing ----------
       The whole feature rests on something that was already here for
       the tests: this game deals the same board twice from the same
       seed. race.js never looks at a card, it only asks for a deal and
       for one number saying how far along we are. */
    race = window.HPRace.create({
      game: 'klondike',
      total: 52,
      label: 'cards home',
      variant: function () { return S.draw; },
      deal: function (seed, variant) { newGame(variant === 3 ? 3 : 1, seed); },
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

    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(render, 120);
    });
  }

  /* Changing the draw count mid game would let a player rewind a dead deal for
     free, so it starts a new one. Saying so out loud beats a silent surprise. */
  function setDraw(n) {
    if (S.draw === n) return;
    var fresh = S.moves === 0;
    if (!fresh && !window.confirm('Switching to draw ' + n + ' starts a new game. Carry on?')) return;
    newGame(n);
    say('Draw ' + n + '. New game dealt.');
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function boot() {
    els.board = document.getElementById('board');
    els.stock = document.querySelector('[data-pile="stock"]');
    els.waste = document.querySelector('[data-pile="waste"]');
    els.tab = document.getElementById('tableau');
    els.found = {};
    SUITS.forEach(function (k) { els.found[k] = document.querySelector('[data-pile="found:' + k + '"]'); });
    els.cols = [];
    for (var i = 0; i < 7; i++) els.cols.push(document.querySelector('[data-pile="tab:' + i + '"]'));
    els.dragLayer = document.getElementById('draglayer');
    els.moves = document.getElementById('moves');
    els.left = document.getElementById('left');
    els.undoBtn = document.getElementById('undoBtn');
    els.hintBtn = document.getElementById('hintBtn');
    els.autoBtn = document.getElementById('autoBtn');
    els.newBtn = document.getElementById('newBtn');
    els.d1 = document.getElementById('draw1');
    els.d3 = document.getElementById('draw3');
    els.win = document.getElementById('winbar');
    els.winNew = document.getElementById('winNew');
    els.stuck = document.getElementById('stuckbar');
    els.stuckTitle = document.getElementById('stuckTitle');
    els.stuckWhy = document.getElementById('stuckWhy');
    els.stuckNew = document.getElementById('stuckNew');
    els.stuckUndo = document.getElementById('stuckUndo');
    els.live = document.getElementById('live');

    if (!load()) newGame(1);
    else render();
    bind();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* A small surface for the test harness. Everything here is also reachable by
     hand, this just spares the suite from synthesising twenty gestures to prove
     one rule. */
  window.HPSolitaire = {
    get state() { return S; },
    newGame: newGame,
    deal: function (seed, draw) { newGame(draw || 1, seed); },
    draw: function () { if (drawStock()) { render(); save(); } },
    undo: function () { if (undo()) { render(); save(); return true; } return false; },
    undoDepth: function () { return undoStack.length; },
    autoFinish: autoFinish,
    autoAvailable: autoAvailable,
    anyMove: anyMove,
    deadEnd: deadEnd,
    boardMoves: boardMoves,
    deckMove: deckMove,
    bestMove: bestMove,
    hint: function () { showHint(); return hint; },
    move: function (src, dest) { var r = apply(src, dest); if (r) { render(); save(); } return r; },
    sendToFoundation: function (src) { var r = sendToFoundation(src); if (r) { render(); save(); } return r; },
    /* Stack the deck so a test can reach a win in a bounded number of steps
       without playing a real game. Not reachable from the UI. */
    forceState: function (o) {
      pushUndo();
      if (o.stock) S.stock = o.stock;
      if (o.waste) S.waste = o.waste;
      if (o.f) S.f = o.f;
      if (o.t) S.t = o.t;
      checkWin(); render(); save();
    },
    clearSave: function () { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } },
    KEY: KEY
  };
})();
