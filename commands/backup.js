/**
 * backup — Create a timestamped backup of the database file.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

module.exports = {
  name: 'backup',
  aliases: [],
  description: 'Create a timestamped backup of the database',
  usage: '/backup',

  async execute(_args, ctx) {
    const { log } = ctx;
    const { DB_PATH, BASE_DIR } = require('../config');

    const backupDir = path.join(BASE_DIR, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(DB_PATH);
    const backupName = `database-${ts}${ext}`;
    const dest = path.join(backupDir, backupName);

    try {
      fs.copyFileSync(DB_PATH, dest);
      const sizeMB = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
      log.ok(`Backup created: ${backupName} (${sizeMB} MB)`);
      log.info(`  Location: ${dest}`);
    } catch (err) {
      log.error('Backup failed:', err.message);
    }
  },
};
