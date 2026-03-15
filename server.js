// Tribe.io Server — run: node server.js  |  tunnel: ngrok http 3000
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const MIME={'.html':'text/html','.css':'text/css','.js':'application/javascript'};
// Fetch our own public tunnel URL from cloudflared local API
let tunnelUrl='';
function fetchTunnelUrl(){
  http.get('http://127.0.0.1:20241/metrics',(r)=>{
    let d='';r.on('data',c=>d+=c);
    r.on('end',()=>{
      const m=d.match(/cloudflared_tunnel_user_hostnames_counts{hostname="([^"]+)"/);
      if(m){tunnelUrl='wss://'+m[1];console.log('Tunnel URL:',tunnelUrl);}
      else{
        // try parsing from metrics differently
        const m2=d.match(/hostname="(.*?\.trycloudflare\.com)"/);
        if(m2){tunnelUrl='wss://'+m2[1];console.log('Tunnel URL:',tunnelUrl);}
      }
    });
  }).on('error',()=>{});
}
setTimeout(fetchTunnelUrl,3000);
setInterval(fetchTunnelUrl,10000);

const server=http.createServer((req,res)=>{
  // Special endpoint so the game client can auto-discover the tunnel URL
  if(req.url==='/tunnel-url'){
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({url:tunnelUrl}));
    return;
  }
  const fp=path.join(__dirname,'public',req.url==='/'?'index.html':req.url);
  fs.readFile(fp,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'text/plain','ngrok-skip-browser-warning':'true','Access-Control-Allow-Origin':'*'});res.end(data);
  });
});

// WebSocket
const clients=new Map();let nextId=1;
function wsHandshake(sock,req){
  const acc=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAccess-Control-Allow-Origin: *\r\nngrok-skip-browser-warning: true\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
}
function wsDecode(buf){
  if(buf.length<2)return null;
  const masked=(buf[1]&0x80)!==0;let len=buf[1]&0x7f,off=2;
  if(len===126){if(buf.length<4)return null;len=buf.readUInt16BE(2);off=4;}
  const tot=off+(masked?4:0)+len;if(buf.length<tot)return null;
  const mask=masked?buf.slice(off,off+4):null;off+=masked?4:0;
  const d=Buffer.from(buf.slice(off,off+len));
  if(masked)for(let i=0;i<d.length;i++)d[i]^=mask[i%4];
  return{text:d.toString('utf8'),consumed:tot};
}
function wsEncode(msg){
  const d=Buffer.from(msg,'utf8'),len=d.length;
  let h;if(len<126){h=Buffer.alloc(2);h[0]=0x81;h[1]=len;}
  else{h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(len,2);}
  return Buffer.concat([h,d]);
}
function send(sock,obj){try{sock.write(wsEncode(JSON.stringify(obj)));}catch(e){}}
function broadcast(obj,excId){
  const f=wsEncode(JSON.stringify(obj));
  for(const[id,c]of clients)if(id!==excId)try{c.socket.write(f);}catch(e){}
}

// Constants
const MAP=4000,TICK_MS=50,P_R=22,BASE_SPD=3.8,REGEN_WAIT=6000,REGEN_RATE=3,MAX_LVL=20,SP_PER_LVL=3;
const XP_TABLE=[0,100,250,450,700,1000,1400,1900,2500,3200,4000,5000,6200,7600,9200,11000,13000,15500,18500,22000];
const WEAPONS={
  axe:  {damage:30,range:68, cooldown:480,unlockLvl:1, stat:'axePower'},
  spear:{damage:20,range:125,cooldown:440,unlockLvl:1, stat:'spearPower'},
  club: {damage:48,range:58, cooldown:720,unlockLvl:5, stat:'axePower'},
  bow:  {damage:28,range:999,cooldown:780,unlockLvl:8, stat:'bowPower',proj:true},
  sword:{damage:38,range:72, cooldown:540,unlockLvl:12,stat:'axePower'},
};
const STRUCTS={
  wall:    {cost:{wood:10},         hp:500,radius:26,solid:true},
  spike:   {cost:{wood:15,stone:5}, hp:250,radius:20,solid:true,damage:20},
  windmill:{cost:{wood:50,stone:20},hp:400,radius:32,solid:true,xpPerSec:0.6},
  totem:   {cost:{wood:30,stone:10},hp:350,radius:28,solid:true},
};

// World
const resources=[];let resId=1;
(()=>{
  const defs=[
    {type:'tree', count:130,radius:30,hp:280,xp:8, dropWood:12},
    {type:'bush', count:90, radius:22,hp:110,xp:4, dropFood:10},
    {type:'stone',count:80, radius:28,hp:380,xp:7, dropStone:10},
    {type:'cactus',count:50,radius:20,hp:160,xp:5, dropWood:6},
  ];
  for(const d of defs)
    for(let i=0;i<d.count;i++)
      resources.push({id:resId++,...d,maxHp:d.hp,x:80+Math.random()*(MAP-160),y:80+Math.random()*(MAP-160)});
})();
const structures=[];let strId=1;
const projectiles=[];let projId=1;

function makePlayer(id,name){
  return{id,name:name||'Tribesman'+id,
    x:400+Math.random()*(MAP-800),y:400+Math.random()*(MAP-800),
    angle:0,hp:100,maxHp:100,wood:0,food:0,stone:0,
    xp:0,level:1,statPoints:0,
    stats:{axePower:0,spearPower:0,bowPower:0,speed:0,defense:0},
    weapon:'axe',attacking:false,attackTimer:0,
    lastDmgTime:0,alive:true,respawnTimer:0,kills:0,score:0};
}
function xpNeeded(lvl){return XP_TABLE[Math.min(lvl,XP_TABLE.length-1)]||99999;}
function addXp(p,amt){
  if(p.level>=MAX_LVL){p.score+=amt;return;}
  p.xp+=amt;p.score+=amt;
  while(p.level<MAX_LVL&&p.xp>=xpNeeded(p.level)){
    p.xp-=xpNeeded(p.level);p.level++;p.statPoints+=SP_PER_LVL;
    p.maxHp=100+(p.level-1)*10;p.hp=Math.min(p.hp+40,p.maxHp);
    const c=clients.get(p.id);
    if(c)send(c.socket,{type:'levelUp',level:p.level,statPoints:p.statPoints,maxHp:p.maxHp});
  }
}
function wDmg(p,wn){const w=WEAPONS[wn];if(!w)return 0;return Math.round(w.damage*(1+(p.stats[w.stat]||0)*0.12));}
function pSpd(p){return BASE_SPD+(p.stats.speed||0)*0.32;}
function pDef(p){return(p.stats.defense||0)*0.06;}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}

// Push player out of a circle obstacle
function resolveCircle(p,ox,oy,or_){
  const d=dist(p,{x:ox,y:oy});
  const min=P_R+or_;
  if(d<min&&d>0.01){
    const nx=(p.x-ox)/d,ny=(p.y-oy)/d;
    p.x=ox+nx*min;p.y=oy+ny*min;
  }
}

function killPlayer(killer,victim){
  victim.alive=false;victim.respawnTimer=6;killer.kills++;
  addXp(killer,150+victim.level*25);
  killer.wood+=Math.floor(victim.wood*0.4);killer.food+=Math.floor(victim.food*0.4);killer.stone+=Math.floor(victim.stone*0.4);
  victim.wood=victim.food=victim.stone=0;
  broadcast({type:'kill',killer:killer.name,victim:victim.name});
}
function pushApart(a,b,min){
  const d=dist(a,b);if(d<min&&d>0.01){
    const nx=(a.x-b.x)/d,ny=(a.y-b.y)/d,push=(min-d)/2;
    a.x+=nx*push;a.y+=ny*push;b.x-=nx*push;b.y-=ny*push;
  }
}

// Game loop — 20 ticks/sec (server authoritative, client interpolates)
let lastTick=Date.now();
setInterval(()=>{
  const now=Date.now(),dt=(now-lastTick)/1000;lastTick=now;
  const alive=[...clients.values()].map(c=>c.player).filter(p=>p&&p.alive);

  for(const c of clients.values()){
    const p=c.player;if(!p)continue;
    if(!p.alive){
      p.respawnTimer-=dt;
      if(p.respawnTimer<=0){p.alive=true;p.hp=p.maxHp;p.x=400+Math.random()*(MAP-800);p.y=400+Math.random()*(MAP-800);}
      continue;
    }
    const inp=c.input||{};
    let mx=0,my=0;
    if(inp.up)my-=1;if(inp.down)my+=1;if(inp.left)mx-=1;if(inp.right)mx+=1;
    const mag=Math.hypot(mx,my);if(mag>0){mx/=mag;my/=mag;}
    p.x=clamp(p.x+mx*pSpd(p),P_R,MAP-P_R);
    p.y=clamp(p.y+my*pSpd(p),P_R,MAP-P_R);
    if(inp.angle!==undefined)p.angle=inp.angle;

    // Solid structure collision
    for(const s of structures){
      if(!s.alive||!STRUCTS[s.type]?.solid)continue;
      resolveCircle(p,s.x,s.y,s.radius);
    }

    if(inp.eat&&p.food>0){p.food--;p.hp=Math.min(p.maxHp,p.hp+25);}
    if(now-p.lastDmgTime>REGEN_WAIT)p.hp=Math.min(p.maxHp,p.hp+REGEN_RATE*dt);
    if(p.attackTimer>0)p.attackTimer-=dt*1000;

    if(inp.attack&&p.attackTimer<=0){
      const wdef=WEAPONS[p.weapon];if(!wdef){p.attacking=false;continue;}
      p.attackTimer=wdef.cooldown;p.attacking=true;
      if(wdef.proj){
        projectiles.push({id:projId++,ownerId:p.id,x:p.x,y:p.y,
          vx:Math.cos(p.angle)*16,vy:Math.sin(p.angle)*16,
          damage:wDmg(p,p.weapon),life:2.2});
      }else{
        const dmg=wDmg(p,p.weapon),ax=p.x+Math.cos(p.angle)*wdef.range,ay=p.y+Math.sin(p.angle)*wdef.range,hitR=p.weapon==='spear'?28:36;
        for(const o of alive){
          if(o.id===p.id)continue;
          if(dist({x:ax,y:ay},o)<P_R+hitR){const actual=Math.round(dmg*(1-pDef(o)));o.hp-=actual;o.lastDmgTime=now;if(o.hp<=0)killPlayer(p,o);}
        }
        for(const r of resources){
          if(r.hp<=0)continue;
          if(dist({x:ax,y:ay},r)<r.radius+28){
            r.hp-=dmg*1.6;
            if(r.dropWood)p.wood+=r.dropWood;if(r.dropFood)p.food+=r.dropFood;if(r.dropStone)p.stone+=r.dropStone;
            addXp(p,r.xp);
            if(r.hp<=0)setTimeout(()=>{r.hp=r.maxHp;r.x=80+Math.random()*(MAP-160);r.y=80+Math.random()*(MAP-160);},20000);
          }
        }
        for(const s of structures){
          if(!s.alive||s.ownerId===p.id)continue;
          if(dist({x:ax,y:ay},s)<s.radius+28){s.hp-=dmg;if(s.hp<=0)s.alive=false;}
        }
      }
    }else if(!inp.attack)p.attacking=false;
  }

  // Projectiles
  for(let i=projectiles.length-1;i>=0;i--){
    const pr=projectiles[i];pr.x+=pr.vx;pr.y+=pr.vy;pr.life-=dt;
    if(pr.life<=0||pr.x<0||pr.x>MAP||pr.y<0||pr.y>MAP){projectiles.splice(i,1);continue;}
    let hit=false;
    for(const o of alive){
      if(o.id===pr.ownerId)continue;
      if(dist(pr,o)<P_R+10){
        const actual=Math.round(pr.damage*(1-pDef(o)));o.hp-=actual;o.lastDmgTime=now;
        const owner=clients.get(pr.ownerId)?.player;if(o.hp<=0&&owner)killPlayer(owner,o);
        hit=true;break;
      }
    }
    // arrow hits solid structure
    if(!hit){
      for(const s of structures){
        if(!s.alive)continue;
        if(dist(pr,s)<s.radius+6){projectiles.splice(i,1);hit=true;break;}
      }
    }
    if(hit)continue;
  }

  // Spikes & windmill XP
  for(const s of structures){
    if(!s.alive)continue;
    const owner=clients.get(s.ownerId)?.player;
    if(STRUCTS[s.type]?.xpPerSec&&owner)addXp(owner,STRUCTS[s.type].xpPerSec*dt);
    if(STRUCTS[s.type]?.damage){
      for(const o of alive){
        if(o.id===s.ownerId)continue;
        if(dist(o,s)<s.radius+P_R){o.hp-=STRUCTS[s.type].damage*dt;o.lastDmgTime=now;if(o.hp<=0&&owner)killPlayer(owner,o);}
      }
    }
  }

  // Player collisions
  for(let i=0;i<alive.length;i++)for(let j=i+1;j<alive.length;j++)pushApart(alive[i],alive[j],P_R*2);

  // Broadcast — only send delta-relevant fields, skip dead projectiles already removed
  const lb=[...clients.values()].filter(c=>c.player)
    .map(c=>({n:c.player.name,s:Math.floor(c.player.score),l:c.player.level,k:c.player.kills}))
    .sort((a,b)=>b.s-a.s).slice(0,10);

  const stateMsg=JSON.stringify({
    t:'s',
    pl:alive.map(p=>({i:p.id,n:p.name,x:Math.round(p.x),y:Math.round(p.y),a:p.angle,h:p.hp,m:p.maxHp,w:p.weapon,at:p.attacking,l:p.level,k:p.kills})),
    // include dead players so client knows they died
    dead:[...clients.values()].filter(c=>c.player&&!c.player.alive).map(c=>({i:c.player.id})),
    re:resources.filter(r=>r.hp>0).map(r=>({i:r.id,t:r.type,x:Math.round(r.x),y:Math.round(r.y),r:r.radius,h:r.hp,m:r.maxHp})),
    st:structures.filter(s=>s.alive).map(s=>({i:s.id,t:s.type,x:s.x,y:s.y,r:s.radius,h:s.hp,m:s.maxHp,o:s.ownerId})),
    pr:projectiles.map(p=>({i:p.id,x:Math.round(p.x),y:Math.round(p.y),vx:Math.round(p.vx*10)/10,vy:Math.round(p.vy*10)/10})),
    lb,
  });
  const frame=wsEncode(stateMsg);

  for(const c of clients.values()){
    if(!c.player)continue;
    const p=c.player;
    send(c.socket,{t:'inv',wo:Math.floor(p.wood),fo:Math.floor(p.food),st:Math.floor(p.stone),
      xp:Math.floor(p.xp),xn:xpNeeded(p.level),lv:p.level,sp:p.statPoints,ss:p.stats,
      wp:p.weapon,hp:p.hp,mh:p.maxHp,ki:p.kills,sc:Math.floor(p.score)});
    try{c.socket.write(frame);}catch(e){}
  }
},TICK_MS);

server.on('upgrade',(req,sock)=>{
  if(req.headers['upgrade']!=='websocket'){sock.destroy();return;}
  wsHandshake(sock,req);
  const id=nextId++;
  const client={socket:sock,id,player:null,input:{},buffer:Buffer.alloc(0)};
  clients.set(id,client);
  sock.on('data',chunk=>{
    client.buffer=Buffer.concat([client.buffer,chunk]);
    while(client.buffer.length>=2){
      const op=client.buffer[0]&0x0f;if(op===8){sock.destroy();return;}
      const res=wsDecode(client.buffer);if(!res)break;
      client.buffer=client.buffer.slice(res.consumed);
      try{handleMsg(client,JSON.parse(res.text));}catch(e){}
    }
  });
  sock.on('close',()=>{clients.delete(id);broadcast({t:'left',i:id});});
  sock.on('error',()=>clients.delete(id));
});

function handleMsg(c,d){
  switch(d.type){
    case 'join':
      c.player=makePlayer(c.id,d.name);
      send(c.socket,{type:'welcome',id:c.id,mapSize:MAP,weapons:WEAPONS,xpTable:XP_TABLE,maxLevel:MAX_LVL});
      break;
    case 'input':c.input=d;break;
    case 'weapon':
      if(c.player){const w=WEAPONS[d.weapon];
        if(w&&c.player.level>=w.unlockLvl)c.player.weapon=d.weapon;
        else send(c.socket,{type:'toast',msg:'Reach level '+(w?.unlockLvl||'?')+' to unlock '+d.weapon+'!'});}
      break;
    case 'allocateStat':
      if(c.player&&c.player.statPoints>0){
        const ok=['axePower','spearPower','bowPower','speed','defense'];
        if(ok.includes(d.stat)&&c.player.stats[d.stat]<20){c.player.stats[d.stat]++;c.player.statPoints--;}
      }break;
    case 'build':{
      if(!c.player||!c.player.alive)break;
      const def=STRUCTS[d.stype];if(!def)break;
      const p=c.player;
      for(const[r,amt]of Object.entries(def.cost)){if(p[r]<amt){send(c.socket,{type:'toast',msg:'Need '+amt+' '+r});return;}}
      for(const[r,amt]of Object.entries(def.cost))p[r]-=amt;
      structures.push({id:strId++,type:d.stype,x:d.x,y:d.y,radius:def.radius,hp:def.hp,maxHp:def.hp,ownerId:c.id,alive:true});
      addXp(p,15);break;
    }
  }
}
server.listen(3000,()=>console.log('Tribe.io on http://localhost:3000'));
