// Self-contained auth module for the trader scanner.
// Implements: register, email verification, login (HMAC-signed cookie session),
// password reset (raw token in URL, sha256 in store), SMTP send with stdout fallback.
//
// Mirrors the LifePilot Next.js auth design but adapted to a vanilla Node.js +
// static-HTML stack: users live in a JSON file under /data so they survive
// scanner restarts, sessions are stateless HMAC tokens (no DB session table).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let nodemailer = null;
try { nodemailer = require('nodemailer'); }
catch { /* SMTP fallback to stdout when nodemailer isn't installed */ }

// ─── Config ───
const SESSION_TTL_MS  = 30 * 24 * 60 * 60 * 1000;   // 30 days
const VERIFY_TTL_MS   = 24 * 60 * 60 * 1000;        // 24 hours
const RESET_TTL_MS    =  1 * 60 * 60 * 1000;        // 1 hour
const COOKIE_NAME     = 'trader_session';
const USERS_FILE      = process.env.AUTH_USERS_FILE || '/data/auth-users.json';

const AUTH_SECRET = (() => {
    const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || '';
    if (!s || s.length < 16) {
        console.warn('[auth] AUTH_SECRET is missing or short — sessions will be invalidated on restart. ' +
                     'Set AUTH_SECRET to a stable random string (>=32 chars).');
        return crypto.randomBytes(32).toString('hex');
    }
    return s;
})();

const APP_BASE_URL =
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    process.env.APP_BASE_URL ||
    (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : 'http://localhost:3000');

const APP_NAME = process.env.APP_NAME || 'Trader';

// ─── User store (JSON file) ───
let users = [];

function loadUsers() {
    try {
        const raw = fs.readFileSync(USERS_FILE, 'utf-8');
        users = JSON.parse(raw);
        if (!Array.isArray(users)) users = [];
    } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[auth] failed to read ${USERS_FILE}: ${err.message}`);
        users = [];
    }
}

function saveUsers() {
    try {
        fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (err) {
        console.error(`[auth] failed to write ${USERS_FILE}: ${err.message}`);
    }
}

function findUserByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    return users.find(u => u.email === normalized) || null;
}

// ─── Password hashing (scrypt — built-in, no deps) ───
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
    if (!stored || !stored.startsWith('scrypt$')) return false;
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ─── Session token (HMAC-signed, stateless) ───
function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function createSession(user) {
    const payload = { uid: user.id, email: user.email, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS };
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', AUTH_SECRET).update(body).digest());
    return `${body}.${sig}`;
}

function verifySession(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = b64url(crypto.createHmac('sha256', AUTH_SECRET).update(body).digest());
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    let payload;
    try { payload = JSON.parse(b64urlDecode(body).toString('utf-8')); }
    catch { return null; }
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
}

// ─── Cookie helpers ───
function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of String(header).split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    }
    return out;
}

function buildSessionCookie(token, { maxAgeSec, secure }) {
    const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (typeof maxAgeSec === 'number') parts.push(`Max-Age=${maxAgeSec}`);
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

function isHttps(req) {
    if (req.socket && req.socket.encrypted) return true;
    const xfp = req.headers['x-forwarded-proto'];
    if (typeof xfp === 'string' && xfp.split(',')[0].trim().toLowerCase() === 'https') return true;
    return APP_BASE_URL.startsWith('https://');
}

function getSessionFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (!token) return null;
    return verifySession(token);
}

function setSessionCookie(req, res, user) {
    const token = createSession(user);
    res.setHeader('Set-Cookie',
        buildSessionCookie(token, { maxAgeSec: Math.floor(SESSION_TTL_MS / 1000), secure: isHttps(req) }));
}

function clearSessionCookie(req, res) {
    res.setHeader('Set-Cookie',
        buildSessionCookie('', { maxAgeSec: 0, secure: isHttps(req) }));
}

// ─── Email tokens ───
function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

// ─── Email sending (SMTP via nodemailer, fallback to stdout) ───
const SMTP_HOST     = process.env.SMTP_HOST || '';
const SMTP_PORT     = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465;
const SMTP_SECURE   = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : SMTP_PORT === 465;
const SMTP_USER     = process.env.SMTP_USER || '';
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';
const EMAIL_FROM    = process.env.EMAIL_FROM || SMTP_USER || `${APP_NAME} <noreply@localhost>`;

let mailTransport = null;
if (nodemailer && SMTP_HOST && SMTP_USER && SMTP_PASSWORD) {
    mailTransport = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    });
}

async function sendEmail({ to, subject, text, html }) {
    if (!mailTransport) {
        console.info(`\n--- [auth dev email]\nto: ${to}\nsubject: ${subject}\n\n${text}\n---\n`);
        return;
    }
    await mailTransport.sendMail({ from: EMAIL_FROM, to, subject, text, html: html || text });
}

function verificationEmail(url) {
    return {
        subject: `${APP_NAME}: подтвердите ваш email`,
        text: `Здравствуйте!\n\nЧтобы завершить регистрацию в ${APP_NAME}, откройте ссылку (действует 24 часа):\n${url}\n\nЕсли вы не регистрировались — просто проигнорируйте это письмо.`,
    };
}

function passwordResetEmail(url) {
    return {
        subject: `${APP_NAME}: сброс пароля`,
        text: `Здравствуйте!\n\nЧтобы установить новый пароль в ${APP_NAME}, откройте ссылку (действует 1 час):\n${url}\n\nЕсли вы не запрашивали сброс пароля — просто проигнорируйте это письмо.`,
    };
}

function appUrl(p) {
    return new URL(p, APP_BASE_URL).toString();
}

// ─── Public actions ───
async function registerUser({ email, password, name }) {
    email = String(email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, error: 'Неверный email' };
    }
    if (!password || password.length < 8) {
        return { ok: false, error: 'Пароль должен быть не короче 8 символов' };
    }
    const existing = findUserByEmail(email);
    if (existing && existing.emailVerified) {
        return { ok: false, error: 'Пользователь с такой почтой уже существует' };
    }
    const passwordHash = hashPassword(password);
    const now = new Date().toISOString();
    if (existing) {
        existing.passwordHash = passwordHash;
        if (name) existing.name = String(name).slice(0, 100);
        existing.updatedAt = now;
    } else {
        users.push({
            id: crypto.randomUUID(),
            email,
            name: name ? String(name).slice(0, 100) : null,
            passwordHash,
            emailVerified: null,
            verificationToken: null,
            verificationExpiresAt: null,
            resetTokenHash: null,
            resetExpiresAt: null,
            resetUsedAt: null,
            createdAt: now,
            updatedAt: now,
        });
    }
    const user = findUserByEmail(email);
    const rawToken = randomToken();
    user.verificationToken = rawToken;
    user.verificationExpiresAt = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
    saveUsers();
    const url = appUrl(`/verify.html?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(email)}`);
    try { await sendEmail({ to: email, ...verificationEmail(url) }); }
    catch (err) { console.error(`[auth] register: sendEmail failed: ${err.message}`); }
    return { ok: true };
}

function verifyEmail({ token, email }) {
    email = String(email || '').trim().toLowerCase();
    if (!token || !email) return { ok: false, error: 'Неверная ссылка' };
    const user = findUserByEmail(email);
    if (!user || user.verificationToken !== token) {
        return { ok: false, error: 'Ссылка недействительна' };
    }
    if (!user.verificationExpiresAt || new Date(user.verificationExpiresAt).getTime() < Date.now()) {
        user.verificationToken = null;
        user.verificationExpiresAt = null;
        saveUsers();
        return { ok: false, error: 'Срок действия ссылки истёк' };
    }
    user.emailVerified = new Date().toISOString();
    user.verificationToken = null;
    user.verificationExpiresAt = null;
    user.updatedAt = user.emailVerified;
    saveUsers();
    return { ok: true };
}

function loginUser({ email, password }) {
    email = String(email || '').trim().toLowerCase();
    const user = findUserByEmail(email);
    if (!user || !user.passwordHash) {
        return { ok: false, error: 'Неверный email или пароль' };
    }
    if (!verifyPassword(password, user.passwordHash)) {
        return { ok: false, error: 'Неверный email или пароль' };
    }
    if (!user.emailVerified) {
        return { ok: false, error: 'Подтвердите почту по ссылке из письма' };
    }
    return { ok: true, user };
}

async function requestPasswordReset({ email }) {
    email = String(email || '').trim().toLowerCase();
    if (!email) return { ok: true };          // do not leak existence
    const user = findUserByEmail(email);
    if (!user) return { ok: true };
    const rawToken = randomToken();
    user.resetTokenHash = sha256(rawToken);
    user.resetExpiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
    user.resetUsedAt = null;
    user.updatedAt = new Date().toISOString();
    saveUsers();
    const url = appUrl(`/reset-apply.html?token=${encodeURIComponent(rawToken)}`);
    try { await sendEmail({ to: user.email, ...passwordResetEmail(url) }); }
    catch (err) { console.error(`[auth] reset: sendEmail failed: ${err.message}`); }
    return { ok: true };
}

function applyPasswordReset({ token, password }) {
    if (!token || typeof token !== 'string' || token.length < 16) {
        return { ok: false, error: 'Ссылка недействительна' };
    }
    if (!password || password.length < 8) {
        return { ok: false, error: 'Пароль должен быть не короче 8 символов' };
    }
    const tokenHash = sha256(token);
    const user = users.find(u => u.resetTokenHash === tokenHash);
    if (!user || user.resetUsedAt || !user.resetExpiresAt ||
        new Date(user.resetExpiresAt).getTime() < Date.now()) {
        return { ok: false, error: 'Ссылка недействительна или истекла' };
    }
    user.passwordHash = hashPassword(password);
    user.resetUsedAt = new Date().toISOString();
    user.resetTokenHash = null;
    user.resetExpiresAt = null;
    user.updatedAt = user.resetUsedAt;
    saveUsers();
    return { ok: true };
}

// ─── Initial seed user (test account) ───
function seedInitialUser() {
    const email = (process.env.INITIAL_USER_EMAIL || '').trim().toLowerCase();
    const password = process.env.INITIAL_USER_PASSWORD || '';
    if (!email || !password) return;
    if (findUserByEmail(email)) return;
    const now = new Date().toISOString();
    users.push({
        id: crypto.randomUUID(),
        email,
        name: process.env.INITIAL_USER_NAME || 'Test user',
        passwordHash: hashPassword(password),
        emailVerified: now,
        verificationToken: null,
        verificationExpiresAt: null,
        resetTokenHash: null,
        resetExpiresAt: null,
        resetUsedAt: null,
        createdAt: now,
        updatedAt: now,
    });
    saveUsers();
    console.log(`[auth] seeded initial user: ${email}`);
}

function init() {
    loadUsers();
    seedInitialUser();
    console.log(`[auth] users loaded: ${users.length} (file: ${USERS_FILE})`);
}

module.exports = {
    init,
    // session
    getSessionFromRequest,
    setSessionCookie,
    clearSessionCookie,
    // actions
    registerUser,
    verifyEmail,
    loginUser,
    requestPasswordReset,
    applyPasswordReset,
};
