// 灋廌覈鑒 · 贡献积分：规则表 + 链上账本读写
// 积分不能转让、不能买卖，不是虚拟货币；只用来解锁服务和兑换实物激励（路线图）。
// 规则来自致远 2026-10-07 手写设计图（MVP ③④⑤）：
//   新人：Agent 认领 ORCID 成果 → 新手保护，送初始积分
//   低分：投稿扣积分；中分：入门，投稿免费；高分：投稿免费 + 优先 + 可审稿挣积分
//   挣积分：复现、核对、认领错挂、审稿、日常运维
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { ethers } from "ethers";
import { RPC, CHAIN_ID, EXPLORER, NETWORK, SUFFIX } from "./config.mjs";
import { subjectOf } from "./lib.mjs";
import pointsRules from "../../xiezhi-ui/points-rules.js";

// One policy source for the issuer CLI and browser; never derive rewards from UI clicks.
export const { RULES_VERSION, RULES, TIERS, tierOf } = pointsRules;

// 部署信息：deployments/points[-testnet].json
const POINTS_FILE = new URL(`./deployments/points${SUFFIX}.json`, import.meta.url);
export const pointsDeployment = () => (existsSync(POINTS_FILE) ? JSON.parse(readFileSync(POINTS_FILE, "utf8")) : null);
export const pointsArtifact = () => JSON.parse(readFileSync(new URL("./artifacts/PointsLedger.json", import.meta.url), "utf8"));
export const reasonOf = (rule) => ethers.encodeBytes32String(rule);

export async function deployPoints(wallet) {
  const { abi, bytecode } = pointsArtifact();
  const c = await new ethers.ContractFactory(abi, bytecode, wallet).deploy();
  const tx = c.deploymentTransaction();
  const rc = await tx.wait();
  const address = await c.getAddress();
  const info = { network: `BOT Chain ${NETWORK}`, chainId: Number(CHAIN_ID), address, deployTx: tx.hash, block: rc.blockNumber,
    explorer: `${EXPLORER}/address/${address}`, owner: wallet.address, rules: RULES_VERSION, deployedAt: new Date().toISOString() };
  mkdirSync(new URL("./deployments/", import.meta.url), { recursive: true });
  writeFileSync(POINTS_FILE, JSON.stringify(info, null, 2));
  return info;
}

export const ledger = (runner, address = pointsDeployment()?.address) => {
  if (!address) throw new Error("积分账本还没部署，先 npm run points -- deploy");
  return new ethers.Contract(address, pointsArtifact().abi, runner);
};

// 按规则发 / 扣积分。evidence：对应行为的指纹（如 ActionRegistry 记录的 content）
export async function apply(contract, openalexId, rule, evidence = ethers.ZeroHash) {
  const r = RULES[rule];
  if (!r) throw new Error(`未知规则 ${rule}，可选 ${Object.keys(RULES).join(" / ")}`);
  const fn = r.kind === "award" ? "award" : "spend";
  const tx = await contract[fn](subjectOf(openalexId), r.amount, reasonOf(rule), evidence);
  const rc = await tx.wait();
  return { rule, kind: r.kind, amount: r.amount, label: r.label, tx: tx.hash, block: rc.blockNumber, txUrl: EXPLORER ? `${EXPLORER}/tx/${tx.hash}` : null };
}

export async function balance(contract, openalexId) {
  return Number(await contract.balanceOf(subjectOf(openalexId)));
}

// 某人的积分流水（从事件读）
export async function history(contract, openalexId, fromBlock = 0) {
  const s = subjectOf(openalexId);
  const [a, b] = await Promise.all([
    contract.queryFilter(contract.filters.Awarded(s), fromBlock),
    contract.queryFilter(contract.filters.Spent(s), fromBlock),
  ]);
  return [...a.map((e) => ({ e, sign: 1 })), ...b.map((e) => ({ e, sign: -1 }))]
    .sort((x, y) => x.e.blockNumber - y.e.blockNumber || x.e.index - y.e.index)
    .map(({ e, sign }) => ({ change: sign * Number(e.args.amount), rule: ethers.decodeBytes32String(e.args.reason), balance: Number(e.args.balance), tx: e.transactionHash, block: e.blockNumber }));
}

export { RPC };
