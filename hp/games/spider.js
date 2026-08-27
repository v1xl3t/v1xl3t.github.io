/* ============================================================
   Spider for HACKING PARADISE.

   The big one. Two decks, a hundred and four cards, ten columns,
   and eight sequences to build from the king down to the ace.

   Three things here that no other game on this table has, and all
   three are why it is the last of the solitaires to be built:

     two decks       so a card id is NOT unique any more. There are
                     two aces of spades. Nothing in this file may
                     look a card up by its id, everything is
                     addressed by column and index. Klondike and
                     FreeCell both take the shortcut this cannot.

     face down       a run only ever starts at a card you can see,
                     and turning one over is the thing that counts
                     as progress. Golf has no hidden cards and
                     FreeCell has none by design.

     the deal        ten cards at once, straight onto the columns,
                     with no way back. It is the only move in any
                     of these games that makes the board strictly
                     worse before it makes it better, and the rule
                     that no column may be empty when you take one
                     is the whole reason Spider is hard.

   Suits are a difficulty dial, not a theme. One suit is a puzzle
   you can learn, four is a fight. Two is where most people live.
   ============================================================ */
(function () {
  'use strict';

  var C = window.HPCards;
  var K = window.HPSolCore;
  var COLS = 10;
  var SETS = 8;               /* eight king to ace runs make a hundred and four */
  var SEQ = 13;

  /* The thirteen ranks in order, taken from the shared deck rather
     than written out again, so a change there cannot leave this file
     behind. */
  var RANKS = C.deck().filter(function (c) { return c.s === 'S'; }).map(function (c) { return c.r; });

  var store = K.Store('hp-spider-v1', 1);
  var undoStack = K.Undo(80);
  var S = null;
  var sel = null;
  var els = {};
  var race = null;
  var say = function () {};
  var hint = null;

  /* ============================================================
     STATE
     ============================================================ */

  /* One suit is eight sets of spades, two is four and four, four is
     two of each. The count of cards never changes, only how many
     ways they can refuse to go together. */
  function suitPlan(suits) {
    if (suits === 1) return ['S', 'S', 'S', 'S', 'S', 'S', 'S', 'S'];
    if (suits === 2) return ['S', 'H', 'S', 'H', 'S', 'H', 'S', 'H'];
    return ['S', 'H', 'C', 'D', 'S', 'H', 'C', 'D'];
  }

  function buildDeck(seed, suits) {
    var out = [];
    suitPlan(suits).forEach(function (s) {
      RANKS.forEach(function (r) { out.push(s + r); });
    });
    return C.shuffle(out, C.rngFrom(seed));
  }

  function freshState(seed, suits) {
    var deck = buildDeck(seed, suits);
    var t = [];
    for (var c = 0; c < COLS; c++) {
      var n = c < 4 ? 6 : 5;          /* fifty four dealt, fifty held back */
      var col = [];
      for (var j = 0; j < n; j++) col.push({ i: deck.pop(), u: j === n - 1 });
      t.push(col);
    }
    return {
      seed: seed, suits: suits,
      stock: deck,                     /* fifty, dealt ten at a time */
      t: t,
      done: [],                        /* the suit letter of each finished run */
      moves: 0,
      won: false
    };
  }

  function snapshot() {
    return {
      stock: S.stock.slice(),
      t: S.t.map(function (col) { return col.map(function (e) { return { i: e.i, u: e.u }; }); }),
      done: S.done.slice(),
      moves: S.moves,
      won: S.won
    };
  }

  function restore(o) {
    S.stock = o.stock.slice();
    S.t = o.t.map(function (col) { return col.map(function (e) { return { i: e.i, u: e.u }; }); });
    S.done = o.done.slice();
    S.moves = o.moves;
    S.won = !!o.won;
  }

  /* ============================================================
     RULES

     Everything takes the board it judges rather than reading the
     live one, so the game and the analysis that decides whether a
     deal is finished share one rulebook and cannot drift.
     ============================================================ */

  /* Anything may sit on an empty column, and otherwise only a card
     one rank below whatever is showing. Suit does NOT matter here.
     Suit matters for whether cards travel together, which is a
     different question and the one people get wrong about Spider. */
  function canStackIn(B, id, col) {
    var pile = B.t[col];
    if (!pile.length) return true;
    var top = pile[pile.length - 1];
    if (!top.u) return false;
    return K.valOf(id) === K.valOf(top.i) - 1;
  }

  /* A run travels only if every card in it is face up, of the same
     suit, and descending one at a time. */
  function runFromIn(B, col, idx) {
    var pile = B.t[col];
    if (idx < 0 || idx >= pile.length) return null;
    if (!pile[idx].u) return null;
    for (var i = idx; i < pile.length - 1; i++) {
      var a = pile[i], b = pile[i + 1];
      if (!b.u) return null;
      if (K.suitOf(a.i) !== K.suitOf(b.i)) return null;
      if (K.valOf(b.i) !== K.valOf(a.i) - 1) return null;
    }
    return pile.slice(idx).map(function (e) { return e.i; });
  }

  function emptyColsIn(B) {
    var n = 0;
    for (var i = 0; i < COLS; i++) if (!B.t[i].length) n++;
    return n;
  }

  /* Ten cards at once, one onto every column, and none of them may be
     the card that lands on nothing. A column left empty when the deal
     comes is the single most expensive mistake in Spider, so the rule
     that forbids it is enforced rather than merely discouraged. */
  function canDealIn(B) {
    return B.stock.length >= COLS && emptyColsIn(B) === 0;
  }

  function canStack(id, col) { return canStackIn(S, id, col); }
  function runFrom(col, idx) { return runFromIn(S, col, idx); }
  function canDeal() { return canDealIn(S); }
  function emptyCols() { return emptyColsIn(S); }

  /* ============================================================
     MOVES
     ============================================================ */
  function legalIn(B, src, dest) {
    if (!src || !dest) return false;
    if (src.col === dest.col) return false;
    var ids = runFromIn(B, src.col, src.idx);
    if (!ids || !ids.length) return false;
    return canStackIn(B, ids[0], dest.col);
  }

  /* Turn the card a move uncovered. Doing this inside the move rather
     than in the render is deliberate: the flip is part of the position,
     not part of the picture, and an undo has to be able to put it back
     face down. */
  function flipIn(B, col) {
    var pile = B.t[col];
    if (pile.length && !pile[pile.length - 1].u) {
      pile[pile.length - 1].u = true;
      return true;
    }
    return false;
  }

  /* A king down to an ace, all one suit, sitting at the bottom of a
     column, leaves the board for good. */
  function harvestIn(B, col) {
    var pile = B.t[col];
    if (pile.length < SEQ) return null;
    var start = pile.length - SEQ;
    var run = runFromIn(B, col, start);
    if (!run) return null;
    if (K.valOf(run[0]) !== SEQ) return null;      /* has to start at the king */
    var suit = K.suitOf(run[0]);
    pile.length = start;
    B.done.push(suit);
    flipIn(B, col);
    return suit;
  }

  function applyIn(B, src, dest) {
    if (!legalIn(B, src, dest)) return false;
    var ids = runFromIn(B, src.col, src.idx);
    B.t[src.col].length = src.idx;
    ids.forEach(function (id) { B.t[dest.col].push({ i: id, u: true }); });
    flipIn(B, src.col);
    harvestIn(B, dest.col);
    return true;
  }

  function dealIn(B) {
    if (!canDealIn(B)) return false;
    for (var c = 0; c < COLS; c++) {
      B.t[c].push({ i: B.stock.pop(), u: true });
    }
    /* A deal can finish a run outright, and it would be a strange game
       that left one sitting there because nobody moved a card onto it. */
    for (var d = 0; d < COLS; d++) harvestIn(B, d);
    return true;
  }

  function checkWin() {
    if (S.done.length === SETS && !S.won) {
      S.won = true;
      els.winbar.hidden = false;
      say('All eight runs finished. Cleared.');
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

  function deal() {
    if (S.won || !canDeal()) return false;
    undoStack.push(snapshot());
    dealIn(S);
    S.moves++;
    hint.clear();
    checkWin();
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
     WHAT IS LEGAL, AND WHAT IS WORTH DOING

     boardMoves lists every legal move. It is deliberately not the
     same list as the one the hint reads, because in Spider most
     legal moves are worthless and a few are the game.
     ============================================================ */
  function movesIn(B) {
    var out = [];
    for (var c = 0; c < COLS; c++) {
      var pile = B.t[c];
      for (var idx = 0; idx < pile.length; idx++) {
        if (!runFromIn(B, c, idx)) continue;
        for (var d = 0; d < COLS; d++) {
          if (d === c) continue;
          /* Every empty column is worth the same, so only the first is
             offered. Without this a board with three empties reports
             three identical moves and the hint has to pick between
             them for no reason. */
          if (!B.t[d].length && emptyColsIn(B) > 1 && d !== firstEmptyIn(B)) continue;
          if (legalIn(B, { col: c, idx: idx }, { col: d })) {
            out.push({ src: { col: c, idx: idx }, dest: { col: d } });
          }
        }
      }
    }
    return out;
  }

  function firstEmptyIn(B) {
    for (var i = 0; i < COLS; i++) if (!B.t[i].length) return i;
    return -1;
  }

  function boardMoves() { return movesIn(S); }
  function anyMove() { return boardMoves().length > 0 || canDeal(); }

  /* ============================================================
     IS THIS DEAL FINISHED

     Getting somewhere in Spider means a face down card turns over or
     a run comes off the board. Sliding face up cards between columns
     is a step.

     While the stock still has cards there is always something left to
     try, so the question only becomes interesting once it is out.

     The cap is read the FreeCell way, not the Klondike way. Ten
     columns of face up cards is an enormous space and a healthy late
     game will blow past any sane budget, so running out means unknown
     and the game says nothing. See the note in sol-core.
     ============================================================ */
  var SEARCH_CAP = 6000;

  function stateKey(B) {
    return B.t.map(function (col) {
      return col.map(function (e) { return e.u ? e.i : '#'; }).join('');
    }).join('|');
  }

  function progressIn(B) {
    /* A run already sitting complete counts, and so does any move that
       would uncover a face down card. */
    for (var c = 0; c < COLS; c++) {
      var pile = B.t[c];
      if (pile.length >= SEQ) {
        var run = runFromIn(B, c, pile.length - SEQ);
        if (run && K.valOf(run[0]) === SEQ) return true;
      }
    }
    var ms = movesIn(B);
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      var col = B.t[m.src.col];
      /* moving from index 0 empties the column, which is progress in
         itself. Otherwise the card under the run has to be face down. */
      if (m.src.idx === 0) return true;
      if (!col[m.src.idx - 1].u) return true;
    }
    return false;
  }

  function cloneOf(B) {
    return {
      stock: B.stock.slice(),
      t: B.t.map(function (col) { return col.map(function (e) { return { i: e.i, u: e.u }; }); }),
      done: B.done.slice(), moves: B.moves, won: B.won
    };
  }

  /* Only the moves that rearrange. A move that flips or harvests is
     the thing being searched for, not a step on the way to it. */
  function shuffles(B) {
    var out = [];
    movesIn(B).forEach(function (m) {
      var col = B.t[m.src.col];
      if (m.src.idx === 0) return;
      if (!col[m.src.idx - 1].u) return;
      var n = cloneOf(B);
      if (!applyIn(n, m.src, m.dest)) return;
      n.key = stateKey(n);
      out.push(n);
    });
    return out;
  }

  function deadEnd() {
    if (S.won) return null;
    if (!anyMove()) return 'none';
    if (canDeal()) return null;
    if (progressIn(S)) return null;
    var start = cloneOf(S);
    start.key = stateKey(start);
    var got = K.reachable(start, shuffles, progressIn, SEARCH_CAP);
    if (got === null) return null;        /* out of budget, so say nothing */
    return got ? null : 'nowhere';
  }

  /* ---------- the deferred verdict ----------
     Same reason as FreeCell. The search is expensive and a move has to
     feel instant, so the paint takes the cheap certain answer and the
     expensive one lands a frame later. */
  var deepCache = {};
  var deepKeys = [];
  var deepToken = 0;

  function cheapVerdict() {
    if (S.won) return null;
    if (!anyMove()) return 'none';
    if (canDeal()) return null;
    if (progressIn(S)) return null;
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

     Ordered by what Spider actually rewards. Finishing a run beats
     everything. Turning a card over beats any tidying. Emptying a
     column beats joining two cards of the same suit, and joining
     the same suit beats any other legal move, because a move that
     mixes suits is usually a move you will have to undo by hand.
     ============================================================ */
  function scoreMove(m) {
    var pile = S.t[m.src.col];
    var ids = runFrom(m.src.col, m.src.idx);
    var head = ids[0];
    var score = 0;

    /* would it finish a run outright */
    var n = cloneOf(S);
    var before = n.done.length;
    applyIn(n, m.src, m.dest);
    if (n.done.length > before) return 1000;

    if (m.src.idx === 0) score += 120;                 /* empties the column */
    else if (!pile[m.src.idx - 1].u) score += 200;     /* turns a card over */

    var destPile = S.t[m.dest.col];
    if (destPile.length) {
      var landing = destPile[destPile.length - 1].i;
      if (K.suitOf(landing) === K.suitOf(head)) score += 60;   /* joins the suit */
      else score -= 20;
    } else {
      score -= 10;      /* an empty column is a resource, spending it costs */
    }
    score += ids.length;
    return score;
  }

  function bestMove() {
    var moves = boardMoves();
    if (!moves.length) return canDeal() ? { kind: 'deal' } : null;
    var best = null, bestScore = -1e9;
    moves.forEach(function (m) {
      var sc = scoreMove(m);
      if (sc > bestScore) { bestScore = sc; best = m; }
    });
    /* Nothing on the board is worth doing and there are cards left, so
       say so rather than suggesting a shuffle that helps nobody. */
    if (bestScore < 0 && canDeal()) return { kind: 'deal' };
    return { kind: 'move', src: best.src, dest: best.dest };
  }

  function showHint() {
    if (S.won) return;
    var dead = deadEnd();
    if (dead) { paintStuck(dead); return; }
    var m = bestMove();
    if (!m) return;
    if (m.kind === 'deal') {
      hint.show('stock', 'stock');
      say('Nothing on the board is worth moving. Deal another row.');
      return;
    }
    hint.show('tab:' + m.src.col, 'tab:' + m.dest.col);
    var ids = runFrom(m.src.col, m.src.idx);
    var what = C.label(K.card(ids[0]));
    if (ids.length > 1) what = what + ' and the ' + (ids.length - 1) + ' under it';
    say('Move the ' + what + ' to column ' + (m.dest.col + 1) + '.');
  }

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  function save() { store.write({ seed: S.seed, suits: S.suits, s: snapshot(), u: undoStack.all() }); }

  function load() {
    var o = store.read();
    if (!o || !o.s) return false;
    S = { seed: o.seed || 0, suits: o.suits === 1 || o.suits === 2 ? o.suits : 4 };
    try { restore(o.s); } catch (e) { return false; }
    if (!S.t || S.t.length !== COLS || !S.done) return false;
    undoStack.load(o.u);
    return true;
  }

  function newGame(suits, seed) {
    hint && hint.clear();
    S = freshState(seed != null ? seed : (Date.now() ^ Math.floor(Math.random() * 0xffffff)) >>> 0,
      suits != null ? suits : (S ? S.suits : 1));
    undoStack.clear();
    sel = null;
    els.winbar.hidden = true;
    render(); save();
  }

  /* The suit count is the difficulty, so changing it mid deal would be
     changing which game you were losing. It starts a new one. */
  function setSuits(n) {
    if (S.suits === n) return;
    if (S.moves > 0 && !window.confirm(
      'Switching to ' + n + ' suit' + (n === 1 ? '' : 's') + ' starts a new game. Carry on?')) return;
    newGame(n);
    say(n + ' suit' + (n === 1 ? '' : 's') + '. New game dealt.');
  }

  /* ============================================================
     RENDER
     ============================================================ */
  function render() {
    K.sizeBoard(els.board, COLS);
    var ch = parseInt(getComputedStyle(els.board).getPropertyValue('--ch'), 10);

    els.stock.innerHTML = '';
    var rows = Math.floor(S.stock.length / COLS);
    els.stock.classList.toggle('dead', !S.stock.length);
    if (S.stock.length) {
      els.stock.appendChild(C.back({
        label: rows + ' row' + (rows === 1 ? '' : 's') + ' left to deal. Tap to deal one.'
      }));
    } else {
      els.stock.appendChild(C.slot('☆', { label: 'Nothing left to deal.' }));
    }
    els.stock.classList.toggle('blocked', S.stock.length > 0 && !canDeal());

    /* Eight markers, not eight piles. They were card sized slots and
       they read as columns you could drop a run onto, which is a
       control that silently does nothing, and a run dropped there
       would just spring back with no explanation. A finished run
       leaves the board for good, so the only honest thing to draw is
       a tally. */
    els.donerow.innerHTML = '';
    for (var f = 0; f < SETS; f++) {
      var suit = S.done[f];
      var chip = document.createElement('span');
      chip.className = 'run' + (suit ? ' won' : '');
      chip.textContent = suit ? C.suit(suit).pip : '·';
      chip.setAttribute('role', 'img');
      chip.setAttribute('aria-label', suit
        ? C.suit(suit).name + ' run finished'
        : 'Run ' + (f + 1) + ', not finished');
      if (suit) chip.dataset.suit = suit;
      els.donerow.appendChild(chip);
    }

    var tabTop = els.tab.getBoundingClientRect().top;
    var longest = 1;
    for (var li = 0; li < COLS; li++) longest = Math.max(longest, S.t[li].length);
    var room = Math.max(240, window.innerHeight - tabTop - 56);
    var step = Math.floor((room - ch) / Math.max(1, longest - 1));
    step = Math.min(Math.round(ch * 0.34), step);
    step = Math.max(Math.round(ch * 0.17), step);
    /* A face down card shows less, because there is nothing on it worth
       showing and the space is better spent on the cards you can read. */
    var downStep = Math.max(6, Math.round(step * 0.55));

    for (var c = 0; c < COLS; c++) {
      var host = els.cols[c];
      host.innerHTML = '';
      var pile = S.t[c];
      if (!pile.length) {
        host.appendChild(C.slot('', { label: 'Column ' + (c + 1) + ', empty' }));
        host.style.height = '';
        continue;
      }
      var y = 0;
      for (var j = 0; j < pile.length; j++) {
        var e = pile[j];
        var node = e.u ? C.play(K.card(e.i)) : C.back({ label: 'Face down' });
        node.style.top = y + 'px';
        node.dataset.idx = String(j);
        if (j === pile.length - 1) node.dataset.top = '1';
        if (sel && sel.col === c && j >= sel.idx) node.classList.add('sel');
        if (e.u && !runFrom(c, j)) node.classList.add('stuckcard');
        host.appendChild(node);
        y += (j + 1 < pile.length && !pile[j].u) ? downStep : step;
      }
      host.style.height = (y - (pile.length ? (pile[pile.length - 1].u ? step : downStep) : 0) + ch) + 'px';
    }

    els.moves.textContent = String(S.moves);
    els.runs.textContent = String(S.done.length);
    els.rows.textContent = String(rows);
    els.undoBtn.disabled = undoStack.depth() === 0;
    [1, 2, 4].forEach(function (n) {
      els.suitBtn[n].setAttribute('aria-pressed', String(S.suits === n));
    });

    var dead = cheapVerdict();
    deepToken++;
    if (dead === 'pending') {
      paintStuck(null);
      els.hintBtn.disabled = S.won;
      scheduleDeep();
    } else {
      paintStuck(dead);
      els.hintBtn.disabled = !!dead || S.won;
    }
  }

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
      els.stuckWhy.textContent = 'Nothing on the board will go anywhere and there is no row left to deal. ' +
        S.done.length + ' of eight runs finished. Walk a few moves back, or take a fresh deal.';
      say('No moves left.');
    } else {
      els.stuckTitle.textContent = 'Nothing left that goes anywhere';
      els.stuckWhy.textContent = 'You can still slide cards about, but nothing will turn a card over or finish a run from here. ' +
        'That is the deal, not your play.';
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
    var out = { cardEl: target.closest('.hpc') };
    if (key === 'stock') out.kind = 'stock';
    else if (key.indexOf('tab:') === 0) {
      out.kind = 'tab';
      out.col = parseInt(key.slice(4), 10);
      out.idx = out.cardEl && out.cardEl.dataset.idx != null ? parseInt(out.cardEl.dataset.idx, 10) : -1;
    }
    return out;
  }

  function srcFromInfo(info) {
    if (!info || info.kind !== 'tab' || info.idx < 0) return null;
    return runFrom(info.col, info.idx) ? { col: info.col, idx: info.idx } : null;
  }

  function handleTap(info) {
    if (!info || S.won) return;

    if (info.kind === 'stock') {
      sel = null;
      if (deal()) { render(); save(); return; }
      if (!S.stock.length) say('There is nothing left to deal.');
      else say('Every column has to have a card in it before you can deal. Fill the empty ' +
        (emptyCols() === 1 ? 'one' : 'ones') + ' first.');
      render();
      return;
    }

    var src = srcFromInfo(info);
    var dest = info.kind === 'tab' ? { col: info.col } : null;

    if (sel && dest) {
      if (sel.col === dest.col) { sel = null; render(); return; }
      if (apply(sel, dest)) { sel = null; render(); save(); return; }
      var held = runFrom(sel.col, sel.idx);
      if (held) {
        say('The ' + C.label(K.card(held[0])) + ' will not sit there.');
      }
    }

    if (!src) {
      if (info.kind === 'tab' && S.t[info.col].length && info.idx >= 0) {
        var e = S.t[info.col][info.idx];
        say(e.u
          ? 'Those cards are not all one suit in order, so they cannot travel together.'
          : 'That card is face down.');
      }
      sel = null; render(); return;
    }

    if (sel && sel.col === src.col && sel.idx === src.idx) sel = null;
    else {
      sel = src;
      var ids = runFrom(src.col, src.idx);
      say(C.label(K.card(ids[0])) + (ids.length > 1 ? ' and ' + (ids.length - 1) + ' more' : '') + ' picked up');
    }
    render();
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function boot() {
    els.board = document.getElementById('board');
    els.stock = document.querySelector('[data-pile="stock"]');
    els.donerow = document.getElementById('donerow');
    els.tab = document.getElementById('tableau');
    els.cols = [];
    for (var c = 0; c < COLS; c++) els.cols.push(document.querySelector('[data-pile="tab:' + c + '"]'));
    els.dragLayer = document.getElementById('draglayer');
    els.live = document.getElementById('live');
    els.moves = document.getElementById('moves');
    els.runs = document.getElementById('runs');
    els.rows = document.getElementById('rows');
    els.newBtn = document.getElementById('newBtn');
    els.undoBtn = document.getElementById('undoBtn');
    els.hintBtn = document.getElementById('hintBtn');
    els.dealBtn = document.getElementById('dealBtn');
    els.suitBtn = { 1: document.getElementById('suit1'), 2: document.getElementById('suit2'), 4: document.getElementById('suit4') };
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
        var info = infoFrom(e.target);
        if (!info) return null;
        var src = srcFromInfo(info);
        return {
          tap: info, src: src,
          ids: src ? runFrom(src.col, src.idx) : null,
          rect: info.cardEl ? info.cardEl.getBoundingClientRect() : null
        };
      },
      destOf: function (el, d) {
        var info = infoFrom(el);
        if (!info || info.kind !== 'tab' || !d.src) return null;
        return legalIn(S, d.src, { col: info.col }) ? { col: info.col } : null;
      },
      hostFor: function (dest) { return els.cols[dest.col]; },
      onDrop: function (d, dest) {
        var moved = dest ? apply(d.src, dest) : false;
        if (moved) { sel = null; render(); save(); }
        else render();
      },
      onTap: handleTap
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
    els.dealBtn.addEventListener('click', function () { handleTap({ kind: 'stock' }); });
    [1, 2, 4].forEach(function (n) {
      els.suitBtn[n].addEventListener('click', function () { setSuits(n); });
    });
    els.winNew.addEventListener('click', function () { newGame(); });
    els.stuckNew.addEventListener('click', function () { newGame(); say('New game dealt.'); });
    els.stuckUndo.addEventListener('click', function () { if (undo()) { render(); save(); say('Move undone.'); } });

    /* ---------- racing ----------
       The whole feature rests on something that was already here for
       the tests: this game deals the same board twice from the same
       seed. race.js never looks at a card, it only asks for a deal and
       for one number saying how far along we are. */
    race = window.HPRace.create({
      game: 'spider',
      total: 8,
      label: 'runs finished',
      variant: function () { return S.suits; },
      deal: function (seed, variant) { newGame(variant, seed); },
      progress: function () {
        return {
          main: (function () { return S.done.length; })(),
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
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(render, 120); });
  }

  window.HPSpider = {
    get state() { return S; },
    deal: function (seed, suits) { newGame(suits, seed); },
    forceState: function (o) {
      if (o.stock) S.stock = o.stock.slice();
      if (o.t) S.t = o.t.map(function (col) { return col.map(function (e) { return { i: e.i, u: e.u }; }); });
      if (o.done) S.done = o.done.slice();
      if (o.suits) S.suits = o.suits;
      S.won = false;
      els.winbar.hidden = true;
      undoStack.clear();
      sel = null;
      checkWin();
      renderSettled(); save();
    },
    move: function (src, dest) { var r = apply(src, dest); if (r) { render(); save(); } return r; },
    dealRow: function () { var r = deal(); if (r) { render(); save(); } return r; },
    undo: function () { var r = undo(); if (r) { render(); save(); } return r; },
    canDeal: canDeal,
    canStack: canStack,
    runFrom: runFrom,
    emptyCols: emptyCols,
    boardMoves: boardMoves,
    anyMove: anyMove,
    deadEnd: deadEnd,
    bestMove: bestMove,
    runsDone: function () { return S.done.slice(); },
    clearSave: function () { store.clear(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
