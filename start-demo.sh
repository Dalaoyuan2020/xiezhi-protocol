#!/bin/zsh
# 灋廌覈鑒 · 一键启动演示（Mac mini）：实时 Agent + 本人认领 + 盖章上链
# 用法：./start-demo.sh                    （默认本地模拟链：不花钱、秒确认，重启即清空）
#      NETWORK=mainnet ./start-demo.sh    （BOT Chain 主网，真实交易，花 Gas）
#      NETWORK=testnet ./start-demo.sh
cd "$(dirname "$0")/aia/chain"
source ~/Documents/Claude_Mini_agent/_digital_assets/api_keys.env   # BOT_PRIVATE_KEY、OPENALEX_API_KEY
export BOT_PRIVATE_KEY OPENALEX_API_KEY
export NETWORK=${NETWORK:-local} AIA_AGENT_ANCHOR_ENABLED=1
# 本地模拟链：启动 ganache 并部署两份合约
# 本地模式只用公开的开发测试私钥（local-chain.mjs 里的 DEV_KEY），主网私钥不进这个进程
if [ "$NETWORK" = local ]; then
  ./local-chain.sh || exit 1
  export BOT_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
fi
export XIEZHI_DEMO_CODES=1   # 邮件服务未接：验证码直接显示在页面上（演示模式，页面有标注）
[ -z "$OPENALEX_API_KEY" ] && echo "⚠ 没有 OPENALEX_API_KEY：每天只有 1000 点额度，大约够 7 次完整核验"
pkill -f "agent-server.mjs" 2>/dev/null; sleep 1
nohup node agent-server.mjs > /tmp/xiezhi-agent.log 2>&1 &
sleep 2; curl -s http://127.0.0.1:8892/api/health; echo
[ -z "$NO_OPEN" ] && open "http://127.0.0.1:8892/live/"
echo "日志：tail -f /tmp/xiezhi-agent.log"
