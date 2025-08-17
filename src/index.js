require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT || 5432,
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser());

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev_secret_change_me';

// Nodemailer transport
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Utilidades
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

async function sendEmail(to, subject, text, html) {
  const from = process.env.FROM_EMAIL || process.env.SMTP_USER;
  await transporter.sendMail({ from, to, subject, text, html });
}

// Middleware para verificar session cookie
async function authMiddleware(req, res, next) {
  const session = req.cookies.session;
  if (!session) {
    req.user = null;
    return next();
  }
  try {
    const decoded = Buffer.from(session, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    const userId = parsed.id;
    const user = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
    if (!user.rows.length) {
      req.user = null;
      return next();
    }
    const email = user.rows[0].email;
    const expected = sha256(email + ':' + userId + ':' + COOKIE_SECRET);
    if (parsed.h !== expected) {
      req.user = null;
      return next();
    }
    req.user = { id: userId, email };
    next();
  } catch (err) {
    console.error('auth parse error', err);
    req.user = null;
    next();
  }
}

// Rutas públicas
app.get('/', (req, res) => {
  res.render('index', { message: null });
});

// Enviar código al email
app.post('/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send('Email requerido');
  // Busca o crea usuario
  let user = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
  let userId;
  if (!user.rows.length) {
    const r = await pool.query('INSERT INTO users(email) VALUES($1) RETURNING id, email', [email]);
    userId = r.rows[0].id;
  } else {
    userId = user.rows[0].id;
  }
  // Generar código 6 dígitos
  const code = ('' + Math.floor(100000 + Math.random() * 900000));
  const codeHash = sha256(code);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 15); // 15 minutos

  await pool.query(
    'INSERT INTO tokens(user_id, code_hash, expires_at, used) VALUES($1,$2,$3,$4)',
    [userId, codeHash, expiresAt, false]
  );

  // Enviar email con código
  await sendEmail(email, 'Tu código de inicio de sesión', `Tu código: ${code}\nVálido 15 minutos.`, `<p>Tu código: <b>${code}</b></p><p>Válido 15 minutos.</p>`);

  res.render('verify', { email, message: 'Código enviado. Revisa tu email.' });
});

// Verificar código
app.post('/auth/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).send('Email y código requeridos');

  const userQ = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (!userQ.rows.length) return res.status(400).send('Usuario no encontrado');

  const userId = userQ.rows[0].id;
  const codeHash = sha256(code);

  const tokenQ = await pool.query(
    `SELECT id, used, expires_at FROM tokens WHERE user_id = $1 AND code_hash = $2 ORDER BY id DESC LIMIT 1`,
    [userId, codeHash]
  );
  if (!tokenQ.rows.length) return res.status(400).send('Código inválido');

  const tokenRow = tokenQ.rows[0];
  if (tokenRow.used) return res.status(400).send('Código ya usado');
  if (new Date(tokenRow.expires_at) < new Date()) return res.status(400).send('Código expirado');

  // Marcar usado
  await pool.query('UPDATE tokens SET used = true WHERE id = $1', [tokenRow.id]);

  // Notificar por email login exitoso
  await sendEmail(email, 'Inicio de sesión exitoso', `Iniciaste sesión con ${email}`, `<p>Has iniciado sesión en la app.</p>`);

  // Crear cookie de sesión (por defecto 1 día)
  const h = sha256(email + ':' + userId + ':' + COOKIE_SECRET);
  const payload = Buffer.from(JSON.stringify({ id: userId, h })).toString('base64');
  // 1 día por defecto
  res.cookie('session', payload, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });

  // Renderiza página que pedirá la duración de la sesión
  res.render('session_choice', { email, userId });
});

// Endpoint para ajustar duración de sesión (client lo llama)
app.post('/auth/session-duration', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).send({ ok: false, error: 'No autenticado' });
  const { choice } = req.body; // expected: '1day' | '60days' | 'always'
  let maxAge;
  if (choice === '1day') maxAge = 24 * 60 * 60 * 1000;
  else if (choice === '60days') maxAge = 60 * 24 * 60 * 60 * 1000;
  else maxAge = 10 * 365 * 24 * 60 * 60 * 1000; // "always" ~ 10 años

  const h = sha256(req.user.email + ':' + req.user.id + ':' + COOKIE_SECRET);
  const payload = Buffer.from(JSON.stringify({ id: req.user.id, h })).toString('base64');
  res.cookie('session', payload, { httpOnly: true, maxAge });
  res.json({ ok: true });
});

// Notas - interfaz
app.get('/notes', authMiddleware, async (req, res) => {
  if (!req.user) return res.redirect('/');
  res.render('notes', { user: req.user });
});

// API - crear nota
app.post('/api/nota/crear', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false });
  const { content } = req.body;
  const r = await pool.query(
    'INSERT INTO notes(user_id, content) VALUES($1,$2) RETURNING id, content, created_at',
    [req.user.id, content]
  );
  res.json({ ok: true, note: r.rows[0] });
});

// API - editar
app.post('/api/nota/editar', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false });
  const { id, content } = req.body;
  await pool.query('UPDATE notes SET content=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3', [content, id, req.user.id]);
  res.json({ ok: true });
});

// API - borrar
app.post('/api/nota/borrar', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false });
  const { id } = req.body;
  await pool.query('DELETE FROM notes WHERE id=$1 AND user_id=$2', [id, req.user.id]);
  res.json({ ok: true });
});

// API - obtener todas por user
app.get('/api/notas/getAllByIdUser', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false });
  const r = await pool.query('SELECT id, content, created_at, updated_at FROM notes WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ ok: true, notes: r.rows });
});

// Logout
app.get('/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.redirect('/');
});

app.listen(port, () => {
  console.log('App escuchando en http://localhost:' + port);
});
