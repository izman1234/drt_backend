/**
 * status — Show server status: uptime, port, TLS, connected users.
 */
'use strict';

const os = require('os');

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

module.exports = {
  name: 'status',
  aliases: ['info'],
  description: 'Show server status (uptime, port, TLS, connections)',
  usage: '/status',

  async execute(_args, ctx) {
    const { config, connectedUsers } = ctx;
    const uptime = formatUptime(process.uptime());
    const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

    console.log('');
    console.log('  \x1b[1mServer Status\x1b[0m');
    console.log('  ─────────────────────────────────');
    console.log(`  Name:         ${config.SERVER_NAME}`);
    console.log(`  Port:         ${config.PORT}`);
    console.log(`  TLS:          ${config.usingTls ? '\x1b[32mEnabled\x1b[0m' : '\x1b[33mDisabled\x1b[0m'}`);
    console.log(`  Dual-proto:   ${config.DUAL_PROTOCOL ? 'Yes' : 'No'}`);
    console.log(`  Uptime:       ${uptime}`);
    console.log(`  Memory:       ${memMB} MB`);
    console.log(`  Connections:  ${connectedUsers.size} socket(s)`);
    console.log(`  Platform:     ${os.platform()} ${os.arch()}`);
    console.log(`  Node:         ${process.version}`);
    console.log('');
  },
};
