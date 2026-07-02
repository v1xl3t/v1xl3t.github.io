//Class - CSMA 101 F1 
//Title - Introduction to Programming
//Semester - Fall 2020
//Instructor - Echo Theohar
//Student - Vi Ellis
//Contact - vi-ellis.com

var table;

//starting fps

let fr = 60;

//variables for search terms

var blueA;
var redB;
var yellowC;

//variables for instruments

var pianoStr = [];
var pianoNote = [];
var pianoPlay = [];

var pianoLast = 0;

var stringStr = [];
var stringNote = [];
var stringPlay = [];

var stringLast = 0;

var violinStr = [];
var violinNote = [];
var violinPlay = [];

var violinLast = 0;

//variables from table

var week = [];

var termA = [];  
var noteA = [];
    
var termB = [];    
var noteB = []; 

var termC = [];
var noteC = [];

var tempStr;

//variables for notes

var noteSelect = [];

var blueX = [];
var redX = [];
var yellowX = [];

let noteY = [];

let volume = 0.005;
var slider;

//variable for bypassing autoplay restrictions

let ctx, ctxOn;

//for note animation

let s;
let q;

//for test

var z = 0;

// ---- LAB MODE (modal-only extras; DORMANT unless the page is opened with ?lab=1) ----
// When off, everything below is inert and the sketch behaves exactly as the original.
const LAB = (function(){ try { return new URLSearchParams(window.location.search).has('lab'); } catch(e){ return false; } })();
let labManual = false;   // becomes true once the viewer scrubs with the wheel
let labScrubS = 0;       // manual timeline position, in "frames"
let sOffset = 0;         // lets the auto timeline restart (e.g. after a CSV upload)

function preload()
{
    //state audio format
    
    soundFormats("mp3");
    
    //load table
    
    table = loadTable("dataProjectFolder/multiTimelineFinal2.csv");
    
    //load sounds into array, sets note values
    
    for(var i = 0; i < 21; i++)
    {
        pianoStr[i] = "dataProjectFolder/piano" + i;
        pianoNote[i] = loadSound(pianoStr[i]);
        pianoPlay[i] = false;
        
        stringStr[i] = "dataProjectFolder/string" + i;
        stringNote[i] = loadSound(stringStr[i]);
        stringPlay[i] = false;
        
        violinStr[i] = "dataProjectFolder/violin" + i;
        violinNote[i] = loadSound(violinStr[i]);
        violinPlay[i] = false;
        
        noteSelect[i] = (i * 40) + 160;
    }
}

function setup()
{   
    createCanvas(1000, 750);
    
    //sets frame rate
    
    frameRate(fr);
    
    //for bypassing autoplay restrictions
    
    ctx = getAudioContext();
    ctxOn = createButton('Turn on Audio');
    ctxOn.mousePressed(() =>
    {
        ctx.resume().then(() => 
        {
            console.log('Audio Context is now ON');
            ctxOn.hide();
        });
    });
    
    //convert table info to array variables

    processTable();

    slider = createSlider(0, 1, 0.5, 0.01);

    // wake the modal-only lab tools (no-op unless ?lab=1)
    if (LAB) setupLab();

    loaded();
}

// Build the note arrays from the current `table`. Factored out of setup() so a
// lab CSV upload can rebuild everything from a new dataset. Behaviour for the
// built-in dataset is identical to the original inline loop.
function processTable()
{
    week = []; termA = []; noteA = []; termB = []; noteB = []; termC = []; noteC = [];

    for(var i = 0; i < table.getRowCount() - 2; i++)
    {
        week[i] = table.getString(i + 2, 0);

        //maps termA popularity to note

        tempStr = splitTokens(table.getString(i + 2, 1), '<');
        tempStr.sort();
        termA[i] = int(tempStr[0]);

        for(var j = 5; j < 100; j += 5)
        {
            if(termA[i] <= j)
            {
                noteA[i] = (j - 5)/5;

                j = 100;
            }
        }

        //maps termB popularity to note

        tempStr = splitTokens(table.getString(i + 2, 2), '<');
        tempStr.sort();
        termB[i] = int(tempStr[0]);

        for(var j = 5; j < 100; j += 5)
        {
            if(termB[i] <= j)
            {
                noteB[i] = (j - 5)/5;

                j = 100;
            }
        }

        //maps termB popularity to note

        tempStr = splitTokens(table.getString(i + 2, 3), '<');
        tempStr.sort();
        termC[i] = int(tempStr[0]);

        for(var j = 5; j < 100; j += 5)
        {
            if(termC[i] <= j)
            {
                noteC[i] = (j - 5)/5;

                j = 100;
            }
        }
    }
}

function loaded()
{
    ready = true;
}

function draw()
{
    //timer

    s = frameCount - sOffset;

    // lab: the wheel takes over the timeline (dormant unless ?lab=1)
    if (LAB && labManual) s = labScrubS;

    //screen update

    background(9);
    drawNotes();
    drawUI();

    if (LAB) drawLabHint();
    
    if(s > (week.length * 60) + 750)
    {
        if(volume < slider.value())
        {
            volume += 0.005; 
        }
        
        stringNote[stringLast].setVolume(slider.value() - volume);
        pianoNote[pianoLast].setVolume(slider.value() - volume);
        violinNote[violinLast].setVolume(slider.value() - volume);
    }
    
    else
    {
        stringNote[stringLast].setVolume(slider.value());
        pianoNote[pianoLast].setVolume(slider.value());
        violinNote[violinLast].setVolume(slider.value());
    }
}

function drawNotes()
{
    //frame 1 - frame 60 x 2 (full loop) x note total > note 0 - note total x note length * 2 (full loop)
    
    q = map(s, 1, (60 * 2) * (table.getRowCount() - 1), 0, (table.getRowCount() - 2) * 40 * 2, true);
    
    let j = 0;
    
    for(var i = 0; i < week.length; i++)
    {   
        noteY[i] = j + q;
        
        fill(255);
        textSize(18);
        text(week[i], 24, noteY[i] + 30);
        
        fill(0, 0, 255);
        blueX[i] = (noteA[i] * 40) + 160;
        rect(blueX[i], noteY[i], 40, 40, 6);

        //string note player
    
        for(var k = 0; k < noteSelect.length; k++)
        {
            if(blueX[i] == noteSelect[k] && noteY[i] <= 570 && noteY[i] >= 530)
            {
                if(!stringNote[k].isPlaying())
                {
                    if(stringNote[stringLast].isPlaying())
                    {
                        stringNote[stringLast].stop();
                    }
                    
                    stringNote[k].loop();
                    stringLast = k;
                }
            }
        }
        
        fill(255, 0, 0);
        redX[i] = (noteB[i] * 40) + 160;
        rect(redX[i], noteY[i], 40, 40, 6);
        
        //piano note player
    
        for(var k = 0; k < noteSelect.length; k++)
        {
            if(redX[i] == noteSelect[k] && noteY[i] <= 570 && noteY[i] >= 530)
            {
                if(!pianoNote[k].isPlaying())
                {
                    if(pianoNote[pianoLast].isPlaying())
                    {
                        pianoNote[pianoLast].stop();
                    }
                    
                    pianoNote[k].loop();
                    pianoLast = k;
                }
            }
        }
        
        fill(255, 255, 0);
        yellowX[i] = (noteC[i] * 40) + 160;
        rect(yellowX[i], noteY[i], 40, 40, 6);
        
        //violin note player
    
        for(var k = 0; k < noteSelect.length; k++)
        {
            if(yellowX[i] == noteSelect[k] && noteY[i] <= 570 && noteY[i] >= 530)
            {
                if(!violinNote[k].isPlaying())
                {
                    if(violinNote[violinLast].isPlaying())
                    {
                        violinNote[violinLast].stop();
                    }
                    
                    violinNote[k].loop();
                    violinLast = k;
                }
            }
        }
        
        j -= 40;
        
        //map(volume, i, week.length, 1, 0);
        
        //stringNote[stringLast].setVolume(volume);
    }
}

function drawUI()
{
    //info boxes
    
    fill(5, 184, 255);
    rect(0, 0, 1000, 60, 0);
    rect(0, 570, 160, 180, 0);
    
    fill(255);
    noStroke();
    rect(10, 645, 140, 93, 6);
    
    fill(0);
    noStroke();
    textSize(21);
    text("--- Search term popularity over time --- Based on data collected by Google --- Project by Vi Ellis ---", 30, 38);

    textSize(10);
    text("Key - C Major", 50, 600);
    text("Tempo - 120", 50, 627);
    
    //blue (1st) search term
    
    blueA = splitTokens(table.getString(1, 1), ':');
    text(blueA[0] + " - string", 40, 663);
    
    //red (2nd) search term
    
    redB = splitTokens(table.getString(1, 2), ':');
    text(redB[0] + " - piano", 40, 693);
    
    //yellow (3rd) search term
    
    yellowC = splitTokens(table.getString(1, 3), ':');
    text(yellowC[0] + " - violin", 40, 723);
    
    fill(0, 0, 255);
    circle(25, 660, 15);
    
    fill(255, 0, 0);
    circle(25, 690, 15);
    
    fill(255, 255, 0);
    circle(25, 720, 15);

    //white keys
    
    var j = 160;
    var k = 0;
    
    for(var i = 0; i < 21; i++)
    {
        fill(255);
        stroke(0);
        rect(j, 570, 40, 180, 6);
        
        fill(0);
        noStroke();
        textSize(15);
        text(k + "%", j + 6, 740);
        
        j += 40;
        k += 5;
    }
    
    //black keys

    var l = 160;

    for(var i = 0; i < 21; i++)
    {
        if(i != 2 && i != 6 && i != 9 && i != 13 && i != 16 && i != 20)
        {
            fill(9);
            rect(l + 28, 570, 24, 120, 6);
        }

        l += 40;
    }
}

// ======================= LAB MODE (modal-only) =======================
// Everything below only runs when the page is opened with ?lab=1. The built-in
// project (plain /datavis/) never calls any of it.

// Highest meaningful timeline position (past this, q clamps anyway).
function labMaxS()
{
    return (60 * 2) * (table.getRowCount() - 1) + 200;
}

// Place the lab bar just under the cyan title bar. The canvas is object-fit:
// contain, so work out where the 1000x750 drawing actually sits in the viewport.
function positionLabBar()
{
    var bar = document.getElementById('labbar');
    if (!bar) return;
    var scale = Math.min(window.innerWidth / 1000, window.innerHeight / 750);
    var drawnTop = (window.innerHeight - 750 * scale) / 2;
    var drawnLeft = (window.innerWidth - 1000 * scale) / 2;
    bar.style.top = (drawnTop + 60 * scale + 8) + 'px';   // 60 = title-bar height
    bar.style.left = (drawnLeft + 12) + 'px';
}

function setupLab()
{
    var css = document.createElement('style');
    css.textContent =
      '#labbar{position:fixed;top:12px;left:12px;z-index:20;display:flex;gap:8px;align-items:center;'
      + 'font-family:"Courier New",monospace;font-size:12px;color:#cfe8ff;background:rgba(6,12,20,.66);'
      + 'border:1px solid rgba(120,200,255,.35);border-radius:10px;padding:7px 9px;}'
      + '#labbar .tag{color:#7fd2ff;font-weight:bold;letter-spacing:.09em;}'
      + '#labbar button,#labbar label{cursor:pointer;font:inherit;color:#eaf6ff;background:rgba(120,200,255,.14);'
      + 'border:1px solid rgba(120,200,255,.4);border-radius:7px;padding:4px 8px;}'
      + '#labbar a{color:#9ad8ff;text-decoration:none;border-bottom:1px dashed rgba(154,216,255,.5);}'
      + '#labbar #labAuto{display:none;}';
    document.head.appendChild(css);

    var bar = document.createElement('div');
    bar.id = 'labbar';
    bar.innerHTML =
        '<span class="tag">LAB</span>'
      + '<label>Upload Trends CSV<input id="labFile" type="file" accept=".csv,text/csv" hidden></label>'
      + '<a href="https://trends.google.com/trends/explore" target="_blank" rel="noopener">Google Trends ↗</a>'
      + '<button id="labAuto" title="Resume automatic playback">▶ Auto</button>';
    document.body.appendChild(bar);
    positionLabBar();
    window.addEventListener('resize', positionLabBar);

    document.getElementById('labFile').addEventListener('change', onLabFile);
    document.getElementById('labAuto').addEventListener('click', function(){
        labManual = false;
        sOffset = frameCount - labScrubS;   // continue auto-play from here
        this.style.display = 'none';
    });

    // mouse wheel scrubs the timeline manually
    window.addEventListener('wheel', function(e){
        labManual = true;
        var a = document.getElementById('labAuto');
        if (a) a.style.display = 'inline-block';
        labScrubS = constrain(labScrubS + e.deltaY * 0.9, 0, labMaxS());
        e.preventDefault();
    }, { passive: false });
}

// Parse an uploaded Google Trends "Interest over time" CSV into a minimal
// stand-in for a p5 Table (blank lines dropped, so row 1 = header, row 2+ = data).
function parseTrendsCSV(text)
{
    var rows = text.split(/\r?\n/)
                   .filter(function(line){ return line.trim().length > 0; })
                   .map(function(line){ return line.split(','); });
    return {
        getRowCount: function(){ return rows.length; },
        getString: function(r, c){ return (rows[r] && rows[r][c] != null) ? rows[r][c] : ''; }
    };
}

function onLabFile(e)
{
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function(){
        try {
            var shim = parseTrendsCSV(reader.result);
            if (shim.getRowCount() < 3 || shim.getString(1, 3) === '') {
                alert('That does not look like a 3-term Google Trends "Interest over time" export. Add three search terms and download the CSV.');
                return;
            }
            table = shim;
            processTable();
            sOffset = frameCount;   // restart the timeline from the top
            labManual = false;
            labScrubS = 0;
            var a = document.getElementById('labAuto');
            if (a) a.style.display = 'none';
        } catch (err) {
            alert('Could not read that CSV: ' + err.message);
        }
    };
    reader.readAsText(f);
}

// Subtle on-canvas hint so the viewer knows the wheel is interactive.
function drawLabHint()
{
    push();
    textAlign(CENTER);
    noStroke();
    if (!labManual) {
        var a = 130 + 90 * sin(frameCount * 0.06);
        fill(180, 225, 255, a);
        textSize(15);
        text('↕ scroll to scrub the timeline', 500, 90);
    } else {
        fill(180, 225, 255, 150);
        textSize(13);
        text('manual — use ▶ Auto to resume', 500, 90);
    }
    pop();
}