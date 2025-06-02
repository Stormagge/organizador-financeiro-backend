// ...existing code...
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Config
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
const db = new sqlite3.Database('./database.sqlite');
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

// Criação de tabelas
// Usuários
// Orçamentos, despesas, perfis
// ...existing code...
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    percent INTEGER NOT NULL,
    FOREIGN KEY(profile_id) REFERENCES profiles(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    value REAL NOT NULL,
    date TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    recurring INTEGER DEFAULT 0,
    FOREIGN KEY(profile_id) REFERENCES profiles(id)
  )`);
});

// ...existing code...
// Rotas de autenticação
app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash], function(err) {
    if (err) return res.status(400).json({ error: 'Usuário já existe' });
    const token = jwt.sign({ userId: this.lastID }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Usuário não encontrado' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'Senha inválida' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  });
});

// Middleware de autenticação
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token ausente' });
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ...existing code...
// Rotas protegidas (exemplo: CRUD de perfis, orçamentos, despesas)
app.get('/api/profiles', auth, (req, res) => {
  db.all('SELECT * FROM profiles WHERE user_id = ?', [req.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar perfis' });
    res.json(rows);
  });
});

app.post('/api/profiles', auth, (req, res) => {
  const { name } = req.body;
  db.run('INSERT INTO profiles (user_id, name) VALUES (?, ?)', [req.userId, name], function(err) {
    if (err) return res.status(500).json({ error: 'Erro ao criar perfil' });
    res.json({ id: this.lastID, name });
  });
});

// CRUD Budgets
// Listar budgets de um perfil
app.get('/api/budgets/:profileId', auth, (req, res) => {
  const { profileId } = req.params;
  db.all('SELECT * FROM budgets WHERE profile_id = ?', [profileId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar orçamentos' });
    res.json(rows);
  });
});

// Criar budget
app.post('/api/budgets/:profileId', auth, (req, res) => {
  const { profileId } = req.params;
  const { category, percent } = req.body;
  db.run('INSERT INTO budgets (profile_id, category, percent) VALUES (?, ?, ?)', [profileId, category, percent], function(err) {
    if (err) return res.status(500).json({ error: 'Erro ao criar orçamento' });
    res.json({ id: this.lastID, category, percent });
  });
});

// Atualizar budget
app.put('/api/budgets/:budgetId', auth, (req, res) => {
  const { budgetId } = req.params;
  const { category, percent } = req.body;
  db.run('UPDATE budgets SET category = ?, percent = ? WHERE id = ?', [category, percent, budgetId], function(err) {
    if (err) return res.status(500).json({ error: 'Erro ao atualizar orçamento' });
    res.json({ success: true });
  });
});

// Remover budget
app.delete('/api/budgets/:budgetId', auth, (req, res) => {
  const { budgetId } = req.params;
  db.run('DELETE FROM budgets WHERE id = ?', [budgetId], function(err) {
    if (err) return res.status(500).json({ error: 'Erro ao remover orçamento' });
    res.json({ success: true });
  });
});

// CRUD Expenses
// Listar expenses de um perfil
app.get('/api/expenses/:profileId', auth, (req, res) => {
  const { profileId } = req.params;
  db.all('SELECT * FROM expenses WHERE profile_id = ?', [profileId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar despesas' });
    res.json(rows);
  });
});

// Criar expense
app.post('/api/expenses/:profileId', auth, (req, res) => {
  const { profileId } = req.params;
  const { value, date, description, category, recurring } = req.body;
  db.run('INSERT INTO expenses (profile_id, value, date, description, category, recurring) VALUES (?, ?, ?, ?, ?, ?)', [profileId, value, date, description, category, recurring ? 1 : 0], function(err) {
    if (err) return res.status(500).json({ error: 'Erro ao criar despesa' });
    res.json({ id: this.lastID, value, date, description, category, recurring });
  });
});

// Atualizar expense
app.put('/api/expenses/:expenseId', auth, (req, res) => {
  const { expenseId } = req.params;
  const { value, date, description, category, recurring } = req.body;
  db.run('UPDATE expenses SET value = ?, date = ?, description = ?, category = ?, recurring = ? WHERE id = ?', [value, date, description, category, recurring ? 1 : 0, expenseId], function(err) {
    if (err) return res.status(500).json({ error: 'Erro ao atualizar despesa' });
    res.json({ success: true });
  });
});

// Remover expense
app.delete('/api/expenses/:expenseId', auth, (req, res) => {
  const { expenseId } = req.params;
  db.run('DELETE FROM expenses WHERE id = ?', [expenseId], function(err) {
    if (err) return res.status(500).json({ error: 'Erro ao remover despesa' });
    res.json({ success: true });
  });
});

// Inicialização
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});
// ...existing code...
