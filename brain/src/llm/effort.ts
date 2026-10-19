// 思考档位（DeepSeek V4.1）：服务端枚举是 none/minimal/low/medium/high/xhigh/max，
// 官方映射表把它们折叠成 **low / high / max** 三档（其余都是别名），且**思考默认开、默认档 high**。
//
// **内核自动选档**（不加工件界面）——「闲聊走 low、日常工作 high、
// 工作模式/深任务 max」，用户端仍然只看到"选模型"，按实计价。
//
// 为什么放在适配器统一兜底：模型 id 的解析只有一处（message-api.resolveModelId），
// 档位同理——散到四个调用点（Tier3 / 工作模式 / 子代理 / 压缩）就会各自漂移。
// 供应商不吃这个参数（caps.thinkingEffort 未申报）就一个字段都不发。

export type ThinkEffort = 'low' | 'high' | 'max';

/** 内核自动选档：按"这一轮在干什么"决定思考档（用户端不可见，按实计价） */
export function effortFor(ref: { role: string; thinking?: boolean }): ThinkEffort {
  // 记忆提炼 / 压缩 / 轻活：机械活，不需要深思（这里省下来的是真金白银）
  if (ref.role === 'compact' || ref.role === 'fast') return 'low';
  // 分身（子代理）：干的是真活；深步骤（thinking）拉满，普通步骤给 high
  if (ref.role === 'subagent') return ref.thinking ? 'max' : 'high';
  // 主档：深任务（Tier3）/ 工作模式（思考常开）→ 拉满；闲聊 → 省
  return ref.thinking ? 'max' : 'low';
}
