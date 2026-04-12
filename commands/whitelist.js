/**
 * whitelist — Manage the server whitelist.
 * Subcommands: add <publicKey>, remove <publicKey>, list, on, off
 */
'use strict';

module.exports = {
  name: 'whitelist',
  aliases: ['wl'],
  description: 'Manage the server whitelist (add / remove / list / on / off)',
  usage: '/whitelist <add|remove|list|on|off> [publicKey]',

  async execute(args, ctx) {
    const { db, log } = ctx;
    const config = require('../config');

    if (args.length === 0) {
      log.warn('Usage: /whitelist <add|remove|list|on|off> [publicKey]');
      return;
    }

    const sub = args[0].toLowerCase();

    const dbRun = (sql, params = []) =>
      new Promise((resolve, reject) =>
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })
      );
    const dbAll = (sql, params = []) =>
      new Promise((resolve, reject) =>
        db.all(sql, params, (err, rows) => { err ? reject(err) : resolve(rows); })
      );

    if (sub === 'add') {
      if (args.length < 2) { log.warn('Usage: /whitelist add <publicKey>'); return; }
      const publicKey = args[1];
      try {
        await dbRun('INSERT OR IGNORE INTO whitelist (publicKey) VALUES (?)', [publicKey]);
        log.ok(`Public key added to the whitelist.`);
      } catch (err) {
        log.error('Failed to add to whitelist:', err.message);
      }

    } else if (sub === 'remove') {
      if (args.length < 2) { log.warn('Usage: /whitelist remove <publicKey>'); return; }
      const publicKey = args[1];
      try {
        const result = await dbRun('DELETE FROM whitelist WHERE publicKey = ?', [publicKey]);
        if (result.changes > 0) {
          log.ok(`Public key removed from the whitelist.`);
        } else {
          log.warn(`That public key is not on the whitelist.`);
        }
      } catch (err) {
        log.error('Failed to remove from whitelist:', err.message);
      }

    } else if (sub === 'list') {
      try {
        const rows = await dbAll(
          `SELECT w.publicKey, w.addedAt, u.username, u.displayName
           FROM whitelist w LEFT JOIN users u ON u.identityPublicKey = w.publicKey
           ORDER BY w.addedAt`
        );
        const whitelistEnabled = config.WHITELIST;
        console.log('');
        console.log(`  \x1b[1mWhitelist\x1b[0m — ${whitelistEnabled ? '\x1b[32mENABLED\x1b[0m' : '\x1b[90mDISABLED\x1b[0m'}`);
        console.log('');
        if (rows.length === 0) {
          console.log('  No whitelisted users.');
        } else {
          for (const r of rows) {
            const name = r.username ? `${r.displayName} (@${r.username})` : r.publicKey;
            const pk = r.publicKey;
            const short = pk.length > 12 ? pk.slice(0, 6) + '…' + pk.slice(-6) : pk;
            const time = new Date(r.addedAt + 'Z').toLocaleString();
            console.log(`  \x1b[32m+\x1b[0m ${name} \x1b[90m(key: ${short}, added ${time})\x1b[0m`);
          }
        }
        console.log('');
      } catch (err) {
        log.error('Failed to list whitelist:', err.message);
      }

    } else if (sub === 'on') {
      // Enable whitelist by updating config
      try {
        const fs   = require('fs');
        const cfgRaw = JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf-8'));
        cfgRaw.whitelist = true;
        fs.writeFileSync(config.CONFIG_PATH, JSON.stringify(cfgRaw, null, 2), 'utf-8');
        config.reloadConfig();
        ctx.config.WHITELIST = true;
        log.ok('Whitelist \x1b[32mENABLED\x1b[0m. Only whitelisted users can register/connect.');
      } catch (err) {
        log.error('Failed to enable whitelist:', err.message);
      }

    } else if (sub === 'off') {
      try {
        const fs   = require('fs');
        const cfgRaw = JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf-8'));
        cfgRaw.whitelist = false;
        fs.writeFileSync(config.CONFIG_PATH, JSON.stringify(cfgRaw, null, 2), 'utf-8');
        config.reloadConfig();
        ctx.config.WHITELIST = false;
        log.ok('Whitelist \x1b[90mDISABLED\x1b[0m. All users can register/connect.');
      } catch (err) {
        log.error('Failed to disable whitelist:', err.message);
      }

    } else {
      log.warn('Unknown subcommand. Usage: /whitelist <add|remove|list|on|off> [publicKey]');
    }
  },
};
