// 在本地模拟链上把演示流程完整跑一遍：seed → 红灯 → close → 变绿 → claim
import ganache from "ganache";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { artifact } from "./config.mjs";
import { decodeAction, openSubmissions, subjectOf } from "./lib.mjs";
import { seed, closeAtJournalA, claimZhiyuan, ZHIYUAN } from "./demo.mjs";

const key = "0x" + "11".repeat(32);
const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: "merge" }, wallet: { accounts: [{ secretKey: key, balance: "0x" + (10n ** 21n).toString(16) }] } }));
const platform = new ethers.Wallet(key, provider);
const { abi, bytecode } = artifact();
const reg = await new ethers.ContractFactory(abi, bytecode, platform).deploy();
await reg.waitForDeployment();
const cards = [{ openalex: ZHIYUAN, name: "Zhiyuan Lv", score: 70, confidence: "低", dims: {} }];
const out = await seed({ platform, reg, cards });
const trusted = out.journals.map((j) => j.address);
const view = async () => openSubmissions((await reg.actionsByContent(out.manuscript)).map(decodeAction), trusted);
assert.equal((await view()).duplicate, true, "seed 后应亮红灯");
await closeAtJournalA(platform, reg);
assert.equal((await view()).duplicate, false, "期刊甲结案后应变绿");
await claimZhiyuan(platform, reg);
const kinds = (await reg.actionsOf(subjectOf(ZHIYUAN))).map(decodeAction).map((a) => a.kind);
assert.deepEqual(kinds, ["SCORE", "CLAIM"]);
console.log(`演示流程本地通过：评分 → 两刊登记（红灯）→ 期刊甲结案（变绿）→ 致远认领；共 ${out.log.length + 2} 笔交易`);
process.exit(0);
