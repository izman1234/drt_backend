const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const log = require('../logger');

const KLIPY_API_URL = 'https://api.klipy.com/api/v1';

module.exports = (io) => {
  const router = express.Router();

  // Middleware to check if Klipy API key is configured
  const checkKlipyKey = (req, res, next) => {
    if (!config.KLIPY_API_KEY) {
      return res.status(503).json({ 
        error: 'GIF service not configured for this server', 
        message: 'Server administrator has not configured Klipy API key' 
      });
    }
    next();
  };

  // Generate a consistent customer_id for this session (required by Klipy)
  const getCustomerId = (req) => {
    // Use user ID if available, otherwise use a session-based ID
    if (req.userId) {
      return req.userId.toString();
    }
    // Fallback to a hash of IP address
    const ip = req.ip || 'anonymous';
    return crypto.createHash('md5').update(ip).digest('hex');
  };

  // Search for GIFs
  router.get('/search', checkKlipyKey, async (req, res) => {
    try {
      const { q, page = 1, per_page = 24 } = req.query;
      
      if (!q || q.trim().length === 0) {
        return res.status(400).json({ error: 'Search query is required' });
      }

      const customerId = getCustomerId(req);

      const response = await axios.get(
        `${KLIPY_API_URL}/${config.KLIPY_API_KEY}/gifs/search`,
        {
          params: {
            q,
            page,
            per_page,
            customer_id: customerId,
            locale: 'us'
          }
        }
      );

      res.json(response.data);
    } catch (error) {
      log.error('Error searching GIFs:', error.message);
      res.status(500).json({ error: 'Failed to search GIFs' });
    }
  });

  // Get trending GIFs
  router.get('/trending', checkKlipyKey, async (req, res) => {
    try {
      const { page = 1, per_page = 24 } = req.query;
      const customerId = getCustomerId(req);

      const response = await axios.get(
        `${KLIPY_API_URL}/${config.KLIPY_API_KEY}/gifs/trending`,
        {
          params: {
            page,
            per_page,
            customer_id: customerId,
            locale: 'us'
          }
        }
      );

      res.json(response.data);
    } catch (error) {
      log.error('Error fetching trending GIFs:', error.message);
      res.status(500).json({ error: 'Failed to fetch trending GIFs' });
    }
  });

  // Get GIF categories
  router.get('/categories', checkKlipyKey, async (req, res) => {
    try {
      const response = await axios.get(
        `${KLIPY_API_URL}/${config.KLIPY_API_KEY}/gifs/categories`,
        {
          params: {
            locale: 'en_US'
          }
        }
      );

      res.json(response.data);
    } catch (error) {
      log.error('Error fetching categories:', error.message);
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  // Get GIFs by category (using search with category name)
  router.get('/category/:categoryName', checkKlipyKey, async (req, res) => {
    try {
      const { categoryName } = req.params;
      const { page = 1, per_page = 24 } = req.query;
      const customerId = getCustomerId(req);

      const response = await axios.get(
        `${KLIPY_API_URL}/${config.KLIPY_API_KEY}/gifs/search`,
        {
          params: {
            q: categoryName,
            page,
            per_page,
            customer_id: customerId,
            locale: 'us'
          }
        }
      );

      res.json(response.data);
    } catch (error) {
      log.error('Error fetching category GIFs:', error.message);
      res.status(500).json({ error: 'Failed to fetch category GIFs' });
    }
  });

  return router;
};

