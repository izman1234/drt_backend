/**
 * owner — Manage server owners.
 * Subcommands: add <username>, remove <username|publicKey>, list
 */
'use strict';

const { disambiguateUser } = require('./disambiguate');

module.exports = {
  name: 'owner',
  aliases: [],
  description: 'Manage server owners (add / remove / list)',
  usage: '/owner <add|remove|list> [username|publicKey]',

  async execute(args, ctx) {
    const { db, log } = ctx;

    if (args.length === 0) {
      log.warn('Usage: /owner <add|remove|list> [username|publicKey]');
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
      if (args.length < 2) { log.warn('Usage: /owner add <username>'); return; }
      const target = args[1];
      try {
        const user = await disambiguateUser(db, target, log);
        if (!user) return;
        await dbRun('INSERT OR IGNORE INTO owners (publicKey) VALUES (?)', [user.identityPublicKey]);
        log.ok(`"${user.displayName}" (@${user.username}) is now a server owner.`);
      } catch (err) {
        log.error('Failed to add owner:', err.message);
      }

    } else if (sub === 'remove') {
      if (args.length < 2) { log.warn('Usage: /owner remove <username|publicKey>'); return; }
      const target = args[1];
      try {
        // First try direct publicKey match
        let result = await dbRun('DELETE FROM owners WHERE publicKey = ?', [target]);
        if (result.changes > 0) {
          log.ok(`Removed owner with public key "${target}".`);
          return;
        }

        // Otherwise treat as username and disambiguate
        const user = await disambiguateUser(db, target, log);
        if (!user) return;

        result = await dbRun('DELETE FROM owners WHERE publicKey = ?', [user.identityPublicKey]);
        if (result.changes > 0) {
          log.ok(`"${user.displayName}" (@${user.username}) is no longer a server owner.`);
        } else {
          log.warn(`"${user.displayName}" (@${user.username}) is not in the owner list.`);
        }
      } catch (err) {
        log.error('Failed to remove owner:', err.message);
      }

    } else if (sub === 'list') {
      try {
        const rows = await dbAll(
          `SELECT o.publicKey, o.addedAt, u.username, u.displayName
           FROM owners o LEFT JOIN users u ON u.identityPublicKey = o.publicKey
           ORDER BY o.addedAt`
        );
        if (rows.length === 0) {
          console.log('  No owners configured.');
          return;
        }
        console.log('');
        console.log(`  \x1b[1mServer owners (${rows.length}):\x1b[0m`);
        console.log('');
        for (const r of rows) {
          const name = r.username ? `${r.displayName} (@${r.username})` : r.publicKey;
          const pk = r.publicKey;
          const short = pk.length > 12 ? pk.slice(0, 6) + '…' + pk.slice(-6) : pk;
          const time = new Date(r.addedAt + 'Z').toLocaleString();
          console.log(`  \x1b[33m*\x1b[0m ${name} \x1b[90m(key: ${short}, added ${time})\x1b[0m`);
        }
        console.log('');
      } catch (err) {
        log.error('Failed to list owners:', err.message);
      }

    } else {
      log.warn('Unknown subcommand. Usage: /owner <add|remove|list> [username|publicKey]');
    }
  },
};
