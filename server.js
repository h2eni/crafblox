const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const PASSWORD_BYTES = 64;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function createApp({
  dbPath = path.join(__dirname, 'data', 'crafblox.sqlite'),
  publicDir = __dirname,
  production = process.env.NODE_ENV === 'production'
} = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY,
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      UNIQUE (requester_id, recipient_id),
      CHECK (requester_id <> recipient_id)
    );

    CREATE TABLE IF NOT EXISTS friendships (
      user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_a, user_b),
      CHECK (user_a < user_b)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id),
      CHECK (blocker_id <> blocked_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK (sender_id <> recipient_id)
    );

    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(sender_id, recipient_id, id);

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK (reporter_id <> reported_id)
    );

    CREATE INDEX IF NOT EXISTS reports_open ON reports(created_at);
  `);

  const authAttempts = new Map();
  const messageAttempts = new Map();

  function json(response, statusCode, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    const origin = response._requestOrigin || '*';
    response.writeHead(statusCode, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': origin !== '*' ? 'true' : 'false',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    });
    response.end(body);
  }

  function sendError(response, statusCode, message) {
    json(response, statusCode, { error: message });
  }

  function parseCookies(headerValue = '') {
    return Object.fromEntries(
      (headerValue || '')
        .split(';')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
          const index = pair.indexOf('=');
          if (index === -1) return null;
          const key = pair.slice(0, index).trim();
          const value = decodeURIComponent(pair.slice(index + 1).trim());
          return [key, value];
        })
        .filter(Boolean)
    );
  }

  function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  function sessionCookie(token, clear = false) {
    const secureSuffix = production ? '; Secure' : '';
    const maxAge = clear ? 0 : Math.floor(SESSION_LIFETIME_MS / 1000);
    return `crafblox_session=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureSuffix}`;
  }

  async function readJson(request) {
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 16_384) {
        const error = new Error('Request body is too large.');
        error.status = 413;
        throw error;
      }
    }

    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid JSON payload.');
      }
      return parsed;
    } catch {
      const error = new Error('Send valid JSON.');
      error.status = 400;
      throw error;
    }
  }

  function sameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;

    try {
      const originHost = new URL(origin).host;
      const host = request.headers.host || '';
      const allowed = new Set(['localhost:3000', '127.0.0.1:3000', 'h2eni.github.io', 'www.h2eni.github.io']);
      return originHost === host || allowed.has(originHost);
    } catch {
      return false;
    }
  }

  function allowRate(map, key, limit, windowMs) {
    const now = Date.now();
    const hits = (map.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    if (hits.length >= limit) {
      map.set(key, hits);
      return false;
    }
    hits.push(now);
    map.set(key, hits);
    return true;
  }

  function userFromSession(request) {
    const token = parseCookies(request.headers.cookie).crafblox_session;
    if (!token || token.length > 200) return null;

    const row = db.prepare(`
      SELECT users.id, users.username, users.created_at AS createdAt
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(hashToken(token), Date.now());

    if (!row) return null;

    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), row.id);
    return row;
  }

  function authenticated(request, response) {
    const user = userFromSession(request);
    if (!user) {
      sendError(response, 401, 'Sign in to use your account.');
      return null;
    }
    return user;
  }

  function publicUser(row) {
    return {
      id: row.id,
      username: row.username,
      online: Date.now() - row.last_seen < 90_000,
      createdAt: row.created_at ?? row.createdAt
    };
  }

  function areFriends(userA, userB) {
    return Boolean(db.prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?').get(Math.min(userA, userB), Math.max(userA, userB)));
  }

  function isBlocked(userA, userB) {
    return Boolean(db.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
      .get(userA, userB, userB, userA));
  }

  function friendRows(userId) {
    return db.prepare(`
      SELECT users.id, users.username, users.created_at AS createdAt, users.last_seen
      FROM friendships
      JOIN users ON users.id = CASE WHEN friendships.user_a = ? THEN friendships.user_b ELSE friendships.user_a END
      WHERE friendships.user_a = ? OR friendships.user_b = ?
      ORDER BY users.username COLLATE NOCASE
    `).all(userId, userId, userId).map(publicUser);
  }

  function createSession(userId, response) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_LIFETIME_MS;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expiresAt);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    const user = db.prepare('SELECT id, username, created_at AS createdAt FROM users WHERE id = ?').get(userId);
    json(response, 200, { user }, { 'Set-Cookie': sessionCookie(token) });
  }

  function dispatchApi(request, response, url) {
    const method = request.method.toUpperCase();
    const segments = url.pathname.split('/').filter(Boolean);
    response._requestOrigin = request.headers.origin && sameOrigin(request) ? request.headers.origin : '*';

    if (method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': response._requestOrigin,
        'Access-Control-Allow-Credentials': response._requestOrigin !== '*' ? 'true' : 'false',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      response.end();
      return;
    }

    if (method !== 'GET' && !sameOrigin(request)) {
      sendError(response, 403, 'Cross-origin requests are not allowed.');
      return;
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      json(response, 200, { status: 'ok' });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/me') {
      json(response, 200, { user: userFromSession(request) });
      return;
    }

    if (method === 'POST' && (url.pathname === '/api/auth/signup' || url.pathname === '/api/auth/login')) {
      const ip = request.socket.remoteAddress || 'unknown';
      if (!allowRate(authAttempts, ip, 12, 15 * 60_000)) {
        sendError(response, 429, 'Too many sign-in attempts. Please try again later.');
        return;
      }

      void readJson(request)
        .then((body) => {
          const username = typeof body.username === 'string' ? body.username.trim() : '';
          const password = typeof body.password === 'string' ? body.password : '';

          if (url.pathname.endsWith('/signup')) {
            if (!USERNAME_PATTERN.test(username)) {
              sendError(response, 400, 'Usernames must be 3–20 characters: letters, numbers, or underscores.');
              return;
            }
            if (password.length < 10 || password.length > 128) {
              sendError(response, 400, 'Passwords must be 10–128 characters.');
              return;
            }

            const salt = crypto.randomBytes(16);
            const hash = crypto.scryptSync(password, salt, PASSWORD_BYTES, { N: 16384, r: 8, p: 1 }).toString('hex');
            try {
              const result = db.prepare('INSERT INTO users (username, password_salt, password_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
                .run(username, salt.toString('hex'), hash, Date.now(), Date.now());
              createSession(result.lastInsertRowid, response);
            } catch (cause) {
              const message = String(cause?.message || '');
              if (cause?.code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE')) {
                sendError(response, 409, 'That username is already taken.');
                return;
              }
              throw cause;
            }
            return;
          }

          const account = db.prepare('SELECT id, username, password_salt, password_hash, created_at AS createdAt FROM users WHERE username = ? COLLATE NOCASE').get(username);
          const salt = Buffer.from(account?.password_salt || '00'.repeat(32), 'hex');
          const expectedHash = Buffer.from(account?.password_hash || '00'.repeat(PASSWORD_BYTES), 'hex');
          const actualHash = crypto.scryptSync(password, salt, PASSWORD_BYTES, { N: 16384, r: 8, p: 1 });

          if (!account || password.length > 128 || !crypto.timingSafeEqual(actualHash, expectedHash)) {
            sendError(response, 401, 'Username or password is incorrect.');
            return;
          }

          createSession(account.id, response);
        })
        .catch((cause) => {
          if (!response.headersSent) {
            sendError(response, cause.status || 500, cause.status ? cause.message : 'Could not complete sign in.');
          }
        });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = parseCookies(request.headers.cookie).crafblox_session;
      if (token) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      }
      json(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', true) });
      return;
    }

    const user = authenticated(request, response);
    if (!user) return;

    if (method === 'GET' && url.pathname === '/api/users') {
      const search = (url.searchParams.get('search') || '').trim().slice(0, 30);
      const escaped = search.replace(/[\\%_]/g, '\\$&');
      const rows = db.prepare(`
        SELECT id, username, created_at, last_seen
        FROM users
        WHERE id <> ?
          AND username LIKE ? ESCAPE '\\'
          AND NOT EXISTS (
            SELECT 1 FROM blocks
            WHERE (blocker_id = ? AND blocked_id = users.id)
               OR (blocker_id = users.id AND blocked_id = ?)
          )
        ORDER BY username COLLATE NOCASE
        LIMIT 100
      `).all(user.id, `%${escaped}%`, user.id, user.id);
      json(response, 200, { users: rows.map(publicUser) });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/friends') {
      json(response, 200, { friends: friendRows(user.id) });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/friend-requests') {
      const rows = db.prepare(`
        SELECT friend_requests.id,
               friend_requests.requester_id AS requesterId,
               friend_requests.recipient_id AS recipientId,
               friend_requests.created_at AS createdAt,
               requester.username AS requesterUsername,
               recipient.username AS recipientUsername
        FROM friend_requests
        JOIN users AS requester ON requester.id = friend_requests.requester_id
        JOIN users AS recipient ON recipient.id = friend_requests.recipient_id
        WHERE friend_requests.status = 'pending'
          AND (friend_requests.requester_id = ? OR friend_requests.recipient_id = ?)
        ORDER BY friend_requests.created_at DESC
      `).all(user.id, user.id);

      json(response, 200, {
        incoming: rows.filter((row) => row.recipientId === user.id),
        outgoing: rows.filter((row) => row.requesterId === user.id)
      });
      return;
    }

    if (method === 'POST' && segments.length === 4 && segments[1] === 'users' && segments[3] === 'friend-request') {
      const recipientId = Number(segments[2]);
      if (!Number.isSafeInteger(recipientId) || recipientId < 1 || recipientId === user.id) {
        sendError(response, 400, 'Choose a different user.');
        return;
      }
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(recipientId)) {
        sendError(response, 404, 'User not found.');
        return;
      }
      if (isBlocked(user.id, recipientId)) {
        sendError(response, 403, 'This friend request cannot be sent.');
        return;
      }
      if (areFriends(user.id, recipientId)) {
        sendError(response, 409, 'You are already friends.');
        return;
      }

      const reciprocal = db.prepare("SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'").get(recipientId, user.id);
      if (reciprocal) {
        sendError(response, 409, 'This user already sent you a request. Accept it in Friend Requests.');
        return;
      }

      const existing = db.prepare('SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ?').get(user.id, recipientId);
      if (existing) {
        db.prepare("UPDATE friend_requests SET status = 'pending', created_at = ? WHERE id = ?").run(Date.now(), existing.id);
        json(response, 200, { requestId: existing.id, status: 'pending' });
        return;
      }

      const result = db.prepare('INSERT INTO friend_requests (requester_id, recipient_id, created_at) VALUES (?, ?, ?)')
        .run(user.id, recipientId, Date.now());

      json(response, 201, { requestId: result.lastInsertRowid, status: 'pending' });
      return;
    }

    if (method === 'POST' && segments.length === 4 && segments[1] === 'friend-requests' && ['accept', 'decline'].includes(segments[3])) {
      const requestId = Number(segments[2]);
      const pending = db.prepare("SELECT * FROM friend_requests WHERE id = ? AND recipient_id = ? AND status = 'pending'").get(requestId, user.id);
      if (!pending) {
        sendError(response, 404, 'Friend request not found.');
        return;
      }

      if (segments[3] === 'decline') {
        db.prepare("UPDATE friend_requests SET status = 'declined' WHERE id = ?").run(requestId);
        json(response, 200, { status: 'declined' });
        return;
      }

      db.prepare('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)')
        .run(Math.min(user.id, pending.requester_id), Math.max(user.id, pending.requester_id), Date.now());
      db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE status = 'pending' AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))")
        .run(pending.requester_id, user.id, user.id, pending.requester_id);

      json(response, 200, { status: 'accepted', friends: friendRows(user.id) });
      return;
    }

    if (method === 'DELETE' && segments.length === 3 && segments[1] === 'friend-requests') {
      const requestId = Number(segments[2]);
      const result = db.prepare("DELETE FROM friend_requests WHERE id = ? AND requester_id = ? AND status = 'pending'")
        .run(requestId, user.id);

      if (result.changes === 0) {
        sendError(response, 404, 'Sent friend request not found.');
        return;
      }

      json(response, 200, { status: 'canceled' });
      return;
    }

    if (method === 'DELETE' && segments.length === 3 && segments[1] === 'friends') {
      const otherId = Number(segments[2]);
      if (!Number.isSafeInteger(otherId) || otherId < 1 || otherId === user.id) {
        sendError(response, 400, 'Choose a valid friend.');
        return;
      }

      db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(Math.min(user.id, otherId), Math.max(user.id, otherId));
      db.prepare('DELETE FROM friend_requests WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)')
        .run(user.id, otherId, otherId, user.id);

      json(response, 200, { friends: friendRows(user.id) });
      return;
    }

    if (segments.length === 3 && segments[1] === 'messages') {
      const otherId = Number(segments[2]);
      if (!Number.isSafeInteger(otherId) || otherId < 1 || otherId === user.id) {
        sendError(response, 400, 'Choose a valid conversation.');
        return;
      }

      if (isBlocked(user.id, otherId) || !areFriends(user.id, otherId)) {
        sendError(response, 403, 'Private messages are available between friends only.');
        return;
      }

      if (method === 'GET') {
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) {
          sendError(response, 400, 'Invalid message cursor.');
          return;
        }

        const messages = db.prepare(`
          SELECT messages.id,
                 messages.sender_id AS senderId,
                 sender.username AS senderUsername,
                 messages.recipient_id AS recipientId,
                 messages.body,
                 messages.created_at AS createdAt
          FROM messages
          JOIN users AS sender ON sender.id = messages.sender_id
          WHERE ((messages.sender_id = ? AND messages.recipient_id = ?) OR (messages.sender_id = ? AND messages.recipient_id = ?))
            AND messages.id > ?
          ORDER BY messages.id DESC
          LIMIT 100
        `).all(user.id, otherId, otherId, user.id, after).reverse();

        json(response, 200, { messages });
        return;
      }

      if (method === 'POST') {
        if (!allowRate(messageAttempts, String(user.id), 30, 60_000)) {
          sendError(response, 429, 'You are sending messages too quickly.');
          return;
        }

        void readJson(request)
          .then((body) => {
            const message = typeof body.message === 'string' ? body.message.trim() : '';
            if (!message || message.length > 1000) {
              sendError(response, 400, 'Messages must contain 1–1000 characters.');
              return;
            }

            const result = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?)')
              .run(user.id, otherId, message, Date.now());

            json(response, 201, {
              id: result.lastInsertRowid,
              senderId: user.id,
              senderUsername: user.username,
              recipientId: otherId,
              body: message,
              createdAt: Date.now()
            });
          })
          .catch((cause) => {
            if (!response.headersSent) {
              sendError(response, cause.status || 500, cause.status ? cause.message : 'Could not send message.');
            }
          });
        return;
      }
    }

    if (method === 'POST' && segments.length === 4 && segments[1] === 'users' && ['block', 'report'].includes(segments[3])) {
      const otherId = Number(segments[2]);
      if (!Number.isSafeInteger(otherId) || otherId < 1 || otherId === user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(otherId)) {
        sendError(response, 404, 'User not found.');
        return;
      }

      if (segments[3] === 'block') {
        db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
          .run(user.id, otherId, Date.now());
        db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(Math.min(user.id, otherId), Math.max(user.id, otherId));
        db.prepare('DELETE FROM friend_requests WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)')
          .run(user.id, otherId, otherId, user.id);
        json(response, 200, { ok: true });
        return;
      }

      void readJson(request)
        .then((body) => {
          const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
          if (reason.length < 5 || reason.length > 500) {
            sendError(response, 400, 'Tell us what happened (5–500 characters).');
            return;
          }

          db.prepare('INSERT INTO reports (reporter_id, reported_id, reason, created_at) VALUES (?, ?, ?, ?)')
            .run(user.id, otherId, reason, Date.now());
          json(response, 201, { ok: true });
        })
        .catch((cause) => {
          if (!response.headersSent) {
            sendError(response, cause.status || 500, cause.status ? cause.message : 'Could not submit report.');
          }
        });
      return;
    }

    sendError(response, 404, 'API endpoint not found.');
  }

  async function serveStatic(request, response, url) {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      response.end();
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendError(response, 405, 'Method not allowed.');
      return;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      sendError(response, 400, 'Invalid path.');
      return;
    }

    if (decodedPath.split('/').some((segment) => segment.startsWith('.') && segment !== '.well-known')) {
      sendError(response, 404, 'Not found.');
      return;
    }

    const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
    const rootPath = path.resolve(publicDir);
    let filePath = path.resolve(publicDir, relativePath);

    if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) {
      sendError(response, 403, 'Forbidden.');
      return;
    }

    try {
      let stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          response.writeHead(308, { Location: `${url.pathname}/${url.search}`, 'Cache-Control': 'no-store' });
          response.end();
          return;
        }
        filePath = path.join(filePath, 'index.html');
        stat = fs.statSync(filePath);
      }

      if (!stat.isFile()) throw new Error('Not a file.');

      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Length': stat.size,
        'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Frame-Options': 'DENY'
      });

      if (request.method === 'HEAD') {
        response.end();
        return;
      }

      fs.createReadStream(filePath).pipe(response);
    } catch {
      sendError(response, 404, 'Not found.');
    }
  }

  const server = http.createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
      sendError(response, 400, 'Invalid request URL.');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        dispatchApi(request, response, url);
      } catch (cause) {
        console.error('API request failed:', cause);
        if (!response.headersSent) sendError(response, 500, 'Something went wrong.');
      }
      return;
    }

    void serveStatic(request, response, url);
  });

  server.database = db;
  server.closeDatabase = () => db.close();
  return server;
}

if (require.main === module) {
  const server = createApp({
    dbPath: process.env.DB_PATH || path.join(__dirname, 'data', 'crafblox.sqlite')
  });

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`Crafblox listening on port ${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      server.closeDatabase();
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { createApp };
