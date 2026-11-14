// Realm of Moviex - simple multiplayer relay server (plain Node.js + ws). Works in Termux, on a PC, or on Render.
// One room = one map. Clients connect to  ws://HOST:PORT/ws/<room>  and send {t:"state",...} ~10x per second.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const rooms = new Map(); // roomName -> Map(id -> {ws, p})
let nextId = 1;

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/index")) {
    fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
      if (err) { res.writeHead(500); res.end("index.html missing"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(data);
    });
  } else { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Moviex server is running."); }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const m = /^\/ws\/([\w-]{1,24})/.exec(req.url || "");
  if (!m) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, m[1]));
});

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const [id, c] of room) if (id !== exceptId && c.ws.readyState === 1) c.ws.send(s);
}

wss.on("connection", (ws, roomName) => {
  if (!rooms.has(roomName)) rooms.set(roomName, new Map());
  const room = rooms.get(roomName), id = "p" + (nextId++);
  room.set(id, { ws, p: null });
  const others = {}; for (const [oid, c] of room) if (oid !== id && c.p) others[oid] = c.p;
  send(ws, { t: "welcome", id, players: others });

  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    const me = room.get(id); if (!me) return;
    if (m.t === "state") {
      const p = {
        name: String(m.name || "Player").slice(0, 16), lvl: Math.max(1, Math.min(100, m.lvl | 0)),
        x: Number(m.x) || 0, z: Number(m.z) || 0, ry: Number(m.ry) || 0,
        hp: Number(m.hp) || 0, maxHp: Number(m.maxHp) || 1, anim: String(m.anim || "").slice(0, 12),
      };
      const isNew = !me.p; me.p = p;
      broadcast(room, Object.assign({ t: isNew ? "join" : "s", id }, p), id);
    } else if (m.t === "chat") {
      broadcast(room, { t: "chat", id, name: me.p ? me.p.name : "?", text: String(m.text || "").slice(0, 120) });
    }
  });
  ws.on("close", () => { room.delete(id); broadcast(room, { t: "left", id }); if (!room.size) rooms.delete(roomName); });
  ws.on("error", () => {});
});

server.listen(PORT, "0.0.0.0", () => console.log("Moviex server on port " + PORT + "  ->  open http://localhost:" + PORT));
