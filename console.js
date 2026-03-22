/**
 * Interactive server console — reads commands from stdin and dispatches
 * them through the command registry.
 *
 * Usage (from index.js after the server has started):
 *   require('./console').start({ db, io, log, connectedUsers, ... });
 *
 * Other modules can temporarily take over input via:
 *   require('./console').askQuestion('Prompt? ')  → Promise<string>
 */

'use strict';

const readline  = require('readline');
const registry  = require('./commands');
const log       = require('./logger');

const PROMPT = '\x1b[90m> \x1b[0m';

/** Module-level state so askQuestion() can reach the readline instance */
let _rl  = null;
let _ctx = null;
let _paused = false;          // true while askQuestion() is waiting
let _questionResolve = null;  // resolve fn for the active question

/**
 * Start the interactive console.
 * @param {object} ctx  Shared context passed to every command.
 */
function start(ctx) {
  _ctx = ctx;

  _rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    prompt:   PROMPT,
    terminal: true,   // force terminal mode so readline uses raw-mode
                      // (SetConsoleMode 0x04) which keeps QuickEdit off
  });

  // Tell the logger about our readline so it can clear/restore the
  // prompt when async log output arrives (prevents garbled display).
  log.setReadline(_rl);

  // Show the prompt once the server is ready
  _rl.prompt();

  _rl.on('line', async (line) => {
    // If a question prompt is active, hand the answer to it instead
    if (_paused && _questionResolve) {
      const resolve = _questionResolve;
      _questionResolve = null;
      _paused = false;
      resolve(line.trim());
      _rl.setPrompt(PROMPT);
      _rl.prompt();
      return;
    }

    const input = line.trim();
    if (!input) { _rl.prompt(); return; }

    // Commands must start with /
    if (!input.startsWith('/')) {
      log.warn(`Commands must start with /. Type "/help" to see available commands.`);
      _rl.prompt();
      return;
    }

    const [rawCmd, ...args] = input.split(/\s+/);
    const cmdName = rawCmd.slice(1); // strip leading /
    if (!cmdName) { _rl.prompt(); return; }
    const cmd = registry.get(cmdName.toLowerCase());

    if (!cmd) {
      log.warn(`Unknown command: "/${cmdName}". Type "/help" to see available commands.`);
      _rl.prompt();
      return;
    }

    try {
      await cmd.execute(args, ctx);
    } catch (err) {
      log.error(`Command "/${cmdName}" failed:`, err.message);
    }

    _rl.prompt();
  });

  _rl.on('close', () => {
    // Ctrl+C / EOF → graceful shutdown
    log.info('Console closed — shutting down...');
    if (typeof ctx.shutdownServer === 'function') {
      ctx.shutdownServer().then(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });
}

/**
 * Temporarily take over the console to ask a yes/no (or free-text)
 * question.  The normal command dispatcher is paused until the user
 * answers.  Returns the trimmed answer string.
 *
 * @param {string} question  Text to display (include trailing space).
 * @returns {Promise<string>}
 */
function askQuestion(question) {
  return new Promise((resolve) => {
    if (!_rl) {
      // Console hasn't started yet (non-interactive or early call)
      if (!process.stdin.isTTY) return resolve('n');
      // Fallback: create a one-shot readline
      const tmpRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      tmpRl.question(question, (answer) => { tmpRl.close(); resolve(answer.trim()); });
      return;
    }

    _paused = true;
    _questionResolve = resolve;
    // Replace the prompt with the question text
    _rl.setPrompt(question);
    _rl.prompt();
  });
}

module.exports = { start, askQuestion };
