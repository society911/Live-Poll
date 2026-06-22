const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  })
);
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

app.use(cors());
app.use(express.json());

// Подключение к PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  client_encoding: 'UTF8',
});

// Проверка соединения с БД
pool
  .connect()
  .then(() => console.log('✅ Подключено к PostgreSQL'))
  .catch((err) => console.error('❌ Ошибка подключения к БД:', err));

// API: Регистрация пользователя
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, role = 'viewer' } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, role',
      [username, email, hashedPassword, role]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Вход пользователя
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res
        .status(401)
        .json({ success: false, error: 'Пользователь не найден' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res
        .status(401)
        .json({ success: false, error: 'Неверный пароль' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Создание опроса
app.post('/api/polls', async (req, res) => {
  try {
    const { userId, question, options } = req.body;

    // Создаем опрос
    const pollResult = await pool.query(
      'INSERT INTO polls (user_id, question) VALUES ($1, $2) RETURNING id',
      [userId, question]
    );

    const pollId = pollResult.rows[0].id;

    // Добавляем варианты ответов
    for (const optionText of options) {
      await pool.query(
        'INSERT INTO options (poll_id, option_text) VALUES ($1, $2)',
        [pollId, optionText]
      );
    }

    // Получаем созданный опрос с вариантами
    const pollWithOptions = await pool.query(
      `SELECT p.*, 
                   COALESCE(json_agg(json_build_object('id', o.id, 'text', o.option_text)) FILTER (WHERE o.id IS NOT NULL), '[]') as options
            FROM polls p
            LEFT JOIN options o ON p.id = o.poll_id
            WHERE p.id = $1
            GROUP BY p.id`,
      [pollId]
    );

    res.json({ success: true, poll: pollWithOptions.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Получение активных опросов
app.get('/api/polls/active', async (req, res) => {
  try {
    const result = await pool.query(`SELECT p.*, 
                   COALESCE(json_agg(json_build_object('id', o.id, 'text', o.option_text)) FILTER (WHERE o.id IS NOT NULL), '[]') as options
            FROM polls p
            LEFT JOIN options o ON p.id = o.poll_id
            WHERE p.is_active = true
            GROUP BY p.id
        `);

    res.json({ success: true, polls: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Голосование
app.post('/api/votes', async (req, res) => {
  try {
    const { optionId, userSessionId } = req.body;

    // Проверяем, голосовал ли уже пользователь за любой вариант этого опроса
    const checkVote = await pool.query(
      `SELECT v.* FROM votes v
             JOIN options o ON v.option_id = o.id
             JOIN polls p ON o.poll_id = p.id
             WHERE v.user_session_id = $1 
             AND p.id = (SELECT poll_id FROM options WHERE id = $2)`,
      [userSessionId, optionId]
    );

    if (checkVote.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Вы уже проголосовали в этом опросе',
      });
    }

    // Записываем голос
    await pool.query(
      'INSERT INTO votes (option_id, user_session_id) VALUES ($1, $2)',
      [optionId, userSessionId]
    );

    // Получаем обновленные результаты
    const results = await pool.query(
      `SELECT o.id, o.option_text, COUNT(v.id) as vote_count
            FROM options o
            LEFT JOIN votes v ON o.id = v.option_id
            WHERE o.poll_id = (SELECT poll_id FROM options WHERE id = $1)
            GROUP BY o.id, o.option_text
            ORDER BY o.id`,
      [optionId]
    );

    res.json({ success: true, results: results.rows });

    // Отправляем обновления через WebSocket
    const pollIdResult = await pool.query(
      'SELECT poll_id FROM options WHERE id = $1',
      [optionId]
    );

    if (pollIdResult.rows.length > 0) {
      io.emit('vote_update', {
        pollId: pollIdResult.rows[0].poll_id,
        results: results.rows,
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Получение результатов опроса
app.get('/api/polls/:id/results', async (req, res) => {
  try {
    const pollId = req.params.id;

    const results = await pool.query(
      `SELECT o.id, o.option_text, COUNT(v.id) as vote_count
            FROM options o
            LEFT JOIN votes v ON o.id = v.option_id
            WHERE o.poll_id = $1
            GROUP BY o.id, o.option_text
            ORDER BY o.id`,
      [pollId]
    );

    res.json({ success: true, results: results.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// WebSocket соединения
io.on('connection', (socket) => {
  console.log('🔗 Новое WebSocket соединение:', socket.id);

  socket.on('join_poll', (pollId) => {
    socket.join(`poll_${pollId}`);
    console.log(`👥 Пользователь присоединился к опросу ${pollId}`);
  });

  socket.on('disconnect', () => {
    console.log('🔌 WebSocket соединение закрыто');
  });
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Старт сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📡 WebSocket доступен по ws://localhost:${PORT}`);
});
