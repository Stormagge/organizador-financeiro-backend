const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// Configuração do Firebase Admin SDK
try {
  const serviceAccount = require('./firebase-service-account.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK inicializado com sucesso!');
} catch (error) {
  console.error('Erro ao inicializar Firebase Admin SDK:', error);
  process.exit(1);
}

// Configuração dos middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check route (não precisa de autenticação)
app.get('/health', (req, res) => {
  console.log('[GET /health] Health check requisitado');
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'Organizador Financeiro API', 
    status: 'Running',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Configurar diretório do banco de dados
const dbPath = process.env.NODE_ENV === 'production' 
  ? path.join(__dirname, 'data', 'database.sqlite')
  : './database.sqlite';

// Garantir que o diretório existe
const fs = require('fs');
if (process.env.NODE_ENV === 'production') {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

const db = new sqlite3.Database(dbPath);

// Middleware global para logar todas as requisições
app.use((req, res, next) => {
  console.log('--- Nova requisição ---');
  console.log('Método:', req.method, '| URL:', req.url);
  console.log('Headers:', req.headers);
  next();
});

// Middleware para autenticar token do Firebase
async function firebaseAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  console.log('[firebaseAuth] Authorization header:', authHeader); // LOG
  if (!authHeader) return res.status(401).json({ error: 'Token ausente' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUid = decoded.uid;
    req.firebaseEmail = decoded.email;
    console.log('[firebaseAuth] Token válido para UID:', decoded.uid, 'Email:', decoded.email); // LOG
    next();
  } catch (err) {
    console.error('[firebaseAuth] Erro ao validar token:', err); // LOG
    res.status(401).json({ error: 'Token Firebase inválido' });
  }
}

// Criação de tabelas
// Usuários
// Orçamentos, despesas, perfis
db.serialize(() => {
  // Removida a tabela users pois usaremos autenticação do Firebase
    db.run(`CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_uid TEXT NOT NULL,
    name TEXT NOT NULL,
    income REAL
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

// Rotas protegidas com Firebase
app.get('/api/profiles', firebaseAuth, (req, res) => {
  console.log('[GET /api/profiles] UID:', req.firebaseUid);
  db.all('SELECT * FROM profiles WHERE user_uid = ?', [req.firebaseUid], (err, rows) => {
    if (err) {
      console.error('[GET /api/profiles] Erro ao buscar perfis:', err);
      return res.status(500).json({ error: 'Erro ao buscar perfis' });
    }
    console.log('[GET /api/profiles] Perfis retornados:', rows);
    res.json(rows);
  });
});

// Buscar perfil por nome (compatibilidade com frontend)
app.get('/api/profiles/:profileName', firebaseAuth, (req, res) => {
  const { profileName } = req.params;
  console.log('[GET /api/profiles/:profileName] UID:', req.firebaseUid, 'Profile:', profileName);
  
  db.get('SELECT * FROM profiles WHERE user_uid = ? AND name = ?', [req.firebaseUid, decodeURIComponent(profileName)], (err, profile) => {
    if (err) {
      console.error('[GET /api/profiles/:profileName] Erro:', err);
      return res.status(500).json({ error: 'Erro ao buscar perfil' });
    }
    if (!profile) {
      console.log('[GET /api/profiles/:profileName] Perfil não encontrado, criando...', profileName);
      // Criar perfil automaticamente se não existir
      db.run('INSERT INTO profiles (user_uid, name, income) VALUES (?, ?, ?)', 
        [req.firebaseUid, decodeURIComponent(profileName), null], 
        function(err) {
          if (err) {
            console.error('[GET /api/profiles/:profileName] Erro ao criar perfil:', err);
            return res.status(500).json({ error: 'Erro ao criar perfil' });
          }
          const newProfile = { id: this.lastID, name: decodeURIComponent(profileName), income: null, categories: null };
          console.log('[GET /api/profiles/:profileName] Perfil criado:', newProfile);
          res.json(newProfile);
        }
      );
    } else {
      console.log('[GET /api/profiles/:profileName] Perfil encontrado:', profile);
      res.json(profile);
    }
  });
});

app.post('/api/profiles', firebaseAuth, (req, res) => {
  const { name, income } = req.body;
  db.run('INSERT INTO profiles (user_uid, name, income) VALUES (?, ?, ?)', 
    [req.firebaseUid, name, income], 
    function(err) {
      if (err) return res.status(500).json({ error: 'Erro ao criar perfil' });
      res.json({ id: this.lastID, name, income });
    }
  );
});

// Atualizar renda do perfil
app.put('/api/profiles/:profileId/income', firebaseAuth, (req, res) => {
  const { profileId } = req.params;
  const { income } = req.body;
  
  db.get('SELECT * FROM profiles WHERE id = ? AND user_uid = ?', [profileId, req.firebaseUid], (err, profile) => {
    if (err || !profile) return res.status(403).json({ error: 'Acesso negado' });
    
    db.run('UPDATE profiles SET income = ? WHERE id = ?', [income, profileId], function(err) {
      if (err) return res.status(500).json({ error: 'Erro ao atualizar renda' });
      res.json({ success: true });
    });
  });
});

// Nova rota para atualizar categorias do perfil
app.put('/api/profiles/:profileId/categories', firebaseAuth, (req, res) => {
  const { profileId } = req.params;
  const { categories } = req.body;
  console.log('[PUT /api/profiles/:profileId/categories] ProfileId:', profileId, 'Categories:', categories);
  
  db.get('SELECT * FROM profiles WHERE id = ? AND user_uid = ?', [profileId, req.firebaseUid], (err, profile) => {
    if (err || !profile) {
      console.error('[PUT /api/profiles/:profileId/categories] Acesso negado ou erro:', err);
      return res.status(403).json({ error: 'Acesso negado' });
    }
    
    // Primeiro, remove todas as categorias existentes do perfil
    db.run('DELETE FROM budgets WHERE profile_id = ?', [profileId], (err) => {
      if (err) {
        console.error('[PUT /api/profiles/:profileId/categories] Erro ao limpar categorias:', err);
        return res.status(500).json({ error: 'Erro ao atualizar categorias' });
      }
      
      // Depois, insere as novas categorias
      if (categories && categories.length > 0) {
        const stmt = db.prepare('INSERT INTO budgets (profile_id, category, percent) VALUES (?, ?, ?)');
        for (const cat of categories) {
          stmt.run([profileId, cat.key, cat.percent]);
        }
        stmt.finalize();
      }
      
      console.log('[PUT /api/profiles/:profileId/categories] Categorias atualizadas com sucesso');
      res.json({ success: true });
    });
  });
});

// CRUD Budgets
app.get('/api/budgets/:profileId', firebaseAuth, (req, res) => {
  const { profileId } = req.params;
  // Verificar se o perfil pertence ao usuário
  db.get('SELECT * FROM profiles WHERE id = ? AND user_uid = ?', [profileId, req.firebaseUid], (err, profile) => {
    if (err || !profile) return res.status(403).json({ error: 'Acesso negado' });
    
    db.all('SELECT * FROM budgets WHERE profile_id = ?', [profileId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao buscar orçamentos' });
      res.json(rows);
    });
  });
});

app.post('/api/budgets/:profileId', firebaseAuth, (req, res) => {
  const { profileId } = req.params;
  const { category, percent } = req.body;
  
  db.get('SELECT * FROM profiles WHERE id = ? AND user_uid = ?', [profileId, req.firebaseUid], (err, profile) => {
    if (err || !profile) return res.status(403).json({ error: 'Acesso negado' });
    
    db.run('INSERT INTO budgets (profile_id, category, percent) VALUES (?, ?, ?)', 
      [profileId, category, percent], 
      function(err) {
        if (err) return res.status(500).json({ error: 'Erro ao criar orçamento' });
        res.json({ id: this.lastID, category, percent });
    });
  });
});

app.put('/api/budgets/:budgetId', firebaseAuth, (req, res) => {
  const { budgetId } = req.params;
  const { category, percent } = req.body;
  
  db.get(`
    SELECT p.* FROM profiles p
    INNER JOIN budgets b ON b.profile_id = p.id
    WHERE b.id = ? AND p.user_uid = ?
  `, [budgetId, req.firebaseUid], (err, profile) => {
    if (err || !profile) return res.status(403).json({ error: 'Acesso negado' });
    
    db.run('UPDATE budgets SET category = ?, percent = ? WHERE id = ?', 
      [category, percent, budgetId], 
      function(err) {
        if (err) return res.status(500).json({ error: 'Erro ao atualizar orçamento' });
        res.json({ success: true });
    });
  });
});

app.delete('/api/budgets/:budgetId', firebaseAuth, (req, res) => {
  const { budgetId } = req.params;
  
  db.get(`
    SELECT p.* FROM profiles p
    INNER JOIN budgets b ON b.profile_id = p.id
    WHERE b.id = ? AND p.user_uid = ?
  `, [budgetId, req.firebaseUid], (err, profile) => {
    if (err || !profile) return res.status(403).json({ error: 'Acesso negado' });
    
    db.run('DELETE FROM budgets WHERE id = ?', [budgetId], function(err) {
      if (err) return res.status(500).json({ error: 'Erro ao remover orçamento' });
      res.json({ success: true });
    });
  });
});

// CRUD Expenses
app.get('/api/expenses/:profileId', firebaseAuth, (req, res) => {
  const { profileId } = req.params;
  
  db.get('SELECT * FROM profiles WHERE id = ? AND user_uid = ?', [profileId, req.firebaseUid], (err, profile) => {
    if (err || !profile) return res.status(403).json({ error: 'Acesso negado' });
    
    db.all('SELECT * FROM expenses WHERE profile_id = ?', [profileId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao buscar despesas' });
      res.json(rows);
    });
  });
});

app.post('/api/expenses/:profileId', firebaseAuth, (req, res) => {
  const { profileId } = req.params;
  const { value, date, description, category, recurring } = req.body;
  
  db.get('SELECT * FROM profiles WHERE id = ? AND user_uid = ?', [profileId, req.firebaseUid], (err, profile) => {
    if (err || !profile) return res.status(403).json({ error: 'Acesso negado' });
    
    db.run('INSERT INTO expenses (profile_id, value, date, description, category, recurring) VALUES (?, ?, ?, ?, ?, ?)',
      [profileId, value, date, description, category, recurring ? 1 : 0],
      function(err) {
        if (err) return res.status(500).json({ error: 'Erro ao criar despesa' });
        res.json({ id: this.lastID, value, date, description, category, recurring });
    });
  });
});

app.put('/api/expenses/:expenseId', firebaseAuth, (req, res) => {
  const { expenseId } = req.params;
  const { value, date, description, category, recurring } = req.body;
  
  db.get(`
    SELECT p.* FROM profiles p
    INNER JOIN expenses e ON e.profile_id = p.id
    WHERE e.id = ? AND p.user_uid = ?
  `, [expenseId, req.firebaseUid], (err, profile) => {
    if (err || !profile) return res.status(403).json({ error: 'Acesso negado' });
    
    db.run('UPDATE expenses SET value = ?, date = ?, description = ?, category = ?, recurring = ? WHERE id = ?',
      [value, date, description, category, recurring ? 1 : 0, expenseId],
      function(err) {
        if (err) return res.status(500).json({ error: 'Erro ao atualizar despesa' });
        res.json({ success: true });
    });
  });
});

app.delete('/api/expenses/:expenseId', firebaseAuth, (req, res) => {
  const { expenseId } = req.params;
  
  db.get(`
    SELECT p.* FROM profiles p
    INNER JOIN expenses e ON e.profile_id = p.id
    WHERE e.id = ? AND p.user_uid = ?
  `, [expenseId, req.firebaseUid], (err, profile) => {
    if (err || !profile) return res.status(403).json({ error: 'Acesso negado' });
    
    db.run('DELETE FROM expenses WHERE id = ?', [expenseId], function(err) {
      if (err) return res.status(500).json({ error: 'Erro ao remover despesa' });
      res.json({ success: true });
    });
  });
});

// CRUD Expenses - Nova rota compatível com frontend
app.get('/api/expenses', firebaseAuth, (req, res) => {
  const { profile, month } = req.query;
  console.log('[GET /api/expenses] UID:', req.firebaseUid, 'Profile:', profile, 'Month:', month);
  
  if (!profile) {
    return res.status(400).json({ error: 'Parâmetro profile é obrigatório' });
  }
  
  // Buscar perfil por nome
  db.get('SELECT * FROM profiles WHERE user_uid = ? AND name = ?', [req.firebaseUid, profile], (err, profileData) => {
    if (err) {
      console.error('[GET /api/expenses] Erro ao buscar perfil:', err);
      return res.status(500).json({ error: 'Erro ao buscar perfil' });
    }
    if (!profileData) {
      console.log('[GET /api/expenses] Perfil não encontrado:', profile);
      return res.json([]); // Retorna array vazio se perfil não existir
    }
    
    let query = 'SELECT * FROM expenses WHERE profile_id = ?';
    let params = [profileData.id];
    
    // Filtrar por mês se especificado
    if (month) {
      query += ' AND date LIKE ?';
      params.push(`${month}%`);
    }
    
    db.all(query, params, (err, rows) => {
      if (err) {
        console.error('[GET /api/expenses] Erro ao buscar despesas:', err);
        return res.status(500).json({ error: 'Erro ao buscar despesas' });
      }
      console.log('[GET /api/expenses] Despesas retornadas:', rows.length);
      res.json(rows);
    });
  });
});

app.post('/api/expenses', firebaseAuth, (req, res) => {
  const { value, date, description, category, recurring, profile, month } = req.body;
  console.log('[POST /api/expenses] UID:', req.firebaseUid, 'Data:', req.body);
  
  if (!profile) {
    return res.status(400).json({ error: 'Parâmetro profile é obrigatório' });
  }
  
  // Buscar perfil por nome
  db.get('SELECT * FROM profiles WHERE user_uid = ? AND name = ?', [req.firebaseUid, profile], (err, profileData) => {
    if (err) {
      console.error('[POST /api/expenses] Erro ao buscar perfil:', err);
      return res.status(500).json({ error: 'Erro ao buscar perfil' });
    }
    if (!profileData) {
      console.error('[POST /api/expenses] Perfil não encontrado:', profile);
      return res.status(404).json({ error: 'Perfil não encontrado' });
    }
    
    db.run('INSERT INTO expenses (profile_id, value, date, description, category, recurring) VALUES (?, ?, ?, ?, ?, ?)',
      [profileData.id, value, date, description, category, recurring ? 1 : 0],
      function(err) {
        if (err) {
          console.error('[POST /api/expenses] Erro ao criar despesa:', err);
          return res.status(500).json({ error: 'Erro ao criar despesa' });
        }
        const newExpense = { id: this.lastID, value, date, description, category, recurring };
        console.log('[POST /api/expenses] Despesa criada:', newExpense);
        res.json(newExpense);
      }
    );
  });
});

// Inicialização do servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=== Organizador Financeiro API ===`);
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Database: ${dbPath}`);
  console.log(`⏰ Started at: ${new Date().toISOString()}`);
  console.log(`===============================`);
});
