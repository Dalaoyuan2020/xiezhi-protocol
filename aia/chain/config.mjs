import { readFileSync, existsSync } from "node:fs";

// NETWORK=testnet 走 BOT Chain 测试网（Chain ID 968），默认主网（Chain ID 677，原生代币 BOT）
const NETWORKS = {
  mainnet: { rpc: "https://rpc.botchain.ai", chainId: 677n, explorer: "https://scan.botchain.ai", suffix: "" },
  testnet: { rpc: "https://rpc.bohr.life", chainId: 968n, explorer: "https://scan.bohr.life", suffix: "-testnet" },
  // 本地模拟链（ganache，./local-chain.sh 启动）：演示「模拟上链」用，不花钱、秒确认，重启即清空
  local: { rpc: "http://127.0.0.1:8545", chainId: 1337n, explorer: "", suffix: "-local" },
};
export const NETWORK = process.env.NETWORK || "mainnet";
const net = NETWORKS[NETWORK];
if (!net) throw new Error(`未知网络 ${NETWORK}，可选 mainnet / testnet`);

export const RPC = process.env.BOT_RPC || net.rpc;
export const CHAIN_ID = net.chainId;
export const EXPLORER = net.explorer;
export const SUFFIX = net.suffix;
export const DEPLOYMENT = new URL(`./deployments/botchain${net.suffix}.json`, import.meta.url);
export const JOURNALS_FILE = new URL(`./deployments/journals${net.suffix}.json`, import.meta.url);
export const ARTIFACT = new URL("./artifacts/ActionRegistry.json", import.meta.url);

export const artifact = () => JSON.parse(readFileSync(ARTIFACT, "utf8"));
export const deployment = () => (existsSync(DEPLOYMENT) ? JSON.parse(readFileSync(DEPLOYMENT, "utf8")) : null);
