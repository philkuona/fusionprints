# FusionPrints

WhatsApp-driven photo and poster printing service for Zimbabwe.

This is the backend service. It handles:
- WhatsApp Business API conversations (the customer-facing bot)
- Order management and pricing
- Payment processing (Paynow, Flutterwave)
- Print job dispatch to the on-premises print agent
- Admin dashboard for order management

The print agent (which actually drives the printers) is a separate codebase that runs on the Windows print-server PC — that comes later.

---

## Quick start

**Prerequisites:** WSL2 with Ubuntu, Node 22, PostgreSQL 16, all set up via the dev environment guide.

```bash
# 1. Install dependencies
npm install

# 2. Create your local database
createdb fusionprints_dev

# 3. Copy and edit environment variables
cp .env.example .env
# Then edit .env — most importantly, set DATABASE_URL with your username

# 4. Generate the initial migration (only needed first time)
npx drizzle-kit generate

# 5. Apply the migration
npm run db:migrate

# 6. Seed initial data (the two printers)
npm run db:seed

# 7. Start the dev server
npm run dev
```

If everything worked, you'll see:

```
🚀 Server listening on http://0.0.0.0:3000
📍 Environment: development
💾 Database: postgresql://yourname:***@localhost:5432/fusionprints_dev
🏥 Health check: http://0.0.0.0:3000/health
```

Open http://localhost:3000/health in your browser. You should see `{"status":"ok","database":"connected"}`.

That's the milestone: **server up, database connected.** Tell me when you've reached it.

---

## What's in this codebase right now

```
fusionprints/
├── src/
│   ├── config/
│   │   └── env.ts              # Validated env vars
│   ├── db/
│   │   ├── client.ts           # Database connection pool
│   │   ├── schema.ts           # All tables defined here
│   │   └── migrations/         # Auto-generated SQL migrations
│   ├── utils/
│   │   └── logger.ts           # Pino logger
│   ├── bot/                    # (empty — the WhatsApp bot will live here)
│   ├── routes/                 # (empty — HTTP routes will live here)
│   ├── services/               # (empty — business logic will live here)
│   └── index.ts                # Server entry point
├── scripts/
│   ├── migrate.ts              # Run migrations
│   ├── seed.ts                 # Seed initial data
│   └── reset-db.ts             # Wipe DB (dev only)
├── docs/                       # Documentation as we go
├── .env.example                # Template for .env
├── drizzle.config.ts           # Drizzle ORM config
├── eslint.config.js            # Linting rules
├── package.json
├── tsconfig.json
└── README.md                   # You are here
```

What's deliberately NOT here yet:
- Bot conversation logic (next up)
- Pricing engine (next up)
- WhatsApp integration (after pricing)
- Payment integrations (after WhatsApp)
- Print agent (separate repo, later)
- Admin dashboard (later)

Each piece comes one at a time. We test each before moving on.

---

## Common commands

```bash
npm run dev              # Start dev server with auto-reload
npm run build            # Compile TypeScript to JS (for production)
npm run start            # Run the compiled JS (production)
npm run typecheck        # Verify all types are valid (no compilation)
npm run lint             # Check code for issues
npm run format           # Auto-format with Prettier

npm run db:migrate       # Apply pending migrations
npm run db:seed          # Seed initial data
npm run db:reset         # Drop and recreate the database (dev only)

npx drizzle-kit generate # Generate a new migration after schema changes
npx drizzle-kit studio   # Visual database browser (opens in browser)
```

---

## How to make a schema change

1. Edit `src/db/schema.ts`
2. Run `npx drizzle-kit generate` — produces a new migration file
3. Review the generated SQL in `src/db/migrations/`
4. Run `npm run db:migrate` to apply it
5. Commit the generated migration file to git

**Never edit a migration after it's been applied to a real database.** Create a new one.

---

## Troubleshooting

### "DATABASE_URL is invalid"
Open `.env`, check the format. Should be:
`postgresql://username@localhost:5432/fusionprints_dev`

Find your username with: `whoami`

### "Connection refused" when starting server
Postgres isn't running. Start it: `sudo service postgresql start`

### "Database 'fusionprints_dev' does not exist"
Create it: `createdb fusionprints_dev`

### "Permission denied" on createdb
You're not set up as a Postgres user. Run:
```bash
sudo -u postgres createuser --superuser $USER
```

### Can't access the server from Windows browser
That's fine — `localhost` works because WSL2 forwards ports automatically. If it doesn't, try `http://127.0.0.1:3000` instead.

### TypeScript errors after pulling new code
Run `npm install` to make sure all dependencies are up to date.

---

## What's next

In the next session, we'll build:

1. The pricing engine — pure logic, no external dependencies, easy to test
2. The product catalog — the SKU list as data
3. A simple CLI that lets you simulate the bot conversation flow without WhatsApp yet

Once those work, we wire up the actual WhatsApp integration and your bot is live.
