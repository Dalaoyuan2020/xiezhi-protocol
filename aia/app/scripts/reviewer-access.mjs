// Run only by the server maintainer after checking identity evidence.
import path from 'node:path';
import { openStore, field, digest } from '../lib/store.mjs';
import { runCheckup } from '../../chain/lib.mjs';
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
if (!process.env.AIA_APP_DATA_DIR || !path.isAbsolute(process.env.AIA_APP_DATA_DIR)) throw new Error('请显式设置 AIA_APP_DATA_DIR 为已备份的服务端数据目录。');
const userId = field(option('--user'), '账号编号', 1, 100);
const store = openStore(process.env.AIA_APP_DATA_DIR);
try {
  store.db.exec('CREATE TABLE IF NOT EXISTS reviewer_credentials (user_id TEXT PRIMARY KEY REFERENCES users(id), data TEXT NOT NULL)');
  const row = store.one('SELECT data FROM users WHERE id=?', userId);
  if (!row) throw new Error('账号不存在。');
  if (args.includes('--revoke')) {
    store.run('DELETE FROM reviewer_credentials WHERE user_id=?', userId);
    console.log('已撤销该账号的社区审稿资格。');
  } else {
    if (!args.includes('--identity-checked')) throw new Error('须先独立核对账号与学术身份，再显式提供 --identity-checked。');
    const evidence = field(option('--evidence'), '核验依据（只保存在服务端）', 20, 2000);
    const user = JSON.parse(row.data), authorId = option('--author');
    if (!/^A\d+$/.test(authorId || '') || user.profile?.openalexId !== authorId) throw new Error('待核验 OpenAlex 编号必须与该账号现有个人资料一致。');
    let card;
    try { card = runCheckup(authorId, { rule: 'v2' }); } catch { throw new Error('读取公开评分失败，资格未更新。请核对服务端网络与数据源配置后重试。'); }
    if (card.openalex !== authorId || !Number.isFinite(card.score) || card.score < 350 || card.score > 950 || !Number.isFinite(card.chain_value)) throw new Error('评分响应不是当前 350–950 分制，资格未更新。');
    const record = { status: 'verified', authorId, score: card.score, scoreHash: digest(card), evidence,
      checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), method: 'maintainer-identity-check-and-public-score' };
    store.run('INSERT INTO reviewer_credentials(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data', userId, JSON.stringify(record));
    console.log(JSON.stringify({ userId, authorId, score: card.score, eligible: card.score >= 750, expiresAt: record.expiresAt }));
  }
} finally { store.close(); }
