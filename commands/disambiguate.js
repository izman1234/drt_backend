/**
 * Shared helper for console commands that need to pick a single user
 * when multiple users share the same username.
 *
 * Returns the chosen user row, or null if cancelled / not found.
 */
'use strict';

/**
 * Look up users by username.  If exactly one match, return it.
 * If multiple, display a numbered list and prompt the operator to pick.
 *
 * @param {object}   db          sqlite3 Database instance
 * @param {string}   username    The username to search for
 * @param {object}   log         Logger instance
 * @returns {Promise<object|null>}  User row with identityPublicKey, username, displayName (or null)
 */
async function disambiguateUser(db, username, log) {
  const rows = await new Promise((resolve, reject) =>
    db.all(
      'SELECT identityPublicKey, username, displayName FROM users WHERE username = ? AND leftServer = 0',
      [username],
      (err, rows) => (err ? reject(err) : resolve(rows))
    )
  );

  if (rows.length === 0) {
    log.warn(`User "@${username}" not found.`);
    return null;
  }

  if (rows.length === 1) return rows[0];

  // Multiple users share this username — ask the operator to pick
  console.log('');
  console.log(`  Multiple users found with username "@${username}":`);
  console.log('');
  for (let i = 0; i < rows.length; i++) {
    const u = rows[i];
    const pk = u.identityPublicKey;
    const short = pk.length > 12 ? pk.slice(0, 6) + '…' + pk.slice(-6) : pk;
    console.log(`  [${i + 1}] ${u.displayName} \x1b[90m(key: ${short})\x1b[0m`);
  }
  console.log(`  [0] Cancel`);
  console.log('');

  const { askQuestion } = require('../console');
  const answer = await askQuestion('  Select a user by number: ');
  const idx = parseInt(answer, 10);

  if (isNaN(idx) || idx < 1 || idx > rows.length) {
    log.info('Cancelled.');
    return null;
  }

  return rows[idx - 1];
}

module.exports = { disambiguateUser };
