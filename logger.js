/**
 * Simple logger with timestamps and level prefixes for the DRT server console.
 */

const LEVEL_COLORS = {
  INFO:  '\x1b[36m',   // cyan
  WARN:  '\x1b[33m',   // yellow
  ERROR: '\x1b[31m',   // red
  OK:    '\x1b[32m',   // green
  DEBUG: '\x1b[90m',   // grey
};
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(level, ...args) {
  const color = LEVEL_COLORS[level] || '';
  const prefix = `${BOLD}${color}[${timestamp()}] [${level}]${RESET}`;
  console.log(prefix, ...args);
}

module.exports = {
  info:  (...args) => log('INFO',  ...args),
  warn:  (...args) => log('WARN',  ...args),
  error: (...args) => log('ERROR', ...args),
  ok:    (...args) => log('OK',    ...args),
  debug: (...args) => log('DEBUG', ...args),
};
