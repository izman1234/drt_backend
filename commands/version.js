/**
 * version — Display the current server version.
 */
'use strict';

module.exports = {
  name: 'version',
  aliases: ['ver', 'v'],
  description: 'Display the current server version',
  usage: '/version',

  async execute(_args, ctx) {
    const { getCurrentVersion } = require('../updater');
    const version = getCurrentVersion();
    ctx.log.info(`DRT Server v${version}`);
  },
};
