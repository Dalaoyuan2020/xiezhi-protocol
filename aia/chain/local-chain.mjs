// 本地模拟链：启动 ganache（Chain ID 1337，端口 8545）并部署 ActionRegistry + PointsLedger
// 用法：node local-chain.mjs        （Mac / Windows 通用；进程常驻，Ctrl+C 结束，重启即清空）
// 只用公开的开发测试私钥（Hardhat 0 号账户），绝不碰主网私钥；合约与主网是同一份代码
import ganache from "ganache";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

export const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const port = Number(process.env.LOCAL_CHAIN_PORT || 8545);
const server = ganache.server({
  chain: { chainId: 1337 }, logging: { quiet: true },
  wallet: { accounts: [{ secretKey: DEV_KEY, balance: "0x3635C9ADC5DEA00000" }] },
});
await server.listen(port, "127.0.0.1");
for (const f of ["botchain-local.json", "points-local.json"]) rmSync(new URL(`./deployments/${f}`, import.meta.url), { force: true });
const env = { ...process.env, NETWORK: "local", BOT_PRIVATE_KEY: DEV_KEY };
const here = new URL(".", import.meta.url);
// 部署脚本跑在子进程里（ganache 在本进程，不能同步阻塞事件循环）
const run = (args) => new Promise((ok, bad) => spawn(process.execPath, args, { cwd: here, env, stdio: "inherit" })
  .on("exit", (c) => (c ? bad(new Error(`${args.join(" ")} 退出码 ${c}`)) : ok())));
await run(["deploy.mjs"]);
// 积分账本部署失败（例如积分规则文件缺失）不挡演示：认领、上链照常，只是不发积分
await run(["points-cli.mjs", "deploy"]).catch((e) => console.log(`⚠ 积分账本未部署：${e.message}（认领与上链不受影响）`));
console.log(`本地模拟链已就绪：http://127.0.0.1:${port}（Chain ID 1337）`);
