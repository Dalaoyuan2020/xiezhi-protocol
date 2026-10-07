// 积分账本本地自检：发放、扣除、余额不足拒绝、非发放方拒绝、没有转账功能、档位规则、流水读取
import ganache from "ganache";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { pointsArtifact, apply, balance, history, tierOf, RULES } from "./points.mjs";

const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: "merge" } }));
const [platform, stranger] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
const { abi, bytecode } = pointsArtifact();
const c = await new ethers.ContractFactory(abi, bytecode, platform).deploy();
await c.waitForDeployment();
const revertsWith = (reason) => (e) => JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v)).includes(reason);
const ME = "A5126602136";

// 新人保护 + 认领错挂 → 25 分
await apply(c, ME, "NEWCOMER");
await apply(c, ME, "CLAIM_FIX");
assert.equal(await balance(c, ME), RULES.NEWCOMER.amount + RULES.CLAIM_FIX.amount);

// 低分投稿扣 10 → 15
await apply(c, ME, "SUBMIT_LOW");
assert.equal(await balance(c, ME), 15);

// 余额不足：再扣两次，第二次被拒
await apply(c, ME, "SUBMIT_LOW");
// 失败的交易在 ganache 里会被打包但回滚，ethers 拿不到原因字符串；用 staticCall 拿原因，再确认余额没变
await assert.rejects(c.spend.staticCall((await import("./lib.mjs")).subjectOf(ME), 10, ethers.ZeroHash, ethers.ZeroHash), revertsWith("insufficient points"));
await assert.rejects(apply(c, ME, "SUBMIT_LOW"));
assert.equal(await balance(c, ME), 5);

// 只有发放方能发积分
await assert.rejects(c.connect(stranger).award.staticCall(ethers.id("x"), 1, ethers.ZeroHash, ethers.ZeroHash), revertsWith("not issuer"));

// 没有任何转账 / 授权函数：积分不能买卖
const fns = c.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
for (const banned of ["transfer", "transferFrom", "approve"]) assert.ok(!fns.includes(banned), `不应存在 ${banned}`);

// 档位
assert.equal(tierOf(70).id, "MID");
assert.equal(tierOf(83).id, "HIGH");
assert.equal(tierOf(21).id, "LOW");
assert.equal(tierOf(59.9).id, "LOW");

// 流水
const h = await history(c, ME);
assert.deepEqual(h.map((x) => x.change), [20, 5, -10, -10]);
assert.deepEqual(h.map((x) => x.balance), [20, 25, 15, 5]);
console.log(`积分账本本地自检通过：发放 / 扣除 / 余额不足拒绝 / 非发放方拒绝 / 无转账函数 / 档位 / 流水（合约函数：${fns.join(", ")}）`);
process.exit(0);
