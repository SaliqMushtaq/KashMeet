const express = require('express'), http = require('http'), path = require('path'), fs = require('fs');
const crypto = require('crypto'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const multer = require('multer'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3'), { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'); // set JWT_SECRET so sessions survive restarts
const MAX_PEERS = 8; // mesh topology: each peer sends to every other peer
const ROOM_RE = /^[a-z0-9-]{3,40}$/;

const db = new Database(path.join(__dirname, 'meet.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, hash TEXT);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, room TEXT, name TEXT, size INTEGER, uploader TEXT)`);
const UP = path.join(__dirname, 'uploads'); fs.mkdirSync(UP, { recursive: true });

const app = express(), server = http.createServer(app), io = new Server(server);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'], fontSrc: ['https://fonts.gstatic.com'],
  connectSrc: ["'self'", 'ws:', 'wss:'], mediaSrc: ["'self'", 'blob:'], imgSrc: ["'self'", 'data:', 'blob:'],
  upgradeInsecureRequests: null } } }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(__dirname));

const sign = u => jwt.sign({ sub: u }, SECRET, { expiresIn: '12h' });
const verify = t => { try { return jwt.verify(t, SECRET).sub; } catch { return null; } };
const requireAuth = (req, res, next) => {
  const u = verify((req.headers.authorization || '').replace('Bearer ', ''));
  if (!u) return res.status(401).json({ error: 'Sign in again.' });
  req.user = u; next();
};

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const creds = req => {
  const { username, password } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return null;
  if (typeof password !== 'string' || password.length < 8 || password.length > 100) return null;
  return { username, password };
};
app.post('/api/register', authLimit, async (req, res) => {
  const c = creds(req);
  if (!c) return res.status(400).json({ error: 'Username: 3-20 letters, numbers or _. Password: 8+ characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(c.username)) return res.status(409).json({ error: 'That username is taken.' });
  db.prepare('INSERT INTO users(username,hash) VALUES(?,?)').run(c.username, await bcrypt.hash(c.password, 12));
  res.json({ token: sign(c.username), username: c.username });
});
app.post('/api/login', authLimit, async (req, res) => {
  const c = creds(req), row = c && db.prepare('SELECT * FROM users WHERE username=?').get(c.username);
  if (!row || !(await bcrypt.compare(c.password, row.hash))) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: sign(row.username), username: row.username });
});

const upload = multer({ storage: multer.diskStorage({ destination: UP, filename: (r, f, cb) => cb(null, crypto.randomBytes(16).toString('hex')) }),
  limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/upload/:room', requireAuth, (req, res) => {
  if (!ROOM_RE.test(req.params.room)) return res.status(400).json({ error: 'Bad room.' });
  upload.single('file')(req, res, err => {
    if (err || !req.file) return res.status(400).json({ error: 'Upload failed (25 MB max).' });
    const f = { id: req.file.filename, room: req.params.room, name: path.basename(req.file.originalname), size: req.file.size, uploader: req.user };
    db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(f.id, f.room, f.name, f.size, f.uploader);
    io.to(f.room).emit('file', f); res.json(f);
  });
});
app.get('/api/files/:id', requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.sendStatus(404);
  res.download(path.join(UP, f.id), f.name);
});

const board = {}; // room -> drawing segments, replayed for late joiners
io.use((s, next) => { const u = verify(s.handshake.auth.token); if (!u) return next(new Error('auth')); s.user = u; next(); });
io.on('connection', s => {
  s.on('join', async room => {
    if (!ROOM_RE.test(room) || s.room) return;
    const members = await io.in(room).fetchSockets();
    if (members.length >= MAX_PEERS) return s.emit('full');
    s.room = room; s.join(room);
    s.emit('peers', members.map(m => ({ id: m.id, name: m.user })));
    s.emit('wb:history', board[room] || []);
    s.emit('files', db.prepare('SELECT * FROM files WHERE room=?').all(room));
  });
  s.on('signal', ({ to, data }) => io.to(to).emit('signal', { from: s.id, name: s.user, data }));
  s.on('wb:seg', seg => { if (!s.room) return; (board[s.room] ||= []).push(seg); if (board[s.room].length > 20000) board[s.room].shift(); s.to(s.room).emit('wb:seg', seg); });
  s.on('wb:clear', () => { if (!s.room) return; board[s.room] = []; io.to(s.room).emit('wb:clear'); });
  s.on('disconnect', async () => {
    if (!s.room) return;
    s.to(s.room).emit('peer-left', s.id);
    if (!(await io.in(s.room).fetchSockets()).length) delete board[s.room];
  });
});
server.listen(PORT, () => console.log(`Keashur Meet on http://localhost:${PORT}`));
