const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'crypto.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Fehler beim Öffnen der Datenbank:', err);
    process.exit(1);
  } else {
    console.log('Datenbank verbunden');
    resetPrices();
  }
});

function resetPrices() {
  db.run(`UPDATE coins SET current_price = start_price`, (err) => {
    if (err) {
      console.error('Fehler beim Reset:', err);
    } else {
      console.log('✓ Alle Preise zurückgesetzt!');
    }
    db.close();
    process.exit(0);
  });
}
