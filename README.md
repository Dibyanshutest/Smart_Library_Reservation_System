# Smart Library System

A Node.js and Express library application with student authentication, book loans, live seat booking, QR entry scanning, penalties, and staff administration.

## Run locally

```powershell
npm install
npm start
```

Open <http://localhost:3000> after the server reports that it is running.

The development command uses nodemon:

```powershell
npm run dev
```

## Default staff account

- Email: `admin@library.com`
- Password: `admin123`

Change this account password before using the application outside local development. The SQLite database is created at `library.db` on first startup and is seeded with a 6 x 8 reading-hall seat map and default settings.

## Main routes

- Student pages: `/register.html`, `/login.html`, `/dashboard.html`, `/catalog.html`, `/seat-map.html`, `/scan.html`
- Staff page: `/admin.html`
- API: `/api/auth`, `/api/books`, `/api/loans`, `/api/seats`, `/api/entry`, `/api/admin`

## Architecture

- `client/`: static HTML, CSS, and vanilla JavaScript
- `server/index.js`: Express REST API and Socket.IO events
- `server/db.js`: SQLite schema and seed data
- `server/jobs/expireHolds.js`: server-side hold expiry and no-show penalties

Seat changes are broadcast through Socket.IO. Seat pages fall back to polling every 10 seconds when the WebSocket connection is unavailable.
