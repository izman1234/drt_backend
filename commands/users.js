/**
 * users — List all registered users with online/offline status.
 */
'use strict';

module.exports = {
  name: 'users',
  aliases: ['userlist'],
  description: 'List all registered users with their status',
  usage: '/users',

  async execute(_args, ctx) {
    const { db } = ctx;

    return new Promise((resolve) => {
      db.all(
        `SELECT identityPublicKey, username, displayName, status, nameColor, createdAt
         FROM users WHERE leftServer = 0 ORDER BY username`,
        (err, rows) => {
          if (err) {
            ctx.log.error('Failed to query users:', err.message);
            return resolve();
          }
          if (!rows || rows.length === 0) {
            console.log('  No registered users.');
            return resolve();
          }

          console.log('');
          console.log(`  \x1b[1mRegistered users (${rows.length}):\x1b[0m`);
          console.log('');
          for (const u of rows) {
            const statusIcon = (u.status === 'online' || u.status === 'away')
              ? '\x1b[32m●\x1b[0m'
              : '\x1b[90m○\x1b[0m';
            const statusText = u.status || 'offline';
            const pk = u.identityPublicKey;
            const short = pk.length > 12 ? pk.slice(0, 6) + '…' + pk.slice(-6) : pk;
            console.log(`  ${statusIcon} ${u.displayName} \x1b[90m(@${u.username}) (key: ${short}) [${statusText}]\x1b[0m`);
          }
          console.log('');
          resolve();
        }
      );
    });
  },
};
