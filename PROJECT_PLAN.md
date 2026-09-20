# Smart Library Management System — Project Plan

> Synthesized from: `01_PRD.md`, `02_Technical_Design.md`, `03_Development_Roadmap.md`

---

## Project Summary

A web-based library system with **real-time seat booking**, **QR-based physical check-in**, **book catalog/loans**, and a **penalty system**. The two "smart" differentiators are: (1) digital entry via ID + QR confirmation with live seat map, and (2) seat booking with a 15-minute no-show penalty system.

**Mandatory Stack:** HTML5, CSS3, Vanilla JavaScript (ES6+)
**Recommended Stack:** Node.js + Express, Socket.io, SQLite (`better-sqlite3`), jsQR/html5-qrcode, qrcode, jsonwebtoken, bcrypt, node-cron

---

## Phase-by-Phase Plan

---

### Phase 0 — Project Setup
**Goal:** Empty-but-running skeleton.
**Estimated Time:** 1–2 hours

**Tasks:**
1. Initialize `npm` project, install dependencies: `express`, `socket.io`, `better-sqlite3`, `bcrypt`, `jsonwebtoken`, `qrcode`, `cors`
2. Create folder structure:
   ```
   smart-library/
   ├── client/
   │   ├── index.html
   │   ├── login.html
   │   ├── dashboard.html
   │   ├── seat-map.html
   │   ├── scan.html
   │   ├── catalog.html
   │   ├── admin.html
   │   ├── css/styles.css
   │   └── js/
   │       ├── api.js
   │       ├── socket.js
   │       ├── seatMap.js
   │       ├── qrScanner.js
   │       ├── auth.js
   │       └── dashboard.js
   ├── server/
   │   ├── index.js
   │   ├── db.js
   │   ├── routes/
   │   │   ├── auth.js
   │   │   ├── books.js
   │   │   ├── seats.js
   │   │   ├── entry.js
   │   │   └── admin.js
   │   ├── jobs/
   │   │   └── expireHolds.js
   │   └── sockets.js
   ├── package.json
   └── README.md
   ```
3. Create Express server (`server/index.js`) serving static files from `/client`
4. Initialize SQLite DB with schema from Technical Design §3 — run on server start if tables don't exist
5. Verify server responds at `localhost:3000` with a basic landing page

**Deliverables:**
- Running Express server on port 3000
- SQLite database initialized with all tables (students, staff, books, loans, seats, entry_logs, penalties, settings)
- At least one static HTML page served successfully

---

### Phase 1 — Authentication (Students + Staff)
**Goal:** Register/login working end-to-end, JWT issued, QR generated at registration.
**Estimated Time:** 3–4 hours

**Tasks:**
1. Implement `POST /api/auth/register` — create student account, hash password with bcrypt, generate `qr_token` (UUID), create QR image using `qrcode` npm package, store token, return QR as data URL
2. Implement `POST /api/auth/login` — verify credentials, issue JWT (12h expiry)
3. Implement `POST /api/auth/staff-login` — librarian/admin login, different JWT payload
4. Create JWT verification middleware for protected routes
5. Front end: `login.html` with form handling, token storage (cookie or Authorization header)
6. Front end: `register` flow showing the generated QR code for download

**Key Technical Details:**
- Passwords hashed with bcrypt (never plaintext)
- JWT used for session management
- QR token is a random opaque string (not the library ID itself — see Security §5.4)

**Deliverables:**
- All 3 auth endpoints working and tested
- Registration creates a student with a QR code image
- Login returns valid JWT
- Protected routes reject requests without valid token

---

### Phase 2 — Book Catalog & Loans
**Goal:** Standard library functionality fully working.
**Estimated Time:** 4–6 hours

**Tasks:**
1. Implement book CRUD endpoints (staff-only for writes):
   - `GET /api/books` — list/search/filter catalog
   - `GET /api/books/:id` — book detail
   - `POST /api/books` — add book
   - `PUT /api/books/:id` — edit book
   - `DELETE /api/books/:id` — remove book
2. Implement loan endpoints:
   - `POST /api/loans` — borrow a book (set due_date = today + 14 days)
   - `POST /api/loans/:id/return` — return book (auto-calculate late fine: ₹2/day from settings)
3. Seed database with sample books
4. Front end: `catalog.html` — search bar, category filter, book card grid with Borrow button
5. Front end: Student dashboard section showing currently borrowed books, due dates, fines
6. Front end: Librarian tools — add/edit/remove books, issue/return actions

**Deliverables:**
- Full book CRUD API working
- Borrow/return flow with due dates and automatic fine calculation
- Catalog page searchable and browsable
- Student sees their active loans on dashboard

---

### Phase 3 — Static Seat Map (No Booking Logic Yet)
**Goal:** Visualize seat layout and live status, no interactivity.
**Estimated Time:** 2–3 hours

**Tasks:**
1. Seed the `seats` table with a layout — a grid (e.g., 6 rows × 8 seats = 48 seats) for the main reading hall, with `pos_x`/`pos_y` for grid placement, `seat_label` (A1, A2, ... F8)
2. Implement `GET /api/seats` — return all seats with current status
3. Front end: `seat-map.html` renders seats as a CSS grid
4. Color coding by status: green (available), yellow (held), red (occupied), gray (maintenance)
5. Also use icons/labels so colorblind users can distinguish (accessibility requirement from PRD §7)

**Deliverables:**
- Seat map visually rendered showing all 48+ seats in a grid
- Live status fetched from API and displayed with correct colors/icons
- No booking functionality yet — read-only visualization

---

### Phase 4 — Real-Time Booking (Core Feature)
**Goal:** 15-minute hold + live sync across all connected clients.
**Estimated Time:** 6–8 hours (hardest phase)

**Tasks:**
1. Implement `POST /api/seats/:id/book` with atomic SQL UPDATE:
   - Check seat is `available`, set to `held`, set `held_by`, `held_at`, `hold_expires_at` (now + 15 min from settings)
   - Return 409 Conflict if seat already taken (race condition safety)
2. Implement cooldown check (section 5.5) — reject booking with 403 if student is in cooldown
3. Implement `POST /api/seats/:id/cancel` — voluntary cancellation (no penalty)
4. Set up Socket.io:
   - Server emits `seat:update` event on every seat status change
   - Client listens and patches only the affected seat's DOM element (no full reload)
5. Implement background expiry job (`server/jobs/expireHolds.js`):
   - Runs every 30 seconds via `setInterval`
   - Finds `held` seats past expiry → sets `available`, creates penalty record, increments strikes, applies cooldown if threshold reached, updates entry_logs, emits socket events
6. Front end: Booking flow — click available seat → confirmation modal → on success, live countdown timer showing time remaining before auto-expiry
7. Front end: Toast notifications for booking confirmed, booking about to expire (5 min left), penalty applied

**Key Technical Details:**
- Atomic booking: `UPDATE seats SET status='held', ... WHERE id=? AND status='available'` — check affected rows
- Server-side timer (not client-side) for expiry — works even if browser tab is closed
- WebSocket provides real-time updates to all connected clients within 1–2 seconds

**Deliverables:**
- Seats can be booked (atomic, race-condition safe)
- Held seats auto-expire after 15 minutes with penalties
- All connected clients see live seat map updates in real time
- Countdown timer on booked seats
- Notification toasts for booking and penalty events

---

### Phase 5 — QR Entry/Exit Scanning
**Goal:** Physical "walking in" confirmed via QR scan.
**Estimated Time:** 4–5 hours

**Tasks:**
1. Front end: `scan.html` — camera-based QR scanner using `html5-qrcode` (or `jsQR` with manual webcam wiring)
2. Include manual ID entry fallback input (for testing without a camera — type library_id or qr_token)
3. Implement `POST /api/entry/scan` — toggle logic:
   - Find student by `qr_token` from request body
   - If student has a `held` (non-expired) seat → check in: set seat `occupied`, log `check_in_at`, status `active` → "Welcome, seat A12 confirmed"
   - If student has an `occupied` seat → check out: set seat `available`, log `check_out_at`, status `completed` → "Goodbye, seat released"
   - Otherwise → "No active booking found — please book a seat first"
4. Success/error toast notifications on the scan screen
5. QR display on student dashboard — students can show their personal QR code (generated at registration) to the kiosk scanner

**Deliverables:**
- Working QR scanner using device camera
- Manual fallback for testing
- Check-in and check-out both functional via single toggle endpoint
- Personal QR code displayed and downloadable from student dashboard

---

### Phase 6 — Penalty System
**Goal:** Strikes, cooldowns, and full visibility.
**Estimated Time:** 2–3 hours

**Tasks:**
1. Confirm penalty creation is wired from the expiry job (Phase 4 — should already be working)
2. Implement `GET /api/students/me/penalties` — full penalty history for logged-in student
3. Verify cooldown enforcement in booking endpoint (section 5.5) — reject with 403 + message: "You're temporarily blocked from booking until [time] due to repeated no-shows"
4. Front end: "My Penalties" panel on student dashboard showing:
   - Strike count
   - Cooldown status (active/inactive, time remaining)
   - Full penalty history with dates and reasons
5. Admin: ability to waive penalties via `POST /api/penalties/:id/waive` (UI on admin dashboard)
6. Cooldown enforcement also covers overdue book fines (strike from late returns)

**Default Rules (admin-configurable in `settings` table):**
- `strikes_before_cooldown` = 3
- `cooldown_hours` = 48
- `no_show_fine` = ₹10 per no-show
- `overdue_fine_per_day` = ₹2
- `booking_hold_minutes` = 15
- `loan_period_days` = 14

**Deliverables:**
- Penalties tracked and visible to students
- Cooldown blocks booking when threshold exceeded
- Admin can waive penalties
- All penalty events logged with timestamps

---

### Phase 7 — Librarian & Admin Dashboards
**Goal:** Staff-facing tools fully functional.
**Estimated Time:** 4–5 hours

**Tasks:**
1. Admin/Librarian dashboard (`admin.html`):
   - Live occupancy counter (subscribe to `seat:update` socket events, count occupied seats)
   - Peak-hour heatmap (historical occupancy by hour) — from `entry_logs` data
   - Defaulters table (students with most no-shows) from `GET /api/admin/defaulters`
   - Book circulation stats
2. Settings management:
   - `GET /api/admin/settings` / `PUT /api/admin/settings`
   - Form for: `booking_hold_minutes`, `strikes_before_cooldown`, `cooldown_hours`, `no_show_fine`, `overdue_fine_per_day`, `loan_period_days`
3. Seat map editor: add/remove seats, mark seats "under maintenance"
4. Staff management: create librarian accounts, assign roles
5. Override tools: waive penalties, manually adjust book availability

**Deliverables:**
- Live occupancy visible to staff at all times
- Analytics: defaulters, circulation stats, peak hours
- All admin settings editable through UI
- Staff can manage books, students, and override penalties

---

### Phase 8 — Polish & Hardening
**Goal:** Production-ready quality.
**Estimated Time:** 4+ hours

**Tasks:**
1. Responsive/mobile CSS pass — students will book from phones
2. Loading states on all API calls (spinners, skeleton screens)
3. Error handling — friendly messages for all failure cases (409, 403, 500, network errors)
4. Empty states — "No books found", "No active bookings", "You haven't been penalized yet"
5. Accessibility pass on seat map:
   - Icons + text labels in addition to color
   - ARIA attributes
   - Keyboard navigation for seat selection
6. Input validation everywhere (server-side primary, client-side secondary)
7. Security final review:
   - All passwords hashed ✓
   - Parameterized SQL queries only
   - JWT expiry reasonable (12h)
   - Rate limiting on `/api/entry/scan`
   - No client-side trust of seat status
8. Write `README.md` with:
   - `npm install`
   - `npm start`
   - Default admin credentials
   - Architecture overview
   - Folder structure explanation
9. Offline degradation — WebSocket disconnect falls back to periodic polling

**Deliverables:**
- Fully responsive app
- Robust error handling
- Accessibility compliant seat map
- Security audit pass complete
- README documentation complete

---

## Summary Timeline

| Phase | Description | Est. Time | Dependencies |
|---|---|---|---|
| 0 | Project Setup | 1–2 hrs | None |
| 1 | Auth | 3–4 hrs | Phase 0 |
| 2 | Catalog & Loans | 4–6 hrs | Phase 0, 1 |
| 3 | Static Seat Map | 2–3 hrs | Phase 0 |
| 4 | Real-Time Booking | 6–8 hrs | Phase 0, 3 |
| 5 | QR Scanning | 4–5 hrs | Phase 0, 1, 4 |
| 6 | Penalty System | 2–3 hrs | Phase 4 |
| 7 | Admin Dashboard | 4–5 hrs | Phase 0, 1, 4, 6 |
| 8 | Polish | 4+ hrs | All previous |
| **Total** | | **~30–40 hrs** | |

---

## Working with AI in Your IDE

**Before every session:** Keep the PRD (`01_PRD.md`) and Technical Design (`02_Technical_Design.md`) open/attached as context.

**Per phase approach:** Work one phase at a time. Use the **Prompt Starter** provided in the roadmap for each phase as your actual request to the AI assistant, adjusted for what you already have built.

**After each phase:**
1. Run the server
2. Click through the feature manually (or with API tests)
3. Verify it works end-to-end
4. Only then move to the next phase

**Why phase-by-phase:** A 200-line diff is much easier to review, test, and fix than a 3,000-line one-shot dump.

---

## Key Files Reference

| Document | Purpose |
|---|---|
| `01_PRD.md` | What to build — features, user stories, goals |
| `02_Technical_Design.md` | How to build — stack, architecture, data model, API spec |
| `03_Development_Roadmap.md` | When to build it — phased build plan with prompt starters |
| `PROJECT_PLAN.md` | This file — integrated plan with all three docs |
