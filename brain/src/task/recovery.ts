// 失败分类与恢复。
//
// 为什么要有这一层：没有它，一次回合失败就只剩两种命运——"不可恢复 → 解除目标"或"别的不管"。
// 于是"网络抖了一下"和"她参数一直传错"和"审批被拒"在用户眼里长得一模一样：都是"她没做完，也没说为什么"。
//
// 这一层的职责：**把失败原文归一成一种处境，再给出与之匹配的处置**——
// 能自己重来的（还没动过手 + 不是用户叫停）就带一句"换个法子"自己重来一次；
// 重来也没用的（余额/凭证/上下文/被拒）就停下来，用一句人话说清"卡在哪、要你做什么"。
//
// 三条纪律：
//   ① **用户叫停绝不自动重来**（kind='aborted' 一律不重试——那是人的意志，不是故障）；
//   ② **动过手就不自动重来**（本回合已经调过工具 → 重来有重复副作用的风险，宁可停下来问）；
//   ③ **每一轮用户消息最多自动重来一次**（不许陷入"失败→重来→失败"的烧钱循环）。

export type RecoveryKind =
  | 'transient'   // 网络/服务抖动、超时、5xx、流中断——等一会儿能好
  | 'usage'       // 服务商限流（429）——等一会儿能好，但不是"重试一次"能解决的
  | 'budget'      // 余额/额度/成本上限——用户不动作就好不了
  | 'auth'        // Key 无效/被吊销——不可恢复
  | 'context'     // 上下文爆掉
  | 'loop'        // 原地打转 / 迭代上限（wrong_approach）
  | 'bad_args'    // 工具参数反复修不好
  | 'permission'  // 策略拒绝 / 审批被拒
  | 'env'         // 环境问题：命令没有、路径不在、没权限
  | 'unknown';

export type RecoveryAction = 'retry' | 'repair' | 'replan' | 'ask' | 'fix_env' | 'escalate';

export interface FailureFacts {
  /** 回合结果的 kind：'error' | 'limit' | 'aborted' | 'final' */
  kind?: string;
  /** error 的原文 */
  message?: string;
  /** limit 的原因：`maxIterations` | `maxCost` | `maxContext` | `maxTokens` | `maxRuntime` | `waitingUser` | `policy` */
  reason?: string;
  /** 本回合工具调用次数（>0 = 动过手；动过手就不自动重来） */
  toolsUsed?: number;
  /** 这一轮用户消息是否已经自动重来过（最多一次） */
  retried?: boolean;
}

export interface RecoveryPlan {
  kind: RecoveryKind;
  action: RecoveryAction;
  /** true = 自动重来（宿主带 note 再跑一次）；false = 停下来叫人 */
  auto: boolean;
  /** 自动重来时注入的提示（对模型说） */
  note: string;
  /** 停下来时给用户的人话 */
  userMessage: string;
  /** 为什么这么处置（进账本日志，便于事后解释） */
  why: string;
}

/** 归一：把"回合怎么结束的"翻译成一种处境 */
export function classifyTurnFailure(f: FailureFacts): RecoveryKind {
  if (f.kind === 'limit') {
    if (f.reason === 'maxCost') return 'budget';
    if (f.reason === 'maxContext') return 'context';
    if (f.reason === 'maxIterations') return 'loop';
    // 其余四个 limit 出口（每个都要有归属，不能落 unknown）
    if (f.reason === 'maxTokens') return 'budget';
    if (f.reason === 'maxRuntime') return 'loop'; // 干太久 ≈ 法子不对/太贪，换思路或拆小
    if (f.reason === 'waitingUser' || f.reason === 'policy') return 'permission'; // 都卡在"需要人点头"
    return 'unknown';
  }
  const m = String(f.message ?? '');
  if (!m) return 'unknown';
  // 顺序有讲究：先判最具体的（策略/环境/参数），再判宽泛的网络类，否则"permission denied"会被网络正则误吞
  if (/POLICY_DENY|APPROVAL_DENIED|审批|被拒绝|denied by policy|风险过高/.test(m)) return 'permission';
  if (/BAD_ARGS|BAD_SCHEMA|参数不|schema/i.test(m)) return 'bad_args';
  if (/ENOENT|command not found|No such file|not found|不存在|EACCES|permission denied|cannot find/i.test(m)) return 'env';
  if (/余额不足|insufficient|HTTP 402|quota exceeded|budget|成本上限/i.test(m)) return 'budget';
  if (/429|限流|rate.?limit|too many requests/i.test(m)) return 'usage';
  if (/HTTP 401|HTTP 403|invalid.*key|key.*invalid|吊销|revoked|authentication/i.test(m)) return 'auth';
  if (/上下文|maxContext|context length|too long|超出上限/i.test(m)) return 'context';
  if (/原地|打转|重复|无进展|no progress/i.test(m)) return 'loop';
  if (/网络|fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|超时|timeout|5\d\d|中断/.test(m)) return 'transient';
  return 'unknown';
}

const NOTE: Record<RecoveryAction, string> = {
  retry: '[自动重试] 上一步没连上（网络/服务抖动，不是你的错）。重新做一遍刚才这件事；已经确认过的部分不用重来。',
  repair: '[自动重试] 上一次工具参数不对（BAD_ARGS/BAD_SCHEMA）。重来：**先 read 看清真实内容与字段**，再改；别猜参数。',
  replan: '[自动重试] 上一次在原地打转或到了迭代上限。换一个思路重做：先用一句话说你打算怎么做，再动手；同一招不要再重复。',
  ask: '',
  fix_env: '',
  escalate: '',
};

/**
 * 处置决策（纯函数）。自动重来的三个前提一个都不能少：
 * ① 处置类型本身就是"再来一次"；② 本回合**没动过手**；③ 这一轮还没重来过。
 */
export function planRecovery(f: FailureFacts): RecoveryPlan {
  const kind = classifyTurnFailure(f);
  const action: RecoveryAction =
    kind === 'transient' ? 'retry'
    : kind === 'bad_args' ? 'repair'
    : kind === 'loop' ? 'replan'
    : kind === 'permission' ? 'ask'
    : kind === 'env' ? 'fix_env'
    : 'escalate';

  const canAuto = ['retry', 'repair', 'replan'].includes(action);
  const toolsUsed = f.toolsUsed ?? 0;
  const retried = f.retried === true;
  // 用户叫停不是故障——绝不自动重来（这是纪律①，写在最前面）
  const userStopped = f.kind === 'aborted';
  const auto = canAuto && !userStopped && toolsUsed === 0 && !retried;

  const why = userStopped
    ? '用户叫停：不自动重来'
    : auto
      ? `可自愈（${kind}）：本回合未动工具、且未重来过 → 自动重来一次`
      : canAuto
        ? `本可自愈（${kind}）但不可自动重来：${toolsUsed > 0 ? '本回合已动过工具（怕重复副作用）' : '这一轮已经重来过一次'} → 停下来报清楚`
        : `不可自愈（${kind}）→ 停下来报清楚`;

  return {
    kind,
    action: auto ? action : (canAuto ? 'escalate' : action),
    auto,
    note: auto ? NOTE[action] : '',
    userMessage: auto ? '' : userMessageFor(kind, f),
    why,
  };
}

/** 停下来时的人话：说清"卡在哪 + 要用户做什么" */
export function userMessageFor(kind: RecoveryKind, f: FailureFacts = {}): string {
  const detail = String(f.message ?? '').slice(0, 120);
  switch (kind) {
    case 'budget':
      return '这次的花销到顶了，我先停下来。你把额度调一下（或告诉我放宽多少），说一声我接着来。';
    case 'usage':
      return '服务商那边限流了，我先歇一会儿——过几分钟你再喊我，或者我下次心跳时自己接着试。';
    case 'auth':
      return '我的钥匙失效了（Key 被吊销或无效）。你在「设置 → 大脑」里换一个，我就继续。';
    case 'context':
      return '这件事的信息量把上下文撑满了，一轮塞不下。拆小一点（比如分两次、或者先只处理其中一个文件），我就能做完。';
    case 'permission':
      return '这件事被拦下来了（审批没通过或策略不允许）。要么你批准，要么换个做法——你说了算。';
    case 'env':
      return `环境这边缺东西：${detail || '命令或路径不对'}。你先修一下（装好/改路径/给权限），修好说一声。`;
    case 'bad_args':
      return '我连续几次把工具参数传错了，先停下来不瞎试。你说一声「再来」，我这次先看清内容再动手。';
    case 'loop':
      return '我在原地打转了（同一招反复用），先停下——硬试只会烧钱。换个思路，或者你给点提示？';
    case 'transient':
      return '连接不太稳，试过还是没成。等一会儿再说一声，我接着来。';
    default:
      return `这次没完成：${detail || '不知道哪里出了问题'}。我先停下来了，你说一声我再试。`;
  }
}
