/**
 * broadcast — Send a system message to all connected clients.
 */
'use strict';

module.exports = {
  name: 'broadcast',
  aliases: ['say', 'announce'],
  description: 'Send a system announcement to all connected clients',
  usage: '/broadcast <message>',

  async execute(args, ctx) {
    const { io, log } = ctx;

    if (args.length === 0) {
      log.warn('Usage: /broadcast <message>');
      return;
    }

    const message = args.join(' ');
    io.emit('server:broadcast', {
      message,
      timestamp: new Date().toISOString(),
    });
    log.ok(`Broadcast sent: "${message}"`);
  },
};
