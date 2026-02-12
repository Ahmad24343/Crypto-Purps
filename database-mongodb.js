const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Verbindung zu MongoDB
const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/crypto-purps';
    await mongoose.connect(uri);
    console.log('Datenbank verbunden');
    initializeDatabase();
  } catch (err) {
    console.error('Fehler beim Verbinden zur Datenbank:', err);
    setTimeout(connectDB, 5000);
  }
};

// Schema Definitionen
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  phone: { type: String, unique: true, required: true },
  balance: { type: Number, default: 0 },
  is_admin: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now }
});

const coinSchema = new mongoose.Schema({
  name: { type: String, unique: true, required: true },
  start_price: { type: Number, required: true },
  current_price: { type: Number, required: true },
  created_at: { type: Date, default: Date.now }
});

const portfolioSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  coin_id: mongoose.Schema.Types.ObjectId,
  amount: { type: Number, default: 0 }
});

const transactionSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  coin_id: mongoose.Schema.Types.ObjectId,
  type: String,
  amount: Number,
  price: Number,
  total: Number,
  created_at: { type: Date, default: Date.now }
});

const withdrawalSchema = new mongoose.Schema({
  user_id: mongoose.Schema.Types.ObjectId,
  amount: Number,
  iban: String,
  status: { type: String, default: 'pending' },
  created_at: { type: Date, default: Date.now }
});

// Models
const User = mongoose.model('User', userSchema);
const Coin = mongoose.model('Coin', coinSchema);
const Portfolio = mongoose.model('Portfolio', portfolioSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

async function initializeDatabase() {
  try {
    // Admin-Konto erstellen
    const adminExists = await User.findOne({ username: 'Admin' });
    if (!adminExists) {
      const hashedPassword = bcrypt.hashSync('AdminAccount123', 10);
      await User.create({
        username: 'Admin',
        password: hashedPassword,
        phone: '12345',
        balance: 0,
        is_admin: 1
      });
      console.log('Admin-Konto erstellt');
    }

    // Coins erstellen
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

    for (const coin of coins) {
      const exists = await Coin.findOne({ name: coin.name });
      if (!exists) {
        await Coin.create({
          name: coin.name,
          start_price: coin.price,
          current_price: coin.price
        });
      }
    }

    console.log('✓ Database initialized successfully');
  } catch (err) {
    console.error('Fehler bei der Datenbankinitialisierung:', err);
  }
}

// Wrapper Funktionen für Kompatibilität
const db = {
  User,
  Coin,
  Portfolio,
  Transaction,
  Withdrawal,
  run: function(sql, params, callback) {
    // Wird nicht direkt von MongoDB verwendet
    if (callback) callback();
  },
  get: function(sql, params, callback) {
    // Wird nicht direkt von MongoDB verwendet
    if (callback) callback(null, null);
  },
  all: function(sql, params, callback) {
    // Wird nicht direkt von MongoDB verwendet
    if (callback) callback(null, []);
  }
};

// Verbindung starten
connectDB();

module.exports = db;
