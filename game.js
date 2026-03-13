// ─── MooMoo.io Clone — Client Game Engine ────────────────────────────────────
'use strict';

// ── SERVER CONFIG ─────────────────────────────────────────────────────────────
// Hosting frontend on Netlify? Set this to your PC's IP and port.
// Your PC must be running server.js and be reachable (port forwarded or same LAN).
// Example: 'ws://123.456.78.90:3000'
// Leave as null to auto-detect (for running everything locally).
const SERVER_URL = null;
// ─────────────────────────────────────────────────────────────────────────────

const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');

// ── State ─────────────────────────────────────────────────────────────────────
let ws, myId, mapSize = 3000;
let gameState  = { players: [], resources: [], structures: [], leaderboard: [] };
let inventory  = { wood: 0, food: 0, stone: 0, gold: 0, weapon: 'sword', hp: 100 };
let camX = 0, camY = 0;
let mouseX = 0, mouseY = 0; // world coords
let mouseScreenX = 0, mouseScreenY = 0;
let selectedBuild = null;
let keys = {};
let prevAlive = true;
let pingStart = 0, ping = 0;
let killFeedQueue = [];
let lastLeaderboard = [];

// ── Canvas Resize ─────────────────────────────────────────────────────────────
function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// ── Join ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-play').addEventListener('click', () => {
  const name = document.getElementById('name-input').value.trim() || 'Anonymous';
  const manualURL = document.getElementById('server-input').value.trim();
  connect(name, manualURL);
});
document.getElementById('name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-play').click();
});
document.getElementById('server-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-play').click();
});

function connect(name, manualURL) {
  let url;
  if (manualURL) {
    // User pasted a URL — use it directly (supports wss:// for Netlify)
    url = manualURL;
  } else if (SERVER_URL) {
    url = SERVER_URL;
  } else {
    const host = location.hostname || '127.0.0.1';
    const port = location.port || 3000;
    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    url = `${wsProtocol}://${host}:${port}`;
  }
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', name }));
  });

  ws.addEventListener('message', e => {
    const data = JSON.parse(e.data);
    onMessage(data);
  });

  ws.addEventListener('close', () => showToast('Disconnected from server'));
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function onMessage(data) {
  switch (data.type) {
    case 'welcome':
      myId = data.id;
      mapSize = data.mapSize;
      document.getElementById('join-screen').style.display = 'none';
      document.getElementById('hud').classList.add('active');
      break;

    case 'state':
      // detect kills for killfeed
      detectKills(gameState.players, data.players);
      gameState = data;
      updateLeaderboard(data.leaderboard);
      // respawn check
      const me = data.players.find(p => p.id === myId);
      if (me) {
        if (!me.alive && prevAlive) showRespawn(true);
        if (me.alive && !prevAlive)  showRespawn(false);
        prevAlive = me.alive;
      }
      break;

    case 'inventory':
      inventory = data;
      updateInventoryUI();
      updateHpBar(data.hp);
      updateWeaponUI(data.weapon);
      break;

    case 'buildFail':
      showToast(`❌ ${data.reason}`);
      break;

    case 'pong':
      ping = Date.now() - pingStart;
      document.getElementById('ping').textContent = `${ping}ms`;
      break;
  }
}

// ── Kill Feed ─────────────────────────────────────────────────────────────────
function detectKills(prev, next) {
  if (!prev.length) return;
  for (const np of next) {
    if (!np.alive) {
      const pp = prev.find(p => p.id === np.id);
      if (pp && pp.alive) {
        // find killer (someone whose kills increased)
        const killer = next.find(p => {
          const op = prev.find(x => x.id === p.id);
          return op && p.kills > op.kills;
        });
        addKillFeed(killer ? killer.name : '?', np.name);
      }
    }
  }
}

function addKillFeed(killer, victim) {
  const feed = document.getElementById('killfeed');
  const el = document.createElement('div');
  el.className = 'kf-entry';
  el.innerHTML = `⚔️ <b>${escHtml(killer)}</b> slayed <b>${escHtml(victim)}</b>`;
  feed.prepend(el);
  setTimeout(() => el.remove(), 4000);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── HUD updates ───────────────────────────────────────────────────────────────
function updateInventoryUI() {
  document.getElementById('inv-wood').textContent  = inventory.wood;
  document.getElementById('inv-food').textContent  = inventory.food;
  document.getElementById('inv-stone').textContent = inventory.stone;
  document.getElementById('inv-gold').textContent  = Math.floor(inventory.gold);
}

function updateHpBar(hp) {
  const pct = Math.max(0, Math.min(100, hp));
  const fill = document.getElementById('hp-bar-fill');
  fill.style.width = pct + '%';
  fill.style.background = pct < 30
    ? 'linear-gradient(90deg, #e05050, #f08080)'
    : 'linear-gradient(90deg, #4ecb71, #80ee90)';
  document.getElementById('hp-label').textContent = Math.ceil(hp);
}

function updateWeaponUI(weapon) {
  document.querySelectorAll('.wpn-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.weapon === weapon);
  });
}

function updateLeaderboard(lb) {
  const el = document.getElementById('lb-list');
  el.innerHTML = '';
  lb.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'lb-row';
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
    div.innerHTML = `<span class="lb-name">${medal} ${escHtml(row.name)}</span><span class="lb-score">${row.score}</span>`;
    el.appendChild(div);
  });
}

function showRespawn(show) {
  document.getElementById('respawn-overlay').classList.toggle('show', show);
}

function showToast(msg) {
  const wrap = document.getElementById('toast');
  wrap.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2100);
}

// ── Input ─────────────────────────────────────────────────────────────────────
const KEY_MAP = { w:'up', a:'left', s:'down', d:'right', arrowup:'up', arrowleft:'left', arrowdown:'down', arrowright:'right' };

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  // weapon switch
  if (k === '1') selectWeapon('sword');
  if (k === '2') selectWeapon('spear');
  // eat
  if (k === 'e') sendInput(true, false);
  // build shortcuts
  if (k === 'q') selectBuild(selectedBuild === 'wall' ? null : 'wall');
  if (k === 'f') selectBuild(selectedBuild === 'spike' ? null : 'spike');
  if (k === 'g') selectBuild(selectedBuild === 'windmill' ? null : 'windmill');
  if (k === 'h') selectBuild(selectedBuild === 'mine' ? null : 'mine');
});
window.addEventListener('keyup',  e => { keys[e.key.toLowerCase()] = false; });

canvas.addEventListener('mousemove', e => {
  mouseScreenX = e.clientX;
  mouseScreenY = e.clientY;
  mouseX = e.clientX - canvas.width/2  + camX;
  mouseY = e.clientY - canvas.height/2 + camY;
});

canvas.addEventListener('mousedown', e => {
  if (e.button === 0) {
    if (selectedBuild) {
      placeBuild(mouseX, mouseY);
    } else {
      sendInput(false, true);
    }
  }
});
canvas.addEventListener('mouseup', e => { if (e.button === 0) sendInput(false, false); });
canvas.addEventListener('contextmenu', e => e.preventDefault());

function selectWeapon(w) {
  send({ type: 'weapon', weapon: w });
}

function selectBuild(stype) {
  selectedBuild = stype;
  document.querySelectorAll('.build-btn').forEach(btn => {
    btn.classList.toggle('sel', btn.dataset.stype === stype);
  });
}

function placeBuild(x, y) {
  send({ type: 'build', stype: selectedBuild, x: Math.round(x), y: Math.round(y) });
}

// Weapon bar buttons
document.querySelectorAll('.wpn-btn').forEach(btn => {
  btn.addEventListener('click', () => selectWeapon(btn.dataset.weapon));
});

// Build bar buttons
document.querySelectorAll('.build-btn').forEach(btn => {
  btn.addEventListener('click', () => selectBuild(selectedBuild === btn.dataset.stype ? null : btn.dataset.stype));
});

// ── Input loop ────────────────────────────────────────────────────────────────
let lastInput = {};
function sendInput(eat = false, attack = false) {
  const me = gameState.players.find(p => p.id === myId);
  const angle = me ? Math.atan2(mouseY - me.y, mouseX - me.x) : 0;
  const inp = {
    type: 'input',
    up:    !!keys['w'] || !!keys['arrowup'],
    down:  !!keys['s'] || !!keys['arrowdown'],
    left:  !!keys['a'] || !!keys['arrowleft'],
    right: !!keys['d'] || !!keys['arrowright'],
    angle,
    attack,
    eat,
  };
  send(inp);
}

setInterval(() => sendInput(), 1000 / 30);

// Ping every 3s
setInterval(() => {
  pingStart = Date.now();
  send({ type: 'ping' });
}, 3000);

// ── Renderer ──────────────────────────────────────────────────────────────────
const COLORS = {
  tree:     '#4a7c59',
  bush:     '#6aaa4a',
  stone:    '#909090',
  gold:     '#f0c040',
  wall:     '#c8a96e',
  spike:    '#8b6a3a',
  windmill: '#e0c060',
  mine:     '#777',
};

function lerp(a, b, t) { return a + (b - a) * t; }

// Pre-render ground tiles for performance
let groundCanvas = null;
function buildGroundTile() {
  const size = 128;
  const oc = document.createElement('canvas');
  oc.width = oc.height = size;
  const oc2 = oc.getContext('2d');
  oc2.fillStyle = '#7ec850';
  oc2.fillRect(0, 0, size, size);
  // subtle variation dots
  for (let i = 0; i < 10; i++) {
    oc2.fillStyle = `rgba(0,0,0,${0.02 + Math.random()*0.03})`;
    oc2.beginPath();
    oc2.arc(Math.random()*size, Math.random()*size, 2+Math.random()*4, 0, Math.PI*2);
    oc2.fill();
  }
  return oc;
}

function drawGround() {
  if (!groundCanvas) groundCanvas = buildGroundTile();
  const pat = ctx.createPattern(groundCanvas, 'repeat');
  ctx.save();
  ctx.translate(-camX, -camY);
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, mapSize, mapSize);
  // border water ring
  ctx.fillStyle = '#5aafdc';
  ctx.fillRect(-200, -200, mapSize + 400, 200);
  ctx.fillRect(-200, mapSize, mapSize + 400, 200);
  ctx.fillRect(-200, -200, 200, mapSize + 400);
  ctx.fillRect(mapSize, -200, 200, mapSize + 400);
  ctx.restore();
}

function drawResource(r) {
  const sx = r.x - camX + canvas.width/2;
  const sy = r.y - camY + canvas.height/2;
  if (sx < -r.radius*2 || sy < -r.radius*2 || sx > canvas.width+r.radius*2 || sy > canvas.height+r.radius*2) return;

  ctx.save();
  ctx.translate(sx, sy);

  if (r.type === 'tree') {
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath(); ctx.ellipse(2, 6, r.radius*0.9, r.radius*0.5, 0, 0, Math.PI*2); ctx.fill();
    // trunk
    ctx.fillStyle = '#7a5230';
    ctx.fillRect(-4, 0, 8, 14);
    // canopy layers
    ctx.fillStyle = '#2d6e3a';
    ctx.beginPath(); ctx.arc(0, -r.radius*0.5, r.radius*1.1, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#4a7c59';
    ctx.beginPath(); ctx.arc(0, -r.radius*0.8, r.radius*0.85, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#6aaa70';
    ctx.beginPath(); ctx.arc(-3, -r.radius, r.radius*0.5, 0, Math.PI*2); ctx.fill();
  } else if (r.type === 'bush') {
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath(); ctx.ellipse(2, 5, r.radius, r.radius*0.5, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#3a8830';
    ctx.beginPath(); ctx.arc(0, 0, r.radius, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#6aaa4a';
    ctx.beginPath(); ctx.arc(-4, -3, r.radius*0.65, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#c04040'; // berries
    [-7,0,7].forEach(bx => {
      ctx.beginPath(); ctx.arc(bx, 2, 3, 0, Math.PI*2); ctx.fill();
    });
  } else if (r.type === 'stone') {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(3, 8, r.radius*0.85, r.radius*0.45, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#777';
    ctx.beginPath();
    ctx.moveTo(-r.radius, r.radius*0.5);
    ctx.lineTo(-r.radius*0.6, -r.radius*0.9);
    ctx.lineTo(r.radius*0.4, -r.radius);
    ctx.lineTo(r.radius, -r.radius*0.2);
    ctx.lineTo(r.radius*0.8, r.radius*0.7);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#aaa';
    ctx.beginPath();
    ctx.moveTo(-r.radius*0.5, -r.radius*0.7);
    ctx.lineTo(r.radius*0.2, -r.radius*0.9);
    ctx.lineTo(r.radius*0.5, -r.radius*0.3);
    ctx.lineTo(-r.radius*0.2, -r.radius*0.1);
    ctx.closePath(); ctx.fill();
  } else if (r.type === 'gold') {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(2, 8, r.radius*0.8, r.radius*0.4, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#c89020';
    ctx.beginPath();
    ctx.moveTo(-r.radius*0.5, r.radius*0.6);
    ctx.lineTo(-r.radius*0.8, -r.radius*0.3);
    ctx.lineTo(0, -r.radius);
    ctx.lineTo(r.radius*0.8, -r.radius*0.3);
    ctx.lineTo(r.radius*0.5, r.radius*0.6);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f0d050';
    ctx.beginPath();
    ctx.moveTo(-r.radius*0.3, r.radius*0.2);
    ctx.lineTo(-r.radius*0.5, -r.radius*0.3);
    ctx.lineTo(0, -r.radius*0.7);
    ctx.lineTo(r.radius*0.5, -r.radius*0.3);
    ctx.lineTo(r.radius*0.3, r.radius*0.2);
    ctx.closePath(); ctx.fill();
  }

  // HP bar if damaged
  if (r.hp < r.maxHp) {
    const barW = r.radius * 2;
    const pct  = r.hp / r.maxHp;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(-r.radius, r.radius + 5, barW, 5);
    ctx.fillStyle = pct > 0.5 ? '#4ecb71' : '#e05050';
    ctx.fillRect(-r.radius, r.radius + 5, barW * pct, 5);
  }

  ctx.restore();
}

function drawStructure(s) {
  const sx = s.x - camX + canvas.width/2;
  const sy = s.y - camY + canvas.height/2;
  if (sx < -80 || sy < -80 || sx > canvas.width+80 || sy > canvas.height+80) return;

  ctx.save();
  ctx.translate(sx, sy);

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath(); ctx.ellipse(2, s.radius*0.5+4, s.radius*0.9, s.radius*0.4, 0, 0, Math.PI*2); ctx.fill();

  if (s.type === 'wall') {
    ctx.fillStyle = '#d4aa70';
    ctx.strokeStyle = '#9a7040';
    ctx.lineWidth = 3;
    const r = s.radius;
    ctx.beginPath();
    ctx.roundRect(-r, -r, r*2, r*2, 5);
    ctx.fill(); ctx.stroke();
    // brick lines
    ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r, -r/2); ctx.lineTo(r, -r/2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r, r/2); ctx.lineTo(r, r/2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r/2, 0); ctx.lineTo(-r/2, r); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r/2, 0); ctx.lineTo(r/2, r); ctx.stroke();
  } else if (s.type === 'spike') {
    ctx.fillStyle = '#8b6a3a';
    ctx.beginPath(); ctx.arc(0, 0, s.radius, 0, Math.PI*2); ctx.fill();
    // spikes
    ctx.fillStyle = '#ddd';
    ctx.strokeStyle = '#999'; ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      ctx.save();
      ctx.rotate(i * Math.PI/4);
      ctx.beginPath();
      ctx.moveTo(-4, 0); ctx.lineTo(0, -s.radius-10); ctx.lineTo(4, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  } else if (s.type === 'windmill') {
    ctx.fillStyle = '#c0a040';
    ctx.beginPath(); ctx.arc(0, 0, s.radius, 0, Math.PI*2); ctx.fill();
    // rotating blades (use time)
    const t = Date.now() / 800;
    ctx.strokeStyle = '#f0d060'; ctx.lineWidth = 7;
    for (let i = 0; i < 4; i++) {
      const a = t + i * Math.PI/2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a)*8, Math.sin(a)*8);
      ctx.lineTo(Math.cos(a)*s.radius*0.95, Math.sin(a)*s.radius*0.95);
      ctx.stroke();
    }
    ctx.fillStyle = '#7a4a00';
    ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI*2); ctx.fill();
  } else if (s.type === 'mine') {
    ctx.fillStyle = '#606060';
    ctx.beginPath(); ctx.arc(0, 0, s.radius, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#888';
    ctx.beginPath(); ctx.arc(-4, -4, s.radius*0.5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#f0c040';
    ctx.beginPath(); ctx.arc(3, 3, 6, 0, Math.PI*2); ctx.fill();
  }

  // HP bar
  const pct = s.hp / s.maxHp;
  const barW = s.radius * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(-s.radius, s.radius + 5, barW, 5);
  ctx.fillStyle = pct > 0.5 ? '#4ecb71' : '#e05050';
  ctx.fillRect(-s.radius, s.radius + 5, barW * pct, 5);

  ctx.restore();
}

function drawPlayer(p) {
  if (!p.alive) return;
  const sx = p.x - camX + canvas.width/2;
  const sy = p.y - camY + canvas.height/2;
  if (sx < -80 || sy < -80 || sx > canvas.width+80 || sy > canvas.height+80) return;

  const isMe = p.id === myId;
  const R = 20;

  ctx.save();
  ctx.translate(sx, sy);

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath(); ctx.ellipse(2, R+2, R*0.85, R*0.35, 0, 0, Math.PI*2); ctx.fill();

  // body
  const bodyColor = isMe ? '#5599ff' : '#ff6655';
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = isMe ? '#2266cc' : '#cc3322';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI*2);
  ctx.fill(); ctx.stroke();

  // face direction
  ctx.save();
  ctx.rotate(p.angle);
  // eyes
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(10, -5, 4, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(10, 5,  4, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath(); ctx.arc(12, -5, 2, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(12, 5,  2, 0, Math.PI*2); ctx.fill();

  // weapon
  const wRange = p.weapon === 'spear' ? 110 : 60;
  const wW     = p.weapon === 'spear' ? 5   : 10;
  const wColor = p.weapon === 'spear' ? '#ccc' : '#c8883a';
  const anim   = p.attacking ? Math.sin(Date.now() / 60) * 0.4 : 0;
  ctx.save();
  ctx.rotate(anim);
  ctx.fillStyle = wColor;
  ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1;
  if (p.weapon === 'spear') {
    ctx.fillStyle = '#aaa';
    ctx.fillRect(R-4, -2, wRange, 4);
    ctx.fillStyle = '#eee';
    ctx.beginPath();
    ctx.moveTo(R + wRange - 4, -8);
    ctx.lineTo(R + wRange + 16, 0);
    ctx.lineTo(R + wRange - 4, 8);
    ctx.closePath(); ctx.fill();
  } else {
    ctx.fillRect(R-2, -wW/2, wRange, wW);
    ctx.strokeRect(R-2, -wW/2, wRange, wW);
  }
  ctx.restore();
  ctx.restore();

  // hat
  ctx.fillStyle = isMe ? '#2255cc' : '#aa2222';
  ctx.beginPath();
  ctx.arc(0, -R*0.3, R*0.75, Math.PI, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = isMe ? '#3366ee' : '#cc3333';
  ctx.fillRect(-R*0.75, -R*0.3, R*1.5, 4);

  // HP bar
  const pct = Math.max(0, p.hp) / p.maxHp;
  const bW = R * 2.5;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(-bW/2, -R-12, bW, 6);
  ctx.fillStyle = pct > 0.5 ? '#4ecb71' : pct > 0.25 ? '#f0c030' : '#e05050';
  ctx.fillRect(-bW/2, -R-12, bW * pct, 6);

  // name
  ctx.fillStyle = isMe ? '#99ccff' : '#ffdddd';
  ctx.font = 'bold 11px Nunito, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, 0, -R - 15);

  ctx.restore();
}

// ── Mini-map ──────────────────────────────────────────────────────────────────
function drawMinimap() {
  const size = 160;
  const pad  = 16;
  const mx   = canvas.width - size - pad;
  const my_  = canvas.height - size - pad - 90; // above inventory
  const scale = size / mapSize;

  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = '#2a4a1a';
  ctx.strokeStyle = 'rgba(255,210,100,0.3)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(mx, my_, size, size, 8);
  ctx.fill(); ctx.stroke();

  // resources (dots)
  for (const r of gameState.resources) {
    ctx.fillStyle = r.type === 'tree' ? '#4a7c59'
      : r.type === 'bush'  ? '#6aaa4a'
      : r.type === 'stone' ? '#888'
      : '#f0c040';
    ctx.beginPath();
    ctx.arc(mx + r.x*scale, my_ + r.y*scale, 1.5, 0, Math.PI*2);
    ctx.fill();
  }

  // players
  for (const p of gameState.players) {
    if (!p.alive) continue;
    ctx.fillStyle = p.id === myId ? '#5599ff' : '#ff6655';
    ctx.beginPath();
    ctx.arc(mx + p.x*scale, my_ + p.y*scale, 3, 0, Math.PI*2);
    ctx.fill();
  }

  // viewport rect
  const me = gameState.players.find(p => p.id === myId);
  if (me) {
    const vw = canvas.width  * scale;
    const vh = canvas.height * scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx + (me.x - canvas.width/2)*scale, my_ + (me.y - canvas.height/2)*scale, vw, vh);
  }

  ctx.restore();
}

// ── Build Preview ─────────────────────────────────────────────────────────────
function drawBuildPreview() {
  if (!selectedBuild) return;
  const sx = mouseScreenX;
  const sy = mouseScreenY;
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = COLORS[selectedBuild] || '#aaa';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  const r = { wall:24, spike:18, windmill:30, mine:28 }[selectedBuild] || 22;
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI*2);
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

// ── Game Loop ─────────────────────────────────────────────────────────────────
function gameLoop() {
  requestAnimationFrame(gameLoop);

  // Camera — follow my player smoothly
  const me = gameState.players.find(p => p.id === myId);
  if (me && me.alive) {
    const targetX = me.x;
    const targetY = me.y;
    camX = lerp(camX, targetX, 0.12);
    camY = lerp(camY, targetY, 0.12);
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawGround();

  // Draw structures
  for (const s of gameState.structures) drawStructure(s);

  // Draw resources
  for (const r of gameState.resources) drawResource(r);

  // Draw players (sort so current player is on top)
  const players = [...gameState.players].sort((a, b) => (b.id === myId ? 1 : 0) - (a.id === myId ? 1 : 0));
  for (const p of players) drawPlayer(p);

  drawBuildPreview();
  drawMinimap();
}

gameLoop();
