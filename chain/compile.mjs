import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// 编译 contracts/ 下的全部合约，每个合约写一份 artifacts/<名字>.json
const NAMES = ["ActionRegistry", "PointsLedger"];
const sources = Object.fromEntries(NAMES.map((n) => [`${n}.sol`, { content: readFileSync(new URL(`./contracts/${n}.sol`, import.meta.url), "utf8") }]));
const input = {
  language: "Solidity",
  sources,
  // paris：不产生 PUSH0，兼容尚未支持上海升级的 EVM 链
  settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}
mkdirSync(new URL("./artifacts/", import.meta.url), { recursive: true });
for (const n of NAMES) {
  const c = out.contracts[`${n}.sol`][n];
  writeFileSync(new URL(`./artifacts/${n}.json`, import.meta.url),
    JSON.stringify({ compiler: solc.version(), evmVersion: "paris", abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2));
  console.log(`${n}: solc ${solc.version()}, bytecode ${c.evm.bytecode.object.length / 2} bytes`);
}
