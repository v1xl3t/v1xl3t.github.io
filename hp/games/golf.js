/* ============================================================
   Golf for HACKING PARADISE.

   The shortest game on the table and the one with the least to
   decide, which is the point of it. Seven columns of five, one
   pile to play onto, and a card may go there if it is one rank
   above or below whatever is showing.

   Two things make it different from the other solitaires here and
   both simplify the code rather than complicate it:

     every move is progress    a card only ever leaves a column,
                               never comes back, so there is no
                               such thing as a treadmill and the
                               dead-end question is just "is there
                               a legal move". No search, no cap,
                               no cache.

     there is one destination  so a tap plays the card outright
                               rather than picking it up and
                               waiting to be told where. Pick up
                               and put down is ceremony when there
                               is only one place to put it.

   The king is a wall by default, because that is the game, and
   the wall is most of the difficulty. Turning wrapping on lets an
   ace follow a king and makes the deal far kinder, so it is a
   choice on the bar rather than a hidden default.
   ============================================================ */
(function () {
  'use strict';

  var C = window.HPCards;
  var K = window.HPSolCore;
  var COLS = 7;
  var DEEP = 5;

  var store = K.Store('hp-golf-v1', 1);
  var undoStack = K.Undo(80);
  var S = null;
  var els = {};
  var race = null;
  var keys = null;
  var say = function () {};
  var hint = null;

  /* ============================================================
     STATE
     ============================================================ */
  function freshState(seed, wrap) {
    var deck = K.shuffled(seed);
    var t = [];
    for (var c = 0; c < COLS; c++) t.push(deck.splice(0, DEEP));
    return {
      seed: seed,
      wrap: !!wrap,
      stock: deck.slice(1),
      waste: [deck[0]],
      t: t,
      moves: 0,
      won: false
    };
  }

  function snapshot() {
    return {
      stock: S.stock.slice(),
      waste: S.waste.slice(),
      t: S.t.map(function (col) { return col.slice(); }),
      moves: S.moves,
      won: S.won
    };
  }

  function restore(o) {
    S.stock = o.stock.slice();
    S.waste = o.waste.slice();
    S.t = o.t.map(function (col) { return col.slice(); });
    S.moves = o.moves;
    S.won = !!o.won;
  }

  /* ============================================================
     RULES

     One rule, and it is the whole game. A card may go on the pile
     if it is one rank away from the card showing.

     Wrapping is what an ace and a king do at the ends of the run.
     Off, the king is a wall and nothing follows it, which is where
     most lost deals come from. On, the ranks are a ring.
     ============================================================ */
  function adjacent(a, b, wrap) {
    var d = Math.abs(K.valOf(a) - K.valOf(b));
    if (d === 1) return true;
    return !!wrap && d === 12;   /* the ace and the king */
  }

  function topOfWasteIn(B) { return B.waste[B.waste.length - 1]; }

  function canPlayIn(B, col) {
    var pile = B.t[col];
    if (!pile.length) return false;
    var showing = topOfWasteIn(B);
    if (!showing) return false;
    return adjacent(pile[pile.length - 1], showing, B.wrap);
  }

  function canPlay(col) { return canPlayIn(S, col); }

  function movesIn(B) {
    var out = [];
    for (var c = 0; c < COLS; c++) if (canPlayIn(B, c)) out.push(c);
    return out;
  }

  function boardMoves() { return movesIn(S); }
  function deckMove() { return S.stock.length > 0; }
  function anyMove() { return boardMoves().length > 0 || deckMove(); }

  /* Every legal move takes a card off the board for good, so a deal
     is over exactly when nothing is legal. There is no position that
     can shuffle forever, which is why nothing in this file searches. */
  function deadEnd() {
    if (S.won) return null;
    return anyMove() ? null : 'none';
  }

  function cardsLeft() {
    var n = 0;
    for (var c = 0; c < COLS; c++) n += S.t[c].length;
    return n;
  }

  function checkWin() {
    if (cardsLeft() === 0 && !S.won) {
      S.won = true;
      els.winbar.hidden = false;
      els.winLede.textContent = S.stock.length
        ? 'All seven columns cleared with ' + S.stock.length + ' still in the deck.'
        : 'All seven columns cleared on the very last card.';
      say('Every column cleared.');
    }
    return S.won;
  }

  /* ============================================================
     MOVES
     ============================================================ */
  function play(col) {
    if (S.won || !canPlay(col)) return false;
    undoStack.push(snapshot());
    S.waste.push(S.t[col].pop());
    S.moves++;
    hint.clear();
    checkWin();
    return true;
  }

  function draw() {
    if (S.won || !S.stock.length) return false;
    undoStack.push(snapshot());
    S.waste.push(S.stock.pop());
    S.moves++;
    hint.clear();
    return true;
  }

  function undo() {
    var snap = undoStack.pop();
    if (!snap) return false;
    restore(snap);
    S.won = false;
    els.winbar.hidden = true;
    hint.clear();
    return true;
  }

  /* ============================================================
     THE HINT

     A column with one card left is worth clearing before one with
     four, because an empty column is the only thing in Golf that
     is permanently good. Beyond that a play beats a draw, always,
     since the deck is finite and every card drawn is one fewer
     chance later.
     ============================================================ */
  function bestMove() {
    var playable = boardMoves();
    if (!playable.length) return deckMove() ? { kind: 'draw' } : null;
    var best = playable[0], bestLen = S.t[best].length;
    playable.forEach(function (c) {
      if (S.t[c].length < bestLen) { best = c; bestLen = S.t[c].length; }
    });
    return { kind: 'play', col: best };
  }

  function showHint() {
    if (S.won) return;
    var dead = deadEnd();
    if (dead) { paintStuck(dead); return; }
    var m = bestMove();
    if (!m) return;
    if (m.kind === 'draw') {
      hint.show('stock', 'waste');
      say('Nothing on the board fits. Turn one over.');
      return;
    }
    hint.show('tab:' + m.col, 'waste');
    var id = S.t[m.col][S.t[m.col].length - 1];
    say('Play the ' + C.label(K.card(id)) + ' from column ' + (m.col + 1) + '.' +
      (S.t[m.col].length === 1 ? ' That clears the column.' : ''));
  }

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  function save() { store.write({ seed: S.seed, wrap: S.wrap, s: snapshot(), u: undoStack.all() }); }

  function load() {
    var o = store.read();
    if (!o || !o.s) return false;
    S = { seed: o.seed || 0, wrap: !!o.wrap };
    try { restore(o.s); } catch (e) { return false; }
    if (!S.t || S.t.length !== COLS || !S.waste) return false;
    undoStack.load(o.u);
    return true;
  }

  function newGame(wrap, seed) {
    hint && hint.clear();
    S = freshState(seed != null ? seed : (Date.now() ^ Math.floor(Math.random() * 0xffffff)) >>> 0,
      wrap != null ? wrap : (S ? S.wrap : false));
    undoStack.clear();
    els.winbar.hidden = true;
    render(); save();
  }

  /* Turning wrapping on or off mid deal would rewrite whether the
     board you are looking at was ever winnable, so it starts a new
     one and says so rather than changing the rules under a player. */
  function setWrap(on) {
    if (S.wrap === on) return;
    if (S.moves > 0 && !window.confirm(
      (on ? 'Letting the ace follow the king' : 'Making the king a wall again') +
      ' starts a new game. Carry on?')) return;
    newGame(on);
    say(on ? 'Aces and kings now join up. New game dealt.' : 'The king is a wall again. New game dealt.');
  }

  /* ============================================================
     RENDER
     ============================================================ */
  function render() {
    K.sizeBoard(els.board, COLS);
    var ch = parseInt(getComputedStyle(els.board).getPropertyValue('--ch'), 10);

    els.stock.innerHTML = '';
    els.stock.classList.toggle('dead', !S.stock.length);
    if (S.stock.length) {
      els.stock.appendChild(C.back({ label: 'Deck, ' + S.stock.length + ' left' }));
    } else {
      els.stock.appendChild(C.slot('☆', { label: 'The deck is empty.' }));
    }

    els.waste.innerHTML = '';
    var showing = topOfWasteIn(S);
    if (showing) {
      var w = C.play(K.card(showing));
      w.dataset.top = '1';
      els.waste.appendChild(w);
    } else {
      els.waste.appendChild(C.slot('', { label: 'Nothing played yet' }));
    }

    /* One step for the whole board, measured against the screen. The
       board's own height is a result of the step, so asking it here
       asks a question whose answer depends on the answer. */
    var tabTop = els.tab.getBoundingClientRect().top;
    var room = Math.max(220, window.innerHeight - tabTop - 56);
    var step = Math.floor((room - ch) / (DEEP - 1));
    step = Math.min(Math.round(ch * 0.5), step);
    step = Math.max(Math.round(ch * 0.19), step);

    for (var c = 0; c < COLS; c++) {
      var host = els.cols[c];
      host.innerHTML = '';
      var pile = S.t[c];
      if (!pile.length) {
        host.appendChild(C.slot('', { label: 'Column ' + (c + 1) + ', cleared' }));
        host.style.height = '';
        continue;
      }
      for (var j = 0; j < pile.length; j++) {
        var node = C.play(K.card(pile[j]));
        node.style.top = (j * step) + 'px';
        node.dataset.idx = String(j);
        if (j === pile.length - 1) {
          node.dataset.top = '1';
          /* The only affordance in the game. A card that fits gets a
             ring, because working out seven adjacencies in your head
             on every single turn is arithmetic, not a decision. */
          if (canPlay(c)) node.classList.add('fits');
        } else {
          node.classList.add('buried');
        }
        host.appendChild(node);
      }
      host.style.height = ((pile.length - 1) * step + ch) + 'px';
    }

    els.moves.textContent = String(S.moves);
    els.left.textContent = String(cardsLeft());
    els.deck.textContent = String(S.stock.length);
    els.undoBtn.disabled = undoStack.depth() === 0;
    els.wrapOff.setAttribute('aria-pressed', String(!S.wrap));
    els.wrapOn.setAttribute('aria-pressed', String(S.wrap));

    var dead = S.won ? null : deadEnd();
    paintStuck(dead);
    els.hintBtn.disabled = !!dead || S.won;
  }

  function paintStuck(dead) {
    if (!dead) { els.stuckbar.hidden = true; return; }
    els.stuckbar.hidden = false;
    els.stuckWhy.textContent = 'The deck is out and nothing on the board fits the pile. ' +
      cardsLeft() + ' card' + (cardsLeft() === 1 ? '' : 's') +
      ' left. Walk a few moves back, or take a fresh deal.';
    say('No moves left.');
  }

  /* ============================================================
     INPUT

     There is one destination, so a tap plays the card outright.
     Dragging still works, because a player coming from the other
     games will try it, and a gesture that does nothing reads as a
     broken game rather than an unnecessary one.
     ============================================================ */
  function infoFrom(target) {
    var pileEl = target.closest ? target.closest('[data-pile]') : null;
    if (!pileEl) return null;
    var key = pileEl.dataset.pile;
    var out = { cardEl: target.closest('.hpc') };
    if (key === 'stock') out.kind = 'stock';
    else if (key === 'waste') out.kind = 'waste';
    else if (key.indexOf('tab:') === 0) {
      out.kind = 'tab';
      out.col = parseInt(key.slice(4), 10);
      out.idx = out.cardEl && out.cardEl.dataset.idx != null ? parseInt(out.cardEl.dataset.idx, 10) : -1;
    }
    return out;
  }

  function isLast(info) {
    return info && info.kind === 'tab' && info.idx >= 0 && info.idx === S.t[info.col].length - 1;
  }

  function handleTap(info) {
    if (!info || S.won) return;
    if (info.kind === 'stock') {
      if (draw()) { render(); save(); }
      else say('The deck is empty.');
      return;
    }
    if (!isLast(info)) {
      if (info.kind === 'tab' && S.t[info.col].length) {
        say('Only the card at the bottom of a column can be played.');
      }
      return;
    }
    if (play(info.col)) { render(); save(); return; }
    var id = S.t[info.col][S.t[info.col].length - 1];
    var showing = topOfWasteIn(S);
    say('The ' + C.label(K.card(id)) + ' is not one away from the ' +
      C.label(K.card(showing)) + '.');
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function boot() {
    els.board = document.getElementById('board');
    els.stock = document.querySelector('[data-pile="stock"]');
    els.waste = document.querySelector('[data-pile="waste"]');
    els.tab = document.getElementById('tableau');
    els.cols = [];
    for (var c = 0; c < COLS; c++) els.cols.push(document.querySelector('[data-pile="tab:' + c + '"]'));
    els.dragLayer = document.getElementById('draglayer');
    els.live = document.getElementById('live');
    els.moves = document.getElementById('moves');
    els.left = document.getElementById('left');
    els.deck = document.getElementById('deck');
    els.newBtn = document.getElementById('newBtn');
    els.undoBtn = document.getElementById('undoBtn');
    els.hintBtn = document.getElementById('hintBtn');
    els.wrapOff = document.getElementById('wrapOff');
    els.wrapOn = document.getElementById('wrapOn');
    els.winbar = document.getElementById('winbar');
    els.winLede = document.getElementById('winLede');
    els.winNew = document.getElementById('winNew');
    els.stuckbar = document.getElementById('stuckbar');
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
        var pickable = isLast(info) && S.t[info.col].length;
        return {
          tap: info,
          src: pickable ? { col: info.col } : null,
          ids: pickable ? [S.t[info.col][S.t[info.col].length - 1]] : null,
          rect: info.cardEl ? info.cardEl.getBoundingClientRect() : null
        };
      },
      destOf: function (el, d) {
        var info = infoFrom(el);
        if (!info || info.kind !== 'waste' || !d.src) return null;
        return canPlay(d.src.col) ? { kind: 'waste' } : null;
      },
      hostFor: function () { return els.waste; },
      onDrop: function (d, dest) {
        if (dest && play(d.src.col)) { render(); save(); }
        else render();
      },
      onTap: handleTap
    });

    document.addEventListener('keydown', function (e) {
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (undo()) { render(); save(); }
      }
    });

    els.newBtn.addEventListener('click', function () { newGame(); say('New game dealt.'); });
    els.undoBtn.addEventListener('click', function () { if (undo()) { render(); save(); say('Move undone.'); } });
    els.hintBtn.addEventListener('click', showHint);
    els.wrapOff.addEventListener('click', function () { setWrap(false); });
    els.wrapOn.addEventListener('click', function () { setWrap(true); });
    els.winNew.addEventListener('click', function () { newGame(); });
    els.stuckNew.addEventListener('click', function () { newGame(); say('New game dealt.'); });
    els.stuckUndo.addEventListener('click', function () { if (undo()) { render(); save(); say('Move undone.'); } });

    /* ---------- racing ----------
       The whole feature rests on something that was already here for
       the tests: this game deals the same board twice from the same
       seed. race.js never looks at a card, it only asks for a deal and
       for one number saying how far along we are. */
    race = window.HPRace.create({
      game: 'golf',
      total: 35,
      label: 'cards cleared',
      variant: function () { return S.wrap; },
      deal: function (seed, variant) { newGame(!!variant, seed); },
      progress: function () {
        return {
          main: (function () { return 35 - cardsLeft(); })(),
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
      cancel: function () {  render(); },
      shortcuts: {
        n: function () { newGame(); say('New game dealt.'); },
        u: function () { if (undo()) { render(); save(); say('Move undone.'); } },
        h: function () { showHint(); },
        r: function () { document.getElementById('raceBtn').click(); },
        d: function () { handleTap({ kind: 'stock' }); },
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
        { keys: ['D'], what: 'Turn a card over from the deck' },
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

  window.HPGolf = {
    get state() { return S; },
    deal: function (seed, wrap) { newGame(wrap, seed); },
    forceState: function (o) {
      if (o.stock) S.stock = o.stock.slice();
      if (o.waste) S.waste = o.waste.slice();
      if (o.t) S.t = o.t.map(function (col) { return col.slice(); });
      if (typeof o.wrap === 'boolean') S.wrap = o.wrap;
      S.won = false;
      els.winbar.hidden = true;
      undoStack.clear();
      checkWin();
      render(); save();
    },
    play: function (col) { var r = play(col); if (r) { render(); save(); } return r; },
    draw: function () { var r = draw(); if (r) { render(); save(); } return r; },
    undo: function () { var r = undo(); if (r) { render(); save(); } return r; },
    adjacent: function (a, b) { return adjacent(a, b, S.wrap); },
    boardMoves: boardMoves,
    deckMove: deckMove,
    anyMove: anyMove,
    deadEnd: deadEnd,
    bestMove: bestMove,
    cardsLeft: cardsLeft,
    clearSave: function () { store.clear(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
