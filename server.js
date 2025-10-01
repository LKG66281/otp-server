const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use('/apk', express.static('static'));

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

// Create HTTP server and attach WebSocket
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

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

// Nodemailer setup for Gmail SMTP
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587, // Use 587 for STARTTLS
  secure: false, // false for 587 (STARTTLS), true for 465 (SSL)
  auth: {
    user: process.env.EMAIL_USER || 'gamer.lkg.2.0@gmail.com', // Fallback for local testing
    pass: process.env.EMAIL_PASS || 'cebfgxqlgroycxlc' // Replace with your App Password
  },
  tls: {
    rejectUnauthorized: false // Helps with cert issues on Render
  }
});

// Verify transporter on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP Verification Error:', error);
  } else {
    console.log('SMTP Server ready to send emails');
  }
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
        console.error('Register Error:', err);
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
      console.error('User Query Error:', err);
      return res.status(404).json({ error: 'User not found' });
    }

    const otp = generateOTP();
    const createdAt = Date.now();
    const expiresAt = createdAt + 10 * 60 * 1000;

    db.run(
      `INSERT INTO otps (user_id, otp, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      [userId, otp, createdAt, expiresAt],
      (err) => {
        if (err) {
          console.error('OTP Storage Error:', err);
          return res.status(500).json({ error: 'Failed to store OTP' });
        }

        if (method === 'push' && clients.has(userId)) {
          const ws = clients.get(userId);
          ws.send(JSON.stringify({ otp, expiresAt }));
          res.json({ message: 'OTP sent via push' });
        } else if (method === 'email') {
          const mailOptions = {
            from: `"OTP Service" <${process.env.EMAIL_USER || 'gamer.lkg.2.0@gmail.com'}>`,
            to: user.email,
            subject: 'Your OTP Code',
            text: `Your OTP is ${otp}. It expires at ${new Date(expiresAt).toLocaleString()}.`,
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
                <h2 style="color: #333;">Your OTP Code</h2>
                <p>Your OTP is <strong style="color: #007bff;">${otp}</strong>.</p>
                <p>It expires at <em>${new Date(expiresAt).toLocaleString()}</em>.</p>
                <p style="color: #555;">Please do not share this code.</p>
              </div>
            `
          };

          transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
              console.error('Email Send Error:', error);
              return res.status(500).json({ error: 'Failed to send email', details: error.message });
            }
            console.log('Email sent:', info.response);
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
        console.error('OTP Verification Error:', err);
        return res.status(400).json({ error: 'Invalid or expired OTP' });
      }
      db.run(`DELETE FROM otps WHERE id = ?`, [row.id], (err) => {
        if (err) {
          console.error('OTP Deletion Error:', err);
          return res.status(500).json({ error: 'Failed to clear OTP' });
        }
        res.json({ message: 'OTP verified' });
      });
    }
  );
});

// Start server
server.listen(port, '0.0.0.0', () => { // Bind to 0.0.0.0 for Render
  console.log(`Server running on port ${port}`);
});