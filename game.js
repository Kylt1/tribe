'use strict';
// ── SERVER ────────────────────────────────────────────────────────────────────
const SERVER_URL = 'wss://declan-acnodal-resplendently.ngrok-free.dev';

// ── Canvas setup ──────────────────────────────────────────────────────────────
const canvas  = document.getElementById('game-canvas');
const ctx     = canvas.getContext('2d');
const mmCanvas= document.getElementById('minimap-canvas');
const mmCtx   = mmCanvas.getContext('2d');

function resize() { canvas.width=innerWidth; canvas.height=innerHeight; }
window.addEventListener('resize', resize);
resize();

// ── State ─────────────────────────────────────────────────────────────────────
let ws, myId, mapSize=4000;
let state   = { players:[], resources:[], structures:[], projectiles:[], leaderboard:[] };
let inv     = { wood:0, food:0, stone:0, xp:0, xpNext:100, level:1, statPoints:0, stats:{}, weapon:'axe', hp:100, maxHp:100, kills:0, score:0 };
let camX=0, camY=0;
let mouseWorldX=0, mouseWorldY=0, mouseScreenX=0, mouseScreenY=0;
let selectedBuild=null;
let keys={};
let prevAlive=true;
let pingStart=0, ping=0;
let WEAPONS_DEF={};
let particles=[];
let dmgNumbers=[];

// ── Connect ───────────────────────────────────────────────────────────────────
document.getElementById('btn-play').addEventListener('click', ()=>{
  const name=document.getElementById('name-input').value.trim()||'Tribesman';
  const url = SERVER_URL || (location.protocol==='https:'?'wss':'ws')+'://'+(location.hostname||'127.0.0.1')+':'+(location.port||3000);
  ws=new WebSocket(url);
  ws.addEventListener('open', ()=>ws.send(JSON.stringify({type:'join',name})));
  ws.addEventListener('message', e=>onMsg(JSON.parse(e.data)));
  ws.addEventListener('close', ()=>showToast('Disconnected'));
  ws.addEventListener('error', ()=>showToast('Connection failed'));
});
document.getElementById('name-input').addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('btn-play').click(); });

function send(obj){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(obj)); }

function onMsg(data){
  switch(data.type){
    case 'welcome':
      myId=data.id; mapSize=data.mapSize;
      if(data.weapons) WEAPONS_DEF=data.weapons;
      document.getElementById('join-screen').style.display='none';
      document.getElementById('hud').classList.add('active');
      break;
    case 'state':
      detectKills(state.players, data.players);
      state=data;
      updateLeaderboard(data.leaderboard);
      const me=data.players.find(p=>p.id===myId);
      if(me){
        if(!me.alive&&prevAlive) document.getElementById('respawn-overlay').classList.add('show');
        if(me.alive&&!prevAlive)  document.getElementById('respawn-overlay').classList.remove('show');
        prevAlive=me.alive;
      }
      break;
    case 'inventory':
      inv=data;
      updateHUD();
      break;
    case 'levelUp':
      showLevelUp(data.level, data.statPoints);
      break;
    case 'toast': showToast(data.msg); break;
    case 'kill':
      addKillFeed(data.killer, data.victim);
      break;
    case 'pong': ping=Date.now()-pingStart; document.getElementById('ping').textContent=ping+'ms'; break;
  }
}

// ── HUD Updates ───────────────────────────────────────────────────────────────
function updateHUD(){
  // HP bar
  const hpPct=Math.max(0,Math.min(100,inv.hp/inv.maxHp*100));
  const hpFill=document.getElementById('hp-fill');
  hpFill.style.width=hpPct+'%';
  hpFill.className='bar-fill'+(hpPct>40?' hi':'');
  document.getElementById('hp-label').textContent=Math.ceil(inv.hp)+'/'+Math.ceil(inv.maxHp);

  // XP bar
  const xpPct=inv.xpNext>0?Math.min(100,inv.xp/inv.xpNext*100):100;
  document.getElementById('xp-fill').style.width=xpPct+'%';
  document.getElementById('xp-label').textContent=Math.floor(inv.xp)+'/'+inv.xpNext;
  document.getElementById('level-badge').textContent='LEVEL '+inv.level+(inv.level>=20?' (MAX)':'');

  // Inventory
  document.getElementById('inv-wood').textContent=inv.wood;
  document.getElementById('inv-food').textContent=inv.food;
  document.getElementById('inv-stone').textContent=inv.stone;
  document.getElementById('inv-kills').textContent=inv.kills;

  // Stat panel
  const sp=inv.statPoints||0;
  document.getElementById('sp-count').textContent=sp+' stat point'+(sp!==1?'s':'')+' available';
  const MAX_STAT=20;
  for(const stat of ['axePower','spearPower','bowPower','speed','defense']){
    const val=(inv.stats&&inv.stats[stat])||0;
    document.getElementById('sv-'+stat).textContent=val;
    document.getElementById('sb-'+stat).style.width=(val/MAX_STAT*100)+'%';
    const btn=document.querySelector('.btn-stat[data-stat="'+stat+'"]');
    if(btn) btn.disabled=(sp<=0||val>=MAX_STAT);
  }

  // Weapon bar unlock states
  document.querySelectorAll('.wpn-btn').forEach(btn=>{
    const wname=btn.dataset.weapon;
    const wdef=WEAPONS_DEF[wname];
    const locked=wdef&&inv.level<wdef.unlockLvl;
    btn.classList.toggle('locked', !!locked);
    btn.classList.toggle('active', wname===inv.weapon);
    // update unlock tag
    const tag=btn.querySelector('.unlock-tag');
    if(tag&&wdef) tag.style.display=locked?'block':'none';
  });
}

function showLevelUp(level, sp){
  document.getElementById('lu-msg').textContent=`You reached level ${level} — ${sp} stat points available!`;
  const banner=document.getElementById('levelup-banner');
  banner.classList.add('show');
  spawnLevelUpParticles();
  setTimeout(()=>banner.classList.remove('show'), 2600);
}

function showToast(msg){
  const wrap=document.getElementById('toast');
  wrap.innerHTML='';
  const el=document.createElement('div');
  el.className='toast-msg'; el.textContent=msg;
  wrap.appendChild(el);
  setTimeout(()=>el.remove(),2500);
}

function addKillFeed(killer,victim){
  const feed=document.getElementById('killfeed');
  const el=document.createElement('div');
  el.className='kf-entry';
  el.innerHTML=`⚔ <b>${esc(killer)}</b> slew <b>${esc(victim)}</b>`;
  feed.prepend(el);
  setTimeout(()=>el.remove(),4500);
  while(feed.children.length>5) feed.removeChild(feed.lastChild);
}

function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function detectKills(prev,next){
  if(!prev.length) return;
  for(const np of next){
    if(!np.alive){
      const pp=prev.find(p=>p.id===np.id);
      if(pp&&pp.alive){
        const killer=next.find(p=>{
          const op=prev.find(x=>x.id===p.id);
          return op&&p.kills>op.kills;
        });
        if(killer&&killer.id===myId) showToast(`💀 You killed ${np.name}!`);
      }
    }
  }
}

function updateLeaderboard(lb){
  const el=document.getElementById('lb-list');
  el.innerHTML='';
  const medals=['🥇','🥈','🥉'];
  (lb||[]).forEach((row,i)=>{
    const div=document.createElement('div');
    div.className='lb-row';
    div.innerHTML=`<span class="lb-rank">${medals[i]||i+1}</span><span class="lb-name">${esc(row.name)}</span><span class="lb-lvl">Lv${row.level}</span><span class="lb-score">${row.score}</span>`;
    el.appendChild(div);
  });
}

// ── Input ─────────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e=>{
  const k=e.key.toLowerCase(); keys[k]=true;
  if(k==='1') send({type:'weapon',weapon:'axe'});
  if(k==='2') send({type:'weapon',weapon:'spear'});
  if(k==='3') send({type:'weapon',weapon:'club'});
  if(k==='4') send({type:'weapon',weapon:'bow'});
  if(k==='5') send({type:'weapon',weapon:'sword'});
  if(k==='e') sendInput(true,false);
  if(k==='q') selectBuild(selectedBuild==='wall'?null:'wall');
  if(k==='f') selectBuild(selectedBuild==='spike'?null:'spike');
  if(k==='g') selectBuild(selectedBuild==='windmill'?null:'windmill');
  if(k==='h') selectBuild(selectedBuild==='totem'?null:'totem');
  if(k==='escape') selectBuild(null);
});
window.addEventListener('keyup',e=>{ keys[e.key.toLowerCase()]=false; });

canvas.addEventListener('mousemove',e=>{
  mouseScreenX=e.clientX; mouseScreenY=e.clientY;
  mouseWorldX=e.clientX-canvas.width/2+camX;
  mouseWorldY=e.clientY-canvas.height/2+camY;
});

canvas.addEventListener('mousedown',e=>{
  if(e.button===0){
    if(selectedBuild){ send({type:'build',stype:selectedBuild,x:Math.round(mouseWorldX),y:Math.round(mouseWorldY)}); }
    else sendInput(false,true);
  }
});
canvas.addEventListener('mouseup',e=>{ if(e.button===0) sendInput(false,false); });
canvas.addEventListener('contextmenu',e=>e.preventDefault());

document.querySelectorAll('.wpn-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{ if(!btn.classList.contains('locked')) send({type:'weapon',weapon:btn.dataset.weapon}); });
});
document.querySelectorAll('.build-btn').forEach(btn=>{
  btn.addEventListener('click',()=>selectBuild(selectedBuild===btn.dataset.stype?null:btn.dataset.stype));
});
document.querySelectorAll('.btn-stat').forEach(btn=>{
  btn.addEventListener('click',()=>send({type:'allocateStat',stat:btn.dataset.stat}));
});

function selectBuild(s){
  selectedBuild=s;
  document.querySelectorAll('.build-btn').forEach(b=>b.classList.toggle('sel',b.dataset.stype===s));
}

// ── Input loop ────────────────────────────────────────────────────────────────
let attackHeld=false;
canvas.addEventListener('mousedown',e=>{ if(e.button===0&&!selectedBuild) attackHeld=true; });
canvas.addEventListener('mouseup',  e=>{ if(e.button===0) attackHeld=false; });

setInterval(()=>{
  const me=state.players.find(p=>p.id===myId);
  const angle=me?Math.atan2(mouseWorldY-me.y,mouseWorldX-me.x):0;
  send({type:'input',
    up:    !!(keys['w']||keys['arrowup']),
    down:  !!(keys['s']||keys['arrowdown']),
    left:  !!(keys['a']||keys['arrowleft']),
    right: !!(keys['d']||keys['arrowright']),
    angle, attack:attackHeld, eat:false,
  });
},1000/30);

setInterval(()=>{ pingStart=Date.now(); send({type:'pong'}); },3000);

function sendInput(eat,attack){
  const me=state.players.find(p=>p.id===myId);
  const angle=me?Math.atan2(mouseWorldY-me.y,mouseWorldX-me.x):0;
  send({type:'input',
    up:!!(keys['w']||keys['arrowup']),down:!!(keys['s']||keys['arrowdown']),
    left:!!(keys['a']||keys['arrowleft']),right:!!(keys['d']||keys['arrowright']),
    angle,attack,eat,
  });
}

// ── Particles ─────────────────────────────────────────────────────────────────
function spawnParticles(x,y,color,count,speed){
  for(let i=0;i<count;i++){
    const a=Math.random()*Math.PI*2;
    const s=speed*(0.5+Math.random()*0.8);
    particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,
      life:1,maxLife:1,color,size:2+Math.random()*3});
  }
}
function spawnLevelUpParticles(){
  const me=state.players.find(p=>p.id===myId);
  if(!me) return;
  const sx=me.x-camX+canvas.width/2, sy=me.y-camY+canvas.height/2;
  for(let i=0;i<40;i++){
    const a=Math.random()*Math.PI*2;
    particles.push({x:sx,y:sy,vx:Math.cos(a)*(3+Math.random()*5),vy:Math.sin(a)*(3+Math.random()*5)-2,
      life:1.5,maxLife:1.5,color:`hsl(${40+Math.random()*20},100%,60%)`,size:3+Math.random()*5});
  }
}
function addDmgNumber(worldX,worldY,dmg){
  dmgNumbers.push({x:worldX,y:worldY,text:'-'+dmg,life:1.2,maxLife:1.2,vy:-1.5});
}

// ── Rendering helpers ─────────────────────────────────────────────────────────
function lerp(a,b,t){ return a+(b-a)*t; }
function wx(x){ return x-camX+canvas.width/2; }
function wy(y){ return y-camY+canvas.height/2; }
function onScreen(x,y,r){ return wx(x)>-r&&wy(y)>-r&&wx(x)<canvas.width+r&&wy(y)<canvas.height+r; }

// ── Ground ────────────────────────────────────────────────────────────────────
let groundPattern=null;
function buildGround(){
  const oc=document.createElement('canvas'); oc.width=oc.height=192;
  const oc2=oc.getContext('2d');
  // base gradient
  const g=oc2.createLinearGradient(0,0,192,192);
  g.addColorStop(0,'#4a9030'); g.addColorStop(0.5,'#3d7828'); g.addColorStop(1,'#4a9030');
  oc2.fillStyle=g; oc2.fillRect(0,0,192,192);
  // grass blades
  oc2.strokeStyle='rgba(0,0,0,0.07)'; oc2.lineWidth=1.5;
  for(let i=0;i<18;i++){
    const gx=Math.random()*192, gy=Math.random()*192;
    oc2.beginPath(); oc2.moveTo(gx,gy+5); oc2.lineTo(gx-2,gy-6); oc2.stroke();
    oc2.beginPath(); oc2.moveTo(gx,gy+5); oc2.lineTo(gx+2,gy-5); oc2.stroke();
  }
  // light dots
  for(let i=0;i<6;i++){
    oc2.fillStyle='rgba(255,255,255,0.04)';
    oc2.beginPath(); oc2.arc(Math.random()*192,Math.random()*192,3+Math.random()*5,0,Math.PI*2); oc2.fill();
  }
  return oc;
}

function drawGround(){
  if(!groundPattern) groundPattern=ctx.createPattern(buildGround(),'repeat');
  ctx.save();
  ctx.translate(-camX+canvas.width/2, -camY+canvas.height/2);
  ctx.fillStyle=groundPattern; ctx.fillRect(0,0,mapSize,mapSize);
  // Border water
  ctx.fillStyle='#2a6090';
  ctx.fillRect(-300,-300,mapSize+600,300);
  ctx.fillRect(-300,mapSize,mapSize+600,300);
  ctx.fillRect(-300,-300,300,mapSize+600);
  ctx.fillRect(mapSize,-300,300,mapSize+600);
  // Grid lines subtle
  ctx.strokeStyle='rgba(0,0,0,0.05)'; ctx.lineWidth=1;
  for(let gx=0;gx<=mapSize;gx+=200){
    ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,mapSize); ctx.stroke();
  }
  for(let gy=0;gy<=mapSize;gy+=200){
    ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(mapSize,gy); ctx.stroke();
  }
  ctx.restore();
}

// ── Resources ─────────────────────────────────────────────────────────────────
function drawResource(r){
  if(!onScreen(r.x,r.y,r.radius*2+10)) return;
  const sx=wx(r.x), sy=wy(r.y);
  ctx.save(); ctx.translate(sx,sy);

  if(r.type==='tree'){
    // shadow
    ctx.fillStyle='rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(3,r.radius*0.6+4,r.radius*0.9,r.radius*0.38,0,0,Math.PI*2); ctx.fill();
    // trunk
    ctx.fillStyle='#6b3d1e';
    ctx.fillRect(-5,2,10,r.radius*0.5+4);
    // canopy layers (3 circles for depth)
    ctx.fillStyle='#255c18'; ctx.beginPath(); ctx.arc(0,-r.radius*0.4,r.radius*1.1,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#347a22'; ctx.beginPath(); ctx.arc(-2,-r.radius*0.7,r.radius*0.88,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#4a9430'; ctx.beginPath(); ctx.arc(1,-r.radius*0.95,r.radius*0.65,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,200,0.08)'; ctx.beginPath(); ctx.arc(-4,-r.radius*1.0,r.radius*0.3,0,Math.PI*2); ctx.fill();
  } else if(r.type==='bush'){
    ctx.fillStyle='rgba(0,0,0,0.15)'; ctx.beginPath(); ctx.ellipse(2,5,r.radius*0.95,r.radius*0.42,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#2a6618'; ctx.beginPath(); ctx.arc(0,0,r.radius,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#3a8825'; ctx.beginPath(); ctx.arc(-5,-4,r.radius*0.68,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#4aa030'; ctx.beginPath(); ctx.arc(4,-5,r.radius*0.55,0,Math.PI*2); ctx.fill();
    // berries
    const berryPos=[[-8,2],[0,-2],[8,2],[-4,6],[4,5]];
    berryPos.forEach(([bx,by])=>{
      ctx.fillStyle='#c03030'; ctx.beginPath(); ctx.arc(bx,by,2.5,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.arc(bx-0.7,by-0.7,0.9,0,Math.PI*2); ctx.fill();
    });
  } else if(r.type==='stone'){
    ctx.fillStyle='rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.ellipse(3,r.radius*0.55+5,r.radius*0.88,r.radius*0.42,0,0,Math.PI*2); ctx.fill();
    // main rock
    ctx.fillStyle='#6a6a78';
    ctx.beginPath();
    ctx.moveTo(-r.radius,r.radius*0.4); ctx.lineTo(-r.radius*0.5,-r.radius*0.85);
    ctx.lineTo(r.radius*0.3,-r.radius); ctx.lineTo(r.radius,r.radius*0.0);
    ctx.lineTo(r.radius*0.75,r.radius*0.65); ctx.closePath(); ctx.fill();
    // highlight face
    ctx.fillStyle='#9090a0';
    ctx.beginPath();
    ctx.moveTo(-r.radius*0.4,-r.radius*0.7); ctx.lineTo(r.radius*0.15,-r.radius*0.88);
    ctx.lineTo(r.radius*0.5,-r.radius*0.15); ctx.lineTo(-r.radius*0.15,-r.radius*0.05);
    ctx.closePath(); ctx.fill();
    // sparkle
    ctx.fillStyle='rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.arc(-r.radius*0.25,-r.radius*0.55,2,0,Math.PI*2); ctx.fill();
  } else if(r.type==='cactus'){
    ctx.fillStyle='rgba(0,0,0,0.15)'; ctx.beginPath(); ctx.ellipse(2,5,r.radius*0.7,r.radius*0.3,0,0,Math.PI*2); ctx.fill();
    // body
    ctx.fillStyle='#3a7830'; ctx.strokeStyle='#2a5820'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.roundRect(-7,-r.radius,14,r.radius*1.8,4); ctx.fill(); ctx.stroke();
    // arms
    ctx.beginPath(); ctx.roundRect(-7-12,-r.radius*0.3,14,7,3); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(7,-r.radius*0.1,12,7,3); ctx.fill(); ctx.stroke();
    // spines
    ctx.strokeStyle='rgba(255,255,200,0.6)'; ctx.lineWidth=1;
    [[-4,-r.radius*0.6],[-4,-r.radius*0.2],[4,-r.radius*0.4],[4,0],[-4,r.radius*0.2]].forEach(([px,py])=>{
      ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(px<0?px-5:px+5,py); ctx.stroke();
    });
  }

  // HP bar if damaged
  if(r.hp<r.maxHp){
    const bw=r.radius*2.2, pct=r.hp/r.maxHp;
    ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.roundRect(-bw/2,r.radius+6,bw,6,3); ctx.fill();
    ctx.fillStyle=pct>0.5?'#40d060':'#e05050';
    ctx.beginPath(); ctx.roundRect(-bw/2,r.radius+6,bw*pct,6,3); ctx.fill();
  }
  ctx.restore();
}

// ── Structures ────────────────────────────────────────────────────────────────
function drawStructure(s){
  if(!onScreen(s.x,s.y,s.radius+10)) return;
  const sx=wx(s.x), sy=wy(s.y);
  ctx.save(); ctx.translate(sx,sy);

  ctx.fillStyle='rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(2,s.radius*0.5+5,s.radius*0.9,s.radius*0.36,0,0,Math.PI*2); ctx.fill();

  if(s.type==='wall'){
    ctx.fillStyle='#c8a060'; ctx.strokeStyle='#8a6028'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.roundRect(-s.radius,-s.radius,s.radius*2,s.radius*2,4); ctx.fill(); ctx.stroke();
    ctx.strokeStyle='rgba(0,0,0,0.2)'; ctx.lineWidth=1.5;
    const hw=s.radius;
    ctx.beginPath(); ctx.moveTo(-hw,0); ctx.lineTo(hw,0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hw,-hw/2); ctx.lineTo(hw,-hw/2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hw,hw/2); ctx.lineTo(hw,hw/2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,-hw); ctx.lineTo(0,0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hw/2,0); ctx.lineTo(-hw/2,hw); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hw/2,0); ctx.lineTo(hw/2,hw); ctx.stroke();
  } else if(s.type==='spike'){
    ctx.fillStyle='#7a5828'; ctx.beginPath(); ctx.arc(0,0,s.radius,0,Math.PI*2); ctx.fill();
    for(let i=0;i<8;i++){
      ctx.save(); ctx.rotate(i*Math.PI/4);
      ctx.fillStyle='#ddd'; ctx.strokeStyle='#888'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(-4,0); ctx.lineTo(0,-(s.radius+12)); ctx.lineTo(4,0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle='#5a3810'; ctx.beginPath(); ctx.arc(0,0,s.radius*0.5,0,Math.PI*2); ctx.fill();
  } else if(s.type==='windmill'){
    ctx.fillStyle='#a08030'; ctx.strokeStyle='#705010'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(0,0,s.radius,0,Math.PI*2); ctx.fill(); ctx.stroke();
    const t=Date.now()/700;
    for(let i=0;i<4;i++){
      ctx.save(); ctx.rotate(t+i*Math.PI/2);
      const gr=ctx.createLinearGradient(0,0,0,-s.radius*0.9);
      gr.addColorStop(0,'#c0902a'); gr.addColorStop(1,'#f0c840');
      ctx.fillStyle=gr;
      ctx.beginPath(); ctx.moveTo(-5,0); ctx.lineTo(-3,-s.radius*0.92); ctx.lineTo(3,-s.radius*0.92); ctx.lineTo(5,0);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle='#4a3010'; ctx.beginPath(); ctx.arc(0,0,7,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#f0c840'; ctx.beginPath(); ctx.arc(0,0,4,0,Math.PI*2); ctx.fill();
  } else if(s.type==='totem'){
    ctx.fillStyle='#7a4a20'; ctx.strokeStyle='#4a2a08'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.roundRect(-10,-s.radius,20,s.radius*2,4); ctx.fill(); ctx.stroke();
    // face carvings
    ctx.fillStyle='#2a1208';
    ctx.beginPath(); ctx.arc(-4,-s.radius*0.4,4,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(4,-s.radius*0.4,4,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#ff4020';
    ctx.beginPath(); ctx.arc(-4,-s.radius*0.4,2,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(4,-s.radius*0.4,2,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#2a1208'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(0,-s.radius*0.0,8,0.2,Math.PI-0.2); ctx.stroke();
    // feathers
    ctx.fillStyle='#e04020';
    ctx.beginPath(); ctx.ellipse(-14,-s.radius*0.6,4,10,0.5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#20a040';
    ctx.beginPath(); ctx.ellipse(14,-s.radius*0.6,4,10,-0.5,0,Math.PI*2); ctx.fill();
  }

  // HP bar
  const pct=s.hp/s.maxHp, bw=s.radius*2.2;
  ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.roundRect(-bw/2,s.radius+5,bw,6,3); ctx.fill();
  ctx.fillStyle=pct>0.5?'#40d060':'#e05050';
  ctx.beginPath(); ctx.roundRect(-bw/2,s.radius+5,bw*pct,6,3); ctx.fill();

  ctx.restore();
}

// ── Players ───────────────────────────────────────────────────────────────────
const WEAPON_ICONS={'axe':'🪓','spear':'🔱','club':'🏏','bow':'🏹','sword':'⚔'};
const PLAYER_COLORS=['#4488ff','#ff5533','#33cc66','#ffaa00','#cc44ff','#00cccc','#ff44aa'];

function drawPlayer(p){
  if(!p.alive) return;
  if(!onScreen(p.x,p.y,60)) return;
  const sx=wx(p.x), sy=wy(p.y);
  const isMe=p.id===myId;
  const R=22;
  const col=isMe?'#5599ff':PLAYER_COLORS[p.id%PLAYER_COLORS.length];
  const colDark=isMe?'#1a4aaa':col.replace(/ff/,'88');

  ctx.save(); ctx.translate(sx,sy);

  // shadow
  ctx.fillStyle='rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(2,R+3,R*0.88,R*0.34,0,0,Math.PI*2); ctx.fill();

  // ── body glow for me ──
  if(isMe){
    ctx.shadowColor=col; ctx.shadowBlur=18;
  }

  // body
  const bodyGrad=ctx.createRadialGradient(-4,-4,2,0,0,R);
  bodyGrad.addColorStop(0,'rgba(255,255,255,0.35)');
  bodyGrad.addColorStop(1,'rgba(0,0,0,0.2)');
  ctx.fillStyle=col; ctx.strokeStyle=colDark; ctx.lineWidth=3;
  ctx.beginPath(); ctx.arc(0,0,R,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.fillStyle=bodyGrad; ctx.beginPath(); ctx.arc(0,0,R,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;

  // hat / tribe marking
  ctx.save(); ctx.rotate(p.angle);
  // weapon arm
  ctx.save();
  const attackSwing = p.attacking ? Math.sin(Date.now()/55)*0.45 : 0;
  ctx.rotate(attackSwing);

  const wname=p.weapon||'axe';
  if(wname==='bow'){
    // Draw bow
    ctx.strokeStyle='#c07820'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.arc(R+8,0,12,Math.PI*0.4,Math.PI*1.6); ctx.stroke();
    ctx.strokeStyle='rgba(255,255,200,0.6)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(R+8-8,Math.sin(Math.PI*0.4)*12); ctx.lineTo(R+8-8,Math.sin(Math.PI*1.6)*12); ctx.stroke();
  } else if(wname==='spear'){
    ctx.fillStyle='#a0a0b0'; ctx.strokeStyle='#606070'; ctx.lineWidth=1;
    ctx.fillRect(R-4,-2.5,80,5);
    ctx.fillStyle='#e0e0f0';
    ctx.beginPath(); ctx.moveTo(R+74,-9); ctx.lineTo(R+92,0); ctx.lineTo(R+74,9); ctx.closePath(); ctx.fill();
  } else if(wname==='sword'){
    ctx.fillStyle='#c0c8d0'; ctx.strokeStyle='#606870'; ctx.lineWidth=1;
    ctx.fillRect(R-4,-4,62,8);
    ctx.fillStyle='#a06020';
    ctx.fillRect(R-4,-6,14,12);
    ctx.fillStyle='#e8e8f0'; ctx.beginPath();
    ctx.moveTo(R+58,-4); ctx.lineTo(R+76,0); ctx.lineTo(R+58,4); ctx.closePath(); ctx.fill();
  } else if(wname==='club'){
    ctx.fillStyle='#8a5a28'; ctx.strokeStyle='#5a3010'; ctx.lineWidth=1.5;
    ctx.fillRect(R-4,-5,45,10); ctx.strokeRect(R-4,-5,45,10);
    ctx.fillStyle='#6a3a18';
    ctx.beginPath(); ctx.arc(R+44,0,12,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#a07040'; ctx.beginPath(); ctx.arc(R+44,-4,4,0,Math.PI*2); ctx.fill();
  } else { // axe
    ctx.fillStyle='#c07820'; ctx.strokeStyle='#805010'; ctx.lineWidth=1.5;
    ctx.fillRect(R-4,-3,48,6); ctx.strokeRect(R-4,-3,48,6);
    // blade
    ctx.fillStyle='#b0b8c0'; ctx.strokeStyle='#707880'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(R+40,-14); ctx.lineTo(R+58,-6); ctx.lineTo(R+58,8); ctx.lineTo(R+40,8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.moveTo(R+42,-10); ctx.lineTo(R+54,-4); ctx.lineTo(R+50,4); ctx.closePath(); ctx.fill();
  }
  ctx.restore(); // weapon arm

  // face (eyes in direction of angle)
  ctx.fillStyle='#fff';
  ctx.beginPath(); ctx.arc(10,-6,4.5,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(10,6,4.5,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#111';
  ctx.beginPath(); ctx.arc(12,-6,2.2,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(12,6,2.2,0,Math.PI*2); ctx.fill();
  ctx.restore(); // angle rotate

  // helmet / hat
  const hCol=isMe?'#1a3a88':col;
  ctx.fillStyle=hCol;
  ctx.beginPath(); ctx.arc(0,0,R,Math.PI,Math.PI*2); ctx.fill();
  // level badge on hat
  ctx.fillStyle='rgba(0,0,0,0.5)';
  ctx.beginPath(); ctx.arc(0,-R*0.5,7,0,Math.PI*2); ctx.fill();
  ctx.fillStyle=isMe?'#60d8ff':'#ffe060';
  ctx.font='bold 8px Nunito,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(p.level||1, 0, -R*0.5);

  // HP bar
  const hpPct=Math.max(0,p.hp/p.maxHp);
  const bw=R*2.8;
  ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.roundRect(-bw/2,-R-13,bw,7,3); ctx.fill();
  ctx.fillStyle=hpPct>0.5?'#30c050':hpPct>0.25?'#e0a020':'#e03020';
  ctx.beginPath(); ctx.roundRect(-bw/2,-R-13,bw*hpPct,7,3); ctx.fill();

  // Name
  ctx.fillStyle=isMe?'#aaddff':'#ffeecc';
  ctx.font='bold 11px Nunito,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='bottom';
  ctx.fillText(p.name, 0, -R-15);

  ctx.restore();
}

// ── Arrows / Projectiles ──────────────────────────────────────────────────────
function drawProjectile(pr){
  if(!onScreen(pr.x,pr.y,20)) return;
  ctx.save();
  ctx.translate(wx(pr.x),wy(pr.y));
  // compute direction from velocity estimate (use stored angle if available)
  const angle=pr.angle||0;
  ctx.rotate(angle);
  // shaft
  ctx.fillStyle='#c07820'; ctx.fillRect(-14,-1.5,28,3);
  // arrowhead
  ctx.fillStyle='#c0c8d0';
  ctx.beginPath(); ctx.moveTo(14,-4); ctx.lineTo(22,0); ctx.lineTo(14,4); ctx.closePath(); ctx.fill();
  // feathers
  ctx.fillStyle='#e05030';
  ctx.beginPath(); ctx.moveTo(-12,-2); ctx.lineTo(-18,-7); ctx.lineTo(-14,0); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-12,2); ctx.lineTo(-18,7); ctx.lineTo(-14,0); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// track projectile angles
const projAngles={};
let lastProjState=[];
function updateProjAngles(prjs){
  for(const pr of prjs){
    const prev=lastProjState.find(p=>p.id===pr.id);
    if(prev) projAngles[pr.id]=Math.atan2(pr.y-prev.y,pr.x-prev.x);
    else if(!projAngles[pr.id]) projAngles[pr.id]=0;
    pr.angle=projAngles[pr.id];
  }
  lastProjState=prjs.map(p=>({...p}));
}

// ── Minimap ───────────────────────────────────────────────────────────────────
function drawMinimap(){
  const W=160, H=160, sc=W/mapSize;
  mmCtx.clearRect(0,0,W,H);
  mmCtx.fillStyle='rgba(20,30,10,0.92)'; mmCtx.fillRect(0,0,W,H);
  // resources
  for(const r of state.resources){
    mmCtx.fillStyle=r.type==='tree'?'#3a7020':r.type==='bush'?'#50a030':r.type==='stone'?'#7070880':r.type==='cactus'?'#408828':'#7070880';
    mmCtx.fillRect(r.x*sc-1,r.y*sc-1,2,2);
  }
  // structures
  for(const s of state.structures){
    mmCtx.fillStyle='rgba(200,160,60,0.6)';
    mmCtx.fillRect(s.x*sc-2,s.y*sc-2,4,4);
  }
  // players
  for(const p of state.players){
    if(!p.alive) continue;
    mmCtx.fillStyle=p.id===myId?'#60aaff':'#ff6040';
    mmCtx.beginPath(); mmCtx.arc(p.x*sc,p.y*sc,p.id===myId?3.5:2.5,0,Math.PI*2); mmCtx.fill();
  }
  // viewport
  const me=state.players.find(p=>p.id===myId);
  if(me){
    mmCtx.strokeStyle='rgba(255,255,255,0.5)'; mmCtx.lineWidth=1;
    const vw=canvas.width*sc, vh=canvas.height*sc;
    mmCtx.strokeRect((me.x-canvas.width/2)*sc,(me.y-canvas.height/2)*sc,vw,vh);
  }
}

// ── Build Preview ─────────────────────────────────────────────────────────────
function drawBuildPreview(){
  if(!selectedBuild) return;
  const r={wall:26,spike:20,windmill:32,totem:28}[selectedBuild]||24;
  ctx.save();
  ctx.globalAlpha=0.45;
  ctx.strokeStyle='#40d060'; ctx.lineWidth=2;
  ctx.setLineDash([6,4]);
  ctx.beginPath(); ctx.arc(mouseScreenX,mouseScreenY,r,0,Math.PI*2); ctx.stroke();
  ctx.globalAlpha=0.2; ctx.fillStyle='#40d060';
  ctx.beginPath(); ctx.arc(mouseScreenX,mouseScreenY,r,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

// ── Particles update/draw ─────────────────────────────────────────────────────
function updateParticles(dt){
  for(let i=particles.length-1;i>=0;i--){
    const p=particles[i];
    p.x+=p.vx; p.y+=p.vy; p.vy+=0.08;
    p.life-=dt;
    if(p.life<=0){particles.splice(i,1);continue;}
    const alpha=p.life/p.maxLife;
    ctx.save();
    ctx.globalAlpha=alpha;
    ctx.fillStyle=p.color;
    ctx.beginPath(); ctx.arc(p.x,p.y,p.size*(0.5+alpha*0.5),0,Math.PI*2); ctx.fill();
    ctx.restore();
  }
}

function updateDmgNumbers(dt){
  for(let i=dmgNumbers.length-1;i>=0;i--){
    const d=dmgNumbers[i];
    d.y+=d.vy; d.life-=dt;
    if(d.life<=0){dmgNumbers.splice(i,1);continue;}
    const sx=wx(d.x), sy=wy(d.y);
    const alpha=d.life/d.maxLife;
    ctx.save(); ctx.globalAlpha=alpha;
    ctx.font='bold 14px Nunito,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#ff4040'; ctx.strokeStyle='rgba(0,0,0,0.8)'; ctx.lineWidth=3;
    ctx.strokeText(d.text,sx,sy); ctx.fillText(d.text,sx,sy);
    ctx.restore();
  }
}

// ── Main render loop ──────────────────────────────────────────────────────────
let lastFrame=performance.now();
function gameLoop(){
  requestAnimationFrame(gameLoop);
  const now=performance.now();
  const dt=(now-lastFrame)/1000;
  lastFrame=now;

  // Camera
  const me=state.players.find(p=>p.id===myId);
  if(me&&me.alive){ camX=lerp(camX,me.x,0.1); camY=lerp(camY,me.y,0.1); }

  ctx.clearRect(0,0,canvas.width,canvas.height);

  drawGround();

  // Draw structures
  for(const s of state.structures) drawStructure(s);

  // Draw resources
  for(const r of state.resources) drawResource(r);

  // Update projectile angles then draw
  updateProjAngles(state.projectiles||[]);
  for(const pr of state.projectiles||[]) drawProjectile(pr);

  // Draw players (me on top)
  const sorted=[...state.players].sort((a,b)=>(a.id===myId?1:0)-(b.id===myId?1:0));
  for(const p of sorted) drawPlayer(p);

  updateParticles(dt);
  updateDmgNumbers(dt);
  drawBuildPreview();
  drawMinimap();
}
gameLoop();
