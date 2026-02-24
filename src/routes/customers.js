const express = require('express');
const Customer = require('../models/Customer');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../config/constants');

const router = express.Router();

router.use(authenticate);

// ── GET /api/customers ─ list all customers (for dropdown) ──────────
router.get(
  '/',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (_req, res) => {
    try {
      const customers = await Customer.find()
        .sort({ name: 1 })
        .select('name phone email address');
      res.json({ success: true, data: customers });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = router;
