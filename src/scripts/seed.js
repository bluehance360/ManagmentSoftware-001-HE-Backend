/**
 * Database Seed Script
 * Creates test users for each role
 * 
 * Run: npm run seed
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { ROLES } = require('../config/constants');

const seedUsers = [
  {
    email: 'admin@hosanna.com',
    password: 'admin123',
    name: 'Admin User',
    role: ROLES.ADMIN,
  },
  {
    email: 'manager@hosanna.com',
    password: 'manager123',
    name: 'Office Manager',
    role: ROLES.OFFICE_MANAGER,
  },
  {
    email: 'tech1@hosanna.com',
    password: 'tech123',
    name: 'John Tech',
    role: ROLES.TECHNICIAN,
  },
  {
    email: 'tech2@hosanna.com',
    password: 'tech123',
    name: 'Jane Tech',
    role: ROLES.TECHNICIAN,
  },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Clear existing users
    await User.deleteMany({});
    console.log('Cleared existing users');

    // Create users
    const createdUsers = await User.create(seedUsers);
    console.log('\nCreated users:');
    createdUsers.forEach((user) => {
      console.log(`  - ${user.name} (${user.email}) - Role: ${user.role}`);
    });

    console.log('\n✅ Seed completed successfully!');
    console.log('\nTest credentials:');
    console.log('  Admin:    admin@hosanna.com / admin123');
    console.log('  Manager:  manager@hosanna.com / manager123');
    console.log('  Tech 1:   tech1@hosanna.com / tech123');
    console.log('  Tech 2:   tech2@hosanna.com / tech123');

    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
