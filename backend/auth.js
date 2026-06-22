const crypto = require('crypto');

// Константы для хеширования
const ITERATIONS = 100000;
const KEY_LEN = 32;
const DIGEST = 'sha256';

function hashPassword(password) {
    // Генерируем случайную соль
    const salt = crypto.randomBytes(16).toString('hex');
    // Хешируем
    const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST).toString('base64');
    // Склеиваем: алгоритм$итерации$соль$хэш
    return `pbkdf2_sha256$${ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(plainPassword, hashedPassword) {
    try {
        const parts = hashedPassword.split('$');
        if (parts.length !== 4) return false;

        const [algo, iter, salt, hash] = parts;
        
        const verifyHash = crypto.pbkdf2Sync(
            plainPassword, 
            salt, 
            parseInt(iter), 
            KEY_LEN, 
            DIGEST
        ).toString('base64');

        return verifyHash === hash;
    } catch (e) {
        console.error("Ошибка проверки пароля:", e);
        return false;
    }
}

module.exports = { hashPassword, verifyPassword };