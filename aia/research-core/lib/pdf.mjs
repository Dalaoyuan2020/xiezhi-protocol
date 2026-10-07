import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function pdfToText(bytes) {
  if (bytes.length > 12 * 1024 * 1024 || !Buffer.from(bytes).subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('PDF 文件无效或超过 12 MB。');
  return new Promise((resolve, reject) => {
    const worker = fork(fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      execArgv: ['--max-old-space-size=384'],
      env: Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'HOME', 'LANG'].filter(key => process.env[key] != null).map(key => [key, process.env[key]])),
    });
    let settled = false;
    const timer = setTimeout(() => { worker.kill(); finish(new Error('PDF 解析超过 20 秒，请使用较小的文本版 PDF 或粘贴文章正文。')); }, 20000);
    function finish(error, text) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(text);
    }
    worker.once('message', result => result.error ? finish(new Error(result.error)) : finish(null, result.text));
    worker.once('error', error => finish(new Error(`PDF 无法读取：${error.message}`)));
    worker.once('exit', code => { if (!settled) finish(new Error(`PDF 解析进程提前结束（${code}）。`)); });
    worker.send({ base64: Buffer.from(bytes).toString('base64') });
  });
}
