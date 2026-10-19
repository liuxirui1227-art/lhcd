#!/bin/sh
# 灵核 · PreToolUse 守卫（随包生产配置的第一条 hook）
#
# 守什么：**用命令行去改保留区**——`.git/hooks/*`（git 会直接执行它）、`.git/config`
#   （`core.hooksPath` 能把钩子指到别处）、以及 `.claude` / `.codex` / `.agents` / `.lhcd`
#   这些"能反过来决定我有多大权限"的目录。
#
# 与内核的分工（**不是两套判断在打架**）：
#   · 内核 `brain/src/policy/engine.ts` 判**结构化落点参数**（write/edit/delete/office/media 的
#     path/file/saveAs/input(s)），判得准 —— 它是唯一真源，命中即硬拒（`reserved-zone`）；
#   · 任意 **shell 文本** 里的同类动作，内核**故意不猜**（判据只有命令字符串，猜错要么放过、
#     要么误伤正功能），这一层补的就是这个空档。钩子**只能加码**：内核放行的它可以拦，
#     内核拒的它一个字也改不了。
#   两边的保留区名单同源，`runtime/hook-guard.test.mjs` 有断言盯着（名单一漂移就红）。
#
# 判据（宁可漏，不可误伤）：① 出现保留区落点 **且** ② 出现"写动作"词 —— 两条同时成立才拦。
#   所以 `ls .git/hooks`、`cat .git/config`、`git config --get core.hooksPath` 这些只读照样放行。
#
# 约定（见 `brain/src/hooks/runner.ts`）：事件 JSON 走 stdin；exit 2 = 阻断（仅 PreToolUse）；exit 0 = 放行。
# ⚠ 本文件由应用每次启动时**重新生成**（`runtime/lib.mjs` 的 ensureHookGuard），手改会被覆盖。
#   想加自己的守卫：另写一个脚本，在配置的 `hooks.PreToolUse` 里追加一条即可（别改这一份）。

payload=$(cat)

# core.hooksPath：看一眼（--get/--list）没问题，**设置它**等于把钩子指到别处 —— 单独判，不带写动作词
if printf '%s' "$payload" | grep -Eq 'core\.hooksPath' \
   && ! printf '%s' "$payload" | grep -Eq -- '--get|--list'; then
  echo "core.hooksPath 能把 git 钩子指到任意脚本上执行，等于给自己发权限：这条我不做（要看当前值用 git config --get core.hooksPath）。"
  exit 2
fi

# ① 保留区落点（JSON 里就是普通文本；按"路径样子"匹配：`.git`/`.claude` 前面不是字母数字——
#    于是 `proj/.git/hooks` 这种嵌在路径中间的也算，而 `.gitignore`、`.claude.md` 不会被误伤）
RESERVED='(^|[^[:alnum:]_-])\.git/hooks([^[:alnum:]_-]|$)|(^|[^[:alnum:]_-])\.git/config([^[:alnum:]_-]|$)|(^|[^[:alnum:]_-])\.(claude|codex|agents|lhcd)/'

# ② 写动作词（含重定向）。没有它就不拦 —— 只读命令放行
#   （解释器一律算"可能写"：`python3 -c "open('.git/config','w')"` 这种没有重定向也没有 cp）
WRITE='(^|[^[:alnum:]_])(rm|mv|cp|install|tee|truncate|dd|ln|chmod|chown|touch|patch|rsync|unlink|sed|awk|(python|node|ruby|perl|php)[0-9.]*)([^[:alnum:]_]|$)|>>|>|--output|-o[[:space:]]'

if printf '%s' "$payload" | grep -Eq "$RESERVED"; then
  if printf '%s' "$payload" | grep -Eq "$WRITE"; then
    echo "这条命令动的是保留区（.git/hooks、.git/config 或 .claude/.codex/.agents/.lhcd 这类配置目录）：它们能反过来决定我有多大权限，所以命令行这一层我不碰——要改请用户自己来。读取不受影响。"
    exit 2
  fi
fi

exit 0
