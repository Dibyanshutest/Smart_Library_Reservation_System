const Database = require('better-sqlite3');
const path = require('path');

// Path to the SQLite database file
const DB_PATH = path.join(__dirname, '..', 'library.db');

// Connect to the SQLite database
const db = new Database(DB_PATH);

// Enable foreign keys for referential integrity
db.pragma('foreign_keys = ON');

// Create all tables from the Technical Design data model
db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    qr_token TEXT UNIQUE NOT NULL,
    strikes INTEGER DEFAULT 0,
    cooldown_until DATETIME,
    fine_balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT CHECK(role IN ('librarian','admin')) NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
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

  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER REFERENCES books(id),
    student_id INTEGER REFERENCES students(id),
    issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    due_at DATETIME NOT NULL,
    returned_at DATETIME,
    fine_charged REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seat_label TEXT NOT NULL,
    hall TEXT DEFAULT 'main',
    pos_x INTEGER,
    pos_y INTEGER,
    status TEXT CHECK(status IN ('available','held','occupied','maintenance')) DEFAULT 'available',
    held_by INTEGER REFERENCES students(id),
    held_at DATETIME,
    hold_expires_at DATETIME,
    occupied_by INTEGER REFERENCES students(id),
    occupied_since DATETIME
  );

  CREATE TABLE IF NOT EXISTS entry_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES students(id),
    seat_id INTEGER REFERENCES seats(id),
    booked_at DATETIME,
    check_in_at DATETIME,
    check_out_at DATETIME,
    status TEXT CHECK(status IN ('completed','no_show','active')) DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS penalties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES students(id),
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    waived_by INTEGER REFERENCES staff(id),
    waived_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Insert default system settings (from Technical Design doc)
const defaultSettings = [
  ['booking_hold_minutes', '15'],
  ['strikes_before_cooldown', '3'],
  ['cooldown_hours', '48'],
  ['no_show_fine', '10'],
  ['overdue_fine_per_day', '2'],
  ['loan_period_days', '14']
];

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const seedSettings = db.transaction(() => {
  defaultSettings.forEach(([key, value]) => insertSetting.run(key, value));
});
seedSettings();

// Seed a default reading hall layout (6 rows x 8 seats = 48 seats)
const seedSeats = db.transaction(() => {
  const seatExists = db.prepare('SELECT id FROM seats LIMIT 1').get();
  if (seatExists) return;

  const insertSeat = db.prepare(`
    INSERT INTO seats (seat_label, hall, pos_x, pos_y, status)
    VALUES (?, 'main', ?, ?, 'available')
  `);

  const rows = 6;
  const cols = 8;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const label = `${String.fromCharCode(65 + row)}${col + 1}`;
      insertSeat.run(label, col + 1, row + 1);
    }
  }
});
seedSeats();

// Seed a default admin account for testing
const seedAdmin = db.transaction(() => {
  const adminExists = db.prepare("SELECT id FROM staff WHERE email = 'admin@library.com'").get();
  if (!adminExists) {
    const bcrypt = require('bcrypt');
    const passwordHash = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO staff (name, email, password_hash, role)
      VALUES (?, ?, ?, ?)
    `).run('System Admin', 'admin@library.com', passwordHash, 'admin');
  }
});
seedAdmin();

// Seed sample books for catalog browsing and borrowing
const seedBooks = db.transaction(() => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO books (title, author, isbn, category, cover_url, total_copies, available_copies, shelf_location)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const books = [
    ['The Great Gatsby', 'F. Scott Fitzgerald', '9780743273565', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780743273565-M.jpg', 3, 3, 'A-12'],
    ['To Kill a Mockingbird', 'Harper Lee', '9780061120084', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780061120084-M.jpg', 4, 4, 'A-13'],
    ['1984', 'George Orwell', '9780451524935', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780451524935-M.jpg', 3, 3, 'A-14'],
    ['Pride and Prejudice', 'Jane Austen', '9780141439518', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780141439518-M.jpg', 2, 2, 'A-15'],
    ['The Hobbit', 'J.R.R. Tolkien', '9780547928227', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780547928227-M.jpg', 5, 5, 'B-01'],
    ['Brave New World', 'Aldous Huxley', '9780060850524', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780060850524-M.jpg', 2, 2, 'B-02'],
    ['The Catcher in the Rye', 'J.D. Salinger', '9780316769488', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780316769488-M.jpg', 3, 3, 'B-03'],
    ['Animal Farm', 'George Orwell', '9780451526342', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780451526342-M.jpg', 2, 2, 'B-04'],
    ['Lord of the Flies', 'William Golding', '9780571223443', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780571223443-M.jpg', 2, 2, 'B-05'],
    ['The Da Vinci Code', 'Dan Brown', '9780385504201', 'Mystery', 'https://covers.openlibrary.org/b/isbn/9780385504201-M.jpg', 3, 3, 'C-01'],
    ['Gone Girl', 'Gillian Flynn', '9780307588371', 'Mystery', 'https://covers.openlibrary.org/b/isbn/9780307588371-M.jpg', 2, 2, 'C-02'],
    ['The Girl with the Dragon Tattoo', 'Stieg Larsson', '9780307949487', 'Mystery', 'https://covers.openlibrary.org/b/isbn/9780307949487-M.jpg', 2, 2, 'C-03'],
    ['Murder on the Orient Express', 'Agatha Christie', '9780062693662', 'Mystery', 'https://covers.openlibrary.org/b/isbn/9780062693662-M.jpg', 4, 4, 'C-04'],
    ['The Alchemist', 'Paulo Coelho', '9780062315007', 'Philosophy', 'https://covers.openlibrary.org/b/isbn/9780062315007-M.jpg', 3, 3, 'D-01'],
    ['Sapiens', 'Yuval Noah Harari', '9780062316097', 'History', 'https://covers.openlibrary.org/b/isbn/9780062316097-M.jpg', 4, 4, 'D-02'],
    ['A Brief History of Time', 'Stephen Hawking', '9780553380163', 'Science', 'https://covers.openlibrary.org/b/isbn/9780553380163-M.jpg', 3, 3, 'E-01'],
    ['The Selfish Gene', 'Richard Dawkins', '9780199291151', 'Science', 'https://covers.openlibrary.org/b/isbn/9780199291151-M.jpg', 2, 2, 'E-02'],
    ['A Short History of Nearly Everything', 'Bill Bryson', '9780767919738', 'Science', 'https://covers.openlibrary.org/b/isbn/9780767919738-M.jpg', 3, 3, 'E-03'],
    ['Clean Code', 'Robert C. Martin', '9780132350884', 'Technology', 'https://covers.openlibrary.org/b/isbn/9780132350884-M.jpg', 4, 4, 'F-01'],
    ['The Pragmatic Programmer', 'Andrew Hunt', '9780201616224', 'Technology', 'https://covers.openlibrary.org/b/isbn/9780201616224-M.jpg', 3, 3, 'F-02'],
    ['Design Patterns', 'Erich Gamma', '9780201633610', 'Technology', 'https://covers.openlibrary.org/b/isbn/9780201633610-M.jpg', 2, 2, 'F-03'],
    ['Introduction to Algorithms', 'Thomas Cormen', '9780262033848', 'Technology', 'https://covers.openlibrary.org/b/isbn/9780262033848-M.jpg', 3, 3, 'F-04'],
    ['The Elements of Style', 'William Strunk', '9780205309023', 'Education', 'https://covers.openlibrary.org/b/isbn/9780205309023-M.jpg', 5, 5, 'G-01'],
    ['How to Win Friends', 'Dale Carnegie', '9780671027032', 'Education', 'https://covers.openlibrary.org/b/isbn/9780671027032-M.jpg', 4, 4, 'G-02'],
    ['Thinking Fast and Slow', 'Daniel Kahneman', '9780374533557', 'Psychology', 'https://covers.openlibrary.org/b/isbn/9780374533557-M.jpg', 3, 3, 'H-01'],
    ['The Psychology of Money', 'Morgan Housel', '9780857190185', 'Business', 'https://covers.openlibrary.org/b/isbn/9780857190185-M.jpg', 2, 2, 'H-02'],
    ['Atomic Habits', 'James Clear', '9780735211292', 'Business', 'https://covers.openlibrary.org/b/isbn/9780735211292-M.jpg', 4, 4, 'H-03'],
    ['Zero to One', 'Peter Thiel', '9780804139298', 'Business', 'https://covers.openlibrary.org/b/isbn/9780804139298-M.jpg', 2, 2, 'H-04'],
    ['The Art of War', 'Sun Tzu', '9781590302255', 'Strategy', 'https://covers.openlibrary.org/b/isbn/9781590302255-M.jpg', 3, 3, 'I-01'],
    ['Meditations', 'Marcus Aurelius', '9780140270322', 'Philosophy', 'https://covers.openlibrary.org/b/isbn/9780140270322-M.jpg', 2, 2, 'I-02'],
    ['The Little Prince', 'Antoine de Saint-Exupery', '9780156012195', 'Fiction', 'https://covers.openlibrary.org/b/isbn/9780156012195-M.jpg', 3, 3, 'I-03']
  ];

  books.forEach((b) => insert.run(b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]));
  console.log(`Seeded ${books.length} books`);
});
seedBooks();

console.log('Database initialized successfully');
console.log('Database file:', DB_PATH);

// Export the database connection for use in other modules
module.exports = db;
