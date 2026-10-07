// 黑客松演示数据：npm run demo -- <seed|close|claim>，需 BOT_PRIVATE_KEY（部署 / 平台钱包）
//   seed  ：给两家演示期刊建钱包并转少量 BOT；平台给 3 个真实案例评分上链；
//           期刊甲、期刊乙先后登记同一份演示稿件（→ 疑似一稿多投）；写出 deployments/journals.json
//   close ：现场演示用——期刊甲登记「拒稿结案」（→ 红灯变绿）
//   claim ：现场演示用——致远认领档案（ORCID 指纹上链）
// 演示期刊的私钥由平台私钥派生，不落盘；换了平台私钥，期刊地址也会变。
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { artifact, RPC, CHAIN_ID, deployment, JOURNALS_FILE } from "./config.mjs";
import { subjectOf, kindOf, orgOf, contentOfBytes, toChainArgs, runCheckup } from "./lib.mjs";

export const JOURNALS = [
  { key: "journalA", name: "演示期刊甲" },
  { key: "journalB", name: "演示期刊乙" },
];
export const CASES = ["A5126602136", "A5009290031", "A5100700361"];
export const DEMO_AUTHOR = "DEMO-MULTI";
export const ZHIYUAN = "A5126602136";
const manuscript = () => contentOfBytes(readFileSync(new URL("./demo/manuscript.txt", import.meta.url)));
export const journalWallet = (platformKey, key, provider) => new ethers.Wallet(ethers.id(`${platformKey}:${key}`), provider);

async function send(contract, signer, method, args, label) {
  const tx = await contract.connect(signer)[method](...args);
  const rc = await tx.wait();
  console.log(`[上链] ${label} → tx ${tx.hash}（区块 ${rc.blockNumber}）`);
  return { label, tx: tx.hash, block: rc.blockNumber };
}

export async function seed({ platform, reg, cards, fund = ethers.parseEther("0.01") }) {
  const log = [];
  const journals = JOURNALS.map((j) => ({ ...j, wallet: journalWallet(platform.privateKey, j.key, platform.provider) }));
  for (const j of journals) {
    const bal = await platform.provider.getBalance(j.wallet.address);
    if (bal < fund / 2n) {
      const tx = await platform.sendTransaction({ to: j.wallet.address, value: fund });
      await tx.wait();
      console.log(`[转账] ${j.name} ${j.wallet.address} ← ${ethers.formatEther(fund)} BOT`);
    }
  }
  for (const card of cards) log.push(await send(reg, platform, "submitScore", toChainArgs(card, card.rule || "checkup-v0"), `评分 ${card.name} ${card.score}`));
  for (const j of journals)
    log.push(await send(reg, j.wallet, "record", [subjectOf(DEMO_AUTHOR), kindOf("SUBMIT"), manuscript(), orgOf(j.name), ethers.ZeroHash, 0], `${j.name} 登记投稿`));
  return { journals: journals.map(({ key, name, wallet }) => ({ key, name, address: wallet.address, org: orgOf(name) })), manuscript: manuscript(), demoAuthor: DEMO_AUTHOR, log };
}

export const closeAtJournalA = (platform, reg) => {
  const j = journalWallet(platform.privateKey, "journalA", platform.provider);
  return send(reg, j, "record", [subjectOf(DEMO_AUTHOR), kindOf("CLOSE"), manuscript(), orgOf("演示期刊甲"), ethers.encodeBytes32String("REJECTED"), 0], "演示期刊甲 拒稿结案");
};

export const claimZhiyuan = (platform, reg) =>
  send(reg, platform, "record", [subjectOf(ZHIYUAN), kindOf("CLAIM"), ethers.id("orcid:0009-0008-5473-5367"), ethers.ZeroHash, ethers.ZeroHash, 0], "致远认领档案");

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (!process.env.BOT_PRIVATE_KEY) throw new Error("缺少环境变量 BOT_PRIVATE_KEY");
  const dep = deployment();
  if (!dep) throw new Error("还没部署，先 npm run deploy");
  const provider = new ethers.JsonRpcProvider(RPC);
  if ((await provider.getNetwork()).chainId !== CHAIN_ID) throw new Error("网络与 NETWORK 设置不符");
  const platform = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
  const reg = new ethers.Contract(dep.address, artifact().abi, provider);
  if (cmd === "seed") {
    const out = await seed({ platform, reg, cards: CASES.map((id) => runCheckup(id, { rule: "v2" })) });
    writeFileSync(JOURNALS_FILE, JSON.stringify({
      note: "演示用可信期刊名单：机构页只采信这些地址登记的行为", platform: platform.address, ...out }, null, 2));
    console.log(`已写出 ${JOURNALS_FILE.pathname}`);
  } else if (cmd === "close") await closeAtJournalA(platform, reg);
  else if (cmd === "claim") await claimZhiyuan(platform, reg);
  else throw new Error("用法：npm run demo -- seed | close | claim");
}
