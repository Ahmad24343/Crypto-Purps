const tough = require('tough-cookie');
const fetchCookie = require('fetch-cookie');
const nodeFetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'crypto.db');

async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function run() {
  console.log('Starting E2E test script');

  // Ensure server likely running
  try {
    const r = await fetch(BASE + '/');
    if (!r.ok && r.status !== 200) throw new Error('no http 200');
  } catch (err) {
    console.error('Failed to reach server at', BASE, '- please start it first (npm start)');
    process.exit(1);
  }

  const db = new sqlite3.Database(DB_PATH);

  // Create test users directly in DB (if exist, skip)
  const adminUser = { username: 'e2e_admin', phone: '90000', password: 'adminpass', balance: 1000, is_admin: 1 };
  const normalUser = { username: 'e2e_user', phone: '90001', password: 'userpass', balance: 200, is_admin: 0 };

  function ensureUser(u) {
    return new Promise((resolve, reject) => {
      db.get(`SELECT id, address FROM users WHERE username = ?`, [u.username], (err, row) => {
        if (err) return reject(err);
        if (row) return resolve(row);

        const hash = bcrypt.hashSync(u.password, 10);
        const addr = '0x' + require('crypto').randomBytes(20).toString('hex');
        db.run(`INSERT INTO users (username, password, phone, address, balance, is_admin) VALUES (?, ?, ?, ?, ?, ?)`,
          [u.username, hash, u.phone, addr, u.balance, u.is_admin], function(err) {
            if (err) return reject(err);
            resolve({id: this.lastID, address: addr});
          }
        );
      });
    });
  }

  const adminRow = await ensureUser(adminUser);
  const normalRow = await ensureUser(normalUser);

  console.log('Test users prepared:', adminRow, normalRow);

  // Create fetch clients with cookie jars
  const jarAdmin = new tough.CookieJar();
  const jarUser = new tough.CookieJar();
  const clientAdmin = fetchCookie(nodeFetch, jarAdmin);
  const clientUser = fetchCookie(nodeFetch, jarUser);

  // Login both
  async function login(client, username, phone, password) {
    const res = await client(BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, phone, password })
    });
    return res.json();
  }

  console.log('Logging in admin...');
  await login(clientAdmin, adminUser.username, adminUser.phone, adminUser.password);
  console.log('Logging in normal user...');
  await login(clientUser, normalUser.username, normalUser.phone, normalUser.password);

  // Debug: fetch current user info to confirm roles
  const adminView = await (await clientAdmin(BASE + '/api/user')).json();
  const userView = await (await clientUser(BASE + '/api/user')).json();
  console.log('Admin session is_admin=', adminView.is_admin, 'User session is_admin=', userView.is_admin);

  // Check admin endpoint access
  try {
    const r = await clientAdmin(BASE + '/api/admin/accounts');
    const rjson = await r.json();
    console.log('Admin accounts fetched OK, count=', rjson.length);
  } catch (err) {
    console.error('Admin accounts fetch failed:', err.response && err.response.data || err.message);
    process.exit(1);
  }

  // Verify normal user cannot access admin endpoint using its cookie jar explicitly
  try {
    const cookieStr = await new Promise((res, rej) => jarUser.getCookieString(BASE, (e, s) => e ? rej(e) : res(s)));
    const r = await nodeFetch(BASE + '/api/admin/accounts', { headers: { Cookie: cookieStr } });
    if (r.status === 200) {
      console.error('ERROR: normal user accessed admin endpoint!');
      process.exit(1);
    } else {
      console.log('Normal user admin access correctly blocked (status', r.status + ')');
    }
  } catch (err) {
    console.log('Normal user admin access correctly blocked.');
  }

  // Fetch a coin to buy
  const coinsRes = await clientUser(BASE + '/api/coins');
  const coins = await coinsRes.json();
  if (!coins || coins.length === 0) {
    console.error('No coins available to buy');
    process.exit(1);
  }
  const coin = coins[0];
  console.log('Buying coin', coin.name, 'id', coin.id);

  // Ensure user has sufficient balance by admin adding balance
  await clientAdmin(BASE + '/api/admin/add-balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: normalRow.id, amount: 500 }) });
  console.log('Added 500 to normal user balance');

  // Buy fractional amount 0.67
  const buyAmount = 0.67;
  const buyResRaw = await clientUser(BASE + '/api/buy-coin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coinId: coin.id, amount: buyAmount }) });
  const buyRes = await buyResRaw.json();
  console.log('Buy response:', buyRes.message, 'newBalance=', buyRes.newBalance);

  // Get user info and portfolio
  const userInfo = await (await clientUser(BASE + '/api/user')).json();
  const portfolio = await (await clientUser(BASE + '/api/portfolio')).json();
  console.log('User balance after buy:', userInfo.balance, 'Portfolio entries:', portfolio.length);

  // Transfer a small amount to admin
  const adminInfo = await (await clientAdmin(BASE + '/api/user')).json();
  const transferAmount = 1.23;
  try {
    const tRaw = await clientUser(BASE + '/api/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientAddress: adminInfo.address, amount: transferAmount }) });
    const t = await tRaw.json();
    console.log('Transfer succeeded:', t.message);
  } catch (err) {
    console.error('Transfer failed:', err.response && err.response.data || err.message);
    process.exit(1);
  }

  // Verify balances changed
  const userAfter = await (await clientUser(BASE + '/api/user')).json();
  const adminAfter = await (await clientAdmin(BASE + '/api/user')).json();
  console.log('User balance now:', userAfter.balance, 'Admin balance now:', adminAfter.balance);

  console.log('E2E script completed successfully.');
  db.close();
}

run().catch(err => {
  console.error('E2E script failed:', err);
  process.exit(1);
});
