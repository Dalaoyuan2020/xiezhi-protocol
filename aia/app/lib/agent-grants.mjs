import { randomBytes } from 'node:crypto';
import { fail, field, hashBytes, id } from './store.mjs';

export const AGENT_SCOPES = Object.freeze(['research:import', 'research:review', 'act:answer', 'act:deliver']);
const AGE = 7 * 24 * 60 * 60 * 1000;

/** Human-issued delegation; never accepts an agent as a browser session. */
export function createAgentGrants(store, auth, { now = Date.now } = {}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS agent_grants (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL, revoked_at INTEGER, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_grants_owner ON agent_grants(user_id);`);
  const usage = new Map();
  const view = row => ({ ...JSON.parse(row.data), revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null, active: !row.revoked_at && row.expires_at > now() });
  function list(userId) { return { agents: store.all('SELECT * FROM agent_grants WHERE user_id=? ORDER BY rowid DESC', userId).map(view) }; }
  function issue(userId, payload) {
    const name = field(payload.name, 'Agent 名称', 1, 60);
    if (!Array.isArray(payload.scopes) || !payload.scopes.length || payload.scopes.length > AGENT_SCOPES.length || new Set(payload.scopes).size !== payload.scopes.length || payload.scopes.some(scope => !AGENT_SCOPES.includes(scope))) fail(400, '请从允许的操作范围中选择授权。');
    if (store.one('SELECT count(*) AS n FROM agent_grants WHERE user_id=? AND revoked_at IS NULL AND expires_at>?', userId, now()).n >= 10) fail(409, '每个账号最多保留 10 个有效 Agent 授权。');
    const createdAt = new Date(now()).toISOString(), expiresAt = now() + AGE;
    const agent = { id: id('agent'), name, guarantorId: userId, scopes: [...payload.scopes], createdAt, expiresAt: new Date(expiresAt).toISOString() };
    const token = `aig_${randomBytes(32).toString('base64url')}`;
    store.run('INSERT INTO agent_grants(id,user_id,token_hash,expires_at,data) VALUES(?,?,?,?,?)', agent.id, userId, hashBytes(token), expiresAt, JSON.stringify(agent));
    return { agent, token };
  }
  function revoke(userId, agentId) {
    const result = store.run('UPDATE agent_grants SET revoked_at=? WHERE id=? AND user_id=?', now(), agentId, userId);
    if (!result.changes) fail(404, '没有找到你的 Agent 授权。');
    return { ok: true };
  }
  function authenticate(req) {
    if (req.headers.cookie || req.headers.origin || req.headers['sec-fetch-site']) fail(403, 'Agent 接口只接受独立的服务端授权请求，请勿携带浏览器会话。');
    const match = /^Bearer (aig_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    if (!match) fail(401, '请提供有效的 Agent 授权。');
    const row = store.one('SELECT * FROM agent_grants WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?', hashBytes(match[1]), now());
    if (!row) fail(401, 'Agent 授权已过期、撤销或无效。');
    const user = auth.userById(row.user_id);
    if (!user) fail(401, '担保账号不存在。');
    for (const [key, value] of usage) if (value.at + 60000 <= now()) usage.delete(key);
    const budget = usage.get(user.id) || { at: now(), count: 0 };
    usage.set(user.id, budget);
    if (++budget.count > 60) fail(429, '该担保人的 Agent 请求过多，请一分钟后重试。');
    const agent = view(row);
    return { user, agent, actor: { type: 'agent', agentId: agent.id, name: agent.name, label: `agent:${agent.name}`, guarantorId: user.id, guarantorName: user.displayName } };
  }
  function requireScope(context, scope) {
    const current = store.one('SELECT revoked_at,expires_at FROM agent_grants WHERE id=?', context.agent.id);
    if (!current || current.revoked_at || current.expires_at <= now()) fail(401, 'Agent 授权已失效。');
    if (!context.agent.scopes.includes(scope)) fail(403, '这份授权不包含该操作。');
  }
  return { list, issue, revoke, authenticate, requireScope };
}
