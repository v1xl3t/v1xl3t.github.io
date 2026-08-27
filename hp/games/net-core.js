/* ============================================================
   net-core.js — two to four browsers, one short code, and
   nothing left behind.

   Lifted out of reversi.js on 2026-08-27 while building online
   Hearts. It was already the right shape there, four verbs and
   one event stream, and the only thing wrong with it was that it
   could only ever hold one guest.

   THE CONTRACT

     the game above this line never mentions PeerJS. Everything
     that can go wrong on a network arrives as an event with a
     reason, never as an exception in the middle of a move.

     the library is fetched only when somebody actually asks to
     play online, so a player who never does pays nothing for it,
     and if it fails to arrive the game is told once and carries
     on offline.

     the host is the only authority. Guests send intents and are
     told the state. Nothing here enforces that, it is a rule the
     games follow, but every verb is shaped to make it the easy
     path: a guest can only send to the host, and only the host
     can send to one player in particular.

   WHAT THIS IS NOT

     It is not private from the broker. PeerJS signaling goes
     through a public matchmaking service to introduce the two
     browsers, which sees the room code and the addresses while
     they shake hands. After that the game data goes browser to
     browser and the service sees none of it. Nothing personal is
     ever sent through here, the code is six random characters
     and the payload is a board, so this is a thing to know
     rather than a thing to fix. It also means the service can be
     down, which is why every game must still play offline.

   ADDRESSES, AND WHY THIS FILE NOW REFUSES TO CONNECT

     A direct browser to browser connection tells each side the
     other's address. That is not a bug in this file, it is how
     peer to peer works, and the only way around it is to send
     every packet through a relay instead, so that all either side
     ever learns is the relay's address.

     A relay is a TURN server. There is no code only version of
     this. So this file now asks for RELAY ONLY, and if it has no
     relay to use it does not connect at all.

     It FAILS CLOSED, deliberately. The tempting thing is to try
     the relay and quietly fall back to a direct connection when
     there is not one, which would work beautifully and would also
     hand out the address the relay existed to hide. A privacy
     setting that turns itself off when it is inconvenient is not
     a privacy setting.

     To turn online play back on, put a relay in turn.json beside
     this file. The shape is in turn.example.json. Nothing else
     needs to change.

     It is not cheat proof. The host's browser holds the whole
     game, and in a game with hidden cards that means the host
     could look. That is the price of having no server, and for a
     game you start by reading six letters to somebody you know,
     it is the right price. It should be said out loud rather
     than pretended away.
   ============================================================ */
(function (root) {
  'use strict';

  /* No zero, O, one, I, S, five, B or eight. This code gets read out
     loud over a phone and those are the pairs people get wrong. */
  var ALPHA = 'ACDEFHJKMNPQRTVWXY3479';
  var LEN = 6;
  var JOIN_MS = 20000;

  /* The loader is shared across every transport on the page, so two of
     them can never race to append the same script tag. */
  var libState = 'idle';        // idle | loading | ready | failed
  var waiting = [];

  /* ---------- the relay ----------
     Read once, from a file rather than from code, so swapping relay or
     adding credentials is editing one small JSON file and not going
     through a build. Absent or empty means there is no relay, which
     means no online play. */
  var turnState = 'idle';       // idle | loading | ready | none
  var turnConf = null;
  var turnWaiting = [];

  function ensureTurn(cb) {
    if (turnState === 'ready') { cb(turnConf); return; }
    if (turnState === 'none') { cb(null); return; }
    turnWaiting.push(cb);
    if (turnState === 'loading') return;
    turnState = 'loading';
    var done = function (conf) {
      turnConf = conf;
      turnState = conf ? 'ready' : 'none';
      var list = turnWaiting; turnWaiting = [];
      list.forEach(function (fn) { fn(turnConf); });
    };
    var req;
    try { req = fetch('turn.json', { cache: 'no-store' }); }
    catch (e) { done(null); return; }
    req.then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var list = j && Array.isArray(j.iceServers) ? j.iceServers.filter(function (s) {
          /* A STUN server is not a relay. It tells you your own address,
             which is the opposite of the job. Only turn: and turns:
             count. */
          var u = [].concat(s && s.urls || []).join(' ');
          return /(^|\s)turns?:/.test(u);
        }) : [];
        done(list.length ? { iceServers: list } : null);
      })
      .catch(function () { done(null); });
  }

  function ensureLib(src, cb) {
    if (libState === 'ready' || typeof root.Peer === 'function') { libState = 'ready'; cb(true); return; }
    if (libState === 'failed') { cb(false); return; }
    waiting.push(cb);
    if (libState === 'loading') return;
    libState = 'loading';
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    /* Two things can go wrong and they end in the same place: the file
       can fail to arrive, and the file can arrive without defining
       Peer. Either way the game quietly stays offline. */
    s.onload = function () {
      libState = typeof root.Peer === 'function' ? 'ready' : 'failed';
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

  function clean(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function makeCode() {
    var out = '';
    var buf = null;
    try {
      if (root.crypto && root.crypto.getRandomValues) {
        buf = new Uint32Array(LEN);
        root.crypto.getRandomValues(buf);
      }
    } catch (e) { buf = null; }
    for (var i = 0; i < LEN; i++) {
      var r = buf ? buf[i] : Math.floor(Math.random() * 0xffffffff);
      out += ALPHA.charAt(r % ALPHA.length);
    }
    return out;
  }

  function create(opts) {
    opts = opts || {};
    var TAG = opts.tag || 'hpg1-';
    var MAX = opts.max || 1;                 /* how many guests a host will hold */
    var SRC = opts.lib || 'peerjs.min.js';

    var peer = null;
    var conns = [];                          /* host: every guest. guest: just the host */
    var sink = null;
    var joinTimer = null;
    var myCode = '';
    var role = '';                           /* 'host' | 'guest' | '' */

    function emit(kind, data, from) { if (sink) sink(kind, data, from); }
    function idFor(code) { return TAG + clean(code).toLowerCase(); }
    function live() { return conns.filter(function (c) { return c && c.open; }); }

    function bind(c) {
      conns.push(c);
      c.on('open', function () {
        clearJoinTimer();
        emit('open', { id: c.peer, count: live().length });
      });
      c.on('data', function (d) { emit('data', d, c.peer); });
      c.on('close', function () {
        conns = conns.filter(function (x) { return x !== c; });
        emit('closed', { id: c.peer, count: live().length });
      });
      c.on('error', function () { emit('error', { reason: 'link', id: c.peer }); });
    }

    function clearJoinTimer() { if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; } }

    function host(attempt) {
      ensureLib(SRC, function (ok) {
        if (!ok) { emit('error', { reason: 'lib' }); return; }
        ensureTurn(function (conf) {
        if (!conf) { emit('error', { reason: 'norelay' }); return; }
        drop();
        role = 'host';
        myCode = makeCode();
        try { peer = new root.Peer(idFor(myCode), peerOpts(conf)); }
        catch (e) { emit('error', { reason: 'start' }); return; }

        peer.on('open', function () { emit('code', myCode); });
        peer.on('connection', function (c) {
          /* A knock past the table size is turned away rather than
             allowed to overwrite a game in progress. */
          if (live().length >= MAX) { try { c.close(); } catch (e) { /* already gone */ } return; }
          bind(c);
        });
        peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) { /* ignore */ } });
        peer.on('error', function (e) {
          var type = e && e.type ? e.type : 'unknown';
          /* A code already in use is not something the player can do
             anything about, so pick another and try again. */
          if (type === 'unavailable-id' && (attempt || 0) < 3) { host((attempt || 0) + 1); return; }
          emit('error', { reason: type });
        });
        });
      });
    }

    /* Relay only, always. See the note at the top about failing closed. */
    function peerOpts(conf) {
      return {
        debug: 0,
        config: {
          iceServers: conf.iceServers,
          iceTransportPolicy: 'relay'
        }
      };
    }

    function join(code) {
      var want = clean(code);
      if (want.length < 4) { emit('error', { reason: 'short' }); return; }
      ensureLib(SRC, function (ok) {
        if (!ok) { emit('error', { reason: 'lib' }); return; }
        ensureTurn(function (conf) {
        if (!conf) { emit('error', { reason: 'norelay' }); return; }
        drop();
        role = 'guest';
        myCode = want;
        try { peer = new root.Peer(undefined, peerOpts(conf)); }
        catch (e) { emit('error', { reason: 'start' }); return; }
        peer.on('open', function () {
          var c;
          try { c = peer.connect(idFor(want), { reliable: true }); }
          catch (e) { emit('error', { reason: 'start' }); return; }
          bind(c);
          clearJoinTimer();
          joinTimer = setTimeout(function () {
            joinTimer = null;
            if (!live().length) emit('error', { reason: 'timeout' });
          }, JOIN_MS);
        });
        peer.on('error', function (e) {
          var type = e && e.type ? e.type : 'unknown';
          emit('error', { reason: type === 'peer-unavailable' ? 'nocode' : type });
        });
        });
      });
    }

    /* Host, this goes to everybody. Guest, there is only the host to
       send to, so it goes there. Returns how many it reached, and a
       caller that cares whether anybody heard should look. */
    function send(obj) {
      var n = 0;
      live().forEach(function (c) {
        try { c.send(obj); n++; } catch (e) { /* that one is gone, its close will fire */ }
      });
      return n;
    }

    /* Host only, and the whole reason hidden hands are possible. A
       guest calling this can only ever reach the host anyway. */
    function sendTo(id, obj) {
      var c = live().filter(function (x) { return x.peer === id; })[0];
      if (!c) return false;
      try { c.send(obj); return true; } catch (e) { return false; }
    }

    /* Tear the sockets down without telling anybody. Used when we are
       about to build new ones. */
    function drop() {
      clearJoinTimer();
      conns.forEach(function (c) { try { c.close(); } catch (e) { /* ignore */ } });
      conns = [];
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
    }

    return {
      on: function (fn) { sink = fn; },
      host: function () { host(0); },
      join: join,
      send: send,
      sendTo: sendTo,
      close: function () { drop(); myCode = ''; role = ''; },
      isOpen: function () { return live().length > 0; },
      count: function () { return live().length; },
      peers: function () { return live().map(function (c) { return c.peer; }); },
      role: function () { return role; },
      code: function () { return myCode; },
      full: function () { return live().length >= MAX; },
      /* Reports whether the library is unusable without forcing a
         download, so a button can decline before it promises anything. */
      libFailed: function () { return libState === 'failed'; },
      /* Whether there is a relay to play through. A game can ask before
         it offers a button that cannot work. */
      hasRelay: function (cb) { ensureTurn(function (c) { cb(!!c); }); },
      relayReady: function () { return turnState === 'ready'; },
      clean: clean
    };
  }

  root.HPNet = { create: create, clean: clean, ALPHA: ALPHA, CODE_LEN: LEN };
})(window);
