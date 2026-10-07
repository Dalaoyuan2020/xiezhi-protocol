import { PDFParse } from 'pdf-parse';

process.once('message', async ({ base64 }) => {
const parser = new PDFParse({ data: new Uint8Array(Buffer.from(base64, 'base64')), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, verbosity: 0, enableXfa: false });
let response;
try {
  const info = await parser.getInfo();
  if (info.total > 200) throw new Error('当前支持最多 200 页的 PDF，请先拆分长文档。');
  const result = await parser.getText({ pageJoiner: '\n\n--- 第 page_number 页 ---\n\n' });
  const text = result.pages.map(page => `--- 第 ${page.num} 页 ---\n${page.text}`).join('\n\n').trim();
  const content = result.pages.map(page => page.text).join('').replace(/\s/g, '');
  if (content.length < 20) throw new Error('这份 PDF 没有足够的可提取文字，可能是扫描件。请先 OCR 或粘贴正文。');
  if (text.length > 2_000_000) throw new Error('PDF 正文过长，请拆分后导入。');
  response = { text };
} catch (error) {
  response = { error: `PDF 读取失败：${error.message}` };
} finally { await parser.destroy(); }
process.send(response, () => process.disconnect());
});
