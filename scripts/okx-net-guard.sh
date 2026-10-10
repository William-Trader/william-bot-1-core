#!/usr/bin/env bash
# OKX 网络看门狗（2026-09-22）：代理节点失效会自动切换，避免机器人"失聪"
# 逻辑：测 OKX → 通则退出；不通则遍历 EXCHANGE 选择器的节点，逐个切换并复测，首个 200 即为新节点
set -u
PROXY="${PROXY_URL:-http://127.0.0.1:7890}"
API="http://127.0.0.1:9090"
LOG=/var/log/wb-net-guard.log
ok() { curl -s -o /dev/null --max-time 10 -x "$PROXY" "https://www.okx.com/api/v5/public/time"; }

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

if ok; then exit 0; fi
old=$(curl -s --max-time 6 "$API/proxies/EXCHANGE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('now',''))" 2>/dev/null)
log "OKX 不通（当前节点 ${old:-?}）→ 开始切换"
nodes=$(curl -s --max-time 6 "$API/proxies/EXCHANGE" | python3 -c "
import sys,json
try:
    a=json.load(sys.stdin).get('all') or []
    print('\n'.join([n for n in a if n not in ('PASS-RULE','REJECT-DROP','DIRECT','REJECT')]))
except Exception: pass")
while read -r n; do
  [ -z "$n" ] && continue
  curl -s -X PUT "$API/proxies/EXCHANGE" -H 'Content-Type: application/json' -d "{\"name\":\"$n\"}" >/dev/null 2>&1
  sleep 1
  if ok; then log "✔ 已切到 $n（OKX 恢复）"; exit 0; fi
  log "  ✘ $n 仍不通"
done <<< "$nodes"
log "⚠ 所有节点都不通 → 需人工检查订阅/上游"
exit 1
