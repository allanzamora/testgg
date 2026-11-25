
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080, MAX_PLAYERS = 40, MAX_TOTAL = 400, GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HIT = 2000000, HITS_PER_SEC = 15, STATE_PER_SEC = 25, IDLE_MS = 45000, ARENA_R = 68, WORLD_LIM = 600, PVP_ROOM = 'pvp';
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
function broadcast(obj, except, room) { if (room !== undefined && String(room).indexOf('x_') === 0) return; const f = frame(JSON.stringify(obj)); clients.forEach(function (c) { if (c !== except && c.joined && c.open && !c.sock.destroyed && (room === undefined || c.room === room)) { try { c.sock.write(f); } catch (e) {} } }); }
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
  if (!key || clients.size >= MAX_TOTAL + 20) { sock.destroy(); return; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: nextId++, sock: sock, buf: Buffer.alloc(0), open: true, joined: false, last: Date.now(), kills: 0, deaths: 0, hits: [], states: [], x: 0, z: 0, ry: 0, hp: 1, mh: 1, mv: 0, name: '', lvl: 1 };
  clients.set(c.id, c);
  sock.on('data', function (d) { parse(c, d); });
  sock.on('close', function () { drop(c); }); sock.on('error', function () { drop(c); });
});
function drop(c) { if (!c.open) return; c.open = false; clients.delete(c.id); try { socialDrop(c); } catch (e) {} if (c.joined) broadcast({ t: 'l', id: c.id }, c, c.room); }

/* ---------- game messages ---------- */
function num(v, lo, hi, d) { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
function rate(arr, perSec) { const now = Date.now(); while (arr.length && now - arr[0] > 1000) arr.shift(); if (arr.length >= perSec) return false; arr.push(now); return true; }
function pub(c) { return { id: c.id, name: c.name, lvl: c.lvl, look: c.look, eq: c.eq, cw: c.cw, x: c.x, z: c.z, ry: c.ry, hp: c.hp, mh: c.mh, k: c.kills, d: c.deaths }; }
const roomDead = new Map();   
function deadList(room) { const d = roomDead.get(room), now = Date.now(), out = []; if (d) d.forEach(function (at, k) { if (at <= now) d.delete(k); else out.push([k, Math.round((at - now) / 1000)]); }); return out; }
function inRoom(room) { return Array.from(clients.values()).filter(function (c) { return c.joined && c.open && c.room === room; }); }
function roomOf(m) { const r = String((m && m.map) || PVP_ROOM).replace(/[^A-Za-z0-9_]/g, '').slice(0, 24); return r || PVP_ROOM; }
function lim(c) { return c.room === PVP_ROOM ? ARENA_R : WORLD_LIM; }
function top() { return inRoom(PVP_ROOM).sort(function (a, b) { return b.kills - a.kills || a.deaths - b.deaths; }).slice(0, 5).map(function (c) { return [c.name, c.kills, c.deaths]; }); }
function small(o) { try { const s = JSON.stringify(o); return s.length < 3000 ? o : {}; } catch (e) { return {}; } }

/* ====================== PARTY + GUILD ====================== */
const PARTY_MAX = 5, GUILD_MAX = 30, GFILE = path.join(process.env.DATA_DIR || __dirname, 'guilds.json');
const parties = new Map(); let nextParty = 1;
const guilds = new Map(), userGuild = new Map(); let nextGuild = 1;
try { const j = JSON.parse(fs.readFileSync(GFILE, 'utf8')); (j.guilds || []).forEach(function (g) { g.members = new Map(Object.entries(g.members || {})); guilds.set(g.id, g); g.members.forEach(function (m, u) { userGuild.set(u, g.id); }); nextGuild = Math.max(nextGuild, g.id + 1); }); } catch (e) {}
let saveTimer = null;
function saveGuilds() { clearTimeout(saveTimer); saveTimer = setTimeout(function () { try { const out = { guilds: Array.from(guilds.values()).map(function (g) { return Object.assign({}, g, { members: Object.fromEntries(g.members) }); }) }; fs.writeFileSync(GFILE, JSON.stringify(out)); } catch (e) {} }, 500); }
function say(c, msg) { send(c, { t: 'sm', msg: msg }); }
function clean(sx, n) { return String(sx || '').replace(/[<>&]/g, '').trim().slice(0, n); }
/* ---- party ---- */
function partyMembers(pa) { return pa.members.map(function (id) { return clients.get(id); }).filter(function (x) { return x && x.open; }); }
function partySend(pa, obj) { partyMembers(pa).forEach(function (x) { send(x, obj); }); }
function partyState(pa) {
  partySend(pa, { t: 'ps', lead: pa.leader, m: partyMembers(pa).map(function (x) { return { id: x.id, n: x.name, l: x.lvl, hp: Math.round(x.hp || 0), mh: Math.round(x.mh || 1), map: x.room }; }) });
}
function partyLeave(c, why) {
  const pa = parties.get(c.party); if (!pa) return; c.party = 0;
  pa.members = pa.members.filter(function (id) { return id !== c.id; });
  send(c, { t: 'ps', lead: 0, m: [], why: why || 'left' });
  if (pa.members.length < 2) { pa.members.forEach(function (id) { const x = clients.get(id); if (x) { x.party = 0; send(x, { t: 'ps', lead: 0, m: [], why: 'disbanded' }); } }); parties.delete(pa.id); return; }
  if (pa.leader === c.id) pa.leader = pa.members[0];
  partyState(pa);
}
function partyJoin(c, pa) { pa.members.push(c.id); c.party = pa.id; partyState(pa); }
setInterval(function () { parties.forEach(partyState); }, 2000);

function guildView(g) {
  return { id: g.id, name: g.name, desc: g.desc, leader: g.leader, members: Array.from(g.members.entries()).map(function (e) { let on = false; clients.forEach(function (c) { if (c.uid === e[0] && c.open && c.joined) on = true; }); return { u: e[0], n: e[1].n, l: e[1].l, on: on, r: e[0] === g.leader ? 'leader' : 'member' }; }) };
}
function guildOnline(g) { const out = []; clients.forEach(function (c) { if (c.uid && g.members.has(c.uid) && c.open && c.joined) out.push(c); }); return out; }
function guildPush(g) { const v = guildView(g); guildOnline(g).forEach(function (c) { send(c, { t: 'gok', g: v }); }); }
function guildLeave(uid, g) {
  g.members.delete(uid); userGuild.delete(uid);
  if (!g.members.size) { guilds.delete(g.id); }
  else if (g.leader === uid) g.leader = g.members.keys().next().value;
  saveGuilds();
}
function socialJoined(c, first) {
  const gid = c.uid && userGuild.get(c.uid), g = gid && guilds.get(gid);
  if (g) { const mm = g.members.get(c.uid); if (mm) { mm.n = c.name; mm.l = c.lvl; } send(c, { t: 'gok', g: guildView(g) }); if (first) guildOnline(g).forEach(function (x) { if (x !== c) say(x, '🏰 ' + c.name + ' is online.'); }); }
  else send(c, { t: 'gok', g: null });
}
function socialDrop(c) { if (c.party) partyLeave(c, 'offline'); }
function social(c, m) {
  const t = m.t;
  if (t === 'pi' || t === 'pn') {                                 
    let v = null; if (t === 'pi') v = clients.get(m.to | 0); else { const nm = clean(m.name, 20).toLowerCase(); clients.forEach(function (x) { if (x.joined && x.open && x.name.toLowerCase() === nm) v = x; }); }
    if (!v || !v.joined || v === c) { say(c, 'Player not found (they must be online).'); return true; }
    if (v.party) { say(c, v.name + ' is already in a party.'); return true; }
    const pa = parties.get(c.party); if (pa && pa.leader !== c.id) { say(c, 'Only the party leader can invite.'); return true; }
    if (pa && pa.members.length >= PARTY_MAX) { say(c, 'Party is full (5).'); return true; }
    v.inv = { from: c.id, at: Date.now() }; send(v, { t: 'pi', from: c.id, fn: c.name, fl: c.lvl }); say(c, 'Party invite sent to ' + v.name + '.'); return true;
  }
  if (t === 'pa') {
    const inv = c.inv; c.inv = null; if (!inv || Date.now() - inv.at > 60000) { say(c, 'Invite expired.'); return true; }
    const ld = clients.get(inv.from); if (!ld || !ld.open) { say(c, 'The inviter went offline.'); return true; }
    if (c.party) { say(c, 'Leave your party first.'); return true; }
    let pa = parties.get(ld.party);
    if (!pa) { pa = { id: nextParty++, leader: ld.id, members: [] }; parties.set(pa.id, pa); pa.members.push(ld.id); ld.party = pa.id; }
    if (pa.members.length >= PARTY_MAX) { say(c, 'Party is full.'); return true; }
    partyJoin(c, pa); partySend(pa, { t: 'sm', msg: '👥 ' + c.name + ' joined the party.' }); return true;
  }
  if (t === 'pd') { const inv = c.inv; c.inv = null; const ld = inv && clients.get(inv.from); if (ld) say(ld, c.name + ' declined your party invite.'); return true; }
  if (t === 'pl') { if (c.party) { const pa = parties.get(c.party); partyLeave(c, 'left'); if (pa) partySend(pa, { t: 'sm', msg: '👥 ' + c.name + ' left the party.' }); } return true; }
  if (t === 'pk') { const pa = parties.get(c.party); if (!pa || pa.leader !== c.id) return true; const v = clients.get(m.id | 0); if (v && v.party === pa.id && v !== c) { partyLeave(v, 'kicked'); say(v, 'You were removed from the party.'); } return true; }
  if (t === 'pc') { const pa = parties.get(c.party); if (pa && rate(c.chat || (c.chat = []), 3)) partySend(pa, { t: 'pc', n: c.name, msg: clean(m.msg, 120) }); return true; }
  if (t === 'px') {                                               // a party member killed a mob: share EXP with members nearby
    const pa = parties.get(c.party); if (!pa || !rate(c.pxr || (c.pxr = []), 20)) return true;
    partyMembers(pa).forEach(function (x) { if (x === c || x.room !== c.room) return; if (c.room.indexOf('x_') !== 0 && Math.hypot(x.x - c.x, x.z - c.z) > 70) return; send(x, { t: 'px', tl: num(m.tl, 1, 999, 1), tx: num(m.tx, 0, 1e9, 0), fx: m.fx ? 1 : 0 }); });
    return true;
  }
  /* ---- guild ---- */
  if (t[0] !== 'g' || t === 'gok') return false;
  if (!c.uid) { say(c, 'Guild needs a logged-in account id.'); return true; }
  const gid = userGuild.get(c.uid), mine = gid && guilds.get(gid);
  if (t === 'gv') { send(c, { t: 'gok', g: mine ? guildView(mine) : null }); return true; }
  if (t === 'gs') {
    const q = clean(m.q, 16).toLowerCase();
    const list = Array.from(guilds.values()).filter(function (g) { return !q || g.name.toLowerCase().indexOf(q) >= 0; }).sort(function (a, b) { return b.members.size - a.members.size; }).slice(0, 25).map(function (g) { const ld = g.members.get(g.leader); return { id: g.id, name: g.name, n: g.members.size, max: GUILD_MAX, leader: ld ? ld.n : '?', desc: g.desc }; });
    send(c, { t: 'gl', list: list, q: q }); return true;
  }
  if (t === 'gcr') {
    if (mine) { send(c, { t: 'ge', msg: 'You are already in a guild.' }); return true; }
    const name = clean(m.name, 16).replace(/\s+/g, ' ');
    if (name.length < 3 || !/^[A-Za-z0-9 ]+$/.test(name)) { send(c, { t: 'ge', msg: 'Guild name: 3-16 letters/numbers.' }); return true; }
    let dup = false; guilds.forEach(function (g) { if (g.name.toLowerCase() === name.toLowerCase()) dup = true; });
    if (dup) { send(c, { t: 'ge', msg: 'That guild name is taken.' }); return true; }
    const g = { id: nextGuild++, name: name, desc: clean(m.desc, 60), leader: c.uid, created: Date.now(), members: new Map([[c.uid, { n: c.name, l: c.lvl }]]) };
    guilds.set(g.id, g); userGuild.set(c.uid, g.id); saveGuilds(); send(c, { t: 'gok', g: guildView(g), created: 1 }); return true;
  }
  if (t === 'gj') {
    if (mine) { send(c, { t: 'ge', msg: 'Leave your guild first.' }); return true; }
    const g = guilds.get(m.id | 0); if (!g) { send(c, { t: 'ge', msg: 'Guild not found.' }); return true; }
    if (g.members.size >= GUILD_MAX) { send(c, { t: 'ge', msg: 'That guild is full.' }); return true; }
    g.members.set(c.uid, { n: c.name, l: c.lvl }); userGuild.set(c.uid, g.id); saveGuilds();
    guildPush(g); guildOnline(g).forEach(function (x) { say(x, '🏰 ' + c.name + ' joined the guild!'); }); return true;
  }
  if (!mine) return true;
  if (t === 'gx') {
    const wasLead = mine.leader === c.uid; guildLeave(c.uid, mine); send(c, { t: 'gok', g: null });
    if (guilds.has(mine.id)) { guildPush(mine); guildOnline(mine).forEach(function (x) { say(x, '🏰 ' + c.name + ' left the guild.' + (wasLead ? ' New leader chosen.' : '')); }); }
    return true;
  }
  if (t === 'gk') {
    if (mine.leader !== c.uid) return true; const nm = clean(m.name, 20).toLowerCase(); let tu = null; mine.members.forEach(function (mm, u) { if (mm.n.toLowerCase() === nm && u !== c.uid) tu = u; });
    if (!tu) return true; mine.members.delete(tu); userGuild.delete(tu); saveGuilds();
    clients.forEach(function (x) { if (x.uid === tu) { send(x, { t: 'gok', g: null }); say(x, 'You were removed from the guild.'); } }); guildPush(mine); return true;
  }
  if (t === 'gd') {
    if (mine.leader !== c.uid) return true; const on = guildOnline(mine); mine.members.forEach(function (mm, u) { userGuild.delete(u); }); guilds.delete(mine.id); saveGuilds();
    on.forEach(function (x) { send(x, { t: 'gok', g: null }); say(x, '🏰 The guild was disbanded.'); }); return true;
  }
  if (t === 'gn') { if (mine.leader === c.uid) { mine.desc = clean(m.desc, 60); saveGuilds(); guildPush(mine); } return true; }
  if (t === 'gc') { if (rate(c.chat || (c.chat = []), 3)) { const o = { t: 'gc', n: c.name, msg: clean(m.msg, 120) }; guildOnline(mine).forEach(function (x) { send(x, o); }); } return true; }
  return false;
}
function onMessage(c, txt) {
  c.last = Date.now(); let m; try { m = JSON.parse(txt); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'p') { send(c, { t: 'p', ts: m.ts, n: c.joined ? inRoom(c.room).length : clients.size }); return; }
  if ((m.t === 'join' && !c.joined) || (m.t === 'map' && c.joined)) {   
    const room = roomOf(m), was = c.joined ? c.room : null;
    if (was === room) return;
    if (inRoom(room).filter(function (x) { return x !== c; }).length >= MAX_PLAYERS) { send(c, { t: 'full' }); if (!c.joined) c.sock.end(); return; }
    if (was !== null) broadcast({ t: 'l', id: c.id }, c, was);
    c.room = room;
    c.name = String(m.name || c.name || 'Player').replace(/[^A-Za-z0-9]/g, '').slice(0, 14) || ('Player' + c.id); c.lvl = num(m.lvl, 1, 150, 1) | 0;
    if (m.uid) c.uid = String(m.uid).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 64);
    c.look = small(m.look); c.eq = small(m.eq); c.cw = small(m.cw); c.mh = num(m.mh, 1, 1e9, 100); c.hp = c.mh;
    const a = Math.random() * Math.PI * 2, r = room === PVP_ROOM ? 14 + Math.random() * 38 : 4 + Math.random() * 10; c.x = Math.cos(a) * r; c.z = Math.sin(a) * r; c.joined = true;
    send(c, { t: 'w', v: 3, dead: deadList(room), id: c.id, x: c.x, z: c.z, players: inRoom(room).filter(function (x) { return x !== c; }).map(pub), top: top() });
    broadcast({ t: 'j', p: pub(c) }, c, room);
    try { socialJoined(c, was === null); } catch (e) {} return;
  }
  if (!c.joined) return;
  if (m.t === 'mk') { if (c.room.indexOf('x_') === 0 || !rate(c.mkr || (c.mkr = []), 30)) return; const id = String(m.s || '').replace(/[^A-Za-z0-9_#]/g, '').slice(0, 40), rt = num(m.rt, 1, 900, 8); if (!id) return; let d = roomDead.get(c.room); if (!d) roomDead.set(c.room, d = new Map()); d.set(id, Date.now() + rt * 1000); broadcast({ t: 'mk', s: id, rt: rt }, c, c.room); return; }
  try { if (social(c, m)) return; } catch (e) { console.log('social error', e); }
  if (m.t === 's') {
    if (!rate(c.states, STATE_PER_SEC)) return;
    c.x = num(m.x, -lim(c), lim(c), c.x); c.z = num(m.z, -lim(c), lim(c), c.z); c.ry = num(m.r, -10, 10, c.ry); c.hp = num(m.hp, 0, 1e9, c.hp); c.mh = num(m.mh, 1, 1e9, c.mh); c.mv = num(m.m, 0, 30, 0);
    broadcast({ t: 's', id: c.id, x: +c.x.toFixed(2), z: +c.z.toFixed(2), r: +c.ry.toFixed(2), hp: Math.round(c.hp), mh: Math.round(c.mh), m: +c.mv.toFixed(1) }, c, c.room);
  } else if (m.t === 'a') {
    if (!rate(c.anims || (c.anims = []), 12)) return;
    broadcast({ t: 'a', id: c.id, k: String(m.k || '').slice(0, 12), d: num(m.d, 0.1, 3, 0.5), sk: String(m.sk || '').slice(0, 24), x: num(m.x, -lim(c), lim(c), 0), z: num(m.z, -lim(c), lim(c), 0) }, c, c.room);
  } else if (m.t === 'e') {
    c.look = small(m.look); c.eq = small(m.eq); c.cw = small(m.cw); c.lvl = num(m.lvl, 1, 150, c.lvl) | 0;
    broadcast({ t: 'e', id: c.id, lvl: c.lvl, look: c.look, eq: c.eq, cw: c.cw }, c, c.room);
  } else if (m.t === 'h') {                     
    const v = clients.get(m.to | 0); if (!v || !v.joined || v === c || v.room !== c.room) return;   
    if (!rate(c.hits, HITS_PER_SEC)) return;
    send(v, { t: 'h', from: c.id, n: c.name, d: Math.round(num(m.d, 1, MAX_HIT, 1)), c: m.c ? 1 : 0 });
  } else if (m.t === 'k') {                                       // victim reports its own death
    if (c.deadAt && Date.now() - c.deadAt < 3000) return; c.deadAt = Date.now(); c.deaths++;
    const k = clients.get(m.by | 0); if (k && k !== c && k.joined) k.kills++;
    broadcast({ t: 'k', killer: k ? k.id : 0, kn: k ? k.name : '', victim: c.id, vn: c.name, top: top() }, undefined, c.room);
  }
}
setInterval(function () { const now = Date.now(); clients.forEach(function (c) { if (now - c.last > IDLE_MS) { try { c.sock.destroy(); } catch (e) {} drop(c); } }); }, 10000);
setInterval(function () { if (clients.size) broadcast({ t: 'top', top: top(), n: inRoom(PVP_ROOM).length }, undefined, PVP_ROOM); }, 5000);
server.listen(PORT, function () { console.log('RanCraft PvP server listening on port ' + PORT); });
