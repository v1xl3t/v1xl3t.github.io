/* ============================================================
   HACKING PARADISE card component, behavior half.

   Pairs with hp-cards.css. Builds DOM for the two scales:

     HPCards.showcase(data)  -> a full ornate card element
     HPCards.play(card)      -> a compact face-up play card
     HPCards.back()          -> a compact face-down card
     HPCards.slot(glyph)     -> an empty pile marker
     HPCards.deck()          -> a standard 52 card deck
     HPCards.shuffle(a, rng) -> in place Fisher Yates

   No dependencies, no build step, no framework. Attaches one
   global, HPCards. Safe to load on any page that also loads
   hp-cards.css and puts .hpc-scope on an ancestor.

   A card object is {id, s, r, v}:
     s  suit key, one of S C H D
     r  rank code, A 2..9 T J Q K
     v  rank value, ace low at 1 through king at 13
     id suit key plus rank code, for example "HQ"
   ============================================================ */
(function (root) {
  'use strict';

  /* The suits carry the four members. This is the one place the mapping
     lives, so it is a single edit to change who owns which suit.

     The PIP stays classic red or black. Only the band, the name and the
     showcase accent take the member color. Recoloring the pips themselves
     was the obvious idea and it makes the game unplayable, red versus
     black is the only thing a solitaire player reads at speed. */
  var SUITS = [
    { k: 'S', pip: '♠', name: 'Spades',   red: false, member: 'Vi Ellis',      mark: 'The Founder' },
    { k: 'H', pip: '♥', name: 'Hearts',   red: true,  member: 'Shinobi Necro', mark: 'The Flagship' },
    { k: 'C', pip: '♣', name: 'Clubs',    red: false, member: 'Judah Ellis',   mark: 'The Builder' },
    { k: 'D', pip: '♦', name: 'Diamonds', red: true,  member: 'Robby Winters', mark: 'The Narrator' }
  ];

  var RANKS = [
    { r: 'A', v: 1,  label: 'A',  word: 'Ace' },
    { r: '2', v: 2,  label: '2',  word: 'Two' },
    { r: '3', v: 3,  label: '3',  word: 'Three' },
    { r: '4', v: 4,  label: '4',  word: 'Four' },
    { r: '5', v: 5,  label: '5',  word: 'Five' },
    { r: '6', v: 6,  label: '6',  word: 'Six' },
    { r: '7', v: 7,  label: '7',  word: 'Seven' },
    { r: '8', v: 8,  label: '8',  word: 'Eight' },
    { r: '9', v: 9,  label: '9',  word: 'Nine' },
    { r: 'T', v: 10, label: '10', word: 'Ten' },
    { r: 'J', v: 11, label: 'J',  word: 'Jack' },
    { r: 'Q', v: 12, label: 'Q',  word: 'Queen' },
    { r: 'K', v: 13, label: 'K',  word: 'King' }
  ];

  var suitBy = {}, rankBy = {};
  SUITS.forEach(function (s) { suitBy[s.k] = s; });
  RANKS.forEach(function (r) { rankBy[r.r] = r; });

  function make(tag, cls, txt) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (txt != null) el.textContent = txt;
    return el;
  }

  function deck() {
    var out = [];
    for (var i = 0; i < SUITS.length; i++) {
      for (var j = 0; j < RANKS.length; j++) {
        out.push({ id: SUITS[i].k + RANKS[j].r, s: SUITS[i].k, r: RANKS[j].r, v: RANKS[j].v });
      }
    }
    return out;
  }

  /* Fisher Yates. Takes an rng so a test can seed it and get the same deal
     twice, which is the only way to assert on a specific move. */
  function shuffle(a, rng) {
    rng = rng || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* A small deterministic generator, so a seeded game is reproducible and a
     saved game can name its seed. mulberry32. */
  function rngFrom(seed) {
    var t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      var x = t;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function label(card) {
    var s = suitBy[card.s], r = rankBy[card.r];
    return r.word + ' of ' + s.name;
  }

  /* ---------- play scale ---------- */

  function play(card, opts) {
    opts = opts || {};
    var s = suitBy[card.s], r = rankBy[card.r];
    var el = make(opts.tag || 'div', 'hpc play up' + (s.red ? ' red' : ''));
    el.dataset.suit = card.s;
    el.dataset.card = card.id;
    el.setAttribute('aria-label', label(card));
    if (opts.tag === 'button') el.type = 'button';

    ['tl', 'br'].forEach(function (pos) {
      var idx = make('div', 'hpc-idx ' + pos);
      idx.appendChild(make('span', 'r', r.label));
      idx.appendChild(make('span', 'p', s.pip));
      idx.setAttribute('aria-hidden', 'true');
      el.appendChild(idx);
    });

    /* The center watermark is a pseudo-element fed by a custom property, not a
       child. As a real text node at 16 percent opacity it is a contrast failure
       to any auditor, and the auditor would be right, it cannot tell decoration
       from content. This spelling says decoration in a way a machine reads. */
    var court = r.v >= 11;
    if (court) el.classList.add('pipcourt');
    el.style.setProperty('--hpc-pip-ch', '"' + (court ? r.label : s.pip) + '"');
    return el;
  }

  function back(opts) {
    opts = opts || {};
    var el = make(opts.tag || 'div', 'hpc play down');
    el.setAttribute('aria-label', opts.label || 'Face down card');
    if (opts.tag === 'button') el.type = 'button';
    return el;
  }

  function slot(glyph, opts) {
    opts = opts || {};
    var el = make(opts.tag || 'div', 'hpc play empty');
    el.setAttribute('aria-label', opts.label || 'Empty space');
    if (opts.tag === 'button') el.type = 'button';
    if (glyph) {
      var g = make('span', 'hpc-slot', glyph);
      g.setAttribute('aria-hidden', 'true');
      el.appendChild(g);
    }
    return el;
  }

  /* ---------- showcase scale ----------

     data = {
       name, rank (number of stars), attr, handle, glyph, type,
       text, no (collector number), set, suit (S C H D, optional skin),
       href (renders an anchor), locked (dims it, no link)
     }
  */
  function showcase(data) {
    data = data || {};
    var isLink = !!data.href && !data.locked;
    var el = make(isLink ? 'a' : 'div', 'hpc show' + (data.locked ? ' locked' : ''));
    if (isLink) el.href = data.href;
    if (data.suit) el.dataset.suit = data.suit;

    var plate = make('div', 'hpc-plate');
    plate.appendChild(make('h3', 'hpc-name', data.name || ''));
    var stars = Math.max(0, Math.min(12, data.rank || 0));
    if (stars) {
      var rk = make('span', 'hpc-rank', new Array(stars + 1).join('☆'));
      rk.setAttribute('aria-label', 'Rank ' + stars);
      plate.appendChild(rk);
    }
    el.appendChild(plate);

    var meta = make('div', 'hpc-meta');
    meta.appendChild(make('span', 'hpc-attr', data.attr || ''));
    meta.appendChild(make('span', null, data.handle || ''));
    el.appendChild(meta);

    var art = make('div', 'hpc-art');
    var st = make('span', 'hpc-artstar', '☆');
    st.setAttribute('aria-hidden', 'true');
    art.appendChild(st);
    var gl = make('div', 'hpc-glyph', data.glyph || '');
    gl.setAttribute('aria-hidden', 'true');
    art.appendChild(gl);
    el.appendChild(art);

    var type = make('div', 'hpc-type');
    type.innerHTML = '';
    var tparts = String(data.type || '').split('|');
    tparts.forEach(function (t, i) {
      if (i) type.appendChild(document.createTextNode(' / '));
      var node = i === 0 ? make('b', null, t.trim()) : document.createTextNode(t.trim());
      type.appendChild(node);
    });
    el.appendChild(type);

    var box = make('div', 'hpc-text');
    box.appendChild(make('p', null, data.text || ''));
    el.appendChild(box);

    var foot = make('div', 'hpc-foot');
    foot.appendChild(make('span', 'hpc-no', data.no || ''));
    foot.appendChild(make('span', 'hpc-set', data.set || 'HACKING PARADISE'));
    el.appendChild(foot);

    return el;
  }

  root.HPCards = {
    SUITS: SUITS, RANKS: RANKS,
    suit: function (k) { return suitBy[k]; },
    rank: function (r) { return rankBy[r]; },
    deck: deck, shuffle: shuffle, rngFrom: rngFrom, label: label,
    play: play, back: back, slot: slot, showcase: showcase
  };
})(window);
