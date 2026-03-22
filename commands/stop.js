/**
 * stop — Gracefully shut down the server.
 */
'use strict';

module.exports = {
  name: 'stop',
  aliases: ['quit', 'exit', 'shutdown'],
  description: 'Gracefully shut down the server',
  usage: '/stop',

  async execute(_args, ctx) {
    const { log, shutdownServer } = ctx;
    log.info('Server shutting down...');
    if (typeof shutdownServer === 'function') {
      await shutdownServer();
    }
    process.exit(0);
  },
};
