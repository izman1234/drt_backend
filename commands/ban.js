/**
 * ban — Ban or unban a user. Banned users cannot connect or register.
 * Subcommands: add <username> [reason], remove <username>, list
 */
'use strict';

module.exports = {
  name: 'ban',
  aliases: ['unban'],
  description: 'Ban/unban a user (add / remove / list)',
  usage: '/ban <add|remove|list> [username] [reason]',

  async execute(args, ctx) {
    const { db, io, log, connectedUsers } = ctx;

    if (args.length === 0) {
      log.warn('Usage: /ban <add|remove|list> [username] [reason]');
      return;
    }

    const sub = args[0].toLowerCase();

    const dbRun = (sql, params = []) =>
      new Promise((resolve, reject) =>
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })
      );
    const dbGet = (sql, params = []) =>
      new Promise((resolve, reject) =>
        db.get(sql, params, (err, row) => { err ? reject(err) : resolve(row); })
      );
    const dbAll = (sql, params = []) =>
      new Promise((resolve, reject) =>
        db.all(sql, params, (err, rows) => { err ? reject(err) : resolve(rows); })
      );

    if (sub === 'add') {
      if (args.length < 2) { log.warn('Usage: /ban add <username> [reason]'); return; }
      const username = args[1];
      const reason = args.slice(2).join(' ') || null;

      try {
        await dbRun(
          'INSERT OR REPLACE INTO bans (username, reason) VALUES (?, ?)',
          [username, reason]
        );
        log.ok(`"${username}" has been banned.${reason ? ` Reason: ${reason}` : ''}`);

        // Kick them if they're currently connected
        const user = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
        if (user) {
          let kicked = 0;
          for (const [socketId, userId] of connectedUsers.entries()) {
            if (userId === user.id) {
              const socket = io.sockets.sockets.get(socketId);
              if (socket) {
                socket.emit('server:kicked', { reason: `You have been banned.${reason ? ' Reason: ' + reason : ''}` });
                socket.disconnect(true);
                kicked++;
              }
            }
          }
          if (kicked > 0) log.info(`  └─ Disconnected ${kicked} active session(s).`);
        }
      } catch (err) {
        log.error('Failed to ban user:', err.message);
      }

    } else if (sub === 'remove') {
      if (args.length < 2) { log.warn('Usage: /ban remove <username>'); return; }
      const username = args[1];
      try {
        const result = await dbRun('DELETE FROM bans WHERE username = ?', [username]);
        if (result.changes > 0) {
          log.ok(`"${username}" has been unbanned.`);
        } else {
          log.warn(`"${username}" is not banned.`);
        }
      } catch (err) {
        log.error('Failed to unban user:', err.message);
      }

    } else if (sub === 'list') {
      try {
        const rows = await dbAll('SELECT username, reason, bannedAt FROM bans ORDER BY username');
        if (rows.length === 0) {
          console.log('  No banned users.');
          return;
        }
        console.log('');
        console.log(`  \x1b[1mBanned users (${rows.length}):\x1b[0m`);
        console.log('');
        for (const r of rows) {
          const reason = r.reason ? ` — ${r.reason}` : '';
          console.log(`  \x1b[31mx\x1b[0m ${r.username}${reason} \x1b[90m(${r.bannedAt})\x1b[0m`);
        }
        console.log('');
      } catch (err) {
        log.error('Failed to list bans:', err.message);
      }

    } else {
      log.warn('Unknown subcommand. Usage: /ban <add|remove|list> [username] [reason]');
    }
  },
};
