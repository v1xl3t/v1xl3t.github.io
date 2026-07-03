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
let labScrubS = 0;         // current timeline position, in "frames"
let sOffset = 0;           // lets auto playback restart / resume from a point
let labScrubbing = false;  // true briefly while the wheel is actively moving
let labSticky = 'play';    // tap toggles 'play' <-> 'pause'
let labResumeTimer = null; // resumes auto shortly after the wheel stops
let builtinTable = null;   // the original dataset, kept for "Reset to original data"

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

    builtinTable = table;   // remember the original dataset (lab "reset")
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

    // lab (dormant unless ?lab=1): wheel-scrub or a tapped pause freezes the
    // timeline; otherwise auto-plays and we keep labScrubS tracking "now" so a
    // pause/scrub always starts from the current moment.
    if (LAB)
    {
        if (labScrubbing || labSticky === 'pause') s = labScrubS;
        else labScrubS = s;
    }

    //screen update

    background(9);
    drawNotes();
    drawUI();
    
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
// project (plain /datavis/) never calls any of it. All added portfolio UI lives
// OUTSIDE the project (in a bar above it); the project itself is framed + tagged.

// Highest meaningful timeline position (past this, q clamps anyway).
function labMaxS()
{
    return (60 * 2) * (table.getRowCount() - 1) + 200;
}

function setupLab()
{
    var css = document.createElement('style');
    css.textContent =
      'body.lab{display:flex;flex-direction:column;}'
      // portfolio bar: deliberately dark chrome, NOT the project's cyan, so the
      // added controls read as separate from the original piece.
      + '#pfbar{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;'
      + 'padding:8px 12px;background:#0d1420;border-bottom:1px solid rgba(120,200,255,.25);'
      + 'font-family:"Courier New",monospace;color:#cfe8ff;font-size:12px;position:relative;z-index:30;}'
      + '#pfbar .pf-tag{color:#7fd2ff;font-weight:bold;letter-spacing:.08em;}'
      + '#pfbar .pf-tag b{color:#eaf6ff;font-weight:600;letter-spacing:0;}'
      + '#pfbar .pf-right{display:flex;align-items:center;gap:8px;position:relative;}'
      + '#pfbar button{cursor:pointer;font:inherit;color:#eaf6ff;background:rgba(120,200,255,.14);'
      + 'border:1px solid rgba(120,200,255,.4);border-radius:7px;padding:5px 9px;}'
      + '#pfbar button:hover{background:rgba(120,200,255,.24);}'
      + '#pfmenu{display:none;position:absolute;top:calc(100% + 8px);right:0;min-width:250px;z-index:40;'
      + 'background:#0d1420;border:1px solid rgba(120,200,255,.35);border-radius:10px;padding:10px;'
      + 'flex-direction:column;gap:8px;box-shadow:0 10px 30px rgba(0,0,0,.5);}'
      + '#pfmenu.open{display:flex;}'
      + '#pfmenu label{cursor:pointer;font-size:12px;color:#eaf6ff;background:rgba(120,200,255,.14);'
      + 'border:1px solid rgba(120,200,255,.4);border-radius:7px;padding:7px 9px;text-align:center;}'
      + '#pfmenu a{font-size:12px;color:#9ad8ff;text-decoration:none;border-bottom:1px dashed rgba(154,216,255,.5);align-self:flex-start;}'
      + '#pfmenu .hint{font-size:11px;color:#cfe8ff;opacity:.75;line-height:1.5;}'
      + '#pfmenu .div{height:1px;background:rgba(120,200,255,.2);margin:2px 0;}'
      // stage: fills the rest; the framed box = the ORIGINAL project.
      + '#pfstage{position:relative;flex:1 1 auto;min-height:0;margin:10px;border:1px solid rgba(120,200,255,.3);'
      + 'border-radius:8px;overflow:hidden;}'
      + '#pfstage .pf-orig{position:absolute;top:6px;left:8px;z-index:5;font:11px "Courier New",monospace;'
      + 'color:rgba(180,225,255,.85);background:rgba(6,12,20,.55);border:1px solid rgba(120,200,255,.25);'
      + 'border-radius:6px;padding:2px 7px;pointer-events:none;}'
      + 'body.lab canvas{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;object-fit:contain!important;}';
    document.head.appendChild(css);

    document.body.classList.add('lab');

    // ----- portfolio bar (added UI, outside the project) -----
    var bar = document.createElement('div');
    bar.id = 'pfbar';
    bar.innerHTML =
        '<span class="pf-tag">PORTFOLIO&nbsp;·&nbsp;<b>added controls</b></span>'
      + '<span class="pf-right">'
      +   '<button id="pfPlay" title="Play / pause (or tap the piece)">&#10074;&#10074; Pause</button>'
      +   '<button id="pfData" title="Bring your own data">Data &#9662;</button>'
      +   '<div id="pfmenu">'
      +     '<label>Upload Google Trends CSV<input id="labFile" type="file" accept=".csv,text/csv" hidden></label>'
      +     '<a href="https://trends.google.com/trends/explore" target="_blank" rel="noopener">Open Google Trends &#8599;</a>'
      +     '<div class="hint">Add up to 3 search terms in Google Trends, then on the "Interest over time" card use the &#8943; menu &#8594; <b>Download CSV</b>, and upload it here.</div>'
      +     '<div class="div"></div>'
      +     '<button id="pfReset">Reset to original data</button>'
      +     '<div class="hint">Scroll the piece to scrub the timeline (it resumes on its own). Tap it to play / pause.</div>'
      +   '</div>'
      + '</span>';
    document.body.insertBefore(bar, document.body.firstChild);

    // ----- stage wrapping the p5 canvas (framed = the original project) -----
    var stage = document.createElement('div');
    stage.id = 'pfstage';
    var tag = document.createElement('div');
    tag.className = 'pf-orig';
    tag.textContent = '▸ original project (2020)';
    stage.appendChild(tag);
    document.body.appendChild(stage);
    var cnv = document.querySelector('canvas');
    if (cnv) stage.appendChild(cnv);   // move the canvas into the framed stage

    // ----- wiring -----
    var menu = document.getElementById('pfmenu');
    document.getElementById('pfData').addEventListener('click', function(e){
        e.stopPropagation(); menu.classList.toggle('open');
    });
    document.addEventListener('click', function(){ menu.classList.remove('open'); });
    menu.addEventListener('click', function(e){ e.stopPropagation(); });

    document.getElementById('pfPlay').addEventListener('click', labToggle);
    document.getElementById('pfReset').addEventListener('click', labResetData);
    document.getElementById('labFile').addEventListener('change', onLabFile);

    // tap the piece to play / pause
    if (cnv) cnv.addEventListener('click', labToggle);

    // wheel scrubs; auto resumes ~0.8s after the wheel stops (unless tapped-paused)
    stage.addEventListener('wheel', function(e){
        labScrubbing = true;
        labScrubS = constrain(labScrubS + e.deltaY * 0.9, 0, labMaxS());
        clearTimeout(labResumeTimer);
        labResumeTimer = setTimeout(function(){
            labScrubbing = false;
            if (labSticky === 'play') sOffset = frameCount - labScrubS;
        }, 800);
        e.preventDefault();
    }, { passive: false });

    labUpdatePlayBtn();
}

// Tap / button toggles a sticky play <-> pause.
function labToggle()
{
    if (labSticky === 'play') { labSticky = 'pause'; }              // freeze at current position
    else { labSticky = 'play'; sOffset = frameCount - labScrubS; }  // resume from frozen point
    labUpdatePlayBtn();
}

function labUpdatePlayBtn()
{
    var b = document.getElementById('pfPlay');
    if (b) b.innerHTML = (labSticky === 'play') ? '❚❚ Pause' : '▶ Play';
}

function labResetData()
{
    if (!builtinTable) return;
    table = builtinTable;
    processTable();
    sOffset = frameCount; labScrubS = 0; labScrubbing = false; labSticky = 'play';
    labUpdatePlayBtn();
    document.getElementById('pfmenu').classList.remove('open');
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
            labScrubbing = false;
            labSticky = 'play';
            labScrubS = 0;
            labUpdatePlayBtn();
            document.getElementById('pfmenu').classList.remove('open');
        } catch (err) {
            alert('Could not read that CSV: ' + err.message);
        }
    };
    reader.readAsText(f);
}