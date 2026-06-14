const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

function generateCryptoAddress() {
  return '0x' + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

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
    address TEXT UNIQUE NOT NULL,
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
  )`, (err) => {
    if (err) {
      console.error('Error creating coins table:', err);
      return;
    }
    ensureUserAddressColumn(createPortfolioTable);
  });
}

function ensureUserAddressColumn(next) {
  db.all(`PRAGMA table_info(users)`, (err, columns) => {
    if (err) {
      console.error('Error reading users schema:', err);
      return next(err);
    }

    const hasAddress = columns.some(col => col.name === 'address');
    if (hasAddress) {
      return next();
    }

    db.run(`ALTER TABLE users ADD COLUMN address TEXT`, (err) => {
      if (err) {
        console.error('Error adding address column:', err);
        return next(err);
      }

      db.all(`SELECT id FROM users WHERE address IS NULL OR address = ''`, (err, users) => {
        if (err) {
          console.error('Error selecting users without address:', err);
          return next(err);
        }

        let remaining = users.length;
        if (remaining === 0) {
          return next();
        }

        users.forEach(user => {
          const address = generateCryptoAddress();
          db.run(`UPDATE users SET address = ? WHERE id = ?`, [address, user.id], (err) => {
            if (err) {
              console.error('Error updating user address:', err);
            }
            remaining -= 1;
            if (remaining === 0) {
              next();
            }
          });
        });
      });
    });
  });
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
    amount REAL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(coin_id) REFERENCES coins(id)
  )`, (err) => {
    if (err) {
      console.error('Error creating portfolio table:', err);
      return;
    }
    ensurePortfolioAmountReal(createTransactionsTable);
  });
}

function ensurePortfolioAmountReal(next) {
  db.all(`PRAGMA table_info(portfolio)`, (err, columns) => {
    if (err) {
      console.error('Error reading portfolio schema:', err);
      return next(err);
    }

    const amountColumn = columns.find(col => col.name === 'amount');
    if (!amountColumn || amountColumn.type.toUpperCase() === 'REAL') {
      return next();
    }

    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS portfolio_temp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        coin_id INTEGER NOT NULL,
        amount REAL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(coin_id) REFERENCES coins(id)
      )`);

      db.run(`INSERT INTO portfolio_temp (id, user_id, coin_id, amount)
              SELECT id, user_id, coin_id, amount FROM portfolio`);
      db.run(`DROP TABLE portfolio`);
      db.run(`ALTER TABLE portfolio_temp RENAME TO portfolio`, next);
    });
  });
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
    amount REAL NOT NULL,
    price REAL NOT NULL,
    total REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(coin_id) REFERENCES coins(id)
  )`, createTransfersTable);
}

function createTransfersTable(err) {
  if (err) {
    console.error('Error creating transactions table:', err);
    return;
  }

  db.run(`CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(recipient_id) REFERENCES users(id)
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
  const address = generateCryptoAddress();
  db.run(
    `INSERT OR IGNORE INTO users (username, password, phone, address, balance, is_admin) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Admin', hashedPassword, '12345', address, 0, 1],
    (err) => {
      if (err) console.error('Error inserting admin:', err);
      else console.log('✓ Database initialized successfully');
    }
  );
}

module.exports = db;
