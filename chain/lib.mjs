import { ethers } from "ethers";
import { execFileSync } from "node:child_process";

// 学者 ID、规则版本、数据快照 → 链上字段
export const subjectOf = (openalexId) => ethers.keccak256(ethers.toUtf8Bytes(`openalex:${openalexId}`));
export const ruleOf = (version) => ethers.encodeBytes32String(version);
export const KINDS = ["SCORE", "SUBMIT", "CLOSE", "REVIEW", "REPRODUCE", "CLAIM"];
export const CLOSE_REASONS = ["REJECTED", "WITHDRAWN", "ACCEPTED"];

// 同一稿件指纹的记录 → 各机构是否仍在审；两家以上同时在审即疑似一稿多投
// trustedRecorders：公开名单里的期刊地址（小写），名单外的地址所记一律忽略
export function openSubmissions(actions, trustedRecorders) {
  const trusted = new Set(trustedRecorders.map((a) => a.toLowerCase()));
  const open = new Map();
  for (const a of [...actions].sort((x, y) => x.time.localeCompare(y.time))) {
    if (!trusted.has(a.recorder.toLowerCase())) continue;
    if (a.kind === "SUBMIT") open.set(a.org, a);
    if (a.kind === "CLOSE") open.delete(a.org);
  }
  return { open: [...open.values()], duplicate: open.size >= 2 };
}
export const kindOf = (name) => {
  if (!KINDS.includes(name)) throw new Error(`未知行为类型 ${name}，可选 ${KINDS.join(" / ")}`);
  return ethers.encodeBytes32String(name);
};
// 机构名、文件内容都只上指纹
export const orgOf = (name) => (name ? ethers.keccak256(ethers.toUtf8Bytes(`org:${name}`)) : ethers.ZeroHash);
export const contentOfBytes = (bytes) => ethers.keccak256(bytes);

// 稳定排序后的 JSON 才能复算出同一个哈希
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v);
export const snapshotOf = (card) => ethers.keccak256(ethers.toUtf8Bytes(canonical(card)));

// 调 Python 打分脚本拿体检卡
export function runCheckup(openalexId) {
  const out = execFileSync("python3", [new URL("../product/checkup.py", import.meta.url).pathname, openalexId], { encoding: "utf8" });
  return JSON.parse(out);
}

// submitScore(subject, score, snapshot, rule)：置信度等细节都在体检卡快照里
export function toChainArgs(card, ruleVersion) {
  return [subjectOf(card.openalex), card.score, snapshotOf(card), ruleOf(ruleVersion)];
}

// 链上 Action 结构 → 可读 JSON
export const decodeAction = (a) => ({
  kind: ethers.decodeBytes32String(a.kind), subject: a.subject, content: a.content, org: a.org,
  rule: a.rule === ethers.ZeroHash ? null : ethers.decodeBytes32String(a.rule), value: Number(a.value),
  recorder: a.recorder, time: new Date(Number(a.time) * 1000).toISOString(),
});
