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
// Runtime voice media state (not persisted)
const voiceMediaStates = new Map(); // key: channelId -> Map<userId, { userId, socketId, cameraOn, screenOn }>
const screenWatchSelections = new Map(); // key: viewer socketId -> { channelId, targetUserId }

const getVoiceRoomName = (channelId) => `voice_${channelId}`;

const getRoomClients = (channelId) => io.sockets.adapter.rooms.get(getVoiceRoomName(channelId)) || new Set();

const socketInVoiceRoom = (socketId, channelId) => getRoomClients(channelId).has(socketId);

const socketsShareVoiceRoom = (socketA, socketB) => {
  const rooms = socketVoiceRooms.get(socketA) || new Set();
  for (const channelId of rooms) {
    if (socketInVoiceRoom(socketB, channelId)) return true;
  }
  return false;
};

const getSocketForUserInVoiceRoom = (channelId, userId) => {
  const clients = getRoomClients(channelId);
  for (const sid of clients) {
    if (String(connectedUsers.get(sid)) === String(userId)) return sid;
  }
  return null;
};

const getMediaStateForUser = (channelId, userId) => {
  const channelStates = voiceMediaStates.get(String(channelId));
  const state = channelStates ? channelStates.get(String(userId)) : null;
  return {
    cameraOn: !!state?.cameraOn,
    screenOn: !!state?.screenOn,
  };
};

const getVoiceMediaStateSnapshot = (channelId) => {
  const clients = getRoomClients(channelId);
  const userIdsInRoom = new Set();
  for (const sid of clients) {
    const uid = connectedUsers.get(sid);
    if (uid) userIdsInRoom.add(String(uid));
  }

  const channelStates = voiceMediaStates.get(String(channelId)) || new Map();
  const states = [];
  for (const [userId, state] of channelStates.entries()) {
    if (!userIdsInRoom.has(String(userId))) continue;
    states.push({
      userId,
      socketId: state.socketId,
      cameraOn: !!state.cameraOn,
      screenOn: !!state.screenOn,
    });
  }
  return states;
};

const getVoiceRoomMemberContext = (channelId) => {
  const clients = getRoomClients(channelId);
  const userIds = [];
  const socketByUser = new Map();

  for (const sid of clients) {
    const uid = connectedUsers.get(sid);
    if (!uid) continue;
    const key = String(uid);
    if (socketByUser.has(key)) continue;
    socketByUser.set(key, sid);
    userIds.push(uid);
  }

  return { clients, userIds, socketByUser };
};

const broadcastVoiceMediaState = (channelId) => {
  io.emit('voice:media-state:update', {
    channelId,
    states: getVoiceMediaStateSnapshot(channelId),
  });
};

const setVoiceMediaState = (channelId, userId, socketId, patch) => {
  const key = String(channelId);
  if (!voiceMediaStates.has(key)) voiceMediaStates.set(key, new Map());
  const channelStates = voiceMediaStates.get(key);
  const prev = channelStates.get(String(userId)) || {
    userId: String(userId),
    socketId,
    cameraOn: false,
    screenOn: false,
  };
  const next = {
    ...prev,
    socketId,
    cameraOn: patch.cameraOn !== undefined ? !!patch.cameraOn : !!prev.cameraOn,
    screenOn: patch.screenOn !== undefined ? !!patch.screenOn : !!prev.screenOn,
  };
  channelStates.set(String(userId), next);
  return next;
};

const notifyScreenWatchRemoved = (viewerSocketId, channelId, targetUserId) => {
  const targetSocketId = getSocketForUserInVoiceRoom(channelId, targetUserId);
  const viewerUserId = connectedUsers.get(viewerSocketId);
  if (targetSocketId && viewerUserId) {
    io.to(targetSocketId).emit('voice:screen-watch:viewer-removed', {
      channelId,
      viewerSocketId,
      viewerUserId,
    });
  }
};

const clearScreenWatchSelection = (viewerSocketId) => {
  const previous = screenWatchSelections.get(viewerSocketId);
  if (!previous) return;
  notifyScreenWatchRemoved(viewerSocketId, previous.channelId, previous.targetUserId);
  screenWatchSelections.delete(viewerSocketId);
};

const clearVoiceMediaForSocket = (socketId, channelId) => {
  const userId = connectedUsers.get(socketId);
  if (!userId) return;

  const channelIds = channelId ? [channelId] : Array.from(socketVoiceRooms.get(socketId) || []);
  channelIds.forEach((cid) => {
    const key = String(cid);
    const channelStates = voiceMediaStates.get(key);
    if (channelStates) {
      channelStates.delete(String(userId));
      if (channelStates.size === 0) voiceMediaStates.delete(key);
    }

    clearScreenWatchSelection(socketId);

    for (const [viewerSocketId, selection] of Array.from(screenWatchSelections.entries())) {
      if (String(selection.channelId) === String(cid) && String(selection.targetUserId) === String(userId)) {
        screenWatchSelections.delete(viewerSocketId);
        io.to(viewerSocketId).emit('voice:screen-watch:current', {
          channelId: cid,
          targetUserId: null,
        });
      }
    }

    broadcastVoiceMediaState(cid);
  });
};

// Helper function to broadcast user list
const broadcastUserList = () => {
  db.all('SELECT identityPublicKey, username, displayName, status, profilePicture, nameColor, bio, customStatus FROM users WHERE leftServer = 0 ORDER BY username', (err, users) => {
    if (!err && users) {
      const merged = users.map(u => {
        const state = userStates.get(String(u.identityPublicKey)) || { isMuted: false, isDeafened: false };
        return { ...u, id: u.identityPublicKey, isMuted: !!state.isMuted, isDeafened: !!state.isDeafened, isOnline: u.status === 'online' || u.status === 'away' };
      });
      io.emit('user_list_update', merged);
    }
  });
};

// Helper to broadcast voice room members for a channel
const broadcastVoiceRoomMembers = (channelId) => {
  try {
    const { userIds } = getVoiceRoomMemberContext(channelId);

    if (userIds.length === 0) {
      io.emit('voice:room-members-update', { channelId, members: [] });
      broadcastVoiceMediaState(channelId);
      return;
    }

    // Query display names, profile pictures, name colors, and status from DB
    const placeholders = userIds.map(() => '?').join(',');
    db.all(`SELECT identityPublicKey, displayName, profilePicture, nameColor, status, username FROM users WHERE identityPublicKey IN (${placeholders})`, userIds, (err, rows) => {
      const latest = getVoiceRoomMemberContext(channelId);
      const activeUserIds = new Set(latest.userIds.map(id => String(id)));

      if (latest.userIds.length === 0) {
        io.emit('voice:room-members-update', { channelId, members: [] });
        broadcastVoiceMediaState(channelId);
        return;
      }

      if (err) {
        log.error('Failed to fetch voice room members from DB', err);
        io.emit('voice:room-members-update', { channelId, members: latest.userIds.map(id => {
          const memberSocketId = latest.socketByUser.get(String(id)) || null;
          const media = getMediaStateForUser(channelId, id);
          return { id, socketId: memberSocketId, displayName: null, profilePicture: null, nameColor: '#b9bbbe', status: 'online', isMuted: false, isDeafened: false, cameraOn: media.cameraOn, screenOn: media.screenOn };
        }) });
        return;
      }
      const members = rows.filter(r => activeUserIds.has(String(r.identityPublicKey))).map(r => {
        const state = userStates.get(String(r.identityPublicKey)) || { isMuted: false, isDeafened: false };
        const memberSocketId = latest.socketByUser.get(String(r.identityPublicKey)) || null;
        const media = getMediaStateForUser(channelId, r.identityPublicKey);
        return { id: r.identityPublicKey, socketId: memberSocketId, displayName: r.displayName || r.username, profilePicture: r.profilePicture || null, nameColor: r.nameColor || '#b9bbbe', status: r.status || 'online', isMuted: !!state.isMuted, isDeafened: !!state.isDeafened, cameraOn: media.cameraOn, screenOn: media.screenOn };
      });
      // Ensure order alphabetical by displayName
      members.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
      io.emit('voice:room-members-update', { channelId, members });
      broadcastVoiceMediaState(channelId);
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
        const { userIds } = getVoiceRoomMemberContext(channelId);
        if (userIds.length === 0) {
          targetSocket.emit('voice:room-members-update', { channelId, members: [] });
          targetSocket.emit('voice:media-state:update', { channelId, states: [] });
          continue;
        }
        const placeholders = userIds.map(() => '?').join(',');
        db.all(`SELECT identityPublicKey, displayName, profilePicture, nameColor, status, username FROM users WHERE identityPublicKey IN (${placeholders})`, userIds, (err, rows) => {
          const latest = getVoiceRoomMemberContext(channelId);
          const activeUserIds = new Set(latest.userIds.map(id => String(id)));

          if (latest.userIds.length === 0) {
            targetSocket.emit('voice:room-members-update', { channelId, members: [] });
            targetSocket.emit('voice:media-state:update', { channelId, states: [] });
            return;
          }

          if (err) {
            targetSocket.emit('voice:room-members-update', { channelId, members: latest.userIds.map(id => {
              const media = getMediaStateForUser(channelId, id);
              return { id, socketId: latest.socketByUser.get(String(id)) || null, displayName: null, profilePicture: null, nameColor: '#b9bbbe', status: 'online', isMuted: false, isDeafened: false, cameraOn: media.cameraOn, screenOn: media.screenOn };
            }) });
            targetSocket.emit('voice:media-state:update', { channelId, states: getVoiceMediaStateSnapshot(channelId) });
            return;
          }
          const members = rows.filter(r => activeUserIds.has(String(r.identityPublicKey))).map(r => {
            const state = userStates.get(String(r.identityPublicKey)) || { isMuted: false, isDeafened: false };
            const memberSocketId = latest.socketByUser.get(String(r.identityPublicKey)) || null;
            const media = getMediaStateForUser(channelId, r.identityPublicKey);
            return { id: r.identityPublicKey, socketId: memberSocketId, displayName: r.displayName || r.username, profilePicture: r.profilePicture || null, nameColor: r.nameColor || '#b9bbbe', status: r.status || 'online', isMuted: !!state.isMuted, isDeafened: !!state.isDeafened, cameraOn: media.cameraOn, screenOn: media.screenOn };
          });
          members.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
          targetSocket.emit('voice:room-members-update', { channelId, members });
          targetSocket.emit('voice:media-state:update', { channelId, states: getVoiceMediaStateSnapshot(channelId) });
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
    db.get('SELECT 1 FROM bans WHERE publicKey = ?', [decoded.userId], (_err, ban) => {
      if (ban) return next(new Error('You are banned from this server'));
      db.get('SELECT identityPublicKey FROM users WHERE identityPublicKey = ?', [decoded.userId], (err2, user) => {
        if (err2 || !user) return next(new Error('User not found'));
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
  db.run("UPDATE users SET status = 'online' WHERE identityPublicKey = ?", [socket.userId], () => {
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
    const { userId: requestedUserId, isMuted } = data || {};
    if (requestedUserId && String(requestedUserId) !== String(socket.userId)) return;
    const userId = socket.userId;
    if (!userId) return;
    const prev = userStates.get(String(userId)) || { isMuted: false, isDeafened: false };
    prev.isMuted = !!isMuted;
    userStates.set(String(userId), prev);
    // Broadcast updated lists so everyone sees the change
    broadcastUserList();
    broadcastAllVoiceRoomMembers();
  });

  socket.on('voice:set-deafened', (data) => {
    const { userId: requestedUserId, isDeafened } = data || {};
    if (requestedUserId && String(requestedUserId) !== String(socket.userId)) return;
    const userId = socket.userId;
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
    db.run("UPDATE users SET status = 'away' WHERE identityPublicKey = ?", [userId], () => {
      broadcastUserList();
      broadcastAllVoiceRoomMembers();
    });
  });

  socket.on('user:set-active', (data) => {
    const { userId } = data;
    if (!userId) return;
    db.run("UPDATE users SET status = 'online' WHERE identityPublicKey = ?", [userId], () => {
      broadcastUserList();
      broadcastAllVoiceRoomMembers();
    });
  });

  // Voice signaling handlers (WebRTC signaling using socket.io)
  socket.on('voice:join', (data) => {
    const { channelId, userId, isMuted, isDeafened } = data;
    const room = getVoiceRoomName(channelId);
    socket.join(room);

    // Track voice room membership for reliable disconnect cleanup
    if (!socketVoiceRooms.has(socket.id)) socketVoiceRooms.set(socket.id, new Set());
    socketVoiceRooms.get(socket.id).add(channelId);

    if (typeof isMuted === 'boolean' || typeof isDeafened === 'boolean') {
      const deafened = !!isDeafened;
      userStates.set(String(socket.userId), {
        isMuted: deafened || !!isMuted,
        isDeafened: deafened,
      });
    }
    setVoiceMediaState(channelId, socket.userId, socket.id, { cameraOn: false, screenOn: false });

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
    broadcastVoiceMediaState(channelId);
  });

  socket.on('voice:leave', (data) => {
    const { channelId } = data;
    const room = getVoiceRoomName(channelId);
    clearVoiceMediaForSocket(socket.id, channelId);
    socket.leave(room);
    socket.to(room).emit('voice:peer-left', { socketId: socket.id });

    // Remove from voice room tracking
    const voiceRooms = socketVoiceRooms.get(socket.id);
    if (voiceRooms) voiceRooms.delete(channelId);

    // Broadcast updated room member lists to all clients
    broadcastVoiceRoomMembers(channelId);
  });

  socket.on('voice:media-state:set', (data) => {
    const { channelId, cameraOn, screenOn } = data || {};
    if (!channelId || !socketInVoiceRoom(socket.id, channelId)) return;

    const prev = getMediaStateForUser(channelId, socket.userId);
    const next = setVoiceMediaState(channelId, socket.userId, socket.id, { cameraOn, screenOn });

    if (prev.screenOn && !next.screenOn) {
      for (const [viewerSocketId, selection] of Array.from(screenWatchSelections.entries())) {
        if (String(selection.channelId) === String(channelId) && String(selection.targetUserId) === String(socket.userId)) {
          screenWatchSelections.delete(viewerSocketId);
          io.to(viewerSocketId).emit('voice:screen-watch:current', {
            channelId,
            targetUserId: null,
          });
        }
      }
    }

    broadcastVoiceMediaState(channelId);
  });

  socket.on('voice:screen-watch:set', (data) => {
    const { channelId, targetUserId } = data || {};
    if (!channelId || !socketInVoiceRoom(socket.id, channelId)) return;

    const previous = screenWatchSelections.get(socket.id);
    if (previous && (String(previous.channelId) !== String(channelId) || String(previous.targetUserId) !== String(targetUserId))) {
      notifyScreenWatchRemoved(socket.id, previous.channelId, previous.targetUserId);
      screenWatchSelections.delete(socket.id);
    }

    if (!targetUserId) {
      socket.emit('voice:screen-watch:current', { channelId, targetUserId: null });
      return;
    }

    const targetSocketId = getSocketForUserInVoiceRoom(channelId, targetUserId);
    const targetMedia = getMediaStateForUser(channelId, targetUserId);
    if (!targetSocketId || !targetMedia.screenOn || String(targetUserId) === String(socket.userId)) {
      if (previous) {
        notifyScreenWatchRemoved(socket.id, previous.channelId, previous.targetUserId);
        screenWatchSelections.delete(socket.id);
      }
      socket.emit('voice:screen-watch:current', { channelId, targetUserId: null });
      return;
    }

    screenWatchSelections.set(socket.id, { channelId, targetUserId: String(targetUserId) });
    io.to(targetSocketId).emit('voice:screen-watch:viewer-added', {
      channelId,
      viewerSocketId: socket.id,
      viewerUserId: socket.userId,
    });
    socket.emit('voice:screen-watch:current', { channelId, targetUserId: String(targetUserId) });
  });

  // Handle speaking status broadcast
  socket.on('voice:speaking-status', (data) => {
    const { userId, isSpeaking, channelId } = data;
    if (channelId) {
      const room = getVoiceRoomName(channelId);
      // Broadcast to other users in the voice channel (exclude sender)
      socket.to(room).emit('voice:speaking-status', { userId, isSpeaking });
    }
  });

  socket.on('voice:offer', (data) => {
    const { target, sdp, channelId } = data; // target is socket id
    const allowed = channelId
      ? socketInVoiceRoom(socket.id, channelId) && socketInVoiceRoom(target, channelId)
      : socketsShareVoiceRoom(socket.id, target);
    if (target && allowed) {
      socket.to(target).emit('voice:offer', { from: socket.id, sdp, channelId });
    }
  });

  socket.on('voice:answer', (data) => {
    const { target, sdp, channelId } = data;
    const allowed = channelId
      ? socketInVoiceRoom(socket.id, channelId) && socketInVoiceRoom(target, channelId)
      : socketsShareVoiceRoom(socket.id, target);
    if (target && allowed) {
      socket.to(target).emit('voice:answer', { from: socket.id, sdp, channelId });
    }
  });

  socket.on('voice:ice-candidate', (data) => {
    const { target, candidate, channelId } = data;
    const allowed = channelId
      ? socketInVoiceRoom(socket.id, channelId) && socketInVoiceRoom(target, channelId)
      : socketsShareVoiceRoom(socket.id, target);
    if (target && allowed) {
      socket.to(target).emit('voice:ice-candidate', { from: socket.id, candidate, channelId });
    }
  });

  socket.on('voice:track-meta', (data) => {
    const { target, channelId, source, streamId, trackId } = data || {};
    const allowed = channelId
      ? socketInVoiceRoom(socket.id, channelId) && socketInVoiceRoom(target, channelId)
      : socketsShareVoiceRoom(socket.id, target);
    if (target && allowed && (source === 'camera' || source === 'screen')) {
      socket.to(target).emit('voice:track-meta', {
        from: socket.id,
        channelId,
        source,
        streamId,
        trackId,
      });
    }
  });

  socket.on('disconnect', () => {
    log.info('User disconnected:', socket.id);
    const userId = connectedUsers.get(socket.id);
    if (userId) {
      clearVoiceMediaForSocket(socket.id);
      connectedUsers.delete(socket.id);

      // Collect the voice rooms BEFORE any async work —
      // io.sockets.adapter.sids is already cleared by the time
      // the disconnect event fires, so we use our own tracking map.
      const voiceRooms = socketVoiceRooms.get(socket.id) || new Set();
      socketVoiceRooms.delete(socket.id);

      // Update user status in database to offline
      db.run("UPDATE users SET status = 'offline' WHERE identityPublicKey = ?", [userId], () => {
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
// Runs once after startup and then every 24 hours while running.
if (process.pkg && !process.argv.includes('--no-update')) {
  const forceUpdate = process.argv.includes('--check-updates');
  // Wire the updater's Y/n prompt through the server console's readline
  // so it doesn't create a second conflicting readline on stdin.
  const updater = require('./updater');
  updater.setPromptFn(serverConsole.askQuestion);
  setTimeout(() => {
    updater.checkForUpdates(forceUpdate, { shutdownFn: shutdownServer }).catch(() => {});
  }, 3000);

  // Periodic 24-hour check while the server is running
  const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
  setInterval(() => {
    log.info('Periodic update check (24h interval)...');
    updater.checkForUpdates(false, { shutdownFn: shutdownServer }).catch(() => {});
  }, UPDATE_CHECK_INTERVAL);
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
