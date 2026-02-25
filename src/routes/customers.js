const express = require('express');
const { body, validationResult } = require('express-validator');
const Customer = require('../models/Customer');
const Job = require('../models/Job');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../config/constants');

const router = express.Router();

router.use(authenticate);

// ── GET /api/customers ─ list all customers ─────────────────────────
router.get(
  '/',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
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

// ── GET /api/customers/:id ─ single customer + linked jobs ──────────
router.get(
  '/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const customer = await Customer.findById(req.params.id);
      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      // Find jobs linked to this customer (via customer ref OR legacy customerName)
      const jobs = await Job.find({
        $or: [
          { customer: customer._id },
          { customerName: customer.name, customer: { $exists: false } },
        ],
      })
        .populate('assignedTechnician', 'name email')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .select('title status scheduledDate assignedTechnician createdBy companyName createdAt');

      res.json({ success: true, data: { customer, jobs } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/customers ─ create new customer ───────────────────────
router.post(
  '/',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('name').notEmpty().withMessage('Customer name is required').trim(),
    body('phone').optional().trim(),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Invalid email').normalizeEmail(),
    body('address').optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const customer = await Customer.create({
        name: req.body.name,
        phone: req.body.phone || '',
        email: req.body.email || '',
        address: req.body.address || '',
      });

      res.status(201).json({ success: true, data: customer });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PUT /api/customers/:id ─ update customer ────────────────────────
router.put(
  '/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('name').optional().notEmpty().withMessage('Name cannot be empty').trim(),
    body('phone').optional().trim(),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Invalid email').normalizeEmail(),
    body('address').optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const customer = await Customer.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true, runValidators: true }
      );

      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      res.json({ success: true, data: customer });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── DELETE /api/customers/:id ─ delete customer ─────────────────────
router.delete(
  '/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const customer = await Customer.findById(req.params.id);
      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      // Check if customer has linked jobs
      const jobCount = await Job.countDocuments({ customer: customer._id });
      if (jobCount > 0) {
        return res.status(400).json({
          success: false,
          error: `Cannot delete customer with ${jobCount} linked job(s). Remove or reassign the jobs first.`,
        });
      }

      await Customer.findByIdAndDelete(req.params.id);
      res.json({ success: true, message: `Customer "${customer.name}" deleted` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = router;
