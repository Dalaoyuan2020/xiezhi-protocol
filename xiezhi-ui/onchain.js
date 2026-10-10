// 钱包上链：用户用自己的钱包，把一份材料的 SHA-256 指纹登记到 BOT Chain 上的 ActionRegistry。
// 免登录、文件不上传；交易由用户钱包签名并支付 gas，本页不持有任何私钥。
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XiezhiOnchain = api;
  if (root && root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => api.mount(root));
    else api.mount(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SDK = 'https://cdn.jsdelivr.net/npm/ethers@6.17.0/+esm';
  const NETWORKS = Object.freeze({
    mainnet: Object.freeze({ key: 'mainnet', chainId: 677, hex: '0x2a5', name: 'BOT Chain', label: 'BOT 主网 · 677', rpc: 'https://rpc.botchain.ai', explorer: 'https://scan.botchain.ai', deployment: '/chain/deployments/botchain.json' }),
    testnet: Object.freeze({ key: 'testnet', chainId: 968, hex: '0x3c8', name: 'BOT Chain Testnet', label: 'BOT 测试网 · 968', rpc: 'https://rpc.bohr.life', explorer: 'https://scan.bohr.life', deployment: '/chain/deployments/botchain-testnet.json' })
  });
  const ABI = Object.freeze([
    'function record(bytes32 subject, bytes32 kind, bytes32 content, bytes32 org, bytes32 rule, uint16 value) returns (uint256 id)',
    'function actionsByContent(bytes32 content) view returns (tuple(bytes32 subject, bytes32 kind, bytes32 content, bytes32 org, bytes32 rule, uint16 value, address recorder, uint64 time)[])',
    'event Recorded(uint256 indexed id, bytes32 indexed subject, bytes32 indexed kind, bytes32 content, bytes32 org, uint16 value, address recorder)'
  ]);
  const KIND = 'CLAIM';
  const RULE = 'wallet-web-v1';
  const KIND_LABELS = { SCORE: '评分', SUBMIT: '投稿', CLOSE: '结案', REVIEW: '审稿', REPRODUCE: '复现', CLAIM: '认领' };
  const ZERO = '0x' + '0'.repeat(64);
  const GAS_HINT = 6n * 10n ** 15n; // 一笔登记实测约 0.0045 BOT，低于 0.006 BOT 时提醒
  const MAX_FILE = 200 * 1024 * 1024;

  function pickNetwork(search) {
    return new URLSearchParams(search || '').get('network') === 'testnet' ? NETWORKS.testnet : NETWORKS.mainnet;
  }
  function toHex(buffer) {
    return '0x' + Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function sha256(bytes, subtle) {
    return toHex(await subtle.digest('SHA-256', bytes));
  }
  function orcidChecksumOk(id) {
    const digits = id.replace(/-/g, '');
    let total = 0;
    for (const char of digits.slice(0, 15)) total = (total + Number(char)) * 2;
    const result = (12 - total % 11) % 11;
    return digits[15] === (result === 10 ? 'X' : String(result));
  }
  function normalizeOrcid(value) {
    const id = String(value || '').trim().toUpperCase().replace(/^HTTPS?:\/\/ORCID\.ORG\//, '');
    if (!id) return '';
    if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(id) || !orcidChecksumOk(id)) throw new Error('ORCID 格式不对，应为 0000-0000-0000-0000 这样的 16 位编号。');
    return id;
  }
  function subjectSeed(address, orcid) {
    return orcid ? 'orcid:' + orcid : 'wallet:' + String(address).toLowerCase();
  }
  /** record() 的 6 个参数：主体、类型 CLAIM、内容指纹、机构 0、规则 wallet-web-v1、分值 0。 */
  function buildRecordArgs(ethers, address, orcid, content) {
    if (!/^0x[0-9a-f]{64}$/i.test(content || '')) throw new Error('还没有材料指纹。');
    const subject = ethers.keccak256(ethers.toUtf8Bytes(subjectSeed(address, orcid)));
    return [subject, ethers.encodeBytes32String(KIND), content, ZERO, ethers.encodeBytes32String(RULE), 0];
  }
  function explain(error) {
    const code = error?.code ?? error?.info?.error?.code ?? error?.error?.code;
    const message = String(error?.shortMessage || error?.info?.error?.message || error?.message || error);
    if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied)/i.test(message)) return '你在钱包里取消了，本次没有发送交易。';
    if (code === -32002) return '钱包里已有一个待处理的请求，请先打开钱包处理。';
    if (code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(message)) return '钱包里的 BOT 不够付 gas，一笔约需 0.005 BOT。';
    if (code === 'TIMEOUT') return '等待确认超时：交易可能仍在处理，请用上面的链接到区块浏览器查看。';
    return message;
  }
  function formatBot(wei) {
    const value = BigInt(wei);
    const whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
    return `${whole}.${fraction} BOT`;
  }
  function decodeLabel(ethers, value) {
    try { return ethers.decodeBytes32String(value); } catch { return String(value).slice(0, 10) + '…'; }
  }
  function formatTime(seconds) {
    return new Date(Number(seconds) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }
  const short = value => String(value).slice(0, 6) + '…' + String(value).slice(-4);
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  function mount(win) {
    const doc = win.document;
    const $ = id => doc.getElementById(id);
    if (!$('oc-connect')) return;
    const net = pickNetwork(win.location.search);
    const state = { account: null, content: null, deployment: null, sdk: null, busy: false };

    const el = (tag, attrs = {}, text) => {
      const node = doc.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
    const status = (text, warn = false) => { $('oc-status').textContent = text; $('oc-status').classList.toggle('warn', warn); };
    const ethereum = () => {
      if (!win.ethereum?.request) throw new Error('没有检测到钱包。手机请在 MetaMask、OKX 钱包等 App 的内置浏览器里打开本页；电脑请安装钱包浏览器扩展。没有钱包也可以先在第 2 步查询链上记录。');
      return win.ethereum;
    };
    const sdk = async () => (state.sdk ||= import(SDK).then(module => module.ethers || module));
    async function deployment() {
      if (state.deployment) return state.deployment;
      const response = await fetch(net.deployment, { cache: 'no-store' });
      if (!response.ok) throw new Error('读取合约部署信息失败。');
      const data = await response.json();
      if (Number(data.chainId) !== net.chainId || !/^0x[0-9a-f]{40}$/i.test(data.address || '')) throw new Error('合约部署信息与所选网络不一致。');
      return (state.deployment = data);
    }

    function renderNetwork() {
      $('oc-net-label').textContent = net.label;
      const box = $('oc-netswitch');
      box.replaceChildren();
      if (net.key === 'mainnet') {
        box.append('想先免费试一下？', el('a', { href: '?network=testnet' }, '切到测试网'), '（测试网 BOT 从官方水龙头领取，不算正式记录）');
      } else {
        box.classList.add('warn');
        box.append('当前是测试网，交易不算正式记录。', el('a', { href: 'onchain.html' }, '回到主网'));
      }
      deployment().then(data => {
        const target = $('oc-contract');
        target.replaceChildren(link(`${net.explorer}/address/${data.address}`, data.address));
      }).catch(error => { $('oc-contract').textContent = explain(error); });
    }

    async function ensureChain(eth) {
      if (BigInt(await eth.request({ method: 'eth_chainId' })) === BigInt(net.chainId)) return;
      try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: net.hex }] }); }
      catch (error) {
        const code = Number(error?.code ?? error?.data?.originalError?.code);
        if (code !== 4902) throw error;
        await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: net.hex, chainName: net.name, nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 }, rpcUrls: [net.rpc], blockExplorerUrls: [net.explorer] }] });
        if (BigInt(await eth.request({ method: 'eth_chainId' })) !== BigInt(net.chainId)) await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: net.hex }] });
      }
      if (BigInt(await eth.request({ method: 'eth_chainId' })) !== BigInt(net.chainId)) throw new Error(`钱包还没有切到 ${net.label}，本次不会发送交易。`);
    }

    async function refreshWallet() {
      const eth = win.ethereum;
      if (!eth?.request || !state.account) return;
      const chainId = BigInt(await eth.request({ method: 'eth_chainId' }));
      const onChain = chainId === BigInt(net.chainId);
      $('oc-wallet').hidden = false;
      $('oc-address').replaceChildren(link(`${net.explorer}/address/${state.account}`, state.account));
      $('oc-chain').textContent = onChain ? net.label + ' ✓' : `链 ID ${chainId}（不是 ${net.label}）`;
      $('oc-chain').classList.toggle('warn', !onChain);
      if (onChain) {
        const balance = BigInt(await eth.request({ method: 'eth_getBalance', params: [state.account, 'latest'] }));
        $('oc-balance').textContent = formatBot(balance) + (balance < GAS_HINT ? '（不够一笔 gas，约需 0.005 BOT）' : '');
        $('oc-balance').classList.toggle('warn', balance < GAS_HINT);
      } else $('oc-balance').textContent = '—';
      $('oc-connect').textContent = '已连接 ' + short(state.account);
      updateSend();
    }

    async function connect() {
      const eth = ethereum();
      const accounts = await eth.request({ method: 'eth_requestAccounts' });
      if (!accounts?.[0]) throw new Error('没有拿到钱包地址。');
      state.account = accounts[0];
      status('正在切换到 ' + net.label + '…');
      await ensureChain(eth);
      await refreshWallet();
      status('钱包已连接。');
    }

    async function showHash(name, hash) {
      if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('指纹格式不对。');
      state.content = hash.toLowerCase();
      $('oc-material').hidden = false;
      $('oc-material-name').textContent = name;
      $('oc-hash').textContent = state.content;
      updateSend();
      await lookup();
    }

    async function setMaterial(name, bytes) {
      const subtle = win.crypto?.subtle;
      if (!subtle) throw new Error('当前浏览器不支持在本地计算指纹，请换用新版浏览器并通过 https 打开。');
      status('正在本地计算指纹…');
      state.content = await sha256(bytes, subtle);
      $('oc-material').hidden = false;
      $('oc-material-name').textContent = name;
      $('oc-hash').textContent = state.content;
      updateSend();
      await lookup();
    }

    async function reader(ethers) {
      if (state.account && win.ethereum?.request && BigInt(await win.ethereum.request({ method: 'eth_chainId' })) === BigInt(net.chainId)) return new ethers.BrowserProvider(win.ethereum);
      return new ethers.JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true, batchMaxCount: 1 });
    }

    async function lookup() {
      if (!state.content) return;
      const box = $('oc-records');
      box.hidden = false;
      box.replaceChildren(el('p', { class: 'oc-hint' }, '正在查询链上记录…'));
      const ethers = await sdk();
      const data = await deployment();
      const contract = new ethers.Contract(data.address, ABI, await reader(ethers));
      const actions = await contract.actionsByContent(state.content);
      box.replaceChildren();
      if (!actions.length) {
        box.append(el('p', { class: 'oc-empty' }, `${net.label} 上还没有这份材料的登记。`));
        status('指纹已算好。');
        return;
      }
      const recorders = new Set(actions.map(action => String(action.recorder).toLowerCase()));
      box.append(el('p', { class: recorders.size > 1 ? 'oc-summary warn' : 'oc-summary' },
        `这份材料在 ${net.label} 上有 ${actions.length} 条登记，来自 ${recorders.size} 个地址` + (recorders.size > 1 ? '：多个地址声明了同一份材料，请注意核对。' : '。')));
      const list = el('ol', { class: 'oc-list' });
      for (const action of actions) {
        const kind = decodeLabel(ethers, action.kind);
        const item = el('li');
        item.append(el('strong', {}, KIND_LABELS[kind] || kind), ' · ', link(`${net.explorer}/address/${action.recorder}`, short(action.recorder)));
        if (same(action.recorder, state.account)) item.append(el('span', { class: 'oc-you' }, '你'));
        const rule = action.rule === ZERO ? '' : ' · 规则 ' + decodeLabel(ethers, action.rule);
        item.append(el('small', {}, formatTime(action.time) + rule));
        list.append(item);
      }
      box.append(list);
      status('指纹已算好，链上记录已更新。');
    }

    function updateSend() {
      $('oc-send').disabled = state.busy || !state.content;
      $('oc-send').textContent = state.account ? '签名并登记到链上' : '连接钱包并登记到链上';
    }

    async function send() {
      if (!state.content) throw new Error('请先在第 2 步选择材料。');
      const orcid = normalizeOrcid($('oc-orcid').value);
      if (!state.account) await connect();
      const eth = ethereum();
      await ensureChain(eth);
      const ethers = await sdk();
      const data = await deployment();
      const signer = await new ethers.BrowserProvider(eth).getSigner();
      if (!same(signer.address, state.account)) { state.account = signer.address; await refreshWallet(); }
      const contract = new ethers.Contract(data.address, ABI, signer);
      status('请在钱包里核对并确认交易…');
      const tx = await contract.record(...buildRecordArgs(ethers, signer.address, orcid, state.content));
      const result = $('oc-result');
      result.hidden = false;
      result.className = 'oc-result pending';
      result.replaceChildren(el('p', {}, '交易已由你的钱包发出，等待区块确认…'), el('p', { class: 'oc-mono' }, ''), el('p'));
      result.children[1].append(link(`${net.explorer}/tx/${tx.hash}`, tx.hash));
      status('交易已发出，等待确认…');
      const receipt = await tx.wait(1, 180000);
      if (!receipt || receipt.status !== 1) throw new Error('交易没有执行成功，请用上面的链接到区块浏览器查看。');
      let id = null;
      for (const entry of receipt.logs) {
        try { const parsed = contract.interface.parseLog(entry); if (parsed?.name === 'Recorded') id = parsed.args.id.toString(); } catch { /* 其他合约的日志 */ }
      }
      result.className = 'oc-result done';
      result.replaceChildren(
        el('p', { class: 'oc-done' }, '✓ 已登记到 ' + net.label),
        el('dl', { class: 'oc-facts' }));
      const facts = result.lastChild;
      const fact = (label, value) => { const row = el('div'); row.append(el('dt', {}, label)); const dd = el('dd'); dd.append(value); row.append(dd); facts.append(row); };
      fact('交易', link(`${net.explorer}/tx/${tx.hash}`, tx.hash));
      fact('区块', link(`${net.explorer}/block/${receipt.blockNumber}`, '#' + receipt.blockNumber));
      if (id !== null) fact('登记编号', '#' + id);
      fact('登记人', link(`${net.explorer}/address/${signer.address}`, signer.address));
      fact('身份', orcid ? 'ORCID ' + orcid : '钱包地址');
      const share = new URL(win.location.href);
      share.search = (net.key === 'testnet' ? '?network=testnet&' : '?') + 'hash=' + state.content;
      fact('查询链接', link(share.href, '打开即可查看这份材料的链上登记'));
      await refreshWallet();
      await lookup();
      status('登记完成，链上记录已更新。');
    }

    const guard = action => async event => {
      event?.preventDefault?.();
      if (state.busy) return;
      state.busy = true; updateSend();
      try { await action(event); }
      catch (error) { status(explain(error), true); }
      finally { state.busy = false; updateSend(); }
    };

    $('oc-connect').addEventListener('click', guard(connect));
    $('oc-send').addEventListener('click', guard(send));
    $('oc-file').addEventListener('change', guard(async () => {
      const file = $('oc-file').files?.[0];
      if (!file) return;
      if (file.size > MAX_FILE) throw new Error('文件超过 200 MB，请换一份较小的文件或改用文字。');
      await setMaterial(`${file.name}（${(file.size / 1024).toFixed(1)} KB）`, await file.arrayBuffer());
    }));
    $('oc-hash-text').addEventListener('click', guard(async () => {
      const text = $('oc-text').value.trim();
      if (!text) throw new Error('请先粘贴一段文字。');
      await setMaterial(`一段文字（${text.length} 字）`, new TextEncoder().encode(text));
    }));
    if (win.ethereum?.on) {
      win.ethereum.on('accountsChanged', accounts => { state.account = accounts?.[0] || null; if (!state.account) { $('oc-wallet').hidden = true; $('oc-connect').textContent = '连接钱包'; updateSend(); } else refreshWallet().catch(() => {}); });
      win.ethereum.on('chainChanged', () => { refreshWallet().catch(() => {}); });
    }
    $('oc-demo').addEventListener('click', guard(async event => {
      if (net.key !== 'mainnet') { win.location.href = 'onchain.html'; return; }
      await showHash('示例：演示期刊甲、乙登记的同一份稿件（10-07 主网）', $('oc-demo').dataset.hash);
    }));
    renderNetwork();
    updateSend();
    const shared = new URLSearchParams(win.location.search).get('hash');
    if (shared) guard(() => showHash('分享的查询链接', shared))();
    if (!win.ethereum?.request) $('oc-wallet-hint').classList.add('warn');
  }

  return { NETWORKS, ABI, KIND, RULE, pickNetwork, toHex, sha256, normalizeOrcid, subjectSeed, buildRecordArgs, explain, formatBot, mount };
});
