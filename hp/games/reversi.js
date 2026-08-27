/* ============================================================
   Reversi for HACKING PARADISE.

   Vanilla, no framework, no build step, no module loader. The
   only outside code is PeerJS, vendored next to this file and
   loaded lazily, and the game is written so that it never needs
   it. If the library is missing, blocked or broken, the board
   still plays. Nothing here throws because a script did not
   arrive.

   Three ways to play, one board:

     two players   the default, one device, no network at all
     online        two browsers talk directly through a short
                   invite code. No account, no server of ours, no
                   record of who played whom.
     computer      a one ply search with a corner weighted board.
                   Beatable, but it will punish a loose edge.

   The two sides are Void, who plays the dark discs and moves
   first, and Promise, who plays the light ones. They are named
   for the two ends of the same fall, and they stay the same
   color in both themes, because a player's color is part of the
   game state rather than part of the room.

   ONLINE, IN ONE PARAGRAPH
   The host owns the truth. The host holds the board, applies
   every move to it, and pushes the whole board to the guest
   after each change. The guest never edits its own board, it
   sends the square it wants and waits to be told what happened.
   That is why two people tapping at the same instant cannot
   corrupt anything. The worst case is that one tap is ignored
   and the sender is resynced a moment later.

   Every network call in this file goes through the Net object.
   The game logic never sees PeerJS, only four verbs, so the
   whole transport can fail and the game does not know the
   difference.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'hp-reversi-v1';
  var PROTO = 1;                 // bump if a message shape ever changes
  var VOID = 1;                  // dark discs, moves first
  var PROMISE = 2;               // light discs
  var AI_SIDE = PROMISE;         // the computer takes the light discs
  var AI_DELAY = 420;            // long enough to read as a move, short enough to wait for

  function nameOf(p) { return p === VOID ? 'Void' : 'Promise'; }
  function other(p) { return p === VOID ? PROMISE : VOID; }

  /* ============================================================
     RULES

     Pure functions over a flat array of 64. 0 is empty, 1 is
     Void, 2 is Promise. Nothing in this block touches the DOM,
     which is what lets the computer player and the network layer
     reuse it without a board on screen.
     ============================================================ */

  function freshBoard() {
    var b = [];
    for (var i = 0; i < 64; i++) b.push(0);
    b[27] = PROMISE; b[28] = VOID;
    b[35] = VOID;    b[36] = PROMISE;
    return b;
  }

  /* Every disc this move would flip, or null when the move is not legal.
     Walked as rows and columns rather than as flat offsets, because flat
     offsets wrap around the edge of the board and that bug is invisible until
     somebody plays column one. */
  function flipsFor(b, i, p) {
    if (i < 0 || i > 63 || b[i] !== 0) return null;
    var them = other(p);
    var r0 = (i / 8) | 0, c0 = i % 8;
    var out = [];
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        var line = [];
        var r = r0 + dr, c = c0 + dc;
        while (r >= 0 && r < 8 && c >= 0 && c < 8 && b[r * 8 + c] === them) {
          line.push(r * 8 + c);
          r += dr; c += dc;
        }
        // a run of theirs only counts when one of ours closes it
        if (line.length && r >= 0 && r < 8 && c >= 0 && c < 8 && b[r * 8 + c] === p) {
          out = out.concat(line);
        }
      }
    }
    return out.length ? out : null;
  }

  function legalMoves(b, p) {
    var map = {};
    for (var i = 0; i < 64; i++) {
      var f = flipsFor(b, i, p);
      if (f) map[i] = f;
    }
    return map;
  }

  function anyMove(b, p) {
    for (var i = 0; i < 64; i++) if (flipsFor(b, i, p)) return true;
    return false;
  }

  function counts(b) {
    var out = { 1: 0, 2: 0, empty: 0 };
    for (var i = 0; i < 64; i++) {
      if (b[i] === VOID) out[1]++;
      else if (b[i] === PROMISE) out[2]++;
      else out.empty++;
    }
    return out;
  }

  function rcLabel(i) {
    return 'row ' + (((i / 8) | 0) + 1) + ', column ' + ((i % 8) + 1);
  }

  /* ============================================================
     STATE
     ============================================================ */

  var S = null;          // {b, turn, over, last, flipped, n, passed}
  var legal = {};        // index -> flips, for the side to move
  var mode = 'pass';     // 'pass' | 'net' | 'ai'
  var myColor = VOID;    // which side this browser owns, online only
  var netRole = '';      // 'host' | 'guest' | ''
  var netOpen = false;
  var aiTimer = null;
  var focusIdx = 27;     // roving tabindex, so the board is one tab stop

  function freshState() {
    return { b: freshBoard(), turn: VOID, over: false, last: -1, flipped: [], n: 0, passed: false };
  }

  function recomputeLegal() { legal = S.over ? {} : legalMoves(S.b, S.turn); }

  /* Hand the turn over. Reversi has no move to make when a side is shut out,
     so the pass is automatic and the only honest thing to do is say it out
     loud. When neither side can move the game is finished, which is not always
     the same as a full board. */
  function advance() {
    var next = other(S.turn);
    if (anyMove(S.b, next)) { S.turn = next; S.passed = false; return 'turn'; }
    if (anyMove(S.b, S.turn)) { S.passed = true; return 'pass'; }
    S.over = true; S.passed = false; return 'over';
  }

  function playAt(i) {
    var f = legal[i];
    if (!f || S.over) return null;
    S.b[i] = S.turn;
    for (var k = 0; k < f.length; k++) S.b[f[k]] = S.turn;
    S.last = i;
    S.flipped = f;
    S.n++;
    var mover = S.turn;
    var what = advance();
    recomputeLegal();
    return { mover: mover, at: i, flips: f.length, what: what };
  }

  function winner() {
    var c = counts(S.b);
    if (c[VOID] === c[PROMISE]) return 0;
    return c[VOID] > c[PROMISE] ? VOID : PROMISE;
  }

  /* ============================================================
     THE COMPUTER

     One ply. It looks at every legal move, plays it on a copy,
     and scores the result. The weights are the classic ones, a
     corner is worth far more than a disc and the square beside a
     corner is worth less than nothing, because handing over a
     corner is how most games are actually lost.

     Mobility is added to the score for the same reason. Owning
     the most discs in the middle of the game is close to
     meaningless. Owning the most CHOICES is not.

     Near the end the weights stop mattering and the count is the
     whole truth, so the score switches to the raw difference.
     ============================================================ */

  var W = [
    120, -22, 20, 6, 6, 20, -22, 120,
    -22, -45, -5, -3, -3, -5, -45, -22,
     20,  -5, 15,  3,  3, 15,  -5,  20,
      6,  -3,  3,  3,  3,  3,  -3,   6,
      6,  -3,  3,  3,  3,  3,  -3,   6,
     20,  -5, 15,  3,  3, 15,  -5,  20,
    -22, -45, -5, -3, -3, -5, -45, -22,
    120, -22, 20, 6, 6, 20, -22, 120
  ];

  function scoreFor(b, p) {
    var c = counts(b);
    if (c.empty <= 10) return (p === VOID ? c[VOID] - c[PROMISE] : c[PROMISE] - c[VOID]) * 100;
    var pos = 0;
    for (var i = 0; i < 64; i++) {
      if (b[i] === p) pos += W[i];
      else if (b[i] === other(p)) pos -= W[i];
    }
    var mine = 0, theirs = 0;
    for (var j = 0; j < 64; j++) {
      if (flipsFor(b, j, p)) mine++;
      if (flipsFor(b, j, other(p))) theirs++;
    }
    return pos + (mine - theirs) * 9;
  }

  function bestMove(b, p) {
    var moves = legalMoves(b, p);
    var keys = Object.keys(moves);
    if (!keys.length) return -1;
    var best = -Infinity, pick = [];
    for (var k = 0; k < keys.length; k++) {
      var i = +keys[k];
      var copy = b.slice();
      copy[i] = p;
      var f = moves[i];
      for (var j = 0; j < f.length; j++) copy[f[j]] = p;
      var v = scoreFor(copy, p);
      if (v > best) { best = v; pick = [i]; }
      else if (v === best) pick.push(i);
    }
    return pick[Math.floor(Math.random() * pick.length)];
  }

  function stopAI() { if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; } }

  function maybeAI() {
    stopAI();
    if (mode !== 'ai' || S.over || S.turn !== AI_SIDE) return;
    aiTimer = setTimeout(function () {
      aiTimer = null;
      if (mode !== 'ai' || S.over || S.turn !== AI_SIDE) return;
      var i = bestMove(S.b, AI_SIDE);
      if (i < 0) return;
      var res = playAt(i);
      render(); save();
      announceMove(res);
      maybeAI();
    }, AI_DELAY);
  }

  /* ============================================================
     TRANSPORT

     Four verbs and one event stream. The game above this line
     never mentions PeerJS, and everything that can go wrong on a
     network arrives here as an event with a reason, not as an
     exception somewhere in the middle of a move.

     The library is fetched only when somebody actually asks to
     play online, so a player who never does pays nothing for it.
     ============================================================ */

  var Net = (function () {
    // No zero, O, one, I, S, five, B or eight. This code gets read out loud
    // over a phone, and those are the pairs people get wrong.
    var ALPHA = 'ACDEFHJKMNPQRTVWXY3479';
    var LEN = 6;
    var TAG = 'hpgo1-';

    var peer = null, conn = null, sink = null;
    var libState = 'idle';       // idle | loading | ready | failed
    var waiting = [];
    var joinTimer = null;
    var myCode = '';

    function emit(kind, data) { if (sink) sink(kind, data); }

    function makeCode() {
      var out = '';
      var buf = null;
      try {
        if (window.crypto && window.crypto.getRandomValues) {
          buf = new Uint32Array(LEN);
          window.crypto.getRandomValues(buf);
        }
      } catch (e) { buf = null; }
      for (var i = 0; i < LEN; i++) {
        var r = buf ? buf[i] : Math.floor(Math.random() * 0xffffffff);
        out += ALPHA.charAt(r % ALPHA.length);
      }
      return out;
    }

    function clean(code) {
      return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    }
    function idFor(code) { return TAG + clean(code).toLowerCase(); }

    /* Load the library on demand. Two things can go wrong, the file can fail to
       arrive and the file can arrive without defining Peer. Both end in the same
       place, which is a game that quietly stays offline. */
    function ensure(cb) {
      if (libState === 'ready' || typeof window.Peer === 'function') { libState = 'ready'; cb(true); return; }
      if (libState === 'failed') { cb(false); return; }
      waiting.push(cb);
      if (libState === 'loading') return;
      libState = 'loading';
      var s = document.createElement('script');
      s.src = 'peerjs.min.js';
      s.async = true;
      s.onload = function () {
        libState = typeof window.Peer === 'function' ? 'ready' : 'failed';
        flush();
      };
      s.onerror = function () { libState = 'failed'; flush(); };
      document.head.appendChild(s);
    }
    function flush() {
      var ok = libState === 'ready';
      var list = waiting; waiting = [];
      for (var i = 0; i < list.length; i++) list[i](ok);
    }

    function bindConn(c) {
      conn = c;
      c.on('open', function () { clearJoinTimer(); emit('open', null); });
      c.on('data', function (d) { emit('data', d); });
      c.on('close', function () { conn = null; emit('closed', null); });
      c.on('error', function () { emit('error', { reason: 'link' }); });
    }
    function clearJoinTimer() { if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; } }

    function host(attempt) {
      ensure(function (ok) {
        if (!ok) { emit('error', { reason: 'lib' }); return; }
        drop();
        myCode = makeCode();
        try { peer = new window.Peer(idFor(myCode), { debug: 0 }); }
        catch (e) { emit('error', { reason: 'start' }); return; }
        peer.on('open', function () { emit('code', myCode); });
        peer.on('connection', function (c) {
          // one guest at a time. A second knock is turned away rather than
          // allowed to overwrite a game in progress.
          if (conn) { try { c.close(); } catch (e) { /* already gone */ } return; }
          bindConn(c);
        });
        peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) { /* ignore */ } });
        peer.on('error', function (e) {
          var type = e && e.type ? e.type : 'unknown';
          // A code already in use is not an error the player can do anything
          // about, so pick another one and try again.
          if (type === 'unavailable-id' && (attempt || 0) < 3) { host((attempt || 0) + 1); return; }
          emit('error', { reason: type });
        });
      });
    }

    function join(code) {
      var want = clean(code);
      if (want.length < 4) { emit('error', { reason: 'short' }); return; }
      ensure(function (ok) {
        if (!ok) { emit('error', { reason: 'lib' }); return; }
        drop();
        myCode = want;
        try { peer = new window.Peer(undefined, { debug: 0 }); }
        catch (e) { emit('error', { reason: 'start' }); return; }
        peer.on('open', function () {
          var c;
          try { c = peer.connect(idFor(want), { reliable: true }); }
          catch (e) { emit('error', { reason: 'start' }); return; }
          bindConn(c);
          clearJoinTimer();
          joinTimer = setTimeout(function () {
            joinTimer = null;
            if (!isOpen()) emit('error', { reason: 'timeout' });
          }, 20000);
        });
        peer.on('error', function (e) {
          var type = e && e.type ? e.type : 'unknown';
          emit('error', { reason: type === 'peer-unavailable' ? 'nocode' : type });
        });
      });
    }

    function send(obj) {
      if (!isOpen()) return false;
      try { conn.send(obj); return true; } catch (e) { return false; }
    }

    function isOpen() { return !!(conn && conn.open); }

    // Tear the sockets down without telling anybody, used when we are about to
    // build new ones.
    function drop() {
      clearJoinTimer();
      if (conn) { try { conn.close(); } catch (e) { /* ignore */ } conn = null; }
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
    }

    function close() { drop(); myCode = ''; }

    return {
      on: function (fn) { sink = fn; },
      host: function () { host(0); },
      join: join,
      send: send,
      close: close,
      isOpen: isOpen,
      // Reports whether the library is usable without forcing a download.
      libFailed: function () { return libState === 'failed'; },
      clean: clean
    };
  })();

  /* ============================================================
     WHO IS ALLOWED TO MOVE
     ============================================================ */

  function myTurn() {
    if (S.over) return false;
    if (mode === 'ai') return S.turn !== AI_SIDE;
    if (mode === 'net') return netOpen && S.turn === myColor;
    return true;
  }

  /* ============================================================
     RENDER
     ============================================================ */

  var els = {};
  var cells = [];

  function buildGrid() {
    els.grid.innerHTML = '';
    cells = [];
    for (var r = 0; r < 8; r++) {
      var row = document.createElement('div');
      row.className = 'brow';
      row.setAttribute('role', 'row');
      for (var c = 0; c < 8; c++) {
        var i = r * 8 + c;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'cell';
        b.setAttribute('role', 'gridcell');
        b.dataset.i = String(i);
        b.tabIndex = -1;
        var d = document.createElement('span');
        d.className = 'disc';
        b.appendChild(d);
        row.appendChild(b);
        cells.push(b);
      }
      els.grid.appendChild(row);
    }
  }

  function cellLabel(i) {
    var v = S.b[i];
    if (v === VOID) return rcLabel(i) + ', Void disc';
    if (v === PROMISE) return rcLabel(i) + ', Promise disc';
    var f = legal[i];
    if (f && myTurn()) {
      return rcLabel(i) + ', empty, playable, flips ' + f.length +
        (f.length === 1 ? ' disc' : ' discs');
    }
    return rcLabel(i) + ', empty';
  }

  function render() {
    var canMove = myTurn();
    els.grid.classList.toggle('locked', !canMove);

    for (var i = 0; i < 64; i++) {
      var el = cells[i];
      var v = S.b[i];
      el.classList.toggle('dark', v === VOID);
      el.classList.toggle('light', v === PROMISE);
      el.classList.toggle('legal', !!legal[i] && canMove);
      el.classList.toggle('last', i === S.last);
      el.setAttribute('aria-label', cellLabel(i));
      el.tabIndex = i === focusIdx ? 0 : -1;
    }

    var c = counts(S.b);
    els.countVoid.textContent = String(c[VOID]);
    els.countPromise.textContent = String(c[PROMISE]);
    els.moveNo.textContent = String(S.n + 1);

    var w = S.over ? winner() : 0;
    els.sideVoid.classList.toggle('on', !S.over && S.turn === VOID);
    els.sidePromise.classList.toggle('on', !S.over && S.turn === PROMISE);
    els.sideVoid.classList.toggle('win', S.over && w === VOID);
    els.sidePromise.classList.toggle('win', S.over && w === PROMISE);

    els.turnline.textContent = turnText();

    els.win.hidden = !S.over;
    if (S.over) {
      els.winTitle.textContent = w === 0 ? 'A dead heat' : nameOf(w) + ' wins';
      els.winText.textContent = w === 0
        ? 'Thirty two discs each, which almost never happens.'
        : 'Final count, Void ' + c[VOID] + ' and Promise ' + c[PROMISE] + '.';
    }
  }

  function turnText() {
    if (S.over) {
      var w = winner();
      return w === 0 ? 'Even, nobody wins' : nameOf(w) + ' wins';
    }
    if (mode === 'net' && !netOpen) return 'Waiting for a second player';
    if (mode === 'net') return S.turn === myColor ? 'Your move' : 'Waiting for your friend';
    if (mode === 'ai' && S.turn === AI_SIDE) return 'The computer is thinking';
    return nameOf(S.turn) + ' to move';
  }

  function say(msg) { if (els.live) els.live.textContent = msg; }

  function announceMove(res) {
    if (!res) return;
    var bits = nameOf(res.mover) + ' plays ' + rcLabel(res.at) +
      ' and flips ' + res.flips + (res.flips === 1 ? ' disc' : ' discs') + '.';
    if (res.what === 'pass') bits += ' ' + nameOf(other(S.turn)) + ' has no legal move, so the turn passes back.';
    else if (res.what === 'over') bits += ' Neither side can move. ' + turnText() + '.';
    else bits += ' ' + nameOf(S.turn) + ' to move.';
    say(bits);
  }

  /* ============================================================
     PERSISTENCE

     Only the games that live on this device are saved. An online
     game belongs to two browsers and half of it would be a lie
     the moment the tab closed, so it is never written down.
     ============================================================ */

  function save() {
    if (mode === 'net') return;
    try {
      localStorage.setItem(KEY, JSON.stringify({
        v: 1, mode: mode, b: S.b.join(''), turn: S.turn,
        over: S.over, last: S.last, n: S.n
      }));
    } catch (e) { /* private mode or full, the game still plays */ }
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      var o = JSON.parse(raw);
      if (!o || o.v !== 1 || typeof o.b !== 'string' || o.b.length !== 64) return false;
      var b = [];
      for (var i = 0; i < 64; i++) {
        var n = o.b.charCodeAt(i) - 48;
        if (n !== 0 && n !== 1 && n !== 2) return false;
        b.push(n);
      }
      S = {
        b: b,
        turn: o.turn === PROMISE ? PROMISE : VOID,
        over: !!o.over,
        last: typeof o.last === 'number' ? o.last : -1,
        flipped: [],
        n: typeof o.n === 'number' ? o.n : 0,
        passed: false
      };
      mode = o.mode === 'ai' ? 'ai' : 'pass';
      recomputeLegal();
      // A saved board with no moves left for either side is simply finished.
      if (!S.over && !Object.keys(legal).length && !anyMove(S.b, other(S.turn))) S.over = true;
      return true;
    } catch (e) { return false; }
  }

  function newGame(quiet) {
    stopAI();
    S = freshState();
    recomputeLegal();
    focusIdx = 27;
    render(); save();
    if (!quiet) say('New game. Void to move.');
    if (mode === 'net' && netRole === 'host' && netOpen) pushState();
    maybeAI();
  }

  /* ============================================================
     ONLINE GLUE

     Message shapes, all of them small and flat:

       hi       guest to host, the handshake
       welcome  host to guest, which side you are and the board
       move     guest to host, the square I want
       state    host to guest, the board as it really is
       again    guest to host, please start another game
       bye      either way, I am leaving on purpose
     ============================================================ */

  function packState() {
    return {
      t: 'state', v: PROTO,
      b: S.b.join(''), turn: S.turn, over: S.over, last: S.last, n: S.n
    };
  }

  function pushState() { Net.send(packState()); }

  function takeState(msg) {
    if (!msg || typeof msg.b !== 'string' || msg.b.length !== 64) return;
    var b = [];
    for (var i = 0; i < 64; i++) {
      var n = msg.b.charCodeAt(i) - 48;
      b.push(n === 1 || n === 2 ? n : 0);
    }
    var before = S ? counts(S.b) : null;
    S = {
      b: b,
      turn: msg.turn === PROMISE ? PROMISE : VOID,
      over: !!msg.over,
      last: typeof msg.last === 'number' ? msg.last : -1,
      flipped: [],
      n: typeof msg.n === 'number' ? msg.n : 0,
      passed: false
    };
    recomputeLegal();
    render();
    if (before) {
      var now = counts(S.b);
      if (now[VOID] + now[PROMISE] !== before[VOID] + before[PROMISE]) {
        say(S.over ? turnText() + '.' : (S.turn === myColor ? 'Your move.' : 'Waiting for your friend.'));
      }
    }
  }

  function netStatus(msg) { els.netStatus.textContent = msg || ''; }

  /* Every reason the transport can hand back, turned into something a person
     would actually say. An unknown reason still gets a sentence rather than a
     code, because a code helps nobody sitting at the board. */
  function reasonText(reason) {
    if (reason === 'lib') return 'Online play could not start because its code did not load. Two players on this device still works.';
    if (reason === 'nocode') return 'No game is waiting on that code. Check the letters, or ask your friend for a fresh one.';
    if (reason === 'short') return 'That code looks too short. It is six characters.';
    if (reason === 'timeout') return 'That took too long. The other browser may have closed the game.';
    if (reason === 'browser-incompatible') return 'This browser cannot make a direct connection. Two players on this device still works.';
    if (reason === 'network' || reason === 'server-error' || reason === 'socket-error' || reason === 'socket-closed') {
      return 'The matchmaking service could not be reached. Two players on this device still works.';
    }
    return 'The connection failed. Two players on this device still works.';
  }

  function netEvent(kind, data) {
    if (kind === 'code') {
      els.codeOut.textContent = data;
      netStatus('Read this code out to your friend, then wait here. You are Void and you move first.');
      return;
    }
    if (kind === 'open') {
      netOpen = true;
      showNetRow('live');
      els.youAre.textContent = nameOf(myColor);
      els.localBtn.hidden = true;
      if (netRole === 'host') {
        newGame(true);
        Net.send({ t: 'welcome', v: PROTO, you: PROMISE, state: packState() });
        netStatus('Your friend is here. You are Void, so you move first.');
        say('Your friend joined. You are Void and you move first.');
      } else {
        Net.send({ t: 'hi', v: PROTO });
        netStatus('Connected. Waiting for the first board.');
      }
      render();
      return;
    }
    if (kind === 'data') { onMessage(data); return; }
    if (kind === 'closed') {
      if (!netOpen) return;
      netOpen = false;
      netStatus('Your friend left the game. The board is still here.');
      say('Your friend left the game.');
      els.localBtn.hidden = false;
      render();
      return;
    }
    if (kind === 'error') {
      netOpen = false;
      netStatus(reasonText(data && data.reason));
      showNetRow('start');
      Net.close();
      netRole = '';
      render();
    }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.v && msg.v !== PROTO) {
      netStatus('That game is running a different version of Reversi. Both of you should reload the page.');
      return;
    }
    if (netRole === 'host') {
      if (msg.t === 'hi') { pushState(); return; }
      if (msg.t === 'move') {
        // The host is the referee. A move from the wrong side, or on a square
        // that is not legal, is dropped and the sender is told the truth again
        // rather than argued with.
        if (S.over || S.turn !== PROMISE || !legal[msg.i]) { pushState(); return; }
        var res = playAt(msg.i);
        render(); pushState();
        announceMove(res);
        return;
      }
      if (msg.t === 'again') { newGame(true); pushState(); say('Your friend started a new game.'); return; }
      if (msg.t === 'bye') { netOpen = false; netStatus('Your friend left the game. The board is still here.'); els.localBtn.hidden = false; render(); return; }
      return;
    }
    // guest
    if (msg.t === 'welcome') {
      myColor = msg.you === VOID ? VOID : PROMISE;
      els.youAre.textContent = nameOf(myColor);
      netStatus('Connected. You are ' + nameOf(myColor) + ', so Void moves first.');
      takeState(msg.state);
      return;
    }
    if (msg.t === 'state') { takeState(msg); return; }
    if (msg.t === 'bye') {
      netOpen = false;
      netStatus('Your friend left the game. The board is still here.');
      els.localBtn.hidden = false;
      render();
    }
  }

  function showNetRow(which) {
    els.netStart.hidden = which !== 'start';
    els.netHost.hidden = which !== 'host';
    els.netJoin.hidden = which !== 'join';
    els.netLive.hidden = which !== 'live';
  }

  function leaveNet(silent) {
    if (!silent) Net.send({ t: 'bye' });
    Net.close();
    netOpen = false;
    netRole = '';
    myColor = VOID;
    els.localBtn.hidden = true;
    showNetRow('start');
    netStatus('');
    els.codeOut.textContent = '------';
  }

  /* ============================================================
     MODES
     ============================================================ */

  function setMode(next, quiet) {
    if (next === mode) return;
    stopAI();
    if (mode === 'net') leaveNet(false);
    mode = next;
    els.modePass.setAttribute('aria-pressed', String(mode === 'pass'));
    els.modeNet.setAttribute('aria-pressed', String(mode === 'net'));
    els.modeAI.setAttribute('aria-pressed', String(mode === 'ai'));
    els.netpanel.hidden = mode !== 'net';
    note('');
    if (mode === 'net') {
      myColor = VOID;
      showNetRow('start');
      netStatus('');
      newGame(true);
      if (!quiet) say('Online play. Start a game to get a code, or join with one.');
    } else if (mode === 'ai') {
      newGame(true);
      if (!quiet) say('Playing the computer. You are Void and you move first.');
      maybeAI();
    } else {
      newGame(true);
      if (!quiet) say('Two players on this device. Void to move.');
    }
    render(); save();
  }

  function note(text) {
    els.note.textContent = text || '';
    els.note.hidden = !text;
  }

  /* ============================================================
     INPUT
     ============================================================ */

  function tryPlay(i) {
    if (S.over) return;
    if (!myTurn()) {
      if (mode === 'net' && !netOpen) note('Start a game or join with a code before you play.');
      return;
    }
    if (mode === 'net' && netRole === 'guest') {
      // The guest asks, it never decides. If the square is not legal the host
      // will simply resend the board and nothing moves.
      if (!legal[i]) return;
      Net.send({ t: 'move', i: i });
      say('Sent. Waiting for your friend.');
      return;
    }
    if (!legal[i]) return;
    var res = playAt(i);
    render(); save();
    announceMove(res);
    if (mode === 'net' && netRole === 'host') pushState();
    maybeAI();
  }

  function moveFocus(delta) {
    var r = (focusIdx / 8) | 0, c = focusIdx % 8;
    r = Math.max(0, Math.min(7, r + delta.r));
    c = Math.max(0, Math.min(7, c + delta.c));
    focusIdx = r * 8 + c;
    cells[focusIdx].tabIndex = 0;
    cells[focusIdx].focus();
    for (var i = 0; i < 64; i++) if (i !== focusIdx) cells[i].tabIndex = -1;
  }

  function bind() {
    els.grid.addEventListener('click', function (e) {
      var cell = e.target.closest ? e.target.closest('.cell') : null;
      if (!cell) return;
      focusIdx = +cell.dataset.i;
      tryPlay(focusIdx);
    });

    /* Arrow keys walk the board and the whole grid is one tab stop, which is
       the standard grid pattern. Sixty four tab stops between the controls and
       the footer would make the page unusable from a keyboard. */
    els.grid.addEventListener('keydown', function (e) {
      var cell = e.target.closest ? e.target.closest('.cell') : null;
      if (!cell) return;
      focusIdx = +cell.dataset.i;
      var k = e.key;
      if (k === 'ArrowLeft') { moveFocus({ r: 0, c: -1 }); }
      else if (k === 'ArrowRight') { moveFocus({ r: 0, c: 1 }); }
      else if (k === 'ArrowUp') { moveFocus({ r: -1, c: 0 }); }
      else if (k === 'ArrowDown') { moveFocus({ r: 1, c: 0 }); }
      else if (k === 'Home') { moveFocus({ r: 0, c: -8 }); }
      else if (k === 'End') { moveFocus({ r: 0, c: 8 }); }
      else if (k === 'PageUp') { moveFocus({ r: -8, c: 0 }); }
      else if (k === 'PageDown') { moveFocus({ r: 8, c: 0 }); }
      else return;
      e.preventDefault();
    });

    els.newBtn.addEventListener('click', function () {
      if (mode === 'net' && netOpen && netRole === 'guest') {
        Net.send({ t: 'again' });
        say('Asked your friend for a new game.');
        return;
      }
      newGame(false);
    });
    els.winNew.addEventListener('click', function () { els.newBtn.click(); });

    els.modePass.addEventListener('click', function () { setMode('pass'); });
    els.modeAI.addEventListener('click', function () { setMode('ai'); });
    els.modeNet.addEventListener('click', function () {
      if (Net.libFailed()) { note(reasonText('lib')); return; }
      setMode('net');
    });

    els.hostBtn.addEventListener('click', function () {
      netRole = 'host';
      myColor = VOID;
      els.codeOut.textContent = '------';
      showNetRow('host');
      netStatus('Getting a code.');
      Net.host();
    });

    els.joinShowBtn.addEventListener('click', function () {
      showNetRow('join');
      netStatus('');
      els.codeIn.value = '';
      els.codeIn.focus();
    });

    els.netJoin.addEventListener('submit', function (e) {
      e.preventDefault();
      netRole = 'guest';
      myColor = PROMISE;
      netStatus('Looking for that game.');
      Net.join(els.codeIn.value);
    });

    els.hostCancel.addEventListener('click', function () { leaveNet(true); });
    els.joinCancel.addEventListener('click', function () { leaveNet(true); });
    els.leaveBtn.addEventListener('click', function () {
      leaveNet(false);
      say('You left the game.');
      render();
    });

    /* When the other browser goes away the board is still a perfectly good
       position. Rather than throw it out, offer to finish it here. */
    els.localBtn.addEventListener('click', function () {
      var keep = S;
      leaveNet(true);
      mode = 'pass';
      els.modePass.setAttribute('aria-pressed', 'true');
      els.modeNet.setAttribute('aria-pressed', 'false');
      els.netpanel.hidden = true;
      S = keep;
      recomputeLegal();
      render(); save();
      say('Carrying on with both sides on this device.');
    });

    els.copyBtn.addEventListener('click', function () {
      var code = els.codeOut.textContent.trim();
      if (!code || code.charAt(0) === '-') return;
      copyText(code, function (ok) {
        els.copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        netStatus(ok
          ? 'Code copied. Send it however you like, it works once and only while this tab is open.'
          : 'Copying is blocked in this browser, so read the code out instead.');
        setTimeout(function () { els.copyBtn.textContent = 'Copy code'; }, 1800);
      });
    });

    // Typing a code should feel like typing a code, not like filling a form.
    els.codeIn.addEventListener('input', function () {
      var v = Net.clean(els.codeIn.value).slice(0, 8);
      if (v !== els.codeIn.value) els.codeIn.value = v;
    });

    // A tab that closes mid game should say goodbye rather than time out.
    window.addEventListener('pagehide', function () {
      if (netOpen) Net.send({ t: 'bye' });
    });
  }

  /* The clipboard API is not available on a plain http origin or inside some
     in app browsers, so there is a second path, and a third that just tells the
     player to read the code aloud. */
  function copyText(text, done) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
        return;
      }
    } catch (e) { /* fall through */ }
    done(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  /* ============================================================
     BOOT
     ============================================================ */

  function boot() {
    els.grid = document.getElementById('grid');
    els.board = document.getElementById('board');
    els.live = document.getElementById('live');
    els.note = document.getElementById('note');
    els.turnline = document.getElementById('turnline');
    els.countVoid = document.getElementById('countVoid');
    els.countPromise = document.getElementById('countPromise');
    els.sideVoid = document.getElementById('sideVoid');
    els.sidePromise = document.getElementById('sidePromise');
    els.moveNo = document.getElementById('moveNo');
    els.newBtn = document.getElementById('newBtn');
    els.win = document.getElementById('winbar');
    els.winTitle = document.getElementById('winTitle');
    els.winText = document.getElementById('winText');
    els.winNew = document.getElementById('winNew');
    els.modePass = document.getElementById('modePass');
    els.modeNet = document.getElementById('modeNet');
    els.modeAI = document.getElementById('modeAI');
    els.netpanel = document.getElementById('netpanel');
    els.netStart = document.getElementById('netStart');
    els.netHost = document.getElementById('netHost');
    els.netJoin = document.getElementById('netJoin');
    els.netLive = document.getElementById('netLive');
    els.netStatus = document.getElementById('netStatus');
    els.codeOut = document.getElementById('codeOut');
    els.codeIn = document.getElementById('codeIn');
    els.youAre = document.getElementById('youAre');
    els.hostBtn = document.getElementById('hostBtn');
    els.joinShowBtn = document.getElementById('joinShowBtn');
    els.hostCancel = document.getElementById('hostCancel');
    els.joinCancel = document.getElementById('joinCancel');
    els.leaveBtn = document.getElementById('leaveBtn');
    els.localBtn = document.getElementById('localBtn');
    els.copyBtn = document.getElementById('copyBtn');

    buildGrid();
    Net.on(netEvent);

    if (!load()) { S = freshState(); recomputeLegal(); }
    // A saved game only ever comes back as a game for this device.
    els.modePass.setAttribute('aria-pressed', String(mode === 'pass'));
    els.modeAI.setAttribute('aria-pressed', String(mode === 'ai'));
    els.netpanel.hidden = true;

    bind();
    render();
    maybeAI();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* A small surface for the test harness. Everything here can also be reached
     by hand, this only spares the suite from playing sixty moves to reach a
     position worth checking. */
  window.HPReversi = {
    get state() { return S; },
    get mode() { return mode; },
    legal: function () { return Object.keys(legal).map(Number); },
    newGame: function () { newGame(true); },
    setMode: setMode,
    play: function (i) { tryPlay(i); return S.b[i]; },
    flipsFor: function (i, p) { return flipsFor(S.b, i, p || S.turn); },
    bestMove: function () { return bestMove(S.b, S.turn); },
    counts: function () { return counts(S.b); },
    forceState: function (o) {
      stopAI();
      if (typeof o.b === 'string' && o.b.length === 64) {
        S.b = o.b.split('').map(function (ch) { var n = +ch; return n === 1 || n === 2 ? n : 0; });
      }
      if (o.turn) S.turn = o.turn === PROMISE ? PROMISE : VOID;
      /* A forced position is judged on its own merits, so `over` and `passed`
         start clean and the two lines below decide. Carrying them over from
         whatever game the page was holding made this hook order dependent: once
         one forced board had finished, every later one came back with no legal
         moves, because recomputeLegal hands back nothing while `over` is set. */
      S.over = typeof o.over === 'boolean' ? o.over : false;
      S.passed = false;
      recomputeLegal();
      if (!S.over && !Object.keys(legal).length && !anyMove(S.b, other(S.turn))) S.over = true;
      render(); save();
      maybeAI();
    },
    netState: function () { return { mode: mode, role: netRole, open: netOpen, you: myColor }; },
    clearSave: function () { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } },
    KEY: KEY
  };
})();
