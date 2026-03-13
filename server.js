const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

// ─── Raw WebSocket Upgrade ────────────────────────────────────────────────────
const clients = new Map(); // id -> { socket, frames, id, ...gameState }
let nextId = 1;

function wsHandshake(socket, req) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsDecode(buf) {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + (masked ? 4 : 0) + len) return null;
  const mask = masked ? buf.slice(offset, offset + 4) : null;
  offset += masked ? 4 : 0;
  const data = buf.slice(offset, offset + len);
  if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return data.toString('utf8');
}

function wsEncode(msg) {
  const data = Buffer.from(msg, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; header[1] = len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, data]);
}

function send(socket, obj) {
  try { socket.write(wsEncode(JSON.stringify(obj))); } catch(e) {}
}

function broadcast(obj, excludeId) {
  const frame = wsEncode(JSON.stringify(obj));
  for (const [id, c] of clients) {
    if (id !== excludeId) try { c.socket.write(frame); } catch(e) {}
  }
}

// ─── Game Constants ───────────────────────────────────────────────────────────
const MAP_SIZE = 3000;
const TICK_RATE = 60;
const PLAYER_SPEED = 3.5;
const PLAYER_RADIUS = 20;
const SWORD_DAMAGE = 25;
const SPEAR_DAMAGE = 15;
const SWORD_RANGE = 60;
const SPEAR_RANGE = 110;
const ATTACK_COOLDOWN = 400;
const REGEN_DELAY = 5000;
const REGEN_RATE = 2;

// ─── Resources (trees, bushes, stones, gold) ─────────────────────────────────
const resources = [];
let resNextId = 1;
function spawnResources() {
  const types = [
    { type: 'tree',  count: 80, radius: 28, hp: 200, color: '#4a7c59', dropWood: 10 },
    { type: 'bush',  count: 60, radius: 20, hp: 80,  color: '#6aaa4a', dropFood: 8  },
    { type: 'stone', count: 50, radius: 25, hp: 300, color: '#888888', dropStone: 8 },
    { type: 'gold',  count: 25, radius: 22, hp: 250, color: '#f0c040', dropGold: 5  },
  ];
  for (const t of types) {
    for (let i = 0; i < t.count; i++) {
      resources.push({
        id: resNextId++,
        type: t.type,
        x: 60 + Math.random() * (MAP_SIZE - 120),
        y: 60 + Math.random() * (MAP_SIZE - 120),
        radius: t.radius,
        hp: t.hp, maxHp: t.hp,
        color: t.color,
        dropWood:  t.dropWood  || 0,
        dropFood:  t.dropFood  || 0,
        dropStone: t.dropStone || 0,
        dropGold:  t.dropGold  || 0,
      });
    }
  }
}
spawnResources();

// ─── Structures ───────────────────────────────────────────────────────────────
const structures = [];
let strNextId = 1;
const STRUCTURE_DEFS = {
  wall:     { cost: { wood: 10 }, hp: 400, radius: 24, color: '#c8a96e' },
  spike:    { cost: { wood: 15, stone: 5 }, hp: 200, radius: 18, color: '#8b6a3a', damage: 20 },
  windmill: { cost: { wood: 50, stone: 20 }, hp: 300, radius: 30, color: '#e0c060', goldPerSec: 1 },
  mine:     { cost: { wood: 30, stone: 15 }, hp: 300, radius: 28, color: '#777', stonePerSec: 0.5 },
};

// ─── Player factory ───────────────────────────────────────────────────────────
function makePlayer(id, name) {
  return {
    id, name: name || `Player${id}`,
    x: 200 + Math.random() * (MAP_SIZE - 400),
    y: 200 + Math.random() * (MAP_SIZE - 400),
    angle: 0,
    hp: 100, maxHp: 100,
    wood: 0, food: 0, stone: 0, gold: 0,
    score: 0,
    kills: 0,
    weapon: 'sword', // sword | spear
    attacking: false,
    attackTimer: 0,
    lastDamageTime: 0,
    alive: true,
    respawnTimer: 0,
    vx: 0, vy: 0,
  };
}

// ─── Projectiles ──────────────────────────────────────────────────────────────
const projectiles = [];
let projNextId = 1;

// ─── Game loop ────────────────────────────────────────────────────────────────
let lastTick = Date.now();

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function circlePush(a, b, minDist) {
  const d = dist(a, b);
  if (d < minDist && d > 0.01) {
    const nx = (a.x - b.x) / d, ny = (a.y - b.y) / d;
    const push = (minDist - d) / 2;
    a.x += nx * push; a.y += ny * push;
    b.x -= nx * push; b.y -= ny * push;
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function respawnResource(r) {
  r.hp = r.maxHp;
  r.x = 60 + Math.random() * (MAP_SIZE - 120);
  r.y = 60 + Math.random() * (MAP_SIZE - 120);
}

function tick() {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  const playerArr = [...clients.values()].map(c => c.player).filter(p => p && p.alive);

  // Move players
  for (const c of clients.values()) {
    const p = c.player;
    if (!p) continue;
    if (!p.alive) {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) {
        p.alive = true;
        p.hp = p.maxHp;
        p.x = 200 + Math.random() * (MAP_SIZE - 400);
        p.y = 200 + Math.random() * (MAP_SIZE - 400);
      }
      continue;
    }

    // Input movement
    const inp = c.input || {};
    let mvx = 0, mvy = 0;
    if (inp.up)    mvy -= 1;
    if (inp.down)  mvy += 1;
    if (inp.left)  mvx -= 1;
    if (inp.right) mvx += 1;
    const mag = Math.hypot(mvx, mvy);
    if (mag > 0) { mvx /= mag; mvy /= mag; }

    p.x = clamp(p.x + mvx * PLAYER_SPEED, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
    p.y = clamp(p.y + mvy * PLAYER_SPEED, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
    if (inp.angle !== undefined) p.angle = inp.angle;

    // Regen
    if (now - p.lastDamageTime > REGEN_DELAY) {
      p.hp = Math.min(p.maxHp, p.hp + REGEN_RATE * dt);
    }

    // Eat food for hp
    if (inp.eat && p.food > 0) {
      p.food--;
      p.hp = Math.min(p.maxHp, p.hp + 20);
    }

    // Attack timer
    if (p.attackTimer > 0) p.attackTimer -= dt * 1000;

    // Attack
    if (inp.attack && p.attackTimer <= 0) {
      p.attacking = true;
      p.attackTimer = ATTACK_COOLDOWN;
      const range = p.weapon === 'spear' ? SPEAR_RANGE : SWORD_RANGE;
      const dmg   = p.weapon === 'spear' ? SPEAR_DAMAGE : SWORD_DAMAGE;
      const ax = p.x + Math.cos(p.angle) * range;
      const ay = p.y + Math.sin(p.angle) * range;

      // Hit players
      for (const other of playerArr) {
        if (other.id === p.id || !other.alive) continue;
        if (dist({ x: ax, y: ay }, other) < PLAYER_RADIUS + (p.weapon === 'spear' ? 25 : 30)) {
          other.hp -= dmg;
          other.lastDamageTime = now;
          if (other.hp <= 0) {
            other.alive = false;
            other.respawnTimer = 5;
            p.kills++;
            p.score += 100;
            // drop resources
            p.wood  += Math.floor(other.wood  * 0.5);
            p.food  += Math.floor(other.food  * 0.5);
            p.stone += Math.floor(other.stone * 0.5);
            p.gold  += Math.floor(other.gold  * 0.5);
            other.wood = other.food = other.stone = other.gold = 0;
          }
        }
      }

      // Harvest resources
      for (const r of resources) {
        if (r.hp <= 0) continue;
        if (dist({ x: ax, y: ay }, r) < r.radius + 20) {
          r.hp -= dmg * 2;
          p.wood  += r.dropWood;
          p.food  += r.dropFood;
          p.stone += r.dropStone;
          p.gold  += r.dropGold;
          p.score += 2;
          if (r.hp <= 0) {
            setTimeout(() => respawnResource(r), 15000);
          }
        }
      }

      // Damage structures
      for (const s of structures) {
        if (!s.alive) continue;
        if (dist({ x: ax, y: ay }, s) < s.radius + 20) {
          s.hp -= dmg;
          if (s.hp <= 0) s.alive = false;
        }
      }
    } else {
      p.attacking = false;
    }
  }

  // Player-player collision
  for (let i = 0; i < playerArr.length; i++) {
    for (let j = i + 1; j < playerArr.length; j++) {
      circlePush(playerArr[i], playerArr[j], PLAYER_RADIUS * 2);
    }
  }

  // Structure passive effects
  for (const s of structures) {
    if (!s.alive) continue;
    const def = STRUCTURE_DEFS[s.type];
    const owner = clients.get(s.ownerId);
    if (!owner || !owner.player) continue;
    const p = owner.player;
    if (def.goldPerSec) p.gold += def.goldPerSec * dt;
    if (def.stonePerSec) p.stone += def.stonePerSec * dt;
    // spike damage
    if (def.damage) {
      for (const op of playerArr) {
        if (op.id === s.ownerId) continue;
        if (dist(op, s) < s.radius + PLAYER_RADIUS) {
          op.hp -= def.damage * dt;
          op.lastDamageTime = now;
          if (op.hp <= 0) {
            op.alive = false;
            op.respawnTimer = 5;
            p.kills++;
            p.score += 100;
          }
        }
      }
    }
  }

  // Build leaderboard
  const leaderboard = [...clients.values()]
    .filter(c => c.player)
    .map(c => ({ name: c.player.name, score: Math.floor(c.player.score), kills: c.player.kills }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // Broadcast state
  const state = {
    type: 'state',
    players: [...clients.values()].filter(c => c.player).map(c => {
      const p = c.player;
      return {
        id: p.id, name: p.name,
        x: Math.round(p.x), y: Math.round(p.y),
        angle: p.angle, hp: p.hp, maxHp: p.maxHp,
        weapon: p.weapon, attacking: p.attacking,
        alive: p.alive, score: Math.floor(p.score), kills: p.kills,
      };
    }),
    resources: resources.filter(r => r.hp > 0).map(r => ({
      id: r.id, type: r.type, x: Math.round(r.x), y: Math.round(r.y),
      radius: r.radius, hp: r.hp, maxHp: r.maxHp,
    })),
    structures: structures.filter(s => s.alive).map(s => ({
      id: s.id, type: s.type, x: s.x, y: s.y,
      radius: s.radius, hp: s.hp, maxHp: s.maxHp, ownerId: s.ownerId,
    })),
    leaderboard,
  };

  const frame = wsEncode(JSON.stringify(state));
  for (const c of clients.values()) {
    if (!c.player) continue;
    const p = c.player;
    // Send personal inventory separately
    send(c.socket, {
      type: 'inventory',
      wood: Math.floor(p.wood), food: Math.floor(p.food),
      stone: Math.floor(p.stone), gold: Math.floor(p.gold),
      weapon: p.weapon, hp: p.hp,
    });
    try { c.socket.write(frame); } catch(e) {}
  }
}

setInterval(tick, 1000 / TICK_RATE);

// ─── WebSocket upgrade handler ────────────────────────────────────────────────
server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') { socket.destroy(); return; }
  wsHandshake(socket, req);

  const id = nextId++;
  const client = { socket, id, player: null, input: {}, buffer: Buffer.alloc(0) };
  clients.set(id, client);

  console.log(`[+] Client ${id} connected`);

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    while (client.buffer.length >= 2) {
      const opcode = client.buffer[0] & 0x0f;
      if (opcode === 8) { socket.destroy(); return; } // close
      let len = client.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (client.buffer.length < 4) break; len = client.buffer.readUInt16BE(2); offset = 4; }
      const masked = (client.buffer[1] & 0x80) !== 0;
      const totalLen = offset + (masked ? 4 : 0) + len;
      if (client.buffer.length < totalLen) break;
      const msg = wsDecode(client.buffer.slice(0, totalLen));
      client.buffer = client.buffer.slice(totalLen);
      if (!msg) continue;
      try {
        const data = JSON.parse(msg);
        handleMessage(client, data);
      } catch(e) {}
    }
  });

  socket.on('close', () => {
    clients.delete(id);
    console.log(`[-] Client ${id} disconnected`);
    broadcast({ type: 'playerLeft', id });
  });

  socket.on('error', () => {
    clients.delete(id);
  });
});

function handleMessage(client, data) {
  switch (data.type) {
    case 'join':
      client.player = makePlayer(client.id, data.name);
      send(client.socket, { type: 'welcome', id: client.id, mapSize: MAP_SIZE });
      broadcast({ type: 'playerJoined', id: client.id, name: client.player.name }, client.id);
      break;
    case 'input':
      client.input = data;
      break;
    case 'weapon':
      if (client.player) client.player.weapon = data.weapon;
      break;
    case 'build': {
      if (!client.player || !client.player.alive) break;
      const def = STRUCTURE_DEFS[data.stype];
      if (!def) break;
      const p = client.player;
      // check cost
      for (const [res, amt] of Object.entries(def.cost)) {
        if (p[res] < amt) { send(client.socket, { type: 'buildFail', reason: `Need ${amt} ${res}` }); return; }
      }
      for (const [res, amt] of Object.entries(def.cost)) p[res] -= amt;
      structures.push({
        id: strNextId++,
        type: data.stype,
        x: data.x, y: data.y,
        radius: def.radius,
        hp: def.hp, maxHp: def.hp,
        ownerId: client.id,
        alive: true,
      });
      p.score += 10;
      break;
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 3000;
server.listen(PORT, () => console.log(`MooMoo server running at http://localhost:${PORT}`));
