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
  
  // instantiate graphics window
  createCanvas(3000, 3000);
  background(255);

  // determine start position (center)
  x = width/2;
  y = height-(height/2);

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

  for (let n = 0; n < stepsPerFrame; n++) {
    // draw current character in the string
    drawIt(binaryString[stringWorm]);

    // increment reading point within string, wrap end
    stringWorm++;
    if (stringWorm > binaryString.length-1) stringWorm = 0;
  }

}

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
    line(x, y, x1, y1);

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
  fill(r, g, b, a);
  stroke(r, g, b, a);
  ellipse(x, y, radius, radius);
}