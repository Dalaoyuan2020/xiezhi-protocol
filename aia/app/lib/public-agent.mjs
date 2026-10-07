import { Worker } from 'node:worker_threads';

const DEFAULT_WORKER = new URL('./public-agent-worker.mjs', import.meta.url);
const problem = code => Object.assign(new Error('公开核验任务未完成。'), { code });

// The legacy scorer starts a synchronous Python process. Run it off the HTTP
// thread so slow public assessments cannot block login, search, or health checks.
export function createPublicAgentRunner({ workerUrl = DEFAULT_WORKER, credentials = () => ({}) } = {}) {
  return async function runPublicAgent(query, emit, options = {}, { signal, timeoutMs = 180000 } = {}) {
    if (signal?.aborted) throw problem('PUBLIC_AGENT_ABORTED');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw problem('PUBLIC_AGENT_TIMEOUT_CONFIG');
    const env = { ...process.env };
    const managed = credentials();
    if (Object.hasOwn(managed, 'OPENALEX_API_KEY')) env.OPENALEX_API_KEY = managed.OPENALEX_API_KEY || '';
    for (const key of Object.keys(env)) if (/PRIVATE.?KEY|MNEMONIC|SEED_PHRASE|DEPLOYER_KEY|AIA_ADMIN_TOKEN/i.test(key)) delete env[key];
    const worker = new Worker(workerUrl, {
      workerData: { query, options: { anchor: false, privateKey: null, ...(options.pick ? { pick: options.pick, query: options.query || query } : {}) } },
      env, stdout: true, stderr: true,
    });
    // Upstream tools may print URLs or errors; none are forwarded to the client
    // or default server logs. The SSE route provides a sanitized failure instead.
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise((resolve, reject) => {
      let settling = false;
      const finish = async error => {
        if (settling) return;
        settling = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        // Do not free the caller's concurrency slot until this worker is gone.
        try { await worker.terminate(); } catch { error ||= problem('PUBLIC_AGENT_WORKER_FAILED'); }
        if (error) reject(error); else resolve();
      };
      const abort = () => { void finish(problem('PUBLIC_AGENT_ABORTED')); };
      const timer = setTimeout(() => { void finish(problem('PUBLIC_AGENT_TIMEOUT')); }, timeoutMs);
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      worker.on('message', message => {
        if (settling) return;
        if (message?.kind === 'event') {
          try { emit(message.event); } catch { void finish(problem('PUBLIC_AGENT_ABORTED')); }
        } else if (message?.kind === 'done') void finish();
        else if (message?.kind === 'error') void finish(problem('PUBLIC_AGENT_WORKER_FAILED'));
      });
      worker.once('error', () => { void finish(problem('PUBLIC_AGENT_WORKER_FAILED')); });
      worker.once('exit', () => { if (!settling) void finish(problem('PUBLIC_AGENT_WORKER_EXITED')); });
      if (signal?.aborted) abort();
    });
  };
}

export const runPublicAgent = createPublicAgentRunner();
