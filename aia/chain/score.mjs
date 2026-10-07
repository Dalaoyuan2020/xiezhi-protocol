// 给学者打分并写上链：BOT_PRIVATE_KEY=0x... npm run score -- A5126602136 [更多ID]
// 不带私钥时只打分、算哈希、模拟交易，不上链（--dry-run 效果相同）
import { ethers } from "ethers";
import { writeFileSync, mkdirSync } from "node:fs";
import { artifact, RPC, deployment } from "./config.mjs";
import { runCheckup, toChainArgs } from "./lib.mjs";

const RULE = process.env.RULE_VERSION || "checkup-v0";
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dry = process.argv.includes("--dry-run") || !process.env.BOT_PRIVATE_KEY;
if (!ids.length) throw new Error("用法：npm run score -- <OpenAlex作者ID> ...");
const dep = deployment();
if (!dry && !dep) throw new Error("还没部署，先 npm run deploy");

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = dry ? null : new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
const reg = dep ? new ethers.Contract(dep.address, artifact().abi, wallet ?? provider) : null;
mkdirSync(new URL("./receipts/", import.meta.url), { recursive: true });

for (const id of ids) {
  const card = runCheckup(id);
  const args = toChainArgs(card, RULE);
  const receipt = { openalex: id, name: card.name, score: card.score, confidence: card.confidence, rule: RULE,
    subject: args[0], snapshot: args[2], card };
  if (dry) {
    console.log(`[模拟] ${card.name} ${card.score} 分 → subject ${args[0]}`);
  } else {
    const tx = await reg.submitScore(...args);
    const rc = await tx.wait();
    Object.assign(receipt, { contract: dep.address, tx: tx.hash, block: rc.blockNumber, chainId: dep.chainId });
    console.log(`[上链] ${card.name} ${card.score} 分 → tx ${tx.hash}（区块 ${rc.blockNumber}）`);
  }
  // 收据连同完整体检卡存档：任何人可用 card 复算 snapshot 哈希，核对链上记录
  writeFileSync(new URL(`./receipts/${id}-${Date.now()}.json`, import.meta.url), JSON.stringify(receipt, null, 2));
}
