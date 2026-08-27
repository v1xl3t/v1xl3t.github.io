/* ============================================================
   Hearts for HACKING PARADISE.

   The odd one out on this table, and the reason it was built last.
   Every other game here is a board you rearrange. This one has three
   opponents, hidden hands, a passing round, and a scoring rule that
   inverts itself if you are brave enough, so almost nothing in
   sol-core applies. What it does still use is the part that was
   never about solitaire: the deck, the card, the store and the live
   region.

   There is deliberately NO undo. The other six games are you against
   a deal, and taking a move back costs nobody anything. Here a move
   back would mean unseeing three other hands, and a game that lets
   you retry a trick after watching how it went is not the game.

   The opponents are named Void, Promise and Abyss, which is what the
   table calls its sides in Reversi too. They are not people.

   Scoring is the whole shape of it. Thirteen hearts at one each and
   the queen of spades at thirteen make twenty six a hand. Take every
   single one of them and the twenty six goes to everybody else
   instead, which is the only move in any of these games where the
   worst possible hand and the best possible hand look identical
   right up until the last trick.
   ============================================================ */
(function () {
  'use strict';

  var C = window.HPCards;
  var K = window.HPSolCore;
  var YOU = 0;
  var SEATS = 4;
  var NAMES = ['You', 'Void', 'Promise', 'Abyss'];
  var WHERE = ['', 'on your left', 'across', 'on your right'];
  var QS = 'SQ';
  var C2 = 'C2';
  var PASS_DIRS = ['left', 'right', 'across', 'nobody'];
  var MOON = 26;

  var store = K.Store('hp-hearts-v1', 1);
  var S = null;
  var els = {};
  var say = function () {};
  var timer = null;

  /* ============================================================
     STATE
     ============================================================ */
  function freshHand(seed, handNo, scores) {
    var deck = K.shuffled(seed);
    var hands = [[], [], [], []];
    for (var i = 0; i < deck.length; i++) hands[i % SEATS].push(deck[i]);
    hands.forEach(sortHand);
    return {
      seed: seed,
      handNo: handNo,
      passDir: handNo % SEATS,          /* left, right, across, then nobody */
      hands: hands,
      taken: [[], [], [], []],
      scores: scores.slice(),
      trick: [],
      leader: -1,
      turn: -1,
      broken: false,
      picked: [],
      lastTrick: null,
      handScores: null,
      phase: 'pass',
      target: 100
    };
  }

  /* Suit blocks in a fixed order, ranks low to high inside them. The
     order never changes, because a hand that reshuffles itself between
     tricks makes a player hunt for a card they were already looking at. */
  var SUIT_ORDER = { C: 0, D: 1, S: 2, H: 3 };
  function sortHand(h) {
    h.sort(function (a, b) {
      var sa = SUIT_ORDER[K.suitOf(a)], sb = SUIT_ORDER[K.suitOf(b)];
      if (sa !== sb) return sa - sb;
      return hi(a) - hi(b);
    });
    return h;
  }

  /* ============================================================
     RULES
     ============================================================ */
  /* ---------- the ace is high ----------
     In every other game on this table the ace is one, because it is
     the card a foundation starts from, and HPSolCore.valOf says so.
     In Hearts it is the highest card in its suit, and reading valOf
     here made an ace lose a trick to a two. Nothing else notices,
     which is exactly why it survived a full audit of legal play: the
     points still totalled twenty six every hand, they just went to
     the wrong person.

     Everywhere rank is COMPARED in this file goes through here.
     Everywhere rank is only identified, like the queen of spades or
     the two of clubs, uses the id and does not care. */
  function hi(id) {
    var v = K.valOf(id);
    return v === 1 ? 14 : v;
  }

  function pointsOf(id) {
    if (id === QS) return 13;
    return K.suitOf(id) === 'H' ? 1 : 0;
  }

  function ledSuitIn(B) { return B.trick.length ? K.suitOf(B.trick[0].id) : null; }

  function hasSuit(hand, s) {
    for (var i = 0; i < hand.length; i++) if (K.suitOf(hand[i]) === s) return true;
    return false;
  }

  /* The four rules that make Hearts Hearts, in the order they bite:

       the two of clubs opens, and nothing else may
       follow the suit that was led if you can
       nothing that scores on the very first trick
       hearts may not be LED until one has been played

     Each of them has an "unless that is all you have" escape, and
     forgetting those is how a game deals a hand it will not let you
     play. */
  function legalIn(B, p) {
    var hand = B.hands[p];
    if (!hand.length) return [];
    var firstTrick = B.taken.every(function (t) { return !t.length; }) && B.trick.length < SEATS;

    if (!B.trick.length) {
      if (firstTrick) return hand.indexOf(C2) >= 0 ? [C2] : [];
      var nonHearts = hand.filter(function (id) { return K.suitOf(id) !== 'H'; });
      if (!B.broken && nonHearts.length) return nonHearts;
      return hand.slice();
    }

    var led = ledSuitIn(B);
    var following = hand.filter(function (id) { return K.suitOf(id) === led; });
    if (following.length) {
      /* On the very first trick even a card of the led suit may not
         score, unless every card you could follow with does. */
      if (firstTrick) {
        var safe = following.filter(function (id) { return !pointsOf(id); });
        if (safe.length) return safe;
      }
      return following;
    }

    if (firstTrick) {
      var clean = hand.filter(function (id) { return !pointsOf(id); });
      if (clean.length) return clean;
    }
    return hand.slice();
  }

  function legal(p) { return legalIn(S, p); }

  function trickWinner(trick) {
    var led = K.suitOf(trick[0].id);
    var best = trick[0];
    trick.forEach(function (t) {
      if (K.suitOf(t.id) === led && hi(t.id) > hi(best.id)) best = t;
    });
    return best.p;
  }

  function handPoints(taken) {
    return taken.map(function (cards) {
      return cards.reduce(function (a, id) { return a + pointsOf(id); }, 0);
    });
  }

  /* Take all twenty six and everybody else takes them instead. The
     rule is stated as "one player has the lot", not "one player has
     twenty six", because those are the same number and only one of
     them is the reason. */
  function settleScores(taken) {
    var raw = handPoints(taken);
    var shooter = -1;
    for (var i = 0; i < SEATS; i++) if (raw[i] === MOON) shooter = i;
    if (shooter < 0) return { add: raw, shooter: -1 };
    var add = [MOON, MOON, MOON, MOON];
    add[shooter] = 0;
    return { add: add, shooter: shooter };
  }

  /* ============================================================
     PASSING

     Left, right, across, then a hand where nobody passes, and round
     again. The fourth is not a rounding error, it is the hand where
     you are stuck with what you were dealt.
     ============================================================ */
  function passTargetOf(from, dir) {
    if (dir === 0) return (from + 1) % SEATS;        /* left */
    if (dir === 1) return (from + 3) % SEATS;        /* right */
    if (dir === 2) return (from + 2) % SEATS;        /* across */
    return from;                                      /* nobody */
  }

  function botPass(p) {
    var hand = S.hands[p].slice();
    var spades = hand.filter(function (id) { return K.suitOf(id) === 'S'; });
    var scored = hand.map(function (id) {
      var v = hi(id), s = K.suitOf(id), score = v;
      /* The queen is only a liability while you are short of the low
         spades that would have protected her. */
      if (id === QS) score = spades.length <= 3 ? 100 : 40;
      else if (s === 'S' && v > 12) score = spades.length <= 3 ? 90 : 45;
      else if (s === 'H') score = 30 + v;
      return { id: id, score: score };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 3).map(function (x) { return x.id; });
  }

  function doPass() {
    if (S.passDir === 3) { startPlay(); return; }
    var out = [S.picked.slice(), botPass(1), botPass(2), botPass(3)];
    var incoming = [[], [], [], []];
    for (var p = 0; p < SEATS; p++) {
      var to = passTargetOf(p, S.passDir);
      out[p].forEach(function (id) {
        var at = S.hands[p].indexOf(id);
        if (at >= 0) S.hands[p].splice(at, 1);
        incoming[to].push(id);
      });
    }
    for (var q = 0; q < SEATS; q++) {
      Array.prototype.push.apply(S.hands[q], incoming[q]);
      sortHand(S.hands[q]);
    }
    S.picked = [];
    var got = incoming[YOU].map(function (id) { return C.label(K.card(id)); }).join(', ');
    say('You passed three ' + PASS_DIRS[S.passDir] + ' and were given ' + got + '.');
    startPlay();
  }

  function startPlay() {
    for (var p = 0; p < SEATS; p++) {
      if (S.hands[p].indexOf(C2) >= 0) { S.leader = p; S.turn = p; }
    }
    S.phase = 'play';
    S.trick = [];
    render(); save();
    if (S.turn !== YOU) scheduleBot();
  }

  /* ============================================================
     PLAYING
     ============================================================ */
  function playCard(p, id) {
    var hand = S.hands[p];
    var at = hand.indexOf(id);
    if (at < 0) return false;
    if (legal(p).indexOf(id) < 0) return false;
    hand.splice(at, 1);
    S.trick.push({ p: p, id: id });
    if (K.suitOf(id) === 'H') S.broken = true;
    if (id === QS) S.broken = true;
    S.turn = (p + 1) % SEATS;
    return true;
  }

  function settleTrick() {
    if (S.trick.length !== SEATS) return false;
    var w = trickWinner(S.trick);
    var cards = S.trick.map(function (t) { return t.id; });
    Array.prototype.push.apply(S.taken[w], cards);
    var pts = cards.reduce(function (a, id) { return a + pointsOf(id); }, 0);
    S.lastTrick = { winner: w, cards: cards, points: pts };
    S.trick = [];
    S.leader = w;
    S.turn = w;
    if (!S.hands[YOU].length) endHand();
    return true;
  }

  function endHand() {
    var out = settleScores(S.taken);
    S.handScores = out;
    for (var i = 0; i < SEATS; i++) S.scores[i] += out.add[i];
    S.phase = S.scores.some(function (n) { return n >= S.target; }) ? 'gameover' : 'handover';
    S.turn = -1;
  }

  function nextHand() {
    var seed = (S.seed * 1103515245 + 12345) >>> 0;
    var scores = S.scores.slice();
    var handNo = S.handNo + 1;
    S = freshHand(seed, handNo, scores);
    if (S.passDir === 3) startPlay();
    else { render(); save(); }
  }

  function newGame(seed) {
    stopBots();
    S = freshHand(seed != null ? seed : (Date.now() ^ Math.floor(Math.random() * 0xffffff)) >>> 0,
      0, [0, 0, 0, 0]);
    render(); save();
  }

  /* ============================================================
     THE OPPONENTS

     Good enough to punish a careless hand and no better. They can
     see only their own cards and what has been played, same as you,
     which is not a courtesy but the only version worth playing
     against. A bot that reads your hand and then loses on purpose is
     worse company than one that is simply beatable.
     ============================================================ */
  function seen(B) {
    var out = {};
    B.taken.forEach(function (cards) { cards.forEach(function (id) { out[id] = 1; }); });
    B.trick.forEach(function (t) { out[t.id] = 1; });
    return out;
  }

  function queenGone(B) { return !!seen(B)[QS]; }

  function botChoice(p) {
    var options = legalIn(S, p);
    if (options.length === 1) return options[0];
    var led = ledSuitIn(S);
    var hand = S.hands[p];

    if (!led) {
      /* Leading. Low is safe. Leading a spade below the queen while
         she is still out there is how you make somebody else take her. */
      var lead = options.slice().sort(function (a, b) { return hi(a) - hi(b); });
      if (!queenGone(S) && hand.indexOf(QS) < 0) {
        var lowSpade = lead.filter(function (id) {
          return K.suitOf(id) === 'S' && hi(id) < 12;
        })[0];
        if (lowSpade) return lowSpade;
      }
      var notSpade = lead.filter(function (id) { return K.suitOf(id) !== 'S'; });
      return (notSpade[0] || lead[0]);
    }

    var following = options.filter(function (id) { return K.suitOf(id) === led; });
    var pot = S.trick.reduce(function (a, t) { return a + pointsOf(t.id); }, 0);
    var last = S.trick.length === SEATS - 1;

    if (following.length) {
      var high = S.trick.filter(function (t) { return K.suitOf(t.id) === led; })
        .reduce(function (a, t) { return Math.max(a, hi(t.id)); }, 0);
      var under = following.filter(function (id) { return hi(id) < high; });
      /* Last to play and the trick is clean, so take it with the
         highest card that still wins and get the lead back. */
      if (last && pot === 0) {
        var winners = following.filter(function (id) { return hi(id) > high; });
        if (winners.length) return winners[winners.length - 1];
      }
      if (under.length) return under[under.length - 1];      /* duck as high as safely possible */
      return following[0];                                    /* have to overtake, do it cheaply */
    }

    /* Void in the led suit, so this is a free discard. The queen goes
       first, then the high spades that might be forced to take her,
       then the highest heart, then the highest anything. */
    if (options.indexOf(QS) >= 0) return QS;
    var bigSpade = options.filter(function (id) {
      return K.suitOf(id) === 'S' && hi(id) > 12;
    }).sort(function (a, b) { return hi(b) - hi(a); })[0];
    if (bigSpade && !queenGone(S)) return bigSpade;
    var hearts = options.filter(function (id) { return K.suitOf(id) === 'H'; })
      .sort(function (a, b) { return hi(b) - hi(a); });
    if (hearts.length) return hearts[0];
    return options.slice().sort(function (a, b) { return hi(b) - hi(a); })[0];
  }

  function stopBots() { if (timer) { clearTimeout(timer); timer = null; } }

  function scheduleBot() {
    stopBots();
    timer = setTimeout(step, 520);
  }

  /* One beat of the table. Kept as a single function so the test can
     drive it without waiting for the clock. */
  function step() {
    timer = null;
    if (S.phase !== 'play') return;
    if (S.trick.length === SEATS) {
      settleTrick();
      render(); save();
      if (S.phase === 'play' && S.turn !== YOU) scheduleBot();
      return;
    }
    if (S.turn === YOU) { render(); return; }
    playCard(S.turn, botChoice(S.turn));
    render(); save();
    if (S.trick.length === SEATS) { timer = setTimeout(step, 900); return; }
    if (S.turn !== YOU) scheduleBot();
  }

  /* ============================================================
     RENDER
     ============================================================ */
  /* ---------- sizing ----------
     Same problem Pyramid has and the same answer. sol-core sizes to
     the WIDTH, and this table is four seats deep plus a hand of
     thirteen, so a width-sized card puts your own hand below the fold
     on the one game where your hand is the only thing you control.

     The board is four cards tall in total, three for the diamond of
     the trick and one for the hand, plus about a hundred and forty
     pixels of seats, labels and gaps. Solve for that and never go
     above what the width would have allowed anyway. */
  function sizeFor() {
    var size = K.sizeBoard(els.board, 8);
    var top = els.board.getBoundingClientRect().top;
    var avail = Math.max(360, window.innerHeight - top - 20);
    /* Two cards tall in total now, one for the trick and one for the
       hand, plus about two hundred pixels of seats, labels and gaps. */
    var ch = Math.floor((avail - 200) / 2);
    ch = Math.max(56, Math.min(size.ch, ch));
    var cw = Math.max(34, Math.round(ch / 1.4));
    ch = Math.round(cw * 1.4);
    els.board.style.setProperty('--cw', cw + 'px');
    els.board.style.setProperty('--ch', ch + 'px');
    return { cw: cw, ch: ch, gap: size.gap };
  }

  function render() {
    var size = sizeFor();

    /* --- the seats --- */
    for (var p = 1; p < SEATS; p++) {
      var seat = els.seats[p];
      seat.querySelector('.seat-n').textContent = String(S.hands[p].length);
      seat.querySelector('.seat-pts').textContent = String(
        S.taken[p].reduce(function (a, id) { return a + pointsOf(id); }, 0));
      seat.classList.toggle('turn', S.turn === p && S.phase === 'play');
    }
    els.youPts.textContent = String(
      S.taken[YOU].reduce(function (a, id) { return a + pointsOf(id); }, 0));
    els.youSeat.classList.toggle('turn', S.turn === YOU && S.phase === 'play');

    /* --- the trick --- */
    els.trick.innerHTML = '';
    for (var i = 0; i < SEATS; i++) {
      var slot = document.createElement('div');
      slot.className = 'trickslot';
      var played = null;
      S.trick.forEach(function (t) { if (t.p === i) played = t; });
      if (played) {
        var node = C.play(K.card(played.id));
        if (S.trick.length && K.suitOf(played.id) === ledSuitIn(S)) node.classList.add('inled');
        slot.appendChild(node);
      }
      var tag = document.createElement('span');
      tag.className = 'trickwho';
      tag.textContent = i === YOU ? 'You' : NAMES[i];
      slot.appendChild(tag);
      els.trick.appendChild(slot);
    }

    /* --- your hand --- */
    els.hand.innerHTML = '';
    var playable = S.phase === 'play' && S.turn === YOU ? legal(YOU) : [];
    S.hands[YOU].forEach(function (id) {
      var node = C.play(K.card(id), { tag: 'button' });
      node.dataset.card = id;
      if (S.phase === 'pass') {
        if (S.picked.indexOf(id) >= 0) node.classList.add('picked');
      } else if (S.phase === 'play') {
        if (S.turn === YOU) {
          if (playable.indexOf(id) >= 0) node.classList.add('free');
          else node.classList.add('barred');
        }
      }
      els.hand.appendChild(node);
    });
    fanHand(size);

    /* --- the bars --- */
    els.passbar.hidden = S.phase !== 'pass';
    if (S.phase === 'pass') {
      els.passWhy.textContent = 'Choose three cards to pass ' + PASS_DIRS[S.passDir] + '.';
      els.passBtn.textContent = 'Pass three ' + PASS_DIRS[S.passDir];
      els.passBtn.disabled = S.picked.length !== 3;
      els.passCount.textContent = S.picked.length + ' of 3 chosen';
    }

    els.overbar.hidden = S.phase !== 'handover' && S.phase !== 'gameover';
    if (!els.overbar.hidden) {
      var hs = S.handScores;
      var line;
      if (hs.shooter >= 0) {
        line = (hs.shooter === YOU ? 'You shot the moon.' : NAMES[hs.shooter] + ' shot the moon.') +
          ' Twenty six to everyone else.';
      } else {
        line = 'This hand, ' + [0, 1, 2, 3].map(function (i) {
          return (i === YOU ? 'you' : NAMES[i]) + ' ' + hs.add[i];
        }).join(', ') + '.';
      }
      els.overWhy.textContent = line;
      if (S.phase === 'gameover') {
        var low = Math.min.apply(null, S.scores);
        var winners = [0, 1, 2, 3].filter(function (i) { return S.scores[i] === low; });
        els.overTitle.textContent = winners.indexOf(YOU) >= 0 && winners.length === 1
          ? 'You win' : (winners.length > 1 ? 'A tie at the bottom' : NAMES[winners[0]] + ' wins');
        els.overBtn.textContent = 'New game';
      } else {
        els.overTitle.textContent = 'Hand ' + (S.handNo + 1) + ' finished';
        els.overBtn.textContent = 'Next hand';
      }
    }

    /* --- the scoreboard --- */
    for (var q = 0; q < SEATS; q++) els.score[q].textContent = String(S.scores[q]);
    els.handNo.textContent = String(S.handNo + 1);
    els.brokenTag.textContent = S.broken ? 'broken' : 'not yet';

    els.lastLine.textContent = S.lastTrick
      ? (S.lastTrick.winner === YOU ? 'You took' : NAMES[S.lastTrick.winner] + ' took') +
        ' the last trick' + (S.lastTrick.points ? ' and ' + S.lastTrick.points + ' point' +
        (S.lastTrick.points === 1 ? '' : 's') : ', clean') + '.'
      : '';
  }

  /* Thirteen cards across a phone is narrower than a card, so the hand
     overlaps and the overlap is worked out from what is actually
     there rather than assumed. The last card is always whole. */
  function fanHand(size) {
    var n = S.hands[YOU].length;
    els.hand.style.setProperty('--cw', size.cw + 'px');
    els.hand.style.setProperty('--ch', size.ch + 'px');
    if (!n) { els.hand.style.height = '0px'; return; }
    /* The hand's own width is set below from this number, so reading it
       back here would be asking a question whose answer depends on the
       answer. Measure the board. */
    var room = els.board.clientWidth;
    var step = Math.min(size.cw + 6, Math.floor((room - size.cw) / Math.max(1, n - 1)));
    step = Math.max(Math.round(size.cw * 0.34), step);
    var kids = els.hand.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].style.left = (i * step) + 'px';
      kids[i].style.zIndex = String(i + 1);
    }
    els.hand.style.height = (size.ch + 10) + 'px';
    els.hand.style.width = ((n - 1) * step + size.cw) + 'px';
  }

  /* ============================================================
     INPUT
     ============================================================ */
  function tapCard(id) {
    if (S.phase === 'pass') {
      var at = S.picked.indexOf(id);
      if (at >= 0) S.picked.splice(at, 1);
      else if (S.picked.length < 3) S.picked.push(id);
      else { say('Three is all you may pass. Tap one of the chosen to swap it.'); return; }
      render();
      return;
    }
    if (S.phase !== 'play') return;
    if (S.turn !== YOU) { say('Wait for your turn.'); return; }
    if (legal(YOU).indexOf(id) < 0) { say(whyNot(id)); return; }
    playCard(YOU, id);
    render(); save();
    if (S.trick.length === SEATS) { timer = setTimeout(step, 900); return; }
    scheduleBot();
  }

  /* A card refusing to be played without saying why is the single most
     confusing thing in Hearts for anybody who has not played it, and
     all four reasons are rules rather than bugs. */
  function whyNot(id) {
    var firstTrick = S.taken.every(function (t) { return !t.length; }) && S.trick.length < SEATS;
    if (!S.trick.length) {
      if (firstTrick) return 'The two of clubs opens the hand.';
      if (K.suitOf(id) === 'H' && !S.broken) {
        return 'Hearts have not been broken yet, so they cannot be led.';
      }
    } else {
      var led = ledSuitIn(S);
      if (hasSuit(S.hands[YOU], led) && K.suitOf(id) !== led) {
        return 'You have to follow ' + C.suit(led).name.toLowerCase() + '.';
      }
    }
    if (firstTrick && pointsOf(id)) return 'Nothing that scores can go on the first trick.';
    return 'That one cannot be played right now.';
  }

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  function save() { store.write(S); }

  function load() {
    var o = store.read();
    if (!o || !o.hands || o.hands.length !== SEATS) return false;
    S = o;
    if (!S.picked) S.picked = [];
    return true;
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function boot() {
    els.board = document.getElementById('board');
    els.trick = document.getElementById('trick');
    els.hand = document.getElementById('hand');
    els.seats = [null];
    for (var p = 1; p < SEATS; p++) els.seats.push(document.querySelector('.seat[data-seat="' + p + '"]'));
    els.youSeat = document.querySelector('.seat[data-seat="0"]');
    els.youPts = document.querySelector('.seat[data-seat="0"] .seat-pts');
    els.score = [0, 1, 2, 3].map(function (i) { return document.getElementById('score' + i); });
    els.handNo = document.getElementById('handNo');
    els.brokenTag = document.getElementById('brokenTag');
    els.lastLine = document.getElementById('lastLine');
    els.live = document.getElementById('live');
    els.newBtn = document.getElementById('newBtn');
    els.passbar = document.getElementById('passbar');
    els.passWhy = document.getElementById('passWhy');
    els.passBtn = document.getElementById('passBtn');
    els.passCount = document.getElementById('passCount');
    els.overbar = document.getElementById('overbar');
    els.overTitle = document.getElementById('overTitle');
    els.overWhy = document.getElementById('overWhy');
    els.overBtn = document.getElementById('overBtn');

    say = K.Speaker(els.live);

    if (!load()) newGame();
    else {
      render();
      if (S.phase === 'play' && S.turn !== YOU) scheduleBot();
    }

    els.hand.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.hpc') : null;
      if (card && card.dataset.card) tapCard(card.dataset.card);
    });

    els.newBtn.addEventListener('click', function () { newGame(); say('New game dealt.'); });
    els.passBtn.addEventListener('click', function () {
      if (S.picked.length === 3) { doPass(); }
    });
    els.overBtn.addEventListener('click', function () {
      if (S.phase === 'gameover') newGame();
      else nextHand();
    });

    var rt = null;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(render, 120); });
  }

  window.HPHearts = {
    get state() { return S; },
    deal: function (seed) { newGame(seed); },
    forceState: function (o) {
      stopBots();
      Object.keys(o).forEach(function (k) { S[k] = o[k]; });
      if (o.hands) S.hands.forEach(sortHand);
      render(); save();
    },
    legal: legal,
    play: function (id) { var r = playCard(YOU, id); if (r) { render(); save(); } return r; },
    playFor: function (p, id) { var r = playCard(p, id); if (r) { render(); save(); } return r; },
    botChoice: botChoice,
    botPlay: function () { var id = botChoice(S.turn); return playCard(S.turn, id) ? id : null; },
    settleTrick: function () { var r = settleTrick(); render(); save(); return r; },
    trickWinner: trickWinner,
    rankHigh: hi,
    pointsOf: pointsOf,
    handPoints: function () { return handPoints(S.taken); },
    settleScores: settleScores,
    passTargetOf: passTargetOf,
    pick: function (id) { tapCard(id); },
    doPass: function () { doPass(); },
    nextHand: nextHand,
    /* Run the table with no waiting, so a test can play a whole hand. */
    fastForward: function (limit) {
      stopBots();
      var guard = 0;
      while (S.phase === 'play' && guard++ < (limit || 400)) {
        if (S.trick.length === SEATS) { settleTrick(); continue; }
        if (S.turn === YOU) break;
        playCard(S.turn, botChoice(S.turn));
      }
      render(); save();
      return S.phase;
    },
    autoPlayYou: function () {
      var opts = legal(YOU);
      return opts.length ? playCard(YOU, opts[0]) : false;
    },
    clearSave: function () { store.clear(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
