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
    slider = createSlider(0, 1, 0.5, 0.01);
    
    loaded();
}

function loaded()
{
    ready = true;
}

function draw()
{
    //timer
    
    s = frameCount;
    
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