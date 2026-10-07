import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicAgentRunner } from '../lib/public-agent.mjs';

const fixture = source => new URL('data:text/javascript,' + encodeURIComponent(`import { parentPort, workerData } from 'node:worker_threads';\n${source}`));

test('worker receives only read-only options and forwards events before terminating cleanly', async () => {
  const run = createPublicAgentRunner({ workerUrl: fixture(`
    parentPort.postMessage({ kind: 'event', event: workerData });
    parentPort.postMessage({ kind: 'done' });
    setInterval(() => {}, 1000); // runner must clean up even a lingering handle
  `) });
  const events = [];
  await run('Ada', event => events.push(event), { anchor: true, privateKey: 'should-never-cross-worker-boundary', pick: 'A1234567', query: 'Ada Lovelace', unexpected: 'drop' });
  assert.deepEqual(events, [{ query: 'Ada', options: { anchor: false, privateKey: null, pick: 'A1234567', query: 'Ada Lovelace' } }]);
});

test('blocking Agent work runs outside the HTTP event loop', async () => {
  const run = createPublicAgentRunner({ workerUrl: fixture(`
    parentPort.postMessage({ kind: 'event', event: { started: true } });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    parentPort.postMessage({ kind: 'done' });
  `) });
  let ticks = 0, timer;
  try {
    await run('Ada', () => { timer = setInterval(() => { ticks++; }, 15); });
    assert.ok(ticks >= 5, `main event loop only advanced ${ticks} times`);
  } finally { clearInterval(timer); }
});

test('timeout terminates even a busy worker and reports only a stable error', async () => {
  const run = createPublicAgentRunner({ workerUrl: fixture(`
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  `) });
  const before = Date.now();
  await assert.rejects(run('Ada', () => {}, {}, { timeoutMs: 80 }), { code: 'PUBLIC_AGENT_TIMEOUT' });
  assert.ok(Date.now() - before < 3000);
});

test('disconnection cancels a running worker and a pre-aborted request never starts one', async () => {
  const controller = new AbortController();
  const run = createPublicAgentRunner({ workerUrl: fixture(`
    parentPort.postMessage({ kind: 'event', event: { started: true } });
    setInterval(() => {}, 1000);
  `) });
  await assert.rejects(run('Ada', () => controller.abort(), {}, { signal: controller.signal }), { code: 'PUBLIC_AGENT_ABORTED' });
  const shouldNotStart = createPublicAgentRunner({ workerUrl: new URL('file:///does-not-exist-public-agent.mjs') });
  await assert.rejects(shouldNotStart('Ada', () => {}, {}, { signal: controller.signal }), { code: 'PUBLIC_AGENT_ABORTED' });
});

test('unexpected worker errors and premature exits never expose internal details', async () => {
  for (const source of ['throw new Error("private credential should never appear");', 'process.exit(0);']) {
    const run = createPublicAgentRunner({ workerUrl: fixture(source) });
    await assert.rejects(run('Ada', () => {}), error => {
      assert.match(error.code, /^PUBLIC_AGENT_WORKER_/);
      assert.doesNotMatch(error.message, /private credential/);
      return true;
    });
  }
});

test('new workers receive current managed OpenAlex credentials without the administrator token', async () => {
  let key = 'first-server-only-key';
  const run = createPublicAgentRunner({ credentials: () => ({ OPENALEX_API_KEY: key }), workerUrl: fixture(`
    parentPort.postMessage({ kind: 'event', event: { key: process.env.OPENALEX_API_KEY, admin: Boolean(process.env.AIA_ADMIN_TOKEN) } });
    parentPort.postMessage({ kind: 'done' });
  `) });
  const events = [];
  await run('Ada', event => events.push(event));
  key = 'updated-server-only-key';
  await run('Ada', event => events.push(event));
  key = '';
  await run('Ada', event => events.push(event));
  assert.deepEqual(events, [{ key: 'first-server-only-key', admin: false }, { key: 'updated-server-only-key', admin: false }, { key: '', admin: false }]);
});
