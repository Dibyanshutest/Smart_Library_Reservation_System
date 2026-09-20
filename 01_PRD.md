# Product Requirements Document (PRD)
## Smart Library Management System

**Version:** 1.0
**Status:** Draft — ready for AI-assisted implementation
**Stack (mandatory):** HTML, CSS, JavaScript
**Stack (optional/recommended):** Node.js, Express, Socket.io, SQLite, QR libraries (see Technical Design doc)

---

## 1. Overview

The Smart Library System digitizes day-to-day library operations for a college/school/public library: cataloging and borrowing books, tracking who is physically inside the library, letting students reserve a specific seat before arriving, and automatically enforcing attendance rules through a penalty system — all without a human at the front desk doing manual entries.

The two things that make this "smart" rather than a plain library-management app are:

1. **Digital entry via ID + QR confirmation** — a student identifies themselves digitally, picks a seat from a live seat map, and confirms physical entry by scanning a QR code at the door.
2. **Live seat booking with a no-show penalty** — seats can be booked up to 15 minutes ahead of arrival; live seat status is visible to everyone so no two people fight over the same seat; if a student books and doesn't show up, they're penalized and the seat is auto-released.

---

## 2. Goals & Objectives

| Goal | Why it matters |
|---|---|
| Eliminate manual entry registers | Saves staff time, removes human error, creates a digital audit trail |
| Real-time seat visibility | Prevents wasted trips, reduces overcrowding disputes |
| Enforce booking discipline | Stops students from "hoarding" seats they never use |
| Full book lifecycle tracking | Standard library functions (catalog, issue, return, fine) still need to exist |
| Give administrators visibility | Occupancy trends, defaulters, popular books, peak hours |

## 3. Non-Goals (Out of Scope for v1)

- Payment gateway integration for fines (a fine "ledger" is tracked; actual online payment is a future phase)
- Native mobile app (this is a responsive web app; QR scanning uses the device camera in-browser)
- Face recognition / biometric entry
- Multi-branch / multi-library federation

---

## 4. User Roles

### 4.1 Student / Member
- Has a unique Library ID (roll number / member ID)
- Can log in, view/reserve books, view live seat map, book a seat, generate/scan QR to check in, view their own attendance & penalty history

### 4.2 Librarian (Staff)
- Manages book catalog (add/edit/remove, copies, categories)
- Approves/handles manual overrides (e.g., waiving a penalty)
- Issues/returns books, views current library occupancy
- Generates reports

### 4.3 Admin
- Everything a librarian can do, plus:
- Manages staff accounts, library hours, seat map layout, penalty rules (thresholds, cooldown durations)
- Views system-wide analytics

### 4.4 Guest (not logged in)
- Can browse the public book catalog (read-only) — cannot book seats or borrow

---

## 5. Core Feature List

### A. Book & Catalog Management (standard library features)
1. Add / edit / delete book records (title, author, ISBN, category, copies available, shelf location, cover image)
2. Search & filter catalog (by title, author, category, availability)
3. Issue a book to a student (with due date)
4. Return a book (auto-calculates late fine if overdue)
5. Renew a book (if not reserved by someone else)
6. Reserve/hold a book that's currently checked out (queue system)
7. Student dashboard: currently borrowed books, due dates, history, fines owed
8. Librarian dashboard: overdue list, most-borrowed books, low-stock alerts
9. Barcode/ISBN-based quick lookup (optional, camera-based)

### B. Digital Entry System (headline feature)
10. Student logs in with Library ID (+ password/PIN, or ID-card QR scan as the login method itself)
11. On login, student sees the **live seat map** of the reading hall(s)
12. Seat colors reflect real-time status: **Available / Held (booked, not yet arrived) / Occupied / Under Cooldown (recently defaulted)**
13. Student selects an available seat and **books it**
14. Booking rule: a seat can be booked **up to 15 minutes before** the student physically arrives. The booking is held for those 15 minutes.
15. Student walks to the library entrance and **scans a QR code** (displayed at the entry gate, or shows their own personal QR to a scanner) to confirm physical check-in
16. On successful scan + within the 15-minute window → seat status flips to **Occupied**, attendance is logged with timestamp
17. If the student does **not** scan in within the 15-minute window → booking **auto-expires**, seat returns to **Available**, and a **penalty (strike)** is recorded against the student
18. Student scans again (or uses an app action) to **check out** when leaving → seat becomes Available, session duration logged
19. Live seat map updates for **all connected users in real time** (via WebSocket/polling) so nobody books a seat someone else just took

### C. Penalty System
20. Each no-show adds one strike / penalty point to the student's record
21. Configurable rule (admin-settable), e.g.: 3 strikes in 30 days → student is **blocked from booking seats for 48 hours (cooldown)**
22. Penalty history visible to the student (transparency) and to admin (override/waive capability)
23. Optional escalating fine (e.g., ₹10 per no-show) added to the student's library fine ledger, alongside overdue-book fines

### D. QR Code System
24. Each student has a **personal QR code** (encodes their Library ID, generated at registration) — used for login/identification and as their "seat check-in credential"
25. Each entry gate (or entry point in the mock-up: a single "Scan to Enter" screen) has a **camera-based scanner** (using device webcam via `getUserMedia` + a JS QR-decoding library) that reads the student's personal QR
26. Alternative flow (no camera needed for testing): manually type Library ID to simulate a scan — useful for the browser-only demo build
27. QR scan on entry = attendance/check-in event; QR scan on exit = check-out event

### E. Notifications (in-app, no external SMS/email needed for v1)
28. Toast/banner notification when: booking confirmed, booking about to expire (e.g., 5 min left), penalty applied, seat auto-released
29. Admin notification when occupancy crosses a threshold (e.g., 90% full)

### F. Admin & Analytics Dashboard
30. Live occupancy count (X / total seats occupied)
31. Peak-hour heatmap (by hour of day)
32. Most frequent no-show students
33. Book circulation stats
34. Manage seat map: add/remove seats, mark seats "under maintenance"
35. Manage penalty rules: strike threshold, cooldown duration, fine amount

---

## 6. Key User Flows

### 6.1 Seat Booking → Entry → Auto-Expiry Flow
```
Student logs in
   → Views live seat map
   → Selects an available seat
   → Confirms booking (system timestamps booking_time, sets status = HELD, expiry = booking_time + 15 min)
   → Seat map broadcasts update to all clients (seat now shown as HELD to everyone else)
   → Student walks to library
   → Student scans QR at entry gate
        IF current_time <= expiry:
             → seat status = OCCUPIED
             → entry_log created (student_id, seat_id, check_in_time)
             → seat map broadcasts update
        IF current_time > expiry (already auto-expired by background job):
             → scan is rejected with "Booking expired" message
             → student may book a different available seat (if any)
   → [background job runs every ~30s] checks all HELD seats past expiry
        → sets seat = AVAILABLE
        → creates penalty record for the student
        → notifies the student (if still connected) that they were penalized
```

### 6.2 Checkout Flow
```
Student finishes studying
   → Scans QR at exit (or clicks "Check out" if still logged in on their device)
   → seat status = AVAILABLE
   → entry_log updated with check_out_time, session duration calculated
   → seat map broadcasts update
```

### 6.3 Book Borrowing Flow
```
Student finds book in catalog → clicks "Borrow"
   → Librarian confirms physical handover (or system auto-approves if configured self-service)
   → due_date = today + loan_period (e.g., 14 days)
   → On return: librarian marks "Returned" → if late, fine calculated and added to student ledger
```

---

## 7. Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Performance** | Seat map updates should propagate to all clients within ~1–2 seconds of a change |
| **Responsiveness** | Fully usable on mobile (students will often book from their phone before walking in) |
| **Reliability** | Booking-expiry checks must run even if no user has the page open (server-side background job, not client-side timer only) |
| **Concurrency safety** | Two students must never be able to book the same seat at the same time (server-side locking / atomic check-and-set) |
| **Security** | Passwords hashed; QR payloads should not be trivially guessable/forgeable (signed token or ID + short-lived nonce) |
| **Auditability** | Every entry, exit, booking, expiry, and penalty must be logged with timestamps for admin review |
| **Accessibility** | Seat map must not rely on color alone (use icons/labels too) for colorblind users |
| **Offline degradation** | If real-time layer (WebSocket) disconnects, fall back to periodic polling rather than breaking the UI |

---

## 8. Success Metrics

- % reduction in "seat disputes" / manual front-desk interventions
- Average time between booking and check-in (should cluster under 15 min)
- No-show rate trend over time (should decrease as penalty system kicks in)
- System uptime / real-time sync reliability

---

## 9. Assumptions & Open Questions (fill in before/while building)

- [ ] How many seats / reading halls does the real library have? (affects seat-map layout)
- [ ] Is there real entry-gate hardware (a scanner device) or is scanning done via a student's own phone camera? (v1 assumes browser-based camera scan on a kiosk tablet or the student's phone)
- [ ] Loan period & fine-per-day for overdue books?
- [ ] Penalty rule specifics: strikes before cooldown, cooldown length, optional monetary fine per no-show?
- [ ] Single library location or multiple halls/floors with independent seat maps?

These are marked as **admin-configurable settings** in the design so you don't need to hardcode the answers — pick sensible defaults (given in the Technical Design doc) and adjust later.
