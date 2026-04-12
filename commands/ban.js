/**
 * ban — Ban or unban a user. Banned users cannot connect or register.
 * Subcommands: add <username> [reason], remove <username|publicKey>, list
 */
'use strict';

const { disambiguateUser } = require('./disambiguate');

module.exports = {
  name: 'ban',
  aliases: ['unban'],
  description: 'Ban/unban a user (add / remove / list)',
  usage: '/ban <add|remove|list> [username|publicKey] [reason]',

  async execute(args, ctx) {
    const { db, io, log, connectedUsers } = ctx;

    if (args.length === 0) {
      log.warn('Usage: /ban <add|remove|list> [username|publicKey] [reason]');
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
      const target = args[1];
      const reason = args.slice(2).join(' ') || null;

      try {
        // Disambiguate by username
        const user = await disambiguateUser(db, target, log);
        if (!user) return;

        await dbRun(
          'INSERT OR REPLACE INTO bans (publicKey, reason) VALUES (?, ?)',
          [user.identityPublicKey, reason]
        );
        log.ok(`"${user.displayName}" (@${user.username}) has been banned.${reason ? ` Reason: ${reason}` : ''}`);

        // Kick them if they're currently connected
        let kicked = 0;
        for (const [socketId, userId] of connectedUsers.entries()) {
          if (userId === user.identityPublicKey) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
              socket.emit('server:kicked', { reason: `You have been banned.${reason ? ' Reason: ' + reason : ''}` });
              socket.disconnect(true);
              kicked++;
            }
          }
        }
        if (kicked > 0) log.info(`  └─ Disconnected ${kicked} active session(s).`);
      } catch (err) {
        log.error('Failed to ban user:', err.message);
      }

    } else if (sub === 'remove') {
      if (args.length < 2) { log.warn('Usage: /ban remove <username|publicKey>'); return; }
      const target = args[1];

      try {
        // First try direct publicKey match
        let result = await dbRun('DELETE FROM bans WHERE publicKey = ?', [target]);
        if (result.changes > 0) {
          log.ok(`Unbanned public key "${target}".`);
          return;
        }

        // Otherwise treat as username and disambiguate
        const user = await disambiguateUser(db, target, log);
        if (!user) return;

        result = await dbRun('DELETE FROM bans WHERE publicKey = ?', [user.identityPublicKey]);
        if (result.changes > 0) {
          log.ok(`"${user.displayName}" (@${user.username}) has been unbanned.`);
        } else {
          log.warn(`"${user.displayName}" (@${user.username}) is not banned.`);
        }
      } catch (err) {
        log.error('Failed to unban user:', err.message);
      }

    } else if (sub === 'list') {
      try {
        const rows = await dbAll(
          `SELECT b.publicKey, b.reason, b.bannedAt, u.username, u.displayName
           FROM bans b LEFT JOIN users u ON u.identityPublicKey = b.publicKey
           ORDER BY b.bannedAt`
        );
        if (rows.length === 0) {
          console.log('  No banned users.');
          return;
        }
        console.log('');
        console.log(`  \x1b[1mBanned users (${rows.length}):\x1b[0m`);
        console.log('');
        for (const r of rows) {
          const reason = r.reason ? ` — ${r.reason}` : '';
          const name = r.username ? `${r.displayName} (@${r.username})` : r.publicKey;
          const time = new Date(r.bannedAt + 'Z').toLocaleString();
          console.log(`  \x1b[31mx\x1b[0m ${name}${reason} \x1b[90m(${time})\x1b[0m`);
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
