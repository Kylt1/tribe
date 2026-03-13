// ─── Tribe.io Server ─────────────────────────────────────────────────────────
// Run: node server.js   |   Tunnel: ngrok http 3000
// ─────────────────────────────────────────────────────────────────────────────
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript' };
const server = http.createServer((req, res) => {
  const fp = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
});

// ── WebSocket helpers ─────────────────────────────────────────────────────────
const clients = new Map();
let nextId = 1;

function wsHandshake(socket, req) {
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\nAccess-Control-Allow-Origin: *\r\n\r\n`
  );
}

function wsDecode(buf) {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  const total = offset + (masked ? 4 : 0) + len;
  if (buf.length < total) return null;
  const mask = masked ? buf.slice(offset, offset + 4) : null;
  offset += masked ? 4 : 0;
  const data = Buffer.from(buf.slice(offset, offset + len));
  if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return { text: data.toString('utf8'), consumed: total };
}

function wsEncode(msg) {
  const data = Buffer.from(msg, 'utf8');
  const len = data.length;
  let hdr;
  if (len < 126) { hdr = Buffer.alloc(2); hdr[0] = 0x81; hdr[1] = len; }
  else           { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 126; hdr.writeUInt16BE(len, 2); }
  return Buffer.concat([hdr, data]);
}

function send(socket, obj)     { try { socket.write(wsEncode(JSON.stringify(obj))); } catch(e){} }
function broadcast(obj, excId) {
  const f = wsEncode(JSON.stringify(obj));
  for (const [id,c] of clients) if (id !== excId) try { c.socket.write(f); } catch(e){}
}

// ── Game Constants ────────────────────────────────────────────────────────────
const MAP        = 4000;
const TICK_MS    = 1000 / 60;
const P_RADIUS   = 22;
const BASE_SPEED = 3.8;
const REGEN_WAIT = 6000;
const REGEN_RATE = 3;
const MAX_LEVEL  = 20;
const SP_PER_LVL = 3;

const XP_TABLE = [0,100,250,450,700,1000,1400,1900,2500,3200,
                  4000,5000,6200,7600,9200,11000,13000,15500,18500,22000];

const WEAPONS = {
  axe:   { damage:30, range:68,  cooldown:480, unlockLvl:1,  stat:'axePower'   },
  spear: { damage:20, range:125, cooldown:440, unlockLvl:1,  stat:'spearPower' },
  club:  { damage:48, range:58,  cooldown:720, unlockLvl:5,  stat:'axePower'   },
  bow:   { damage:28, range:999, cooldown:780, unlockLvl:8,  stat:'bowPower', proj:true },
  sword: { damage:38, range:72,  cooldown:540, unlockLvl:12, stat:'axePower'   },
};

const STRUCTS = {
  wall:     { cost:{wood:10},          hp:500, radius:26 },
  spike:    { cost:{wood:15,stone:5},  hp:250, radius:20, damage:20 },
  windmill: { cost:{wood:50,stone:20}, hp:400, radius:32, xpPerSec:0.6 },
  totem:    { cost:{wood:30,stone:10}, hp:350, radius:28 },
};

// ── World Generation ──────────────────────────────────────────────────────────
const resources = [];
let resId = 1;
(function spawnRes() {
  const defs = [
    { type:'tree',  count:130, radius:30, hp:280, xp:8,  dropWood:12 },
    { type:'bush',  count:90,  radius:22, hp:110, xp:4,  dropFood:10 },
    { type:'stone', count:80,  radius:28, hp:380, xp:7,  dropStone:10},
    { type:'cactus',count:50,  radius:20, hp:160, xp:5,  dropWood:6  },
  ];
  for (const d of defs)
    for (let i = 0; i < d.count; i++)
      resources.push({ id:resId++, ...d, maxHp:d.hp,
        x:80+Math.random()*(MAP-160), y:80+Math.random()*(MAP-160) });
})();

const structures = [];
let strId = 1;
const projectiles = [];
let projId = 1;

// ── Player Factory ────────────────────────────────────────────────────────────
function makePlayer(id, name) {
  return {
    id, name: name || `Tribesman${id}`,
    x: 400+Math.random()*(MAP-800), y:400+Math.random()*(MAP-800),
    angle:0, hp:100, maxHp:100,
    wood:0, food:0, stone:0,
    xp:0, level:1, statPoints:0,
    stats: { axePower:0, spearPower:0, bowPower:0, speed:0, defense:0 },
    weapon:'axe', attacking:false, attackTimer:0,
    lastDmgTime:0, alive:true, respawnTimer:0,
    kills:0, score:0,
  };
}

function xpNeeded(lvl) { return XP_TABLE[Math.min(lvl-1, XP_TABLE.length-1)] || 99999; }

function addXp(p, amt) {
  if (p.level >= MAX_LEVEL) { p.score += amt; return; }
  p.xp += amt; p.score += amt;
  while (p.level < MAX_LEVEL && p.xp >= xpNeeded(p.level)) {
    p.xp -= xpNeeded(p.level);
    p.level++;
    p.statPoints += SP_PER_LVL;
    p.maxHp = 100 + (p.level-1)*10;
    p.hp = Math.min(p.hp+40, p.maxHp);
    const c = clients.get(p.id);
    if (c) send(c.socket, { type:'levelUp', level:p.level, statPoints:p.statPoints, maxHp:p.maxHp });
  }
}

function wDamage(p, wname) {
  const w = WEAPONS[wname]; if (!w) return 0;
  return Math.round(w.damage * (1 + (p.stats[w.stat]||0) * 0.12));
}
function pSpeed(p)   { return BASE_SPEED + (p.stats.speed||0)*0.32; }
function pDefense(p) { return (p.stats.defense||0)*0.06; }
function dist(a,b)   { return Math.hypot(a.x-b.x, a.y-b.y); }
function clamp(v,lo,hi) { return Math.max(lo,Math.min(hi,v)); }
function pushApart(a,b,min) {
  const d=dist(a,b); if(d<min&&d>0.01){
    const nx=(a.x-b.x)/d, ny=(a.y-b.y)/d, push=(min-d)/2;
    a.x+=nx*push; a.y+=ny*push; b.x-=nx*push; b.y-=ny*push;
  }
}

function killPlayer(killer, victim) {
  victim.alive=false; victim.respawnTimer=6;
  killer.kills++;
  addXp(killer, 150+victim.level*25);
  killer.wood  += Math.floor(victim.wood  *0.4);
  killer.food  += Math.floor(victim.food  *0.4);
  killer.stone += Math.floor(victim.stone *0.4);
  victim.wood=victim.food=victim.stone=0;
  broadcast({ type:'kill', killer:killer.name, victim:victim.name });
}

// ── Game Loop ─────────────────────────────────────────────────────────────────
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;

  const alive = [...clients.values()].map(c=>c.player).filter(p=>p&&p.alive);

  for (const c of clients.values()) {
    const p = c.player; if (!p) continue;

    // Respawn
    if (!p.alive) {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) {
        p.alive=true; p.hp=p.maxHp;
        p.x=400+Math.random()*(MAP-800); p.y=400+Math.random()*(MAP-800);
      }
      continue;
    }

    const inp = c.input || {};
    // Move
    let mx=0, my=0;
    if (inp.up)    my-=1; if (inp.down)  my+=1;
    if (inp.left)  mx-=1; if (inp.right) mx+=1;
    const mag=Math.hypot(mx,my); if(mag>0){mx/=mag;my/=mag;}
    p.x=clamp(p.x+mx*pSpeed(p), P_RADIUS, MAP-P_RADIUS);
    p.y=clamp(p.y+my*pSpeed(p), P_RADIUS, MAP-P_RADIUS);
    if (inp.angle!==undefined) p.angle=inp.angle;

    // Eat
    if (inp.eat && p.food>0) { p.food--; p.hp=Math.min(p.maxHp,p.hp+25); }

    // Regen
    if (now-p.lastDmgTime>REGEN_WAIT) p.hp=Math.min(p.maxHp,p.hp+REGEN_RATE*dt);

    // Attack cooldown
    if (p.attackTimer>0) p.attackTimer-=dt*1000;

    // Attack
    if (inp.attack && p.attackTimer<=0) {
      const wdef=WEAPONS[p.weapon]; if(!wdef){p.attacking=false;continue;}
      p.attackTimer=wdef.cooldown; p.attacking=true;

      if (wdef.proj) {
        projectiles.push({
          id:projId++, ownerId:p.id,
          x:p.x, y:p.y,
          vx:Math.cos(p.angle)*16, vy:Math.sin(p.angle)*16,
          damage:wDamage(p,p.weapon), life:2.2,
        });
      } else {
        const dmg=wDamage(p,p.weapon);
        const ax=p.x+Math.cos(p.angle)*wdef.range;
        const ay=p.y+Math.sin(p.angle)*wdef.range;
        const hitR=p.weapon==='spear'?28:36;

        for (const o of alive) {
          if (o.id===p.id) continue;
          if (dist({x:ax,y:ay},o)<P_RADIUS+hitR) {
            const actual=Math.round(dmg*(1-pDefense(o)));
            o.hp-=actual; o.lastDmgTime=now;
            if (o.hp<=0) killPlayer(p,o);
          }
        }
        for (const r of resources) {
          if (r.hp<=0) continue;
          if (dist({x:ax,y:ay},r)<r.radius+28) {
            r.hp-=dmg*1.6;
            if(r.dropWood)  p.wood+=r.dropWood;
            if(r.dropFood)  p.food+=r.dropFood;
            if(r.dropStone) p.stone+=r.dropStone;
            addXp(p,r.xp);
            if(r.hp<=0) setTimeout(()=>{r.hp=r.maxHp;r.x=80+Math.random()*(MAP-160);r.y=80+Math.random()*(MAP-160);},20000);
          }
        }
        for (const s of structures) {
          if (!s.alive||s.ownerId===p.id) continue;
          if (dist({x:ax,y:ay},s)<s.radius+28) { s.hp-=dmg; if(s.hp<=0)s.alive=false; }
        }
      }
    } else if (!inp.attack) {
      p.attacking=false;
    }
  }

  // Projectiles
  for (let i=projectiles.length-1;i>=0;i--) {
    const pr=projectiles[i];
    pr.x+=pr.vx; pr.y+=pr.vy; pr.life-=dt;
    if (pr.life<=0||pr.x<0||pr.x>MAP||pr.y<0||pr.y>MAP) { projectiles.splice(i,1); continue; }
    let hit=false;
    for (const o of alive) {
      if (o.id===pr.ownerId) continue;
      if (dist(pr,o)<P_RADIUS+10) {
        const actual=Math.round(pr.damage*(1-pDefense(o)));
        o.hp-=actual; o.lastDmgTime=now;
        const owner=clients.get(pr.ownerId)?.player;
        if (o.hp<=0&&owner) killPlayer(owner,o);
        hit=true; break;
      }
    }
    if (hit) projectiles.splice(i,1);
  }

  // Structure passives + spikes
  for (const s of structures) {
    if (!s.alive) continue;
    const owner=clients.get(s.ownerId)?.player;
    const def=STRUCTS[s.type];
    if (def?.xpPerSec&&owner) addXp(owner, def.xpPerSec*dt);
    if (def?.damage) {
      for (const o of alive) {
        if (o.id===s.ownerId) continue;
        if (dist(o,s)<s.radius+P_RADIUS) {
          o.hp-=def.damage*dt; o.lastDmgTime=now;
          if(o.hp<=0&&owner) killPlayer(owner,o);
        }
      }
    }
  }

  // Collisions
  for (let i=0;i<alive.length;i++)
    for (let j=i+1;j<alive.length;j++)
      pushApart(alive[i],alive[j],P_RADIUS*2);

  // Build leaderboard
  const lb=[...clients.values()].filter(c=>c.player)
    .map(c=>({name:c.player.name,score:Math.floor(c.player.score),level:c.player.level,kills:c.player.kills}))
    .sort((a,b)=>b.score-a.score).slice(0,10);

  // State broadcast
  const state={
    type:'state',
    players:[...clients.values()].filter(c=>c.player).map(c=>{
      const p=c.player;
      return {id:p.id,name:p.name,x:Math.round(p.x),y:Math.round(p.y),
              angle:p.angle,hp:p.hp,maxHp:p.maxHp,alive:p.alive,
              weapon:p.weapon,attacking:p.attacking,level:p.level,kills:p.kills,score:Math.floor(p.score)};
    }),
    resources:resources.filter(r=>r.hp>0).map(r=>({
      id:r.id,type:r.type,x:Math.round(r.x),y:Math.round(r.y),radius:r.radius,hp:r.hp,maxHp:r.maxHp
    })),
    structures:structures.filter(s=>s.alive).map(s=>({
      id:s.id,type:s.type,x:s.x,y:s.y,radius:s.radius,hp:s.hp,maxHp:s.maxHp,ownerId:s.ownerId
    })),
    projectiles:projectiles.map(p=>({id:p.id,x:Math.round(p.x),y:Math.round(p.y)})),
    leaderboard:lb,
  };
  const frame=wsEncode(JSON.stringify(state));

  for (const c of clients.values()) {
    if (!c.player) continue;
    const p=c.player;
    send(c.socket,{
      type:'inventory',
      wood:Math.floor(p.wood),food:Math.floor(p.food),stone:Math.floor(p.stone),
      xp:Math.floor(p.xp),xpNext:xpNeeded(p.level),
      level:p.level,statPoints:p.statPoints,stats:p.stats,
      weapon:p.weapon,hp:p.hp,maxHp:p.maxHp,
      kills:p.kills,score:Math.floor(p.score),
    });
    try { c.socket.write(frame); } catch(e){}
  }
}, TICK_MS);

// ── Upgrade + message handling ────────────────────────────────────────────────
server.on('upgrade', (req,socket) => {
  if (req.headers['upgrade']!=='websocket'){socket.destroy();return;}
  wsHandshake(socket,req);
  const id=nextId++;
  const client={socket,id,player:null,input:{},buffer:Buffer.alloc(0)};
  clients.set(id,client);
  console.log(`[+] Client ${id}`);

  socket.on('data', chunk => {
    client.buffer=Buffer.concat([client.buffer,chunk]);
    while(client.buffer.length>=2){
      const op=client.buffer[0]&0x0f;
      if(op===8){socket.destroy();return;}
      const res=wsDecode(client.buffer);
      if(!res) break;
      client.buffer=client.buffer.slice(res.consumed);
      try{handleMsg(client,JSON.parse(res.text));}catch(e){}
    }
  });
  socket.on('close',()=>{clients.delete(id);broadcast({type:'playerLeft',id});});
  socket.on('error',()=>clients.delete(id));
});

function handleMsg(c,data){
  switch(data.type){
    case 'join':
      c.player=makePlayer(c.id,data.name);
      send(c.socket,{type:'welcome',id:c.id,mapSize:MAP,weapons:WEAPONS,xpTable:XP_TABLE,maxLevel:MAX_LEVEL});
      break;
    case 'input': c.input=data; break;
    case 'weapon':
      if(c.player){
        const w=WEAPONS[data.weapon];
        if(w&&c.player.level>=w.unlockLvl) c.player.weapon=data.weapon;
        else send(c.socket,{type:'toast',msg:`Reach level ${w?.unlockLvl||'?'} to unlock ${data.weapon}!`});
      }
      break;
    case 'allocateStat':
      if(c.player&&c.player.statPoints>0){
        const ok=['axePower','spearPower','bowPower','speed','defense'];
        if(ok.includes(data.stat)&&c.player.stats[data.stat]<20){
          c.player.stats[data.stat]++;
          c.player.statPoints--;
        }
      }
      break;
    case 'build':{
      if(!c.player||!c.player.alive) break;
      const def=STRUCTS[data.stype]; if(!def) break;
      const p=c.player;
      for(const[r,amt]of Object.entries(def.cost)){
        if(p[r]<amt){send(c.socket,{type:'toast',msg:`Need ${amt} ${r}`});return;}
      }
      for(const[r,amt]of Object.entries(def.cost)) p[r]-=amt;
      structures.push({id:strId++,type:data.stype,x:data.x,y:data.y,
        radius:def.radius,hp:def.hp,maxHp:def.hp,ownerId:c.id,alive:true});
      addXp(p,15);
      break;
    }
  }
}

server.listen(3000,()=>console.log('Tribe.io running on http://localhost:3000'));
