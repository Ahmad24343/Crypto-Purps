const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const bodyParser = require('body-parser');

// Choose between MongoDB or SQLite backend depending on environment
require('dotenv').config();
const useMongo = !!process.env.MONGODB_URI;
const db = useMongo ? require('./database-mongodb') : require('./database');


const app = express();

function generateCryptoAddress() {
  return '0x' + crypto.randomBytes(20).toString('hex');
}

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session-Konfiguration
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/crypto-purps';

const sessionOptions = {
  secret: process.env.SESSION_SECRET || 'purps-crypto-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' }
};
if (useMongo) {
  sessionOptions.store = MongoStore.create({
    mongoUrl: mongoUri,
    touchAfter: 24 * 3600
  });
} else {
  console.warn('MongoDB URI not set, using default memory session store.');
}

// use session parser instance so socket.io can access sessions
const sessionParser = session(sessionOptions);
app.use(sessionParser);

// Ensure messages table exists for anonymous chat
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Routes
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.redirect('/dashboard');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/dashboard', (req, res) => {
  if (!req.session.userId) {
    res.redirect('/');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  }
});

// API: Registrierung
app.post('/api/register', (req, res) => {
  const { username, password, phone } = req.body;

  if (!username || !password || !phone) {
    return res.status(400).json({ error: 'Alle Felder sind erforderlich' });
  }

  if (!/^\d{5,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Telefonnummer muss zwischen 5 und 15 Ziffern lang sein' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const address = generateCryptoAddress();

  db.run(
    `INSERT INTO users (username, password, phone, address) VALUES (?, ?, ?, ?)`,
    [username, hashedPassword, phone, address],
    (err) => {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Benutzername oder Telefonnummer existiert bereits' });
        }
        return res.status(500).json({ error: 'Fehler bei der Registrierung' });
      }
      res.json({ message: 'Registrierung erfolgreich' });
    }
  );
});

// API: Login
app.post('/api/login', (req, res) => {
  const { username, phone, password } = req.body;

  if (!username || !password || !phone) {
    return res.status(400).json({ error: 'Benutzername, Handynummer und Passwort erforderlich' });
  }

  db.get(
    `SELECT * FROM users WHERE username = ? AND phone = ?`,
    [username, phone],
    (err, user) => {
      if (err || !user) {
        return res.status(400).json({ error: 'Ungültige Anmeldedaten' });
      }

      if (!bcrypt.compareSync(password, user.password)) {
        return res.status(400).json({ error: 'Ungültige Anmeldedaten' });
      }

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.isAdmin = user.is_admin === 1;
      res.json({ message: 'Login erfolgreich' });
    }
  );
});

// API: Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logout erfolgreich' });
});

// API: Benutzer-Info
app.get('/api/user', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  db.get(
    `SELECT id, address, balance, is_admin FROM users WHERE id = ?`,
    [req.session.userId],
    (err, user) => {
      if (err || !user) {
        return res.status(500).json({ error: 'Fehler beim Abrufen der Benutzerdaten' });
      }

      if (!user.address) {
        const newAddress = generateCryptoAddress();
        db.run(
          `UPDATE users SET address = ? WHERE id = ?`,
          [newAddress, user.id],
          (updateErr) => {
            if (updateErr) {
              console.error('Error updating missing address:', updateErr);
              return res.status(500).json({ error: 'Fehler beim Erzeugen der Wallet-Adresse' });
            }
            user.address = newAddress;
            res.json(user);
          }
        );
      } else {
        res.json(user);
      }
    }
  );
});

// API: Alle Coins abrufen
app.get('/api/coins', (req, res) => {
  db.all(`SELECT * FROM coins ORDER BY current_price ASC`, (err, coins) => {
    if (err) {
      return res.status(500).json({ error: 'Fehler beim Abrufen der Coins' });
    }
    res.json(coins);
  });
});

// API: Coin-Details mit Portfolio
app.get('/api/coin/:coinId', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const { coinId } = req.params;

  db.get(
    `SELECT * FROM coins WHERE id = ?`,
    [coinId],
    (err, coin) => {
      if (err || !coin) {
        return res.status(404).json({ error: 'Coin nicht gefunden' });
      }

      db.get(
        `SELECT amount FROM portfolio WHERE user_id = ? AND coin_id = ?`,
        [req.session.userId, coinId],
        (err, portfolio) => {
          const amount = portfolio ? portfolio.amount : 0;
          res.json({ ...coin, userAmount: amount });
        }
      );
    }
  );
});

// API: Portfolio abrufen
app.get('/api/portfolio', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  db.all(
    `SELECT c.id AS coin_id, c.name, c.current_price, p.amount,
            (p.amount * c.current_price) AS value
     FROM portfolio p
     JOIN coins c ON p.coin_id = c.id
     WHERE p.user_id = ? AND p.amount > 0
     ORDER BY c.name ASC`,
    [req.session.userId],
    (err, portfolio) => {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Abrufen des Portfolios' });
      }
      res.json(portfolio || []);
    }
  );
});

// API: Geld oder Coins an andere Adresse überweisen
app.post('/api/transfer', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const { recipientAddress, amount, coinId } = req.body;
  const value = parseFloat(amount);
  const senderId = req.session.userId;

  if (!recipientAddress || isNaN(value) || value <= 0) {
    return res.status(400).json({ error: 'Ungültige Eingaben' });
  }

  db.get(`SELECT id FROM users WHERE address = ?`, [recipientAddress], (err, recipient) => {
    if (err || !recipient) {
      return res.status(400).json({ error: 'Empfängeradresse nicht gefunden' });
    }

    if (recipient.id === senderId) {
      return res.status(400).json({ error: 'Du kannst nicht an dich selbst überweisen' });
    }

    if (coinId) {
      const coinIdNumber = parseInt(coinId, 10);
      if (isNaN(coinIdNumber)) {
        return res.status(400).json({ error: 'Ungültiger Coin' });
      }

      db.get(`SELECT * FROM coins WHERE id = ?`, [coinIdNumber], (err, coin) => {
        if (err || !coin) {
          return res.status(404).json({ error: 'Coin nicht gefunden' });
        }

        db.get(
          `SELECT amount FROM portfolio WHERE user_id = ? AND coin_id = ?`,
          [senderId, coinIdNumber],
          (err, portfolio) => {
            if (err || !portfolio || portfolio.amount < value) {
              return res.status(400).json({ error: 'Nicht genügend Coins im Portfolio' });
            }

            db.serialize(() => {
              db.run('BEGIN TRANSACTION');
              db.run(
                `UPDATE portfolio SET amount = amount - ? WHERE user_id = ? AND coin_id = ?`,
                [value, senderId, coinIdNumber]
              );
              db.run(
                `INSERT OR IGNORE INTO portfolio (user_id, coin_id, amount) VALUES (?, ?, 0)`,
                [recipient.id, coinIdNumber]
              );
              db.run(
                `UPDATE portfolio SET amount = amount + ? WHERE user_id = ? AND coin_id = ?`,
                [value, recipient.id, coinIdNumber]
              );
              db.run(
                `INSERT INTO transactions (user_id, coin_id, type, amount, price, total) VALUES (?, ?, 'transfer-out', ?, 0, 0)`,
                [senderId, coinIdNumber, value]
              );
              db.run(
                `INSERT INTO transactions (user_id, coin_id, type, amount, price, total) VALUES (?, ?, 'transfer-in', ?, 0, 0)`,
                [recipient.id, coinIdNumber, value]
              );
              db.run('COMMIT', (err) => {
                if (err) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Fehler bei der Überweisung' });
                }
                res.json({ message: `Coin erfolgreich gesendet: ${coin.name}`, coinId: coinIdNumber, amount: value });
              });
            });
          }
        );
      });
      return;
    }

    db.get(`SELECT balance FROM users WHERE id = ?`, [senderId], (err, sender) => {
      if (err || !sender) {
        return res.status(500).json({ error: 'Benutzer nicht gefunden' });
      }

      if (sender.balance < value) {
        return res.status(400).json({ error: 'Unzureichendes Guthaben' });
      }

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(
          `UPDATE users SET balance = balance - ? WHERE id = ?`,
          [value, senderId]
        );
        db.run(
          `UPDATE users SET balance = balance + ? WHERE id = ?`,
          [value, recipient.id]
        );
        db.run(
          `INSERT INTO transfers (sender_id, recipient_id, amount) VALUES (?, ?, ?)`,
          [senderId, recipient.id, value]
        );
        db.run('COMMIT', (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Fehler bei der Überweisung' });
          }
          res.json({ message: 'Überweisung erfolgreich', newBalance: sender.balance - value });
        });
      });
    });
  });
});

// API: Coin kaufen
app.post('/api/buy-coin', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const { coinId, amount } = req.body;
  const quantity = parseFloat(amount);
  const userId = req.session.userId;

  if (!coinId || isNaN(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Ungültige Menge' });
  }

  db.get(`SELECT * FROM coins WHERE id = ?`, [coinId], (err, coin) => {
    if (err || !coin) {
      return res.status(404).json({ error: 'Coin nicht gefunden' });
    }

    const buyPricePerUnit = coin.start_price >= 100 ?
      coin.current_price * 1.04 : // 3-stellige: +4%
      coin.current_price * 1.02;  // 2-stellige: +2%
    const totalCost = buyPricePerUnit * quantity;

    db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
      if (err || !user) {
        return res.status(500).json({ error: 'Benutzer nicht gefunden' });
      }

      if (user.balance < totalCost) {
        return res.status(400).json({ error: 'Unzureichende Balance' });
      }

      // Balance aktualisieren
      db.run(
        `UPDATE users SET balance = balance - ? WHERE id = ?`,
        [totalCost, userId],
        (err) => {
          if (err) {
            return res.status(500).json({ error: 'Fehler beim Kauf' });
          }

          // Portfolio aktualisieren
          db.get(
            `SELECT * FROM portfolio WHERE user_id = ? AND coin_id = ?`,
            [userId, coinId],
            (err, portfolio) => {
              if (portfolio) {
                db.run(
                  `UPDATE portfolio SET amount = amount + ? WHERE user_id = ? AND coin_id = ?`,
                  [quantity, userId, coinId],
                  (err) => {
                    if (err) {
                      return res.status(500).json({ error: 'Fehler beim Aktualisieren des Portfolios' });
                    }
                    completeTransaction();
                  }
                );
              } else {
                db.run(
                  `INSERT INTO portfolio (user_id, coin_id, amount) VALUES (?, ?, ?)`,
                  [userId, coinId, quantity],
                  (err) => {
                    if (err) {
                      return res.status(500).json({ error: 'Fehler beim Erstellen des Portfolios' });
                    }
                    completeTransaction();
                  }
                );
              }
            }
          );

          function completeTransaction() {
            db.run(
              `INSERT INTO transactions (user_id, coin_id, type, amount, price, total)
               VALUES (?, ?, 'buy', ?, ?, ?)`,
              [userId, coinId, quantity, buyPricePerUnit, totalCost],
              (err) => {
                if (err) {
                  console.error('Fehler beim Speichern der Transaktion:', err);
                }

                let priceChangePercent = coin.start_price >= 100 ? 0.04 : 0.02;
                const newPrice = coin.current_price * (1 + priceChangePercent);
                db.run(
                  `UPDATE coins SET current_price = ? WHERE id = ?`,
                  [newPrice, coinId],
                  (err) => {
                    res.json({ message: 'Coin erfolgreich gekauft', newBalance: user.balance - totalCost, newPrice, startPrice: coin.start_price });
                  }
                );
              }
            );
          }
        }
      );
    });
  });
});

// API: Coin verkaufen
app.post('/api/sell-coin', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const { coinId, amount } = req.body;
  const quantity = parseFloat(amount);
  const userId = req.session.userId;

  if (!coinId || isNaN(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Ungültige Menge' });
  }

  db.get(`SELECT * FROM coins WHERE id = ?`, [coinId], (err, coin) => {
    if (err || !coin) {
      return res.status(404).json({ error: 'Coin nicht gefunden' });
    }

    db.get(
      `SELECT amount FROM portfolio WHERE user_id = ? AND coin_id = ?`,
      [userId, coinId],
      (err, portfolio) => {
        if (err || !portfolio || portfolio.amount < quantity) {
          return res.status(400).json({ error: 'Nicht genügend Coins im Portfolio' });
        }

        let sellPricePerUnit;
        if (coin.start_price >= 100) {
          sellPricePerUnit = coin.current_price * 0.95; // 3-stellige: -5%
        } else {
          sellPricePerUnit = coin.current_price * 0.97; // 2-stellige: -3%
        }
        const totalRevenue = sellPricePerUnit * quantity;

        db.run(
          `UPDATE users SET balance = balance + ? WHERE id = ?`,
          [totalRevenue, userId],
          (err) => {
            if (err) {
              return res.status(500).json({ error: 'Fehler beim Verkauf' });
            }

            db.run(
              `UPDATE portfolio SET amount = amount - ? WHERE user_id = ? AND coin_id = ?`,
              [quantity, userId, coinId],
              (err) => {
                if (err) {
                  return res.status(500).json({ error: 'Fehler beim Aktualisieren des Portfolios' });
                }

                db.run(
                  `INSERT INTO transactions (user_id, coin_id, type, amount, price, total)
                   VALUES (?, ?, 'sell', ?, ?, ?)`,
                  [userId, coinId, quantity, sellPricePerUnit, totalRevenue],
                  (err) => {
                    if (err) {
                      console.error('Fehler beim Speichern der Transaktion:', err);
                    }
                  }
                );

                let priceChangePercent = coin.start_price >= 100 ? -0.05 : -0.03;
                const newPrice = coin.current_price * (1 + priceChangePercent);
                db.run(
                  `UPDATE coins SET current_price = ? WHERE id = ?`,
                  [newPrice, coinId],
                  (err) => {
                    db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
                      res.json({ message: 'Coin erfolgreich verkauft', newBalance: user.balance, newPrice, startPrice: coin.start_price });
                    });
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

// API: Auszahlung anfordern
app.post('/api/request-withdrawal', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const { amount, iban } = req.body;
  const userId = req.session.userId;

  if (!amount || !iban || amount <= 0) {
    return res.status(400).json({ error: 'Ungültige Eingaben' });
  }

  db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
    if (err || !user) {
      return res.status(500).json({ error: 'Benutzer nicht gefunden' });
    }

    if (user.balance < amount) {
      return res.status(400).json({ error: 'Unzureichende Balance' });
    }

    // Balance sofort reduzieren
    db.run(
      `UPDATE users SET balance = balance - ? WHERE id = ?`,
      [amount, userId],
      (err) => {
        if (err) {
          return res.status(500).json({ error: 'Fehler beim Erstellen der Auszahlungsanfrage' });
        }

        // Auszahlungsanfrage speichern
        db.run(
          `INSERT INTO withdrawals (user_id, amount, iban) VALUES (?, ?, ?)`,
          [userId, amount, iban],
          (err) => {
            if (err) {
              return res.status(500).json({ error: 'Fehler beim Speichern der Auszahlungsanfrage' });
            }
            res.json({ message: 'Auszahlungsanfrage eingereicht', newBalance: user.balance - amount });
          }
        );
      }
    );
  });
});

// Admin-API: Auszahlungen abrufen
app.get('/api/admin/withdrawals', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  db.all(
    `SELECT w.*, u.address AS user_address FROM withdrawals w 
     JOIN users u ON w.user_id = u.id 
     WHERE w.status = 'pending' 
     ORDER BY w.created_at DESC`,
    (err, withdrawals) => {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Abrufen' });
      }
      res.json(withdrawals);
    }
  );
});

// Admin-API: Alle Konten abrufen
app.get('/api/admin/accounts', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  db.all(
    `SELECT id, username, address, phone, balance, password, is_admin FROM users ORDER BY username ASC`,
    (err, accounts) => {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Abrufen' });
      }
      
      // Für jedes Konto die Coins abrufen
      let completed = 0;
      accounts.forEach(account => {
        account.coins = [];
        db.all(
          `SELECT c.id, c.name, c.current_price, p.amount FROM coins c 
           LEFT JOIN portfolio p ON c.id = p.coin_id AND p.user_id = ? 
           ORDER BY c.name ASC`,
          [account.id],
          (err, coins) => {
            if (!err && coins) {
              account.coins = coins.filter(c => c.amount && c.amount > 0);
            }
            completed++;
            if (completed === accounts.length) {
              res.json(accounts);
            }
          }
        );
      });
      
      // Falls keine Konten vorhanden
      if (accounts.length === 0) {
        res.json(accounts);
      }
    }
  );
});

// Admin-API: Geld zu Konto hinzufügen
app.post('/api/admin/add-balance', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  const { userId, amount } = req.body;

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Ungültige Eingaben' });
  }

  db.run(
    `UPDATE users SET balance = balance + ? WHERE id = ?`,
    [amount, userId],
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Hinzufügen des Guthabens' });
      }
      res.json({ message: 'Guthaben erfolgreich hinzugefügt' });
    }
  );
});

// Admin-API: Geld von Konto entfernen
app.post('/api/admin/remove-balance', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  const { userId, amount } = req.body;

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Ungültige Eingaben' });
  }

  db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }

    if (user.balance < amount) {
      return res.status(400).json({ error: 'Unzureichendes Guthaben' });
    }

    db.run(
      `UPDATE users SET balance = balance - ? WHERE id = ?`,
      [amount, userId],
      (err) => {
        if (err) {
          return res.status(500).json({ error: 'Fehler beim Entfernen des Guthabens' });
        }
        res.json({ message: 'Guthaben erfolgreich entfernt' });
      }
    );
  });
});

// Admin-API: Konto zur Admin-Rolle hinzufügen
app.post('/api/admin/make-admin/:userId', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  const { userId } = req.params;

  db.run(
    `UPDATE users SET is_admin = 1 WHERE id = ?`,
    [userId],
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Setzen der Admin-Rolle' });
      }
      res.json({ message: 'Admin-Rolle erfolgreich vergeben' });
    }
  );
});

// Admin-API: Admin-Rolle entfernen
app.post('/api/admin/remove-admin/:userId', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  const { userId } = req.params;

  db.run(
    `UPDATE users SET is_admin = 0 WHERE id = ?`,
    [userId],
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Entfernen der Admin-Rolle' });
      }
      res.json({ message: 'Admin-Rolle erfolgreich entfernt' });
    }
  );
});

// Admin-API: Konto löschen
app.post('/api/admin/delete-account/:userId', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  const { userId } = req.params;

  // Kann sich nicht selbst löschen
  if (userId == req.session.userId) {
    return res.status(400).json({ error: 'Du kannst dein eigenes Konto nicht löschen' });
  }

  // Lösche Portfolio
  db.run(`DELETE FROM portfolio WHERE user_id = ?`, [userId], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Fehler beim Löschen des Portfolios' });
    }

    // Lösche Transaktionen
    db.run(`DELETE FROM transactions WHERE user_id = ?`, [userId], (err) => {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Löschen der Transaktionen' });
      }

      // Lösche Auszahlungsanfragen
      db.run(`DELETE FROM withdrawals WHERE user_id = ?`, [userId], (err) => {
        if (err) {
          return res.status(500).json({ error: 'Fehler beim Löschen der Auszahlungen' });
        }

        // Lösche Benutzer
        db.run(`DELETE FROM users WHERE id = ?`, [userId], (err) => {
          if (err) {
            return res.status(500).json({ error: 'Fehler beim Löschen des Kontos' });
          }
          res.json({ message: 'Konto erfolgreich gelöscht' });
        });
      });
    });
  });
});

// Admin-API: Passwort zurücksetzen
app.post('/api/admin/reset-password/:userId', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  const { userId } = req.params;
  const { password } = req.body;

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen lang sein' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  db.run(
    `UPDATE users SET password = ? WHERE id = ?`,
    [hashedPassword, userId],
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Ändern des Passworts' });
      }
      res.json({ message: 'Passwort erfolgreich geändert' });
    }
  );
});

// Admin-API: Auszahlung genehmigen
app.post('/api/admin/approve-withdrawal/:withdrawalId', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  const { withdrawalId } = req.params;

  db.run(
    `UPDATE withdrawals SET status = 'approved' WHERE id = ?`,
    [withdrawalId],
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Fehler beim Genehmigen' });
      }
      res.json({ message: 'Auszahlung genehmigt' });
    }
  );
});

// Admin-API: Auszahlung ablehnen
app.post('/api/admin/reject-withdrawal/:withdrawalId', (req, res) => {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  }

  const { withdrawalId } = req.params;

  // Auszahlung in der Datenbank aktualisieren
  db.get(
    `SELECT user_id, amount FROM withdrawals WHERE id = ?`,
    [withdrawalId],
    (err, withdrawal) => {
      if (err || !withdrawal) {
        return res.status(404).json({ error: 'Auszahlung nicht gefunden' });
      }

      // Balance zurückgeben
      db.run(
        `UPDATE users SET balance = balance + ? WHERE id = ?`,
        [withdrawal.amount, withdrawal.user_id],
        (err) => {
          if (err) {
            return res.status(500).json({ error: 'Fehler beim Zurückgeben der Balance' });
          }

          // Status aktualisieren
          db.run(
            `UPDATE withdrawals SET status = 'rejected' WHERE id = ?`,
            [withdrawalId],
            (err) => {
              if (err) {
                return res.status(500).json({ error: 'Fehler beim Ablehnen' });
              }
              res.json({ message: 'Auszahlung abgelehnt und Balance zurückgegeben' });
            }
          );
        }
      );
    }
  );
});

// ensure direct messages table
db.run(`CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// start HTTP + socket.io server
const PORT = process.env.PORT || 3000;
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

// map from user id -> set of socket ids
const onlineUsers = new Map();

io.on('connection', (socket) => {
  // expect client to send a 'register' event with their userId after connecting
  socket.on('register', async (payload) => {
    try {
      const uid = payload && payload.userId;
      if (!uid) return;
      socket.userId = uid;
      if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set());
      onlineUsers.get(uid).add(socket.id);

      socket.on('direct_message', (data) => {
        const { toAddress, content } = data || {};
        if (!toAddress || !content) return;
        const text = String(content).trim().slice(0, 1000);
        if (!text) return;
        // find recipient id
        db.get(`SELECT id FROM users WHERE address = ?`, [toAddress], (err, row) => {
          if (err || !row) return;
          const rid = row.id;
          db.run(`INSERT INTO direct_messages (sender_id, recipient_id, content) VALUES (?, ?, ?)`, [uid, rid, text], function(err) {
            if (err) return;
            const payload = { id: this.lastID, fromAddress: null, toAddress, content: text, created_at: new Date().toISOString() };
            // deliver to recipient sockets
            const sockets = onlineUsers.get(rid);
            if (sockets) {
              sockets.forEach(sid => io.to(sid).emit('direct_message', payload));
            }
            // confirm to sender
            io.to(socket.id).emit('direct_message_sent', payload);
          });
        });
      });

      socket.on('disconnect', () => {
        const set = onlineUsers.get(uid);
        if (set) { set.delete(socket.id); if (set.size === 0) onlineUsers.delete(uid); }
      });
    } catch (e) {
      console.error('register handler error', e);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Royal Crypto Server läuft auf Port ${PORT}`);
  console.log(`URL: http://localhost:${PORT}`);
});

// Anonymous chat: send message
const chatRateLimits = new Map(); // userId -> {count, windowStart}
app.post('/api/chat/send', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  const { content } = req.body;
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'Ungültige Nachricht' });
  const text = content.trim();
  if (text.length === 0 || text.length > 500) return res.status(400).json({ error: 'Nachricht muss 1-500 Zeichen sein' });

  // rate limit: max 5 messages / 60s
  const uid = req.session.userId;
  const now = Date.now();
  const entry = chatRateLimits.get(uid) || { count: 0, windowStart: now };
  if (now - entry.windowStart > 60_000) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  chatRateLimits.set(uid, entry);
  if (entry.count > 5) return res.status(429).json({ error: 'Zu viele Nachrichten, bitte kurz warten' });

  db.run(`INSERT INTO messages (content) VALUES (?)`, [text], function(err) {
    if (err) return res.status(500).json({ error: 'Fehler beim Speichern der Nachricht' });
    db.get(`SELECT id, content, created_at FROM messages WHERE id = ?`, [this.lastID], (err, row) => {
      if (err) return res.status(500).json({ error: 'Fehler' });
      res.json({ message: 'Nachricht gesendet', messageItem: row });
    });
  });
});

// Get recent chat messages (public)
app.get('/api/chat', (req, res) => {
  db.all(`SELECT id, content, created_at FROM messages ORDER BY created_at DESC LIMIT 200`, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Fehler beim Laden der Nachrichten' });
    res.json(rows);
  });
});

// Admin: view messages (anonymized) and delete
app.get('/api/admin/chat', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  db.all(`SELECT id, content, created_at FROM messages ORDER BY created_at DESC LIMIT 1000`, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Fehler beim Laden der Nachrichten' });
    res.json(rows);
  });
});

app.post('/api/admin/chat/delete/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Admin-Zugriff erforderlich' });
  const { id } = req.params;
  db.run(`DELETE FROM messages WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: 'Fehler beim Löschen' });
    res.json({ message: 'Nachricht gelöscht' });
  });
});