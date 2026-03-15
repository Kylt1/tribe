'use strict';
const SERVER_URL = 'ws://declan-acnodal-resplendently.ngrok-free.dev';

// ── Canvas ────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d', { alpha: false });
const mmC    = document.getElementById('minimap-canvas');
const mmX    = mmC.getContext('2d');
ctx.imageSmoothingEnabled = false;

let groundDirty=true, groundCanvas=null;

function resize(){ canvas.width=innerWidth; canvas.height=innerHeight; groundDirty=true; }
window.addEventListener('resize', resize); resize();

// ── State ─────────────────────────────────────────────────────────────────────
let ws, myId, mapSize=4000;
let gameState  = {pl:[],re:[],st:[],pr:[],lb:[]};
let inv = {wo:0,fo:0,st:0,xp:0,xn:100,lv:1,sp:0,ss:{},wp:'axe',hp:100,mh:100,ki:0,sc:0};
let camX=0,camY=0,targetCamX=0,targetCamY=0;
let mouseWX=0,mouseWY=0,mouseSX=0,mouseSY=0;
let selBuild=null,keys={},prevAlive=true,attackHeld=false;
let pingStart=0,WDEFS={};
let particles=[];

// ── Sprite cache ──────────────────────────────────────────────────────────────
const spriteCache={};
function getSprite(key, w, h, drawFn){
  if(spriteCache[key]) return spriteCache[key];
  const oc=document.createElement('canvas'); oc.width=w; oc.height=h;
  const ox=oc.getContext('2d'); drawFn(ox,w,h);
  spriteCache[key]=oc; return oc;
}

// Pre-render resource sprites
function makeTreeSprite(){
  return getSprite('tree',80,90,(c,w,h)=>{
    c.fillStyle='rgba(0,0,0,.18)'; c.beginPath(); c.ellipse(40,78,28,10,0,0,Math.PI*2); c.fill();
    c.fillStyle='#5a2e10'; c.fillRect(36,50,8,28);
    c.fillStyle='#1e5010'; c.beginPath(); c.arc(40,36,30,0,Math.PI*2); c.fill();
    c.fillStyle='#2d6e1e'; c.beginPath(); c.arc(38,26,24,0,Math.PI*2); c.fill();
    c.fillStyle='#3d8428'; c.beginPath(); c.arc(41,18,17,0,Math.PI*2); c.fill();
    c.fillStyle='rgba(255,255,200,.08)'; c.beginPath(); c.arc(33,14,8,0,Math.PI*2); c.fill();
  });
}
function makeBushSprite(){
  return getSprite('bush',60,50,(c,w,h)=>{
    c.fillStyle='rgba(0,0,0,.14)'; c.beginPath(); c.ellipse(30,44,22,7,0,0,Math.PI*2); c.fill();
    c.fillStyle='#1e5810'; c.beginPath(); c.arc(30,28,20,0,Math.PI*2); c.fill();
    c.fillStyle='#2e7018'; c.beginPath(); c.arc(18,24,14,0,Math.PI*2); c.fill();
    c.fillStyle='#3a8820'; c.beginPath(); c.arc(38,22,13,0,Math.PI*2); c.fill();
    [[20,30],[30,26],[40,30],[25,34],[35,33]].forEach(([x,y])=>{
      c.fillStyle='#b02828'; c.beginPath(); c.arc(x,y,2.5,0,Math.PI*2); c.fill();
      c.fillStyle='rgba(255,255,255,.32)'; c.beginPath(); c.arc(x-.7,y-.7,.9,0,Math.PI*2); c.fill();
    });
  });
}
function makeStoneSprite(){
  return getSprite('stone',70,65,(c,w,h)=>{
    c.fillStyle='rgba(0,0,0,.2)'; c.beginPath(); c.ellipse(36,58,26,8,0,0,Math.PI*2); c.fill();
    c.fillStyle='#5a5a68';
    c.beginPath(); c.moveTo(8,48); c.lineTo(16,12); c.lineTo(36,6); c.lineTo(58,16); c.lineTo(62,42); c.lineTo(44,54); c.closePath(); c.fill();
    c.fillStyle='#8888a0';
    c.beginPath(); c.moveTo(20,16); c.lineTo(40,10); c.lineTo(56,22); c.lineTo(40,28); c.closePath(); c.fill();
    c.fillStyle='rgba(255,255,255,.22)'; c.beginPath(); c.arc(26,18,3,0,Math.PI*2); c.fill();
  });
}
function makeCactusSprite(){
  return getSprite('cactus',56,72,(c,w,h)=>{
    c.fillStyle='rgba(0,0,0,.14)'; c.beginPath(); c.ellipse(28,66,16,6,0,0,Math.PI*2); c.fill();
    c.fillStyle='#306620'; c.strokeStyle='#1e4414'; c.lineWidth=1.5;
    c.beginPath(); c.roundRect(22,10,12,58,4); c.fill(); c.stroke();
    c.beginPath(); c.roundRect(8,30,16,8,3); c.fill(); c.stroke();
    c.beginPath(); c.roundRect(30,22,16,8,3); c.fill(); c.stroke();
    c.strokeStyle='rgba(255,255,200,.55)'; c.lineWidth=1;
    [[24,22],[24,36],[30,28],[30,42],[24,50]].forEach(([x,y])=>{
      c.beginPath(); c.moveTo(x,y); c.lineTo(x<28?x-5:x+5,y); c.stroke();
    });
  });
}

// ── Ground tile ───────────────────────────────────────────────────────────────
function buildGround(){
  const tile=document.createElement('canvas'); tile.width=tile.height=200;
  const tc=tile.getContext('2d');
  tc.fillStyle='#3e7a22'; tc.fillRect(0,0,200,200);
  for(let i=0;i<12;i++){
    tc.fillStyle=`rgba(0,0,0,${.02+Math.random()*.04})`;
    tc.beginPath(); tc.arc(Math.random()*200,Math.random()*200,2+Math.random()*6,0,Math.PI*2); tc.fill();
  }
  for(let i=0;i<8;i++){
    tc.strokeStyle=`rgba(0,80,0,${.06+Math.random()*.06})`; tc.lineWidth=1.5;
    const gx=Math.random()*200,gy=Math.random()*200;
    tc.beginPath(); tc.moveTo(gx,gy+6); tc.lineTo(gx-2,gy-5); tc.stroke();
    tc.beginPath(); tc.moveTo(gx,gy+6); tc.lineTo(gx+2,gy-4); tc.stroke();
  }
  const pat=ctx.createPattern(tile,'repeat');
  groundCanvas=document.createElement('canvas');
  groundCanvas.width=canvas.width; groundCanvas.height=canvas.height;
  const gc=groundCanvas.getContext('2d');
  gc.fillStyle=pat; gc.fillRect(0,0,groundCanvas.width,groundCanvas.height);
  groundDirty=false;
}

function drawGround(){
  if(groundDirty||!groundCanvas) buildGround();
  // fill screen with grass via pattern shifted by camera
  ctx.save();
  const tile=200;
  const ox=((-camX+canvas.width/2)%tile+tile)%tile;
  const oy=((-camY+canvas.height/2)%tile+tile)%tile;
  ctx.drawImage(groundCanvas, ox-tile, oy-tile, groundCanvas.width+tile, groundCanvas.height+tile,
                0, 0, canvas.width, canvas.height);
  // water border
  const bx=wx(0),by=wy(0),bw=wx(mapSize)-bx,bh=wy(mapSize)-by;
  ctx.fillStyle='#1e5070';
  ctx.fillRect(0,0,canvas.width,Math.max(0,by));
  ctx.fillRect(0,Math.min(canvas.height,by+bh),canvas.width,canvas.height);
  ctx.fillRect(0,0,Math.max(0,bx),canvas.height);
  ctx.fillRect(Math.min(canvas.width,bx+bw),0,canvas.width,canvas.height);
  ctx.restore();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function wx(x){ return x-camX+canvas.width*.5; }
function wy(y){ return y-camY+canvas.height*.5; }
function onScreen(x,y,r){ const sx=wx(x),sy=wy(y); return sx>-r&&sy>-r&&sx<canvas.width+r&&sy<canvas.height+r; }
function lerp(a,b,t){ return a+(b-a)*t; }

// ── Draw Resource ─────────────────────────────────────────────────────────────
function drawResource(r){
  if(!onScreen(r.x,r.y,r.r+10)) return;
  const sx=wx(r.x)|0, sy=wy(r.y)|0;
  let spr;
  if(r.t==='tree')   spr=makeTreeSprite();
  else if(r.t==='bush')  spr=makeBushSprite();
  else if(r.t==='stone') spr=makeStoneSprite();
  else spr=makeCactusSprite();
  ctx.drawImage(spr, sx-(spr.width>>1), sy-(spr.height>>1));
  if(r.h<r.m){
    const bw=r.r*2.4|0, bh=6, bx=sx-(bw>>1), by=sy+r.r+4;
    ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillRect(bx,by,bw,bh);
    ctx.fillStyle=r.h/r.m>.5?'#30c050':'#e05050';
    ctx.fillRect(bx,by,(bw*r.h/r.m)|0,bh);
  }
}

// ── Draw Structure ────────────────────────────────────────────────────────────
const STRUCT_SPRITES={};
function getStructSprite(type){
  if(STRUCT_SPRITES[type]) return STRUCT_SPRITES[type];
  const sz=80;
  const oc=document.createElement('canvas'); oc.width=oc.height=sz;
  const c=oc.getContext('2d');
  const cx=sz>>1, cy=sz>>1;
  if(type==='wall'){
    c.fillStyle='#c09850'; c.strokeStyle='#7a5820'; c.lineWidth=3;
    c.beginPath(); c.roundRect(cx-24,cy-24,48,48,4); c.fill(); c.stroke();
    c.strokeStyle='rgba(0,0,0,.22)'; c.lineWidth=1.5;
    [0,-12,12].forEach(dy=>{ c.beginPath(); c.moveTo(cx-24,cy+dy); c.lineTo(cx+24,cy+dy); c.stroke(); });
    [0,-12].forEach(dx=>{ c.beginPath(); c.moveTo(cx+dx,cy-24); c.lineTo(cx+dx,cy+24); c.stroke(); });
  }else if(type==='spike'){
    c.fillStyle='#7a5828'; c.beginPath(); c.arc(cx,cy,18,0,Math.PI*2); c.fill();
    c.fillStyle='#e0e0e8'; c.strokeStyle='#888'; c.lineWidth=1;
    for(let i=0;i<8;i++){
      c.save(); c.translate(cx,cy); c.rotate(i*Math.PI/4);
      c.beginPath(); c.moveTo(-3.5,0); c.lineTo(0,-30); c.lineTo(3.5,0); c.closePath(); c.fill(); c.stroke();
      c.restore();
    }
  }else if(type==='windmill'){
    c.fillStyle='#9a7828'; c.beginPath(); c.arc(cx,cy,26,0,Math.PI*2); c.fill();
    // static blades for sprite
    c.strokeStyle='#e0b030'; c.lineWidth=7; c.lineCap='round';
    for(let i=0;i<4;i++){
      c.save(); c.translate(cx,cy); c.rotate(i*Math.PI/2+0.4);
      c.beginPath(); c.moveTo(0,7); c.lineTo(0,-24); c.stroke(); c.restore();
    }
    c.fillStyle='#3a2808'; c.beginPath(); c.arc(cx,cy,6,0,Math.PI*2); c.fill();
  }else if(type==='totem'){
    c.fillStyle='#7a4a20'; c.strokeStyle='#3a2008'; c.lineWidth=2;
    c.beginPath(); c.roundRect(cx-10,cy-28,20,56,3); c.fill(); c.stroke();
    c.fillStyle='#1a0808';
    c.beginPath(); c.arc(cx-5,cy-14,4,0,Math.PI*2); c.fill();
    c.beginPath(); c.arc(cx+5,cy-14,4,0,Math.PI*2); c.fill();
    c.fillStyle='#ff3010';
    c.beginPath(); c.arc(cx-5,cy-14,2,0,Math.PI*2); c.fill();
    c.beginPath(); c.arc(cx+5,cy-14,2,0,Math.PI*2); c.fill();
    c.fillStyle='#e04020'; c.beginPath(); c.ellipse(cx-16,cy-14,3,10,.5,0,Math.PI*2); c.fill();
    c.fillStyle='#1a9030'; c.beginPath(); c.ellipse(cx+16,cy-14,3,10,-.5,0,Math.PI*2); c.fill();
  }
  STRUCT_SPRITES[type]=oc; return oc;
}

function drawStructure(s){
  if(!onScreen(s.x,s.y,s.r+10)) return;
  const sx=wx(s.x)|0, sy=wy(s.y)|0;
  // Windmill needs rotation — draw directly
  if(s.t==='windmill'){
    ctx.save(); ctx.translate(sx,sy);
    ctx.fillStyle='rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(2,s.r*.5+4,s.r*.85,s.r*.3,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#9a7828'; ctx.beginPath(); ctx.arc(0,0,s.r,0,Math.PI*2); ctx.fill();
    const t=Date.now()/700;
    ctx.strokeStyle='#e0b030'; ctx.lineWidth=6; ctx.lineCap='round';
    for(let i=0;i<4;i++){
      ctx.save(); ctx.rotate(t+i*Math.PI/2);
      ctx.beginPath(); ctx.moveTo(0,7); ctx.lineTo(0,-s.r*.88); ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle='#2a1808'; ctx.beginPath(); ctx.arc(0,0,6,0,Math.PI*2); ctx.fill();
    ctx.restore();
  } else {
    const spr=getStructSprite(s.t);
    ctx.drawImage(spr, sx-(spr.width>>1), sy-(spr.height>>1));
  }
  // HP bar
  const bw=s.r*2.4|0, bh=5, bx=sx-(bw>>1), by=sy+s.r+4;
  ctx.fillStyle='rgba(0,0,0,.5)'; ctx.fillRect(bx,by,bw,bh);
  ctx.fillStyle=s.h/s.m>.5?'#30c050':'#e05050';
  ctx.fillRect(bx,by,(bw*s.h/s.m)|0,bh);
}

// ── Draw Player ───────────────────────────────────────────────────────────────
const P_COLS=['#4488ff','#ff5533','#33cc66','#ffaa00','#cc44ff','#00c8c8','#ff44aa','#88cc00'];
function drawPlayer(p){
  if(!p.alive) return;
  if(!onScreen(p.x,p.y,64)) return;
  const sx=wx(p.x)|0, sy=wy(p.y)|0;
  const isMe=p.i===myId, R=22;
  const col=isMe?'#4488ff':P_COLS[p.i%P_COLS.length];

  ctx.save(); ctx.translate(sx,sy);

  // shadow
  ctx.fillStyle='rgba(0,0,0,.2)';
  ctx.beginPath(); ctx.ellipse(2,R+2,R*.82,R*.3,0,0,Math.PI*2); ctx.fill();

  // glow for me
  if(isMe){ ctx.shadowColor=col; ctx.shadowBlur=14; }

  // body
  ctx.fillStyle=col; ctx.strokeStyle='rgba(0,0,0,.5)'; ctx.lineWidth=2.5;
  ctx.beginPath(); ctx.arc(0,0,R,0,Math.PI*2); ctx.fill(); ctx.stroke();
  // shine
  ctx.fillStyle='rgba(255,255,255,.18)';
  ctx.beginPath(); ctx.arc(-5,-7,8,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;

  // weapon + face (rotated to angle)
  ctx.save(); ctx.rotate(p.a);
  const swing=p.at?Math.sin(Date.now()/50)*.4:0;
  ctx.rotate(swing);
  drawWeaponArm(ctx,R,p.w);
  // eyes
  ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(12,-5,4,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(12,5,4,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#111'; ctx.beginPath(); ctx.arc(14,-5,2,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(14,5,2,0,Math.PI*2); ctx.fill();
  ctx.restore();

  // hat
  const hcol=isMe?'#1a3a80':col+'bb';
  ctx.fillStyle=hcol; ctx.strokeStyle='rgba(0,0,0,.4)'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.arc(0,0,R,Math.PI,Math.PI*2); ctx.fill(); ctx.stroke();
  // level circle
  ctx.fillStyle='rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(0,-R*.45,7,0,Math.PI*2); ctx.fill();
  ctx.fillStyle=isMe?'#50d0ff':'#ffd040';
  ctx.font='bold 8px Nunito'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(p.l||1,0,-R*.45);

  // HP bar
  const hpPct=Math.max(0,p.h/p.m);
  const bw=R*2.8|0;
  ctx.fillStyle='rgba(0,0,0,.45)'; ctx.beginPath(); ctx.roundRect(-bw>>1,-R-13,bw,7,3); ctx.fill();
  ctx.fillStyle=hpPct>.5?'#30c050':hpPct>.25?'#e0a020':'#e03020';
  ctx.beginPath(); ctx.roundRect(-bw>>1,-R-13,(bw*hpPct)|0,7,3); ctx.fill();

  // name
  ctx.fillStyle=isMe?'#99ccff':'#ffeedd';
  ctx.font='bold 11px Nunito'; ctx.textAlign='center'; ctx.textBaseline='bottom';
  ctx.fillText(p.n,0,-R-15);

  ctx.restore();
}

function drawWeaponArm(c,R,wname){
  const w=wname||'axe';
  c.save();
  if(w==='spear'){
    c.fillStyle='#a0a0b4'; c.fillRect(R-4,-2.5,82,5);
    c.fillStyle='#d0d8e8'; c.beginPath(); c.moveTo(R+76,-8); c.lineTo(R+94,0); c.lineTo(R+76,8); c.closePath(); c.fill();
    c.fillStyle='#8a6030'; c.fillRect(R-4,-3,14,6);
  }else if(w==='sword'){
    c.fillStyle='#b0b8c8'; c.fillRect(R-2,-3.5,62,7);
    c.fillStyle='#a06020'; c.fillRect(R-2,-5,13,10);
    c.fillStyle='#d8e0e8'; c.beginPath(); c.moveTo(R+60,-4.5); c.lineTo(R+78,0); c.lineTo(R+60,4.5); c.closePath(); c.fill();
  }else if(w==='club'){
    c.fillStyle='#8a5828'; c.strokeStyle='#502808'; c.lineWidth=1.2;
    c.fillRect(R-3,-4,44,8); c.strokeRect(R-3,-4,44,8);
    c.fillStyle='#5a3010'; c.beginPath(); c.arc(R+44,0,13,0,Math.PI*2); c.fill();
    c.fillStyle='#9a7040'; c.beginPath(); c.arc(R+44,-5,4,0,Math.PI*2); c.fill();
  }else if(w==='bow'){
    c.strokeStyle='#b07020'; c.lineWidth=3.5;
    c.beginPath(); c.arc(R+10,0,14,Math.PI*.38,Math.PI*1.62); c.stroke();
    c.strokeStyle='rgba(255,255,200,.55)'; c.lineWidth=1;
    c.beginPath(); c.moveTo(R+10+Math.cos(Math.PI*.38)*14,Math.sin(Math.PI*.38)*14);
    c.lineTo(R+10+Math.cos(Math.PI*1.62)*14,Math.sin(Math.PI*1.62)*14); c.stroke();
  }else{ // axe
    c.fillStyle='#b07018'; c.strokeStyle='#704808'; c.lineWidth=1.2;
    c.fillRect(R-3,-3,46,6); c.strokeRect(R-3,-3,46,6);
    c.fillStyle='#a8b0b8'; c.strokeStyle='#606870'; c.lineWidth=1.2;
    c.beginPath(); c.moveTo(R+40,-13); c.lineTo(R+58,-5); c.lineTo(R+58,7); c.lineTo(R+40,7); c.closePath(); c.fill(); c.stroke();
    c.fillStyle='rgba(255,255,255,.28)';
    c.beginPath(); c.moveTo(R+42,-9); c.lineTo(R+54,-3); c.lineTo(R+50,4); c.closePath(); c.fill();
  }
  c.restore();
}

// ── Draw Arrow ────────────────────────────────────────────────────────────────
const projAngles={};
let prevProj=[];
function drawProjectiles(prs){
  for(const pr of prs){
    const prev=prevProj.find(p=>p.i===pr.i);
    if(prev) projAngles[pr.i]=Math.atan2(pr.y-prev.y,pr.x-prev.x);
    else if(projAngles[pr.i]===undefined) projAngles[pr.i]=0;
    if(!onScreen(pr.x,pr.y,20)) continue;
    ctx.save(); ctx.translate(wx(pr.x)|0,wy(pr.y)|0); ctx.rotate(projAngles[pr.i]||0);
    ctx.fillStyle='#b87020'; ctx.fillRect(-14,-1.5,28,3);
    ctx.fillStyle='#b8c0c8'; ctx.beginPath(); ctx.moveTo(14,-4); ctx.lineTo(22,0); ctx.lineTo(14,4); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#c04020'; ctx.beginPath(); ctx.moveTo(-12,-2); ctx.lineTo(-19,-7); ctx.lineTo(-14,0); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-12,2); ctx.lineTo(-19,7); ctx.lineTo(-14,0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  prevProj=prs.map(p=>({...p}));
}

// ── Build preview ─────────────────────────────────────────────────────────────
function drawBuildPreview(){
  if(!selBuild) return;
  const r={wall:26,spike:20,windmill:32,totem:28}[selBuild]||24;
  ctx.save(); ctx.globalAlpha=.4; ctx.strokeStyle='#40d060'; ctx.lineWidth=2; ctx.setLineDash([5,4]);
  ctx.beginPath(); ctx.arc(mouseSX,mouseSY,r,0,Math.PI*2); ctx.stroke();
  ctx.globalAlpha=.15; ctx.fillStyle='#40d060';
  ctx.beginPath(); ctx.arc(mouseSX,mouseSY,r,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

// ── Particles ─────────────────────────────────────────────────────────────────
function spawnLevelUpFX(){
  const me=gameState.pl.find(p=>p.i===myId); if(!me) return;
  const sx=wx(me.x),sy=wy(me.y);
  for(let i=0;i<30;i++){
    const a=Math.random()*Math.PI*2,sp=3+Math.random()*6;
    particles.push({x:sx,y:sy,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-2,
      life:1.2,ml:1.2,c:`hsl(${38+Math.random()*20},100%,62%)`,s:2+Math.random()*4});
  }
}
function tickParticles(dt){
  for(let i=particles.length-1;i>=0;i--){
    const p=particles[i]; p.x+=p.vx; p.y+=p.vy; p.vy+=.1; p.life-=dt;
    if(p.life<=0){particles.splice(i,1);continue;}
    ctx.save(); ctx.globalAlpha=p.life/p.ml;
    ctx.fillStyle=p.c; ctx.beginPath(); ctx.arc(p.x,p.y,p.s,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }
}

// ── Minimap ───────────────────────────────────────────────────────────────────
let mmDirty=0;
function drawMinimap(){
  const now=Date.now(); if(now-mmDirty<100) return; mmDirty=now; // redraw 10fps
  const W=150,sc=W/mapSize;
  mmX.fillStyle='rgba(14,22,8,.92)'; mmX.fillRect(0,0,W,W);
  for(const r of gameState.re){
    mmX.fillStyle=r.t==='tree'?'#2d6010':r.t==='bush'?'#408018':r.t==='stone'?'#606070':'#306010';
    mmX.fillRect((r.x*sc)|0,(r.y*sc)|0,2,2);
  }
  for(const s of gameState.st){
    mmX.fillStyle='rgba(180,140,40,.7)'; mmX.fillRect((s.x*sc-2)|0,(s.y*sc-2)|0,4,4);
  }
  for(const p of gameState.pl){
    if(!p.alive) continue;
    mmX.fillStyle=p.i===myId?'#4499ff':'#ff5030';
    mmX.beginPath(); mmX.arc((p.x*sc)|0,(p.y*sc)|0,p.i===myId?3.5:2.5,0,Math.PI*2); mmX.fill();
  }
  const me=gameState.pl.find(p=>p.i===myId);
  if(me){
    mmX.strokeStyle='rgba(255,255,255,.45)'; mmX.lineWidth=1;
    mmX.strokeRect(((me.x-canvas.width/2)*sc)|0,((me.y-canvas.height/2)*sc)|0,(canvas.width*sc)|0,(canvas.height*sc)|0);
  }
}

// ── HUD DOM updates (throttled) ───────────────────────────────────────────────
let hudDirty=0,lastInvStr='';
function updateHUD(){
  const now=Date.now(); if(now-hudDirty<80) return; hudDirty=now;
  const str=JSON.stringify(inv); if(str===lastInvStr) return; lastInvStr=str;

  const hp=inv.hp,mh=inv.mh,hpPct=Math.max(0,Math.min(100,hp/mh*100));
  const hf=document.getElementById('hp-fill');
  hf.style.width=hpPct+'%'; hf.className='bar-fill'+(hpPct<35?' low':'');
  document.getElementById('hp-label').textContent=Math.ceil(hp)+'/'+mh;

  const xpPct=inv.xn>0?Math.min(100,inv.xp/inv.xn*100):100;
  document.getElementById('xp-fill').style.width=xpPct+'%';
  document.getElementById('xp-label').textContent=Math.floor(inv.xp)+'/'+inv.xn;
  document.getElementById('level-badge').textContent='LEVEL '+inv.lv+(inv.lv>=20?' ★':'');

  document.getElementById('inv-wood').textContent=inv.wo;
  document.getElementById('inv-food').textContent=inv.fo;
  document.getElementById('inv-stone').textContent=inv.st;
  document.getElementById('inv-kills').textContent=inv.ki;
  document.getElementById('inv-score').textContent=inv.sc;

  const sp=inv.sp||0;
  const spb=document.getElementById('sp-badge');
  spb.textContent=sp+' pts'; spb.className=sp>0?'show':'';

  const MAX_S=20;
  for(const s of ['axePower','spearPower','bowPower','speed','defense']){
    const v=(inv.ss&&inv.ss[s])||0;
    document.getElementById('sv-'+s).textContent=v;
    document.getElementById('sb-'+s).style.width=(v/MAX_S*100)+'%';
    const btn=document.querySelector('.btn-stat[data-stat="'+s+'"]');
    if(btn) btn.disabled=sp<=0||v>=MAX_S;
  }

  document.querySelectorAll('.wpn-btn').forEach(btn=>{
    const wn=btn.dataset.weapon;
    const wd=WDEFS[wn]; const locked=wd&&inv.lv<wd.unlockLvl;
    btn.classList.toggle('locked',!!locked);
    btn.classList.toggle('active',wn===inv.wp);
    const tag=btn.querySelector('.unlock-tag');
    if(tag) tag.style.display=locked?'':'none';
  });
}

function updateLeaderboard(lb){
  const el=document.getElementById('lb-list');
  const medals=['🥇','🥈','🥉'];
  let html='';
  (lb||[]).forEach((r,i)=>{
    html+=`<div class="lb-row"><span class="lb-rank">${medals[i]||i+1}</span><span class="lb-name">${esc(r.n)}</span><span class="lb-lvl">Lv${r.l}</span><span class="lb-sc">${r.s}</span></div>`;
  });
  el.innerHTML=html;
}

function showLevelUp(lvl,sp){
  document.getElementById('lu-msg').textContent='Level '+lvl+' — '+sp+' stat points!';
  const b=document.getElementById('levelup-banner'); b.classList.add('show');
  spawnLevelUpFX();
  setTimeout(()=>b.classList.remove('show'),2700);
}
function showToast(msg){
  const wrap=document.getElementById('toast'); wrap.innerHTML='';
  const el=document.createElement('div'); el.className='toast-msg'; el.textContent=msg;
  wrap.appendChild(el); setTimeout(()=>el.remove(),2500);
}
function addKillFeed(killer,victim){
  const feed=document.getElementById('killfeed');
  const el=document.createElement('div'); el.className='kf-entry';
  el.innerHTML=`⚔ <b>${esc(killer)}</b> slew <b>${esc(victim)}</b>`;
  feed.prepend(el); setTimeout(()=>el.remove(),4000);
  while(feed.children.length>5) feed.removeChild(feed.lastChild);
}
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Connect ───────────────────────────────────────────────────────────────────
document.getElementById('btn-play').addEventListener('click',()=>{
  const name=document.getElementById('name-input').value.trim()||'Tribesman';
  ws=new WebSocket(SERVER_URL);
  ws.addEventListener('open',()=>ws.send(JSON.stringify({type:'join',name})));
  ws.addEventListener('message',e=>onMsg(JSON.parse(e.data)));
  ws.addEventListener('close',()=>showToast('Disconnected'));
  ws.addEventListener('error',()=>showToast('Connection failed'));
});
document.getElementById('name-input').addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('btn-play').click(); });

function wsSend(obj){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(obj)); }

function onMsg(data){
  switch(data.type||data.t){
    case 'welcome':
      myId=data.id; mapSize=data.mapSize;
      if(data.weapons) WDEFS=data.weapons;
      document.getElementById('join-screen').style.display='none';
      document.getElementById('hud').classList.add('active');
      break;
    case 's':{
      // detect deaths for killfeed
      const prevMap={}; for(const p of gameState.pl) prevMap[p.i]=p;
      gameState={pl:data.pl||[],re:data.re||[],st:data.st||[],pr:data.pr||[],lb:data.lb||[]};
      // add dead players back for rendering dead state
      for(const d of data.dead||[]){
        if(!gameState.pl.find(p=>p.i===d.i)) gameState.pl.push({...prevMap[d.i],alive:false});
      }
      const me=gameState.pl.find(p=>p.i===myId);
      if(me){
        targetCamX=me.x; targetCamY=me.y;
        const alive=me.alive!==false;
        if(!alive&&prevAlive) document.getElementById('respawn-overlay').classList.add('show');
        if(alive&&!prevAlive) document.getElementById('respawn-overlay').classList.remove('show');
        prevAlive=alive;
      }
      updateLeaderboard(data.lb);
      break;
    }
    case 'inv': inv=data; break;
    case 'levelUp': showLevelUp(data.level,data.statPoints); break;
    case 'toast': showToast(data.msg); break;
    case 'kill': addKillFeed(data.killer,data.victim);
      if(data.victim===document.getElementById('name-input').value.trim()) showToast('You were slain by '+data.killer);
      break;
    case 'pong': document.getElementById('ping').textContent=(Date.now()-pingStart)+'ms'; break;
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────
window.addEventListener('keydown',e=>{
  const k=e.key.toLowerCase(); keys[k]=true;
  if(k==='1') wsSend({type:'weapon',weapon:'axe'});
  if(k==='2') wsSend({type:'weapon',weapon:'spear'});
  if(k==='3') wsSend({type:'weapon',weapon:'club'});
  if(k==='4') wsSend({type:'weapon',weapon:'bow'});
  if(k==='5') wsSend({type:'weapon',weapon:'sword'});
  if(k==='e') wsSend({type:'input',eat:true,attack:false,up:false,down:false,left:false,right:false,angle:0});
  if(k==='q') setSel(selBuild==='wall'?null:'wall');
  if(k==='f') setSel(selBuild==='spike'?null:'spike');
  if(k==='g') setSel(selBuild==='windmill'?null:'windmill');
  if(k==='h') setSel(selBuild==='totem'?null:'totem');
  if(k==='escape') setSel(null);
});
window.addEventListener('keyup',e=>{ keys[e.key.toLowerCase()]=false; });

canvas.addEventListener('mousemove',e=>{
  mouseSX=e.clientX; mouseSY=e.clientY;
  mouseWX=e.clientX-canvas.width*.5+camX;
  mouseWY=e.clientY-canvas.height*.5+camY;
});
canvas.addEventListener('mousedown',e=>{
  if(e.button!==0) return;
  if(selBuild){ wsSend({type:'build',stype:selBuild,x:mouseWX|0,y:mouseWY|0}); }
  else attackHeld=true;
});
canvas.addEventListener('mouseup',e=>{ if(e.button===0) attackHeld=false; });
canvas.addEventListener('contextmenu',e=>e.preventDefault());

document.querySelectorAll('.wpn-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{ if(!btn.classList.contains('locked')) wsSend({type:'weapon',weapon:btn.dataset.weapon}); });
});
document.querySelectorAll('.build-btn').forEach(btn=>{
  btn.addEventListener('click',()=>setSel(selBuild===btn.dataset.stype?null:btn.dataset.stype));
});
document.querySelectorAll('.btn-stat').forEach(btn=>{
  btn.addEventListener('click',()=>wsSend({type:'allocateStat',stat:btn.dataset.stat}));
});

function setSel(s){
  selBuild=s;
  document.querySelectorAll('.build-btn').forEach(b=>b.classList.toggle('sel',b.dataset.stype===s));
}

// Input send loop — 20hz
setInterval(()=>{
  const me=gameState.pl.find(p=>p.i===myId);
  const angle=me?Math.atan2(mouseWY-me.y,mouseWX-me.x):0;
  wsSend({type:'input',
    up:!!(keys['w']||keys['arrowup']),down:!!(keys['s']||keys['arrowdown']),
    left:!!(keys['a']||keys['arrowleft']),right:!!(keys['d']||keys['arrowright']),
    angle, attack:attackHeld, eat:false});
},50);

// Ping
setInterval(()=>{ pingStart=Date.now(); wsSend({type:'pong'}); },3000);

// ── Main render loop ──────────────────────────────────────────────────────────
let lastFrame=performance.now();
function gameLoop(){
  requestAnimationFrame(gameLoop);
  const now=performance.now(), dt=Math.min((now-lastFrame)/1000,.05);
  lastFrame=now;

  // Smooth camera
  camX=lerp(camX,targetCamX,.12);
  camY=lerp(camY,targetCamY,.12);

  // Draw
  drawGround();

  // Structures
  for(const s of gameState.st) drawStructure(s);
  // Resources
  for(const r of gameState.re) drawResource(r);
  // Projectiles
  drawProjectiles(gameState.pr||[]);
  // Players (me last = on top)
  const pl=[...gameState.pl].sort((a,b)=>(a.i===myId?1:0)-(b.i===myId?1:0));
  for(const p of pl) drawPlayer(p);

  tickParticles(dt);
  drawBuildPreview();
  drawMinimap();
  updateHUD();
}
gameLoop();
