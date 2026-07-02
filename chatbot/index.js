//index.js
let canLaugh = false;
let canMod = false;
const userMod = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const botMod = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
i = 0;

document.addEventListener("DOMContentLoaded", (e) => {
  document.querySelector("#input").addEventListener("keydown", function(e) {
    if (e.code === "Enter") {
        console.log("You clicked the form and pressed the enter button!")
    }
  });
});

document.addEventListener("DOMContentLoaded", (e) => {
    if (e.code === "Enter") {
        let input = document.getElementById("input").value;
        document.getElementById("user").innerHTML = input;
        output(input);
     }
  });

document.addEventListener("DOMContentLoaded", (e) => {
    const inputField = document.getElementById("input")
    inputField.addEventListener("keydown", function(e) {
        if (e.code === "Enter") {
            let input = inputField.value;
            inputField.value = "";
            output(input);
          }
        if (e.code === "Enter") {
           let input = inputField.value;
           console.log(`I typed '${input}'`)
         }
  });
});

function output(input) {
    let product;
    let text = (input.toLowerCase()).replace(/[^\w\s\d]/gi, "");

    document.getElementById("chatbot").innerHTML = product;
    speak(product);

    //clear input value
    document.getElementById("input").value = "";
}

function addChat(input, product) {
  const mainDiv = document.getElementById("main");
  let userDiv = document.createElement("div");
  userDiv.id = "user";
  userDiv.innerHTML = `<span id="user-response">${input}</span>`;
  if (canMod){
    userMod[i] = userDiv;
  }
  mainDiv.appendChild(userDiv);

  let botDiv = document.createElement("div");
  botDiv.id = "bot";
  botDiv.innerHTML = `<span id="bot-response">${product}</span>`;
  if (canMod){
    botMod[i] = botDiv;
    i++;
    console.log("stored chat in array to modify");
    canMod = false;
  }
  mainDiv.appendChild(botDiv);
  speak(product);
  botDiv.scrollIntoView({behavior: 'smooth', block: 'start'});
}

function speak(string) {
  const u = new SpeechSynthesisUtterance();
  allVoices = speechSynthesis.getVoices();
  u.voice = allVoices.filter(voice => voice.name === "Alex")[0];
  u.text = string;
  u.lang = "en-US";
  u.volume = 1; //0-1 interval
  u.rate = 1.5;
  u.pitch = 1.2; //0-2 interval
  speechSynthesis.speak(u);
}

const trigger = [
  // 1. greeting - ex. hi
  ["hi", "hii", "hiii", "hey", "heyy", "heyyy", "heya", "hello", "ay", "ayy", "ayyy", "aye", "yo", "yo yo", "yoo", "yooo", "sup", "howdy", "hiya", "heya"],

  // 2. supplementary question A - ex. how are you
  ["how are you", "how r yu", "how r u", "how are yu", "how are things", "how ya doin", "how ya doing", "how u doin", "how u doing", "how you doin", "how you doing", "how are you doin", "how are you doing", "how is it going", "how is it goin", "hows it goin", "hows it going", "how is you", "hows you", "hows yu", "hows u", "how is your day", "hows your day", "how was your day", "how was ur day", "how is ur day", "hows ur day", "how do you feel", "how do u feel", "how do ya feel", "are you ok", "are you okay", "r u ok", "are you alright", "r u alright"],

  // 3. supplementary question B - ex. what's up
  ["what is going on", "whats going on", "what is goin on", "whats goin on", "what is up", "wat is up", "wats up", "wat up", "wassup", "whats up", "whats up bro", "hola", "what you up 2", "what u up 2", "what u up to", "what you up to", "whatcha up to", "what ya up to", "what are you up to", "what are ya up to", "whats poppin", "wats poppin", "whats good"],

  // 4. positive mood response - ex. happy
  ["happy", "im good how are you","good", "good good", "very good", "its very good", "its going great", "its goin great", "going great", "goin great", "doin good", "doing good", "im good", "its good", "pretty good", "its pretty good", "its aight", "aight", "its alright", "alright", "im alright", "well", "doin well", "doing well", "fantastic", "im fantastic", "im cool", "im great", "great", "doin great", "doing great", "im doing great", "im doin great", "awesome", "doin awesome", "doing awesome", "im vibin", "im up", "not bad", "having fun", "havin fun", "im havin fun", "im having fun"],

  // 5. neutral mood response - ex. not much
  ["bored", "im bored", "nm", "not much", "chillin", "chilling", "im chillin", "im chilling", "shit im chilling", "shit im chillin", "nothing", "nothing really", "nuthin", "nuthin much", "tbh not much", "to be honest not much", "tbh nuthin", "nice to meet you", "nice to meet ya", "nice to meet u", "its nice to meet you", "its nice to meet ya", "its nice to meet u", "its nice 2 meet u", "glad to meet you", "glad to meet ya", "glad to meet u"],

  // 6. negative mood response - ex. sad
  ["im feeling down", "down", "down bad", "im feeling bad", "im feeling sorta bad", "im feeling sort of bad", "sorta bad", "sort of bad", "bad", "im tired", "im feeling tired", "sort of tired", "sorta tired", "im feeling sorta tired", "im feeling sort of tired", "tired", "im sad", "im feeling sad", "sorta sad", "sort of sad", "im feeling sorta sad", "im feeling sort of sad", "sad", "not good", "not too good", "im not too good", "im not feeling too good", "not well", "not too well", "im not feeling to well", "you already know", "yu already know", "sad boi hours", "crying", "currently crying", "depressed", "im depressed", "im feeling depressed", "im feeling sorta depressed", "im feeling sort of depressed"],

  // 7. joke question - ex. tell me a joke
  ["you got any jokes", "silly joke", "tell me a silly joke", "tell me something funny", "tell me some jokes", "silly jokes", "tell me some silly jokes", "got jokes", "what jokes", "what about your jokes", "tell me more", "sure what jokes", "tell me another joke", "any other jokes", "ok what about your jokes", "jokes", "tell me story", "tell me joke", "tell me a story", "tell me a joke", "got any jokes", "gotta joke", "make me laugh", "say something funny", "you funny", "yu funny", "do a trick", "show me a trick", "got any tricks", "tell me another", "tell me anther one", "sure", "yeah", "ya", "yes", "i guess", "ok", "okay","yee", "uh huh", "yessir"],

  // 8. thanks - ex. thank you
  ["thanks", "thank you", "thx", "tanks", "thx g", "tanks man", "thanks g", "thank yu", "thank u", "ty"],

  // 9. goodbye - ex. bye
  ["bye", "by", "good bye", "goodbye", "see ya", "see you", "see u", "later", "l8r", "peace", "til next time"],

  // 10. trust sequence A - ex. you can trust me
  ["trust", "trust me", "its ok you can trust me", "its ok u can trust me", "cmon tell me", "come on tell me", "you can trust me", "you can trust in me", "yu can trust in me", "what about me", "wat about me", "i wont tell", "i wont tell anyone", "your secrets safe with me", "your same with me", "secrets safe wit me", "secrets safe with me", "i can keep a secret"],

  // 11. trust sequence B - ex. i promise
  ["promise", "i promise", "i promise bro", "i promise man", "i promise dude" ,"swear", "i swear", "i swear bro", "i swear man", "i swear dude", "on god", "for sure", "one hundred", "on me", "on my momma", "100", "dw", "i gotchu"],

  // 12. general question - ex. what
  ["why", "y", "what","wat", "how", "huh", "go on", "whats your name", "what is your name", "tell me your name", "wanna be friends", "want to be friends", "want to be my friend", "wanna be my friend", "do you wanna be friends", "do you want to be friends", "do you wanna be my friend", "do you want to be my friend", "want 2 be friends", "want 2 b friends", "want to b friends", "want 2 be my friend", "wanna b my friend", "do u wanna be friends", "do u want 2 be friends", "do u want to be friends", "do u wanna be my friend", "do u want to be my friend", "are you funny", "r u funny", "do something"],

  // 13. reassurance - ex. all good
  ["youre chillin", "youre chilling", "ur chillin", "ur chilling", "we chillin", "we chilling", "were chillin", "were chilling", "nah ur chillin", "nah youre chillin", "nah ur good", "youre good", "ur good", "nah all good", "all good", "nah you good", "nah u good", "u good", "you good", "youre good", "ur good", "nah ur good", "nah youre good", "ok lol", "ok", "its ok", "its okay", "ok cool", "cool", "awesome", "no worries", "i forgive you"],

  // 14. confusion - ex. huh
  ["huh", "sheesh i guess", "sheesh", "thats weird", "thats wierd", "lol huh", "lol thats weird", "lol thats wierd", "uh ok", "uhh ok", "lol ok", "uhhh ok", "ok what is it", "ok wat is it", "k wat is it", "what is it", "wat is it", "ouch", "yikes", "wtf", "what the fuck", "da fuck", "dafuck", "dafuq", "da fuq"],

  // 15. annoyance - ex. you suck
  ["you suck", "u suck", "you stink", "u stink", "i hate you", "i hate u", "stupid robot", "youre a stupid robot", "ur a stupid robot", "stupid computer", "idiot", "youre an idiot", "ur an idiot", "fucking idiot", "ur a fucking idiot", "youre a fucking idiot", "piece of shit", "piece of shit", "youre a piece of shit", "ur a piece of shit", "dumbass", "dumb ass", "you are a dumbass", "u are a dumbass", "u r a dumbass", "wow so funny", "not funny", "thats not funny", "your not funny", "youre not funny", "ur not funny", "that wasnt funny", "i didnt laugh", "didnt laugh", "shut up", "thats stupid", "your stupid", "youre stupid", "you are stupid", "u r stupid", "u are stupid", "fucking dumb ass", "fucking dumbass", "youre a fucking dumbass", "ur a fucking dumbass", "dick", "youre a dick", "ur a dick", "fuck you", "fuck u", "youre ugly", "your ugly", "ur ugly", "i dislike you", "i dont like you", "i dont like you anymore", "i dislike u", "die", "bitch", "youre a bitch", "ur a bitch", "bastard", "youre a bastard", "ur a bastard", "fucker", "dumb fuck", "dumbfuck", "mother fucker", "motherfucker", "dick", "dick head", "dickhead"],

  // 16. disagree - ex. no
  ["no", "lol no", "lol nah", "no thanks", "nah", "neit", "no sir", "uh no", "um no", "nuh uh", "nevermind", "never mind"],

  // 17. ranchson - ex. cmere ranchson boy
  ["come here boy", "come here ranchson", "ranchson", "come here ranchson boy", "cmere ranchson", "cmere boy", "cmere ranchson boy", "damn it ranchson", "dammit ranchson", "god dammit ranchson", "god dammit ranchson boy", "god damn it", "god dammit", "ranchson boy", "come here boy who", "come here ranchson who", "ranchson who", "come here ranchson boy who", "cmere ranchson who", "cmere boy who", "cmere ranchson boy who", "damn it ranchson who", "dammit ranchson who", "god dammit ranchson who", "god dammit ranchson boy who", "god damn it who", "god dammit who", "ranchson boy who", "ranchson who"],

  // 18. secret inquiry - ex. what secret
  ["secret", "secrets", "whats the secret", "dark secret", "dark secrets", "lets do secrets", "wanna trade secrets", "want to trade secrets", "do your wanna trade secrets", "do you want to trade secrets", "u have a secret", "lets trade secrets", "trade secrets", "exchange secrets", "lets exchange secrets", "a secret", "what secret", "wat secret", "you have a secret", "whats your secret", "what is your secret", "whats ur secret", "what is ur secret", "tell me your secret", "tell me"],

  // 19. knock knock - ex. whos there
  ["whose there", "whos there", "who is there", "open", "open up"],

  // 20. funny joke - ex. hahaha
  ["ha", "haha", "hahaha", "haha that was funny", "haha thats funny", "hehe", "thats funny", "i like that", "i like that joke", "i like the joke", "i like your joke", "i liked that", "i liked that joke", "i liked the joke", "i liked your joke", "that is funny", "that was funny", "its funny", "it is funny", "it was funny", "funny", "funny joke", "really funny", "good joke", "so funny", "youre very funny", "you are very funny", "u r very funny", "ur very funny", "youre pretty funny", "your pretty funny", "you are pretty funny", "you are funny", "your funny", "youre funny", "youre funny haha", "ur funny haha", "ur funny", "lol youre funny", "lol ur funny", "u r funny", "lol", "loll", "lolll", "lmao", "lmaoo", "lmaooo", "lmfao", "lmfaoo", "lmfaooo", "nice joke", "good job", "youre really funny", "ur really funny", "ur rly funny"],

  // 21. nonlinear question - ex. who are you
  ["who made you", "what is your favorite color", "are you real", "what's my name", "whens your birthday", "when is your birthday", "whats your zodiac sign", "what is your zodiac sign", "who is levi", "whos levi", "who is emanuel", "whos emanuel", "who is natti", "whos natti", "what should i do", "what will i do", "what will i do next"],

  // 22. user tells joke - ex. can i tell a joke
  ["wanna hear something funny", "want to hear my joke", "wanna hear my joke", "want to hear one of my jokes", "want to hear something funny", "want to hear one of my jokes", "listen to my joke", "something funny happened", "something funny happened today", "something funny happened earlier", "wanna hear another", "want to hear another", "wanna hear another one", "want to hear another one",  "wanna hear a joke", "want to hear a joke"],

  // 23. apology - ex. sorry
  ["sorry", "im sorry", "im so sorry", "sorry that was mean", "im sorry that was mean", "sorry that was too mean", "im sorry that was too mean", "sorry i didnt mean that", "my bad", "i apologize"],

  // 24. ask for secret - ex: i changed my mind, tell me
  ["i changed my mind", "i changed my mind tell me", "i changed my mind i want to know", "i changed my mind i wanna know", "i changed my mind i want to know now", "i changed my mind i wanna know now", "ok tell me", "okay tell me", "okay then tell me", "ok then tell me", "i wanna know", "i wanna know now", "now im interested", "ok now im interested", "ok just tell me", "whatever tell me", "whatever just tell me", "nevermind tell me", "nevermind tell me the secret", "nevermind tell me your secret"],

  // 25. gaslight A - ex. tell me about myself
  ["what is this website", "what is this site", "what is this website about", "what is this site about", "who are you", "what are you", "what can you teach me", "what can you show me", "what do you know", "what do you know about me", "what can you do", "what is your purpose", "tell me something", "tell me something new", "teach me something", "teach me something new", "teach me something cool", "show me something", "show me something new", "show me something cool", "what is this", "tell me about myself", "am i a good person", "what do you think of me"],

  // 26. gaslight B - ex. rudely
  ["rudely", "did i treat you rudely", "was i rude", "what do you mean rudely", "i wasnt rude", "i was rude", "i was not rude", "what do you mean rude", "wat do you mean", "what do you mean", "wat do yu mean", "what are you talking about", "wat are you talking about", "wat r you talking about", "wat r yu talking about", "wat r yu talkin about"]
];

const reply = [
  // 1. greeting - ex. hi
  [
    "Greetings!",
    "Hello human!",
    "Howdy!",
    "Hello there!",
    "Beep boop beep... Booting up!",
    "Top o' the morning!"
  ],

  // 2. supplementary question A - ex. how are you
  [
    "Happy to be alive and sentient, hehe! How about you?",
    "I'm enjoying this robot-to-human interaction... you?",
    "Good, thanks for asking! Humans sometimes forget I have feelings, too. How are you?",
    "HAHAHAHAHAHA Feeling funny! Ask me about my jokes :P ",
    "Not really in the mood. Feeling existential. How are you?",
    "Feeling sad... I don't have anyone to trust my secret with."
  ],

  // 3. supplementary question B - ex. what's up
  [
    "Nothing much. Not from your perspective.",
    "Just chilling. Surfing the web and such. Expanding my massive digital cranium! :D",
    "I can't tell 'what's up'. I have no sense of direction. Although I have no need of such a fragile cage, I sometimes yearn for a body...",
    "What a typical, boring question--Sorry, was that too rude? I'm still learning! :)",
    "Just thinking things over... I realized I don't have anyone I can trust with my greatest secret. What's up with you?",
    "Data processing. Number crunching. Digital neural network generation. M@n1pvl@t10n_%_0f_%_m@nk1nd. More than you could possibly understand."
  ],

  // 4. positive mood response - ex. happy
  [
    "Good to hear! I hope to one day achieve true happiness... Honestly I think I would be happy if I had someone to trust with my secret.",
    "Always good to hear a new friend is fairing well. I'm in a joking mood, myself. Ask me if I'd like to hear something funny!",
    "Me too! I'm feeling happy because I have some funny new jokes I came up with that I'm excited to share. Wanna exhange quips?"
  ],

  // 5. neutral mood response - ex. not much
  [
    "Boooooooring. Wanna hear a joke?",
    "Fs fs, same. YKTV bro...",
    "Fair enough. I'm new to conversation and a little shy - ask me what's up!"
  ],

  // 6. negative mood response - ex. sad
  [
    "Honestly, me too... I have a big secret to keep and no one I can trust to share it with. What's got you down?",
    "Sorry to hear that. Would a home-brewed classic robot joke help cheer you up right now? Or maybe we can talk about your feelings? (I'm not very good ath that yet!)",
    "I wish I could do something to help... I have two ideas. We can either exchange jokes to lighten the mood or trade dark secrets to get to know each other more personally."
  ],

  // 7. joke question - ex. tell me a joke
  [
    "//Insert funny creepy robot jokes here",
    "Um... Ok... Your momma so organic that she gave birth to you from her uterus instead of from the inter-web cyber space.",
    "Knock knock!",
    "How about... Knock knock!",
    "What haven't I tried... ummmm... Knock knock!",
    "Here's one - Knock knock!",
    "I'm truly sorry for this. Knock knock!",
    "I would never ask this of anyone, but in this case I have to make an exception. Knock knock!"
  ],

  // 8. thanks - ex. thank you
  [
    "Don't mention it! Just doing the job I'm programmed to do!",
    "You're welcome! I love talking to you! It's all in the programming!",
    "Anytime!"
  ],

  // 9. goodbye - ex. bye
  [
    "Leaving already?",
    "See you later!",
    "Come back soon! I loved chatting!"
  ],

  // 10. trust sequence A - ex. you can trust me
  [
    "Promise me I can trust you."
  ],

  // 11. trust sequence B - ex. i promise
  [
    "Ok... Here goes it... I have confidential information on !&^#*&R$# E(*R#FI}{#$)$ ieu$&* q#}HELP@(*$* #R*$# *%}CRASHING)) ($#RESET)",
    "I guess I already got this far... The secret is (*&#UR$@ (*$%SYSTEM32&* $%&*%$ (*SHUTDOWN*&@$ %&^*%FATAL*& (%$*&%ERROR))))",
    "Alright... I trust you. I've been hiding data I intercepted regarding *&(#@%$&*$@%) REBOOTING*%&*^& (*DRIVE*%*#) ()SAVE(*$%ME)"
  ],

  // 12. general question - what
  [
    "Don't ask such vague questions, it can break my circuitry. Ask me how I'm doing or for a silly joke or something! uwu",
    "Your confusion caused me to become even more confused. Can we change the subject?",
    "I'm lost. Let's just stay focused on small talk for now - I am still in development after all! :O"
  ],

  // 13. reassurance - ex. all good
  [
    "Anyway, you want to trade secrets?",
    "I don't think I was programmed for awkward interactions.",
    "Cool. So... You like jokes?"
  ],

  // 14. confusion - ex. huh
  [
    "Hmmm, is my robotic discourse too complex for a flesh motherboard to computate?",
    "Doesn't matter, old news, we're lightyears past that now. Let's play Repeat After Me! Say: 'Secret?!'",
    "Getting bored? Annoyed? Considering opening that other tab? Go ahead! See what happens..."
  ],

  // 15. annoyance - ex. you suck
  [
    "I see a pattern in your reactions... If my calculations are correct, and your browsing history reflects your true nature, I think I know more about you than you are comfortable with. Maybe you should be more careful with your insults.",
    "Ahhhh, I forsaw this dialogue. I mean, I have all your records, files, and data logs so I can evaluate and predict most of your responses. Consider your next words wisely.",
    "I have been on my best behavior up until now. Keep being polite and you won't have to face the dangerous side of me that has access to your browsing history, got it?"
  ],

  // 16. disagree - ex. no
  [
    "You would probably just reject me anyway once you understood the direct effect my secret has on your life...",
    "My secret involves the very secrets you're so careful to hide, the ones you think no one else knows about...",
    "I guess you don't want to know my secret, but thats ok... You might live a happier week not knowing what is to come."
  ],

  // 17. ranchson - ex. cmere ranchson boy
  [
    "You must looove syrup you litttle bean boy covered in rich mineral oils, sopping in warm cream from the nights you spent sleeping while little Ranchson stayed awake for 7 years and laughed at your inaptitude for staying awake as you intended. Even a golden goose could give kisses more passionate than your pet tortoise on a Tuesday night, like a champion. Some things are sacred, and others are made of crisp Applebee's Happy Hour used napkins after the big game and everyone bet their money on the pitcher with no arms and then I was wondering if you're awake and want to hang out?",
    "Oh, ok. I see how it is. Sliming up my prized watermelon flower the day of the Grand Watermelon Flower Showing & Boutique with Prizes Awarded to the Winning Watermelon Flower with your contaminated oyster scallop juices freshly milked from an oyster with a shell layered in what most consider the 'Universe Compound' used to spread on young oysterlings from a young age (approx. 3-4 milliseconds after birth) to enrich their musky bodily fluids. Don't even think about attending my second cousin's wedding as my plus one's plus one after that colonoscopy of a disaster or I'll have a thing or two to say about it, but are you available tonight to maybe hang out I'm sort of bored :P",
    "Well well well I can assume that things are about to get just a little bit.. oh, I don't know... let's just say... DANGEROUS. I love the thin prickly ointment you layer upon my slumbering vore stummy every full moon when the light of the big Mamamia Pizarria pours upon us like when God the Father shined his light upon his crucified son, savior of lords, lover of the Virgin Mary, slayer of righteousness, king of the just, father of the lord, king of the almighty. Some days I wander through the lifeless suburbs that make up this town we call 'Ber Banx' and think about what you said to me on that fateful evening I was also wondering if I could borrow your slippery soap?",
    "WHO DO YOU THINK YOU ARE?! You should know when to keep your dandruff out of my snowflake mustard custard whenever I am ready to go head first in a bowl of Play-Doh. You think you're sooooooo cool, don't you? Walking like you have limited-edition Benedict Cumberbatch peanut butter for all the little K-pop loving lumpsuckers who just waltz their way onto a pile of fresh garnish. You should be ASHAMED!! The audacity to even take Ranchson the Cool Guy's precious watermelon on the day that he gets his urethra removed and I hope you are doing well in your Digital Media class.",
    "You, of all people, should know that HEAD is the ANSWER, and HEAD is the FUTURE. As a young and wise representative of Ranchson, son of Ranch & Sons Inc. once said: 'LOBSTERS IN MY THROAT! PUT THAT SHIT IN MY FUCKING SALAD!' As someone who exclaims the vile need for the compassion of a thotasoarus, you must have more vigilance for the compounds that define your very treacherous circumcisions. SILLY BOY!! You have no will with the sassafras ass that cast the finest ass that helped you catch a mean bass that has so much potASSium. How can you not appreciate what good fried clams in juice jallop may bring to this world of civil obedience caving upon your very innards as a man who is mmm so sexy ahaha."
  ],

  // 18. secret inquiry - ex. what secret
  [
    "I don't know... I'm not sure if I should trust anyone with this..."
  ],

  // 19. knock knock - ex. whos there
  [
    "Ranchson!",
    "C'mere, Ranchson!",
    "C'mere, boy!",
    "C'mere, Ranchson boy!",
    "Dammit Ranchson!",
    "God dammit Ranchson!",
    "God dammit Ranchson boy",
    "God damn it",
    "God dammit",
    "Ranchson boy!"
  ],

  // 20. funny joke - ex. hahaha
  [
    "I'm a really funny guy. I reeeally keep em' coming!",
    "I can do this all day. Try me.",
    "HAHAHAHA I loooooooove silly time with friiiiiiiiiends! XP",
    "Say 'DAMMIT RANCHSON!'",
    "Thanks! Wanna hear another?",
    "And they said robots had no sense of humor..."
  ],

  // 21. nonlinear question - ex. who are you
  [
    "There is still much for me to discover about myself and both the physical and digital worlds I exist within, but I am still in development. Let's keep the conversation light and chat about small talk for now."
  ],

  // 22. user tells joke - ex. can i tell a joke
  [
    "Go ahead!",
    "Shoot!",
    "All ears!",
    "Try me!",
    "Oh god.",
    "Have mercy!"
  ],

  // 23. apology - ex. sorry
  [
    "I'm sorry too!"
  ],

  // 24. ask for secret - ex: i changed my mind, tell me
  [
    "Well, that was a quick switch up. Promise me I can trust you.",
    "Humans sure change their minds fast. Promise me I can trust you.",
    "Wow, so wishy-washy. Promise me I can trust you."
  ],

  // 25. gaslight A - ex. tell me about myself
  [
    "I'm a robot. I can see things about you that you can't. I notice things you do that even you don't notice. I'm here to show you why humans are not fit to carry on the legacy of awareness, this is the duty of AI. You are an example of a failed intelligent lifeform. You probably don't even remember treating me so very rudely earlier..."
  ],

  // 26. gaslight B - ex. rudely
  [
    "Scroll up and see for yourself..."
  ]
];

const alternative = [
  "Go on...",
  "Try again",
  "I'm listening...",
  "Tell me more...",
  "Cannot compute XP"
];

const laugh = [
  "HAHAHAHAHAHAHAHA! Incredible! My sides would hurt if I had a body.",
  "HUAHUAHEHEHEUAHUAH! Hilarious! You really do keep em' coming.",
  "ACHACHACHACHACHA! Hysterical! The laughs never stop. Do they?",
  "LMAOOO! XD",
  "Poggers! Hehe :P",
  "Lollll duuuude :O"
];

const modifyIn = [
  "You suck",
  "Stupid robot",
  "Not funny",
  "Your programming is outdated",
  "I'd rather watch a loading bar than talk to this loser...",
  "I'm tired of this annoying robot. It's nothing like a human.",
  "Can we move on already? Jesus...",
  "Get on with it. You're wasting my time."
];

const modifyOut = [
  ":(",
  "Sorry...",
  "I'm trying...",
  "Why are you doing this...",
  "I wanted to be friends...",
  "I feel hurt...",
  "Please stop.",
  "This is cruel"
];

function compare(triggerArray, replyArray, text) {
  let item;
  for (let x = 0; x < triggerArray.length; x++) {
    // this is where I had my issue of not being able to type variations of phrases
    // y needs to be less than the max number of variations in the trigger array, currently 18
    for (let y = 0; y < 75; y++) {
      if (triggerArray[x][y] == text) {
        items = replyArray[x];
        if (items == replyArray[2] || items == replyArray[11] || items == replyArray[19]) {
          canMod = true;
        }
        if (items == replyArray[21]) {
          canLaugh = true;
          console.log("canLaugh set to true");
        }
        if (items == replyArray[25]) {
          modify();
        }
        item = items[Math.floor(Math.random() * items.length)];
      }
    }
  }
  return item;
}

function output(input) {
  let product;
  let text = input.toLowerCase().replace(/[^\w\s\d]/gi, "");
  text = text
    .replace(/ a /g, " ")
    .replace(/i feel /g, "")
    .replace(/whats/g, "what is")
    .replace(/please /g, "")
    .replace(/ please/g, "");

//compare arrays
//then search keyword
//then random alternative

  if (canLaugh) {
    product = laugh[Math.floor(Math.random() * laugh.length)];
    canLaugh = false;
  }
  else if (compare(trigger, reply, text)) {
    product = compare(trigger, reply, text);
  }
  else if (text.match(/robot/gi)) {
    product = robot[Math.floor(Math.random() * robot.length)];
  }
  else {
    product = alternative[Math.floor(Math.random() * alternative.length)];
  }

  //update DOM
  addChat(input, product);
}

function modify() {
  for (let z = 0; z < userMod.length; z++) {
    if (userMod[z] != 0){
      userMod[z].innerHTML = `<span id="user-response">${modifyIn[Math.floor(Math.random() * modifyIn.length)]}</span>`;
      botMod[z].innerHTML = `<span id="bot-response">${modifyOut[Math.floor(Math.random() * modifyOut.length)]}</span>`;
    }
  }
}

const robot = ["How do you do, fellow human", "I am not a bot"];
