import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { runCheckup } from '../../chain/lib.mjs';

test('legacy Agent invokes Python with a native absolute script path, bounded runtime and UTF-8 output', async () => {
  let invoked;
  const result = runCheckup('A123', { env: { AIA_PYTHON: '', AIA_CHECKUP_TIMEOUT_MS: '120000' }, execFileSync: (...args) => { invoked = args; return '{"name":"中文姓名","openalex":"A123","score":42}'; } });
  assert.equal(result.name, '中文姓名');
  const [executable, args, options] = invoked;
  assert.equal(executable, process.platform === 'win32' ? 'python' : 'python3');
  assert.equal(args[0], fileURLToPath(new URL('../../product/checkup.py', import.meta.url)));
  assert.ok(path.isAbsolute(args[0]));
  assert.ok((await stat(args[0])).isFile());
  assert.equal(args[1], 'A123');
  if (process.platform === 'win32') assert.doesNotMatch(args[0], /^\/[A-Z]:/i);
  assert.equal(options.cwd, fileURLToPath(new URL('../../product/', import.meta.url)));
  assert.equal(options.timeout, 120000);
  assert.equal(options.windowsHide, true);
  assert.equal(options.encoding, 'utf8');
  assert.equal(options.env.PYTHONIOENCODING, 'utf-8');
  assert.equal(options.env.PYTHONUTF8, '1');
  assert.equal(options.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.ok(options.maxBuffer <= 4 * 1024 * 1024);
  assert.notEqual(options.shell, true);
});

test('Python override is one literal executable and errors never produce a cached or fabricated card', () => {
  let invocation;
  const configured = 'C:/Program Files/Python 学术/python.exe';
  runCheckup('A123', { env: { AIA_PYTHON: configured, AIA_CHECKUP_TIMEOUT_MS: '45000' }, execFileSync: (...args) => { invocation = args; return '{}'; } });
  assert.equal(invocation[0], configured);
  assert.equal(invocation[2].timeout, 45000);
  for (const timeoutMs of [0, -1, 180001, 1.5, 'invalid']) {
    assert.throws(() => runCheckup('A123', { timeoutMs, execFileSync: () => assert.fail('invalid timeout must not spawn') }), /超时/);
  }
  for (const code of ['ENOENT', 'ETIMEDOUT']) {
    assert.throws(() => runCheckup('A123', { execFileSync: () => { throw Object.assign(new Error('Python unavailable in fixture'), { code }); } }), error => error.code === code);
  }
  assert.throws(() => runCheckup('A123', { execFileSync: () => 'not JSON' }), SyntaxError);
});

test('actual local Python runs the shipped scorer offline, preserves Unicode and supports ORCID arguments', async t => {
  const python = process.env.AIA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  try { execFileSync(python, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); }
  catch { t.skip('Python interpreter is unavailable; configure AIA_PYTHON to run the process integration test'); return; }
  const root = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(root, 'aia-python-学术 path-'));
  t.after(async () => {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('aia-python-学术 path-'));
    await rm(resolved, { recursive: true, force: true });
  });
  // Python auto-imports this module before the real script. Every HTTP attempt is intercepted;
  // unexpected URLs fail closed so this integration test cannot query OpenAlex or any network.
  await writeFile(path.join(directory, 'sitecustomize.py'), `import io, json, urllib.request
def offline_urlopen(url, timeout=None):
    if "/authors/" in url:
        value = {"id":"https://openalex.org/A123", "display_name":"测试学者 · Scholar", "orcid":"https://orcid.org/0000-0002-1825-0097", "last_known_institutions":[{"display_name":"研究机构"}], "cited_by_count":100, "summary_stats":{"h_index":7,"i10_index":3}}
    elif "/works?" in url:
        value = {"results":[{"title":"已核对的公开作品", "primary_topic":{"field":{"display_name":"计算机科学"}}, "is_retracted":False, "open_access":{"is_oa":True}, "fwci":1.2, "publication_year":2026}], "meta":{"next_cursor":None}}
    else:
        raise RuntimeError("All external network requests are disabled by the integration test")
    return io.BytesIO(json.dumps(value, ensure_ascii=False).encode("utf-8"))
urllib.request.urlopen = offline_urlopen
`, 'utf8');
  for (const author of ['A123', 'https://orcid.org/0000-0002-1825-0097']) {
    const card = runCheckup(author, { python, timeoutMs: 5000, env: { PYTHONPATH: directory } });
    assert.equal(card.name, '测试学者 · Scholar');
    assert.equal(card.openalex, 'A123');
    assert.equal(card.institutions[0], '研究机构');
    assert.equal(card.score, 92);
    assert.equal(card.works, 1);
    assert.match(card.dims['身份清晰度'], /计算机科学/);
  }
  await assert.rejects(stat(path.join(directory, '__pycache__')), { code: 'ENOENT' });
});
