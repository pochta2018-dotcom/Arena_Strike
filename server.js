// ARENA STRIKE — WebSocket сервер для Render.com
// Установка: npm install ws
// Запуск: node server.js (порт берётся из process.env.PORT)

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// HTTP сервер для health cdheck (Render требует)
// Проверка работоспособности HTTP-сервера (Render-сервер)
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: Object.keys(rooms).length, players: countPlayers() }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

// Комнаты: { code: { host: ws, guest: ws, createdAt: timestamp } }
const rooms = {};
// Карта ws -> код комнаты
const wsRooms = new Map();

function countPlayers() {
  let c = 0;
  for (const r of Object.values(rooms)) {
    if (r.host) c++;
    if (r.guest) c++;
  }
  return c;
}

function generateCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[code]);
  return code;
}

function cleanupRoom(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.host && room.host.readyState === 1) {
    room.host.send(JSON.stringify({ type: 'error', message: 'Комната закрыта' }));
  }
  if (room.guest && room.guest.readyState === 1) {
    room.guest.send(JSON.stringify({ type: 'error', message: 'Комната закрыта' }));
  }
  if (room.host) wsRooms.delete(room.host);
  if (room.guest) wsRooms.delete(room.guest);
  delete rooms[code];
  console.log(`[ROOM] ${code} удалена`);
}

wss.on('connection', (ws) => {
  console.log(`[WS] Новое подключение, всего: ${wss.clients.size}`);
  let lastPing = Date.now();

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch(e) { return; }

    switch (data.type) {
      case 'ping':
        lastPing = Date.now();
        ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
        break;

      case 'create_room':
        // Удаляем старую комнату этого ws, если есть
        const oldCode = wsRooms.get(ws);
        if (oldCode && rooms[oldCode]) {
          if (rooms[oldCode].host === ws) delete rooms[oldCode];
        }
        const code = generateCode();
        rooms[code] = { host: ws, guest: null, createdAt: Date.now() };
        wsRooms.set(ws, code);
        ws.send(JSON.stringify({ type: 'room_created', code }));
        console.log(`[ROOM] Создана комната ${code}`);
        break;

      case 'join_room':
        const room = rooms[data.code];
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
          return;
        }
        if (room.guest) {
          ws.send(JSON.stringify({ type: 'error', message: 'Комната уже заполнена' }));
          return;
        }
        room.guest = ws;
        wsRooms.set(ws, data.code);
        // Оповещаем хоста
        if (room.host && room.host.readyState === 1) {
          room.host.send(JSON.stringify({ type: 'guest_joined' }));
        }
        ws.send(JSON.stringify({ type: 'joined', code: data.code }));
        console.log(`[ROOM] Игрок подключился к комнате ${data.code}`);
        break;

      case 'game_state':
        // Хост -> клиент: полное состояние игры
        const gsRoom = wsRooms.get(ws);
        if (gsRoom && rooms[gsRoom] && rooms[gsRoom].host === ws) {
          if (rooms[gsRoom].guest && rooms[gsRoom].guest.readyState === 1) {
            rooms[gsRoom].guest.send(raw.toString());
          }
        }
        break;

      case 'input':
        // Клиент -> хост: inputs игрока 2
        const inRoom = wsRooms.get(ws);
        if (inRoom && rooms[inRoom] && rooms[inRoom].guest === ws) {
          if (rooms[inRoom].host && rooms[inRoom].host.readyState === 1) {
            rooms[inRoom].host.send(raw.toString());
          }
        }
        break;

      case 'leave_room':
        const lvCode = wsRooms.get(ws);
        if (lvCode) cleanupRoom(lvCode);
        break;

      default:
        // Пересылаем любой другой тип между игроками
        const defRoom = wsRooms.get(ws);
        if (defRoom && rooms[defRoom]) {
          const other = rooms[defRoom].host === ws ? rooms[defRoom].guest : rooms[defRoom].host;
          if (other && other.readyState === 1) {
            other.send(raw.toString());
          }
        }
    }
  });

  ws.on('close', () => {
    const code = wsRooms.get(ws);
    if (code) {
      const room = rooms[code];
      if (room) {
        if (room.host === ws) {
          // Хост вышел — закрываем комнату
          cleanupRoom(code);
        } else if (room.guest === ws) {
          // Гость вышел — оповещаем хоста
          room.guest = null;
          wsRooms.delete(ws);
          if (room.host && room.host.readyState === 1) {
            room.host.send(JSON.stringify({ type: 'guest_left' }));
          }
          console.log(`[ROOM] Гость покинул комнату ${code}`);
        }
      }
    }
    console.log(`[WS] Отключение, осталось: ${wss.clients.size}`);
  });

  ws.on('error', (e) => {
    console.error('[WS] Ошибка:', e.message);
  });
});

// Очистка неактивных комнат (старше 2 часов)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of Object.entries(rooms)) {
    if (now - room.createdAt > 2 * 60 * 60 * 1000) {
      cleanupRoom(code);
    }
    // Проверка активности хоста
    if (room.host && room.host.readyState > 1) {
      cleanupRoom(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});