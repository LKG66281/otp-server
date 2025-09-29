const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use('/apk', express.static('static')); // Serve APK from static folder

// In-memory SQLite database
const db = new sqlite3.Database(':memory:');

// Initialize database schema
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
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

// WebSocket server
const wss = new WebSocket.Server({ port: 8080 });
const clients = new Map(); // Store WebSocket clients by userId

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const userId = params.get('userId');
  if (userId) {
    clients.set(userId, ws);
    ws.send(JSON.stringify({ message: 'Connected' }));
    ws.on('close', () => clients.delete(userId));
  } else {
    ws.close();
  }
});

// Nodemailer setup for email
const transporter = nodemailer.createTransport({
  sendmail: true,
  newline: 'unix',
  path: '/usr/sbin/sendmail'
});

// Generate OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Register user
app.post('/register', (req, res) => {
  const { userId, phone, email } = req.body;
  if (!userId || !phone || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.run(
    `INSERT INTO users (userId, phone, email) VALUES (?, ?, ?)`,
    [userId, phone, email],
    function (err) {
      if (err) {
        return res.status(400).json({ error: 'User already exists' });
      }
      res.json({ message: 'User registered' });
    }
  );
});

// Send OTP
app.post('/send-otp', (req, res) => {
  const { userId, method } = req.body;
  if (!userId || !method) {
    return res.status(400).json({ error: 'Missing userId or method' });
  }

  db.get(`SELECT * FROM users WHERE userId = ?`, [userId], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const otp = generateOTP();
    const createdAt = Date.now();
    const expiresAt = createdAt + 10 * 60 * 1000; // 10 minutes expiry

    db.run(
      `INSERT INTO otps (user_id, otp, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      [userId, otp, createdAt, expiresAt],
      (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to store OTP' });
        }

        if (method === 'push' && clients.has(userId)) {
          const ws = clients.get(userId);
          ws.send(JSON.stringify({ otp, expiresAt }));
          res.json({ message: 'OTP sent via push' });
        } else if (method === 'email') {
          const mailOptions = {
            from: 'otp@otp-server-lkg66281.onrender.com',
            to: user.email,
            subject: 'Your OTP Code',
            text: `Your OTP is ${otp}. It expires at ${new Date(expiresAt).toLocaleString()}.`
          };
          transporter.sendMail(mailOptions, (error) => {
            if (error) {
              return res.status(500).json({ error: 'Failed to send email' });
            }
            res.json({ message: 'OTP sent via email' });
          });
        } else {
          res.status(400).json({ error: 'Invalid method or user not connected' });
        }
      }
    );
  });
});

// Verify OTP
app.post('/verify-otp', (req, res) => {
  const { userId, otp } = req.body;
  if (!userId || !otp) {
    return res.status(400).json({ error: 'Missing userId or otp' });
  }

  db.get(
    `SELECT * FROM otps WHERE user_id = ? AND otp = ? AND expires_at > ?`,
    [userId, otp, Date.now()],
    (err, row) => {
      if (err || !row) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
      }
      db.run(`DELETE FROM otps WHERE id = ?`, [row.id], (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to clear OTP' });
        }
        res.json({ message: 'OTP verified' });
      });
    }
  );
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});