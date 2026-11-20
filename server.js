
'use strict';
const http = require('http'), crypto = require('crypto');
const PORT = +process.env.PORT || 8080, MAX_PLAYERS = 40, GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HIT = 2000000, HITS_PER_SEC = 15, STATE_PER_SEC = 25, IDLE_MS = 45000, ARENA_R = 68;
const clients = new Map(); let nextId = 1;

const server = http.createServer(function (req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('RanCraft PvP server OK - players online: ' + clients.size + '\n');
});

/* ---------- minimal RFC 6455 WebSocket ---------- */
function frame(str) {
  const p = Buffer.from(str), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x81, n]); else if (n < 65536) h = Buffer.from([0x81, 126, n >> 8, n & 255]);
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  return Buffer.concat([h, p]);
}
function send(c, obj) { if (c.sock.destroyed || !c.open) return; try { c.sock.write(frame(JSON.stringify(obj))); } catch (e) {} }
function broadcast(obj, except) { const f = frame(JSON.stringify(obj)); clients.forEach(function (c) { if (c !== except && c.joined && c.open && !c.sock.destroyed) { try { c.sock.write(f); } catch (e) {} } }); }
function parse(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  if (c.buf.length > 200000) { c.sock.destroy(); return; }
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const op = b[0] & 15, fin = (b[0] & 128) !== 0, masked = (b[1] & 128) !== 0; let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = b.readUInt32BE(6); off = 10; }
    if (len > 16384) { c.sock.destroy(); return; }
    if (b.length < off + (masked ? 4 : 0) + len) return;
    let payload;
    if (masked) { const m = b.slice(off, off + 4); payload = Buffer.from(b.slice(off + 4, off + 4 + len)); for (let i = 0; i < len; i++) payload[i] ^= m[i & 3]; off += 4; }
    else payload = b.slice(off, off + len);
    c.buf = b.slice(off + len);
    if (op === 8) { c.sock.end(); return; }
    if (op === 9) { try { c.sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch (e) {} continue; }
    if (op === 1 || op === 0) {
      c.frag = op === 1 ? [payload] : (c.frag || []).concat([payload]);
      if (fin) { const txt = Buffer.concat(c.frag).toString('utf8'); c.frag = null; onMessage(c, txt); }
    }
  }
}
server.on('upgrade', function (req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key || clients.size >= MAX_PLAYERS + 20) { sock.destroy(); return; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: nextId++, sock: sock, buf: Buffer.alloc(0), open: true, joined: false, last: Date.now(), kills: 0, deaths: 0, hits: [], states: [], x: 0, z: 0, ry: 0, hp: 1, mh: 1, mv: 0, name: '', lvl: 1 };
  clients.set(c.id, c);
  sock.on('data', function (d) { parse(c, d); });
  sock.on('close', function () { drop(c); }); sock.on('error', function () { drop(c); });
});
function drop(c) { if (!c.open) return; c.open = false; clients.delete(c.id); if (c.joined) broadcast({ t: 'l', id: c.id }); }

/* ---------- game messages ---------- */
function num(v, lo, hi, d) { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
function rate(arr, perSec) { const now = Date.now(); while (arr.length && now - arr[0] > 1000) arr.shift(); if (arr.length >= perSec) return false; arr.push(now); return true; }
function pub(c) { return { id: c.id, name: c.name, lvl: c.lvl, look: c.look, eq: c.eq, cw: c.cw, x: c.x, z: c.z, ry: c.ry, hp: c.hp, mh: c.mh, k: c.kills, d: c.deaths }; }
function top() { return Array.from(clients.values()).filter(function (c) { return c.joined; }).sort(function (a, b) { return b.kills - a.kills || a.deaths - b.deaths; }).slice(0, 5).map(function (c) { return [c.name, c.kills, c.deaths]; }); }
function small(o) { try { const s = JSON.stringify(o); return s.length < 3000 ? o : {}; } catch (e) { return {}; } }
function onMessage(c, txt) {
  c.last = Date.now(); let m; try { m = JSON.parse(txt); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'p') { send(c, { t: 'p', ts: m.ts, n: clients.size }); return; }
  if (m.t === 'join' && !c.joined) {
    if (Array.from(clients.values()).filter(function (x) { return x.joined; }).length >= MAX_PLAYERS) { send(c, { t: 'full' }); c.sock.end(); return; }
    c.name = String(m.name || 'Player').replace(/[^A-Za-z0-9]/g, '').slice(0, 14) || ('Player' + c.id); c.lvl = num(m.lvl, 1, 150, 1) | 0;
    c.look = small(m.look); c.eq = small(m.eq); c.cw = small(m.cw); c.mh = num(m.mh, 1, 1e9, 100); c.hp = c.mh;
    const a = Math.random() * Math.PI * 2, r = 14 + Math.random() * 38; c.x = Math.cos(a) * r; c.z = Math.sin(a) * r; c.joined = true;
    send(c, { t: 'w', id: c.id, x: c.x, z: c.z, players: Array.from(clients.values()).filter(function (x) { return x.joined && x !== c; }).map(pub), top: top() });
    broadcast({ t: 'j', p: pub(c) }, c); return;
  }
  if (!c.joined) return;
  if (m.t === 's') {
    if (!rate(c.states, STATE_PER_SEC)) return;
    c.x = num(m.x, -ARENA_R, ARENA_R, c.x); c.z = num(m.z, -ARENA_R, ARENA_R, c.z); c.ry = num(m.r, -10, 10, c.ry); c.hp = num(m.hp, 0, 1e9, c.hp); c.mh = num(m.mh, 1, 1e9, c.mh); c.mv = num(m.m, 0, 30, 0);
    broadcast({ t: 's', id: c.id, x: +c.x.toFixed(2), z: +c.z.toFixed(2), r: +c.ry.toFixed(2), hp: Math.round(c.hp), mh: Math.round(c.mh), m: +c.mv.toFixed(1) }, c);
  } else if (m.t === 'a') {
    if (!rate(c.anims || (c.anims = []), 12)) return;
    broadcast({ t: 'a', id: c.id, k: String(m.k || '').slice(0, 12), d: num(m.d, 0.1, 3, 0.5), sk: String(m.sk || '').slice(0, 24), x: num(m.x, -ARENA_R, ARENA_R, 0), z: num(m.z, -ARENA_R, ARENA_R, 0) }, c);
  } else if (m.t === 'e') {
    c.look = small(m.look); c.eq = small(m.eq); c.cw = small(m.cw); c.lvl = num(m.lvl, 1, 150, c.lvl) | 0;
    broadcast({ t: 'e', id: c.id, lvl: c.lvl, look: c.look, eq: c.eq, cw: c.cw }, c);
  } else if (m.t === 'h') {                                       // attacker -> victim (damage before the victim's defence)
    const v = clients.get(m.to | 0); if (!v || !v.joined || v === c) return;
    if (!rate(c.hits, HITS_PER_SEC)) return;
    send(v, { t: 'h', from: c.id, n: c.name, d: Math.round(num(m.d, 1, MAX_HIT, 1)), c: m.c ? 1 : 0 });
  } else if (m.t === 'k') {                                       // victim reports its own death
    if (c.deadAt && Date.now() - c.deadAt < 3000) return; c.deadAt = Date.now(); c.deaths++;
    const k = clients.get(m.by | 0); if (k && k !== c && k.joined) k.kills++;
    broadcast({ t: 'k', killer: k ? k.id : 0, kn: k ? k.name : '', victim: c.id, vn: c.name, top: top() });
  }
}
setInterval(function () { const now = Date.now(); clients.forEach(function (c) { if (now - c.last > IDLE_MS) { try { c.sock.destroy(); } catch (e) {} drop(c); } }); }, 10000);
setInterval(function () { if (clients.size) broadcast({ t: 'top', top: top(), n: Array.from(clients.values()).filter(function (c) { return c.joined; }).length }); }, 5000);
server.listen(PORT, function () { console.log('RanCraft PvP server listening on port ' + PORT); });
