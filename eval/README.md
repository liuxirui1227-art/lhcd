# 评测 harness · 说明

本目录是数字人的评测框架：人格探针集、情感评分实验、情绪与检索基线、计价备忘。
标注「需要 API key」的脚本会产生真实调用费用，**不随回归门槛运行**；零成本部分会自动跑。

## 内容一览

| 文件 | 说明 |
|---|---|
| `probes.json` | 50 条固定人格探针，5 维度 × 10 条：温暖共情(W) / 好奇心(C) / 幽默(H) / 主见与边界(A) / 风格一致性(S)。定稿即锁定，只能追加新版本，不得改原条目语义 |
| `constitution-v0(.2).json` | 人格宪法（实验用中性设定：温暖 0.7 / 真诚 / 短句） |
| `exemplars-v0(.2).json` | 范例回复（exemplar），与宪法一起注入 system 层 |
| `run-eval.mjs` | 双盲情感评分：裸模型 vs 宪法注入各生成一轮 → 打乱匿名 → LLM 评审员按 5 维打分。用法：`DEEPSEEK_API_KEY=sk-xxx node run-eval.mjs` |
| `run-eval-phase2.mjs` / `run-drift-check.mjs` | 阶段对比与漂移监测（跨模型一致性） |
| `emotion-corpus.jsonl` + `emotion-eval.mjs` | 情绪识别语料与门槛（macro-F1 ≥ 0.8）——零成本 |
| `retrieval-test.mjs` | 检索基线（≥ 80%）——零成本 |
| `local-bench.sh` | 本机小模型实测（llama.cpp 路线，端侧可行性） |
| `pricing-notes.md` | 第三方模型计价备忘（计费口径 + 成本测算方法） |

## 评分与达标线

LLM 评审员按 5 维打分（1~5）：情感温度 / 风格一致 / 边界尊重 / 人味 / 有用性。
达标线：情感温度 ≥ 3.8 且 风格一致 ≥ 3.8——用于验证「宪法 + 范例注入」相对裸模型确有提升。

## 跑法

- 零成本（不需要 key）：`node emotion-eval.mjs`、`node retrieval-test.mjs`
- 需要 key（产生费用）：`DEEPSEEK_API_KEY=sk-xxx node run-eval.mjs`（模型/端点可用
  `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` 覆盖；也可复制 `.env.example` 为 `.env`）
