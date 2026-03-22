/**
 * channels — List all channels on the server.
 */
'use strict';

module.exports = {
  name: 'channels',
  aliases: ['ch'],
  description: 'List all channels on the server',
  usage: '/channels',

  async execute(_args, ctx) {
    const { db, log } = ctx;

    return new Promise((resolve) => {
      db.all(
        "SELECT id, name, type, description, `order` FROM channels ORDER BY CASE WHEN type = 'text' THEN 0 ELSE 1 END, `order`, name",
        (err, rows) => {
          if (err) { log.error('Failed to query channels:', err.message); return resolve(); }
          if (!rows || rows.length === 0) {
            console.log('  No channels found.');
            return resolve();
          }

          console.log('');
          console.log(`  \x1b[1mChannels (${rows.length}):\x1b[0m`);
          console.log('');
          for (const ch of rows) {
            const icon = ch.type === 'voice' ? '[V]' : ' # ';
            const desc = ch.description ? ` \x1b[90m— ${ch.description}\x1b[0m` : '';
            console.log(`  ${icon} ${ch.name}${desc} \x1b[90m[${ch.type}]\x1b[0m`);
          }
          console.log('');
          resolve();
        }
      );
    });
  },
};
