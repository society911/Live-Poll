const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const { hashPassword, verifyPassword } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// инициализация базы данных
const db = new sqlite3.Database('./poll.db');

// включение каскадного удаления для связей
db.run("PRAGMA foreign_keys = ON");

db.serialize(() => {
    // создание таблицы пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'viewer',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // создание таблицы опросов
    db.run(`CREATE TABLE IF NOT EXISTS polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        question TEXT NOT NULL,
        is_active BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // создание таблицы вариантов ответа
    db.run(`CREATE TABLE IF NOT EXISTS options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        option_text TEXT NOT NULL,
        FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    )`);
    
    // создание таблицы голосов
    db.run(`CREATE TABLE IF NOT EXISTS votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        option_id INTEGER NOT NULL,
        user_session_id TEXT NOT NULL,
        voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (option_id) REFERENCES options(id) ON DELETE CASCADE,
        UNIQUE(poll_id, user_session_id) 
    )`);
    
    console.log('база данных успешно запущена');
});

// вспомогательные функции для работы с бд
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { if (err) reject(err); else resolve({ id: this.lastID }); });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
});

// регистрация нового пользователя
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const passwordHash = hashPassword(password);
        await dbRun('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)', [username, email, passwordHash]);
        const user = await dbGet('SELECT id, username, role FROM users WHERE username = ?', [username]);
        res.json({ success: true, user });
    } catch (error) { res.json({ success: false, error: error.message }); }
});

// вход пользователя в систему
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
        if (!user || !verifyPassword(password, user.password_hash)) return res.json({ success: false, error: 'неверный логин или пароль' });
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (error) { res.json({ success: false, error: error.message }); }
});

// получение списка активных опросов
app.get('/api/polls/active', async (req, res) => {
    try {
        const polls = await dbAll('SELECT * FROM polls WHERE is_active = 1');
        for (let poll of polls) {
            poll.options = await dbAll('SELECT id, option_text as text FROM options WHERE poll_id = ?', [poll.id]);
        }
        res.json({ success: true, polls });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// список всех опросов для администратора
app.get('/api/polls/admin-list', async (req, res) => {
    try {
        const polls = await dbAll('SELECT * FROM polls ORDER BY id DESC');
        res.json({ success: true, polls });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// получение результатов голосования по id
app.get('/api/polls/:id/results', async (req, res) => {
    try {
        const pollId = req.params.id;
        const rows = await dbAll(`
            SELECT o.id, COUNT(v.id) as vote_count 
            FROM options o 
            LEFT JOIN votes v ON o.id = v.option_id 
            WHERE o.poll_id = ? 
            GROUP BY o.id
        `, [pollId]);
        res.json({ success: true, results: rows });
    } catch (error) { res.json({ success: false, error: error.message }); }
});

// создание нового опроса и рассылка через сокеты
app.post('/api/polls', async (req, res) => {
    try {
        const { userId, question, options } = req.body;
        console.log("получен запрос на создание опроса:", { userId, question, options });

        if (!question || !options || options.length < 2) {
            return res.status(400).json({ success: false, error: 'недостаточно данных' });
        }

        const result = await dbRun('INSERT INTO polls (user_id, question, is_active) VALUES (?, ?, ?)', [userId || 1, question, 1]);
        const pollId = result.id;

        for (let opt of options) {
            await dbRun('INSERT INTO options (poll_id, option_text) VALUES (?, ?)', [pollId, opt]);
        }

        const savedOptions = await dbAll('SELECT id, option_text as text FROM options WHERE poll_id = ?', [pollId]);
        const newPoll = { id: pollId, question, options: savedOptions };

        io.emit('poll_started', newPoll);
        res.json({ success: true, pollId: pollId });
    } catch (error) {
        console.error('ошибка при создании опроса:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// обработка голоса пользователя
app.post('/api/votes', async (req, res) => {
    const { optionId, userSessionId } = req.body;
    try {
        const option = await dbGet('SELECT poll_id FROM options WHERE id = ?', [optionId]);
        if (!option) return res.status(404).json({ success: false, error: 'вариант не найден' });
        
        await dbRun('INSERT INTO votes (poll_id, option_id, user_session_id) VALUES (?, ?, ?)', [option.poll_id, optionId, userSessionId]);
        
        const results = await dbAll(`
            SELECT o.id, COUNT(v.id) as vote_count FROM options o 
            LEFT JOIN votes v ON o.id = v.option_id 
            WHERE o.poll_id = ? GROUP BY o.id`, [option.poll_id]);
        
        io.emit('vote_update', { pollId: option.poll_id, results });
        res.json({ success: true });
    } catch (e) {
        if (e.message.includes('UNIQUE')) return res.json({ success: false, error: 'вы уже голосовали в этом опросе' });
        res.status(500).json({ success: false, error: e.message });
    }
});

// переключение статуса опроса (активен/неактивен)
app.patch('/api/polls/:id/toggle', async (req, res) => {
    try {
        const pollId = req.params.id;
        const poll = await dbGet('SELECT id, is_active FROM polls WHERE id = ?', [pollId]);
        if (!poll) return res.status(404).json({ success: false, error: 'опрос не найден' });

        const newStatus = poll.is_active ? 0 : 1;
        await dbRun('UPDATE polls SET is_active = ? WHERE id = ?', [newStatus, pollId]);

        if (newStatus) {
            const pollData = await dbGet('SELECT * FROM polls WHERE id = ?', [pollId]);
            pollData.options = await dbAll('SELECT id, option_text as text FROM options WHERE poll_id = ?', [pollId]);
            io.emit('poll_started', pollData);
        } else {
            io.emit('poll_ended', parseInt(pollId));
        }

        res.json({ success: true, is_active: newStatus === 1 });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// удаление опроса по id
app.delete('/api/polls/:id', async (req, res) => {
    try {
        const pollId = req.params.id;
        await dbRun('DELETE FROM polls WHERE id = ?', [pollId]);
        io.emit('poll_ended', parseInt(pollId));
        res.json({ success: true });
    } catch (error) {
        console.error('ошибка при удалении:', error);
        res.status(500).json({ success: false, error: 'ошибка сервера' });
    }
});

// настройка статических файлов фронтенда
app.use(express.static(path.join(__dirname, '../frontend')));

// перенаправление всех остальных запросов на главную страницу
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`сервер запущен: http://localhost:${PORT}`);
});

// создание учетной записи администратора по умолчанию
async function createAdmin() {
    const adminHash = hashPassword("admin123");
    db.get("SELECT id FROM users WHERE username = 'admin'", (err, row) => {
        if (!row) db.run(`INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)`, 
        ['admin', 'admin@poll.ru', adminHash, 'admin']);
    });
}
setTimeout(createAdmin, 500);