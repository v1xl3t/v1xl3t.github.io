
window.SC=(function(){
var K='sc_cart2';
function q(s,r){return (r||document).querySelector(s)}
function cart(){try{return JSON.parse(localStorage.getItem(K))||[]}catch(e){return[]}}
function save(c){localStorage.setItem(K,JSON.stringify(c));render();}
function money(n){return '$'+n.toFixed(2)}
function init(){if(q('#sc-drawer'))return;
 var d=document.createElement('div');
 d.innerHTML='<div id="sc-back"></div><aside id="sc-drawer" aria-label="Cart"><div class="hd"><b>CART</b><button aria-label="Close">&times;</button></div><div class="rows"></div><div class="ft"><div class="sub"><span>Subtotal</span><b class="tot">$0.00</b></div><button class="co">CHECKOUT</button></div></aside><div id="sc-toast">SWEET CREAM archive &mdash; the store is no longer active</div>';
 while(d.firstChild)document.body.appendChild(d.firstChild);
 q('#sc-back').onclick=close; q('#sc-drawer .hd button').onclick=close;
 q('#sc-drawer .co').onclick=toast;
 document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
 render();}
function render(){init();var c=cart(),r=q('#sc-drawer .rows'),tot=0;r.innerHTML='';
 if(!c.length)r.innerHTML='<div class="empty">Your cart is empty.</div>';
 c.forEach(function(it,i){tot+=it.p;
  var row=document.createElement('div');row.className='row';
  row.innerHTML='<img src="'+(it.img||'')+'" alt=""><span class="inf"><b>'+it.n+'</b><small>'+(it.o||'')+'</small></span><span class="pr">'+money(it.p)+'</span>';
  var x=document.createElement('button');x.className='rm';x.innerHTML='&times;';x.title='Remove';
  x.onclick=function(){var cc=cart();cc.splice(i,1);save(cc);};
  row.appendChild(x);r.appendChild(row);});
 q('#sc-drawer .tot').textContent=money(tot);}
function open(){init();render();document.body.classList.add('sc-cart-open')}
function close(){document.body.classList.remove('sc-cart-open')}
function toast(){init();var t=q('#sc-toast');t.classList.add('on');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('on')},2600)}
function add(it){init();var c=cart();c.push(it);save(c);open()}
function bindGeneric(){init();
 document.querySelectorAll('button,a,[role=button]').forEach(function(el){
  if(el.dataset.scb)return;el.dataset.scb=1;
  var tx=(el.textContent||'').trim();
  if(tx==='Log In'){el.style.display='none';return;}
  if(/^(add to cart|buy now)/i.test(tx)){if(el.classList.contains('atc'))return;
   el.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();
   if(window._scT&&Date.now()-window._scT<500)return;window._scT=Date.now();
   var n=((q('h1')||{}).textContent||document.title.split('|')[0]).trim();
   var pm=(document.body.textContent.match(/\$([0-9]+(?:\.[0-9]{2})?)/)||[]);
   add({n:n,p:pm[1]?parseFloat(pm[1]):0,o:'',img:''});},true);return;}
  if(/^cart\b/i.test(tx)){el.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();open();},true);return;}
  var al=(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('data-hook')||'');
  if(/cart|bag/i.test(al)){el.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();open();},true);}
 });}
addEventListener('load',function(){init();bindGeneric();});
return {add:add,open:open,close:close,toast:toast};
})();
