// 部署到 BOT Chain 主网。私钥只从环境变量读：BOT_PRIVATE_KEY=0x... npm run deploy
import { ethers } from "ethers";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { artifact, RPC, CHAIN_ID, DEPLOYMENT, deployment, NETWORK, EXPLORER } from "./config.mjs";

if (!process.env.BOT_PRIVATE_KEY) throw new Error("缺少环境变量 BOT_PRIVATE_KEY");
if (deployment() && !process.argv.includes("--force")) throw new Error(`已部署在 ${deployment().address}，重新部署请加 --force`);

const provider = new ethers.JsonRpcProvider(RPC);
const { chainId } = await provider.getNetwork();
if (chainId !== CHAIN_ID) throw new Error(`连到的网络不对：期望 ${CHAIN_ID}，实际 ${chainId}`);
const wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
const balance = await provider.getBalance(wallet.address);
console.log(`部署地址 ${wallet.address}，余额 ${ethers.formatEther(balance)} BOT`);

const { abi, bytecode, compiler, evmVersion } = artifact();
const contract = await new ethers.ContractFactory(abi, bytecode, wallet).deploy();
const tx = contract.deploymentTransaction();
console.log(`部署交易 ${tx.hash}，等待确认…`);
const receipt = await tx.wait();
const address = await contract.getAddress();
const info = { network: `BOT Chain ${NETWORK}`, chainId: Number(chainId), address, explorer: `${EXPLORER}/address/${address}`, deployTxUrl: `${EXPLORER}/tx/${tx.hash}`,
  deployTx: tx.hash, block: receipt.blockNumber, deployer: wallet.address, compiler, evmVersion, deployedAt: new Date().toISOString() };
if (!existsSync(new URL("./deployments/", import.meta.url))) mkdirSync(new URL("./deployments/", import.meta.url));
writeFileSync(DEPLOYMENT, JSON.stringify(info, null, 2));
console.log(info);
