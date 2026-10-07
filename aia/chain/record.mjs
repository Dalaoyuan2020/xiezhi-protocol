// 登记一个学术行为：BOT_PRIVATE_KEY=0x... npm run record -- <行为> <OpenAlex作者ID> <文件路径或文本> [机构名]
// 例：npm run record -- SUBMIT A0000000001 ./manuscript.pdf 期刊甲
// 行为：SUBMIT / CLOSE / REVIEW / REPRODUCE / CLAIM（评分用 npm run score）
// 结案：npm run record -- CLOSE A0000000001 ./manuscript.pdf 期刊甲 REJECTED（原因 REJECTED / WITHDRAWN / ACCEPTED）
import { ethers } from "ethers";
import { readFileSync, existsSync } from "node:fs";
import { artifact, RPC, deployment } from "./config.mjs";
import { subjectOf, kindOf, orgOf, contentOfBytes, CLOSE_REASONS } from "./lib.mjs";

const [kind, id, source, org, reason] = process.argv.slice(2);
if (!kind || !id || !source) throw new Error("用法：npm run record -- <行为> <作者ID> <文件或文本> [机构名]");
if (kind === "SCORE") throw new Error("评分请用 npm run score");
const bytes = existsSync(source) ? readFileSync(source) : ethers.toUtf8Bytes(source);
if (kind === "CLOSE" && !CLOSE_REASONS.includes(reason)) throw new Error(`结案要写原因：${CLOSE_REASONS.join(" / ")}`);
const args = [subjectOf(id), kindOf(kind), contentOfBytes(bytes), orgOf(org), kind === "CLOSE" ? ethers.encodeBytes32String(reason) : ethers.ZeroHash, 0];
console.log(`${kind} ${id} 指纹 ${args[2]}${org ? ` 机构 ${org}` : ""}`);
if (!process.env.BOT_PRIVATE_KEY) { console.log("[模拟] 未设置 BOT_PRIVATE_KEY，不上链"); process.exit(0); }
const dep = deployment();
if (!dep) throw new Error("还没部署，先 npm run deploy");
const wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, new ethers.JsonRpcProvider(RPC));
const tx = await new ethers.Contract(dep.address, artifact().abi, wallet).record(...args);
const rc = await tx.wait();
console.log(`[上链] tx ${tx.hash}（区块 ${rc.blockNumber}）`);
