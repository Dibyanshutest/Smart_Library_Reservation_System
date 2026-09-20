# Technical Design Document
## Smart Library Management System

---

## 1. Tech Stack

### Mandatory (front end)
- **HTML5** — structure
- **CSS3** — styling (plain CSS or a utility approach; no framework required)
- **Vanilla JavaScript (ES6+)** — all client-side logic, DOM updates, API calls, WebSocket handling

### Recommended optional (back end — needed for real functionality, not just a static mock)
- **Node.js + Express** — REST API server
- **Socket.io** — real-time seat-map broadcasting (a plain HTML/JS client can consume this easily)
- **SQLite** (via `better-sqlite3` or `sqlite3` npm package) — lightweight file-based database, zero setup, perfect for a student project; swap for MySQL/PostgreSQL later if needed
- **jsQR** or **html5-qrcode** (npm/CDN JS library) — decode QR codes from a webcam feed in-browser
- **qrcode** (npm) or **QRCode.js** (CDN) — generate each student's personal QR code
- **jsonwebtoken (JWT)** — session tokens for login
- **bcrypt** — password hashing
- **node-cron** (or a simple `setInterval` on the server) — background job to expire stale seat holds

> If you'd rather avoid running a Node server at all, the fallback is **Firebase** (Firestore for data + Firebase Auth + Firestore's real-time listeners replace Socket.io). This document assumes the Node/Express/Socket.io/SQLite path since it's the most transparent for learning and for an AI pair-programmer to reason about, but the data model below maps directly onto Firestore collections if you switch.

### Why you can't do this with "HTML/CSS/JS only, no backend at all"
Two features specifically require a server-side source of truth:
- **Live seat map visible to *other* students** — client-side JS alone can't tell Student B that Student A just booked a seat; you need a server (or Firebase) broadcasting updates.
- **Auto-expiry of a 15-minute hold** — this must be enforced by something that runs even when the student's browser tab isn't open, i.e., a server-side timer, not a `setTimeout` in the browser.

Everything else (catalog browsing, UI, QR decoding itself) can technically run client-only, but for a coherent single system, use the backend for all of it.

---

## 2. System Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────┐
│         BROWSER (Client)     │        │        SERVER            │
│  HTML/CSS/JS SPA             │        │  Node.js + Express       │
│                              │◄──HTTP──►│  REST API                │
│  - Login / Register          │  (JSON) │  - Auth (JWT)            │
│  - Book Catalog UI           │        │  - Book CRUD             │
│  - Live Seat Map             │◄─WS────►│  Socket.io               │
│  - QR Scanner (camera)       │ (live   │  - broadcasts seat       │
│  - QR Display (own code)     │  seat   │    state changes         │
│  - Student/Admin Dashboards  │  events)│  - Background cron:      │
│                              │        │    expires stale holds   │
└─────────────────────────────┘        │  - Penalty engine         │
                                        │                           │
                                        │  SQLite DB                │
                                        │  (students, books, seats, │
                                        │   bookings, entry_logs,   │
                                        │   penalties, fines)       │
                                        └──────────────────────────┘
```

**Real-time flow:** every time a seat's status changes (booked, checked-in, expired, checked-out), the server updates the DB *and* emits a Socket.io event (`seat:update`) to all connected clients, who patch their local seat-map UI without a full reload.

---

## 3. Data Model (SQLite schema)

```sql
-- Students / Members
CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id TEXT UNIQUE NOT NULL,      -- e.g. roll number, printed on ID card
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  qr_token TEXT UNIQUE NOT NULL,        -- signed/opaque token encoded in their personal QR
  strikes INTEGER DEFAULT 0,            -- current penalty count
  cooldown_until DATETIME,              -- null if not currently blocked
  fine_balance REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Staff / Admin
CREATE TABLE staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT CHECK(role IN ('librarian','admin')) NOT NULL
);

-- Books
CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  isbn TEXT,
  category TEXT,
  cover_url TEXT,
  total_copies INTEGER DEFAULT 1,
  available_copies INTEGER DEFAULT 1,
  shelf_location TEXT
);

-- Book Loans
CREATE TABLE loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER REFERENCES books(id),
  student_id INTEGER REFERENCES students(id),
  issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  due_at DATETIME NOT NULL,
  returned_at DATETIME,
  fine_charged REAL DEFAULT 0
);

-- Reading Hall Seats
CREATE TABLE seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_label TEXT NOT NULL,             -- e.g. "A1", "Row2-Seat14"
  hall TEXT DEFAULT 'main',
  pos_x INTEGER,                        -- for rendering seat map layout
  pos_y INTEGER,
  status TEXT CHECK(status IN ('available','held','occupied','maintenance')) DEFAULT 'available',
  held_by INTEGER REFERENCES students(id),
  held_at DATETIME,
  hold_expires_at DATETIME,
  occupied_by INTEGER REFERENCES students(id),
  occupied_since DATETIME
);

-- Entry/Exit Attendance Log
CREATE TABLE entry_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER REFERENCES students(id),
  seat_id INTEGER REFERENCES seats(id),
  booked_at DATETIME,
  check_in_at DATETIME,
  check_out_at DATETIME,
  status TEXT CHECK(status IN ('completed','no_show','active')) DEFAULT 'active'
);

-- Penalties
CREATE TABLE penalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER REFERENCES students(id),
  reason TEXT,                          -- 'no_show', 'late_return', etc.
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  waived_by INTEGER REFERENCES staff(id),
  waived_at DATETIME
);

-- System Settings (admin-configurable)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- seed rows: booking_hold_minutes=15, strikes_before_cooldown=3,
--            cooldown_hours=48, no_show_fine=10, overdue_fine_per_day=2, loan_period_days=14
```

---

## 4. API Endpoint Spec (REST)

### Auth
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Create student account, generates `qr_token` + QR image |
| POST | `/api/auth/login` | Login with library_id + password → returns JWT |
| POST | `/api/auth/staff-login` | Librarian/admin login |

### Books
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/books` | List/search/filter catalog |
| GET | `/api/books/:id` | Book detail |
| POST | `/api/books` | (staff) add book |
| PUT | `/api/books/:id` | (staff) edit book |
| DELETE | `/api/books/:id` | (staff) remove book |
| POST | `/api/loans` | Borrow a book |
| POST | `/api/loans/:id/return` | Return a book (calculates fine if late) |

### Seats & Live Map
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/seats` | Current status of all seats (initial load before WS takes over) |
| POST | `/api/seats/:id/book` | Book a seat (server checks seat is `available`, sets `held`, starts 15-min expiry, atomic) |
| POST | `/api/seats/:id/cancel` | Student cancels their own hold voluntarily (no penalty) |
| WS event `seat:update` | Server → all clients whenever any seat's status changes |

### Entry / QR
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/students/me/qr` | Fetch current student's QR image/token |
| POST | `/api/entry/scan` | Body: `{ qr_token }`. Server resolves student, checks for an active `held` seat within expiry → checks in. If student already `occupied` somewhere → treats as check-out instead (toggle logic) |

### Penalties & Student Profile
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/students/me` | Profile: strikes, cooldown status, fine balance, loan history |
| GET | `/api/students/me/penalties` | Penalty history |
| POST | `/api/penalties/:id/waive` | (staff) waive a penalty |

### Admin/Analytics
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/occupancy` | Live count + historical occupancy |
| GET | `/api/admin/defaulters` | Students with most no-shows |
| GET | `/api/admin/settings` | Get configurable rules |
| PUT | `/api/admin/settings` | Update rules (hold duration, strike threshold, fines) |

---

## 5. Core Logic Details

### 5.1 Seat Booking — Race Condition Safety
Booking must be an **atomic** server-side operation, e.g. in SQL:
```sql
UPDATE seats
SET status = 'held', held_by = ?, held_at = CURRENT_TIMESTAMP,
    hold_expires_at = datetime('now', '+15 minutes')
WHERE id = ? AND status = 'available';
```
Check the number of affected rows — if 0, someone else booked it a moment earlier; return a `409 Conflict` to the client ("Seat just got taken, pick another").

### 5.2 Background Expiry Job
Every 30 seconds (server-side `setInterval` or `node-cron`), run:
```sql
SELECT * FROM seats WHERE status = 'held' AND hold_expires_at < CURRENT_TIMESTAMP;
```
For each expired seat:
1. Set seat back to `available` (clear `held_by`)
2. Insert a `penalties` row for that student, reason `no_show`
3. Increment `students.strikes`; if strikes ≥ `strikes_before_cooldown`, set `cooldown_until`
4. Update the related `entry_logs` row status → `no_show`
5. Emit `seat:update` and (if the student is connected) a `penalty:notice` socket event

### 5.3 QR Scan → Check-in/Check-out Toggle
```
POST /api/entry/scan  { qr_token }
  → find student by qr_token
  → if student currently has a seat with status 'held' and not expired:
        → mark seat 'occupied', occupied_by = student, occupied_since = now
        → entry_logs.check_in_at = now, status = 'active'
        → respond "Welcome, seat A12 confirmed"
  → else if student currently has a seat with status 'occupied' (by them):
        → mark seat 'available'
        → entry_logs.check_out_at = now, status = 'completed'
        → respond "Goodbye, seat released"
  → else:
        → respond "No active booking found — please book a seat first"
```
This single toggle endpoint is what both the entry *and* exit QR scan calls hit — no need for separate "entry gate" vs "exit gate" screens in v1 (one "Scan Here" kiosk works for both).

### 5.4 QR Token Design
Don't just encode the raw `library_id` in the QR (guessable/spoofable). Instead:
- At registration, generate a random opaque token (`qr_token`, e.g. UUID or signed JWT with student id)
- Encode `qr_token` (not the ID itself) into the QR image
- Server looks up the student by `qr_token` on scan
- Optionally rotate/regenerate the token periodically for extra security

### 5.5 Penalty Cooldown Enforcement
When a student tries to book a seat (`POST /api/seats/:id/book`), server first checks:
```js
if (student.cooldown_until && student.cooldown_until > now) {
  return 403 "You're temporarily blocked from booking until <time> due to repeated no-shows"
}
```

---

## 6. Front-End Page/Screen List

1. **Landing / Public Catalog** (guest-accessible, read-only book search)
2. **Login / Register**
3. **Student Dashboard**
   - My borrowed books, due dates, fines
   - "Book a Seat" button → seat map
   - My QR code (for entry) — displayed as an image, downloadable
4. **Live Seat Map** (the core screen)
   - Grid/visual layout of seats, color/icon-coded by status
   - Click available seat → confirm booking modal → live countdown timer once booked
5. **Scan to Enter/Exit** (kiosk-style screen — camera view + "manual ID entry" fallback input)
6. **Book Catalog & Search** (full catalog, borrow button)
7. **My Penalties & History**
8. **Librarian Dashboard** — book CRUD, issue/return, current occupancy
9. **Admin Dashboard** — analytics, settings, defaulters list, seat map editor

---

## 7. Suggested Folder Structure

```
smart-library/
├── client/                     # static front end (HTML/CSS/JS)
│   ├── index.html
│   ├── login.html
│   ├── dashboard.html
│   ├── seat-map.html
│   ├── scan.html
│   ├── catalog.html
│   ├── admin.html
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── api.js              # fetch() wrapper helpers
│       ├── socket.js           # socket.io client setup
│       ├── seatMap.js
│       ├── qrScanner.js
│       ├── auth.js
│       └── dashboard.js
├── server/
│   ├── index.js                # Express app entry
│   ├── db.js                   # SQLite connection + schema init
│   ├── routes/
│   │   ├── auth.js
│   │   ├── books.js
│   │   ├── seats.js
│   │   ├── entry.js
│   │   └── admin.js
│   ├── jobs/
│   │   └── expireHolds.js      # cron/interval job
│   └── sockets.js              # socket.io event wiring
├── package.json
└── README.md
```

---

## 8. Security Notes
- Hash all passwords with bcrypt (never store plaintext)
- Use JWT with reasonable expiry (e.g., 12h) + refresh on activity
- Validate every seat-booking and scan request server-side (never trust client-reported seat status)
- Rate-limit `/api/entry/scan` to prevent QR brute forcing
- Sanitize all catalog search inputs (parameterized SQL queries only, never string-concatenated SQL)
