// 工具注册表与公共类型唯一出处。
// 启动时按 name 排序；tools.enabled 白名单过滤；capabilityRequirement 按 capabilities 过滤。

import type { ToolDef } from '../llm/provider.js';
import type { Runtime } from '../runtime/types.js';
import type { Config } from '../config/schema.js';
import type { AgentEvent } from '../session/events.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { MemoryService } from '../memory/service.js';
import type { SkillMeta } from '../skills/scan.js';
import type { SubagentRunner } from '../agents/runner.js';

/** 工具执行上下文 */
export interface ExecCtx {
  sessionId: string;
  cwd: string;
  runtime: Runtime;
  config: Config;
  policy?: PolicyEngine;
  memory?: MemoryService;
  /** 技能清单（工厂扫描快照） */
  skills?: SkillMeta[];
  /** 本会话已加载技能（每技能仅一次） */
  loadedSkills?: Set<string>;
  /** run_agent 用；未注入时 run_agent 不注册 */
  subagentRunner?: SubagentRunner;
  /** 当前侧面（facet key 或 'companion'）：记忆检索分区过滤依据 */
  facet?: string;
  /** 当前模式（'chat' | 'work'）：工具可据此收紧自己（如 run_agent 只在工作模式可用）。
   *  与 facet 一样是**只读快照**，工具不许改它。 */
  mode?: 'chat' | 'work';
  /** 定时任务表（schedule 工具用；宿主未挂载时工具拒绝） */
  cronJobs?: import('../orchestrate/jobs.js').CronJobs;
  /** 任务账本（task 工具用；宿主未挂载时工具拒绝） */
  taskStore?: import('../task/store.js').TaskStore;
  /** 宿主注入的能力端口（Office / 回收站；未挂载时工具如实拒绝） */
  ports?: import('../ports.js').AgentPorts;
  /** 本回合的改动清单（写类工具登记；收尾前回读核对用） */
  mutations?: import('../loop/workcheck.js').FileMutation[];
  /**
   * **回合级快照**（写类工具在改动**之前**调 `record`；`undo` 用它整体退回）。
   * 未挂载 = 不记快照（CLI/评测里不需要），`undo` 会如实拒绝而不是假装成功。
   */
  snapshots?: import('../session/snapshots.js').TurnSnapshots;
  /** 快照库本身（`undo` 按回合取计划用） */
  snapshotStore?: import('../session/snapshots.js').SnapshotStore;
  emit: (ev: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  truncated?: boolean;
  error?: { code: string; message: string };
}

/**
 * 权限类。`screen` = **看屏幕**：屏幕截取走策略与审计，能像别的类一样被规则收紧（`screen → deny` 一刀切关掉）。
 */
export type PermissionClass = 'read' | 'write' | 'bash' | 'net' | 'app' | 'internal' | 'screen';
export type CapabilityRequirement = 'exec' | 'net' | 'app' | 'browser';

export interface ToolEntry {
  name: string;
  schema: ToolDef;
  executor: (args: unknown, ctx: ExecCtx) => Promise<ToolResult>;
  permissionClass: PermissionClass;
  /** 写类工具互斥串行（并行执行约束） */
  exclusive?: boolean;
  /** 平台能力不支持则不注册 */
  capabilityRequirement?: CapabilityRequirement;
}

export class ToolRegistry {
  private readonly entries = new Map<string, ToolEntry>();

  register(entry: ToolEntry): void {
    if (this.entries.has(entry.name)) {
      throw new Error(`工具重复注册: ${entry.name}`);
    }
    this.entries.set(entry.name, entry);
  }

  get(name: string): ToolEntry | undefined {
    return this.entries.get(name);
  }

  /** 全部已注册工具（按 name 排序） */
  all(): ToolEntry[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 启动清单：按 name 排序 → enabled 白名单过滤 → capabilityRequirement 按 capabilities 过滤。
   * 顺序会话内固定（前缀冻结）。
   */
  listEnabled(config: Config, caps: Runtime['capabilities']): ToolEntry[] {
    const enabled = new Set(config.tools.enabled);
    return this.all().filter((e) => {
      if (!enabled.has(e.name)) return false;
      if (e.capabilityRequirement && !caps[e.capabilityRequirement]) return false;
      return true;
    });
  }

  /** 工具 schema 列表（进冻结前缀，顺序固定） */
  schemasFor(config: Config, caps: Runtime['capabilities']): ToolDef[] {
    return this.listEnabled(config, caps).map((e) => e.schema);
  }
}
