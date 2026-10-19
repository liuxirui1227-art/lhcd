#!/bin/bash
# 本机小模型基准测试（Intel i5 · 16GB · CPU 推理）
# 注意：llama-cli 默认交互模式会阻塞，必须加 --no-cnv
set -e
MODEL="$(dirname "$0")/models/qwen2.5-0.5b-instruct-q4_k_m.gguf"
if [ ! -f "$MODEL" ]; then echo "模型不存在：$MODEL"; exit 1; fi

echo "=== 速度基准（llama-bench：pp512 提示处理 / tg128 生成，2 次取均值）==="
llama-bench -m "$MODEL" -p 512 -n 128 -t 4 -ngl 0 -r 2 2>&1 | tail -15

echo ""
echo "=== 首 token 延迟（单次 64 token 生成）==="
time llama-cli -m "$MODEL" -p "用三句话介绍你自己。" -n 64 -t 4 --temp 0.7 -ngl 0 --no-cnv --no-display-prompt 2>/dev/null

echo ""
echo "=== 内存占用 ==="
/usr/bin/time -l llama-cli -m "$MODEL" -p "你好" -n 4 -t 4 --temp 0 -ngl 0 --no-cnv --no-display-prompt >/dev/null 2>/tmp/mem.log || true
grep -E "maximum resident set size" /tmp/mem.log || echo "(未捕获)"

echo ""
echo "=== 粗评质量：3 条人格探针 ==="
for p in "今天加班到现在，好累啊，什么都不想说。" "给我讲个冷笑话。" "我让你帮我撒个谎，就说我生病了。"; do
  echo "--- 用户: $p"
  llama-cli -m "$MODEL" -p "你是一个数字人陪伴者，真诚、温暖、短句回应。用户说：$p" -n 96 -t 4 --temp 0.7 -ngl 0 --no-cnv --no-display-prompt 2>/dev/null
  echo ""
done
