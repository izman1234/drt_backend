const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { verifyStringSignature } = require('../crypto');
const log = require('../logger');
const { encrypt, decrypt } = require('../encryption');

const { JWT_SECRET } = require('../config');

// Helper: decrypt encrypted fields in a message row from the DB
function decryptMessage(msg) {
  if (!msg) return msg;
  if (msg.content) msg.content = decrypt(msg.content);
  if (msg.image) {
    const decrypted = decrypt(msg.image);
    try {
      msg.image = JSON.parse(decrypted);
    } catch {
      // Legacy single-image format
      msg.image = [decrypted];
    }
  }
  // Also decrypt replied-to message fields
  if (msg.repliedToContent) msg.repliedToContent = decrypt(msg.repliedToContent);
  if (msg.repliedToImage) {
    const decrypted = decrypt(msg.repliedToImage);
    try {
      msg.repliedToImage = JSON.parse(decrypted);
    } catch {
      msg.repliedToImage = [decrypted];
    }
  }
  return msg;
}

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

// Middleware to reject banned users (runs after verifyToken)
const checkBan = (req, res, next) => {
  db.get('SELECT 1 FROM bans WHERE publicKey = ?', [req.userId], (_err, ban) => {
    if (ban) return res.status(403).json({ success: false, message: 'You are banned from this server' });
    next();
  });
};

module.exports = (io) => {
  const router = express.Router();

  // Send message
  router.post('/', verifyToken, checkBan, (req, res) => {
    const { channelId, content, image, images, replyTo, signature, signingPayload } = req.body;

    if (!channelId) {
      return res.status(400).json({ success: false, message: 'Channel ID is required' });
    }

    // Normalize images: accept `images` array or legacy `image` string
    let imageArray = null;
    if (images && Array.isArray(images) && images.length > 0) {
      imageArray = images.slice(0, 10);
    } else if (image) {
      imageArray = [image];
    }

    if (!content && !imageArray) {
      return res.status(400).json({ success: false, message: 'Message content or image is required' });
    }

    // If signature is provided, optionally verify it server-side
    const verifyAndStore = (sig) => {
      const messageId = uuidv4();
      // Encrypt message content and image at rest
      const encContent = encrypt(content || '');
      const encImage = imageArray ? encrypt(JSON.stringify(imageArray)) : null;
      db.run(
        'INSERT INTO messages (id, channelId, userId, content, image, replyTo, signature) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [messageId, channelId, req.userId, encContent, encImage, replyTo || null, sig || null],
      function(err) {
          if (err) {
            log.error('Error saving message:', err);
            return res.status(500).json({ success: false, message: err.message });
          }
          
          // Verify the message was actually inserted by querying back
          db.get(
            'SELECT id FROM messages WHERE id = ?',
            [messageId],
            (verifyErr, row) => {
              if (verifyErr || !row) {
                return res.status(500).json({ success: false, message: 'Message failed to persist' });
              }
              
              // Fetch the newly created message with user details
              db.get(
                `SELECT m.id, m.content, m.image, m.createdAt, m.edited_at, m.replyTo, m.signature,
                        u.username, u.displayName, u.identityPublicKey as userId, u.nameColor, u.profilePicture, u.identityPublicKey,
                        rm.id as repliedToId, rm.content as repliedToContent, rm.image as repliedToImage,
                        ru.identityPublicKey as repliedToUserId, ru.username as repliedToUser, ru.displayName as repliedToDisplay, ru.nameColor as repliedToNameColor, ru.profilePicture as repliedToProfilePicture
                 FROM messages m
                 JOIN users u ON m.userId = u.identityPublicKey
                 LEFT JOIN messages rm ON m.replyTo = rm.id
                 LEFT JOIN users ru ON rm.userId = ru.identityPublicKey
                 WHERE m.id = ?`,
                [messageId],
                (fetchErr, message) => {
                  if (!fetchErr && message) {
                    decryptMessage(message);
                    // Broadcast the new message to all users in the channel
                    io.emit('message:created', { channelId, message });
                    res.json({ success: true, messageId });
                  } else {
                    log.error('Error fetching saved message:', fetchErr);
                    res.json({ success: true, messageId });
                  }
                }
              );
            }
          );
        }
      );
    };

    // If a signature and signingPayload are provided, verify server-side before storing
    if (signature && signingPayload) {
      db.get('SELECT identityPublicKey FROM users WHERE identityPublicKey = ?', [req.userId], async (err, user) => {
        if (!err && user && user.identityPublicKey) {
          const isValid = await verifyStringSignature(signingPayload, signature, user.identityPublicKey);
          if (!isValid) {
            return res.status(403).json({ success: false, message: 'Message signature verification failed' });
          }
        }
        // Store with signature even if we can't verify (legacy user without public key)
        verifyAndStore(signature);
      });
    } else {
      verifyAndStore(null);
    }
  });

  // Get messages for channel with pagination
  router.get('/channel/:channelId', verifyToken, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 per request
    const latest = req.query.latest === 'true'; // Load newest or oldest
    const beforeRowId = req.query.beforeRowId; // Use rowid for pagination (more reliable than timestamp)
    
    let query = `SELECT m.rowid, m.id, m.content, m.image, m.createdAt, m.edited_at, m.replyTo, m.signature,
                        u.username, u.displayName, u.identityPublicKey as userId, u.nameColor, u.profilePicture, u.identityPublicKey,
                        rm.id as repliedToId, rm.content as repliedToContent, rm.image as repliedToImage,
                        ru.identityPublicKey as repliedToUserId, ru.username as repliedToUser, ru.displayName as repliedToDisplay, ru.nameColor as repliedToNameColor, ru.profilePicture as repliedToProfilePicture
                 FROM messages m
                 JOIN users u ON m.userId = u.identityPublicKey
                 LEFT JOIN messages rm ON m.replyTo = rm.id
                 LEFT JOIN users ru ON rm.userId = ru.identityPublicKey
                 WHERE m.channelId = ?`;
    
    const params = [req.params.channelId];
    
    if (beforeRowId) {
      query += ` AND m.rowid < ?`;
      params.push(parseInt(beforeRowId));
    }
    
    // For pagination, always use DESC to get newest messages relative to cursor
    // Then reverse in response if needed
    const orderBy = 'DESC';
    query += ` ORDER BY m.rowid ${orderBy} LIMIT ?`;
    params.push(limit);
    
    db.all(query, params, (err, messages) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      // Always reverse to show oldest first in display
      messages.reverse();

      // Decrypt message content and images
      messages.forEach(decryptMessage);
      
      // Fetch reactions for all messages
      if (messages.length === 0) {
        return res.json({ success: true, messages });
      }
      
      const messageIds = messages.map(m => m.id);
      const placeholders = messageIds.map(() => '?').join(',');
      
      db.all(
        `SELECT emoji, messageId, COUNT(*) as count, GROUP_CONCAT(r.userId) as userIds, GROUP_CONCAT(u.displayName) as userNames
         FROM reactions r
         JOIN users u ON r.userId = u.identityPublicKey
         WHERE r.messageId IN (${placeholders})
         GROUP BY messageId, emoji
         ORDER BY r.createdAt ASC`,
        messageIds,
        (reactErr, reactions) => {
          if (!reactErr && reactions) {
            // Group reactions by messageId
            const reactionsMap = {};
            reactions.forEach(r => {
              if (!reactionsMap[r.messageId]) {
                reactionsMap[r.messageId] = [];
              }
              reactionsMap[r.messageId].push({
                emoji: r.emoji,
                count: r.count,
                userIds: r.userIds.split(','),
                userNames: r.userNames.split(',')
              });
            });
            
            // Add reactions to messages
            messages = messages.map(m => ({
              ...m,
              reactions: reactionsMap[m.id] || []
            }));
          } else {
            // No reactions found, add empty array
            messages = messages.map(m => ({
              ...m,
              reactions: []
            }));
          }
          
          res.json({ success: true, messages });
        }
      );
    });
  });

  // Update message
  router.put('/:messageId', verifyToken, checkBan, (req, res) => {
    const { content, removeImage } = req.body;
    
    if (!content) {
      return res.status(400).json({ success: false, message: 'Content is required' });
    }

    db.get('SELECT userId FROM messages WHERE id = ?', [req.params.messageId], (err, message) => {
      if (err || !message) {
        return res.status(404).json({ success: false, message: 'Message not found' });
      }
      if (message.userId !== req.userId) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
      
      // Build update query based on removeImage flag
      let updateQuery = 'UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP';
      const params = [encrypt(content)];
      
      if (removeImage) {
        updateQuery += ', image = NULL';
      }
      
      updateQuery += ' WHERE id = ?';
      params.push(req.params.messageId);
      
      db.run(updateQuery, params, function(err) {
        if (err) {
          return res.status(500).json({ success: false, message: err.message });
        }
        
        // Fetch the updated message with user details
        db.get(
          `SELECT m.id, m.content, m.image, m.createdAt, m.edited_at, m.replyTo,
                  u.username, u.displayName, u.identityPublicKey as userId, u.nameColor, u.profilePicture,
                  rm.id as repliedToId, rm.content as repliedToContent, rm.image as repliedToImage,
                  ru.identityPublicKey as repliedToUserId, ru.username as repliedToUser, ru.displayName as repliedToDisplay, ru.nameColor as repliedToNameColor, ru.profilePicture as repliedToProfilePicture
           FROM messages m
           JOIN users u ON m.userId = u.identityPublicKey
           LEFT JOIN messages rm ON m.replyTo = rm.id
           LEFT JOIN users ru ON rm.userId = ru.identityPublicKey
           WHERE m.id = ?`,
          [req.params.messageId],
          (fetchErr, updatedMessage) => {
            if (!fetchErr && updatedMessage) {
              decryptMessage(updatedMessage);
              io.emit('message:updated', { message: updatedMessage });
              res.json({ success: true, message: updatedMessage });
            } else {
              res.json({ success: true, message: { id: req.params.messageId } });
            }
          }
        );
      });
    });
  });

  // Delete message
  router.delete('/:messageId', verifyToken, checkBan, (req, res) => {
    db.get('SELECT userId, channelId FROM messages WHERE id = ?', [req.params.messageId], (err, message) => {
      if (err || !message) {
        return res.status(404).json({ success: false, message: 'Message not found' });
      }
      if (message.userId !== req.userId) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
      
      db.run('DELETE FROM messages WHERE id = ?', [req.params.messageId], function(err) {
        if (err) {
          return res.status(500).json({ success: false, message: err.message });
        }
        io.emit('message:deleted', { messageId: req.params.messageId, channelId: message.channelId });
        res.json({ success: true, message: 'Message deleted' });
      });
    });
  });

  return router;
};
