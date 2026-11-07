#!/bin/sh
# 跑全部测试；任何一套失败就返回 1。
#
# 为什么用 shell 而不是 node 脚本去 spawn：
#   node 的 spawnSync 会在某些受限环境里让子进程拿不到临时目录写权限（EPERM mkdir），
#   而 hook 由 git 用 sh 调起、直接 fork/exec 就没这个问题。
#
# 为什么优先用 DSH 的 exe：
#   插件实际跑在 Electron 的 node 里（例如 zstd 逐帧解压的行为与系统 node 不同），
#   所以测试也该在那个运行时里跑。可用 DSH_BIN 覆盖。

cd "$(dirname "$0")/.." || exit 1

if [ -n "$DSH_BIN" ] && [ -x "$DSH_BIN" ]; then
  RUNNER="$DSH_BIN"
elif [ -x "D:/杂物/工具/DSH/DeepSeek Harness.exe" ]; then
  RUNNER="D:/杂物/工具/DSH/DeepSeek Harness.exe"
elif [ -x "C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe" ]; then
  RUNNER="C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe"
else
  RUNNER="node"
fi

export ELECTRON_RUN_AS_NODE=1
echo "runner: $RUNNER"

failed=""
total=0
for file in test-*.mjs; do
  case "$file" in
    test-fixtures.mjs) continue ;;
  esac
  total=$((total + 1))
  start=$(date +%s)
  out=$("$RUNNER" "$file" 2>&1)
  status=$?
  end=$(date +%s)
  ms=$(( (end - start) * 1000 ))
  if [ $status -eq 0 ]; then
    printf 'PASS  %-26s %ss\n' "$file" "$(( (end - start) ))"
  else
    printf 'FAIL  %-26s %ss\n' "$file" "$(( (end - start) ))"
    echo "$out" | grep -E "FAIL|Error|失败" | head -4 | sed 's/^/    /'
    failed="$failed $file"
  fi
done

echo ""
if [ -n "$failed" ]; then
  echo "没通过的：$failed"
  exit 1
fi
echo "全部 $total 套通过"
