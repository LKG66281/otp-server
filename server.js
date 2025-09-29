const express = require('express');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
const app = express();
const wss = new WebSocket.Server({ port: 8080 });
const db = new sqlite3.Database(path.join(__dirname, 'data', 'mydb.db'), (err) => {
  if (err) console.error('Database error:', err);
});

app.use(express.json());
app.use(helmet());
app.use('/send-otp', rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }));

const transporter = nodemailer.createTransport({
  host: 'localhost',
  port: 25,
  secure: false,
});

const clients = new Map();

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phone TEXT UNIQUE,
    email TEXT UNIQUE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS otps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    otp TEXT,
    created_at DATETIME,
    expires_at DATETIME
  )`);
});

setInterval(() => {
  db.run(`DELETE FROM otps WHERE expires_at < ?`, [new Date()], (err) => {
    if (err) console.error('Cleanup error:', err);
  });
}, 60 * 60 * 1000);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

wss.on('connection', (ws, req) => {
  const userId = new URLSearchParams(req.url.split('?')[1]).get('userId');
  if (userId) {
    const existingClient = clients.get(userId);
    if (existingClient) existingClient.close();
    clients.set(userId, ws);
    ws.on('close', () => clients.delete(userId));
    ws.on('error', () => clients.delete(userId));
    ws.send(JSON.stringify({ message: 'Connected' }));
  } else {
    ws.close();
  }
});

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post('/register', (req, res) => {
  const { userId, phone, email } = req.body;
  if (!userId || !phone || !email) return res.status(400).json({ error: 'Missing userId, phone, or email' });
  db.run(
    `INSERT OR IGNORE INTO users (id, phone, email) VALUES (?, ?, ?)`,
    [userId, phone, email],
    (err) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ message: 'User registered' });
    }
  );
});

app.post('/send-otp', async (req, res) => {
  const { userId, method } = req.body;
  if (!userId || !method || !['push', 'email'].includes(method)) {
    return res.status(400).json({ error: 'Invalid userId or method' });
  }
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  db.get(`SELECT id, email FROM users WHERE id = ?`, [userId], async (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    db.run(
      `INSERT INTO otps (user_id, otp, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      [userId, otp, new Date(), expiresAt],
      async (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (method === 'push') {
          const client = clients.get(userId);
          if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ otp, expiresAt }));
            return res.json({ message: 'OTP sent via push' });
          } else {
            return res.status(400).json({ error: 'User not connected' });
          }
        } else if (method === 'email') {
          try {
            await transporter.sendMail({
              from: 'no-reply@yourdomain.com',
              to: user.email,
              subject: 'Your OTP Code',
              text: `Your OTP is ${otp}. Expires in 5 minutes.`,
            });
            return res.json({ message: 'OTP sent via email' });
          } catch (error) {
            console.error('Email error:', err);
            return res.status(500).json({ error: 'Failed to send email' });
          }
        }
      }
    );
  });
});

app.post('/verify-otp', (req, res) => {
  const { userId, otp } = req.body;
  if (!userId || !otp) return res.status(400).json({ error: 'Missing userId or OTP' });
  db.get(
    `SELECT * FROM otps WHERE user_id = ? AND otp = ? AND expires_at > ?`,
    [userId, otp, new Date()],
    (err, row) => {
      if (err || !row) return res.status(400).json({ error: 'Invalid or expired OTP' });
      db.run(`DELETE FROM otps WHERE id = ?`, [row.id], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ message: 'OTP verified' });
      });
    }
  );
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));