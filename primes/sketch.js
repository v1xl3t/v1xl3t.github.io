limit = 1500; // how many natural numbers to compute

let x, y; // current position of the turtle
let currentAngle = 0; // direction the turtle is pointing
let step = 10; // how much the turtle moves with each 'F'
let angle = 90; // how much the turtle turns with a '-' or '+'

let binaryString = ''; // blank container for converted binary string
let numLoops = 8; // how many iterations to pre-compute (up to 8)
let ruleSet = []; // blank array for ruleset
ruleSet[0] = ['A', '+AF-BFB-FA+']; // first rule
ruleSet[1] = ['B', '-BF+AFA+FB-']; // second rule

let stringWorm = 0; // current location within L-system

// first function to run upon play
function preload() {
  
  // convert natural numbers to binary, populate 'binaryString' before setup
  sortPrimes(); 
}

// second function to run following 'preload()'
function setup() {

  // visible canvas fills the window; the artwork accumulates in a wide
  // offscreen buffer that the camera looks at. The turtle's path is a
  // horizontal band (measured: ~2100px tall, marching right forever), so the
  // stage is wide and short, and when the turtle reaches the right edge the
  // piece begins a new chapter on a fresh canvas.
  createCanvas(windowWidth, windowHeight);
  art = createGraphics(ART_W, ART_H);
  art.background(255);

  x = START_X;
  y = START_Y;

  resetView();

  // compute L-system
  for (let i = 0; i < numLoops; i++) {
    binaryString = lindenmayer(binaryString);
  }
}

// how many characters of the string to draw per frame.
// the original drew 1/frame, so the piece took minutes to develop; drawing
// several per frame reaches the same result faster for the embedded view.
let stepsPerFrame = 250;

// looping function
function draw() {

  if (chapterPause > 0) {
    // brief rest with the finished chapter on display
    if (--chapterPause === 0) {
      art.background(255);
      x = START_X; y = START_Y;
      bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
    }
  } else {
    for (let n = 0; n < stepsPerFrame; n++) {
      // draw current character in the string
      drawIt(binaryString[stringWorm]);

      // increment reading point within string, wrap end
      stringWorm++;
      if (stringWorm > binaryString.length-1) stringWorm = 0;
    }
    // reached the right edge: let the chapter breathe, then start the next
    if (x > ART_W - 80) chapterPause = 150;
  }

  // keep the canvas matched to the window (covers embedded/iframe resizes too)
  if (width !== windowWidth || height !== windowHeight) {
    resizeCanvas(windowWidth, windowHeight);
  }

  // auto-follow: ease the camera around the growing drawing until Vi's
  // visitor grabs the controls themselves
  if (!interacted) {
    const t = fitTarget();
    zoom += (t.z - zoom) * 0.06;
    panX += (t.px - panX) * 0.06;
    panY += (t.py - panY) * 0.06;
  }

  // render the artwork through the camera
  background(255);
  push();
  translate(panX, panY);
  scale(zoom);
  image(art, 0, 0);
  pop();
}

/* ---------------- camera: zoom + pan controls ----------------
   wheel zooms toward the cursor, drag pans, pinch zooms on touch,
   double click (or the home button) resets the view              */

const ART_W = 7000, ART_H = 2600;   // stage sized to the path's real band
const START_X = 900, START_Y = 1750; // measured so the band fits the stage
let art;                // offscreen buffer the turtle draws into
let chapterPause = 0;   // frames of rest between chapters
let zoom = 1, panX = 0, panY = 0;
let pinchDist = 0;
let interacted = false; // camera auto-follows the artwork until you take over
let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity; // drawn extent

function fitZoom() { return Math.min(width / ART_W, height / ART_H); }

// fit the drawn artwork (with padding), or the whole buffer if empty
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

function resetView() {
  const t = fitTarget();
  zoom = t.z; panX = t.px; panY = t.py;
  interacted = false; // hand the camera back to auto-follow
}

function zoomAt(mx, my, factor) {
  interacted = true;
  const next = constrain(zoom * factor, fitZoom() * 0.5, 8);
  factor = next / zoom;
  panX = mx - (mx - panX) * factor;
  panY = my - (my - panY) * factor;
  zoom = next;
}

function mouseWheel(e) {
  zoomAt(mouseX, mouseY, e.delta > 0 ? 0.9 : 1.1);
  return false; // keep the page from scrolling
}

function mouseDragged() {
  if (touches.length > 1) return false; // pinch handles two fingers
  interacted = true;
  panX += movedX;
  panY += movedY;
  return false;
}

function doubleClicked() { resetView(); }

function touchMoved() {
  if (touches.length === 2) {
    const d = dist(touches[0].x, touches[0].y, touches[1].x, touches[1].y);
    const cx = (touches[0].x + touches[1].x) / 2;
    const cy = (touches[0].y + touches[1].y) / 2;
    if (pinchDist > 0) zoomAt(cx, cy, d / pinchDist);
    pinchDist = d;
    return false;
  }
  pinchDist = 0;
  return mouseDragged();
}

function touchEnded() { pinchDist = 0; }

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (!interacted) resetView();
}

// on-screen buttons (added by index.html)
window.primesCam = {
  zin:  () => zoomAt(width/2, height/2, 1.35),
  zout: () => zoomAt(width/2, height/2, 1/1.35),
  home: () => resetView(),
};

// L-system calculator
function lindenmayer(s) {
  
  // blank container for output string
  let outputString = '';

  // iterate through 'ruleSet' looking for symbol matches
  for (let i = 0; i < s.length; i++) {
    let isMatching = 0; // by default, no match
    
    // iterate through rule instructions from ruleset
    for (let j = 0; j < ruleSet.length; j++) {
      if (s[i] == ruleSet[j][0])  {
        // write substitution
        outputString += ruleSet[j][1];
        // save match when found without saving over symbol
        isMatching = 1;
        // exit for loop
        break;
      }
    }
    // in case of no matches, copy symbol over
    if (isMatching == 0) outputString+= s[i];
  }
  // return modified string
  return outputString;
}

// natural number to binary converter
function sortPrimes() {
  
  // string label for current number, default A for prime
  let current = 'A';
  
  // calculates for each natural number from 0 to set limit
  for (let i = 0; i < limit; i++) {
    // check if number is equal to 1
    if (i <= 1) {
      // sends B to 'binaryString' if non-prime
      current = 'B';
    }
    // check if number is greater than 1
    else if (i > 1) {

      // looping through 2 to number-1
      for (let z = 2; z < i; z++) {
        if (i % z == 0) {
          // sends B to 'binaryString' if non-prime
          current = 'B';
          break;
        }
      }
    }
    // appends binary value A or B to 'binaryString'
    binaryString = binaryString+current;
  }
}

// draw turtle commands
function drawIt(k) {

  if (k=='F') { // draw forward
    // polar to cartesian based on step and currentAngle:
    let x1 = x + step*cos(radians(currentAngle));
    let y1 = y + step*sin(radians(currentAngle));
    // connect the old and the new
    art.line(x, y, x1, y1);

    // update turtle position
    x = x1;
    y = y1;
  } else if (k == '+') {
    // turn left
    currentAngle += angle; 
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