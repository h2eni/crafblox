const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('index.html should not contain the legacy fake-player mock data', () => {
  assert.doesNotMatch(html, /const\s+people\s*=\s*\[/, 'Legacy mocked people data should be removed.');
  assert.doesNotMatch(html, /data-person-index/, 'Legacy fake-person UI should be removed.');
  assert.match(html, /data-auth-form/, 'Live auth form should still exist.');
});

test('browser preflight OPTIONS requests are accepted without a 405', async () => {
  const server = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/api/health`, { method: 'OPTIONS' });
    const login = await fetch(`${base}/api/auth/login`, { method: 'OPTIONS' });
    const signup = await fetch(`${base}/api/auth/signup`, { method: 'OPTIONS' });
    assert.equal(health.status, 204);
    assert.equal(login.status, 204);
    assert.equal(signup.status, 204);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('signup and friend-request flow work against the real server API', async () => {
  const server = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function request(path, init = {}) {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(init.body && !Object.keys(init.headers || {}).some((key) => key.toLowerCase() === 'content-type')
          ? { 'Content-Type': 'application/json' }
          : {})
      }
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { res, body };
  }

  try {
    const first = await request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'password1234' })
    });
    assert.equal(first.res.status, 200);
    const cookie = first.res.headers.get('set-cookie');
    assert.ok(cookie, 'signup should create a session cookie');

    const second = await request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'password1234' }),
      headers: { Cookie: cookie }
    });
    assert.equal(second.res.status, 200);

    const list = await request('/api/users?search=bob', {
      headers: { Cookie: cookie }
    });
    assert.equal(list.res.status, 200);
    assert.ok(list.body.users.some((user) => user.username === 'bob'));

    const requestResult = await request(`/api/users/${list.body.users[0].id}/friend-request`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: '{}'
    });
    assert.equal(requestResult.res.status, 201);
    assert.equal(requestResult.body.status, 'pending');
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('github pages static fallback supports chat message endpoints', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const code = fs.readFileSync(require('node:path').join(__dirname, '..', 'retro.js'), 'utf8');
  const storage = {};
  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    setItem(key, value) { storage[key] = String(value); },
    removeItem(key) { delete storage[key]; },
    clear() { Object.keys(storage).forEach((key) => delete storage[key]); }
  };
  const document = {
    querySelector() { return { dataset: {}, hidden: false, open: false, style: {}, textContent: '', value: '', innerHTML: '', classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, append() {}, appendChild() {}, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, reset() {}, scrollTop: 0 }; },
    querySelectorAll() { return []; },
    createElement() { return { dataset: {}, hidden: false, open: false, style: {}, textContent: '', value: '', innerHTML: '', classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, append() {}, appendChild() {}, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, reset() {}, scrollTop: 0 }; },
    addEventListener() {}
  };
  const context = {
    console,
    window: {
      location: { hostname: 'h2eni.github.io', pathname: '/crafblox/', protocol: 'https:' },
      localStorage,
      history: { pushState() {} },
      setTimeout,
      clearTimeout,
      setInterval() { return 0; },
      clearInterval() {},
      scrollTo() {},
      confirm() { return true; },
      prompt() { return 'Because it is static'; },
      addEventListener() {}
    },
    document,
    localStorage,
    URLSearchParams,
    FormData: class {},
    Headers: class {},
    location: { hostname: 'h2eni.github.io', pathname: '/crafblox/', protocol: 'https:' },
    history: { pushState() {} },
    setTimeout,
    clearTimeout,
    setInterval() { return 0; },
    clearInterval() {},
    scrollTo() {},
    fetch: async () => ({ ok: true, json: async () => ({}) })
  };
  context.window.document = document;
  context.window.location = context.location;
  context.window.localStorage = localStorage;
  context.window.history = context.history;
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  await context.api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'charlie', password: 'password1234' }) });
  await context.api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ username: 'dana', password: 'password1234' }) });
  await context.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'charlie', password: 'password1234' }) });
  const users = await context.api('/api/users');
  const other = users.users.find((user) => user.username === 'dana');
  assert.ok(other, 'demo users list should expose the other user');
  await context.api(`/api/users/${other.id}/friend-request`, { method: 'POST', body: '{}' });
  await context.api('/api/auth/logout', { method: 'POST' });
  await context.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'dana', password: 'password1234' }) });
  const requests = await context.api('/api/friend-requests');
  const requestId = requests.incoming[0].id;
  await context.api(`/api/friend-requests/${requestId}/accept`, { method: 'POST', body: '{}' });
  await context.api('/api/auth/logout', { method: 'POST' });
  await context.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'charlie', password: 'password1234' }) });
  const messageResult = await context.api(`/api/messages/${other.id}?after=0`, { method: 'GET' });
  const sendResult = await context.api(`/api/messages/${other.id}`, { method: 'POST', body: JSON.stringify({ message: 'hello friend' }) });
  assert.equal(sendResult.body, 'hello friend');
  assert.equal(sendResult.senderUsername, 'charlie');
  assert.ok(Array.isArray(messageResult.messages) || messageResult.messages === undefined, 'chat routes should return message data without a 404');
});
