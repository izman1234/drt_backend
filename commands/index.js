/**
 * Command registry — auto-discovers command modules in this directory.
 *
 * Each command file must export:
 *   name        {string}   Primary command name (lowercase)
 *   aliases     {string[]} Optional alternative names
 *   description {string}   One-line summary shown in `help`
 *   usage       {string}   Usage string (e.g. "kick <username>")
 *   execute     {Function} async (args: string[], ctx: object) => void
 *
 * The `ctx` object passed to every command contains:
 *   db, io, log, connectedUsers, userStates, shutdownServer, config
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/** @type {Map<string, object>} name/alias → command module */
const commands = new Map();

/** @type {Map<string, object>} primary name → command module (no aliases) */
const primaryCommands = new Map();

// Load every .js file in this folder except index.js
const dir = __dirname;
for (const file of fs.readdirSync(dir)) {
  if (file === 'index.js' || !file.endsWith('.js')) continue;
  try {
    const cmd = require(path.join(dir, file));
    if (!cmd.name || typeof cmd.execute !== 'function') continue;
    primaryCommands.set(cmd.name, cmd);
    commands.set(cmd.name, cmd);
    if (Array.isArray(cmd.aliases)) {
      for (const alias of cmd.aliases) commands.set(alias, cmd);
    }
  } catch (e) {
    console.error(`[commands] Failed to load ${file}:`, e.message);
  }
}

module.exports = {
  /** Resolve a command by name or alias */
  get(name) { return commands.get(name); },

  /** Iterable of all unique command modules (by primary name) */
  all() { return [...primaryCommands.values()]; },

  /** Check if a command exists */
  has(name) { return commands.has(name); },
};
