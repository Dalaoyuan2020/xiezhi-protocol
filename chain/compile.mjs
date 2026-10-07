import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const source = readFileSync(new URL("./contracts/ActionRegistry.sol", import.meta.url), "utf8");
const input = {
  language: "Solidity",
  sources: { "ActionRegistry.sol": { content: source } },
  // paris：不产生 PUSH0，兼容尚未支持上海升级的 EVM 链
  settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}
const c = out.contracts["ActionRegistry.sol"].ActionRegistry;
mkdirSync(new URL("./artifacts/", import.meta.url), { recursive: true });
writeFileSync(new URL("./artifacts/ActionRegistry.json", import.meta.url),
  JSON.stringify({ compiler: solc.version(), evmVersion: "paris", abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2));
console.log(`compiled with solc ${solc.version()}, bytecode ${c.evm.bytecode.object.length / 2} bytes`);
