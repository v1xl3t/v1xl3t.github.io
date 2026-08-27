/* ============================================================
   race.js — the same deal, two people, one short code.

   Multiplayer for a game that has no opponent in it. Nobody
   touches anybody else's board. Both players are dealt the
   IDENTICAL deal from one seed and race it, and a strip along the
   top says how the other one is doing.

   That is the whole idea, and it is the right one for a solitaire
   for a reason worth writing down. Taking turns on a shared board
   sounds more social and plays worse, because one bad move dead
   ends a deal for both people and it is always somebody's fault.
   Racing keeps the game exactly as it is and adds the only thing
   it was missing, which is somebody to beat.

   THE PART THAT MAKES IT FAIR

     the seed. Every one of these games already deals from a seed
     and every one of them was already asserted to deal the same
     board twice from the same number. That was built for tests
     and it turns out to be the whole feature.

   WHAT A GAME HAS TO HAND OVER

     deal(seed, variant)   deal exactly that board
     variant()             the setting that changes the deal, the
                           draw count or the suit count or how many
                           passes. Raced boards must agree on it or
                           they are not the same deal
     progress()            { main, moves, done, stuck }
     total, label          what `main` counts, for the strip

   Nothing else. race.js never looks at a card.
   ============================================================ */
(function (root) {
  'use strict';

  var PROTO = 1;
  var TICK_MS = 250;         /* the fastest we will tell them anything */

  function create(opts) {
    var Net = root.HPNet.create({ tag: 'hpsr1-', max: 1, lib: opts.lib });
    var game = opts.game;
    var els = opts.els;
    var say = opts.say || function () {};

    var role = '';
    var open = false;
    var seed = 0;
    var them = null;           /* their last reported progress */
    var mine = null;
    var result = '';           /* '' | 'won' | 'lost' | 'draw' */
    var lastSent = 0;
    var sendTimer = null;

    /* ---------- what a person is told ---------- */
    function reasonText(reason) {
      if (reason === 'lib') return 'Racing could not start because its code did not load. The game itself is unaffected.';
      if (reason === 'nocode') return 'No race is waiting on that code. Check the letters, or ask for a fresh one.';
      if (reason === 'short') return 'That code looks too short. It is six characters.';
      if (reason === 'timeout') return 'That took too long. The other browser may have closed the race.';
      if (reason === 'game') return 'That code is for a different game. A race is one game and one deal, so both of you have to be on the same page.';
      if (reason === 'browser-incompatible') return 'This browser cannot make a direct connection. The game itself is unaffected.';
      if (reason === 'network' || reason === 'server-error' || reason === 'socket-error' || reason === 'socket-closed') {
        return 'The matchmaking service could not be reached. The game itself is unaffected.';
      }
      return 'The connection failed. The game itself is unaffected.';
    }

    function status(msg) { if (els.status) els.status.textContent = msg || ''; }

    function showRow(which) {
      els.start.hidden = which !== 'start';
      els.host.hidden = which !== 'host';
      els.join.hidden = which !== 'join';
      els.live.hidden = which !== 'live';
    }

    /* ---------- the strip ----------
       Two rows, you and them, and one line saying how it ended. It
       says a NUMBER rather than drawing a bar, because "nine cards
       home" is a thing you can act on and a bar three fifths full is
       not. */
    function paint() {
      if (!els.strip) return;
      els.strip.hidden = !open && !result;
      if (els.strip.hidden) return;

      mine = opts.progress();
      var rows = [
        { who: 'You', p: mine },
        { who: 'Them', p: them }
      ];
      els.strip.innerHTML = '';
      rows.forEach(function (r) {
        var row = document.createElement('div');
        row.className = 'racerow' + (r.p && r.p.done ? ' done' : '') + (r.p && r.p.stuck ? ' stuck' : '');
        var who = document.createElement('span');
        who.className = 'racewho';
        who.textContent = r.who;
        var main = document.createElement('b');
        main.className = 'racemain';
        main.textContent = r.p ? String(r.p.main) : '--';
        var of = document.createElement('span');
        of.className = 'raceof';
        of.textContent = opts.label + (r.p ? ' of ' + opts.total : '');
        var mv = document.createElement('span');
        mv.className = 'racemoves';
        mv.textContent = r.p ? r.p.moves + ' moves' : 'not started';
        row.appendChild(who); row.appendChild(main); row.appendChild(of); row.appendChild(mv);
        if (r.p && r.p.stuck) {
          var tag = document.createElement('span');
          tag.className = 'racetag';
          tag.textContent = 'out of moves';
          row.appendChild(tag);
        }
        els.strip.appendChild(row);
      });

      var line = document.createElement('p');
      line.className = 'raceline';
      if (result === 'won') line.textContent = 'You cleared it first.';
      else if (result === 'lost') line.textContent = 'They cleared it first.';
      else if (result === 'draw') line.textContent = 'Neither deal could be cleared. That one was the deal, not either of you.';
      else if (!them) line.textContent = 'Waiting for them to start.';
      else if (mine && them) {
        var d = mine.main - them.main;
        line.textContent = d === 0 ? 'Level.'
          : d > 0 ? 'You are ' + d + ' ahead.'
          : 'You are ' + (-d) + ' behind.';
      }
      els.strip.appendChild(line);
    }

    /* ---------- telling them where you are ----------
       Throttled, because a drag can fire several renders in a row and
       nobody needs to know about all of them. Anything that ENDS the
       race goes out immediately. */
    function tick(force) {
      if (!open) { paint(); return; }
      var p = opts.progress();
      var ending = p.done || p.stuck;
      var now = Date.now();
      if (!force && !ending && now - lastSent < TICK_MS) {
        if (!sendTimer) sendTimer = setTimeout(function () { sendTimer = null; tick(true); }, TICK_MS);
        paint();
        return;
      }
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
      lastSent = now;
      Net.send({ t: 'p', v: PROTO, main: p.main, moves: p.moves, done: !!p.done, stuck: !!p.stuck });
      if (ending) settle();
      paint();
    }

    /* Who won. The host decides, because two browsers each deciding
       for themselves is how you get two people both being told they
       won. */
    function settle() {
      if (result) return;
      var me = opts.progress();
      if (role !== 'host') return;
      var they = them || {};
      if (me.done && !they.done) declare('host');
      else if (they.done && !me.done) declare('guest');
      else if (me.done && they.done) declare('host');       /* ours arrived first */
      else if (me.stuck && they.stuck) declare('draw');
    }

    function declare(winner) {
      result = winner === 'draw' ? 'draw' : (winner === 'host' ? 'won' : 'lost');
      Net.send({ t: 'result', v: PROTO, winner: winner });
      announce();
      paint();
    }

    function announce() {
      if (result === 'won') say('You cleared it first.');
      else if (result === 'lost') say('They cleared it first.');
      else if (result === 'draw') say('Neither deal could be cleared.');
    }

    /* ---------- starting one ---------- */
    function startRace() {
      seed = (Date.now() ^ Math.floor(Math.random() * 0xffffff)) >>> 0;
      them = null;
      result = '';
      opts.deal(seed, opts.variant());
      Net.send({
        t: 'deal', v: PROTO, game: game, seed: seed,
        variant: opts.variant(), total: opts.total, label: opts.label
      });
      status('Same deal, both of you. First to clear it wins.');
      tick(true);
    }

    function onEvent(kind, data) {
      if (kind === 'code') {
        els.code.textContent = data;
        status('Read this code out. The race starts the moment they join.');
        return;
      }

      if (kind === 'open') {
        open = true;
        showRow('live');
        if (role === 'host') {
          startRace();
          say('They joined. Same deal, both of you.');
        } else {
          Net.send({ t: 'hello', v: PROTO, game: game });
          status('Connected. Waiting for the deal.');
        }
        paint();
        return;
      }

      if (kind === 'data') { onMessage(data); return; }

      if (kind === 'closed') {
        if (!open) return;
        open = false;
        status(result ? 'They left. The board is still here.'
          : 'They left before the race finished. The board is still here.');
        say('They left the race.');
        showRow('start');
        paint();
        return;
      }

      if (kind === 'error') {
        open = false;
        status(reasonText(data && data.reason));
        showRow('start');
        Net.close();
        role = '';
        paint();
      }
    }

    function onMessage(msg) {
      if (!msg || msg.v !== PROTO) return;

      if (msg.t === 'hello') {
        /* A code from another game finds a real table and the wrong
           one, so say which rather than letting them sit there. */
        if (msg.game !== game) {
          Net.send({ t: 'wrong', v: PROTO, game: game });
          status('Somebody tried to join with a code for a different game.');
        }
        return;
      }

      if (msg.t === 'wrong') { onEvent('error', { reason: 'game' }); return; }

      if (msg.t === 'deal') {
        if (msg.game !== game) { onEvent('error', { reason: 'game' }); return; }
        if (typeof msg.seed !== 'number' || !isFinite(msg.seed)) {
          status('That deal did not make sense, so it was ignored.');
          return;
        }
        seed = msg.seed >>> 0;
        them = null;
        result = '';
        opts.deal(msg.seed, msg.variant);
        status('Same deal, both of you. First to clear it wins.');
        tick(true);
        return;
      }

      if (msg.t === 'p') {
        /* Numbers from the wire, coerced. They are only ever painted
           with textContent so nothing can be smuggled in, but a string
           where a count should be reads as nonsense on the strip. */
        var num = function (n) {
          n = Math.round(Number(n));
          return isFinite(n) && n >= 0 ? n : 0;
        };
        them = { main: num(msg.main), moves: num(msg.moves), done: !!msg.done, stuck: !!msg.stuck };
        if (role === 'host') settle();
        paint();
        return;
      }

      if (msg.t === 'result') {
        result = msg.winner === 'draw' ? 'draw' : (msg.winner === 'guest' ? 'won' : 'lost');
        announce();
        paint();
        return;
      }
    }

    function leave(silent) {
      if (!silent) Net.send({ t: 'bye', v: PROTO });
      Net.close();
      open = false;
      role = '';
      them = null;
      result = '';
      showRow('start');
      status('');
      paint();
    }

    Net.on(onEvent);

    /* ---------- the buttons ---------- */
    function wire() {
      els.toggle.addEventListener('click', function () {
        if (Net.libFailed()) { say(reasonText('lib')); return; }
        var show = els.panel.hidden;
        els.panel.hidden = !show;
        els.toggle.setAttribute('aria-expanded', String(show));
        if (show && !role) showRow('start');
        if (opts.onResize) opts.onResize();
      });
      els.hostBtn.addEventListener('click', function () {
        role = 'host';
        showRow('host');
        els.code.textContent = '------';
        status('Starting a race.');
        Net.host();
      });
      els.joinShowBtn.addEventListener('click', function () {
        showRow('join');
        status('');
        els.codeIn.value = '';
        els.codeIn.focus();
      });
      els.joinBtn.addEventListener('click', function () {
        role = 'guest';
        status('Looking for that race.');
        Net.join(els.codeIn.value);
      });
      els.codeIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); els.joinBtn.click(); }
      });
      els.copyBtn.addEventListener('click', function () {
        var code = els.code.textContent;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(function () {
              status('Code copied. Read it out or paste it to them.');
            }, function () { status('Could not copy it. The code is ' + code + '.'); });
            return;
          }
        } catch (e) { /* fall through */ }
        status('Could not copy it. The code is ' + code + '.');
      });
      els.hostCancel.addEventListener('click', function () { leave(true); });
      els.joinCancel.addEventListener('click', function () { showRow('start'); status(''); });
      els.leaveBtn.addEventListener('click', function () { leave(false); });
      if (els.againBtn) {
        els.againBtn.addEventListener('click', function () {
          if (role !== 'host') { status('Whoever started the race deals the next one.'); return; }
          startRace();
        });
      }
    }

    wire();
    paint();

    return {
      tick: tick,
      racing: function () { return open; },
      role: function () { return role; },
      seed: function () { return seed; },
      them: function () { return them; },
      result: function () { return result; },
      leave: leave,
      libFailed: Net.libFailed
    };
  }

  root.HPRace = { create: create };
})(window);
