const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();

// Serve static files in production
app.use(express.static(path.join(__dirname, '../ruletka/build')));

// CORS configuration
app.use(cors({
  origin: ["https://ruletka.top", "http://localhost:3000"],
  methods: ["GET", "POST"],
  credentials: true
}));

const server = http.createServer(app);

// Socket.IO configuration
const io = new Server(server, {
  path: '/socket.io',
  cors: {
    origin: ["https://ruletka.top", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["*"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true
});

// Handle production routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../ruletka/build/index.html'));
});

const waitingUsers = new Set();
const connectedPairs = new Map();
let onlineUsers = 0;

const debug = true;
const log = (...args) => {
  if (debug) console.log(...args);
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  onlineUsers++;
  io.emit('updateOnlineCount', onlineUsers);

  // Очередь ожидающих пользователей
  const waitingUsers = new Map();
  // Активные соединения
  const connectedPairs = new Map();
  // Состояния пользователей
  const userStates = new Map();

  socket.on('startSearch', () => {
    console.log('User started search:', socket.id);
    
    // Если пользователь уже в паре, разрываем предыдущее соединение
    const currentPair = connectedPairs.get(socket.id);
    if (currentPair) {
      handleDisconnect(socket.id);
    }

    // Добавляем пользователя в очередь ожидания
    waitingUsers.set(socket.id, {
      timestamp: Date.now(),
      preferences: socket.preferences || {}
    });

    // Пытаемся найти подходящего партнера
    findMatch(socket);
  });

  function findMatch(socket) {
    const currentUser = waitingUsers.get(socket.id);
    if (!currentUser) return;

    // Ищем подходящего партнера среди ожидающих
    for (const [partnerId, partnerData] of waitingUsers) {
      if (partnerId !== socket.id && isCompatible(currentUser, partnerData)) {
        // Создаем новую комнату
        const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Удаляем обоих пользователей из очереди ожидания
        waitingUsers.delete(socket.id);
        waitingUsers.delete(partnerId);

        // Добавляем пару в активные соединения
        connectedPairs.set(socket.id, { partner: partnerId, room: roomId });
        connectedPairs.set(partnerId, { partner: socket.id, room: roomId });

        // Присоединяем обоих к комнате
        socket.join(roomId);
        io.sockets.sockets.get(partnerId)?.join(roomId);

        // Уведомляем обоих пользователей
        io.to(roomId).emit('chatStarted', { roomId });
        
        // Устанавливаем состояние соединения
        userStates.set(socket.id, 'connected');
        userStates.set(partnerId, 'connected');

        return;
      }
    }

    // Если партнер не найден, отправляем статус ожидания
    socket.emit('waiting');
  }

  function isCompatible(user1, user2) {
    // Здесь можно добавить логику проверки совместимости пользователей
    // Например, по языку, региону, интересам и т.д.
    return true;
  }

  function handleDisconnect(userId) {
    const pair = connectedPairs.get(userId);
    if (pair) {
      const { partner, room } = pair;
      
      // Уведомляем партнера
      io.to(partner).emit('partnerLeft');
      
      // Очищаем комнату
      socket.leave(room);
      io.sockets.sockets.get(partner)?.leave(room);
      
      // Удаляем пару из активных соединений
      connectedPairs.delete(userId);
      connectedPairs.delete(partner);
      
      // Очищаем состояния
      userStates.delete(userId);
      userStates.delete(partner);
    }
    
    // Удаляем из очереди ожидания
    waitingUsers.delete(userId);
  }

  socket.on('nextPartner', ({ roomId }) => {
    handleDisconnect(socket.id);
    // Автоматически начинаем новый поиск
    process.nextTick(() => {
      socket.emit('startSearch');
    });
  });

  socket.on('leaveRoom', ({ roomId }) => {
    handleDisconnect(socket.id);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    handleDisconnect(socket.id);
    onlineUsers--;
    io.emit('updateOnlineCount', onlineUsers);
  });

  // Обработка сигналов WebRTC
  socket.on('signal', ({ signal, roomId }) => {
    const pair = connectedPairs.get(socket.id);
    if (pair && pair.room === roomId) {
      socket.to(roomId).emit('signal', { signal, from: socket.id });
    }
  });

  // Обработка сообщений чата
  socket.on('message', ({ roomId, message }) => {
    const pair = connectedPairs.get(socket.id);
    if (pair && pair.room === roomId) {
      socket.to(roomId).emit('message', { message });
    }
  });
});

// Периодическая очистка "зависших" пользователей
setInterval(() => {
  for (const userId of waitingUsers) {
    if (!io.sockets.sockets.get(userId)) {
      waitingUsers.delete(userId);
    }
  }
}, 10000);

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 