const mongoose = require('mongoose');
const dns = require('dns');

// Use Google DNS directly for SRV lookups required by mongodb+srv://.
// Some OS DNS resolvers (e.g. Windows stub resolver) silently drop SRV queries.
// Google DNS (8.8.8.8) is public infrastructure — safe on all machines and in production.
dns.setServers(['8.8.8.8', '8.8.4.4']);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log(`MongoDB Connected: ${mongoose.connection.host}`);
  } catch (error) {
    console.error(`MongoDB connection failed. Retrying in 5s...`, error.message);
    setTimeout(connectDB, 5000);
  }
};

module.exports = connectDB;
