const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: ["https://ruletka.top", "http://localhost:3000"],
  methods: ["GET", "POST"],
  credentials: true
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://ruletka.top", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
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

    // Проверяем, что пользователь не в списке ожидания
    if (waitingUsers.has(socket.id)) {
      log('User already in waiting list');
      return;
    }

    // Ищем партнера
    if (waitingUsers.size > 0) {
      log('Found waiting users:', waitingUsers.size);
      let partnerSocket = null;
      
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
        
        io.to(roomId).emit('chatStarted', { roomId });
      } else {
        log('No available partners, adding to waiting list:', socket.id);
        waitingUsers.add(socket.id);
      }
    } else {
      log('No waiting users, adding to waiting list:', socket.id);
      waitingUsers.add(socket.id);
    }
  });

  socket.on('sendSignal', ({ signal, to }) => {
    console.log('Signal sent from', socket.id, 'to', to);
    // Находим партнера через пару
    const pair = connectedPairs.get(socket.id);
    if (pair) {
      io.to(pair.partner).emit('receiveSignal', { signal, from: socket.id });
    }
  });

  socket.on('returnSignal', ({ signal, to }) => {
    console.log('Return signal from', socket.id, 'to', to);
    io.to(to).emit('receiveReturnSignal', { signal, from: socket.id });
  });

  socket.on('message', ({ roomId, message }) => {
    socket.to(roomId).emit('message', message);
  });

  socket.on('nextPartner', () => {
    const currentPair = connectedPairs.get(socket.id);
    if (currentPair) {
      const { partner, room } = currentPair;
      
      socket.leave(room);
      io.sockets.sockets.get(partner)?.leave(room);
      
      connectedPairs.delete(socket.id);
      connectedPairs.delete(partner);
      
      io.to(partner).emit('partnerLeft');
    }
    
    // Автоматически начинаем новый поиск
    socket.emit('searchingNewPartner');
    process.nextTick(() => {
      socket.emit('startSearch');
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
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