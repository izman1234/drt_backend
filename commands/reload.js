/**
 * reload — Reload server-config.json without restarting.
 */
'use strict';

module.exports = {
  name: 'reload',
  aliases: [],
  description: 'Reload server-config.json (applies mutable settings)',
  usage: '/reload',

  async execute(_args, ctx) {
    const { log, io } = ctx;
    const config = require('../config');

    try {
      const changes = config.reloadConfig();
      if (changes.length === 0) {
        log.info('Configuration reloaded — no changes detected.');
      } else {
        log.ok('Configuration reloaded. Changes:');
        for (const c of changes) {
          console.log(`    • ${c}`);
        }

        // Notify all connected clients of the new config
        io.emit('server:config-update', {
          name: config.SERVER_NAME,
          icon: config.SERVER_ICON,
        });
      }
      // Update the console context's config snapshot
      ctx.config.SERVER_NAME   = config.SERVER_NAME;
      ctx.config.SERVER_ICON   = config.SERVER_ICON;
      ctx.config.PORT          = config.PORT;
      ctx.config.DUAL_PROTOCOL = config.DUAL_PROTOCOL;
      ctx.config.WHITELIST     = config.WHITELIST;

      // Update console window title
      process.title = config.SERVER_NAME;
    } catch (err) {
      log.error('Failed to reload config:', err.message);
    }
  },
};
