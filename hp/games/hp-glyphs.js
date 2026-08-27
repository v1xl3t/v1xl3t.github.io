/* ============================================================
   hp-glyphs.js — four suits, drawn the way the diver is drawn.

   A spade, a club, a heart and a diamond, each still readable as
   its suit at a glance, and each carrying the name of the seat it
   belongs to when you actually look at it.

   THE MAPPING IS THE POEM

     Void and Abyss are the BLACK suits. Below, cold, the descent.
     That is stanza one.

     Promise and Paradise are the RED suits. Above, warm, the sky.
     That is stanza two.

   Vi picked the pairing and it lands exactly on the split the
   founding poem already had, so the board is the cosmology whether
   or not anybody reads it that way.

   WHAT EACH ONE DOES WITH ITS SHAPE

     Void, spade      the spade has no floor. The two lobes never
                      close at the bottom and the stem has come
                      away and is still falling. "Fervent doubters
                      claim It has no floor."

     Abyss, club      the three lobes are drawn as bowls nested
                      inside bowls, so the trefoil reads as
                      something you are looking DOWN into rather
                      than three leaves. The descent breaks and
                      keeps going.

     Promise, heart   two strokes reaching for each other and not
                      quite arriving, at the cleft and again at the
                      point. A promise is a thing not yet kept.
                      One tick reaches upward, still waiting.

     Paradise, diamond  a diamond that is also a distant star.
                      Rays at the four points, a spark at the
                      center, the same spark the diver wears.

   THE STYLE IS THE DIVER'S

   Open strokes with round caps and joins, and the same sketch
   filter, a fractal turbulence displacement whose seed animates,
   which is what makes a line look drawn by a hand rather than by a
   machine. Every glyph inherits currentColor, so it is whatever
   color the thing around it already is.

   Motion is a preference. Under prefers-reduced-motion the seed
   stops on one value and the glyph is still crooked, just no
   longer boiling. The look survives, the movement does not.
   ============================================================ */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var FILTER_ID = 'hpg-sketch';
  var injected = false;

  /* One filter for the whole page rather than one per glyph. Four of
     these animate at once on the Hearts table and there is no reason
     to run four identical noise generators. */
  function ensureFilter() {
    if (injected || document.getElementById(FILTER_ID)) { injected = true; return; }
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.position = 'absolute';
    /* Reduced motion is decided HERE rather than in CSS. `display:none`
       on an <animate> is not a reliable way to stop SMIL, and the first
       attempt at this pointed at `.hpg animate`, which never matched
       anything because the animation lives in the injected filter and
       not inside any glyph. So the boil simply never stopped. Not
       creating the element is the only version that is certainly true.

       The glyph stays crooked either way. The crookedness is the
       displacement, the movement is the seed. */
    var still = false;
    try {
      still = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { still = false; }

    svg.innerHTML =
      '<defs><filter id="' + FILTER_ID + '" x="-30%" y="-30%" width="160%" height="160%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.055" numOctaves="2" seed="2" result="n">' +
      (still ? '' : '<animate attributeName="seed" values="2;5;9;3;2" dur="0.55s" repeatCount="indefinite"/>') +
      '</feTurbulence>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="1.5" xChannelSelector="R" yChannelSelector="G"/>' +
      '</filter></defs>';
    document.body.appendChild(svg);
    injected = true;
  }

  /* Each entry is a list of paths and the class that styles them.
     `ln` is a plain stroke, `wait` is the dashed stroke that means
     something has not arrived yet, `soft` is a lighter stroke for a
     thing that is fading. */
  var GLYPHS = {
    /* ---------- Void, the spade with no floor ---------- */
    S: {
      name: 'Void',
      paths: [
        /* the two shoulders, meeting at the top point and NOT meeting
           at the bottom, which is the whole idea */
        ['ln', 'M12,2.4 C10.9,4.6 3.4,9.4 3.4,13.5 C3.4,16.6 6.4,18.3 9,17 C10.3,16.3 10.9,15.2 11.2,14.2'],
        ['ln', 'M12,2.4 C13.1,4.6 20.6,9.4 20.6,13.5 C20.6,16.6 17.6,18.3 15,17 C13.7,16.3 13.1,15.2 12.8,14.2'],
        /* the stem, come away and still going */
        ['ln', 'M12,15.6 L12,17.9'],
        ['soft', 'M12,19.4 L12,21.4']
      ]
    },

    /* ---------- Abyss, the club you look down into ---------- */
    C: {
      name: 'Abyss',
      paths: [
        /* A clean club silhouette first. Three nested bowls read as
           depth at a hundred pixels and as mud at eighteen, and
           eighteen is the size it will actually be used at. */
        ['ln', 'M9.2,9.9 C7.3,9 7.1,5.9 9.4,4.6 C11.9,3.2 14.7,4.5 15,6.8 C15.1,7.8 14.7,9.1 14.1,9.9'],
        ['ln', 'M10.1,11.1 C9.4,9.8 7.7,8.9 6.1,9.5 C4,10.3 3.4,13.1 5.1,14.6 C6.4,15.8 8.5,15.7 9.7,14.5'],
        ['ln', 'M13.9,11.1 C14.6,9.8 16.3,8.9 17.9,9.5 C20,10.3 20.6,13.1 18.9,14.6 C17.6,15.8 15.5,15.7 14.3,14.5'],
        /* ONE bowl inside the top one, which is enough to say it is
           something you look down into rather than three leaves */
        ['soft', 'M10.4,8.5 C9.8,7.6 10.4,6.2 12,6 C13.6,5.8 14.4,6.9 14,7.9'],
        /* the descent, broken, no floor here either */
        ['ln', 'M12,13.6 L12,17.4'],
        ['soft', 'M12,18.9 L12,21.4']
      ]
    },

    /* ---------- Promise, the heart that has not arrived ---------- */
    H: {
      name: 'Promise',
      paths: [
        /* the half that is here */
        ['ln', 'M11.7,7.6 C11.2,6.3 10,5 8.3,5 C5.9,5 4,6.8 4,9.4 C4,13.6 9.4,17.6 11.6,19.6'],
        /* the half that is still coming, and does not reach the cleft
           at the top or the point at the bottom */
        ['wait', 'M12.7,7.4 C13.3,6.2 14.6,5 16.2,5 C18.6,5 20.4,6.8 20.4,9.4 C20.4,12.9 16.6,16.3 14,18.4'],
        /* one tick reaching up, still waiting */
        ['soft', 'M12.2,3.7 L12.2,1.8']
      ]
    },

    /* ---------- Paradise, the diamond that is a distant star ---------- */
    D: {
      name: 'Paradise',
      paths: [
        /* the near half, drawn plainly */
        ['ln', 'M12,21.2 L4.2,12.1 L12,3'],
        /* the far half, fading, because Ambrosian Fields fade */
        ['soft', 'M12,3 L19.8,12.1 L12,21.2'],
        /* rays at the four points */
        ['soft', 'M12,1.9 L12,0.9 M12,22.4 L12,23.4 M3.1,12.1 L2.1,12.1 M20.9,12.1 L21.9,12.1'],
        /* the diver wears this same spark */
        ['fl', 'M12,9.3 L12.9,11.3 L14.9,12.1 L12.9,12.9 L12,14.9 L11.1,12.9 L9.1,12.1 L11.1,11.3 Z']
      ]
    }
  };

  /* Build one. `suit` is the letter the games already use. */
  function make(suit, opts) {
    opts = opts || {};
    var g = GLYPHS[suit];
    if (!g) return null;
    ensureFilter();

    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'hpg hpg-' + suit + (opts.className ? ' ' + opts.className : ''));
    if (opts.label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', opts.label);
    } else {
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
    }

    var grp = document.createElementNS(NS, 'g');
    grp.setAttribute('filter', 'url(#' + FILTER_ID + ')');
    g.paths.forEach(function (pair) {
      var el = document.createElementNS(NS, 'path');
      el.setAttribute('class', pair[0]);
      el.setAttribute('d', pair[1]);
      grp.appendChild(el);
    });
    svg.appendChild(grp);
    return svg;
  }

  root.HPGlyphs = {
    make: make,
    nameOf: function (suit) { return GLYPHS[suit] ? GLYPHS[suit].name : ''; },
    suits: function () { return ['S', 'C', 'H', 'D']; }
  };
})(window);
