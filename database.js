const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'crypto.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Fehler beim Öffnen der Datenbank:', err);
  } else {
    console.log('Datenbank verbunden');
    initializeDatabase();
  }
});

function initializeDatabase() {
  // Benutzertabelle
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    balance REAL DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, createCoinsTable);
}

function createCoinsTable(err) {
  if (err) {
    console.error('Error creating users table:', err);
    return;
  }

  // Coin-Tabelle
  db.run(`CREATE TABLE IF NOT EXISTS coins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    start_price REAL NOT NULL,
    current_price REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, createPortfolioTable);
}

function createPortfolioTable(err) {
  if (err) {
    console.error('Error creating coins table:', err);
    return;
  }

  // Benutzer-Portfolio
  db.run(`CREATE TABLE IF NOT EXISTS portfolio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    coin_id INTEGER NOT NULL,
    amount INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(coin_id) REFERENCES coins(id)
  )`, createTransactionsTable);
}

function createTransactionsTable(err) {
  if (err) {
    console.error('Error creating portfolio table:', err);
    return;
  }

  // Transaktionshistorie
  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    coin_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    price REAL NOT NULL,
    total REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(coin_id) REFERENCES coins(id)
  )`, createWithdrawalsTable);
}

function createWithdrawalsTable(err) {
  if (err) {
    console.error('Error creating transactions table:', err);
    return;
  }

  // Auszahlungsanfragen
  db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    iban TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`, insertCoins);
}

function insertCoins(err) {
  if (err) {
    console.error('Error creating withdrawals table:', err);
    return;
  }

  // Coins einfügen
  const coins = [
    { name: 'Crystal', price: 5 },
    { name: 'Liora', price: 10 },
    { name: 'Valora', price: 25 },
    { name: 'Solstice', price: 50 },
    { name: 'Aureum', price: 100 },
    { name: 'Veyron', price: 125 },
    { name: 'Celestia', price: 250 },
    { name: 'Opalis', price: 375 },
    { name: 'Zenithra', price: 500 },
    { name: 'Novaris', price: 625 },
    { name: 'Luminar', price: 750 },
    { name: 'Stellar', price: 875 },
    { name: 'Astra', price: 1000 },
    { name: 'Nebiros', price: 1250 },
    { name: 'Elysium', price: 1500 },
    { name: 'Aurion', price: 1750 },
    { name: 'Imperium', price: 2000 },
    { name: 'Solara', price: 2250 },
    { name: 'Astralis', price: 2500 }
  ];

  let coinsInserted = 0;
  coins.forEach(coin => {
    db.run(
      `INSERT OR IGNORE INTO coins (name, start_price, current_price) VALUES (?, ?, ?)`,
      [coin.name, coin.price, coin.price],
      (err) => {
        if (err) console.error('Error inserting coin:', err);
        coinsInserted++;
        if (coinsInserted === coins.length) {
          insertAdmin();
        }
      }
    );
  });
}

function insertAdmin(err) {
  if (err) console.error('Error in coin insertion:', err);

  // Admin-Konto einfügen
  const hashedPassword = bcrypt.hashSync('AdminAccount123', 10);
  db.run(
    `INSERT OR IGNORE INTO users (username, password, phone, balance, is_admin) VALUES (?, ?, ?, ?, ?)`,
    ['Admin', hashedPassword, '12345', 0, 1],
    (err) => {
      if (err) console.error('Error inserting admin:', err);
      else console.log('✓ Database initialized successfully');
    }
  );
}

module.exports = db;
