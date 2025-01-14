const express = require('express');
const https = require('https');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const isDevelopment = process.env.NODE_ENV !== 'production';

let httpsServer;
let io;

// Serve static files in production
app.use(express.static(path.join(__dirname, '../../rulet/build')));

// CORS configuration
const corsOptions = {
  origin: isDevelopment 
    ? ["http://localhost:3000"] 
    : ["https://ruletka.top", "https://www.ruletka.top", "wss://ruletka.top", "wss://www.ruletka.top"],
  methods: ["GET", "POST"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"]
};

app.use(cors(corsOptions));

if (isDevelopment) {
  // Development: Create HTTP server
  const httpServer = http.createServer(app);
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: corsOptions,
    transports: ['websocket'],
    pingTimeout: 60000,
    pingInterval: 25000,
    allowEIO3: true
  });
  
  httpServer.listen(5002, () => {
    console.log('Development HTTP Server running on port 5002');
  });
} else {
  // Production: Create HTTPS server with SSL
  console.log('Starting server in production mode...');
  
  try {
    const credentials = {
      key: fs.readFileSync('/etc/nginx/ssl/ruletka.top.key'),
      cert: fs.readFileSync('/etc/nginx/ssl/ruletka.top.crt'),
      ca: fs.readFileSync('/etc/nginx/ssl/ruletka.top.chain.crt')
    };
    console.log('SSL certificates loaded successfully');
    
    httpsServer = https.createServer(credentials, app);
    console.log('HTTPS server created');
    
    io = new Server(httpsServer, {
      path: '/socket.io',
      cors: corsOptions,
      transports: ['websocket'],
      pingTimeout: 60000,
      pingInterval: 25000,
      allowEIO3: true,
      cookie: {
        name: 'io',
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: true
      }
    });
    console.log('Socket.IO server initialized');

    httpsServer.listen(5002, () => {
      console.log('HTTPS Server running on port 5002');
    });
  } catch (error) {
    console.error('Error starting server:', error);
  }
}

// Handle production routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../rulet/build/index.html'));
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
  console.log('New client connected:', socket.id);
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

  socket.on('nextPartner', ({ roomId }) => {
    console.log('Next partner requested by:', socket.id);
    handleDisconnect(socket);
    
    // Автоматически начинаем новый поиск
    process.nextTick(() => {
      socket.emit('startSearch');
    });
  });

  socket.on('leaveRoom', ({ roomId }) => {
    console.log('Leave room requested by:', socket.id);
    handleDisconnect(socket);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    handleDisconnect(socket);
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