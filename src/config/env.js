/**
 * Environment loader with local-override support.
 *
 * Load order (first value wins — dotenv never overwrites a variable
 * that is already set):
 *   1. .env.local  — developer machine overrides (gitignored, never deployed)
 *   2. .env        — canonical configuration
 *
 * Require this ONCE at the top of every entry point (server, scripts)
 * instead of calling require('dotenv').config() directly.
 */
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..', '..');

dotenv.config({ path: path.join(ROOT, '.env.local') }); // optional, wins when present
dotenv.config({ path: path.join(ROOT, '.env') });
