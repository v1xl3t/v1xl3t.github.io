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

  /* ---------- rules ---------- */
  function canFound(id, suitKey) {
    if (suitOf(id) !== suitKey) return false;
    var pile = S.f[suitKey];
    return valOf(id) === pile.length + 1;
  }
  function foundationFor(id) {
    return canFound(id, suitOf(id)) ? suitOf(id) : null;
  }
  function canStack(id, col) {
    var pile = S.t[col];
    if (!pile.length) return valOf(id) === 13;          // only a king opens an empty column
    var top = pile[pile.length - 1];
    if (!top.u) return false;
    return valOf(top.i) === valOf(id) + 1 && isRed(top.i) !== isRed(id);
  }

  /* The face-up run a player can pick up from a tableau index. Face-up runs are
     always valid by construction, but validate anyway. A corrupt save should
     refuse to be picked up rather than teleport cards. */
  function runFrom(col, idx) {
    var pile = S.t[col];
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

  /* ---------- moves ---------- */
  function flipIfNeeded(col) {
    var pile = S.t[col];
    if (pile.length && !pile[pile.length - 1].u) pile[pile.length - 1].u = true;
  }

  function drawStock() {
    pushUndo();
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
    if (!undoStack.length) return false;
    restore(undoStack.pop());
    sel = null;
    return true;
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

    /* --- chrome --- */
    els.moves.textContent = String(S.moves);
    els.left.textContent = String(S.stock.length + S.waste.length);
    els.undoBtn.disabled = !undoStack.length;
    els.autoBtn.hidden = !autoAvailable();
    els.win.hidden = !S.won;
    els.d1.setAttribute('aria-pressed', String(S.draw === 1));
    els.d3.setAttribute('aria-pressed', String(S.draw === 3));
    if (S.won) say('You cleared the board in ' + S.moves + ' moves.');
  }

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
    els.autoBtn.addEventListener('click', function () { autoFinish(false); });
    els.d1.addEventListener('click', function () { setDraw(1); });
    els.d3.addEventListener('click', function () { setDraw(3); });
    els.winNew.addEventListener('click', function () { newGame(S.draw); });

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
    els.autoBtn = document.getElementById('autoBtn');
    els.newBtn = document.getElementById('newBtn');
    els.d1 = document.getElementById('draw1');
    els.d3 = document.getElementById('draw3');
    els.win = document.getElementById('winbar');
    els.winNew = document.getElementById('winNew');
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
