const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const WORLD = 1000;
const CORE = { x: 500, y: 500 };
const MAX_PLAYERS = 4;
const TYPES = {
  z: { hp: 30, r: 13, sp: 38, coreDps: 6, pDps: 8 },
  r: { hp: 16, r: 9, sp: 75, coreDps: 5, pDps: 10 },
  b: { hp: 120, r: 22, sp: 26, coreDps: 14, pDps: 22 },
};

const rooms = new Map();
const page = fs.readFileSync(path.join(__dirname, 'index.html'));

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});
const wss = new WebSocketServer({ server: httpServer });

let nextId = 1;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(c));
  return c;
}

function newRoom(code) {
  return {
    code, players: new Map(), enemies: [], bullets: [],
    wave: 0, spawnLeft: 0, spawnTimer: 0,
    core: 100, state: 'lobby', overTimer: 0, hostId: null,
  };
}

function makePlayer(id, ws, name) {
  return {
    id, ws, name: String(name || 'بازیکن').slice(0, 12),
    x: CORE.x + rnd(-80, 80), y: CORE.y + rnd(-80, 80),
    ix: 0, iy: 0, hp: 100, maxHp: 100, dmg: 12, rate: 0.45, cd: 0,
    alive: true, kills: 0,
  };
}

function spawnEnemy(room) {
  const roll = Math.random();
  let t = 'z';
  if (room.wave >= 5 && roll < 0.12) t = 'b';
  else if (room.wave >= 3 && roll < 0.35) t = 'r';
  const T = TYPES[t];
  const a = rnd(0, Math.PI * 2);
  room.enemies.push({
    t, x: CORE.x + Math.cos(a) * 560, y: CORE.y + Math.sin(a) * 560,
    hp: T.hp, mhp: T.hp, dead: false,
  });
}

function startWave(room) {
  room.wave++;
  room.spawnLeft = 6 + room.wave * 3;
  room.spawnTimer = 1.5;
  if (room.wave > 1) {
    for (const p of room.players.values()) {
      p.maxHp += 10;
      p.dmg += 2;
      p.rate = Math.max(0.18, p.rate - 0.02);
      if (p.alive) {
        p.hp = Math.min(p.maxHp, p.hp + 40);
      } else {
        p.alive = true;
        p.hp = Math.round(p.maxHp * 0.6);
        p.x = CORE.x + rnd(-80, 80);
        p.y = CORE.y + rnd(-80, 80);
      }
    }
    room.core = Math.min(100, room.core + 20);
  }
}

function resetRoom(room) {
  room.wave = 0;
  room.spawnLeft = 0;
  room.spawnTimer = 0;
  room.enemies = [];
  room.bullets = [];
  room.core = 100;
  room.state = 'playing';
  for (const p of room.players.values()) {
    Object.assign(p, {
      hp: 100, maxHp: 100, dmg: 12, rate: 0.45, cd: 0, alive: true, kills: 0,
      x: CORE.x + rnd(-80, 80), y: CORE.y + rnd(-80, 80),
    });
  }
}

function update(room, dt) {
  if (room.state === 'over') {
    room.overTimer -= dt;
    if (room.overTimer <= 0) resetRoom(room);
    return;
  }
  if (room.state !== 'playing') return;

  // Spawning and wave progression
  if (room.spawnLeft > 0) {
    room.spawnTimer -= dt;
    if (room.spawnTimer <= 0) {
      spawnEnemy(room);
      room.spawnLeft--;
      room.spawnTimer = Math.max(0.3, 1.3 - room.wave * 0.05);
    }
  } else if (room.enemies.length === 0) {
    startWave(room);
    return;
  }

  // Players move and auto-shoot the nearest enemy
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    p.x = clamp(p.x + p.ix * 150 * dt, 0, WORLD);
    p.y = clamp(p.y + p.iy * 150 * dt, 0, WORLD);
    p.cd -= dt;
    if (p.cd <= 0) {
      let best = null, bd = 380;
      for (const e of room.enemies) {
        const d = dist(p.x, p.y, e.x, e.y);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) {
        const L = bd || 1;
        const s = 700;
        room.bullets.push({
          x: p.x, y: p.y,
          vx: ((best.x - p.x) / L) * s, vy: ((best.y - p.y) / L) * s,
          life: 0.6, dmg: p.dmg, owner: p.id,
        });
        p.cd = p.rate;
      }
    }
  }

  // Bullets
  for (const b of room.bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    for (const e of room.enemies) {
      if (!e.dead && dist(b.x, b.y, e.x, e.y) < TYPES[e.t].r + 3) {
        e.hp -= b.dmg;
        b.life = 0;
        if (e.hp <= 0) {
          e.dead = true;
          const o = room.players.get(b.owner);
          if (o) o.kills++;
        }
        break;
      }
    }
  }
  room.bullets = room.bullets.filter(b => b.life > 0);
  room.enemies = room.enemies.filter(e => !e.dead);

  // Enemies march on the core and bite players in contact
  const alive = [...room.players.values()].filter(p => p.alive);
  for (const e of room.enemies) {
    const T = TYPES[e.t];
    const dc = dist(e.x, e.y, CORE.x, CORE.y);
    if (dc > 40) {
      e.x += ((CORE.x - e.x) / dc) * T.sp * dt;
      e.y += ((CORE.y - e.y) / dc) * T.sp * dt;
    } else {
      room.core -= T.coreDps * dt;
    }
    for (const p of alive) {
      if (p.alive && dist(e.x, e.y, p.x, p.y) < T.r + 14) p.hp -= T.pDps * dt;
    }
  }

  for (const p of room.players.values()) {
    if (p.alive && p.hp <= 0) { p.alive = false; p.hp = 0; }
  }
  if (room.core <= 0) {
    room.core = 0;
    room.state = 'over';
    room.overTimer = 6;
  }
}

function broadcast(room) {
  const msg = JSON.stringify({
    t: 'state',
    s: {
      state: room.state,
      wave: room.wave,
      core: Math.max(0, Math.round(room.core)),
      host: room.hostId,
      over: room.state === 'over',
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
        hp: Math.round(p.hp), maxHp: p.maxHp, alive: p.alive, kills: p.kills,
      })),
      enemies: room.enemies.map(e => ({
        x: Math.round(e.x), y: Math.round(e.y), t: e.t,
        hp: Math.round(e.hp), mhp: e.mhp,
      })),
      bullets: room.bullets.map(b => ({ x: Math.round(b.x), y: Math.round(b.y) })),
    },
  });
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

wss.on('connection', ws => {
  const id = nextId++;
  let room = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'create') {
      if (room) return;
      const code = genCode();
      room = newRoom(code);
      rooms.set(code, room);
      room.hostId = id;
      room.players.set(id, makePlayer(id, ws, m.name));
      ws.send(JSON.stringify({ t: 'joined', code, id, host: true }));
    } else if (m.t === 'join') {
      if (room) return;
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r) return ws.send(JSON.stringify({ t: 'error', msg: 'اتاقی با این کد پیدا نشد' }));
      if (r.players.size >= MAX_PLAYERS) return ws.send(JSON.stringify({ t: 'error', msg: 'اتاق پره' }));
      room = r;
      room.players.set(id, makePlayer(id, ws, m.name));
      ws.send(JSON.stringify({ t: 'joined', code: room.code, id, host: room.hostId === id }));
    } else if (m.t === 'input' && room) {
      const p = room.players.get(id);
      if (p) {
        p.ix = clamp(Number(m.x) || 0, -1, 1);
        p.iy = clamp(Number(m.y) || 0, -1, 1);
      }
    } else if (m.t === 'start' && room && room.hostId === id && room.state === 'lobby') {
      room.state = 'playing';
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.players.delete(id);
    if (room.players.size === 0) {
      rooms.delete(room.code);
    } else if (room.hostId === id) {
      room.hostId = [...room.players.keys()][0];
    }
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    update(room, 1 / 30);
    broadcast(room);
  }
}, 1000 / 30);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('Server is running on port ' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list) {
      if ((n.family === 'IPv4' || n.family === 4) && !n.internal) {
        console.log('  برای گوشی همون وای‌فای: http://' + n.address + ':' + PORT);
      }
    }
  }
});
