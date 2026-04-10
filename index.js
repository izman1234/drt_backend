const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('./database');
const { JWT_SECRET, PORT, DUAL_PROTOCOL, SERVER_NAME, SERVER_ICON, BASE_DIR, WHITELIST } = require('./config');
const { getTlsCredentials } = require('./tls');
const log = require('./logger');
const serverConsole = require('./console');

// Set console window title to server name
process.title = SERVER_NAME;

// ── Disable Windows QuickEdit mode ────────────────────────────────────
// When QuickEdit is enabled, clicking the console window freezes the
// process (title changes to "Select …") until Enter is pressed.
// Calling setRawMode(false) resets the console mode to
// ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT | ENABLE_PROCESSED_INPUT (0x07)
// via libuv's SetConsoleMode — this does NOT include
// ENABLE_QUICK_EDIT_MODE (0x40), so QuickEdit is cleared.  Once
// readline starts it switches to raw mode (0x04) which also excludes
// QuickEdit, keeping it disabled for the lifetime of the process.
if (process.platform === 'win32' && process.stdin.isTTY) {
  try { process.stdin.setRawMode(false); } catch (_) {}
}

// Import routes
const identityRoutes = require('./routes/identity');
const userRoutes = require('./routes/users');
const channelRoutes = require('./routes/channels');
const messageRoutes = require('./routes/messages');
const reactionRoutes = require('./routes/reactions');
const gifRoutes = require('./routes/gifs');

const app = express();

// Server and socket.io will be initialized in startServer()
let server;       // the primary server that listens on PORT
let httpServer;   // HTTP handler (used in dual-protocol mode)
let httpsServer;  // HTTPS handler
let io;
let usingTls = false; // true when HTTPS is available

// ── Track all raw TCP sockets so we can force-destroy them on shutdown ──
const activeSockets = new Set();

function trackSockets(srv) {
  if (!srv) return;
  srv.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
  });
}

async function startServer() {

  log.info('─────────────────────────────────────────');
  log.info(`  DRT Server — ${SERVER_NAME}`);
  log.info('─────────────────────────────────────────');

  // ── Protocol setup ─────────────────────────────────────────────────
  //
  // dualProtocol = false (default / production):
  //   HTTPS only on PORT.  All clients use HTTPS.
  //   Falls back to HTTP on PORT if TLS cert generation fails.
  //
  // dualProtocol = true (development):
  //   HTTP on PORT, HTTPS on PORT + 1.
  //   Lets browsers connect via HTTP while Electron uses HTTPS.

  try {
    const tlsCredentials = await getTlsCredentials();
    httpsServer = https.createServer(tlsCredentials, app);
    usingTls = true;
  } catch (e) {
    log.warn('TLS certificate generation failed — HTTPS disabled:', e.message);
  }

  if (DUAL_PROTOCOL) {
    // Dev mode: HTTP on PORT, HTTPS on PORT+1
    httpServer = http.createServer(app);
    server = httpServer;
  } else {
    // Production: HTTPS only on PORT (fall back to HTTP if TLS failed)
    server = httpsServer || http.createServer(app);
    if (!httpsServer) {
      httpServer = server; // server IS the http server in fallback
    }
  }

  // Socket.IO on the primary server, plus the second server if dual-protocol
  io = socketIo(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });
  if (DUAL_PROTOCOL && httpsServer) {
    io.attach(httpsServer);
  }

// Track connected users
const connectedUsers = new Map();
// Runtime per-user state (not persisted)
const userStates = new Map(); // key: userId (string) -> { isMuted: bool, isDeafened: bool }
// Track which voice rooms each socket is in (for reliable disconnect cleanup)
const socketVoiceRooms = new Map(); // key: socketId -> Set<channelId>

// Helper function to broadcast user list
const broadcastUserList = () => {
  db.all('SELECT id, username, displayName, status, profilePicture, nameColor FROM users WHERE leftServer = 0 ORDER BY username', (err, users) => {
    if (!err && users) {
      const merged = users.map(u => {
        const state = userStates.get(String(u.id)) || { isMuted: false, isDeafened: false };
        return { ...u, isMuted: !!state.isMuted, isDeafened: !!state.isDeafened, isOnline: u.status === 'online' || u.status === 'away' };
      });
      io.emit('user_list_update', merged);
    }
  });
};

// Helper to broadcast voice room members for a channel
const broadcastVoiceRoomMembers = (channelId) => {
  const room = `voice_${channelId}`;
  try {
    const clients = io.sockets.adapter.rooms.get(room) || new Set();
    const userIds = [];
    for (const sid of clients) {
      const uid = connectedUsers.get(sid);
      if (uid) userIds.push(uid);
    }

    if (userIds.length === 0) {
      io.emit('voice:room-members-update', { channelId, members: [] });
      return;
    }

    // Query display names, profile pictures, name colors, and status from DB
    const placeholders = userIds.map(() => '?').join(',');
    db.all(`SELECT id, displayName, profilePicture, nameColor, status, username FROM users WHERE id IN (${placeholders})`, userIds, (err, rows) => {
      if (err) {
        log.error('Failed to fetch voice room members from DB', err);
        io.emit('voice:room-members-update', { channelId, members: userIds.map(id => {
          let memberSocketId = null;
          for (const sid of clients) {
            if (connectedUsers.get(sid) === id) { memberSocketId = sid; break; }
          }
          return { id, socketId: memberSocketId, displayName: null, profilePicture: null, nameColor: '#b9bbbe', status: 'online', isMuted: false, isDeafened: false };
        }) });
        return;
      }
      const members = rows.map(r => {
        const state = userStates.get(String(r.id)) || { isMuted: false, isDeafened: false };
        // Find the socket ID for this user
        let memberSocketId = null;
        for (const sid of clients) {
          if (connectedUsers.get(sid) === r.id) {
            memberSocketId = sid;
            break;
          }
        }
        return { id: r.id, socketId: memberSocketId, displayName: r.displayName || r.username, profilePicture: r.profilePicture || null, nameColor: r.nameColor || '#b9bbbe', status: r.status || 'online', isMuted: !!state.isMuted, isDeafened: !!state.isDeafened };
      });
      // Ensure order alphabetical by displayName
      members.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
      io.emit('voice:room-members-update', { channelId, members });
    });
  } catch (e) {
    log.error('Error broadcasting voice room members', e);
  }
};

// Helper to broadcast all active voice room members
const broadcastAllVoiceRoomMembers = () => {
  try {
    const rooms = io.sockets.adapter.rooms;
    if (!rooms) return;
    for (const roomName of rooms.keys()) {
      if (roomName.startsWith('voice_')) {
        const channelId = roomName.replace('voice_', '');
        broadcastVoiceRoomMembers(channelId);
      }
    }
  } catch (e) {
    log.error('Error broadcasting all voice room members', e);
  }
};

// Helper to send all active voice room members directly to a specific socket
// (unicast instead of broadcast, guarantees the new client receives the data)
const sendAllVoiceRoomMembersTo = (targetSocket) => {
  try {
    const rooms = io.sockets.adapter.rooms;
    if (!rooms) return;
    for (const roomName of rooms.keys()) {
      if (roomName.startsWith('voice_')) {
        const channelId = roomName.replace('voice_', '');
        const room = roomName;
        const clients = io.sockets.adapter.rooms.get(room) || new Set();
        const userIds = [];
        for (const sid of clients) {
          const uid = connectedUsers.get(sid);
          if (uid) userIds.push(uid);
        }
        if (userIds.length === 0) {
          targetSocket.emit('voice:room-members-update', { channelId, members: [] });
          continue;
        }
        const placeholders = userIds.map(() => '?').join(',');
        db.all(`SELECT id, displayName, profilePicture, nameColor, status, username FROM users WHERE id IN (${placeholders})`, userIds, (err, rows) => {
          if (err) {
            targetSocket.emit('voice:room-members-update', { channelId, members: userIds.map(id => ({ id, socketId: null, displayName: null, profilePicture: null, nameColor: '#b9bbbe', status: 'online', isMuted: false, isDeafened: false })) });
            return;
          }
          const members = rows.map(r => {
            const state = userStates.get(String(r.id)) || { isMuted: false, isDeafened: false };
            let memberSocketId = null;
            for (const sid of clients) {
              if (connectedUsers.get(sid) === r.id) { memberSocketId = sid; break; }
            }
            return { id: r.id, socketId: memberSocketId, displayName: r.displayName || r.username, profilePicture: r.profilePicture || null, nameColor: r.nameColor || '#b9bbbe', status: r.status || 'online', isMuted: !!state.isMuted, isDeafened: !!state.isDeafened };
          });
          members.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
          targetSocket.emit('voice:room-members-update', { channelId, members });
        });
      }
    }
  } catch (e) {
    log.error('Error sending voice room members to socket', e);
  }
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Routes
app.use('/api/auth/identity', identityRoutes(io));
// Attach broadcast helper to io for use in routes
io.broadcastUserList = broadcastUserList;
io.broadcastAllVoiceRoomMembers = broadcastAllVoiceRoomMembers;
app.use('/api/users', userRoutes(io));
app.use('/api/channels', channelRoutes(io));
app.use('/api/messages', messageRoutes(io));
app.use('/api/reactions', reactionRoutes(io));
app.use('/api/gifs', gifRoutes(io));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Server info endpoint (public, no auth required)
app.get('/api/server/info', (req, res) => {
  const config = require('./config');
  const info = {
    name: config.SERVER_NAME,
    icon: config.SERVER_ICON,
    tls: usingTls,
  };
  // In dual-protocol mode, tell clients the HTTPS port
  if (DUAL_PROTOCOL && usingTls) {
    info.httpsPort = PORT + 1;
  }
  res.json(info);
});

// Socket.io JWT authentication middleware (also rejects banned users)
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    // Check if this user is banned before allowing the connection
    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
      if (err || !user) return next(new Error('User not found'));
      db.get('SELECT 1 FROM bans WHERE username = ?', [user.username], (_err2, ban) => {
        if (ban) return next(new Error('You are banned from this server'));
        next();
      });
    });
  } catch (err) {
    return next(new Error('Invalid authentication token'));
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  log.info('User connected:', socket.id);

  // Register the JWT-authenticated user
  connectedUsers.set(socket.id, socket.userId);
  // Always reset mute/deafen state on new connection so stale state
  // from a previous session doesn't persist.
  userStates.set(String(socket.userId), { isMuted: false, isDeafened: false });
  db.run("UPDATE users SET status = 'online' WHERE id = ?", [socket.userId], () => {
    broadcastUserList();
    // Send all current voice room members directly to the newly connected
    // client (unicast) so they can see who is already in voice channels.
    sendAllVoiceRoomMembersTo(socket);
  });

  socket.on('join_channel', (data) => {
    socket.join(`channel_${data.channelId}`);
  });

  socket.on('leave_channel', (data) => {
    socket.leave(`channel_${data.channelId}`);
  });

  // Typing indicator: relay to all other clients
  socket.on('typing:start', (data) => {
    const { channelId, userId, displayName } = data || {};
    if (!channelId || !userId) return;
    socket.broadcast.emit('typing:start', { channelId, userId, displayName });
  });

  // Receive runtime mute/deafen updates from clients
  socket.on('voice:set-muted', (data) => {
    const { userId, isMuted } = data || {};
    if (!userId) return;
    const prev = userStates.get(String(userId)) || { isMuted: false, isDeafened: false };
    prev.isMuted = !!isMuted;
    userStates.set(String(userId), prev);
    // Broadcast updated lists so everyone sees the change
    broadcastUserList();
    broadcastAllVoiceRoomMembers();
  });

  socket.on('voice:set-deafened', (data) => {
    const { userId, isDeafened } = data || {};
    if (!userId) return;
    const prev = userStates.get(String(userId)) || { isMuted: false, isDeafened: false };
    prev.isDeafened = !!isDeafened;
    // When deafening, also mute the user
    if (prev.isDeafened) prev.isMuted = true;
    // When undeafening, also unmute
    if (!prev.isDeafened) prev.isMuted = false;
    userStates.set(String(userId), prev);
    broadcastUserList();
    broadcastAllVoiceRoomMembers();
  });

  // User idle/away status handlers
  socket.on('user:set-idle', (data) => {
    const { userId } = data;
    if (!userId) return;
    db.run("UPDATE users SET status = 'away' WHERE id = ?", [userId], () => {
      broadcastUserList();
      broadcastAllVoiceRoomMembers();
    });
  });

  socket.on('user:set-active', (data) => {
    const { userId } = data;
    if (!userId) return;
    db.run("UPDATE users SET status = 'online' WHERE id = ?", [userId], () => {
      broadcastUserList();
      broadcastAllVoiceRoomMembers();
    });
  });

  // Voice signaling handlers (WebRTC signaling using socket.io)
  socket.on('voice:join', (data) => {
    const { channelId, userId } = data;
    const room = `voice_${channelId}`;
    socket.join(room);

    // Track voice room membership for reliable disconnect cleanup
    if (!socketVoiceRooms.has(socket.id)) socketVoiceRooms.set(socket.id, new Set());
    socketVoiceRooms.get(socket.id).add(channelId);

    // Reset mute/deafen state on (re)join so it always matches
    // the frontend's initial state (unmuted, undeafened).
    userStates.set(String(userId), { isMuted: false, isDeafened: false });

    // Notify existing peers in the room about the new peer
    socket.to(room).emit('voice:peer-joined', { socketId: socket.id, userId });

    // Send current peers in the room to the joining socket
    try {
      const clients = io.sockets.adapter.rooms.get(room) || new Set();
      const peers = [];
      for (const sid of clients) {
        if (sid === socket.id) continue;
        const peerUserId = connectedUsers.get(sid) || null;
        peers.push({ socketId: sid, userId: peerUserId });
      }
      socket.emit('voice:current-peers', peers);
    } catch (e) {
      log.error('Error sending current peers for voice room', e);
    }
    // Broadcast updated room member lists to all clients
    broadcastVoiceRoomMembers(channelId);
  });

  socket.on('voice:leave', (data) => {
    const { channelId } = data;
    const room = `voice_${channelId}`;
    socket.leave(room);
    socket.to(room).emit('voice:peer-left', { socketId: socket.id });

    // Remove from voice room tracking
    const voiceRooms = socketVoiceRooms.get(socket.id);
    if (voiceRooms) voiceRooms.delete(channelId);

    // Broadcast updated room member lists to all clients
    broadcastVoiceRoomMembers(channelId);
  });

  // Handle speaking status broadcast
  socket.on('voice:speaking-status', (data) => {
    const { userId, isSpeaking, channelId } = data;
    if (channelId) {
      const room = `voice_${channelId}`;
      // Broadcast to other users in the voice channel (exclude sender)
      socket.to(room).emit('voice:speaking-status', { userId, isSpeaking });
    }
  });

  socket.on('voice:offer', (data) => {
    const { target, sdp } = data; // target is socket id
    if (target) {
      socket.to(target).emit('voice:offer', { from: socket.id, sdp });
    }
  });

  socket.on('voice:answer', (data) => {
    const { target, sdp } = data;
    if (target) {
      socket.to(target).emit('voice:answer', { from: socket.id, sdp });
    }
  });

  socket.on('voice:ice-candidate', (data) => {
    const { target, candidate } = data;
    if (target) {
      socket.to(target).emit('voice:ice-candidate', { from: socket.id, candidate });
    }
  });

  socket.on('disconnect', () => {
    log.info('User disconnected:', socket.id);
    const userId = connectedUsers.get(socket.id);
    if (userId) {
      connectedUsers.delete(socket.id);

      // Collect the voice rooms BEFORE any async work —
      // io.sockets.adapter.sids is already cleared by the time
      // the disconnect event fires, so we use our own tracking map.
      const voiceRooms = socketVoiceRooms.get(socket.id) || new Set();
      socketVoiceRooms.delete(socket.id);

      // Update user status in database to offline
      db.run("UPDATE users SET status = 'offline' WHERE id = ?", [userId], () => {
        broadcastUserList();
        // Update all voice rooms the user was in
        for (const channelId of voiceRooms) {
          broadcastVoiceRoomMembers(channelId);
        }
      });
    }
  });
});

// Track sockets on all servers for clean shutdown
trackSockets(server);
if (httpsServer && httpsServer !== server) trackSockets(httpsServer);
if (httpServer && httpServer !== server) trackSockets(httpServer);

server.listen(PORT, () => {
  if (DUAL_PROTOCOL) {
    log.ok(`HTTP server running on port ${PORT}`);
    if (httpsServer) {
      const HTTPS_PORT = PORT + 1;
      httpsServer.listen(HTTPS_PORT, () => {
        log.ok(`HTTPS server running on port ${HTTPS_PORT}`);
      });
    } else {
      log.warn('HTTPS disabled — TLS unavailable');
    }
  } else {
    log.ok(`Server running on port ${PORT} (${usingTls ? 'HTTPS' : 'HTTP — TLS unavailable'})`);
  }
});

log.info('Server is ready. Type "/help" to see available commands.');

// ── Interactive server console ──────────────────────────────────────
serverConsole.start({
  db,
  io,
  log,
  connectedUsers,
  userStates,
  shutdownServer,
  config: { SERVER_NAME, PORT, DUAL_PROTOCOL, usingTls, WHITELIST },
});

// ── Auto-update check ───────────────────────────────────────────────
// Runs once after startup; respects 24-hour cooldown unless forced.
if (process.pkg && !process.argv.includes('--no-update')) {
  const forceUpdate = process.argv.includes('--check-updates');
  // Wire the updater's Y/n prompt through the server console's readline
  // so it doesn't create a second conflicting readline on stdin.
  const updater = require('./updater');
  updater.setPromptFn(serverConsole.askQuestion);
  setTimeout(() => {
    updater.checkForUpdates(forceUpdate, { shutdownFn: shutdownServer }).catch(() => {});
  }, 3000);
}

} // end startServer

// ── Graceful shutdown (used by auto-updater) ──────────────────────────
function shutdownServer() {
  return new Promise((resolve) => {
    log.info('Shutting down server for update...');

    // 1. Disconnect all Socket.IO clients immediately
    if (io) {
      try {
        io.disconnectSockets(true);
        io.close();
      } catch {}
    }

    // 2. Destroy all raw TCP connections so the port is freed
    for (const socket of activeSockets) {
      try { socket.destroy(); } catch {}
    }
    activeSockets.clear();

    // 3. Close listeners
    const servers = [server, httpsServer, httpServer].filter(
      (s, i, arr) => s && s.listening && arr.indexOf(s) === i
    );

    let pending = servers.length;
    if (pending === 0) return resolve();

    const finish = () => { if (--pending <= 0) resolve(); };
    for (const srv of servers) srv.close(finish);

    // Safety timeout
    setTimeout(resolve, 5000);
  });
}

module.exports = { shutdownServer };

// Launch
startServer().catch(err => {
  log.error('Fatal: Failed to start server:', err);
  process.exit(1);
});
