const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
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

    // Ищем партнера
    if (waitingUsers.size > 0) {
      log('Found waiting users:', waitingUsers.size);
      let partnerSocket = null;
      
      // Находим первого доступного партнера
      for (const waitingUser of waitingUsers) {
        if (waitingUser !== socket.id && io.sockets.sockets.get(waitingUser)) {
          partnerSocket = waitingUser;
          break;
        }
      }

      if (partnerSocket) {
        log('Connecting users:', socket.id, 'and', partnerSocket);
        waitingUsers.delete(partnerSocket);
        
        const roomId = `${socket.id}-${partnerSocket}`;
        socket.join(roomId);
        io.sockets.sockets.get(partnerSocket).join(roomId);
        
        connectedPairs.set(socket.id, { partner: partnerSocket, room: roomId });
        connectedPairs.set(partnerSocket, { partner: socket.id, room: roomId });
        
        // Отправляем событие начала чата обоим участникам
        socket.emit('chatStarted', { roomId, isInitiator: true });
        io.to(partnerSocket).emit('chatStarted', { roomId, isInitiator: false });
      } else {
        log('No available partners, adding to waiting list:', socket.id);
        waitingUsers.add(socket.id);
        socket.emit('waiting');
      }
    } else {
      log('No waiting users, adding to waiting list:', socket.id);
      waitingUsers.add(socket.id);
      socket.emit('waiting');
    }
  });

  // Обработка WebRTC сигналов
  socket.on('signal', ({ signal, roomId }) => {
    log('Signal received from', socket.id, 'for room', roomId);
    const pair = connectedPairs.get(socket.id);
    if (pair && pair.room === roomId) {
      log('Forwarding signal to partner:', pair.partner);
      io.to(pair.partner).emit('signal', { signal, from: socket.id });
    } else {
      log('Invalid signal: no matching pair found');
    }
  });

  socket.on('message', ({ roomId, message }) => {
    log('Message received from', socket.id, 'for room', roomId);
    const pair = connectedPairs.get(socket.id);
    if (pair && pair.room === roomId) {
      log('Forwarding message to partner:', pair.partner);
      socket.to(roomId).emit('message', { 
        message,
        from: socket.id 
      });
    } else {
      log('Invalid message: no matching pair found');
    }
  });

  socket.on('nextPartner', () => {
    const currentPair = connectedPairs.get(socket.id);
    if (currentPair) {
      const { partner, room } = currentPair;
      
      // Отключаем текущую пару
      socket.leave(room);
      io.sockets.sockets.get(partner)?.leave(room);
      connectedPairs.delete(socket.id);
      connectedPairs.delete(partner);
      io.to(partner).emit('partnerLeft');
      
      // Запускаем новый поиск для обоих пользователей
      socket.emit('searchingNewPartner');
      io.to(partner).emit('searchingNewPartner');
      
      // Добавляем обоих в список ожидания
      process.nextTick(() => {
        if (io.sockets.sockets.get(partner)) {
          waitingUsers.add(partner);
          io.to(partner).emit('waiting');
        }
        socket.emit('startSearch');
      });
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
      if (io.sockets.sockets.get(partner)) {
        waitingUsers.add(partner);
        io.to(partner).emit('waiting');
      }
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

const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 