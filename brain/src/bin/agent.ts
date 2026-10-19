#!/usr/bin/env node
// CLI 入口：agent --version / init / config / -p（print）/ --mode json / --resume / eval --mock。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, initConfigFile } from '../config/load.js';
import { createAgent } from '../factory.js';
import { runTurn } from '../loop/turn.js';
import { eventLine, stampEmitter, makeEventIdFactory, coalesceDeltas } from '../session/events.js';
import { replaySession } from '../session/replay.js';
import { SessionStore } from '../session/store.js';
import { consolidateSession } from '../memory/consolidate.js';
import { runEval, type EvalCase } from '../eval/runner.js';

export const AGENT_VERSION = '0.2.10';

const USAGE = [
  'agent —— 灵核初诞 · 智能体大脑 CLI（Agent-Harness v4.0）',
  '',
  '用法:',
  '  agent                    交互 TUI（未落地，2.11 宿主 GUI 承载）',
  '  agent --version          版本号',
  '  agent init [file]        生成 agent.json 默认配置',
  '  agent config             打印合并后的最终配置（不含密钥）',
  '  agent -p "任务"          单次 print 模式：执行任务输出最终文本',
  '  agent --mode json -p …   事件协议逐行 JSON 直出 stdout',
  '  agent --resume <id> -p … 续接会话（重放 messages.jsonl）',
  '  agent replay [id]        会话事件回放（排障：轮次/工具/压缩/审批/缺口）',
].join('\n');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === undefined) {
    console.log(USAGE);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(`agent ${AGENT_VERSION}`);
    return;
  }
  if (cmd === 'init') {
    const file = args[1] ?? path.join(process.cwd(), 'agent.json');
    const { created } = initConfigFile(file);
    console.log(created ? `已生成默认配置: ${file}` : `配置已存在（不动）: ${file}`);
    return;
  }
  if (cmd === 'config') {
    const cfg = loadConfig({ cwd: process.cwd() });
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }
  if (cmd === 'replay') {
    /* 会话事件回放（排障入口）——"她这轮到底做了什么"。
       只读：读 `sessions/<id>/events.jsonl` 重建轮次/工具/压缩/审批/缓存，并把**缺口**如实报出来。 */
    const id = args[1] ?? 'main';
    const { createNodeRuntime } = await import('../runtime/node.js');
    // 会话目录取合并后的配置（与 `agent -p` 同一处口径），别自己猜路径
    const cfg = loadConfig({ cwd: process.cwd() });
    const rt = createNodeRuntime({
      cwd: process.cwd(),
      storage: {
        sessionsDir: cfg.sessions.dir,
        logsDir: cfg.log.dir,
        memoryDir: cfg.memory.autoDir,
        configDir: path.dirname(cfg.sessions.dir),
      },
    });
    const r = await replaySession(rt, id);
    console.log(`会话 ${id}：${r.turns.length} 轮 · ${r.compactions.length} 次压缩 · ${r.approvals.length} 次审批 · 缓存 ${r.cache.calls} 次`);
    if (r.from && r.to) console.log(`时间范围：${r.from} → ${r.to}`);
    for (const t of r.turns) {
      const tools = t.tools.length ? ` · 工具 ${t.tools.map((x) => `${x.name}${x.ok === false ? '✗' : x.ok ? '✓' : '?'}`).join(',')}` : '';
      const tail = t.final === false ? '（未正常收尾）' : t.final ? '' : '（没收尾）';
      console.log(`  第 ${t.seq} 轮${tail} 正文 ${t.textChars} 字${tools}`);
    }
    if (r.gaps.length) {
      console.log(`\n⚠ 缺口 ${r.gaps.length} 处：`);
      for (const g of r.gaps) console.log(`  · ${g}`);
    }
    return;
  }
  if (cmd === 'eval') {
    // 黄金用例（--mock 确定性，零成本，CI 默认）
    const here = path.dirname(fileURLToPath(import.meta.url));
    const casesDir = path.join(here, '..', '..', 'eval', 'cases');
    const files = fs.readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort();
    const cases: EvalCase[] = files.map((f) => JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8')) as EvalCase);
    const report = await runEval(cases);
    for (const r of report.cases) {
      console.log(`${r.passed ? '✅' : '❌'} ${r.id} ${r.name}`);
      for (const f of r.failures) console.log(`     ✗ ${f}`);
    }
    console.log(`\n总计 ${report.total}，通过 ${report.passed}，失败 ${report.failed}`);
    process.exitCode = report.failed > 0 ? 1 : 0;
    return;
  }

  // -p / --mode json / --resume
  const modeJson = args.includes('--mode') && args.includes('json');
  const resumeFlag = args.indexOf('--resume');
  const resumeId = resumeFlag >= 0 ? args[resumeFlag + 1] : undefined;
  const pFlag = args.indexOf('-p');
  const task = pFlag >= 0 ? args[pFlag + 1] : args.join(' ');
  if (!task) {
    console.error('缺少任务文本（-p "任务"）');
    process.exitCode = 1;
    return;
  }

  try {
    const agent = await createAgent({ cwd: process.cwd() });
    const store = new SessionStore(agent.runtime);
    let session = agent.createSession();

    // resume：重放历史 + configHash 校验
    if (resumeId) {
      const loaded = await store.load(resumeId, agent.config);
      if (!loaded) {
        console.error(`会话 ${resumeId} 不存在`);
        process.exitCode = 1;
        return;
      }
      session = agent.createSession({ id: resumeId });
      session.history = loaded.history;
      session.stats = loaded.meta.stats;
      if (loaded.configChanged) {
        console.error('[警告] 配置已变更（configHash 不一致），冻结前缀已按新配置重建');
      }
    }

    /* CLI 也是**落盘点**，信封在这一层盖（与宿主 `lib.mjs` 同一处逻辑）。
       `--mode json` 打出去的就是带信封的那一行（跟文件里逐字节一致）。 */
    {
      const base = session.emit;
      const sink = coalesceDeltas(
        stampEmitter((ev) => {
          base(ev);
          if (modeJson) console.log(eventLine(ev));
          void store.appendEvent(session.id, ev);
        }, makeEventIdFactory(), () => new Date().toISOString()),
      );
      session.emit = (ev) => sink(ev);
    }

    session.emit({ type: 'session.start', id: session.id, cwd: session.cwd, provider: agent.provider.name, model: 'main', startedAt: agent.runtime.clock() });
    const result = await runTurn(session, task);
    const hitTotal = session.stats.hitTokens + session.stats.missTokens;
    session.emit({
      type: 'session.end',
      stats: {
        iterations: session.stats.iterations,
        costUsd: session.stats.costUsd,
        cacheHitRate: hitTotal > 0 ? session.stats.hitTokens / hitTotal : 0,
        compactions: session.stats.compactions,
        subagentCostUsd: 0,
        failedToolCalls: session.stats.failedToolCalls,
        memoryWrites: 0,
      },
    });
    await store.save(session, agent.runtime.clock());

    // 自动巩固：以压缩摘要为事实来源写语义层 + 情景归档
    if (agent.config.memory.autoConsolidate) {
      const cr = await consolidateSession(session, agent.memory, session.lastSummary);
      session.emit({ type: 'memory.consolidate', added: cr.added, updated: cr.updated, deleted: 0 });
    }

    if (result.kind === 'final') {
      if (!modeJson) console.log(result.text);
    } else if (result.kind === 'aborted') {
      // 中止保留半截正文——CLI 也照常输出已得内容
      if (!modeJson) console.log(result.text);
      process.exitCode = 3;
    } else if (result.kind === 'limit') {
      console.error(`[${result.reason}] ${result.text}`);
      process.exitCode = 2;
    } else {
      console.error(`[error] ${result.message}`);
      process.exitCode = 3;
    }
  } catch (err) {
    console.error(`[fatal] ${(err as Error).message}`);
    process.exitCode = 4;
  }
}

void main();
