/**
 * clear — Clear the terminal screen.
 */
'use strict';

module.exports = {
  name: 'clear',
  aliases: ['cls'],
  description: 'Clear the terminal screen',
  usage: '/clear',

  async execute() {
    process.stdout.write('\x1Bc');
  },
};
