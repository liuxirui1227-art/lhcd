# @lhcd/brain · 智能体大脑

灵核（LHCD）数字人的通用智能体大脑：核心循环 / 工具 / 权限 / 记忆 / 提示词分区全部自持。
零运行时依赖；核心逻辑禁止直接使用 Node 内置模块（架构红线），平台能力只经 `src/runtime/` 接口。

## 命令

- `npm run build` —— tsc 编译到 `dist/`
- `npm test` —— 编译 + `node --test` 全绿
- `npm run agent` —— CLI 入口（`dist/bin/agent.js`）：
  - `agent -p "…"` 单次执行
  - `agent --mode json -p …` 事件协议逐行 JSON 直出 stdout
  - `agent --resume <id> -p …` 续接会话
  - `agent replay [id]` 会话事件回放（排障：轮次 / 工具 / 压缩 / 审批 / 缺口）
  - `agent eval --mock` 黄金用例评测（零成本）

## 架构红线

- Provider 专属逻辑只在 `src/llm/adapters/`
- 平台能力只经 `src/runtime/` 接口
- 提示词组装只在 `src/prompt/assemble.ts`
- 事件发射只经 `src/session/events.ts`
- 记忆写入只经 `src/memory/`

模块地图与核心循环说明见仓库根 `README.md` 的「项目架构」一节。
