/**
 * update — Force an update check for the backend.
 */
'use strict';

module.exports = {
  name: 'update',
  aliases: ['checkupdate'],
  description: 'Force a check for backend updates',
  usage: '/update',

  async execute(_args, ctx) {
    const { log, shutdownServer } = ctx;
    const updater = require('../updater');

    log.info('Forcing update check...');
    try {
      await updater.checkForUpdates(true, { shutdownFn: shutdownServer });
    } catch (err) {
      log.error('Update check failed:', err.message);
    }
  },
};
