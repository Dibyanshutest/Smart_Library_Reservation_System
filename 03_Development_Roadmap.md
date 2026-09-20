# Development Roadmap
## Smart Library Management System — Build Plan for IDE + AI

This breaks the build into phases so you can work through it with an AI coding assistant one chunk at a time, instead of asking for "the whole system" in one go (which tends to produce shallow, buggy results). For each phase: give your AI assistant the **PRD** and **Technical Design** doc as context, then paste the "prompt starter" as your actual request, adjusting for what you already have.

---

### Phase 0 — Project Setup
**Goal:** empty-but-running skeleton.
- Init `npm` project, install `express`, `socket.io`, `better-sqlite3`, `bcrypt`, `jsonwebtoken`, `qrcode`, `cors`
- Create the folder structure from the Technical Design doc
- Get a basic Express server running, serving static files from `/client`
- Initialize the SQLite DB with the schema (run once on server start if tables don't exist)

**Prompt starter:**
> "Set up the folder structure and package.json described in section 7 of the Technical Design doc. Create an Express server (server/index.js) that serves the client/ folder statically and initializes the SQLite schema from section 3 on startup."

---

### Phase 1 — Auth (Students + Staff)
**Goal:** register/login working end-to-end, JWT issued, QR generated at registration.
- `POST /api/auth/register`, `/login`, `/staff-login`
- Password hashing, JWT issuing/verifying middleware
- On registration, generate `qr_token` + a QR code image (using `qrcode` npm package), store token, return image to display/download
- Front end: `login.html` + `js/auth.js` with basic form handling and token storage (in memory/JS variable + a cookie or `Authorization` header — avoid `localStorage` if you later port this into any sandboxed artifact environment, but for a normal deployed site `localStorage` is fine)

**Prompt starter:**
> "Implement the auth routes from section 4 of the Technical Design doc: register, login, staff-login. Use bcrypt for password hashing and JWT for sessions. On register, generate a QR code image for the student's qr_token using the qrcode npm package and return it as a data URL."

---

### Phase 2 — Book Catalog & Loans
**Goal:** standard library functionality, fully working.
- CRUD for books (staff-only for write ops)
- Borrow/return endpoints with due-date and fine calculation
- Front end: `catalog.html` with search/filter, borrow button; student dashboard shows current loans

**Prompt starter:**
> "Implement the books and loans routes and schema from the Technical Design doc. Build catalog.html with a search bar, category filter, and a grid of book cards, each with a Borrow button that calls POST /api/loans."

---

### Phase 3 — Seat Map (static first, no booking logic yet)
**Goal:** visualize the seat layout and live status, no interactivity yet.
- Seed the `seats` table with a layout (rows/columns) matching your real reading hall (or a placeholder grid, e.g. 6x8)
- `GET /api/seats` endpoint
- Front end: `seat-map.html` renders seats as a CSS grid, colored by status

**Prompt starter:**
> "Build seat-map.html + js/seatMap.js that fetches GET /api/seats and renders each seat as a colored box in a CSS grid based on its status field (available=green, held=yellow, occupied=red, maintenance=gray). Use the pos_x/pos_y fields for grid placement."

---

### Phase 4 — Real-Time Booking (the core feature)
**Goal:** the 15-minute hold + live sync across clients.
- Implement `POST /api/seats/:id/book` with the atomic UPDATE from section 5.1
- Wire up Socket.io: server emits `seat:update` on every seat change; client listens and patches the DOM without refetching everything
- Server-side background job (section 5.2) that expires stale holds every 30s and applies penalties
- Front end: booking confirmation modal + live countdown timer on a held seat

**Prompt starter:**
> "Implement seat booking per section 5.1 (atomic UPDATE, 409 on conflict) and Socket.io real-time updates per section 2 — server emits seat:update, client (js/socket.js) listens and updates only the affected seat's DOM element. Then implement the background expiry job from section 5.2 as a setInterval running every 30 seconds on the server."

---

### Phase 5 — QR Entry/Exit Scanning
**Goal:** physically "walking in" is confirmed via QR scan.
- Front end: `scan.html` using `html5-qrcode` (or `jsQR` + manual camera video wiring) to read a QR from the webcam; include a manual-ID-entry fallback input for testing without a camera
- `POST /api/entry/scan` implementing the check-in/check-out toggle logic (section 5.3)
- Show clear success/error toasts ("Welcome, seat A12 confirmed" / "Booking expired, please rebook" / "Goodbye, seat released")

**Prompt starter:**
> "Build scan.html using the html5-qrcode library to scan a QR code from the webcam and POST the decoded value to /api/entry/scan. Also add a manual text input fallback for typing a qr_token directly (for testing without a camera). Implement the /api/entry/scan toggle logic from section 5.3 on the server."

---

### Phase 6 — Penalty System
**Goal:** strikes, cooldowns, and visibility.
- Confirm penalty creation is wired from the expiry job (Phase 4)
- `GET /api/students/me/penalties`, cooldown enforcement in the booking endpoint (section 5.5)
- Front end: "My Penalties" section on student dashboard; blocked-booking message when in cooldown

**Prompt starter:**
> "Add cooldown enforcement to the seat booking endpoint per section 5.5 — reject booking attempts with a 403 and a clear message if the student is in cooldown. Build a 'My Penalties' panel on the student dashboard showing penalty history from GET /api/students/me/penalties."

---

### Phase 7 — Librarian & Admin Dashboards
**Goal:** staff-facing tools.
- `librarian.html` / `admin.html`: book management table, issue/return actions, live occupancy count, defaulters list, settings form (hold duration, strike threshold, fines)
- Wire `/api/admin/*` endpoints

**Prompt starter:**
> "Build admin.html with: a live occupancy counter (subscribe to seat:update events and count occupied seats), a defaulters table from GET /api/admin/defaulters, and a settings form that reads/writes GET/PUT /api/admin/settings for booking_hold_minutes, strikes_before_cooldown, cooldown_hours, and no_show_fine."

---

### Phase 8 — Polish
- Responsive/mobile CSS pass (students will book from phones)
- Loading states, error handling, empty states
- Accessibility pass on the seat map (icons + labels, not color-only)
- Basic input validation everywhere
- Write a README with setup instructions (`npm install`, `npm start`, default admin login, etc.)

---

## Suggested Timeline (rough, for a solo student project)

| Phase | Est. time |
|---|---|
| 0 – Setup | 1–2 hrs |
| 1 – Auth | 3–4 hrs |
| 2 – Catalog & Loans | 4–6 hrs |
| 3 – Static Seat Map | 2–3 hrs |
| 4 – Real-Time Booking | 6–8 hrs (the hardest phase) |
| 5 – QR Scanning | 4–5 hrs |
| 6 – Penalty System | 2–3 hrs |
| 7 – Admin Dashboard | 4–5 hrs |
| 8 – Polish | 4+ hrs |

**Tip for working with AI in your IDE:** keep the PRD and Technical Design doc open/attached as context in every session, and work phase-by-phase rather than asking for everything at once — it's much easier to review, test, and fix a 200-line diff than a 3,000-line one-shot dump. After each phase, actually run and click through what was built before moving to the next.
