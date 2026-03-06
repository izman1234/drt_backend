const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('./database');
const { JWT_SECRET, PORT, DUAL_PROTOCOL, SERVER_NAME, SERVER_ICON, BASE_DIR } = require('./config');
const { getTlsCredentials } = require('./tls');
const log = require('./logger');

// Set console window title to server name
process.title = SERVER_NAME;

// ── Disable Windows QuickEdit mode ────────────────────────────────────
// When QuickEdit is enabled, clicking the console window freezes the
// process (title changes to "Select …") until Enter is pressed.
// We clear the ENABLE_QUICK_EDIT_MODE flag via SetConsoleMode so the
// server can never be accidentally paused by a stray click.
if (process.platform === 'win32') {
  try {
    const _cp = require('child_process');
    const _os = require('os');
    const _ps = require('path');
    const _fss = require('fs');
    const _tmp = _ps.join(_os.tmpdir(), '_drt_qe_' + process.pid + '.ps1');
    _fss.writeFileSync(_tmp, [
      '$c = Add-Type -Name QE -Namespace Win32 -PassThru -MemberDefinition @"',
      '[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int h);',
      '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);',
      '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);',
      '"@',
      '$h = $c::GetStdHandle(-10)',
      '$m = 0',
      '$c::GetConsoleMode($h, [ref]$m) | Out-Null',
      '$c::SetConsoleMode($h, $m -band (-bnot 0x0040)) | Out-Null',
    ].join('\r\n'), 'utf-8');
    _cp.execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${_tmp}"`, {
      stdio: ['inherit', 'ignore', 'ignore'],  // inherit stdin so PS can access the console input handle
    });
    try { _fss.unlinkSync(_tmp); } catch (_) {}
  } catch (e) { /* non-fatal — server still works, just with QuickEdit on */ }
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
  const info = {
    name: SERVER_NAME,
    icon: SERVER_ICON,
    tls: usingTls,
  };
  // In dual-protocol mode, tell clients the HTTPS port
  if (DUAL_PROTOCOL && usingTls) {
    info.httpsPort = PORT + 1;
  }
  res.json(info);
});

// Socket.io JWT authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    return next(new Error('Invalid authentication token'));
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  log.info('User connected:', socket.id);

  // Register the JWT-authenticated user
  connectedUsers.set(socket.id, socket.userId);
  if (!userStates.has(String(socket.userId))) {
    userStates.set(String(socket.userId), { isMuted: false, isDeafened: false });
  }
  db.run("UPDATE users SET status = 'online' WHERE id = ?", [socket.userId], () => {
    broadcastUserList();
  });

  socket.on('join_channel', (data) => {
    socket.join(`channel_${data.channelId}`);
  });

  socket.on('leave_channel', (data) => {
    socket.leave(`channel_${data.channelId}`);
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
      
      // Update user status in database to offline
      db.run("UPDATE users SET status = 'offline' WHERE id = ?", [userId], () => {
        broadcastUserList();
        // Update all voice rooms the user was in
        try {
          const rooms = io.sockets.adapter.sids.get(socket.id) || new Set();
          for (const r of rooms) {
            if (r.startsWith('voice_')) {
              const channelId = r.replace('voice_', '');
              broadcastVoiceRoomMembers(channelId);
            }
          }
        } catch (e) {}
      });
    }
  });
});

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

log.info('Server is ready. Press Ctrl+C to stop.');

// ── Auto-update check ───────────────────────────────────────────────
// Runs once after startup; respects 24-hour cooldown unless forced.
if (process.pkg && !process.argv.includes('--no-update')) {
  const forceUpdate = process.argv.includes('--check-updates');
  setTimeout(() => {
    require('./updater').checkForUpdates(forceUpdate, { shutdownFn: shutdownServer }).catch(() => {});
  }, 3000);
}

} // end startServer

// ── Graceful shutdown (used by auto-updater) ──────────────────────────
function shutdownServer() {
  return new Promise((resolve) => {
    log.info('Shutting down server for update...');

    let pending = 0;
    const done = () => { if (--pending <= 0) resolve(); };

    if (io) { try { io.close(); } catch {} }

    if (server && server.listening) {
      pending++;
      server.close(done);
    }
    if (httpsServer && httpsServer !== server && httpsServer.listening) {
      pending++;
      httpsServer.close(done);
    }
    if (httpServer && httpServer !== server && httpServer.listening) {
      pending++;
      httpServer.close(done);
    }

    if (pending === 0) resolve();

    // Safety timeout — don't wait forever
    setTimeout(resolve, 5000);
  });
}

module.exports = { shutdownServer };

// Launch
startServer().catch(err => {
  log.error('Fatal: Failed to start server:', err);
  process.exit(1);
});
