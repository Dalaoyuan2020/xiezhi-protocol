import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore, digest } from '../lib/store.mjs';
import { createAuth } from '../lib/auth.mjs';
import { createResearchService } from '../lib/research-service.mjs';
import { createWorkflow } from '../lib/workflow.mjs';
import { createCommunityAct, loadActSeedFile } from '../lib/community-act.mjs';

const APP = fileURLToPath(new URL('../', import.meta.url));
const REPO = path.resolve(APP, '../..');
const TARGETS = ['A5126602136', 'A5072119017', 'A5101284139'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const short = value => String(value || '').split('/').pop();

export function buildActSeeds(sources) {
  const groups = new Map(TARGETS.map(author => [author, []]));
  const names = new Map();
  for (const source of sources) {
    for (const work of Array.isArray(source.data.results) ? source.data.results : [source.data]) {
      if (!/^W\d+$/.test(short(work.id)) || typeof work.title !== 'string' || !Array.isArray(work.authorships) || work.authorships.length > 30 || work.authorships.length < 1) continue;
      const authors = work.authorships.map(item => ({ id: short(item.author?.id), name: item.author?.display_name })).filter(item => /^A\d+$/.test(item.id) && typeof item.name === 'string');
      // Incomplete author lists must never support an absence question.
      if (authors.length !== work.authorships.length) continue;
      for (const author of authors) if (groups.has(author.id)) {
        names.set(author.id, author.name);
        const group = groups.get(author.id);
        if (group.length < 8 && !group.some(item => item.snapshot.workId === short(work.id))) group.push({ source,
          snapshot: { workId: short(work.id), title: work.title, doi: work.doi || null, publicationYear: work.publication_year || null, authors } });
      }
    }
  }
  const selected = [], seen = new Set();
  for (let round = 0; round < 8 && selected.length < 10; round++) for (const author of TARGETS) {
    const item = groups.get(author)[round];
    if (item && selected.length < 10 && !seen.has(item.snapshot.workId)) { selected.push({ ...item, author }); seen.add(item.snapshot.workId); }
  }
  if (selected.length < 5) throw new Error('真实公开快照不足五道题；没有生成替代或虚构题目。');
  const snapshots = [], tasks = selected.map((item, index) => {
    // Mix positive and negative membership questions; hidden quality checks are
    // selected separately by a persistent server secret, never by this index.
    const negative = index % 5 === 4 ? TARGETS.find(author => names.has(author) && !item.snapshot.authors.some(a => a.id === author)) : null;
    const target = negative || item.author;
    const snapshotHash = digest(item.snapshot);
    snapshots.push({ snapshotHash, sourceUrl: `https://api.openalex.org/works/${item.snapshot.workId}`,
      sourceSha256: item.source.sourceSha256, capturedAt: item.source.capturedAt, timestampBasis: item.source.timestampBasis, snapshot: item.snapshot });
    return { subject: { authorId: target, workId: item.snapshot.workId }, title: `核对作者列表：${names.get(target)} · ${item.snapshot.workId}`,
      prompt: `请核对所附 OpenAlex 快照：《${item.snapshot.title}》的作者列表是否包含 ${names.get(target)}（${target}）？请指出作者编号、记录日期等依据。只核对公开记录，不认定真实署名归属；材料不足可选不确定。`,
      createdAt: item.source.capturedAt,
      evidence: [{ url: `https://api.openalex.org/works/${item.snapshot.workId}`, label: 'OpenAlex 论文记录快照', retrievedAt: item.source.capturedAt,
        timestampBasis: item.source.timestampBasis, snapshotHash, excerpt: JSON.stringify(item.snapshot, null, 2) },
        { url: `https://api.openalex.org/authors/${target}`, label: `待核对作者 ${target}`, retrievedAt: item.source.capturedAt,
          timestampBasis: item.source.timestampBasis, snapshotHash, excerpt: `待核对的公开作者编号：${target}；显示姓名：${names.get(target)}。姓名不能代替编号或身份证明。` }] };
  });
  return { version: 1, generatedAt: new Date().toISOString(), source: 'OpenAlex public metadata',
    notice: '由已取得的公开记录制作；时间依据逐条列出。只核对快照中的作者编号，不证明作者真实身份。未生成 Bastet 或任何竞赛任务。', snapshots, tasks };
}

async function cachedSources() {
  const sources = [];
  for (const directory of ['aia/chain/.cache', 'aia/product/.cache']) {
    const names = await readdir(path.join(REPO, directory)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of names.filter(name => /^[a-f0-9]{40}\.json$/.test(name)).sort().slice(0, 1000)) {
      const file = path.join(REPO, directory, name), info = await stat(file);
      if (!info.isFile() || info.size > 12 * 1024 * 1024) continue;
      const bytes = await readFile(file);
      let data; try { data = JSON.parse(bytes); } catch { continue; }
      sources.push({ data, capturedAt: info.mtime.toISOString(), timestampBasis: 'local-cache-mtime (not publisher update time)', sourceSha256: sha256(bytes) });
    }
  }
  return sources;
}

async function refreshSources() {
  const sources = [];
  for (const author of TARGETS) {
    const url = new URL('https://api.openalex.org/works');
    url.searchParams.set('filter', 'author.id:' + author); url.searchParams.set('per-page', '5');
    url.searchParams.set('select', 'id,title,doi,publication_year,authorships');
    if (process.env.OPENALEX_API_KEY) url.searchParams.set('api_key', process.env.OPENALEX_API_KEY);
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw new Error(`OpenAlex 返回 ${response.status}，没有生成替代题目。`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('OpenAlex 响应超过安全大小。'); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks);
    sources.push({ data: JSON.parse(bytes), capturedAt: new Date().toISOString(), timestampBasis: 'direct-fetch', sourceSha256: sha256(bytes) });
  }
  return sources;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some(arg => !['--from-cache', '--refresh', '--snapshot-only'].includes(arg)) || (args.has('--from-cache') && args.has('--refresh'))) throw new Error('用法：seed-act-tasks.mjs [--from-cache | --refresh] [--snapshot-only]');
  const seedPath = path.join(APP, 'data/act-source-snapshots.json');
  let tasks;
  if (args.has('--from-cache') || args.has('--refresh')) {
    const data = buildActSeeds(await (args.has('--refresh') ? refreshSources() : cachedSources()));
    await mkdir(path.dirname(seedPath), { recursive: true });
    await writeFile(seedPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    tasks = data.tasks;
    console.log(`已保存 ${tasks.length} 道有来源微任务；未写入任何 API 凭据。`);
  } else tasks = loadActSeedFile(seedPath);
  if (args.has('--snapshot-only')) return;
  const dataDir = process.env.AIA_APP_DATA_DIR || path.join(APP, '.runtime');
  const store = openStore(dataDir);
  try {
    const auth = createAuth(store), research = createResearchService(store, auth, { dataDir }), workflow = createWorkflow(store, auth, research, { dataDir });
    const act = createCommunityAct(store, auth, research, workflow, { seedFile: seedPath });
    console.log(`任务池现有 ${act.snapshot().tasks.length} 道微任务。启动与默认种子导入均不联网。`);
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('真实任务种子生成或导入失败；未生成替代结论。检查公开快照、网络状态或参数。'); process.exitCode = 1;
});
