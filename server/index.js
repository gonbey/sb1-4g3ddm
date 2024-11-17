import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createClient } from '@libsql/client';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Configure CORS with specific options
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || '12', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

const db = createClient({
  url: 'file:todo.db'
});

// Initialize database
await db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )
`);

await db.execute(`
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Register user
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    await db.execute({
      sql: 'INSERT INTO users (username, password) VALUES (?, ?)',
      args: [username, hashedPassword]
    });
    
    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      res.status(400).json({ message: 'Username already exists' });
    } else {
      console.error('Registration error:', error);
      res.status(500).json({ message: 'Error registering user' });
    }
  }
});

// Login user
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });

    const user = result.rows[0];
    
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ token, username: user.username });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Error logging in' });
  }
});

// Get all todos for authenticated user
app.get('/api/todos', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM todos WHERE user_id = ? ORDER BY position ASC',
      args: [req.user.id]
    });
    res.json(result.rows);
  } catch (error) {
    console.error('Fetch todos error:', error);
    res.status(500).json({ message: 'Error fetching todos' });
  }
});

// Add new todo
app.post('/api/todos', authenticateToken, async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ message: 'Todo text is required' });
    }

    // Get the maximum position for the user's todos
    const maxPositionResult = await db.execute({
      sql: 'SELECT COALESCE(MAX(position), -1) as maxPosition FROM todos WHERE user_id = ?',
      args: [req.user.id]
    });
    const newPosition = maxPositionResult.rows[0].maxPosition + 1;

    const result = await db.execute({
      sql: 'INSERT INTO todos (user_id, text, position) VALUES (?, ?, ?) RETURNING *',
      args: [req.user.id, text, newPosition]
    });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create todo error:', error);
    res.status(500).json({ message: 'Error creating todo' });
  }
});

// Update todo positions (MOVED BEFORE :id routes)
app.patch('/api/todos/reorder', authenticateToken, async (req, res) => {
  try {
    const { orderedIds } = req.body;
    
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ message: 'Invalid order data' });
    }

    // Start a write transaction
    await db.transaction('write', async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.execute({
          sql: 'UPDATE todos SET position = ? WHERE id = ? AND user_id = ?',
          args: [i, orderedIds[i], req.user.id]
        });
      }
    });

    res.json({ message: 'Todo order updated successfully' });
  } catch (error) {
    console.error('Reorder todos error:', error);
    res.status(500).json({ message: 'Error reordering todos' });
  }
});

// Toggle todo completion
app.patch('/api/todos/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.execute({
      sql: `
        UPDATE todos 
        SET completed = NOT completed 
        WHERE id = ? AND user_id = ?
        RETURNING *
      `,
      args: [id, req.user.id]
    });
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Todo not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update todo error:', error);
    res.status(500).json({ message: 'Error updating todo' });
  }
});

// Delete todo
app.delete('/api/todos/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.execute({
      sql: 'DELETE FROM todos WHERE id = ? AND user_id = ?',
      args: [id, req.user.id]
    });
    
    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: 'Todo not found' });
    }
    
    res.json({ message: 'Todo deleted' });
  } catch (error) {
    console.error('Delete todo error:', error);
    res.status(500).json({ message: 'Error deleting todo' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});