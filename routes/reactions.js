const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');

const { JWT_SECRET } = require('../config');

// Middleware to verify token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

module.exports = (io) => {
  const router = express.Router();

  // Add reaction to message
  router.post('/:messageId', verifyToken, (req, res) => {
    const { emoji } = req.body;
    const messageId = req.params.messageId;

    if (!emoji) {
      return res.status(400).json({ success: false, message: 'Emoji is required' });
    }

    // Check if message exists
    db.get('SELECT id FROM messages WHERE id = ?', [messageId], (err, message) => {
      if (err || !message) {
        return res.status(404).json({ success: false, message: 'Message not found' });
      }

      // Add reaction (will ignore if already exists due to UNIQUE constraint)
      const reactionId = uuidv4();
      db.run(
        'INSERT OR IGNORE INTO reactions (id, messageId, userId, emoji) VALUES (?, ?, ?, ?)',
        [reactionId, messageId, req.userId, emoji],
        function(err) {
          if (err) {
            return res.status(500).json({ success: false, message: err.message });
          }

          // Fetch updated reactions for the message
          db.all(
            `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(u.identityPublicKey) as userIds, GROUP_CONCAT(u.displayName) as userNames
             FROM reactions r
             JOIN users u ON r.userId = u.identityPublicKey
             WHERE r.messageId = ?
             GROUP BY emoji
             ORDER BY r.createdAt ASC`,
            [messageId],
            (fetchErr, reactions) => {
              if (!fetchErr && reactions) {
                const reactionsData = reactions.map(r => ({
                  emoji: r.emoji,
                  count: r.count,
                  userIds: r.userIds.split(','),
                  userNames: r.userNames.split(',')
                }));
                io.emit('reaction:added', { messageId, reactions: reactionsData });
                res.json({ success: true, reactions: reactionsData });
              } else {
                res.json({ success: true });
              }
            }
          );
        }
      );
    });
  });

  // Remove reaction from message
  router.delete('/:messageId/:emoji', verifyToken, (req, res) => {
    const { messageId, emoji } = req.params;

    db.run(
      'DELETE FROM reactions WHERE messageId = ? AND userId = ? AND emoji = ?',
      [messageId, req.userId, emoji],
      function(err) {
        if (err) {
          return res.status(500).json({ success: false, message: err.message });
        }

        // Check if any reactions remain for this emoji on this message
        db.get(
          'SELECT COUNT(*) as count FROM reactions WHERE messageId = ? AND emoji = ?',
          [messageId, emoji],
          (checkErr, row) => {
            if (row && row.count === 0) {
              // No more reactions with this emoji, fetch all remaining reactions
              db.all(
                `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(u.identityPublicKey) as userIds, GROUP_CONCAT(u.displayName) as userNames
                 FROM reactions r
                 JOIN users u ON r.userId = u.identityPublicKey
                 WHERE r.messageId = ?
                 GROUP BY emoji
                 ORDER BY r.createdAt ASC`,
                [messageId],
                (fetchErr, reactions) => {
                  if (!fetchErr && reactions) {
                    const reactionsData = reactions.map(r => ({
                      emoji: r.emoji,
                      count: r.count,
                      userIds: r.userIds.split(','),
                      userNames: r.userNames.split(',')
                    }));
                    io.emit('reaction:removed', { messageId, reactions: reactionsData });
                    res.json({ success: true, reactions: reactionsData });
                  } else {
                    io.emit('reaction:removed', { messageId, reactions: [] });
                    res.json({ success: true, reactions: [] });
                  }
                }
              );
            } else {
              // Fetch remaining reactions
              db.all(
                `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(u.identityPublicKey) as userIds, GROUP_CONCAT(u.displayName) as userNames
                 FROM reactions r
                 JOIN users u ON r.userId = u.identityPublicKey
                 WHERE r.messageId = ?
                 GROUP BY emoji
                 ORDER BY r.createdAt ASC`,
                [messageId],
                (fetchErr, reactions) => {
                  if (!fetchErr && reactions) {
                    const reactionsData = reactions.map(r => ({
                      emoji: r.emoji,
                      count: r.count,
                      userIds: r.userIds.split(','),
                      userNames: r.userNames.split(',')
                    }));
                    io.emit('reaction:removed', { messageId, reactions: reactionsData });
                    res.json({ success: true, reactions: reactionsData });
                  } else {
                    io.emit('reaction:removed', { messageId, reactions: [] });
                    res.json({ success: true, reactions: [] });
                  }
                }
              );
            }
          }
        );
      }
    );
  });

  return router;
};
