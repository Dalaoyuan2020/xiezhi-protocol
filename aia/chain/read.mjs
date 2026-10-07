// 读链上记录（只读，不需要私钥）
//   npm run read -- A5126602136            某位学者的行为时间线
//   npm run read -- --content 0x...        同一指纹的全部记录（看是否疑似一稿多投）
import { ethers } from "ethers";
import { artifact, RPC, deployment } from "./config.mjs";
import { subjectOf, decodeAction } from "./lib.mjs";

const dep = deployment();
if (!dep) throw new Error("还没部署");
const reg = new ethers.Contract(dep.address, artifact().abi, new ethers.JsonRpcProvider(RPC));
const i = process.argv.indexOf("--content");
const list = i > 0 ? await reg.actionsByContent(process.argv[i + 1]) : await reg.actionsOf(subjectOf(process.argv[2]));
console.log(JSON.stringify(list.map(decodeAction), null, 2));
