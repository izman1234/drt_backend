/**
 * kick — Disconnect a user by username.
 */
'use strict';

const { disambiguateUser } = require('./disambiguate');

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

    try {
      const user = await disambiguateUser(db, targetUsername, log);
      if (!user) return;

      // Find all sockets belonging to this user
      let kicked = 0;
      for (const [socketId, userId] of connectedUsers.entries()) {
        if (userId === user.identityPublicKey) {
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
        log.warn(`"${user.displayName}" (@${user.username}) is not currently connected.`);
      }
    } catch (err) {
      log.error('Failed to kick user:', err.message);
    }
  },
};
