
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080, MAX_PLAYERS = 40, MAX_TOTAL = 400, GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HIT = 2000000, HITS_PER_SEC = 15, STATE_PER_SEC = 25, IDLE_MS = 45000, ARENA_R = 68, WORLD_LIM = 600, PVP_ROOM = 'pvp';
const clients = new Map(); let nextId = 1;

const server = http.createServer(function (req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('RanCraft PvP server OK - players online: ' + clients.size + '\n');
});


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
const roomDead = new Map();   // room -> Map(mobId -> respawn-at ms): shared mob kills so everyone in a map sees the same mobs
const roomLoot = new Map();   // room -> Map(lid -> {lid,it,x,z,at}) items dropped by dead players (first come, first served)
let lootSeq = 0; const LOOT_MS = 180000;
function lootList(room) { const m = roomLoot.get(room), now = Date.now(), out = []; if (m) m.forEach(function (l, k) { if (now - l.at > LOOT_MS) m.delete(k); else out.push({ lid: l.lid, it: l.it, x: l.x, z: l.z }); }); return out; }
function lootItem(it) { if (!it || typeof it.b !== 'string') return null; const r = (Array.isArray(it.r) ? it.r : []).slice(0, 12).filter(function (q) { return Array.isArray(q) && /^[a-z]{2,8}$/.test(String(q[0])) && isFinite(q[1]); }).map(function (q) { return [String(q[0]), +q[1]]; }); return { b: it.b.replace(/[^A-Za-z0-9_~-]/g, '').slice(0, 40), r: r, u: Math.max(0, Math.min(200, it.u | 0)), s: Math.max(0, Math.min(5, it.s | 0)), m: Math.max(1, Math.min(1024, it.m | 0)) }; }
setInterval(function () { const now = Date.now(); roomLoot.forEach(function (m, room) { m.forEach(function (l, k) { if (now - l.at > LOOT_MS) { m.delete(k); broadcast({ t: 'lx', lid: k }, undefined, room); } }); }); }, 15000);
function deadList(room) { const d = roomDead.get(room), now = Date.now(), out = []; if (d) d.forEach(function (at, k) { if (at <= now) d.delete(k); else out.push([k, Math.round((at - now) / 1000)]); }); return out; }
function inRoom(room) { return Array.from(clients.values()).filter(function (c) { return c.joined && c.open && c.room === room; }); }
function roomOf(m) { const r = String((m && m.map) || PVP_ROOM).replace(/[^A-Za-z0-9_]/g, '').slice(0, 24); return r || PVP_ROOM; }
function isArena(room) { return /^pvp[2-5]?$/.test(room); }
function lim(c) { return isArena(c.room) ? ARENA_R : WORLD_LIM; }
function top(room) { return inRoom(room || PVP_ROOM).sort(function (a, b) { return b.kills - a.kills || a.deaths - b.deaths; }).slice(0, 5).map(function (c) { return [c.name, c.kills, c.deaths]; }); }
function small(o) { try { const s = JSON.stringify(o); return s.length < 3000 ? o : {}; } catch (e) { return {}; } }

/* ====================== PARTY + GUILD ====================== */
const PARTY_MAX = 5, GUILD_MAX = 30, GFILE = path.join(process.env.DATA_DIR || __dirname, 'guilds.json');
const parties = new Map(); let nextParty = 1;
const guilds = new Map(), userGuild = new Map(); let nextGuild = 1;
try { const j = JSON.parse(fs.readFileSync(GFILE, 'utf8')); (j.guilds || []).forEach(function (g) { g.members = new Map(Object.entries(g.members || {})); guilds.set(g.id, g); g.members.forEach(function (m, u) { userGuild.set(u, g.id); }); nextGuild = Math.max(nextGuild, g.id + 1); }); } catch (e) {}
/* ---- persistence: Firebase Realtime Database (REST) + local file fallback ----
   env FIREBASE_DB_URL (default = the game's database), FIREBASE_SECRET (database secret, needed if your rules are not public for /moviex_guilds) */
const FB_URL = String(process.env.FIREBASE_DB_URL || 'https://html-codes-encrytper.firebaseio.com').replace(/\/+$/, ''), FB_SECRET = process.env.FIREBASE_SECRET || 'c7zcqlxVa6dsEJldwExNgR9T0hWZIhBvlKNZxxh2', FB_PATH = '/moviex_guilds.json';
let fbLoaded = false, saveTimer = null, fbDirty = false;
function fbReq(method, body, cb, pth) {
  let u; try { u = new URL(FB_URL + (pth || FB_PATH) + (FB_SECRET ? '?auth=' + encodeURIComponent(FB_SECRET) : '')); } catch (e) { return cb(e); }
  const mod = u.protocol === 'http:' ? http : require('https'), data = body === undefined ? null : JSON.stringify(body);
  const rq = mod.request(u, { method: method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, timeout: 10000 }, function (rs) {
    let buf = ''; rs.on('data', function (d) { buf += d; }); rs.on('end', function () { if (rs.statusCode >= 200 && rs.statusCode < 300) { try { cb(null, buf ? JSON.parse(buf) : null); } catch (e) { cb(e); } } else cb(new Error('HTTP ' + rs.statusCode + ' ' + buf.slice(0, 120))); });
  });
  rq.on('error', cb); rq.on('timeout', function () { rq.destroy(new Error('timeout')); }); if (data) rq.write(data); rq.end();
}
function packGuilds() { const out = {}; guilds.forEach(function (g) { out[g.id] = Object.assign({}, g, { members: Object.fromEntries(g.members) }); }); return out; }
function loadFromObj(obj) { Object.values(obj || {}).forEach(function (g) { if (!g || !g.id || guilds.has(g.id)) return; g.members = new Map(Object.entries(g.members || {})); if (!g.members.size) return; guilds.set(g.id, g); g.members.forEach(function (mm, u) { userGuild.set(u, g.id); }); nextGuild = Math.max(nextGuild, g.id + 1); }); }
function fbLoad() {
  fbReq('GET', undefined, function (err, data) {
    if (err) { console.log('[guilds] Firebase load failed (' + err.message + '), retrying in 30s'); setTimeout(fbLoad, 30000); return; }
    loadFromObj(data); fbLoaded = true; console.log('[guilds] loaded from Firebase: ' + guilds.size + ' guild(s)'); if (fbDirty) saveGuilds();
  });
}
function saveGuilds() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try { fs.writeFileSync(GFILE, JSON.stringify({ guilds: Array.from(guilds.values()).map(function (g) { return Object.assign({}, g, { members: Object.fromEntries(g.members) }); }) })); } catch (e) {}
    if (!fbLoaded) { fbDirty = true; return; }
    fbReq('PUT', packGuilds(), function (err) { if (err) console.log('[guilds] Firebase save failed: ' + err.message); });
  }, 800);
}
fbLoad();
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
/* ---- guild ---- */
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

/* ====================== MARKET PLACE ====================== */
const MK_PATH = '/moviex_market.json', MK_MAX_USER = 20, MK_MAX = 4000, MK_SLOTS = ['weapon', 'helmet', 'armor', 'pants', 'gloves', 'wings', 'necklace', 'ringL', 'ringR'];
const market = new Map(), mkEarn = new Map(); let nextMk = 1, mkLoaded = false, mkDirty = false, mkTimer = null;
function mkPack() { const l = {}, e = {}; market.forEach(function (x, k) { l[k] = x; }); mkEarn.forEach(function (x, k) { if (x.g || x.d) e[k] = x; }); return { listings: l, earn: e, next: nextMk }; }
function mkFromObj(o) { o = o || {}; Object.values(o.listings || {}).forEach(function (x) { if (x && x.id && !market.has(x.id)) market.set(x.id, x); }); Object.keys(o.earn || {}).forEach(function (u) { if (!mkEarn.has(u)) mkEarn.set(u, { g: o.earn[u].g | 0, d: o.earn[u].d | 0 }); }); nextMk = Math.max(nextMk, o.next | 0, 1); }
try { mkFromObj(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR || __dirname, 'market.json'), 'utf8'))); } catch (e) {}
function mkLoad() { fbReq('GET', undefined, function (err, data) { if (err) { console.log('[market] Firebase load failed (' + err.message + '), retrying in 30s'); setTimeout(mkLoad, 30000); return; } mkFromObj(data); mkLoaded = true; console.log('[market] loaded: ' + market.size + ' listing(s)'); if (mkDirty) mkSave(); }, MK_PATH); }
function mkSave() {
  clearTimeout(mkTimer);
  mkTimer = setTimeout(function () {
    try { fs.writeFileSync(path.join(process.env.DATA_DIR || __dirname, 'market.json'), JSON.stringify(mkPack())); } catch (e) {}
    if (!mkLoaded) { mkDirty = true; return; }
    fbReq('PUT', mkPack(), function (err) { if (err) console.log('[market] Firebase save failed: ' + err.message); }, MK_PATH);
  }, 600);
}
mkLoad();
function mkView(x) { return { id: x.id, sn: x.sn, slot: x.slot, it: x.it, p: x.p, cur: x.cur }; }
function mkMine(c) { const l = []; market.forEach(function (x) { if (x.uid === c.uid) l.push(mkView(x)); }); const e = mkEarn.get(c.uid) || { g: 0, d: 0 }; send(c, { t: 'mxmine', l: l, e: { g: e.g, d: e.d } }); }
function mkHandle(c, m) {
  const t = m.t; if (!c.uid) { send(c, { t: 'mxo', ok: 0, msg: 'Market needs a logged-in account id.' }); return true; }
  if (!rate(c.mxr || (c.mxr = []), 8)) return true;
  if (t === 'mxl') {
    const cur = m.cur === 'd' ? 'd' : 'g', slot = String(m.slot || ''), out = [];
    market.forEach(function (x) { if (x.cur === cur && x.slot === slot) out.push(x); });
    out.sort(function (a, b) { return m.sort === 'lo' ? a.p - b.p : b.p - a.p; });
    send(c, { t: 'mxl', cur: cur, slot: slot, n: out.length, l: out.slice(0, 60).map(mkView) }); return true;
  }
  if (t === 'mxs') {
    const it = lootItem(m.it), cur = m.cur === 'd' ? 'd' : 'g', p = Math.floor(+m.p), slot = String(m.slot || '');
    if (!it || MK_SLOTS.indexOf(slot) < 0 || !(p >= 1) || p > (cur === 'd' ? 1000000 : 2000000000)) { send(c, { t: 'mxo', ok: 0, msg: 'Invalid listing.' }); return true; }
    let mine = 0; market.forEach(function (x) { if (x.uid === c.uid) mine++; });
    if (mine >= MK_MAX_USER) { send(c, { t: 'mxo', ok: 0, msg: 'You can list at most ' + MK_MAX_USER + ' items.' }); return true; }
    if (market.size >= MK_MAX) { send(c, { t: 'mxo', ok: 0, msg: 'The market is full.' }); return true; }
    const x = { id: 'M' + (nextMk++), uid: c.uid, sn: c.name, slot: slot, it: it, p: p, cur: cur, at: Date.now() };
    market.set(x.id, x); mkSave(); send(c, { t: 'mxo', ok: 1, id: x.id, msg: 'Item listed.', tok: String(m.tok || '') }); return true;
  }
  if (t === 'mxb') {
    const x = market.get(String(m.id));
    if (!x) { send(c, { t: 'mxbk', ok: 0, msg: 'That item was already sold or removed.' }); return true; }
    if (x.uid === c.uid) { send(c, { t: 'mxbk', ok: 0, msg: 'You cannot buy your own item.' }); return true; }
    market.delete(x.id); const e = mkEarn.get(x.uid) || { g: 0, d: 0 }; e[x.cur] += x.p; mkEarn.set(x.uid, e); mkSave();
    send(c, { t: 'mxbk', ok: 1, it: x.it, p: x.p, cur: x.cur, id: x.id, slot: x.slot, sn: x.sn });
    clients.forEach(function (o) { if (o.uid === x.uid && o.open && o.joined) send(o, { t: 'mxe', msg: c.name + ' bought your item for ' + x.p + (x.cur === 'd' ? ' diamonds' : ' gold') + '. Collect it at the Market Place.' }); });
    return true;
  }
  if (t === 'mxc') {
    const x = market.get(String(m.id)); if (!x || x.uid !== c.uid) { send(c, { t: 'mxcx', ok: 0 }); return true; }
    market.delete(x.id); mkSave(); send(c, { t: 'mxcx', ok: 1, it: x.it, id: x.id }); return true;
  }
  if (t === 'mxm') { mkMine(c); return true; }
  if (t === 'mxe') { const e = mkEarn.get(c.uid); if (!e || (!e.g && !e.d)) { send(c, { t: 'mxcl', g: 0, d: 0 }); return true; } const g = e.g, d = e.d; e.g = 0; e.d = 0; mkSave(); send(c, { t: 'mxcl', g: g, d: d }); return true; }
  return false;
}
function social(c, m) {
  const t = m.t;
  if (t.length === 3 && t.indexOf('mx') === 0) return mkHandle(c, m);
  if (t === 'pi' || t === 'pn') {                                 // invite to party (by id or by name)
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
    const base = num(m.x, 0, 5e6, 0); if (base <= 0) return true;
    const near = partyMembers(pa).filter(function (x) { return x === c || (x.room === c.room && (c.room.indexOf('x_') === 0 || Math.hypot(x.x - c.x, x.z - c.z) <= 80)); });
    const share = Math.floor(base / near.length); near.forEach(function (x) { send(x, { t: 'px', x: share, n: near.length }); });
    return true;
  }
  if (t === 'ch') {                                               // chat: world / map / whisper (guild chat is 'gc')
    if (!rate(c.chr || (c.chr = []), 2)) { say(c, 'You are chatting too fast.'); return true; }
    const msg = clean(m.msg, 120); if (!msg) return true; const ch = m.c;
    if (ch === 'world') { if (Date.now() - (c.lastWorld || 0) < 3000) { say(c, 'World chat cooldown: 3 seconds.'); return true; } c.lastWorld = Date.now(); const o = { t: 'ch', c: 'world', n: c.name, msg: msg }; clients.forEach(function (x) { if (x.joined && x.open) send(x, o); }); }
    else if (ch === 'map') { const o = { t: 'ch', c: 'map', n: c.name, msg: msg }; clients.forEach(function (x) { if (x.joined && x.open && x.room === c.room) send(x, o); }); }
    else if (ch === 'priv') {
      const nm = clean(m.to, 20).toLowerCase(); let v = null; clients.forEach(function (x) { if (x.joined && x.open && x.name.toLowerCase() === nm) v = x; });
      if (!v) { say(c, 'Player "' + clean(m.to, 20) + '" is not online.'); return true; }
      send(v, { t: 'ch', c: 'priv', n: c.name, msg: msg }); send(c, { t: 'ch', c: 'priv', n: c.name, to: v.name, msg: msg, me: 1 });
    }
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
  if ((m.t === 'join' && !c.joined) || (m.t === 'map' && c.joined)) {   // join a map room (or switch rooms when the player travels)
    const room = roomOf(m), was = c.joined ? c.room : null;
    if (was === room) { if (c.joined) send(c, { t: 'w', v: 7, loot: lootList(room), dead: deadList(room), id: c.id, x: c.x, z: c.z, players: inRoom(room).filter(function (x) { return x !== c; }).map(pub), top: top(room) }); return; }   // same map reloaded: resend who is here
    if (inRoom(room).filter(function (x) { return x !== c; }).length >= MAX_PLAYERS) { send(c, { t: 'full' }); if (!c.joined) c.sock.end(); return; }
    if (was !== null) broadcast({ t: 'l', id: c.id }, c, was);
    c.room = room;
    c.name = String(m.name || c.name || 'Player').replace(/[^A-Za-z0-9]/g, '').slice(0, 14) || ('Player' + c.id); c.lvl = num(m.lvl, 1, 150, 1) | 0;
    if (m.uid) c.uid = String(m.uid).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 64);
    c.look = small(m.look); c.eq = small(m.eq); c.cw = small(m.cw); c.mh = num(m.mh, 1, 1e9, 100); c.hp = c.mh;
    const a = Math.random() * Math.PI * 2, r = isArena(room) ? 14 + Math.random() * 38 : 4 + Math.random() * 10; c.x = Math.cos(a) * r; c.z = Math.sin(a) * r; c.joined = true;
    send(c, { t: 'w', v: 7, loot: lootList(room), dead: deadList(room), id: c.id, x: c.x, z: c.z, players: inRoom(room).filter(function (x) { return x !== c; }).map(pub), top: top(room) });
    broadcast({ t: 'j', p: pub(c) }, c, room);
    try { socialJoined(c, was === null); } catch (e) {} return;
  }
  if (!c.joined) return;
  if (m.t === 'ld') {                                             // a dead player drops an item
    if (!c.joined || c.room.indexOf('x_') === 0 || !rate(c.ldr || (c.ldr = []), 0.5)) return;
    const it = lootItem(m.it); if (!it) return; const lid = 'L' + (++lootSeq);
    const l = { lid: lid, it: it, x: num(m.x, -lim(c), lim(c), 0), z: num(m.z, -lim(c), lim(c), 0), at: Date.now() };
    if (!roomLoot.has(c.room)) roomLoot.set(c.room, new Map()); roomLoot.get(c.room).set(lid, l);
    broadcast({ t: 'ld', l: { lid: lid, it: it, x: l.x, z: l.z } }, undefined, c.room); return;
  }
  if (m.t === 'lp') {                                             // pick up: first request wins
    const rl = roomLoot.get(c.room), l = rl && rl.get(String(m.lid)); if (!l || !c.joined || !rate(c.lpr || (c.lpr = []), 5)) return;
    rl.delete(l.lid); send(c, { t: 'lg', it: l.it }); broadcast({ t: 'lx', lid: l.lid }, undefined, c.room); return;
  }
  if (m.t === 'dq' || m.t === 'da' || m.t === 'dn' || m.t === 'dx') {          // duel messages: relayed to the other player in the same room
    if (!c.joined || c.room.indexOf('x_') === 0 || !rate(c.dur || (c.dur = []), 6)) return;
    const o = clients.get(m.to | 0); if (!o || !o.joined || o.room !== c.room || o === c) return;
    send(o, { t: m.t, from: c.id, fn: c.name, cx: +m.cx || 0, cz: +m.cz || 0, r: m.r === 'lost' ? 'lost' : 'draw' }); return;
  }
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
  } else if (m.t === 'h') {                                       // attacker -> victim (damage before the victim's defence)
    const v = clients.get(m.to | 0); if (!v || !v.joined || v === c || v.room !== c.room) return;   // PK works in every map room (the client checks safe zones / PK mode)
    if (!rate(c.hits, HITS_PER_SEC)) return;
    send(v, { t: 'h', from: c.id, n: c.name, d: Math.round(num(m.d, 1, MAX_HIT, 1)), c: m.c ? 1 : 0 });
  } else if (m.t === 'k') {                                       // victim reports its own death
    if (c.deadAt && Date.now() - c.deadAt < 3000) return; c.deadAt = Date.now(); c.deaths++;
    const k = clients.get(m.by | 0); if (k && k !== c && k.joined) k.kills++;
    broadcast({ t: 'k', killer: k ? k.id : 0, kn: k ? k.name : '', victim: c.id, vn: c.name, top: top(c.room) }, undefined, c.room);
  }
}
setInterval(function () { const now = Date.now(); clients.forEach(function (c) { if (now - c.last > IDLE_MS) { try { c.sock.destroy(); } catch (e) {} drop(c); } }); }, 10000);
setInterval(function () { if (clients.size) ['pvp', 'pvp2', 'pvp3', 'pvp4', 'pvp5'].forEach(function (r) { if (inRoom(r).length) broadcast({ t: 'top', top: top(r), n: inRoom(r).length }, undefined, r); }); }, 5000);
server.listen(PORT, function () { console.log('RanCraft PvP server listening on port ' + PORT); });
