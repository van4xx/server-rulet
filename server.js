const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  credentials: true
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 30000,
  pingInterval: 10000
});

const waitingUsers = new Set();
const connectedPairs = new Map();
let onlineUsers = 0;

const debug = true;
const log = (...args) => {
  if (debug) console.log(...args);
};

io.on('connection', (socket) => {
  log('User connected:', socket.id);
  onlineUsers++;
  io.emit('updateOnlineCount', onlineUsers);

  socket.on('startSearch', () => {
    log('User started searching:', socket.id);
    
    // Если пользователь уже в паре, отключаем его
    const existingPair = connectedPairs.get(socket.id);
    if (existingPair) {
      log('User was in pair, disconnecting from previous partner');
      const { partner, room } = existingPair;
      socket.leave(room);
      io.sockets.sockets.get(partner)?.leave(room);
      connectedPairs.delete(socket.id);
      connectedPairs.delete(partner);
      io.to(partner).emit('partnerLeft');
    }

    // Удаляем из списка ожидания, если был там
    waitingUsers.delete(socket.id);

    // Проверяем активных пользователей в списке ожидания
    const activeWaitingUsers = Array.from(waitingUsers).filter(userId => {
      const userSocket = io.sockets.sockets.get(userId);
      return userSocket && userSocket.connected && userId !== socket.id;
    });

    log('Active waiting users:', activeWaitingUsers.length);

    if (activeWaitingUsers.length > 0) {
      // Берем случайного пользователя из списка ожидания
      const randomIndex = Math.floor(Math.random() * activeWaitingUsers.length);
      const partnerSocket = activeWaitingUsers[randomIndex];
      
      log('Connecting users:', socket.id, 'and', partnerSocket);
      waitingUsers.delete(partnerSocket);
      
      const roomId = `${socket.id}-${partnerSocket}`;
      socket.join(roomId);
      const partnerSocketObj = io.sockets.sockets.get(partnerSocket);
      
      if (partnerSocketObj && partnerSocketObj.connected) {
        partnerSocketObj.join(roomId);
        
        connectedPairs.set(socket.id, { partner: partnerSocket, room: roomId });
        connectedPairs.set(partnerSocket, { partner: socket.id, room: roomId });
        
        // Отправляем событие начала чата обоим участникам
        socket.emit('chatStarted', { roomId, isInitiator: true });
        io.to(partnerSocket).emit('chatStarted', { roomId, isInitiator: false });
        
        log('Users connected successfully in room:', roomId);
      } else {
        log('Partner socket not found or disconnected');
        socket.emit('searchingNewPartner');
        waitingUsers.add(socket.id);
      }
    } else {
      log('No available partners, adding to waiting list:', socket.id);
      waitingUsers.add(socket.id);
      socket.emit('waiting');
    }
  });

  // Обработка WebRTC сигналов
  socket.on('signal', ({ signal, roomId }) => {
    log('Signal received from', socket.id, 'for room', roomId);
    const pair = connectedPairs.get(socket.id);
    if (pair && pair.room === roomId) {
      const partnerSocket = io.sockets.sockets.get(pair.partner);
      if (partnerSocket && partnerSocket.connected) {
        log('Forwarding signal to partner:', pair.partner);
        io.to(pair.partner).emit('signal', { signal, from: socket.id });
      } else {
        log('Partner disconnected, ending chat');
        socket.emit('partnerLeft');
        connectedPairs.delete(socket.id);
        connectedPairs.delete(pair.partner);
      }
    } else {
      log('Invalid signal: no matching pair found');
    }
  });

  socket.on('disconnect', () => {
    log('User disconnected:', socket.id);
    onlineUsers--;
    io.emit('updateOnlineCount', onlineUsers);
    
    // Удаляем из списка ожидающих
    waitingUsers.delete(socket.id);
    
    // Уведомляем партнера, если был в паре
    const pair = connectedPairs.get(socket.id);
    if (pair) {
      const { partner, room } = pair;
      io.to(partner).emit('partnerLeft');
      connectedPairs.delete(socket.id);
      connectedPairs.delete(partner);
      
      // Добавляем партнера обратно в список ожидания
      const partnerSocket = io.sockets.sockets.get(partner);
      if (partnerSocket && partnerSocket.connected) {
        waitingUsers.add(partner);
        io.to(partner).emit('waiting');
      }
    }
  });
});

// Периодическая очистка "зависших" пользователей
setInterval(() => {
  const disconnectedUsers = new Set();
  
  // Проверяем все ожидающие сокеты
  for (const userId of waitingUsers) {
    const userSocket = io.sockets.sockets.get(userId);
    if (!userSocket || !userSocket.connected) {
      disconnectedUsers.add(userId);
    }
  }
  
  // Удаляем отключенных пользователей
  for (const userId of disconnectedUsers) {
    waitingUsers.delete(userId);
    log('Removed disconnected user:', userId);
  }
  
  // Пересчитываем онлайн
  const actualOnline = io.sockets.sockets.size;
  if (actualOnline !== onlineUsers) {
    onlineUsers = actualOnline;
    io.emit('updateOnlineCount', onlineUsers);
  }
  
  log('Current waiting users:', waitingUsers.size);
  log('Current connected pairs:', connectedPairs.size);
}, 5000);

const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 