const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
      credentials: true,
    },
  });

  // Authenticate socket connections via JWT
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('_id name role');
      if (!user) return next(new Error('User not found'));

      socket.userId = user._id.toString();
      socket.userRole = user.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    // Join a personal room so we can target specific users
    socket.join(`user:${socket.userId}`);
    // Join a role-based room
    socket.join(`role:${socket.userRole}`);

    socket.on('disconnect', () => {
      // cleanup handled automatically
    });
  });

  return io;
}

function getIO() {
  return io;
}

/**
 * Emit a real-time event to specific users and/or roles.
 */
function emitToUsers({ event, data, recipientIds = [], recipientRoles = [], excludeUserId }) {
  if (!io) return;

  const rooms = [];
  recipientIds.forEach((id) => {
    const idStr = id.toString();
    if (!excludeUserId || idStr !== excludeUserId.toString()) {
      rooms.push(`user:${idStr}`);
    }
  });
  recipientRoles.forEach((role) => rooms.push(`role:${role}`));

  if (rooms.length === 0) return;

  if (excludeUserId && recipientRoles.length > 0) {
    // When broadcasting to roles but excluding a user, use except
    io.to(rooms).except(`user:${excludeUserId.toString()}`).emit(event, data);
  } else {
    io.to(rooms).emit(event, data);
  }
}

module.exports = { initSocket, getIO, emitToUsers };
