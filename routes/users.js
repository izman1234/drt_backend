const express = require('express');
const jwt = require('jsonwebtoken');
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

  // Get user profile
  router.get('/profile', verifyToken, (req, res) => {
    db.get('SELECT id, username, displayName, isOnline, profilePicture, nameColor, createdAt FROM users WHERE id = ?', [req.userId], (err, user) => {
      if (err || !user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      res.json({ success: true, user });
    });
  });

  // Update display name
  router.put('/displayName', verifyToken, (req, res) => {
    const { displayName } = req.body;
    
    if (!displayName) {
      return res.status(400).json({ success: false, message: 'Display name is required' });
    }

    // Helper function to find an available displayName
    const findAvailableDisplayName = (baseName, callback) => {
      const checkName = (name, suffix) => {
        const candidateName = suffix === 0 ? name : `${name}_${suffix}`;
        
        db.get(
          'SELECT id FROM users WHERE LOWER(displayName) = LOWER(?) AND id != ?',
          [candidateName, req.userId],
          (err, row) => {
            if (err) {
              return callback(null, err);
            }
            
            if (!row) {
              // Name is available
              callback(candidateName, null);
            } else {
              // Name is taken, try next suffix
              checkName(baseName, suffix + 1);
            }
          }
        );
      };
      
      checkName(baseName, 0);
    };

    findAvailableDisplayName(displayName, (finalName, err) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }

      db.run(
        'UPDATE users SET displayName = ? WHERE id = ?',
        [finalName, req.userId],
        function(err) {
          if (err) {
            return res.status(500).json({ success: false, message: err.message });
          }
          
          // Broadcast updated user list to all connected clients
          if (io.broadcastUserList) {
            io.broadcastUserList();
          }

          // Emit display name update so clients can patch loaded messages
          io.emit('user:displayName-updated', { userId: req.userId, displayName: finalName });
          
          // Also broadcast all active voice room members since display name changed
          if (io.broadcastAllVoiceRoomMembers) {
            io.broadcastAllVoiceRoomMembers();
          }
          
          res.json({ success: true, message: 'Display name updated', displayName: finalName });
        }
      );
    });
  });

  // Update profile picture
  router.put('/profilePicture', verifyToken, (req, res) => {
    const { profilePicture } = req.body;
    
    if (!profilePicture) {
      return res.status(400).json({ success: false, message: 'Profile picture is required' });
    }

    db.run(
      'UPDATE users SET profilePicture = ? WHERE id = ?',
      [profilePicture, req.userId],
      function(err) {
        if (err) {
          return res.status(500).json({ success: false, message: err.message });
        }
        
        // Broadcast updated user list so everyone sees the new profile picture
        if (io.broadcastUserList) {
          io.broadcastUserList();
        }
        
        // Also broadcast all active voice room members
        if (io.broadcastAllVoiceRoomMembers) {
          io.broadcastAllVoiceRoomMembers();
        }
        
        res.json({ success: true, message: 'Profile picture updated' });
      }
    );
  });

  // Update name color
  router.put('/nameColor', verifyToken, (req, res) => {
    const { nameColor } = req.body;
    
    if (!nameColor) {
      return res.status(400).json({ success: false, message: 'Name color is required' });
    }

    db.run(
      'UPDATE users SET nameColor = ? WHERE id = ?',
      [nameColor, req.userId],
      function(err) {
        if (err) {
          return res.status(500).json({ success: false, message: err.message });
        }
        
        // Emit socket event so other clients see the color change in real-time
        io.emit('user:nameColor-updated', { userId: req.userId, nameColor });
        
        // Broadcast updated user list so everyone sees the new name color
        if (io.broadcastUserList) {
          io.broadcastUserList();
        }
        
        // Also broadcast all active voice room members
        if (io.broadcastAllVoiceRoomMembers) {
          io.broadcastAllVoiceRoomMembers();
        }
        
        res.json({ success: true, message: 'Name color updated' });
      }
    );
  });

  // Get all users
  router.get('/all', verifyToken, (req, res) => {
    db.all('SELECT id, username, displayName, isOnline, profilePicture, nameColor, status FROM users WHERE leftServer = 0 ORDER BY username', (err, users) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      // Derive isOnline from status to match broadcastUserList behavior
      const merged = (users || []).map(u => ({
        ...u,
        isOnline: u.status === 'online' || u.status === 'away'
      }));
      res.json({ success: true, users: merged });
    });
  });

  // Leave server — mark user as left (messages preserved)
  router.delete('/leave', verifyToken, (req, res) => {
    const userId = req.userId;

    db.run('UPDATE users SET leftServer = 1, isOnline = 0 WHERE id = ?', [userId], function(err) {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }

      // Broadcast updated user list
      if (io.broadcastUserList) {
        io.broadcastUserList();
      }

      res.json({ success: true, message: 'Left server successfully' });
    });
  });

  return router;
};
