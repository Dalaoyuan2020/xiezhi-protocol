import { parentPort, workerData } from 'node:worker_threads';

try {
  const { run } = await import('../../chain/agent.mjs');
  const { query, options } = workerData;
  await run(query, event => parentPort.postMessage({ kind: 'event', event }), {
    anchor: false, privateKey: null,
    ...(options.pick ? { pick: options.pick, query: options.query || query } : {}),
  });
  parentPort.postMessage({ kind: 'done' });
} catch {
  parentPort.postMessage({ kind: 'error' });
} finally {
  parentPort.close();
}
