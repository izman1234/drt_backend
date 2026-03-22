/**
 * online — Show only currently connected users.
 */
'use strict';

module.exports = {
  name: 'online',
  aliases: ['who'],
  description: 'Show currently connected users',
  usage: '/online',

  async execute(_args, ctx) {
    const { db, connectedUsers } = ctx;
    const onlineIds = [...new Set(connectedUsers.values())];

    if (onlineIds.length === 0) {
      console.log('  No users currently online.');
      return;
    }

    return new Promise((resolve) => {
      const placeholders = onlineIds.map(() => '?').join(',');
      db.all(
        `SELECT id, username, displayName, status FROM users WHERE id IN (${placeholders})`,
        onlineIds,
        (err, rows) => {
          if (err) {
            ctx.log.error('Failed to query online users:', err.message);
            return resolve();
          }

          console.log('');
          console.log(`  \x1b[1mOnline users (${rows.length}):\x1b[0m`);
          console.log('');
          for (const u of rows) {
            const statusText = u.status === 'away' ? '\x1b[33maway\x1b[0m' : '\x1b[32monline\x1b[0m';
            console.log(`  \x1b[32m●\x1b[0m ${u.displayName} \x1b[90m(@${u.username})\x1b[0m [${statusText}]`);
          }
          console.log('');
          resolve();
        }
      );
    });
  },
};
