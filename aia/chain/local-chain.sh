#!/bin/zsh
# 本地模拟链（Mac 包装）：后台启动 node local-chain.mjs，等合约部署完成再返回。不使用主网私钥。
cd "$(dirname "$0")"
pkill -f "local-chain.mjs" 2>/dev/null; pkill -f "ganache.*8545" 2>/dev/null; sleep 1
nohup node local-chain.mjs > /tmp/xiezhi-local-chain.log 2>&1 &
for i in {1..60}; do grep -q "本地模拟链已就绪" /tmp/xiezhi-local-chain.log 2>/dev/null && break; sleep 1; done
cat /tmp/xiezhi-local-chain.log | grep -E "address|地址|就绪|Error|错误" | head -8
grep -q "本地模拟链已就绪" /tmp/xiezhi-local-chain.log
