const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const path = require('path');
const bodyParser = require('body-parser');
const db = require('./database-mongodb');
require('dotenv').config();

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session-Konfiguration
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/crypto-purps';

app.use(session({
  store: MongoStore.create({
    mongoUrl: mongoUri,
    touchAfter: 24 * 3600
  }),
  secret: process.env.SESSION_SECRET || 'purps-crypto-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

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

  if (!/^\d{5}$/.test(phone)) {
    return res.status(400).json({ error: 'Telefonnummer muss 5 Ziffern sein' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  db.run(
    `INSERT INTO users (username, password, phone) VALUES (?, ?, ?)`,
    [username, hashedPassword, phone],
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
    `SELECT id, username, balance, is_admin FROM users WHERE id = ?`,
    [req.session.userId],
    (err, user) => {
      if (err || !user) {
        return res.status(500).json({ error: 'Fehler beim Abrufen der Benutzerdaten' });
      }
      res.json(user);
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

// API: Coin kaufen
app.post('/api/buy-coin', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const { coinId } = req.body;
  const userId = req.session.userId;

  db.get(`SELECT * FROM coins WHERE id = ?`, [coinId], (err, coin) => {
    if (err || !coin) {
      return res.status(404).json({ error: 'Coin nicht gefunden' });
    }

    const buyPrice = coin.start_price >= 100 ? 
      coin.current_price * 1.04 : // 3-stellige: +4%
      coin.current_price * 1.02;  // 2-stellige: +2%
    
    db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
      if (err || !user) {
        return res.status(500).json({ error: 'Benutzer nicht gefunden' });
      }

      if (user.balance < buyPrice) {
        return res.status(400).json({ error: 'Unzureichende Balance' });
      }

      // Balance aktualisieren
      db.run(
        `UPDATE users SET balance = balance - ? WHERE id = ?`,
        [buyPrice, userId],
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
                // Wenn bereits vorhanden, dann Update
                db.run(
                  `UPDATE portfolio SET amount = amount + 1 WHERE user_id = ? AND coin_id = ?`,
                  [userId, coinId],
                  (err) => {
                    if (err) {
                      return res.status(500).json({ error: 'Fehler beim Aktualisieren des Portfolios' });
                    }
                    completeTransaction();
                  }
                );
              } else {
                // Wenn neu, dann Insert
                db.run(
                  `INSERT INTO portfolio (user_id, coin_id, amount) VALUES (?, ?, 1)`,
                  [userId, coinId],
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
            // Transaktion speichern
            db.run(
              `INSERT INTO transactions (user_id, coin_id, type, amount, price, total)
               VALUES (?, ?, 'buy', 1, ?, ?)`,
              [userId, coinId, buyPrice, buyPrice],
              (err) => {
                if (err) {
                  console.error('Fehler beim Speichern der Transaktion:', err);
                }
                
                // Bestimme Preis-Änderung basierend auf Coinpreis
                // 3-stellige (100€+): +4%
                // 2-stellige (10-99€): +2%
                let priceChangePercent = coin.start_price >= 100 ? 0.04 : 0.02;
                
                const newPrice = coin.current_price * (1 + priceChangePercent);
                db.run(
                  `UPDATE coins SET current_price = ? WHERE id = ?`,
                  [newPrice, coinId],
                  (err) => {
                    res.json({ message: 'Coin erfolgreich gekauft', newBalance: user.balance - buyPrice, newPrice: newPrice });
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

  const { coinId } = req.body;
  const userId = req.session.userId;

  db.get(`SELECT * FROM coins WHERE id = ?`, [coinId], (err, coin) => {
    if (err || !coin) {
      return res.status(404).json({ error: 'Coin nicht gefunden' });
    }

    db.get(
      `SELECT amount FROM portfolio WHERE user_id = ? AND coin_id = ?`,
      [userId, coinId],
      (err, portfolio) => {
        if (err || !portfolio || portfolio.amount < 1) {
          return res.status(400).json({ error: 'Coin nicht im Portfolio' });
        }

        // Verkauf: 3-stellige -5%, 2-stellige -3%
        let sellPrice;
        if (coin.start_price >= 100) {
          sellPrice = coin.current_price * 0.95; // 3-stellige: -5%
        } else {
          sellPrice = coin.current_price * 0.97; // 2-stellige: -3%
        }

        // Balance aktualisieren
        db.run(
          `UPDATE users SET balance = balance + ? WHERE id = ?`,
          [sellPrice, userId],
          (err) => {
            if (err) {
              return res.status(500).json({ error: 'Fehler beim Verkauf' });
            }

            // Portfolio aktualisieren
            db.run(
              `UPDATE portfolio SET amount = amount - 1 WHERE user_id = ? AND coin_id = ?`,
              [userId, coinId],
              (err) => {
                if (err) {
                  return res.status(500).json({ error: 'Fehler beim Aktualisieren des Portfolios' });
                }

                // Transaktion speichern
                db.run(
                  `INSERT INTO transactions (user_id, coin_id, type, amount, price, total)
                   VALUES (?, ?, 'sell', 1, ?, ?)`,
                  [userId, coinId, sellPrice, sellPrice],
                  (err) => {
                    if (err) {
                      console.error('Fehler beim Speichern der Transaktion:', err);
                    }
                  }
                );

                // Bestimme Preis-Änderung basierend auf Coinpreis
                // 3-stellige (100€+): -5%
                // 2-stellige (10-99€): -3%
                let priceChangePercent = coin.start_price >= 100 ? -0.05 : -0.03;

                const newPrice = coin.current_price * (1 + priceChangePercent);
                db.run(
                  `UPDATE coins SET current_price = ? WHERE id = ?`,
                  [newPrice, coinId],
                  (err) => {
                    db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
                      res.json({ message: 'Coin erfolgreich verkauft', newBalance: user.balance, newPrice: newPrice });
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
    `SELECT w.*, u.username FROM withdrawals w 
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
    `SELECT id, username, phone, balance, password, is_admin FROM users ORDER BY username ASC`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Purps Crypto Server läuft auf Port ${PORT}`);
  console.log(`URL: http://localhost:${PORT}`);
});
