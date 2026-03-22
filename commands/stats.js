/**
 * stats — Show database statistics (users, messages, channels).
 */
'use strict';

module.exports = {
  name: 'stats',
  aliases: ['statistics'],
  description: 'Show server statistics (users, messages, channels)',
  usage: '/stats',

  async execute(_args, ctx) {
    const { db, log } = ctx;

    const query = (sql) =>
      new Promise((resolve, reject) =>
        db.get(sql, (err, row) => (err ? reject(err) : resolve(row)))
      );

    try {
      const [users, online, channels, messages, reactions] = await Promise.all([
        query('SELECT COUNT(*) AS count FROM users WHERE leftServer = 0'),
        query("SELECT COUNT(*) AS count FROM users WHERE status IN ('online','away')"),
        query('SELECT COUNT(*) AS count FROM channels'),
        query('SELECT COUNT(*) AS count FROM messages'),
        query('SELECT COUNT(*) AS count FROM reactions'),
      ]);

      console.log('');
      console.log('  \x1b[1mServer Statistics\x1b[0m');
      console.log('  ─────────────────────────────────');
      console.log(`  Users:       ${users.count} registered (${online.count} online)`);
      console.log(`  Channels:    ${channels.count}`);
      console.log(`  Messages:    ${messages.count}`);
      console.log(`  Reactions:   ${reactions.count}`);
      console.log('');
    } catch (err) {
      log.error('Failed to gather stats:', err.message);
    }
  },
};
