/**
 * owner — Manage server owners.
 * Subcommands: add <username>, remove <username>, list
 */
'use strict';

module.exports = {
  name: 'owner',
  aliases: [],
  description: 'Manage server owners (add / remove / list)',
  usage: '/owner <add|remove|list> [username]',

  async execute(args, ctx) {
    const { db, log } = ctx;

    if (args.length === 0) {
      log.warn('Usage: /owner <add|remove|list> [username]');
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
      const username = args[1];
      try {
        await dbRun('INSERT OR IGNORE INTO owners (username) VALUES (?)', [username]);
        log.ok(`"${username}" is now a server owner.`);
      } catch (err) {
        log.error('Failed to add owner:', err.message);
      }

    } else if (sub === 'remove') {
      if (args.length < 2) { log.warn('Usage: /owner remove <username>'); return; }
      const username = args[1];
      try {
        const result = await dbRun('DELETE FROM owners WHERE username = ?', [username]);
        if (result.changes > 0) {
          log.ok(`"${username}" is no longer a server owner.`);
        } else {
          log.warn(`"${username}" is not in the owner list.`);
        }
      } catch (err) {
        log.error('Failed to remove owner:', err.message);
      }

    } else if (sub === 'list') {
      try {
        const rows = await dbAll('SELECT username, addedAt FROM owners ORDER BY username');
        if (rows.length === 0) {
          console.log('  No owners configured.');
          return;
        }
        console.log('');
        console.log(`  \x1b[1mServer owners (${rows.length}):\x1b[0m`);
        console.log('');
        for (const r of rows) {
          console.log(`  \x1b[33m*\x1b[0m ${r.username} \x1b[90m(added ${r.addedAt})\x1b[0m`);
        }
        console.log('');
      } catch (err) {
        log.error('Failed to list owners:', err.message);
      }

    } else {
      log.warn('Unknown subcommand. Usage: /owner <add|remove|list> [username]');
    }
  },
};
