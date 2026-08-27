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
  /* Which seat this browser drives. Zero on your own, and whatever the
     host deals you online, which is why it is a variable and not the
     constant it started as. */
  var mySeat = 0;
  var SEATS = 4;

  /* The names belong to the SEATS, not to the players, so everybody at
     the table sees the same four and two people can talk about a hand
     without working out whose left is whose. Your own seat is drawn as
     "You" wherever you happen to be sitting.

     Two below and two above, which is the table this game is played on. */
  var SEAT_NAMES = ['Void', 'Abyss', 'Promise', 'Paradise'];

  /* Each seat carries a suit, and the pairing is the founding poem.
     Void and Abyss are the black suits, below. Promise and Paradise
     are the red ones, above. Vi picked it and it lands exactly on the
     split the poem already had. */
  var SEAT_SUITS = ['S', 'C', 'H', 'D'];

  /* Put a seat's glyph in front of its name. Rebuilt rather than
     moved, because the same seat appears in two places at once and one
     node cannot be in both. */
  function glyphInto(el, seat) {
    if (!window.HPGlyphs) return;
    var old = el.querySelector('.hpg');
    if (old) old.remove();
    var g = window.HPGlyphs.make(SEAT_SUITS[seat]);
    if (g) el.insertBefore(g, el.firstChild);
  }
  var WHERE = ['', 'on your left', 'across', 'on your right'];

  /* Your own seat is always "You", wherever you are sitting, and the
     other three keep their own names so two people at the same table
     can talk about a hand without working out whose left is whose. */
  function nameOf(p) { return p === mySeat ? 'You' : SEAT_NAMES[p]; }
  function lowerNameOf(p) { return p === mySeat ? 'you' : SEAT_NAMES[p]; }
  /* Where a seat sits relative to yours. Offset one is on your left,
     whichever chair you happen to be in. */
  function seatAtOffset(off) { return (mySeat + off) % SEATS; }
  var QS = 'SQ';
  var C2 = 'C2';
  var PASS_DIRS = ['left', 'right', 'across', 'nobody'];
  var MOON = 26;

  var store = K.Store('hp-hearts-v1', 1);
  var S = null;
  var els = {};
  var say = function () {};
  var timer = null;

  /* ---------- online ----------
     The host holds the whole game and is the only authority. Guests
     send what they would like to do and are told what happened. A seat
     with nobody in it is played by the computer, and a seat somebody
     leaves goes back to being played by the computer rather than
     ending everyone else's game. */
  var Net = window.HPNet.create({ tag: 'hphe1-', max: 3 });
  var netRole = '';           /* 'host' | 'guest' | '' */
  var netOpen = false;
  var seatOf = {};            /* peer id  ->  seat number, host only */
  var peerAt = [null, null, null, null];   /* seat -> peer id, host only */
  var wantPass = [null, null, null, null]; /* what each human chose to pass */

  function online() { return netOpen && !!netRole; }
  function iAmHost() { return netRole === 'host'; }
  /* Bots run in exactly one browser, the one that owns the game. On
     your own that is you. Online it is the host, and a guest that ran
     them too would be playing a second game nobody can see. */
  function iDriveTheTable() { return !online() || iAmHost(); }
  function seatIsPerson(p) { return !!(S && S.seatKind && S.seatKind[p] === 'person'); }

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
      given: null,
      /* Who is a person and who is the computer, kept in the state
         because a guest cannot work it out and has to be told. */
      seatKind: ['person', 'bot', 'bot', 'bot'],
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

  /* A guest holds its own cards and nobody else's, so asking what
     another seat may play has no honest answer and gets none. */
  function legal(p) {
    if (online() && !iAmHost() && p !== mySeat) return [];
    return legalIn(S, p);
  }

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

  /* One seat has chosen its three. On your own that is only ever you.
     Online every person at the table chooses at the same time, and
     nobody's cards move until the last of them has, so the round does
     not turn into three people watching one person think. */
  function submitPass(seat, ids) {
    if (!iDriveTheTable()) return false;
    if (S.phase !== 'pass' || S.passDir === 3) return false;
    if (!Array.isArray(ids) || ids.length !== 3) return false;
    /* A guest could send anything. Only cards that are actually in that
       seat's hand, and no card twice. */
    var hand = S.hands[seat];
    var seen = {};
    for (var i = 0; i < 3; i++) {
      if (hand.indexOf(ids[i]) < 0 || seen[ids[i]]) return false;
      seen[ids[i]] = 1;
    }
    wantPass[seat] = ids.slice();
    if (seat === mySeat) S.picked = ids.slice();
    tryPass();
    return true;
  }

  function waitingOn() {
    var n = 0;
    for (var p = 0; p < SEATS; p++) if (seatIsPerson(p) && !wantPass[p]) n++;
    return n;
  }

  function tryPass() {
    if (!iDriveTheTable()) return;
    if (S.passDir === 3) { clearPicks(); startPlay(); return; }
    if (waitingOn() > 0) { render(); save(); pushState(); return; }

    var out = [];
    for (var p = 0; p < SEATS; p++) out.push(wantPass[p] || botPass(p));
    var incoming = [[], [], [], []];
    for (var a = 0; a < SEATS; a++) {
      var to = passTargetOf(a, S.passDir);
      /* Captured per seat, because the closure below runs after the
         loop variable has moved on. */
      (function (from, dest, cards) {
        cards.forEach(function (id) {
          var at = S.hands[from].indexOf(id);
          if (at >= 0) S.hands[from].splice(at, 1);
          incoming[dest].push(id);
        });
      })(a, to, out[a]);
    }
    for (var q = 0; q < SEATS; q++) {
      Array.prototype.push.apply(S.hands[q], incoming[q]);
      sortHand(S.hands[q]);
    }
    clearPicks();
    S.given = incoming.map(function (cards) { return cards.slice(); });
    sayGiven();
    startPlay();
  }

  function clearPicks() {
    S.picked = [];
    wantPass = [null, null, null, null];
  }

  function sayGiven() {
    if (!S.given || !S.given[mySeat]) return;
    var got = S.given[mySeat].map(function (id) { return C.label(K.card(id)); }).join(', ');
    say('You passed three ' + PASS_DIRS[S.passDir] + ' and were given ' + got + '.');
  }

  /* What the Pass button does. A guest asks, the host decides. */
  function doPass() {
    if (S.passDir === 3) { if (iDriveTheTable()) { clearPicks(); startPlay(); } return; }
    if (S.picked.length !== 3) return;
    if (online() && !iAmHost()) {
      wantPass[mySeat] = S.picked.slice();
      Net.send({ t: 'pass', v: PROTO, ids: S.picked.slice() });
      render();
      return;
    }
    submitPass(mySeat, S.picked.slice());
  }

  function startPlay() {
    for (var p = 0; p < SEATS; p++) {
      if (S.hands[p].indexOf(C2) >= 0) { S.leader = p; S.turn = p; }
    }
    S.phase = 'play';
    S.trick = [];
    render(); save(); pushState();
    if (!seatIsPerson(S.turn)) scheduleBot();
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
    if (!S.hands[mySeat].length) endHand();
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
    var kinds = S.seatKind.slice();
    S = freshHand(seed, handNo, scores);
    S.seatKind = kinds.slice();
    wantPass = [null, null, null, null];
    if (S.passDir === 3) startPlay();
    else { render(); save(); pushState(); }
  }

  function newGame(seed) {
    stopBots();
    var kinds = S ? S.seatKind.slice() : ['person', 'bot', 'bot', 'bot'];
    S = freshHand(seed != null ? seed : (Date.now() ^ Math.floor(Math.random() * 0xffffff)) >>> 0,
      0, [0, 0, 0, 0]);
    S.seatKind = kinds;
    wantPass = [null, null, null, null];
    render(); save(); pushState();
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
    if (!iDriveTheTable()) return;
    timer = setTimeout(step, 520);
  }

  /* One beat of the table. Kept as a single function so the test can
     drive it without waiting for the clock. */
  function step() {
    timer = null;
    if (!iDriveTheTable()) return;
    if (S.phase !== 'play') return;
    if (S.trick.length === SEATS) {
      settleTrick();
      render(); save(); pushState();
      if (S.phase === 'play' && !seatIsPerson(S.turn)) scheduleBot();
      return;
    }
    if (seatIsPerson(S.turn)) { render(); pushState(); return; }
    playCard(S.turn, botChoice(S.turn));
    render(); save(); pushState();
    if (S.trick.length === SEATS) { timer = setTimeout(step, 900); return; }
    if (!seatIsPerson(S.turn)) scheduleBot();
  }

  /* ============================================================
     ONLINE

     Host authoritative, and the shape is the same one Reversi uses.
     The host holds the only real game. Guests send what they would
     like to do and are told what happened, so there is exactly one
     copy of the rules running and two browsers can never disagree
     about a board.

     What makes this different from Reversi is that the cards are
     hidden, so the state cannot simply be broadcast. Every guest is
     sent the public half plus its OWN hand and nothing else, which is
     what net-core's sendTo exists for. What is public is genuinely
     public: the trick on the table, every card already taken, the
     scores, and how many cards each seat is holding. Nothing else
     leaves the host.

     A seat nobody is sitting in is played by the computer. A seat
     somebody leaves goes back to being played by the computer rather
     than ending the game for the other three, which is the only
     answer that is fair to the people still there.
     ============================================================ */
  var PROTO = 1;
  var HIDDEN = '__';        /* a card a guest is not allowed to see */

  function packPublic() {
    return {
      handNo: S.handNo, passDir: S.passDir, phase: S.phase,
      scores: S.scores.slice(),
      taken: S.taken.map(function (t) { return t.slice(); }),
      trick: S.trick.map(function (t) { return { p: t.p, id: t.id }; }),
      leader: S.leader, turn: S.turn, broken: S.broken,
      handScores: S.handScores, lastTrick: S.lastTrick,
      seatKind: S.seatKind.slice(),
      sizes: S.hands.map(function (h) { return h.length; }),
      waiting: waitingOn(),
      target: S.target
    };
  }

  function pushState() {
    if (!online() || !iAmHost()) return;
    var pub = packPublic();
    for (var p = 0; p < SEATS; p++) {
      var id = peerAt[p];
      if (!id) continue;
      Net.sendTo(id, {
        t: 'state', v: PROTO, seat: p, pub: pub,
        hand: S.hands[p].slice(),
        given: S.given ? S.given[p] : null
      });
    }
  }

  /* ---------- everything from the wire is suspect ----------
     Not because a friend you read six letters to is going to attack
     you, but because the rank lookups take a card id on trust and
     throw on anything else, so one malformed message is a crashed
     page rather than a bad move. Cheap to check, and it turns a whole
     class of "the game just died" into a line in the status area.

     Nothing here is a defense against a HOST who cheats. A host can
     see every hand and there is no fixing that without a server. This
     only stops a bad message wrecking the page. */
  function cardsOnly(a) {
    return Array.isArray(a) ? a.filter(K.isCardId) : [];
  }
  function intIn(n, lo, hi, fallback) {
    n = Math.round(Number(n));
    return (isFinite(n) && n >= lo && n <= hi) ? n : fallback;
  }
  var PHASES = { pass: 1, play: 1, handover: 1, gameover: 1 };

  function sane(msg) {
    var pub = msg && msg.pub;
    if (!pub) return false;
    if (!PHASES[pub.phase]) return false;
    if (!Array.isArray(pub.sizes) || pub.sizes.length !== SEATS) return false;
    if (!Array.isArray(pub.taken) || pub.taken.length !== SEATS) return false;
    if (!Array.isArray(pub.scores) || pub.scores.length !== SEATS) return false;
    if (!Array.isArray(pub.seatKind) || pub.seatKind.length !== SEATS) return false;
    if (intIn(msg.seat, 0, SEATS - 1, -1) < 0) return false;
    return true;
  }

  function applyState(msg) {
    if (!sane(msg)) {
      netStatus('That message from the table did not make sense, so it was ignored.');
      return;
    }
    var pub = msg.pub;
    mySeat = intIn(msg.seat, 0, SEATS - 1, 0);
    S.handNo = intIn(pub.handNo, 0, 9999, 0);
    S.passDir = intIn(pub.passDir, 0, 3, 0);
    S.phase = pub.phase;
    S.scores = pub.scores.map(function (n) { return intIn(n, -999, 9999, 0); });
    S.taken = pub.taken.map(cardsOnly);
    S.trick = (Array.isArray(pub.trick) ? pub.trick : []).filter(function (t) {
      return t && K.isCardId(t.id) && intIn(t.p, 0, SEATS - 1, -1) >= 0;
    }).map(function (t) { return { p: intIn(t.p, 0, SEATS - 1, 0), id: t.id }; });
    S.leader = intIn(pub.leader, -1, SEATS - 1, -1);
    S.turn = intIn(pub.turn, -1, SEATS - 1, -1);
    S.broken = !!pub.broken;
    S.handScores = pub.handScores || null;
    S.lastTrick = pub.lastTrick || null;
    S.seatKind = pub.seatKind.map(function (k) { return k === 'person' ? 'person' : 'bot'; });
    S.target = intIn(pub.target, 1, 9999, 100);
    S.waiting = intIn(pub.waiting, 0, SEATS, 0);
    var myHand = cardsOnly(msg.hand);
    S.hands = pub.sizes.map(function (n, p) {
      if (p === mySeat) return myHand;
      var out = [];
      var many = intIn(n, 0, 52, 0);
      for (var i = 0; i < many; i++) out.push(HIDDEN);
      return out;
    });
    /* Picks are the guest's own business and the host never sends them
       back, so anything still chosen here is only cleared when the
       passing round is over. */
    if (S.phase !== 'pass') { S.picked = []; wantPass = [null, null, null, null]; }
    if (msg.given) {
      S.given = [];
      S.given[mySeat] = cardsOnly(msg.given);
      sayGiven();
      S.given = null;
    }
    render();
  }

  function seatFor(peerId) {
    if (seatOf[peerId] != null) return seatOf[peerId];
    for (var p = 1; p < SEATS; p++) {
      if (peerAt[p] == null) {
        peerAt[p] = peerId;
        seatOf[peerId] = p;
        S.seatKind[p] = 'person';
        return p;
      }
    }
    return -1;
  }

  function freeSeat(peerId) {
    var p = seatOf[peerId];
    if (p == null) return;
    peerAt[p] = null;
    delete seatOf[peerId];
    S.seatKind[p] = 'bot';
    wantPass[p] = null;
  }

  function seatsTaken() {
    var n = 0;
    for (var p = 0; p < SEATS; p++) if (S.seatKind[p] === 'person') n++;
    return n;
  }

  /* Every reason the transport can hand back, said the way a person
     would say it. An unknown reason still gets a sentence rather than
     a code, because a code helps nobody sitting at the table. */
  function reasonText(reason) {
    if (reason === 'lib') return 'Online play could not start because its code did not load. The game against the computer still works.';
    if (reason === 'nocode') return 'No table is waiting on that code. Check the letters, or ask for a fresh one.';
    if (reason === 'short') return 'That code looks too short. It is six characters.';
    if (reason === 'timeout') return 'That took too long. The other browser may have closed the table.';
    if (reason === 'browser-incompatible') return 'This browser cannot make a direct connection. The game against the computer still works.';
    if (reason === 'network' || reason === 'server-error' || reason === 'socket-error' || reason === 'socket-closed') {
      return 'The matchmaking service could not be reached. The game against the computer still works.';
    }
    return 'The connection failed. The game against the computer still works.';
  }

  function netStatus(msg) { if (els.netStatus) els.netStatus.textContent = msg || ''; }

  function netEvent(kind, data, from) {
    if (kind === 'code') {
      els.codeOut.textContent = data;
      netStatus('Read this code out. Up to three others can join, and the computer plays any seat still empty.');
      return;
    }

    if (kind === 'open') {
      netOpen = true;
      if (iAmHost()) {
        var seat = seatFor(data.id);
        if (seat < 0) return;
        /* Nobody has committed to a hand yet, so deal a fresh one and
           everybody starts together. Joining later means taking over
           the seat the computer was playing, mid hand. */
        if (S.phase === 'pass' && waitingOn() === seatsTaken()) newGame(S.seed);
        showNetRow('live');
        netStatus(seatsTaken() + ' of 4 seats have somebody in them. The computer plays the rest.');
        say('Somebody joined and took ' + SEAT_NAMES[seat] + '.');
        render(); pushState();
      } else {
        Net.send({ t: 'hi', v: PROTO });
        netStatus('Connected. Waiting for the table.');
        showNetRow('live');
        render();
      }
      return;
    }

    if (kind === 'data') { onMessage(data, from); return; }

    if (kind === 'closed') {
      if (iAmHost()) {
        var left = seatOf[data.id];
        freeSeat(data.id);
        if (left != null) {
          netStatus(seatsTaken() + ' of 4 seats have somebody in them. The computer took ' + SEAT_NAMES[left] + ' back.');
          say('Somebody left. The computer is playing ' + SEAT_NAMES[left] + ' now.');
        }
        if (!Net.isOpen()) netOpen = Net.isOpen();
        render(); pushState();
        /* Their seat is a bot now, so if it was their turn the table
           has to start moving again on its own. */
        if (S.phase === 'play' && !seatIsPerson(S.turn)) scheduleBot();
        return;
      }
      if (!netOpen) return;
      netStatus('The table closed. Start your own, or play the computer.');
      say('The table closed.');
      showNetRow('start');
      goSolo();
      return;
    }

    if (kind === 'error') {
      netStatus(reasonText(data && data.reason));
      showNetRow('start');
      Net.close();
      goSolo();
    }
  }

  function onMessage(msg, from) {
    if (!msg || msg.v !== PROTO) return;

    if (iAmHost()) {
      var seat = seatOf[from];
      if (seat == null) return;
      if (msg.t === 'hi') { pushState(); return; }
      if (msg.t === 'pass') { submitPass(seat, msg.ids); return; }
      if (msg.t === 'play') {
        /* The host runs the rules. A guest asking for a card it may not
           play is told nothing changed, which is what a guest who has
           fallen behind by one message looks like. */
        if (S.phase !== 'play' || S.turn !== seat) { pushState(); return; }
        if (!playCard(seat, msg.id)) { pushState(); return; }
        render(); save(); pushState();
        if (S.trick.length === SEATS) { timer = setTimeout(step, 900); return; }
        if (!seatIsPerson(S.turn)) scheduleBot();
        return;
      }
      if (msg.t === 'again') {
        if (S.phase === 'gameover') newGame();
        else if (S.phase === 'handover') nextHand();
        return;
      }
      return;
    }

    if (msg.t === 'state') { applyState(msg); return; }
    if (msg.t === 'bye') {
      netStatus('The host closed the table. Your own is still here.');
      showNetRow('start');
      goSolo();
    }
  }

  function showNetRow(which) {
    els.netStart.hidden = which !== 'start';
    els.netHost.hidden = which !== 'host';
    els.netJoin.hidden = which !== 'join';
    els.netLive.hidden = which !== 'live';
  }

  /* Back to your own table against the computer. The seat map has to be
     wiped as well as the connection, because newGame deliberately keeps
     it across deals so a table survives a fresh hand, and a guest that
     kept the HOST's map would sit down alone still believing two of the
     three empty seats had people in them. */
  function goSolo() {
    stopBots();
    netOpen = false;
    netRole = '';
    mySeat = 0;
    seatOf = {};
    peerAt = [null, null, null, null];
    wantPass = [null, null, null, null];
    if (S) S.seatKind = ['person', 'bot', 'bot', 'bot'];
    newGame();
  }

  function leaveTable(silent) {
    if (!silent) Net.send(iAmHost() ? { t: 'bye', v: PROTO } : { t: 'bye', v: PROTO });
    Net.close();
    showNetRow('start');
    netStatus('');
    goSolo();
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
    /* Two cards tall in total, one for the trick and one for the hand.
       Everything else is MEASURED rather than guessed, because it is
       the part that changes: the seats grow a line when a seat says it
       is the computer, and opening the online panel moves the whole
       board down the page. A guessed constant was wrong by about a
       hundred pixels with the panel open, which is a hand hanging off
       the bottom of the screen. */
    var overhead = 60 +
      (els.seatsRow ? els.seatsRow.offsetHeight : 70) +
      (els.youSeat ? els.youSeat.offsetHeight : 60) +
      (els.lastLine ? els.lastLine.offsetHeight + 28 : 45);
    var ch = Math.floor((avail - overhead) / 2);
    ch = Math.max(56, Math.min(size.ch, ch));
    var cw = Math.max(34, Math.round(ch / 1.4));
    ch = Math.round(cw * 1.4);
    els.board.style.setProperty('--cw', cw + 'px');
    els.board.style.setProperty('--ch', ch + 'px');
    return { cw: cw, ch: ch, gap: size.gap };
  }

  function render() {
    var size = sizeFor();

    /* --- the seats ---
       Drawn by where they sit relative to YOU rather than by seat
       number, so online everybody sees their own three opponents on
       their own left, across and right. The slot is fixed, the seat in
       it is not. */
    for (var off = 1; off < SEATS; off++) {
      var p = seatAtOffset(off);
      var seat = els.slots[off];
      seat.dataset.seat = String(p);
      var nameEl = seat.querySelector('.seat-name');
      nameEl.textContent = SEAT_NAMES[p];
      seat.dataset.suit = SEAT_SUITS[p];
      glyphInto(nameEl, p);
      seat.querySelector('.seat-where').textContent =
        WHERE[off] + (S.seatKind[p] === 'bot' ? ', computer' : '');
      seat.querySelector('.seat-n').textContent = String(S.hands[p].length);
      seat.querySelector('.seat-pts').textContent = String(
        S.taken[p].reduce(function (a, id) { return a + pointsOf(id); }, 0));
      seat.classList.toggle('turn', S.turn === p && S.phase === 'play');
      seat.classList.toggle('bot', S.seatKind[p] === 'bot');
    }
    els.youSeat.dataset.seat = String(mySeat);
    els.youSeat.dataset.suit = SEAT_SUITS[mySeat];
    var youName = els.youSeat.querySelector('.seat-name');
    youName.textContent = 'You' + (online() ? ' (' + SEAT_NAMES[mySeat] + ')' : '');
    glyphInto(youName, mySeat);
    els.youPts.textContent = String(
      S.taken[mySeat].reduce(function (a, id) { return a + pointsOf(id); }, 0));
    els.youSeat.classList.toggle('turn', S.turn === mySeat && S.phase === 'play');

    /* --- the trick --- */
    els.trick.innerHTML = '';
    for (var k = 0; k < SEATS; k++) {
      var i = seatAtOffset(k);
      var slot = document.createElement('div');
      slot.className = 'trickslot';
      var played = null;
      /* eslint-disable-next-line no-loop-func */
      S.trick.forEach(function (t) { if (t.p === i) played = t; });
      if (played) {
        var node = C.play(K.card(played.id));
        if (S.trick.length && K.suitOf(played.id) === ledSuitIn(S)) node.classList.add('inled');
        slot.appendChild(node);
      }
      var tag = document.createElement('span');
      tag.className = 'trickwho';
      tag.textContent = nameOf(i);
      slot.appendChild(tag);
      els.trick.appendChild(slot);
    }

    /* --- your hand --- */
    els.hand.innerHTML = '';
    var playable = S.phase === 'play' && S.turn === mySeat ? legal(mySeat) : [];
    S.hands[mySeat].forEach(function (id) {
      var node = C.play(K.card(id), { tag: 'button' });
      node.dataset.card = id;
      if (S.phase === 'pass') {
        if (S.picked.indexOf(id) >= 0) node.classList.add('picked');
      } else if (S.phase === 'play') {
        if (S.turn === mySeat) {
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
      var mine = wantPass[mySeat];
      var waiting = online() ? (iAmHost() ? waitingOn() : (S.waiting || 0)) : 0;
      if (mine && waiting > 0) {
        /* Everybody chooses at once, so the only honest thing to show
           somebody who has already chosen is who is still thinking. */
        els.passWhy.textContent = 'Waiting for ' + waiting + ' other ' +
          (waiting === 1 ? 'player' : 'players') + ' to choose.';
        els.passBtn.textContent = 'Chosen';
        els.passBtn.disabled = true;
        els.passCount.textContent = 'Yours are in';
      } else {
        els.passWhy.textContent = 'Choose three cards to pass ' + PASS_DIRS[S.passDir] + '.';
        els.passBtn.textContent = 'Pass three ' + PASS_DIRS[S.passDir];
        els.passBtn.disabled = S.picked.length !== 3;
        els.passCount.textContent = S.picked.length + ' of 3 chosen';
      }
    }

    els.overbar.hidden = S.phase !== 'handover' && S.phase !== 'gameover';
    if (!els.overbar.hidden) {
      var hs = S.handScores;
      var line;
      if (hs.shooter >= 0) {
        line = (hs.shooter === mySeat ? 'You shot the moon.' : SEAT_NAMES[hs.shooter] + ' shot the moon.') +
          ' Twenty six to everyone else.';
      } else {
        line = 'This hand, ' + [0, 1, 2, 3].map(function (i) {
          return lowerNameOf(i) + ' ' + hs.add[i];
        }).join(', ') + '.';
      }
      els.overWhy.textContent = line;
      if (S.phase === 'gameover') {
        var low = Math.min.apply(null, S.scores);
        var winners = [0, 1, 2, 3].filter(function (i) { return S.scores[i] === low; });
        els.overTitle.textContent = winners.indexOf(mySeat) >= 0 && winners.length === 1
          ? 'You win' : (winners.length > 1 ? 'A tie at the bottom' : SEAT_NAMES[winners[0]] + ' wins');
        els.overBtn.textContent = 'New game';
      } else {
        els.overTitle.textContent = 'Hand ' + (S.handNo + 1) + ' finished';
        els.overBtn.textContent = 'Next hand';
      }
    }

    /* --- the scoreboard --- */
    for (var q = 0; q < SEATS; q++) {
      var seatQ = seatAtOffset(q);
      els.scoreName[q].textContent = nameOf(seatQ);
      els.scoreName[q].parentNode.dataset.suit = SEAT_SUITS[seatQ];
      glyphInto(els.scoreName[q], seatQ);
      els.score[q].textContent = String(S.scores[seatQ]);
    }
    els.handNo.textContent = String(S.handNo + 1);
    els.brokenTag.textContent = S.broken ? 'broken' : 'not yet';

    els.lastLine.textContent = S.lastTrick
      ? (S.lastTrick.winner === mySeat ? 'You took' : SEAT_NAMES[S.lastTrick.winner] + ' took') +
        ' the last trick' + (S.lastTrick.points ? ' and ' + S.lastTrick.points + ' point' +
        (S.lastTrick.points === 1 ? '' : 's') : ', clean') + '.'
      : '';
  }

  /* Thirteen cards across a phone is narrower than a card, so the hand
     overlaps and the overlap is worked out from what is actually
     there rather than assumed. The last card is always whole. */
  function fanHand(size) {
    var n = S.hands[mySeat].length;
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
    if (S.turn !== mySeat) { say('Wait for your turn.'); return; }
    if (legal(mySeat).indexOf(id) < 0) { say(whyNot(id)); return; }

    /* A guest asks and waits. It could put the card down straight away
       and look faster, but then two browsers would each hold an opinion
       about the board, and the moment they disagreed there would be no
       way to tell which one was right. One copy of the rules, one
       answer. */
    if (online() && !iAmHost()) {
      Net.send({ t: 'play', v: PROTO, id: id });
      return;
    }

    playCard(mySeat, id);
    render(); save(); pushState();
    if (S.trick.length === SEATS) { timer = setTimeout(step, 900); return; }
    if (!seatIsPerson(S.turn)) scheduleBot();
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
      if (hasSuit(S.hands[mySeat], led) && K.suitOf(id) !== led) {
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
    els.seatsRow = document.querySelector('.seats');
    els.slots = [null];
    for (var p = 1; p < SEATS; p++) els.slots.push(document.querySelector('.seat[data-slot="' + p + '"]'));
    els.youSeat = document.querySelector('.seat.you');
    els.youPts = els.youSeat.querySelector('.seat-pts');
    els.score = [0, 1, 2, 3].map(function (i) { return document.getElementById('score' + i); });
    els.scoreName = [0, 1, 2, 3].map(function (i) { return document.getElementById('scoreName' + i); });
    els.onlineBtn = document.getElementById('onlineBtn');
    els.netpanel = document.getElementById('netpanel');
    els.netStart = document.getElementById('netStart');
    els.netHost = document.getElementById('netHost');
    els.netJoin = document.getElementById('netJoin');
    els.netLive = document.getElementById('netLive');
    els.netStatus = document.getElementById('netStatus');
    els.codeOut = document.getElementById('codeOut');
    els.codeIn = document.getElementById('codeIn');
    els.hostBtn = document.getElementById('hostBtn');
    els.joinShowBtn = document.getElementById('joinShowBtn');
    els.joinBtn = document.getElementById('joinBtn');
    els.copyBtn = document.getElementById('copyBtn');
    els.hostCancel = document.getElementById('hostCancel');
    els.joinCancel = document.getElementById('joinCancel');
    els.leaveBtn = document.getElementById('leaveBtn');
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
      if (S.phase === 'play' && S.turn !== mySeat) scheduleBot();
    }

    els.hand.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.hpc') : null;
      if (card && card.dataset.card) tapCard(card.dataset.card);
    });

    els.newBtn.addEventListener('click', function () {
      if (online() && !iAmHost()) { say('Whoever started the table deals.'); return; }
      newGame();
      say('New game dealt.');
      pushState();
    });
    els.passBtn.addEventListener('click', function () {
      if (S.picked.length === 3) { doPass(); }
    });
    els.overBtn.addEventListener('click', function () {
      if (online() && !iAmHost()) { Net.send({ t: 'again', v: PROTO }); return; }
      if (S.phase === 'gameover') newGame();
      else nextHand();
      pushState();
    });

    /* ---------- the online panel ---------- */
    Net.on(netEvent);

    els.onlineBtn.addEventListener('click', function () {
      if (Net.libFailed()) { say(reasonText('lib')); return; }
      var open = els.netpanel.hidden;
      els.netpanel.hidden = !open;
      els.onlineBtn.setAttribute('aria-expanded', String(open));
      if (open && !netRole) showNetRow('start');
      /* The panel is tall, and the board is sized against whatever room
         is left below it, so opening it without a redraw pushes your own
         hand off the bottom of the screen. */
      render();
    });

    els.hostBtn.addEventListener('click', function () {
      netRole = 'host';
      mySeat = 0;
      seatOf = {};
      peerAt = [null, null, null, null];
      showNetRow('host');
      els.codeOut.textContent = '------';
      netStatus('Starting a table.');
      Net.host();
    });

    els.joinShowBtn.addEventListener('click', function () {
      showNetRow('join');
      netStatus('');
      els.codeIn.value = '';
      els.codeIn.focus();
    });

    els.joinBtn.addEventListener('click', function () {
      netRole = 'guest';
      netStatus('Looking for that table.');
      Net.join(els.codeIn.value);
    });

    els.codeIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); els.joinBtn.click(); }
    });

    els.copyBtn.addEventListener('click', function () {
      var code = els.codeOut.textContent;
      /* The clipboard is not always allowed, and a button that silently
         does nothing is worse than one that admits it. */
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(function () {
            netStatus('Code copied. Read it out or paste it to them.');
          }, function () { netStatus('Could not copy it. The code is ' + code + '.'); });
          return;
        }
      } catch (e) { /* fall through */ }
      netStatus('Could not copy it. The code is ' + code + '.');
    });

    els.hostCancel.addEventListener('click', function () { leaveTable(true); });
    els.joinCancel.addEventListener('click', function () { showNetRow('start'); netStatus(''); });
    els.leaveBtn.addEventListener('click', function () { leaveTable(false); });

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
    play: function (id) { var r = playCard(mySeat, id); if (r) { render(); save(); } return r; },
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
        if (S.turn === mySeat) break;
        playCard(S.turn, botChoice(S.turn));
      }
      render(); save();
      return S.phase;
    },
    autoPlayYou: function () {
      var opts = legal(mySeat);
      return opts.length ? playCard(mySeat, opts[0]) : false;
    },
    clearSave: function () { store.clear(); },

    /* ---------- online, for the suite ---------- */
    netState: function () {
      return {
        role: netRole, open: netOpen, mySeat: mySeat,
        seatKind: S ? S.seatKind.slice() : null,
        seats: peerAt.slice(), waiting: S && S.waiting
      };
    },
    seatIsPerson: seatIsPerson,
    /* Drive the wire path directly, so a suite can hand this browser
       exactly what a hostile or broken host would send. There is no
       other way to test the checks, because every honest path builds a
       well formed message by construction. */
    wireMessage: function (msg, from) {
      var wasRole = netRole, wasOpen = netOpen;
      netRole = 'guest'; netOpen = true;
      try { onMessage(msg, from || 'test'); }
      finally { netRole = wasRole; netOpen = wasOpen; }
    },
    submitPass: submitPass,
    waitingOn: waitingOn,
    packPublic: packPublic,
    doPass: function () { doPass(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
