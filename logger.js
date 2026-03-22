/**
 * Simple logger with timestamps and level prefixes for the DRT server console.
 *
 * Call setReadline(rl) once the interactive console starts so that
 * async log output properly clears / restores the readline prompt.
 */

const rlModule = require('readline');

const LEVEL_COLORS = {
  INFO:  '\x1b[36m',   // cyan
  WARN:  '\x1b[33m',   // yellow
  ERROR: '\x1b[31m',   // red
  OK:    '\x1b[32m',   // green
  DEBUG: '\x1b[90m',   // grey
};
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';

/** Active readline instance (set by console.js) */
let _rl = null;

function setReadline(rl) { _rl = rl; }

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(level, ...args) {
  const color = LEVEL_COLORS[level] || '';
  const prefix = `${BOLD}${color}[${timestamp()}] [${level}]${RESET}`;

  if (_rl) {
    // Clear the current readline line, write our log, then restore the prompt
    rlModule.clearLine(process.stdout, 0);
    rlModule.cursorTo(process.stdout, 0);
    console.log(prefix, ...args);
    _rl.prompt(true);
  } else {
    console.log(prefix, ...args);
  }
}

module.exports = {
  info:  (...args) => log('INFO',  ...args),
  warn:  (...args) => log('WARN',  ...args),
  error: (...args) => log('ERROR', ...args),
  ok:    (...args) => log('OK',    ...args),
  debug: (...args) => log('DEBUG', ...args),
  setReadline,
};
