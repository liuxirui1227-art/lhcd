// 验证契约
//
// 为什么要有它："任务完成"的机器判据不能只有"她说的最后一句话 == 她承诺的那句信号"
// （见 `task/criteria.ts`）。那管的是**"话说到做到"**，不管**"活真的干成了"**。
// 不能让"模型说完成了"当完成标准；报告形状：
//   { task, attempts, verification: [{type,status}], confidence }，其中 **confidence 是系统内部估计，不是事实**。
//
// 证据**不新造采集器**，全部来自已有事实：
//   · `session.mutations`——这一轮改过的文件 + 写时登记的预期（workcheck 已经在回读核对，这里复用同一套读盘）
//   · Office 产物（`binary` 标记）——核"产物在 + 原件没被动"；改动正确性由 Office 工具自证
//   · 这一轮**成功跑过的工具**——弱证据（研究类任务没有文件可核时的兜底）
//
// 闸门在 `turn.ts` 的收尾管线里（工作模式才拦）：过不了 → 回插一条"无凭据不许交付"（护栏：一轮只插一次）。
// 闲聊模式**不拦**（用户要的是陪伴，不是审计——验证标准也是模式差异之一）。

import type { FileMutation } from './workcheck.js';

export interface EvidenceItem {
  type: 'file-content' | 'file-exists' | 'office-selfcheck' | 'tool-ok';
  /** 文件路径 / 工具名 */
  target: string;
  status: 'passed' | 'failed' | 'unknown';
  detail: string;
}

export interface VerificationReport {
  task: string;
  attempts: number;
  evidence: EvidenceItem[];
  /** 0~1 的**系统内部估计**（不是事实，别当承诺对外说） */
  confidence: number;
  /** 通过 = 至少一条真证据、且没有一条失败 */
  passed: boolean;
  checkedAt: string;
}

/** verify.ts 需要的最小会话面（避免与 Session 类循环依赖） */
export interface VerifiableSession {
  mutations: FileMutation[];
  turnToolLog?: Array<{ name: string; ok: boolean }>;
  runtime: { fs: { read(path: string, opts?: { limit?: number }): Promise<{ content: string }>; stat(path: string): Promise<unknown> } };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 生成报告。`attempts` = 本回合到收尾为止的迭代数（越多说明越费劲，进 confidence）。
 * 同一文件一轮里改多次 → **只核最后一次**（与 workcheck 同口径：前面的被覆盖是正常的，不误报）。
 */
export async function buildVerificationReport(
  session: VerifiableSession,
  opts: { task?: string; attempts?: number } = {},
): Promise<VerificationReport> {
  const evidence: EvidenceItem[] = [];
  const latest = new Map<string, FileMutation>();
  for (const m of session.mutations) latest.set(m.path, m);

  for (const m of latest.values()) {
    if (m.binary) {
      // Office/PDF 产物：只核"在不在"（回读二进制会读出乱码、误报；正确性由工具自证）
      try {
        await session.runtime.fs.stat(m.path);
        evidence.push({ type: 'office-selfcheck', target: m.path, status: 'passed', detail: '产物在磁盘上（改动正确性由 Office 工具自证）' });
      } catch {
        evidence.push({ type: 'office-selfcheck', target: m.path, status: 'failed', detail: '说改好的产物现在找不到了' });
      }
      if (m.expect?.source) {
        try {
          await session.runtime.fs.stat(m.expect.source);
          evidence.push({ type: 'file-exists', target: m.expect.source, status: 'passed', detail: '原件还在（改文档不该动原件）' });
        } catch {
          evidence.push({ type: 'file-exists', target: m.expect.source, status: 'failed', detail: '原件不见了' });
        }
      }
      continue;
    }
    let content: string;
    try {
      content = (await session.runtime.fs.read(m.path, { limit: 2_000_000 })).content;
    } catch {
      evidence.push({ type: 'file-content', target: m.path, status: 'failed', detail: '改完读不回来' });
      continue;
    }
    const e = m.expect ?? {};
    if (e.content !== undefined) {
      const same = content === e.content;
      evidence.push({ type: 'file-content', target: m.path, status: same ? 'passed' : 'failed', detail: same ? '文件内容与写进去的一致（重读核对过）' : `重读回来的内容与写进去的不一致（写 ${e.content.length} 字，读回 ${content.length} 字）` });
    } else if (e.newString !== undefined) {
      const hit = content.includes(e.newString);
      evidence.push({ type: 'file-content', target: m.path, status: hit ? 'passed' : 'failed', detail: hit ? '替换后的新内容就在文件里' : '文件里找不到替换成的那段文字' });
    } else {
      evidence.push({ type: 'file-content', target: m.path, status: 'unknown', detail: '改了但没留可核对的预期' });
    }
  }

  // 弱证据：这一轮成功跑过的工具（没有文件可核时用；研究/检索类任务靠它）
  const tools = session.turnToolLog ?? [];
  if (evidence.length === 0) {
    for (const t of [...new Set(tools.filter((t) => t.ok).map((t) => t.name))]) {
      // 兜底句**不许同义反复**（「read：这一步真跑通了（read）」式的话工具名念两遍、等于没说）。
      // 要说一句**有信息量**的话：做过、没报错、但没留下能核对的东西——
      // 并明说这只是弱证据（别把"跑通了"说成"做对了"）。
      evidence.push({ type: 'tool-ok', target: t, status: 'passed', detail: '做过这一步、没报错，但没留下能核对的东西（算弱证据）' });
    }
  }

  const passedCount = evidence.filter((e) => e.status === 'passed').length;
  const failedCount = evidence.filter((e) => e.status === 'failed').length;
  const attempts = Math.max(1, opts.attempts ?? 1);

  let confidence = 0.5;
  if (evidence.length > 0) {
    confidence = 0.3 + 0.6 * (passedCount / evidence.length);
  }
  const toolFailed = tools.filter((t) => !t.ok).length;
  if (tools.length > 0 && toolFailed === 0) confidence += 0.1;
  if (attempts > 6) confidence -= 0.1; // 磨了很久才收尾 → 扣一点（不是事实，只是系统自估）
  // 失败是主信号：**加完所有奖励之后再压**（否则"有一条没过但工具都跑通了"会算出个漂亮的分数）
  if (failedCount > 0) confidence = Math.min(confidence, 0.3);
  confidence = round2(Math.max(0.05, Math.min(0.95, confidence)));

  return {
    task: opts.task ?? '',
    attempts,
    evidence,
    confidence,
    // 通过 = **至少一条真正核过的证据**（passed）且没有一条失败。
    // 注意 unknown 不算过：那是"改了但没留可核对的预期"——恰恰是验证契约要消灭的东西。
    passed: passedCount > 0 && failedCount === 0,
    checkedAt: new Date().toISOString(),
  };
}

/** 回插话术（工作模式过不了闸时用）：说清缺什么、要求给出证据或如实说没成 */
export function verifyNudge(report: VerificationReport): string {
  const lines = [
    '（后台核对·**补充意见，不是替代**）这是**工作模式**：你要收尾了，但你手上这件事我没法核对——',
    report.evidence.length === 0
      ? '· 你这一轮动过手（用了工具），但**没有留下任何可核对的结果**（没改文件、也没能说清哪一步跑通了）。'
      : `· 有一处对不上：${report.evidence.filter((e) => e.status === 'failed').map((e) => `${e.target}（${e.detail}）`).join('；')}`,
    '要么把活真正做成（然后再收尾），要么**如实告诉用户哪一步没成、卡在哪**——不许按"搞定了"交付。',
    '收尾时说清三件事：你改了什么、依据是什么、还剩什么没做。',
  ];
  return lines.join('\n');
}
