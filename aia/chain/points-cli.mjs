// 积分命令行：
//   NETWORK=testnet BOT_PRIVATE_KEY=0x... npm run points -- deploy
//   NETWORK=testnet BOT_PRIVATE_KEY=0x... npm run points -- apply <作者ID> <规则>     规则见 points.mjs 的 RULES
//   NETWORK=testnet npm run points -- show <作者ID>                                 余额、档位与流水（只读）
//   NETWORK=testnet BOT_PRIVATE_KEY=0x... npm run points -- demo                     演示数据：致远新手保护 + 认领错挂
import { ethers } from "ethers";
import { RPC, deployPoints, ledger, apply, balance, history, pointsDeployment, tierOf, RULES } from "./points.mjs";

const [cmd, id, rule] = process.argv.slice(2);
const provider = new ethers.JsonRpcProvider(RPC);
const signer = () => {
  if (!process.env.BOT_PRIVATE_KEY) throw new Error("缺少环境变量 BOT_PRIVATE_KEY");
  return new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
};

if (cmd === "deploy") {
  if (pointsDeployment() && !process.argv.includes("--force")) throw new Error(`已部署在 ${pointsDeployment().address}，重新部署请加 --force`);
  console.log(await deployPoints(signer()));
} else if (cmd === "apply") {
  console.log(await apply(ledger(signer()), id, rule));
} else if (cmd === "show") {
  const c = ledger(provider);
  const score = Number(process.argv[4] ?? NaN);
  console.log(JSON.stringify({ id, points: await balance(c, id), tier: Number.isFinite(score) ? tierOf(score) : undefined,
    history: await history(c, id, pointsDeployment().block) }, null, 2));
} else if (cmd === "demo") {
  const c = ledger(signer());
  for (const r of ["NEWCOMER", "CLAIM_FIX"]) console.log(await apply(c, "A5126602136", r));
  console.log("致远积分：", await balance(c, "A5126602136"));
} else {
  console.log(`用法：deploy | apply <作者ID> <规则> | show <作者ID> [可核查度] | demo\n规则：${Object.keys(RULES).join(" / ")}`);
}
