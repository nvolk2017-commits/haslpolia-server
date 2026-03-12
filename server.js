const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Хаслполия сервер работает!');
});

const wss = new WebSocket.Server({ server });

// rooms[code] = { host, players[], state, started }
const rooms = {};

function genCode() {
  return Math.random().toString(36).substr(2, 5).toUpperCase();
}

function broadcast(room, msg, excludeWs = null) {
  const str = JSON.stringify(msg);
  rooms[room]?.players.forEach(p => {
    if (p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(str);
    }
  });
}

function broadcastAll(room, msg) {
  broadcast(room, msg, null);
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getRoomInfo(code) {
  const room = rooms[code];
  if (!room) return null;
  return {
    code,
    started: room.started,
    players: room.players.map(p => ({ id: p.id, name: p.name, tok: p.tok, ready: p.ready }))
  };
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, data } = msg;

    // ── CREATE ROOM ──
    if (type === 'create') {
      const code = genCode();
      rooms[code] = {
        host: data.playerId,
        players: [],
        state: null,
        started: false
      };
      ws.roomCode = code;
      ws.playerId = data.playerId;
      rooms[code].players.push({ ws, id: data.playerId, name: data.name, tok: data.tok, ready: false });
      sendTo(ws, { type: 'created', data: { code, playerId: data.playerId } });
      console.log(`Room ${code} created by ${data.name}`);
    }

    // ── JOIN ROOM ──
    else if (type === 'join') {
      const room = rooms[data.code];
      if (!room) return sendTo(ws, { type: 'error', data: { msg: 'Комната не найдена' } });
      if (room.started) return sendTo(ws, { type: 'error', data: { msg: 'Игра уже началась' } });
      if (room.players.length >= 6) return sendTo(ws, { type: 'error', data: { msg: 'Комната заполнена' } });

      // Check duplicate name/tok
      const taken = room.players.find(p => p.tok === data.tok);
      if (taken) return sendTo(ws, { type: 'error', data: { msg: 'Эта фишка уже занята' } });

      ws.roomCode = data.code;
      ws.playerId = data.playerId;
      room.players.push({ ws, id: data.playerId, name: data.name, tok: data.tok, ready: false });

      sendTo(ws, { type: 'joined', data: getRoomInfo(data.code) });
      broadcast(data.code, { type: 'playerJoined', data: getRoomInfo(data.code) }, ws);
      console.log(`${data.name} joined room ${data.code}`);
    }

    // ── START GAME ──
    else if (type === 'start') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      if (room.host !== ws.playerId) return sendTo(ws, { type: 'error', data: { msg: 'Только хост может начать' } });
      if (room.players.length < 2) return sendTo(ws, { type: 'error', data: { msg: 'Нужно минимум 2 игрока' } });

      room.started = true;
      room.state = data.state; // initial game state from host

      broadcastAll(ws.roomCode, {
        type: 'gameStarted',
        data: { state: data.state }
      });
      console.log(`Room ${ws.roomCode} game started`);
    }

    // ── GAME ACTION (host sends updated state to all) ──
    else if (type === 'action') {
      const room = rooms[ws.roomCode];
      if (!room || !room.started) return;

      // Host is the source of truth — broadcasts new state to all others
      room.state = data.state;
      broadcast(ws.roomCode, {
        type: 'stateUpdate',
        data: { state: data.state, action: data.action }
      }, ws);
    }

    // ── PLAYER INPUT (non-host sends action to host) ──
    else if (type === 'playerAction') {
      const room = rooms[ws.roomCode];
      if (!room || !room.started) return;

      // Forward to host
      const hostPlayer = room.players.find(p => p.id === room.host);
      if (hostPlayer) {
        sendTo(hostPlayer.ws, {
          type: 'playerAction',
          data: { playerId: ws.playerId, action: data.action, payload: data.payload }
        });
      }
    }

    // ── GET ROOM INFO ──
    else if (type === 'getRoomInfo') {
      const info = getRoomInfo(ws.roomCode);
      if (info) sendTo(ws, { type: 'roomInfo', data: info });
    }

    // ── LEAVE ──
    else if (type === 'leave') {
      handleLeave(ws);
    }
  });

  ws.on('close', () => handleLeave(ws));
});

function handleLeave(ws) {
  const code = ws.roomCode;
  if (!code || !rooms[code]) return;

  const room = rooms[code];
  const idx = room.players.findIndex(p => p.id === ws.playerId);
  if (idx !== -1) {
    const name = room.players[idx].name;
    room.players.splice(idx, 1);
    console.log(`${name} left room ${code}`);

    if (room.players.length === 0) {
      delete rooms[code];
      console.log(`Room ${code} deleted`);
    } else {
      // If host left, assign new host
      if (room.host === ws.playerId) {
        room.host = room.players[0].id;
      }
      broadcastAll(code, {
        type: 'playerLeft',
        data: { playerId: ws.playerId, ...getRoomInfo(code) }
      });
    }
  }
}

server.listen(PORT, () => {
  console.log(`Хаслполия сервер запущен на порту ${PORT}`);
});
