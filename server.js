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

// Глобальные переменные для отслеживания пользователей
const waitingUsers = new Map();
const connectedPairs = new Map();
const userStates = new Map();
let onlineUsers = 0;

function findMatch(socket) {
  console.log('Finding match for:', socket.id);
  console.log('Waiting users:', Array.from(waitingUsers.keys()));

  // Ищем подходящего партнера среди ожидающих
  for (const [partnerId, partnerData] of waitingUsers) {
    if (partnerId !== socket.id && io.sockets.sockets.get(partnerId)) {
      // Создаем новую комнату
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      console.log(`Creating room ${roomId} for users ${socket.id} and ${partnerId}`);
      
      // Удаляем обоих пользователей из очереди ожидания
      waitingUsers.delete(socket.id);
      waitingUsers.delete(partnerId);

      // Добавляем пару в активные соединения
      connectedPairs.set(socket.id, { partner: partnerId, room: roomId });
      connectedPairs.set(partnerId, { partner: socket.id, room: roomId });

      // Присоединяем обоих к комнате
      socket.join(roomId);
      io.sockets.sockets.get(partnerId)?.join(roomId);

      console.log('Match found:', socket.id, 'with', partnerId, 'in room', roomId);

      // Уведомляем обоих пользователей
      io.to(roomId).emit('chatStarted', { roomId });
      
      // Устанавливаем состояние соединения
      userStates.set(socket.id, 'connected');
      userStates.set(partnerId, 'connected');

      return true;
    }
  }

  return false;
}

function handleDisconnect(socket) {
  console.log('Handling disconnect for:', socket.id);
  
  // Удаляем из списка ожидающих
  if (waitingUsers.has(socket.id)) {
    waitingUsers.delete(socket.id);
    console.log('Removed from waiting list:', socket.id);
  }

  // Обрабатываем активное соединение
  const pair = connectedPairs.get(socket.id);
  if (pair) {
    const { partner, room } = pair;
    console.log('Found active pair:', socket.id, 'with', partner, 'in room', room);
    
    // Уведомляем партнера
    io.to(partner).emit('partnerLeft');
    
    // Очищаем комнату
    socket.leave(room);
    const partnerSocket = io.sockets.sockets.get(partner);
    if (partnerSocket) {
      partnerSocket.leave(room);
    }
    
    // Удаляем пару из активных соединений
    connectedPairs.delete(socket.id);
    connectedPairs.delete(partner);
    
    // Очищаем состояния
    userStates.delete(socket.id);
    userStates.delete(partner);
    
    console.log('Disconnected pair cleaned up');
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  onlineUsers++;
  io.emit('updateOnlineCount', onlineUsers);

  socket.on('startSearch', () => {
    console.log('Search started by:', socket.id);
    
    // Сначала отключаем от предыдущего чата, если есть
    handleDisconnect(socket);
    
    // Добавляем в список ожидания
    waitingUsers.set(socket.id, {
      timestamp: Date.now(),
      preferences: socket.preferences || {}
    });
    
    console.log('Added to waiting list:', socket.id);
    console.log('Current waiting users:', Array.from(waitingUsers.keys()));

    // Пытаемся найти партнера
    if (!findMatch(socket)) {
      console.log('No match found, user waiting:', socket.id);
      socket.emit('waiting');
    }
  });

  // Обработка сигналов WebRTC
  socket.on('signal', ({ signal, roomId }) => {
    console.log(`Received signal from ${socket.id} for room ${roomId}`);
    const pair = connectedPairs.get(socket.id);
    if (pair && pair.room === roomId) {
      console.log(`Forwarding signal to partner in room ${roomId}`);
      socket.to(roomId).emit('signal', { signal, from: socket.id });
    } else {
      console.log(`Invalid room or pair for signal: ${roomId}`);
    }
  });

  socket.on('nextPartner', ({ roomId }) => {
    console.log('Next partner requested by:', socket.id);
    handleDisconnect(socket);
    
    // Автоматически начинаем новый поиск
    process.nextTick(() => {
      console.log('Starting new search for:', socket.id);
      socket.emit('startSearch');
    });
  });

  socket.on('leaveRoom', ({ roomId }) => {
    console.log('Leave room requested by:', socket.id);
    handleDisconnect(socket);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    handleDisconnect(socket);
    onlineUsers--;
    io.emit('updateOnlineCount', onlineUsers);
  });

  // Обработка сообщений чата
  socket.on('message', ({ roomId, message }) => {
    console.log(`Message from ${socket.id} in room ${roomId}`);
    const pair = connectedPairs.get(socket.id);
    if (pair && pair.room === roomId) {
      socket.to(roomId).emit('message', { message });
    }
  });
});

// Периодическая очистка неактивных пользователей
setInterval(() => {
  console.log('Cleaning inactive users...');
  console.log('Before cleanup - Waiting users:', Array.from(waitingUsers.keys()));
  
  for (const [userId, userData] of waitingUsers) {
    // Проверяем, существует ли еще сокет
    if (!io.sockets.sockets.get(userId)) {
      console.log('Removing inactive user:', userId);
      waitingUsers.delete(userId);
    }
    // Проверяем время ожидания (более 5 минут)
    else if (Date.now() - userData.timestamp > 5 * 60 * 1000) {
      console.log('Removing user due to timeout:', userId);
      waitingUsers.delete(userId);
      const socket = io.sockets.sockets.get(userId);
      if (socket) {
        socket.emit('searchTimeout');
      }
    }
  }
  
  console.log('After cleanup - Waiting users:', Array.from(waitingUsers.keys()));
}, 30000);

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 