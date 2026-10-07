// 本地 EVM 全流程自检 + 对 BOT Chain 主网估算部署 gas（不花钱、不需要私钥）
import ganache from "ganache";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { artifact, RPC } from "./config.mjs";
import { subjectOf, ruleOf, snapshotOf, toChainArgs, kindOf, orgOf, decodeAction, openSubmissions } from "./lib.mjs";

const { abi, bytecode } = artifact();
const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: "merge" } }));
const [platform, journalA, journalB, me] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
const reg = await new ethers.ContractFactory(abi, bytecode, platform).deploy();
await reg.waitForDeployment();
const revertsWith = (reason) => (e) => JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v)).includes(reason);
const Z = ethers.ZeroHash;

// 1. 评分：平台给致远打 70 分
const zhiyuan = subjectOf("A5126602136");
const card = { openalex: "A5126602136", score: 70, confidence: "低", dims: { a: 1 } };
await (await reg.submitScore(...toChainArgs(card, "checkup-v0"))).wait();

// 2. 一稿多投：同一稿件指纹先后出现在两家期刊
const manuscript = ethers.keccak256(ethers.toUtf8Bytes("同一份稿件的字节"));
const author = subjectOf("A0000000001");
await (await reg.connect(journalA).record(author, kindOf("SUBMIT"), manuscript, orgOf("期刊甲"), Z, 0)).wait();
await (await reg.connect(journalB).record(author, kindOf("SUBMIT"), manuscript, orgOf("期刊乙"), Z, 0)).wait();
const journals = [await journalA.getAddress(), await journalB.getAddress()];
const view = async () => openSubmissions((await reg.actionsByContent(manuscript)).map(decodeAction), journals);
assert.equal((await view()).duplicate, true, "两家同时在审 → 疑似一稿多投");

// 2b. 作者自己伪造一行「结案」：不在期刊名单里，不算
await (await reg.connect(me).record(author, kindOf("CLOSE"), manuscript, orgOf("期刊甲"), ethers.encodeBytes32String("WITHDRAWN"), 0)).wait();
assert.equal((await view()).duplicate, true, "作者自记的结案不被采信");

// 2c. 期刊甲真的拒稿结案 → 只剩期刊乙在审，属正常改投
await (await reg.connect(journalA).record(author, kindOf("CLOSE"), manuscript, orgOf("期刊甲"), ethers.encodeBytes32String("REJECTED"), 0)).wait();
const after = await view();
assert.equal(after.duplicate, false, "拒稿后改投不报警");
assert.equal(after.open.length, 1);

// 3. 本人认领 + 复现，进入个人时间线
await (await reg.connect(me).record(zhiyuan, kindOf("CLAIM"), ethers.id("orcid:0009-0008-5473-5367"), Z, Z, 0)).wait();
await (await reg.connect(me).record(zhiyuan, kindOf("REPRODUCE"), ethers.id("复现日志"), orgOf("学术体检"), Z, 0)).wait();
const timeline = (await reg.actionsOf(zhiyuan)).map(decodeAction);
assert.deepEqual(timeline.map((a) => a.kind), ["SCORE", "CLAIM", "REPRODUCE"]);
assert.equal(timeline[0].value, 70);
assert.equal(timeline[0].rule, "checkup-v0");
assert.equal(timeline[0].content, snapshotOf(card));
assert.equal(timeline[1].recorder, await me.getAddress());
assert.equal(snapshotOf({ b: 1, a: 2 }), snapshotOf({ a: 2, b: 1 }), "快照哈希与键顺序无关");

// 4. 越界与非法输入
await assert.rejects(reg.submitScore(zhiyuan, 101, Z, ruleOf("v")), revertsWith("score>100"));
await assert.rejects(reg.record(zhiyuan, ethers.encodeBytes32String("LIKE"), Z, Z, Z, 0), revertsWith("unknown kind"));
await assert.rejects(reg.record(zhiyuan, kindOf("REVIEW"), Z, Z, Z, 5), revertsWith("value only for SCORE"));
assert.equal(Number(await reg.count()), 7);
console.log("本地 EVM：评分、一稿多投识别、作者伪造结案不被采信、拒稿结案后改投不报警、个人时间线、非法输入拒绝 全部通过");

// 主网只读估算：确认字节码（paris，无 PUSH0）能被 BOT Chain 接受
const main = new ethers.JsonRpcProvider(RPC);
const net = await main.getNetwork();
assert.equal(net.chainId, 677n);
const gas = await main.estimateGas({ data: bytecode });
const price = (await main.getFeeData()).gasPrice;
console.log(`BOT Chain 主网：chainId ${net.chainId}，部署估算 gas ${gas}，gasPrice ${price} wei，预计费用 ${ethers.formatEther(gas * (price ?? 0n))} BOT`);
process.exit(0);
