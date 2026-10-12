let currentUser = null;
let friends = [];
let incomingRequests = [];
let outgoingRequests = [];
let currentCommunityView = 'discover';
let authMode = 'signup';
let activeConversation = null;
let lastMessageId = 0;
let messagePoll;
let userSearchTimer;

let currentRoute = 'home';
let gameSearch = '';
let userSearch = '';
const basePath = location.pathname.replace(/(?:home|games|users)\/?$/, '') || '/';
const retroGames = [
  { name: 'Baseplate', genre: 'Building', alt: 'Baseplate building scene' },
  { name: 'Drift Rush', genre: 'Racing', alt: 'Racing challenge' },
  { name: 'Pixel Quest', genre: 'Adventure', alt: 'Adventure map' },
  { name: 'Sky Arena', genre: 'Action', alt: 'Action arena' }
];
const isGitHubPages = typeof window !== 'undefined' && (window.location.hostname.endsWith('.github.io') || window.location.protocol === 'file:');
const apiBase = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? '' : (window.location.hostname.endsWith('.github.io') ? 'http://localhost:3000' : '');

function getDemoState() {
  try {
    return JSON.parse(window.localStorage.getItem('crafblox_demo_state') || '{"users":[],"friendRequests":[],"friendships":[],"blocks":[],"messages":[]}');
  } catch {
    return { users: [], friendRequests: [], friendships: [], blocks: [], messages: [] };
  }
}

function setDemoState(state) {
  window.localStorage.setItem('crafblox_demo_state', JSON.stringify(state));
}

function getCurrentDemoUser() {
  try {
    const cached = JSON.parse(window.localStorage.getItem('crafblox_user') || 'null');
    return cached && cached.username ? cached : null;
  } catch {
    return null;
  }
}

function findDemoUser(username) {
  const state = getDemoState();
  return state.users.find((user) => user.username.toLowerCase() === String(username).toLowerCase());
}

function demoPublicUser(user) {
  return { id: user.id, username: user.username, online: true, createdAt: user.createdAt };
}

function demoApi(endpoint, options = {}) {
  const state = getDemoState();
  const method = (options.method || 'GET').toUpperCase();
  const currentUser = getCurrentDemoUser();
  const path = String(endpoint || '/');
  const userMatch = path.match(/^\/api\/users\/([0-9]+)(?:\/|$)/);
  const requestMatch = path.match(/^\/api\/friend-requests\/([0-9]+)(?:\/|$)/);

  if (path === '/api/me') {
    return Promise.resolve({ user: currentUser ? { id: currentUser.id, username: currentUser.username, createdAt: currentUser.createdAt || Date.now() } : null });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    window.localStorage.removeItem('crafblox_user');
    return Promise.resolve({ ok: true });
  }

  if (path === '/api/auth/signup' && method === 'POST') {
    return Promise.resolve().then(() => {
      const body = options.body ? JSON.parse(options.body) : {};
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error('Usernames must be 3–20 characters: letters, numbers, or underscores.');
      if (password.length < 10 || password.length > 128) throw new Error('Passwords must be 10–128 characters.');
      if (findDemoUser(username)) throw new Error('That username is already taken.');
      const user = { id: Date.now(), username, password, createdAt: Date.now() };
      state.users.push(user);
      setDemoState(state);
      const safeUser = { id: user.id, username: user.username, createdAt: user.createdAt };
      window.localStorage.setItem('crafblox_user', JSON.stringify(safeUser));
      return { user: safeUser };
    });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    return Promise.resolve().then(() => {
      const body = options.body ? JSON.parse(options.body) : {};
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = findDemoUser(username);
      if (!user || user.password !== password) throw new Error('Username or password is incorrect.');
      const safeUser = { id: user.id, username: user.username, createdAt: user.createdAt };
      window.localStorage.setItem('crafblox_user', JSON.stringify(safeUser));
      return { user: safeUser };
    });
  }

  if (!currentUser) {
    return Promise.reject(new Error('Sign in to use your account.'));
  }

  if (path === '/api/users') {
    const params = new URLSearchParams(endpoint.split('?')[1] || '');
    const search = (params.get('search') || '').trim().toLowerCase();
    const users = state.users.filter((user) => user.id !== currentUser.id && (!search || user.username.toLowerCase().includes(search))).map(demoPublicUser);
    return Promise.resolve({ users });
  }

  if (path === '/api/friends') {
    const currentId = currentUser.id;
    const friends = state.friendships.filter((pair) => pair.user_a === currentId || pair.user_b === currentId).map((pair) => {
      const friendId = pair.user_a === currentId ? pair.user_b : pair.user_a;
      const friend = state.users.find((user) => user.id === friendId);
      return friend ? demoPublicUser(friend) : null;
    }).filter(Boolean);
    return Promise.resolve({ friends });
  }

  if (path === '/api/friend-requests') {
    const currentId = currentUser.id;
    return Promise.resolve({
      incoming: state.friendRequests.filter((request) => request.recipientId === currentId && request.status === 'pending').map((request) => ({
        id: request.id,
        requesterId: request.requesterId,
        recipientId: currentId,
        requesterUsername: state.users.find((user) => user.id === request.requesterId)?.username || 'Unknown',
        recipientUsername: currentUser.username
      })),
      outgoing: state.friendRequests.filter((request) => request.requesterId === currentId && request.status === 'pending').map((request) => ({
        id: request.id,
        requesterId: currentId,
        recipientId: request.recipientId,
        requesterUsername: currentUser.username,
        recipientUsername: state.users.find((user) => user.id === request.recipientId)?.username || 'Unknown'
      }))
    });
  }

  if (userMatch && method === 'POST' && path.includes('/friend-request')) {
    const recipientId = Number(userMatch[1]);
    if (!Number.isFinite(recipientId) || recipientId === currentUser.id) throw new Error('Choose a different user.');
    const exists = state.friendships.some((pair) => (pair.user_a === currentUser.id && pair.user_b === recipientId) || (pair.user_a === recipientId && pair.user_b === currentUser.id));
    if (exists) throw new Error('You are already friends.');
    const pending = state.friendRequests.find((request) => request.requesterId === currentUser.id && request.recipientId === recipientId && request.status === 'pending');
    if (pending) return Promise.resolve({ status: 'pending', requestId: pending.id });
    const request = { id: Date.now(), requesterId: currentUser.id, recipientId, status: 'pending', createdAt: Date.now() };
    state.friendRequests.push(request);
    setDemoState(state);
    return Promise.resolve({ status: 'pending', requestId: request.id });
  }

  if (requestMatch && method === 'POST' && path.includes('/accept')) {
    const requestId = Number(requestMatch[1]);
    const request = state.friendRequests.find((item) => item.id === requestId && item.recipientId === currentUser.id && item.status === 'pending');
    if (!request) throw new Error('Friend request not found.');
    request.status = 'accepted';
    const pair = { user_a: Math.min(request.requesterId, currentUser.id), user_b: Math.max(request.requesterId, currentUser.id), createdAt: Date.now() };
    state.friendships = state.friendships.filter((item) => !(item.user_a === pair.user_a && item.user_b === pair.user_b)).concat(pair);
    setDemoState(state);
    return Promise.resolve({ status: 'accepted', friends: state.friendships.filter((item) => item.user_a === currentUser.id || item.user_b === currentUser.id).map((item) => {
      const friendId = item.user_a === currentUser.id ? item.user_b : item.user_a;
      return demoPublicUser(state.users.find((user) => user.id === friendId));
    }) });
  }

  if (requestMatch && method === 'POST' && path.includes('/decline')) {
    const requestId = Number(requestMatch[1]);
    const request = state.friendRequests.find((item) => item.id === requestId && item.recipientId === currentUser.id && item.status === 'pending');
    if (!request) throw new Error('Friend request not found.');
    request.status = 'declined';
    setDemoState(state);
    return Promise.resolve({ status: 'declined' });
  }

  if (requestMatch && method === 'DELETE') {
    const requestId = Number(requestMatch[1]);
    const index = state.friendRequests.findIndex((item) => item.id === requestId && item.requesterId === currentUser.id && item.status === 'pending');
    if (index === -1) throw new Error('Sent friend request not found.');
    state.friendRequests.splice(index, 1);
    setDemoState(state);
    return Promise.resolve({ status: 'canceled' });
  }

  if (userMatch && method === 'DELETE' && path.includes('/friends/')) {
    const otherId = Number(userMatch[1]);
    state.friendships = state.friendships.filter((pair) => !((pair.user_a === currentUser.id && pair.user_b === otherId) || (pair.user_a === otherId && pair.user_b === currentUser.id)));
    state.friendRequests = state.friendRequests.filter((request) => !(request.requesterId === currentUser.id && request.recipientId === otherId || request.requesterId === otherId && request.recipientId === currentUser.id));
    setDemoState(state);
    return Promise.resolve({ friends: [] });
  }

  if (userMatch && method === 'POST' && path.includes('/block')) {
    const otherId = Number(userMatch[1]);
    state.blocks = state.blocks.filter((entry) => !(entry.blockerId === currentUser.id && entry.blockedId === otherId));
    state.blocks.push({ blockerId: currentUser.id, blockedId: otherId, createdAt: Date.now() });
    state.friendships = state.friendships.filter((pair) => !(pair.user_a === currentUser.id && pair.user_b === otherId) && !(pair.user_a === otherId && pair.user_b === currentUser.id));
    state.friendRequests = state.friendRequests.filter((request) => !(request.requesterId === currentUser.id && request.recipientId === otherId) && !(request.requesterId === otherId && request.recipientId === currentUser.id));
    setDemoState(state);
    return Promise.resolve({ ok: true });
  }

  if (userMatch && method === 'POST' && path.includes('/report')) {
    return Promise.resolve({ ok: true });
  }

  if (userMatch && path.includes('/messages') && method === 'GET') {
    const otherId = Number(userMatch[1]);
    const messages = (state.messages || []).filter((message) => (message.senderId === currentUser.id && message.recipientId === otherId) || (message.senderId === otherId && message.recipientId === currentUser.id)).sort((a, b) => a.id - b.id);
    return Promise.resolve({ messages });
  }

  if (userMatch && path.includes('/messages') && method === 'POST') {
    const otherId = Number(userMatch[1]);
    const body = options.body ? JSON.parse(options.body) : {};
    const messageText = String(body.message || '').trim();
    if (!messageText) throw new Error('Messages must contain 1–1000 characters.');
    const message = { id: Date.now(), senderId: currentUser.id, recipientId: otherId, body: messageText, createdAt: Date.now() };
    state.messages.push(message);
    setDemoState(state);
    return Promise.resolve({ id: message.id, senderId: currentUser.id, senderUsername: currentUser.username, recipientId: otherId, body: messageText, createdAt: message.createdAt });
  }

  return Promise.reject(new Error('API endpoint not found.'));
}

function resolveApiUrl(endpoint) {
  if (!endpoint || /^https?:\/\//.test(endpoint)) return endpoint;
  return `${apiBase}${endpoint}`;
}

function avatarMarkup(color = '#4684bf') {
  return `<span class="classic-avatar" aria-hidden="true"><i class="head"></i><i class="torso" style="background:${color};border-color:${color}"></i><i class="leg left"></i><i class="leg right"></i></span>`;
}

function gameMarkup(game) {
  return `<article class="classic-game"><a class="classic-game-image classic-baseplate" href="${basePath}games/" data-retro-play="${game.name}" role="img" aria-label="${game.alt}"></a><a class="classic-game-name" href="${basePath}games/" data-retro-play="${game.name}">${game.name}</a><div class="classic-game-meta"><span>${game.genre}</span><span class="classic-online">Click to play</span></div></article>`;
}

function userMarkup(user, index) {
  const friend = friends.some((item) => item.id === user.id);
  const outgoing = outgoingRequests.some((item) => item.recipientId === user.id);
  const incoming = incomingRequests.find((item) => item.requesterId === user.id);
  let actions;
  if (friend) {
    actions = `<button type="button" class="classic-button" data-chat-user="${user.id}" data-chat-name="${user.username}">Message</button><button type="button" class="classic-button secondary" data-friend-remove="${user.id}">Remove Friend</button>`;
  } else if (incoming) {
    actions = `<button type="button" class="classic-button" data-request-action="accept" data-request-id="${incoming.id}">Accept Request</button>`;
  } else if (outgoing) {
    actions = '<button type="button" class="classic-button secondary" disabled>Request Sent</button>';
  } else {
    actions = `<button type="button" class="classic-button" data-friend-request="${user.id}">Add Friend</button>`;
  }
  return `<article class="classic-user">${avatarMarkup('#4684bf')}<a class="classic-user-name" href="#user-${user.id}">${user.username}</a><div class="classic-user-status ${user.online ? 'online' : ''}">${user.online ? 'Online' : 'Offline'}</div><div class="classic-user-actions">${actions}</div><details class="classic-user-safety"><summary>More</summary><button type="button" data-user-action="block" data-user-id="${user.id}" data-user-name="${user.username}">Block</button><button type="button" data-user-action="report" data-user-id="${user.id}" data-user-name="${user.username}">Report</button></details></article>`;
}

async function api(endpoint, options = {}) {
  if (isGitHubPages || window.location.hostname === '127.0.0.1' && !window.location.port) {
    return demoApi(endpoint, options);
  }
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const url = resolveApiUrl(endpoint);
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: apiBase ? 'include' : 'same-origin'
  });
  let data = {};
  try { data = await response.json(); } catch { /* Empty responses are allowed. */ }
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function filteredGames() {
  const search = gameSearch.trim().toLowerCase();
  return retroGames.filter((game) => !search || `${game.name} ${game.genre}`.toLowerCase().includes(search));
}

function renderGameGrid(container, list) {
  container.innerHTML = list.length ? list.map(gameMarkup).join('') : '<div class="classic-empty">No games found. Try another search.</div>';
}

function syncNav() {
  document.querySelectorAll('[data-retro-route]').forEach((link) => {
    const active = link.dataset.retroRoute === currentRoute;
    link.classList.toggle('is-current', active);
    if (link.matches('.classic-side-nav a')) link.classList.toggle('is-current', active);
    link.href = `${basePath}${link.dataset.retroRoute}/`;
  });
  document.querySelector('[data-classic-breadcrumb]').textContent = { home: 'Home', games: 'Games', users: 'Users' }[currentRoute];
  document.title = `${currentRoute === 'users' ? 'Users' : currentRoute[0].toUpperCase() + currentRoute.slice(1)} - Crafblox`;
}

function showRoute(name, updateHistory = false) {
  currentRoute = ['home', 'games', 'users'].includes(name) ? name : 'home';
  document.querySelectorAll('[data-retro-page]').forEach((page) => { page.hidden = page.dataset.retroPage !== currentRoute; });
  syncNav();
  if (updateHistory) history.pushState(null, '', `${basePath}${currentRoute}/`);
  if (currentRoute === 'users' && currentUser) void refreshCommunity();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function renderHome() {
  renderGameGrid(document.querySelector('[data-home-games]'), retroGames);
  void renderFriendSidebar();
}

function renderGamesPage() {
  const results = filteredGames();
  renderGameGrid(document.querySelector('[data-games-grid]'), results);
  document.querySelector('[data-game-results]').textContent = `${results.length} ${results.length === 1 ? 'game' : 'games'}`;
}

async function renderUsersPage() {
  const query = userSearch.trim().toLowerCase();
  if (!currentUser) {
    document.querySelector('[data-users-grid]').innerHTML = '<div class="classic-empty">Sign in to find people and send friend requests.</div>';
    document.querySelector('[data-user-results]').textContent = '';
    return;
  }
  try {
    const result = await api(`/api/users?search=${encodeURIComponent(query)}`);
    document.querySelector('[data-users-grid]').innerHTML = result.users.length
      ? result.users.map(userMarkup).join('')
      : '<div class="classic-empty">No users found. Check the spelling and try again.</div>';
    document.querySelector('[data-user-results]').textContent = `${result.users.length} users`;
  } catch (cause) {
    document.querySelector('[data-users-grid]').innerHTML = '<div class="classic-empty">The user list could not be refreshed.</div>';
    document.querySelector('[data-user-results]').textContent = '0 users';
    setFeedback(cause.message, true);
  }
}

function setFeedback(message, isError = false) {
  const feedback = document.querySelector('[data-social-feedback]');
  feedback.textContent = message;
  feedback.classList.toggle('is-error', isError);
  feedback.hidden = !message;
  if (message) window.setTimeout(() => { feedback.hidden = true; }, 5000);
}

function escapeText(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function setCommunityView(view) {
  currentCommunityView = view;
  document.querySelectorAll('[data-community-view]').forEach((button) => {
    const selected = button.dataset.communityView === view;
    button.classList.toggle('is-current', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('[data-community-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.communityPanel !== view;
  });
  if (currentUser) void refreshCommunity();
}

async function renderFriendSidebar() {
  const sidebar = document.querySelector('[data-friend-list]');
  if (!currentUser) {
    sidebar.innerHTML = '<span class="classic-muted-link">Sign in to see friends.</span>';
    return;
  }
  try {
    const result = await api('/api/friends');
    sidebar.innerHTML = result.friends.length
      ? result.friends.filter((friend) => friend.online).slice(0, 6).map((friend) => `<div class="classic-friend">${avatarMarkup('#4684bf')}<a href="${basePath}users/" data-open-chat="${friend.id}" data-chat-name="${escapeText(friend.username)}">${escapeText(friend.username)}</a><span>Online</span></div>`).join('') || '<span class="classic-muted-link">No friends online.</span>'
      : '<span class="classic-muted-link">No friends yet.</span>';
  } catch {
    sidebar.innerHTML = '<span class="classic-muted-link">Could not load friends.</span>';
  }
}

function renderFriendCards() {
  const container = document.querySelector('[data-friends-grid]');
  container.innerHTML = friends.length ? friends.map((friend) => `<article class="classic-user">${avatarMarkup('#4684bf')}<strong class="classic-user-name">${escapeText(friend.username)}</strong><div class="classic-user-status ${friend.online ? 'online' : ''}">${friend.online ? 'Online' : 'Offline'}</div><div class="classic-user-actions"><button type="button" class="classic-button" data-chat-user="${friend.id}" data-chat-name="${escapeText(friend.username)}">Message</button><button type="button" class="classic-button secondary" data-friend-remove="${friend.id}">Remove Friend</button></div></article>`).join('') : '<div class="classic-empty">You have no friends yet. Find someone to build with!</div>';
  document.querySelector('[data-friends-count]').textContent = String(friends.length);
}

function renderRequests() {
  const incoming = document.querySelector('[data-incoming-requests]');
  const outgoing = document.querySelector('[data-outgoing-requests]');
  incoming.innerHTML = incomingRequests.length ? incomingRequests.map((request) => `<article class="classic-user"><strong class="classic-user-name">${escapeText(request.requesterUsername)}</strong><div class="classic-user-status">Wants to be your friend</div><div class="classic-user-actions"><button type="button" class="classic-button" data-request-action="accept" data-request-id="${request.id}">Accept</button><button type="button" class="classic-button secondary" data-request-action="decline" data-request-id="${request.id}">Decline</button></div></article>`).join('') : '<div class="classic-empty">No incoming requests.</div>';
  outgoing.innerHTML = outgoingRequests.length ? outgoingRequests.map((request) => `<article class="classic-user"><strong class="classic-user-name">${escapeText(request.recipientUsername)}</strong><div class="classic-user-status">Friend request sent</div><div class="classic-user-actions"><button type="button" class="classic-button secondary" data-request-cancel="${request.id}">Cancel Request</button></div></article>`).join('') : '<div class="classic-empty">No sent requests.</div>';
  document.querySelector('[data-requests-count]').textContent = String(incomingRequests.length);
}

async function refreshCommunity() {
  if (!currentUser) return;
  friends = [];
  incomingRequests = [];
  outgoingRequests = [];
  renderFriendCards();
  renderRequests();
  renderFriendSidebar().catch(() => {});
  try {
    const [friendResult, requestResult] = await Promise.all([api('/api/friends'), api('/api/friend-requests')]);
    friends = friendResult.friends;
    incomingRequests = requestResult.incoming;
    outgoingRequests = requestResult.outgoing;
    renderFriendCards();
    renderRequests();
    await Promise.all([renderUsersPage(), renderFriendSidebar()]);
  } catch (cause) {
    renderFriendCards();
    renderRequests();
    setFeedback(cause.message, true);
  }
}

function persistUser(user) {
  if (!user) {
    window.localStorage.removeItem('crafblox_user');
    return;
  }
  window.localStorage.setItem('crafblox_user', JSON.stringify(user));
}

function updateAccount(user) {
  currentUser = user;
  persistUser(user);
  document.querySelector('[data-signed-out]').hidden = Boolean(user);
  document.querySelector('[data-signed-in]').hidden = !user;
  document.querySelector('[data-current-username]').textContent = user?.username || '';
  document.querySelector('[data-sidebar-username]').textContent = user?.username || 'Guest';
  document.querySelector('[data-sidebar-welcome]').textContent = user ? 'Welcome back!' : 'Sign in to save your account.';
  if (user) void refreshCommunity();
  else {
    friends = [];
    incomingRequests = [];
    outgoingRequests = [];
    void renderFriendSidebar();
    void renderUsersPage();
    renderFriendCards();
    renderRequests();
  }
}

function openAuth(mode = 'signup') {
  authMode = mode;
  const dialog = document.querySelector('[data-auth-dialog]');
  const isSignup = mode === 'signup';
  const confirmInput = document.querySelector('[data-auth-confirm-password] input');
  document.querySelector('#auth-dialog-title').textContent = isSignup ? 'Create your account' : 'Log in to Crafblox';
  document.querySelector('[data-auth-submit]').textContent = isSignup ? 'Create Account' : 'Log In';
  document.querySelector('[data-auth-confirm-password]').hidden = !isSignup;
  confirmInput.required = isSignup;
  confirmInput.value = '';
  document.querySelector('[data-auth-switch-prompt]').textContent = isSignup ? 'Already registered?' : 'New to Crafblox?';
  document.querySelector('[data-auth-switch]').textContent = isSignup ? 'Log In' : 'Sign Up';
  document.querySelector('[data-auth-error]').hidden = true;
  if (!dialog.open) dialog.showModal();
}

function appendMessages(messages) {
  const list = document.querySelector('[data-message-list]');
  if (!messages.length && lastMessageId === 0) {
    list.innerHTML = '<p class="classic-message-empty">No messages yet. Say hello!</p>';
    return;
  }
  const empty = list.querySelector('.classic-message-empty');
  if (empty) empty.remove();
  messages.forEach((message) => {
    if (message.id <= lastMessageId) return;
    lastMessageId = message.id;
    const item = document.createElement('article');
    item.className = `classic-message${message.senderId === currentUser.id ? ' is-mine' : ''}`;
    const heading = document.createElement('strong');
    heading.textContent = message.senderUsername;
    const text = document.createElement('p');
    text.textContent = message.body;
    item.append(heading, text);
    list.append(item);
  });
  list.scrollTop = list.scrollHeight;
}

async function loadConversation() {
  if (!activeConversation || !document.querySelector('[data-chat-dialog]').open) return;
  try {
    const result = await api(`/api/messages/${activeConversation.id}?after=${lastMessageId}`);
    appendMessages(result.messages);
  } catch (cause) {
    document.querySelector('[data-chat-error]').textContent = cause.message;
    document.querySelector('[data-chat-error]').hidden = false;
    window.clearInterval(messagePoll);
  }
}

async function openConversation(id, username) {
  activeConversation = { id: Number(id), username };
  lastMessageId = 0;
  const list = document.querySelector('[data-message-list]');
  list.innerHTML = '';
  document.querySelector('#chat-title').textContent = `Chat with ${username}`;
  document.querySelector('[data-chat-error]').hidden = true;
  document.querySelector('[data-chat-dialog]').showModal();
  await loadConversation();
  window.clearInterval(messagePoll);
  messagePoll = window.setInterval(loadConversation, 2500);
  document.querySelector('[data-message-form] input').focus();
}

async function initialize() {
  renderHome();
  renderGamesPage();
  showRoute(location.pathname.match(/\/(home|games|users)\/?$/)?.[1] || 'home');
  try {
    const result = await api('/api/me');
    updateAccount(result.user);
  } catch {
    try {
      const cached = JSON.parse(window.localStorage.getItem('crafblox_user') || 'null');
      if (cached && cached.username) {
        updateAccount(cached);
        return;
      }
    } catch {
      // Ignore invalid cached user state and fall back to signed-out.
    }
    updateAccount(null);
  }
}

void initialize();

document.addEventListener('click', async (event) => {
  const openChat = event.target.closest('[data-open-chat]');
  const messageFriend = event.target.closest('[data-chat-user]');
  if (openChat || messageFriend) {
    event.preventDefault();
    const control = openChat || messageFriend;
    await openConversation(control.dataset.openChat || control.dataset.chatUser, control.dataset.chatName);
    return;
  }

  const authButton = event.target.closest('[data-auth-open]');
  if (authButton) {
    openAuth(authButton.dataset.authOpen);
    return;
  }
  if (event.target.closest('[data-auth-close]')) {
    document.querySelector('[data-auth-dialog]').close();
    return;
  }
  if (event.target.closest('[data-auth-switch]')) {
    openAuth(authMode === 'signup' ? 'login' : 'signup');
    return;
  }
  if (event.target.closest('[data-logout]')) {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      updateAccount(null);
      setFeedback('You are signed out.');
    } catch (cause) {
      updateAccount(null);
      setFeedback(cause.message, true);
    }
    return;
  }

  const routeLink = event.target.closest('[data-retro-route]');
  if (routeLink) {
    event.preventDefault();
    showRoute(routeLink.dataset.retroRoute, true);
    return;
  }
  const communityTab = event.target.closest('[data-community-view]');
  if (communityTab) {
    setCommunityView(communityTab.dataset.communityView);
    return;
  }
  if (event.target.closest('[data-retro-play]')) {
    event.preventDefault();
    showRoute('games', true);
    setFeedback('Baseplate is ready to build in. Game launch requires a Roblox game integration.');
    return;
  }

  const requestButton = event.target.closest('[data-friend-request]');
  if (requestButton) {
    requestButton.disabled = true;
    try {
      await api(`/api/users/${requestButton.dataset.friendRequest}/friend-request`, { method: 'POST', body: '{}' });
      setFeedback('Friend request sent.');
      await refreshCommunity();
    } catch (cause) {
      requestButton.disabled = false;
      setFeedback(cause.message, true);
    }
    return;
  }
  const requestAction = event.target.closest('[data-request-action]');
  if (requestAction) {
    try {
      await api(`/api/friend-requests/${requestAction.dataset.requestId}/${requestAction.dataset.requestAction}`, { method: 'POST', body: '{}' });
      setFeedback(requestAction.dataset.requestAction === 'accept' ? 'Friend request accepted.' : 'Friend request declined.');
      await refreshCommunity();
    } catch (cause) {
      setFeedback(cause.message, true);
    }
    return;
  }
  const cancelRequest = event.target.closest('[data-request-cancel]');
  if (cancelRequest) {
    try {
      await api(`/api/friend-requests/${cancelRequest.dataset.requestCancel}`, { method: 'DELETE' });
      setFeedback('Friend request canceled.');
      await refreshCommunity();
    } catch (cause) {
      setFeedback(cause.message, true);
    }
    return;
  }
  const removeFriend = event.target.closest('[data-friend-remove]');
  if (removeFriend) {
    try {
      await api(`/api/friends/${removeFriend.dataset.friendRemove}`, { method: 'DELETE' });
      setFeedback('Friend removed.');
      await refreshCommunity();
    } catch (cause) {
      setFeedback(cause.message, true);
    }
    return;
  }
  const safetyButton = event.target.closest('[data-user-action]');
  if (safetyButton) {
    const { userId, userName, userAction } = safetyButton.dataset;
    if (userAction === 'block') {
      if (!window.confirm(`Block ${userName}? They will no longer be able to find or message you.`)) return;
      try {
        await api(`/api/users/${userId}/block`, { method: 'POST', body: '{}' });
        setFeedback(`${userName} has been blocked.`);
        await refreshCommunity();
      } catch (cause) {
        setFeedback(cause.message, true);
      }
      return;
    }
    const reason = window.prompt(`Why are you reporting ${userName}?`);
    if (reason === null) return;
    try {
      await api(`/api/users/${userId}/report`, { method: 'POST', body: JSON.stringify({ reason }) });
      setFeedback('Report sent to the Crafblox moderation team.');
    } catch (cause) {
      setFeedback(cause.message, true);
    }
  }
});

document.querySelector('[data-auth-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const username = data.get('username').trim();
  const password = data.get('password');
  const error = document.querySelector('[data-auth-error]');
  if (authMode === 'signup' && password !== data.get('confirmPassword')) {
    error.textContent = 'The passwords do not match.';
    error.hidden = false;
    return;
  }
  const submit = document.querySelector('[data-auth-submit]');
  submit.disabled = true;
  error.hidden = true;
  try {
    const result = await api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify({ username, password }) });
    updateAccount(result.user);
    form.reset();
    document.querySelector('[data-auth-dialog]').close();
    setFeedback(authMode === 'signup' ? 'Your Crafblox account is ready.' : 'Welcome back.');
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('[data-auth-dialog]').addEventListener('close', () => document.querySelector('[data-auth-form]').reset());
document.querySelector('[data-users-search]').addEventListener('input', (event) => {
  userSearch = event.target.value;
  clearTimeout(userSearchTimer);
  userSearchTimer = window.setTimeout(() => { void renderUsersPage(); }, 180);
});
document.querySelector('[data-users-search-form]').addEventListener('submit', (event) => { event.preventDefault(); userSearch = document.querySelector('[data-users-search]').value; void renderUsersPage(); });
document.querySelector('[data-classic-search]').addEventListener('submit', (event) => {
  event.preventDefault();
  gameSearch = document.querySelector('[data-classic-search-input]').value;
  showRoute('games', true);
  renderGamesPage();
});
document.querySelector('[data-classic-search-input]').addEventListener('input', (event) => { gameSearch = event.target.value; });
document.querySelector('[data-message-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeConversation) return;
  const input = event.currentTarget.elements.message;
  const message = input.value.trim();
  if (!message) return;
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    await api(`/api/messages/${activeConversation.id}`, { method: 'POST', body: JSON.stringify({ message }) });
    input.value = '';
    document.querySelector('[data-chat-error]').hidden = true;
    await loadConversation();
    input.focus();
  } catch (cause) {
    const error = document.querySelector('[data-chat-error]');
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
document.querySelector('[data-chat-close]').addEventListener('click', () => document.querySelector('[data-chat-dialog]').close());
document.querySelector('[data-chat-dialog]').addEventListener('close', () => {
  window.clearInterval(messagePoll);
  activeConversation = null;
});
window.setInterval(() => { if (currentUser) void refreshCommunity(); }, 30_000);
window.addEventListener('popstate', () => showRoute(location.pathname.match(/\/(home|games|users)\/?$/)?.[1] || 'home'));