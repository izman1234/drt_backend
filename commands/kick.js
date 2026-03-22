/**
 * kick — Disconnect a user by username.
 */
'use strict';

module.exports = {
  name: 'kick',
  aliases: ['disconnect'],
  description: 'Disconnect a user from the server by username',
  usage: '/kick <username>',

  async execute(args, ctx) {
    const { db, io, log, connectedUsers } = ctx;

    if (args.length === 0) {
      log.warn('Usage: /kick <username>');
      return;
    }

    const targetUsername = args[0];

    return new Promise((resolve) => {
      db.get(
        'SELECT id, username, displayName FROM users WHERE username = ?',
        [targetUsername],
        (err, user) => {
          if (err) { log.error('DB error:', err.message); return resolve(); }
          if (!user) { log.warn(`User "@${targetUsername}" not found.`); return resolve(); }

          // Find all sockets belonging to this user
          let kicked = 0;
          for (const [socketId, userId] of connectedUsers.entries()) {
            if (userId === user.id) {
              const socket = io.sockets.sockets.get(socketId);
              if (socket) {
                socket.emit('server:kicked', { reason: 'You were kicked by the server administrator.' });
                socket.disconnect(true);
                kicked++;
              }
            }
          }

          if (kicked > 0) {
            log.ok(`Kicked "${user.displayName}" (@${user.username}) — ${kicked} session(s) disconnected.`);
          } else {
            log.warn(`"@${targetUsername}" is not currently connected.`);
          }
          resolve();
        }
      );
    });
  },
};
