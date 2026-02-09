# Hosanna Backend - Field Service Management API

## Architecture

```
backend/
├── src/
│   ├── config/
│   │   ├── db.js           # MongoDB connection
│   │   └── constants.js    # Roles, statuses, transitions
│   ├── middleware/
│   │   ├── auth.js         # JWT auth & role authorization
│   │   └── errorHandler.js # Global error handling
│   ├── models/
│   │   ├── User.js         # User model with roles
│   │   └── Job.js          # Job model with status history
│   ├── routes/
│   │   ├── auth.js         # Login/register endpoints
│   │   ├── jobs.js         # Job CRUD & status transitions
│   │   └── users.js        # User management
│   ├── services/
│   │   └── JobService.js   # Atomic job operations & validation
│   ├── scripts/
│   │   └── seed.js         # Database seeding
│   └── server.js           # Express app entry point
├── .env                    # Environment variables
└── package.json
```

## Job Status Flow

```
TENTATIVE → CONFIRMED → ASSIGNED → DISPATCHED → IN_PROGRESS → COMPLETED → BILLED
   │            │           │           │              │             │
   └── ADMIN ───┴── ADMIN ──┘           │              │             │
                                        │              │             │
                          OFFICE_MANAGER ┘              │             │
                                                       │             │
                                          TECHNICIAN ──┴─────────────┘
                                                                     │
                                                   OFFICE_MANAGER ───┘
```

### Visibility Rules
- **ADMIN** — sees all jobs in every status
- **OFFICE_MANAGER** — sees CONFIRMED and above (TENTATIVE hidden)
- **TECHNICIAN** — sees only their assigned jobs from DISPATCHED onward

## Roles & Permissions

| Action | ADMIN | OFFICE_MANAGER | TECHNICIAN |
|--------|-------|----------------|------------|
| Create Job | ✅ | ❌ | ❌ |
| Confirm Job (TENTATIVE → CONFIRMED) | ✅ | ❌ | ❌ |
| Assign Technician (CONFIRMED → ASSIGNED) | ✅ | ❌ | ❌ |
| Dispatch Job (ASSIGNED → DISPATCHED) | ❌ | ✅ | ❌ |
| Start Job (DISPATCHED → IN_PROGRESS) | ❌ | ❌ | ✅ |
| Complete Job (IN_PROGRESS → COMPLETED) | ❌ | ❌ | ✅ |
| Bill Job (COMPLETED → BILLED) | ❌ | ✅ | ❌ |
| View All Jobs | ✅ | ✅ (excl. TENTATIVE) | ❌ |
| View Assigned Jobs | ✅ | ✅ | ✅ (DISPATCHED+) |

## Setup

1. **Install dependencies:**
   ```bash
   cd backend
   pnpm install
   ```

2. **Configure environment:**
   ```bash
   # Edit .env file with your MongoDB URI
   MONGODB_URI=mongodb://localhost:27017/hosanna_fsm
   JWT_SECRET=your-secret-key
   ```

3. **Seed the database:**
   ```bash
   pnpm run seed
   ```

4. **Start the server:**
   ```bash
   pnpm run dev
   ```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user

### Jobs
- `GET /api/jobs` - List jobs (filtered by role)
- `GET /api/jobs/:id` - Get job details
- `POST /api/jobs` - Create job (ADMIN)
- `PATCH /api/jobs/:id/status` - Update job status
- `PATCH /api/jobs/:id/assign` - Assign technician (ADMIN)
- `PUT /api/jobs/:id` - Update job details
- `GET /api/jobs/:id/history` - Get status history

### Users
- `GET /api/users` - List users (ADMIN)
- `GET /api/users/technicians` - List technicians

## Test Credentials

| Role | Email | Password |
|------|-------|----------|
| ADMIN | admin@hosanna.com | admin123 |
| OFFICE_MANAGER | manager@hosanna.com | manager123 |
| TECHNICIAN | tech1@hosanna.com | tech123 |
| TECHNICIAN | tech2@hosanna.com | tech123 |
