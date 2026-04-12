const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const log = require('../logger');

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

// Create channel
router.post('/', verifyToken, (req, res) => {
  const { name, description, type } = req.body;

  if (!name || !type) {
    return res.status(400).json({ success: false, message: 'Name and type are required' });
  }

  const channelId = uuidv4();
  // Get the next order number for this type
  db.get(
    'SELECT MAX(`order`) as maxOrder FROM channels WHERE type = ?',
    [type],
    (err, result) => {
      const nextOrder = (result?.maxOrder ?? -1) + 1;
      db.run(
        'INSERT INTO channels (id, name, description, type, creatorId, `order`) VALUES (?, ?, ?, ?, ?, ?)',
        [channelId, name, description || '', type, req.userId, nextOrder],
        function(err) {
          if (err) {
            return res.status(500).json({ success: false, message: err.message });
          }
          // Add creator as channel member
          db.run(
            'INSERT INTO channel_members (id, channelId, userId) VALUES (?, ?, ?)',
            [uuidv4(), channelId, req.userId]
          );
          const newChannel = { id: channelId, name, description, type, order: nextOrder };
          // Broadcast to all connected clients
          io.emit('channel:created', newChannel);
          res.json({ success: true, channel: newChannel });
        }
      );
    }
  );
});

// Get all channels (ordered by type, then by order)
router.get('/', verifyToken, (req, res) => {
  db.all('SELECT * FROM channels ORDER BY type DESC, `order` ASC', (err, channels) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    res.json({ success: true, channels });
  });
});

// Get all unread text channel IDs for the current user
// MUST be before /:channelId to avoid param matching 'unread' as a channelId
router.get('/unread/list', verifyToken, (req, res) => {
  db.all(
    `SELECT DISTINCT m.channelId FROM messages m
     JOIN channels c ON c.id = m.channelId
     LEFT JOIN channel_reads cr ON cr.channelId = m.channelId AND cr.userId = ?
     WHERE c.type = 'text'
       AND m.createdAt > COALESCE(cr.lastReadAt, '1970-01-01')
       AND m.userId != ?`,
    [req.userId, req.userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      const channelIds = rows.map(r => r.channelId);
      res.json({ success: true, channelIds });
    }
  );
});

// Get channel by ID
router.get('/:channelId', verifyToken, (req, res) => {
  db.get('SELECT * FROM channels WHERE id = ?', [req.params.channelId], (err, channel) => {
    if (err || !channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    res.json({ success: true, channel });
  });
});

// Join channel
router.post('/:channelId/join', verifyToken, (req, res) => {
  const memberId = uuidv4();
  db.run(
    'INSERT INTO channel_members (id, channelId, userId) VALUES (?, ?, ?)',
    [memberId, req.params.channelId, req.userId],
    function(err) {
      if (err) {
        return res.status(400).json({ success: false, message: 'Already a member or channel not found' });
      }
      res.json({ success: true, message: 'Joined channel' });
    }
  );
});

// Leave channel
router.post('/:channelId/leave', verifyToken, (req, res) => {
  db.run(
    'DELETE FROM channel_members WHERE channelId = ? AND userId = ?',
    [req.params.channelId, req.userId],
    function(err) {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      res.json({ success: true, message: 'Left channel' });
    }
  );
});

// Get channel members
router.get('/:channelId/members', verifyToken, (req, res) => {
  db.all(
    `SELECT u.identityPublicKey as id, u.username, u.displayName FROM users u
     JOIN channel_members cm ON u.identityPublicKey = cm.userId
     WHERE cm.channelId = ?`,
    [req.params.channelId],
    (err, members) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      res.json({ success: true, members });
    }
  );
});

// Update channel (name and/or description)
router.put('/:channelId', verifyToken, (req, res) => {
  const { name, description } = req.body;
  
  // Check if channel exists
  db.get('SELECT id FROM channels WHERE id = ?', [req.params.channelId], (err, channel) => {
    if (err || !channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    
    const updates = [];
    const values = [];
    
    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }
    
    values.push(req.params.channelId);
    const query = `UPDATE channels SET ${updates.join(', ')} WHERE id = ?`;
    
    db.run(query, values, function(err) {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      // Broadcast to all connected clients
      io.emit('channel:updated', { id: req.params.channelId, name, description });
      res.json({ success: true, message: 'Channel updated' });
    });
  });
});

// Reorder channel
router.put('/:channelId/reorder', verifyToken, (req, res) => {
  const { newIndex, type } = req.body;
  
  if (newIndex === undefined || !type) {
    return res.status(400).json({ success: false, message: 'newIndex and type are required' });
  }

  // Get the channel's current position
  db.get('SELECT `order`, type FROM channels WHERE id = ?', [req.params.channelId], (err, channel) => {
    if (err || !channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }

    const oldIndex = channel.order;
    const oldType = channel.type;

    // If type is changing, treat it as removing from old type and adding to new type
    if (oldType !== type) {
      // Remove from old type
      db.run(
        'UPDATE channels SET `order` = `order` - 1 WHERE type = ? AND `order` > ?',
        [oldType, oldIndex],
        (err) => {
          if (err) {
            return res.status(500).json({ success: false, message: err.message });
          }
          // Shift new type channels
          db.run(
            'UPDATE channels SET `order` = `order` + 1 WHERE type = ? AND `order` >= ?',
            [type, newIndex],
            (err) => {
              if (err) {
                return res.status(500).json({ success: false, message: err.message });
              }
              // Update the channel
              db.run(
                'UPDATE channels SET `order` = ?, type = ? WHERE id = ?',
                [newIndex, type, req.params.channelId],
                function(err) {
                  if (err) {
                    return res.status(500).json({ success: false, message: err.message });
                  }
                  // Broadcast to all connected clients
                  io.emit('channel:reordered');
                  res.json({ success: true, message: 'Channel reordered' });
                }
              );
            }
          );
        }
      );
    } else {
      // Same type, just reorder
      if (newIndex > oldIndex) {
        // Moving down
        db.run(
          'UPDATE channels SET `order` = `order` - 1 WHERE type = ? AND `order` > ? AND `order` <= ?',
          [type, oldIndex, newIndex],
          (err) => {
            if (err) {
              return res.status(500).json({ success: false, message: err.message });
            }
            db.run(
              'UPDATE channels SET `order` = ? WHERE id = ?',
              [newIndex, req.params.channelId],
              function(err) {
                if (err) {
                  return res.status(500).json({ success: false, message: err.message });
                }
                // Broadcast to all connected clients
                io.emit('channel:reordered');
                res.json({ success: true, message: 'Channel reordered' });
              }
            );
          }
        );
      } else {
        // Moving up
        db.run(
          'UPDATE channels SET `order` = `order` + 1 WHERE type = ? AND `order` >= ? AND `order` < ?',
          [type, newIndex, oldIndex],
          (err) => {
            if (err) {
              return res.status(500).json({ success: false, message: err.message });
            }
            db.run(
              'UPDATE channels SET `order` = ? WHERE id = ?',
              [newIndex, req.params.channelId],
              function(err) {
                if (err) {
                  return res.status(500).json({ success: false, message: err.message });
                }
                // Broadcast to all connected clients
                io.emit('channel:reordered');
                res.json({ success: true, message: 'Channel reordered' });
              }
            );
          }
        );
      }
    }
  });
});

// Delete channel
router.delete('/:channelId', verifyToken, (req, res) => {
  // Check if channel exists
  db.get('SELECT id FROM channels WHERE id = ?', [req.params.channelId], (err, channel) => {
    if (err || !channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    
    // Delete channel members first
    db.run('DELETE FROM channel_members WHERE channelId = ?', [req.params.channelId], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      
      // Delete messages
      db.run('DELETE FROM messages WHERE channelId = ?', [req.params.channelId], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: err.message });
        }
        
        // Delete channel read tracking
        db.run('DELETE FROM channel_reads WHERE channelId = ?', [req.params.channelId], (err) => {
          if (err) {
            // Non-critical, continue with channel deletion
            log.error('Failed to delete channel_reads:', err);
          }
          
          // Delete channel
          db.run('DELETE FROM channels WHERE id = ?', [req.params.channelId], function(err) {
            if (err) {
              return res.status(500).json({ success: false, message: err.message });
            }
            // Broadcast to all connected clients
            io.emit('channel:deleted', { id: req.params.channelId });
            res.json({ success: true, message: 'Channel deleted' });
          });
        });
      });
    });
  });
});

// Mark a channel as read for the current user
router.put('/:channelId/read', verifyToken, (req, res) => {
  db.run(
    `INSERT INTO channel_reads (userId, channelId, lastReadAt) VALUES (?, ?, datetime('now'))
     ON CONFLICT(userId, channelId) DO UPDATE SET lastReadAt = datetime('now')`,
    [req.userId, req.params.channelId],
    function(err) {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      res.json({ success: true });
    }
  );
});

  return router;
};
