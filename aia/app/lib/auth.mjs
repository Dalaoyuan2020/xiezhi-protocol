import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { field, fail, hashBytes, id } from './store.mjs';
import { normalizeOrcid } from './scholars.mjs';

const scrypt = promisify(scryptCallback);
const SESSION_AGE = 7 * 24 * 60 * 60;
const COOKIE = 'aia_session';
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function passwordHash(password, salt = randomBytes(24).toString('hex')) {
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt-v1$${salt}$${key.toString('hex')}`;
}
function username(value) {
  const name = field(value, '用户名', 3, 40).toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(name)) fail(400, '用户名只支持英文字母、数字、下划线、点和短横线。');
  return name;
}
function passwordInput(value, minimum) {
  if (typeof value !== 'string' || value.includes('\0') || Array.from(value).length < minimum || Array.from(value).length > 256) fail(400, `密码须为 ${minimum} 至 256 字。`);
  return value;
}
export function createAuth(store, { secureCookies = false } = {}) {
  function userById(userId) { const row = store.one('SELECT data FROM users WHERE id=?', userId); return row ? JSON.parse(row.data) : null; }
  function cookie(res, token, age = SESSION_AGE) {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookies ? '; Secure' : ''}`);
  }
  function session(req) {
    const token = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenHash = hashBytes(token);
    const row = store.one('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', tokenHash, new Date().toISOString());
    if (!row) return null;
    const user = userById(row.user_id);
    return user ? { user, csrfToken: row.csrf, tokenHash } : null;
  }
  function requireSession(req) { return session(req) || fail(401, '请先登录自己的账号。'); }
  function csrf(req, current) { if (!safeEqual(req.headers['x-csrf-token'], current.csrfToken)) fail(403, '会话校验失败，请刷新页面后重试。'); }
  function establish(req, res, user) {
    const current = session(req);
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    store.transaction(() => {
      if (current) store.run('DELETE FROM sessions WHERE token_hash=?', current.tokenHash);
      store.run('DELETE FROM sessions WHERE expires_at<=?', new Date().toISOString());
      store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)', hashBytes(token), user.id, csrfToken, new Date(Date.now() + SESSION_AGE * 1000).toISOString());
    });
    cookie(res, token);
    return { user, csrfToken };
  }
  async function register(req, res, payload) {
    const name = username(payload.username);
    const displayName = field(payload.displayName, '显示姓名', 1, 80);
    const password = passwordInput(payload.password, 10);
    if (store.one('SELECT id FROM users WHERE username=?', name)) fail(409, '该用户名已被使用。');
    const encoded = await passwordHash(password);
    const user = { id: id('user'), username: name, displayName, createdAt: new Date().toISOString(), profile: { institution: '', bio: '', orcid: '', openalexId: '', identityStatus: 'user-declared', walletAddress: null, walletVerified: false } };
    try { store.run('INSERT INTO users(id,username,password_hash,data) VALUES(?,?,?,?)', user.id, name, encoded, JSON.stringify(user)); }
    catch (error) { if (String(error.message).includes('UNIQUE')) fail(409, '该用户名已被使用。'); throw error; }
    return establish(req, res, user);
  }
  async function login(req, res, payload) {
    const name = username(payload.username);
    const password = passwordInput(payload.password, 1);
    const row = store.one('SELECT password_hash,data FROM users WHERE username=?', name);
    const encoded = row?.password_hash || 'scrypt-v1$000000000000000000000000000000000000000000000000$00';
    const derived = await passwordHash(password, encoded.split('$')[1]);
    if (!row || !safeEqual(derived, encoded)) fail(401, '用户名或密码不正确。');
    return establish(req, res, JSON.parse(row.data));
  }
  function logout(req, res) { const current = requireSession(req); store.run('DELETE FROM sessions WHERE token_hash=?', current.tokenHash); cookie(res, '', 0); return { ok: true }; }
  function saveUser(user) { store.run('UPDATE users SET data=? WHERE id=?', JSON.stringify(user), user.id); return user; }
  function profile(userId, payload) {
    const user = userById(userId);
    user.displayName = field(payload.displayName, '显示姓名', 1, 80);
    for (const [key, max] of [['institution', 200], ['bio', 3000], ['orcid', 40], ['openalexId', 80]]) user.profile[key] = field(payload[key] ?? '', key, 0, max);
    if (user.profile.orcid) { const normalized = normalizeOrcid(user.profile.orcid); if (!normalized) fail(400, 'ORCID 格式或校验位不正确；手填信息不会成为认证。'); user.profile.orcid = normalized; }
    if (user.profile.openalexId && !/^A\d+$/.test(user.profile.openalexId)) fail(400, 'OpenAlex 作者编号应以 A 开头并跟随数字。');
    user.profile.identityStatus = 'user-declared';
    return { user: saveUser(user) };
  }
  function search(query) {
    const q = field(query ?? '', '搜索词', 0, 80).replace(/[\\%_]/g, value => `\\${value}`);
    return { users: store.all("SELECT data FROM users WHERE username LIKE ? ESCAPE '\\' OR json_extract(data,'$.displayName') LIKE ? ESCAPE '\\' ORDER BY username LIMIT 30", `%${q}%`, `%${q}%`).map(row => { const u = JSON.parse(row.data); return { id: u.id, username: u.username, displayName: u.displayName }; }) };
  }
  return { session, requireSession, csrf, register, login, logout, profile, search, userById, saveUser };
}
