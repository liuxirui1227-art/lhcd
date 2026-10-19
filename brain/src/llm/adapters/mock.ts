// mock 适配器：测试/评测用，非生产。
// 脚本化回复序列，零网络、零成本、确定性。不进生产构建（运行时按需注入）。

import type { ChatEvent, ChatMessage, ChatRequest, LLMProvider, ProviderCaps, ToolDef, Usage } from '../provider.js';

export interface MockOptions {
  /** 预置回复序列：每次 chat() 消耗一个回合（事件数组） */
  script?: ChatEvent[][];
  /** 每回合固定 usage（缺省全 0，成本 0） */
  usage?: Partial<Usage>;
  /** 回合耗尽时循环最后一段（默认 false：耗尽抛错） */
  loop?: boolean;
}

/**
 * 脚本里插一个"抛错"事件——模拟网络/服务故障。
 * 失败分类与恢复（`task/recovery.ts`）与 provider 回退链都靠"首字节前失败"这个条件。
 * 放在脚本最前面 = 首字节前失败（会触发换备胎/自动重来）；放在文本后面 = 说到一半挂（不换人）。
 */
export function mockThrow(message: string): ChatEvent[] {
  return [{ type: 'throw', message } as unknown as ChatEvent];
}

export function mockText(text: string): ChatEvent[] {
  return [{ type: 'text.delta', text }, { type: 'done', usage: zero() }];
}

export function mockToolCalls(calls: { id: string; name: string; args: unknown }[]): ChatEvent[] {
  return [{ type: 'tool_calls', calls }, { type: 'done', usage: zero() }];
}

function zero(): Usage {
  return { inTokens: 0, hitTokens: 0, missTokens: 0, outTokens: 0, reasoningTokens: 0, costUsd: 0 };
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly caps: ProviderCaps = {
    cache: { kind: 'none' },
    reasoning: 'none',
    parallelToolCalls: true,
    compaction: 'client',
    // 跟随默认大脑（DeepSeek V4.1）的 1M 窗口——mock 与真身窗口不一致会让压缩时机的测试不准
    maxContextTokens: 1000000,
  };
  /** 每次 chat() 的完整请求记录（测试断言用） */
  readonly requests: ChatRequest[] = [];
  private readonly script: ChatEvent[][];
  private readonly usage: Partial<Usage>;
  private readonly loop: boolean;
  private cursor = 0;

  constructor(opts: MockOptions = {}) {
    this.script = opts.script ?? [];
    this.usage = opts.usage ?? {};
    this.loop = opts.loop ?? false;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(req);
    if (this.script.length === 0) throw new Error('mock 脚本为空：请先注入回复序列');
    const turn = this.script[Math.min(this.cursor, this.script.length - 1)]!;
    // 调试通道（LHCD_DEBUG_MOCK=1）："哪条剧本落给哪一轮"对不上时，先看这行
    if (process.env.LHCD_DEBUG_MOCK === '1') {
      console.log(`[mock] req#${this.requests.length} → script[${Math.min(this.cursor, this.script.length - 1)}] 事件=${turn.map((e) => e.type).join('+')}`);
    }
    if (this.cursor < this.script.length - 1 || this.loop) this.cursor++;
    for (const ev of turn) {
      // 测试专用：{ type: 'throw', message } 模拟流中断/服务商异常（planner 容错演练）
      const raw = ev as unknown as { type?: string; message?: string };
      if (raw.type === 'throw') throw new Error(raw.message ?? 'mock 脚本抛出');
      if (ev.type === 'done') {
        yield { type: 'done', usage: { ...zero(), ...this.usage } };
      } else {
        yield ev;
      }
    }
  }

  sanitizeForRequest(msgs: ChatMessage[]): ChatMessage[] {
    // mock 不做净化，原样返回
    return msgs.map((m) => ({ ...m }));
  }

  injectCacheMarkers(_system: string, _tools: ToolDef[]): void {
    // mock 无缓存
  }
}
