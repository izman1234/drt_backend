/**
 * help — List all commands or show details for a specific command.
 */
'use strict';

module.exports = {
  name: 'help',
  aliases: ['?', 'commands'],
  description: 'List all commands or get help on a specific one',
  usage: '/help [command]',

  async execute(args, ctx) {
    const registry = require('./index');
    const { log } = ctx;

    if (args.length > 0) {
      const cmd = registry.get(args[0].toLowerCase());
      if (!cmd) {
        log.warn(`Unknown command: "${args[0]}"`);
        return;
      }
      console.log('');
      console.log(`  \x1b[1m/${cmd.name}\x1b[0m — ${cmd.description}`);
      console.log(`  Usage: ${cmd.usage}`);
      if (cmd.aliases?.length) console.log(`  Aliases: ${cmd.aliases.map(a => '/' + a).join(', ')}`);
      console.log('');
      return;
    }

    const cmds = registry.all().sort((a, b) => a.name.localeCompare(b.name));
    console.log('');
    console.log('  \x1b[1mAvailable commands:\x1b[0m');
    console.log('');
    for (const cmd of cmds) {
      const aliases = cmd.aliases?.length ? ` \x1b[90m(${cmd.aliases.map(a => '/' + a).join(', ')})\x1b[0m` : '';
      console.log(`  \x1b[36m${'/' + cmd.name.padEnd(12)}\x1b[0m ${cmd.description}${aliases}`);
    }
    console.log('');
    console.log('  Type \x1b[36m/help <command>\x1b[0m for details on a specific command.');
    console.log('');
  },
};
