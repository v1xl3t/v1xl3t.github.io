// Primes / L-system (2020) — ambient edition.
// The original piece, streaming forever: a prime-seeded L-system turtle paints
// a horizontal band in chapters, and a soft camera follows the growth.
// No controls, no interaction, just the drawing.

let limit = 1500; // how many natural numbers to compute
let x, y; // current position of the turtle
let currentAngle = 0; // direction the turtle is pointing
let step = 10; // how much the turtle moves with each 'F'
let angle = 90; // how much the turtle turns with a '-' or '+'

// the L-system rules (a Hilbert-curve variant, seeded by primality)
const RULES = { A: '+AF-BFB-FA+', B: '-BF+AFA+FB-' };
const DEPTH = 8; // how many expansions deep the stream runs

let seed = ''; // primality string the whole piece grows from

// ---- lazy L-system stream ----
// The fully expanded string would be hundreds of megabytes (it crashed
// phones). Instead the expansion tree is walked on demand with a tiny
// stack, yielding the exact same character sequence with no memory cost.
let seedIdx = 0;
const stack = [];
function nextChar() {
  while (true) {
    if (!stack.length) {
      stack.push({ str: seed[seedIdx], i: 0, d: DEPTH });
      seedIdx = (seedIdx + 1) % seed.length;
    }
    const top = stack[stack.length - 1];
    if (top.i >= top.str.length) { stack.pop(); continue; }
    const ch = top.str[top.i++];
    if (top.d > 0 && RULES[ch]) stack.push({ str: RULES[ch], i: 0, d: top.d - 1 });
    else return ch;
  }
}

// ---- the stage ----
// The turtle paints a horizontal band (~2100px tall) that drifts right
// forever, so the stage is wide and short and the piece runs in chapters:
// reach the right edge, rest a moment, begin again on a fresh canvas.
const MOBILE = typeof matchMedia !== 'undefined' && matchMedia('(pointer:coarse)').matches;
const ART_W = MOBILE ? 4200 : 7000;
const ART_H = MOBILE ? 2400 : 2600;
const START_X = 1000, START_Y = 1750;
let art;               // offscreen buffer the turtle draws into
let chapterPause = 0;  // frames of rest between chapters
let stepsPerFrame = 100;

// drawn extent, which the camera follows
let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
let zoom = 1, panX = 0, panY = 0;

function preload() {
  // convert natural numbers to binary, populate the seed before setup
  sortPrimes();
}

function setup() {
  // cap densities: phones default to 3x, which would silently triple every
  // canvas dimension (the art buffer alone became ~360MB and killed the tab)
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
  createCanvas(windowWidth, windowHeight);
  art = createGraphics(ART_W, ART_H);
  art.pixelDensity(1);
  art.background(255);
  x = START_X;
  y = START_Y;
  const lo = document.getElementById('loading');
  if (lo) lo.remove();
  const t = fitTarget();
  zoom = t.z; panX = t.px; panY = t.py;
}

function draw() {
  // keep the canvas matched to the window (covers embeds and rotation)
  if (width !== windowWidth || height !== windowHeight) {
    resizeCanvas(windowWidth, windowHeight);
  }

  if (chapterPause > 0) {
    // brief rest with the finished chapter on display
    if (--chapterPause === 0) {
      art.background(255);
      x = START_X; y = START_Y;
      bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
    }
  } else {
    for (let n = 0; n < stepsPerFrame; n++) drawIt(nextChar());
    // the chapter ends when the drawn band nears the stage edge, so no
    // motif is ever clipped by the buffer boundary
    if (bx1 - bx0 > ART_W - 420 || x > ART_W - 140 || bx0 < 60) chapterPause = 150;
  }

  // ease the camera around the growing drawing
  const t = fitTarget();
  zoom += (t.z - zoom) * 0.06;
  panX += (t.px - panX) * 0.06;
  panY += (t.py - panY) * 0.06;

  // composite only the visible slice of the buffer, cheap at any zoom
  background(255);
  const sx = Math.max(0, -panX / zoom);
  const sy = Math.max(0, -panY / zoom);
  const sw = Math.min(ART_W - sx, width / zoom);
  const sh = Math.min(ART_H - sy, height / zoom);
  if (sw > 0 && sh > 0) {
    image(art,
      panX + sx * zoom, panY + sy * zoom, sw * zoom, sh * zoom,
      sx, sy, sw, sh);
  }
}

// fit the drawn artwork (with padding), or the start area when fresh
function fitTarget() {
  let x0 = bx0, y0 = by0, x1 = bx1, y1 = by1;
  if (!isFinite(x0) || x1 - x0 < 60 || y1 - y0 < 60) {
    x0 = START_X - 200; y0 = START_Y - 200; x1 = START_X + 200; y1 = START_Y + 200;
  }
  const pad = Math.max(40, (x1 - x0) * 0.08);
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const z = Math.min(width / (x1 - x0), height / (y1 - y0), 8);
  return { z, px: (width - (x0 + x1) * z) / 2, py: (height - (y0 + y1) * z) / 2 };
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// natural number to binary converter
function sortPrimes() {
  // string label for current number, default A for prime
  let current = 'A';
  // calculates for each natural number from 0 to set limit
  for (let i = 0; i < limit; i++) {
    // check if number is equal to 1
    if (i <= 1) {
      current = 'B';
    } else if (i > 1) {
      // looping through 2 to number-1
      for (let z = 2; z < i; z++) {
        if (i % z == 0) {
          current = 'B';
          break;
        }
      }
    }
    seed = seed + current;
  }
}

// draw turtle commands
function drawIt(k) {
  if (k == 'F') { // draw forward
    // polar to cartesian based on step and currentAngle:
    let x1 = x + step * cos(radians(currentAngle));
    let y1 = y + step * sin(radians(currentAngle));
    // connect the old and the new
    art.line(x, y, x1, y1);
    // update turtle position
    x = x1;
    y = y1;
  } else if (k == '+') {
    currentAngle += angle; // turn left
  } else if (k == '-') {
    currentAngle -= angle; // turn right
  }

  // random blue value generator
  let r = random(0, 85);
  let g = random(85, 170);
  let b = random(170, 255);
  let a = random(0, 30);

  // random gaussian (D&D) distribution for ellipse radius
  let radius = 0;
  radius += random(0, 15);
  radius += random(0, 15);
  radius += random(0, 15);
  radius = radius / 5;

  // draw new frame
  art.fill(r, g, b, a);
  art.stroke(r, g, b, a);
  art.ellipse(x, y, radius, radius);

  // grow the artwork's known bounding box (the camera follows this)
  if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
  if (y < by0) by0 = y; if (y > by1) by1 = y;
}
