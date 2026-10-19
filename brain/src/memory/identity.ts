// Identity 层：用户给 TA 定过的**长期规矩 / 稳定偏好 / 长期要求**。
//
// 三层记忆各管一段，别混：
//   宪法 constitution = 她是谁（出生时冻结，不可搜不可改）
//   Identity（本文件） = **你定过的规矩**（只有用户明说才进来，可改可删、一条一行）
//   语义 / 情景记忆     = 你和她之间发生过什么（可搜、会过期、有来路）
//
// **高度克制**（设计纪律：写任务史，不写用户画像）：
//   · 只有**用户明说**才进来（工具 scope='identity' / 界面手加）；她自己从对话里提炼的
//     一律不进这层（那是候选态语义记忆该待的地方）
//   · 硬上限 30 条：满了**拒收并如实说**，不静默丢老的 —— 规矩多了等于没有规矩
//   · 相似条目 = 同一条要求的重申：更新措辞、**保留最早的时间**（它一直算数）
//   · 一条一行、人可读可改：用户直接编辑这个文件 = 改她的长期要求（改完下次开会话生效）
import type { Runtime } from '../runtime/types.js';
import { hasSecret } from './semantic.js';
import { scoreText } from './text.js';

export interface IdentityItem {
  text: string;
  /** 谁定的：user-request（工具）/ user-edit（用户直接改文件）/ user-ui（界面加的） */
  source: string;
  /** 首次定下这条规矩的时间（重申不刷新 —— 它一直算数） */
  at: string;
}

/** 上限：30 条。满了拒收（如实告诉用户），不静默丢老规矩 */
export const IDENTITY_MAX = 30;
/** 相似度阈值：超过它视为"同一条要求的重申" */
const SAME_RULE_SCORE = 0.75;

const HEADER = [
  '# 你给 TA 定过的长期规矩（Identity 层）',
  '# 一条一行；直接改这个文件就是改她的长期要求（改完下次开会话生效）；删掉即失效。',
  '# 只有你明说的才会进来 —— 她自己提炼的不会。',
  '',
];

export class IdentityStore {
  constructor(
    private readonly runtime: Runtime,
    /** 文件路径（config.memory.identityFile） */
    private readonly file: string,
  ) {}

  private parse(raw: string): IdentityItem[] {
    const out: IdentityItem[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('- ') || t.startsWith('- #')) continue;
      const body = t.slice(2);
      const m = body.match(/^(.*?)\s*<!--\s*(.*?)\s*-->\s*$/);
      const text = (m ? m[1]! : body).trim();
      if (!text) continue;
      // 出处注释：`source · at`；用户手写没带注释 → 记为 user-edit（诚实：不知道是谁定的就说是改文件来的）
      const meta = m ? m[2]!.split('·').map((s) => s.trim()) : [];
      out.push({ text, source: meta[0] || 'user-edit', at: meta[1] || '' });
    }
    return out;
  }

  private serialize(items: IdentityItem[]): string {
    return HEADER.concat(
      items.map((it) => `- ${it.text}  <!-- ${it.source}${it.at ? ` · ${it.at}` : ''} -->`),
    ).join('\n') + '\n';
  }

  async list(): Promise<IdentityItem[]> {
    try {
      return this.parse((await this.runtime.fs.read(this.file, { limit: 200_000 })).content);
    } catch {
      return []; // 没有这个文件 = 还没有规矩
    }
  }

  /**
   * 记一条长期规矩。返回 action：
   *   add 新增 / update 视为重申（措辞刷新、时间保留）/ full 满了拒收 / empty 空串 / redacted 疑似密钥
   */
  async add(text: string, source = 'user-request', at?: string): Promise<{ action: 'add' | 'update' | 'full' | 'empty' | 'redacted'; count: number }> {
    const clean = String(text ?? '').trim().slice(0, 200);
    const items = await this.list();
    if (!clean) return { action: 'empty', count: items.length };
    if (hasSecret(clean)) return { action: 'redacted', count: items.length };
    const hit = items.find((it) => scoreText(it.text, clean).score >= SAME_RULE_SCORE);
    if (hit) {
      hit.text = clean; // 重申：刷新措辞，**保留最早的 at**（它一直算数）
      await this.runtime.fs.write(this.file, this.serialize(items));
      return { action: 'update', count: items.length };
    }
    if (items.length >= IDENTITY_MAX) return { action: 'full', count: items.length };
    items.push({ text: clean, source, at: at ?? this.runtime.clock() });
    await this.runtime.fs.write(this.file, this.serialize(items));
    return { action: 'add', count: items.length };
  }

  /** 删一条（按下标；界面按 list() 的顺序给下标）。越界返回 false */
  async remove(index: number): Promise<boolean> {
    const items = await this.list();
    if (!Number.isInteger(index) || index < 0 || index >= items.length) return false;
    items.splice(index, 1);
    await this.runtime.fs.write(this.file, this.serialize(items));
    return true;
  }

  /** 按内容删一条（相似即视为同一条；工具/界面都能用）。删不到返回 false */
  async removeByText(text: string): Promise<boolean> {
    const clean = String(text ?? '').trim();
    if (!clean) return false;
    const items = await this.list();
    const hit = items.findIndex((it) => scoreText(it.text, clean).score >= SAME_RULE_SCORE);
    if (hit < 0) return false;
    items.splice(hit, 1);
    await this.runtime.fs.write(this.file, this.serialize(items));
    return true;
  }

  /** 注入用渲染（空 → 空串）。**保持文件顺序**（确定性：同一份文件 → 同一段字节） */
  async render(): Promise<string> {
    const items = await this.list();
    if (items.length === 0) return '';
    return items.map((it) => `- ${it.text}`).join('\n');
  }
}
