// provider 回退链。
//
// 为什么要有它：路由已把备胎算好——`routeTask` 返回**按分数降序的完整数组**（即回退链），
// 但调用点只取 `[0]`，"主源故障自动换备胎"这件事一直没人接。这里把它接上。
//
// 规则只有一条，但很要紧：**首字节前才切换**。
// 已经开口（吐出过事件）就不能装作没说过——半截回复 + 换个人重说，用户看到的是两个人抢话；
// 那种情况照旧把错误抛上去，交给失败分类与恢复（`task/recovery.ts`）处置。
import type { ChatEvent, ChatRequest, LLMProvider } from './provider.js';

/**
 * 什么时候**才**换备胎：只有"这家服务商自己出问题"——5xx / 429。
 * 三类**不换**，各自有更该走的路：
 *   · 传输层失败（没网/连不上/DNS）→ 那是"用户离线"，该走本机存续态人设（换一家也连不上，且换人说话会毁人设）；
 *   · 4xx（参数/凭证/额度）→ 换个供应商只会拿同样的错请求再撞一次；
 *   · 已经开口说过话 → 半截回复不能换个人重说（见下）。
 */
export function shouldFallback(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err ?? '');
  return /HTTP 5\d\d|HTTP 429|限流|rate.?limit|服务(器)?(错误|不可用|过载)/i.test(m);
}

export interface FallbackHooks {
  /** 换备胎时回调（宿主接日志用；不接就是静默切换——但"静默"和"没人知道"是两回事，宿主该接） */
  onFallback?: (err: unknown, fromName: string, toName: string) => void;
  /** 自定义"该不该换"的判据（缺省 = shouldFallback：只有 5xx/429 换） */
  canFallback?: (err: unknown) => boolean;
}

/** 把一串 provider 串成回退链（首字节前失败才往下走；全都失败抛最后一个错） */
export function createFallbackProvider(providers: LLMProvider[], hooks: FallbackHooks = {}): LLMProvider {
  const list = (providers ?? []).filter(Boolean);
  if (list.length === 0) throw new Error('回退链为空：至少要有一个 provider');
  const primary = list[0]!;
  const name = list.length > 1 ? `${primary.name}+${list.length - 1}` : primary.name;

  return {
    name,
    caps: primary.caps,
    sanitizeForRequest: (msgs) => primary.sanitizeForRequest(msgs),
    injectCacheMarkers: (system, tools) => primary.injectCacheMarkers(system, tools),
    ...(primary.embed ? { embed: (texts: string[]) => primary.embed!(texts) } : {}),
    async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
      let lastErr: unknown;
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        let spoke = false;
        try {
          for await (const ev of p.chat(req)) {
            spoke = true; // 一旦开口，就不许再换人
            yield ev;
          }
          return;
        } catch (e) {
          if (spoke) throw e;                    // 开口了 → 不换人
          if (!(hooks.canFallback?.(e) ?? shouldFallback(e))) throw e; // 不是服务商侧的锅 → 交给上层（存续态/恢复引擎）
          lastErr = e;
          const next = list[i + 1];
          if (next) hooks.onFallback?.(e, p.name, next.name);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('回退链上的 provider 全都失败了');
    },
  };
}
