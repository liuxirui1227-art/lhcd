// Artifact（产物）登记
//
// 要解决的事：**"她做出来的东西"散在多处、互不同步**——任务账本里只有一串路径、文件改动只活在内存
// （回合一开始就清空）、宿主另有一份 `processedFiles` 流水（≤100 条）、大输出落盘的文件没有主人。
// 于是"她刚才做的那份文件在哪"没人答得上来。
//
// 边界（有意）：
//   · **只登记"她做出来/改出来"的**——读过什么不算产物（那是文件页的活）；
//   · 只追加（`artifacts.jsonl`），不重写、不删；
//   · 每条带 id / 类型 / 路径 / 大小 / 谁做的 / 什么时候 / 属于哪一轮。
import type { Runtime } from '../runtime/types.js';
import type { FileMutation } from '../loop/workcheck.js';

/** 产物类型（人话在界面上再翻译；这里只要够分类） */
export type ArtifactType = 'document' | 'sheet' | 'slides' | 'pdf' | 'image' | 'audio' | 'video' | 'code' | 'text' | 'data' | 'other';

export interface Artifact {
  /** `art-<epoch36>-<序号>`：稳定、可引用（对话里的产物卡就靠它） */
  id: string;
  type: ArtifactType;
  /** 本机文件（她做出来的绝大多数东西都在这条路上） */
  path?: string;
  /** 非文件产物（链接/截图等）用 uri */
  uri?: string;
  mimeType: string;
  size?: number;
  /** 谁做出来的：工具名（write / edit / office / media / screenshot…） */
  createdBy: string;
  createdAt: string;
  sessionId: string;
  /** 属于哪一轮（`turn.end` 的 seq 口径） */
  turnSeq?: number;
}

const EXT_TYPE: Array<[RegExp, ArtifactType, string]> = [
  [/\.(docx?|rtf|pages|odt)$/i, 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  [/\.(xlsx?|csv|numbers|ods)$/i, 'sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  [/\.(pptx?|key|odp)$/i, 'slides', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  [/\.pdf$/i, 'pdf', 'application/pdf'],
  [/\.(png|jpe?g|webp|gif|bmp|avif|heic|tiff?)$/i, 'image', 'image/*'],
  [/\.(mp3|wav|m4a|aac|flac|ogg)$/i, 'audio', 'audio/*'],
  [/\.(mp4|mov|mkv|webm|avi)$/i, 'video', 'video/*'],
  [/\.(md|markdown|txt|html?)$/i, 'text', 'text/plain'],
  [/\.(json|jsonl|ya?ml|xml|toml)$/i, 'data', 'application/json'],
  [/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|sh|sql|css)$/i, 'code', 'text/plain'],
];

/** 按扩展名判类型与 mime（判不出来就是 other，不猜） */
export function classifyArtifact(pathOrUri: string): { type: ArtifactType; mimeType: string } {
  for (const [re, type, mime] of EXT_TYPE) if (re.test(pathOrUri)) return { type, mimeType: mime };
  return { type: 'other', mimeType: 'application/octet-stream' };
}

/** 只登记"她做出来的"：写入类工具。读（read/grep/glob/session_search…）不算产物。 */
export const PRODUCING_TOOLS = new Set(['write', 'edit', 'office', 'media', 'screenshot', 'export', 'backup_export']);

export interface ArtifactInput {
  tool: string;
  path: string;
  sessionId: string;
  at: string;
  turnSeq?: number;
  /** 给不了就省略（有的工具自己不报大小） */
  size?: number;
}

/** 从一个"文件改动"造产物（纯函数；不判存在性——那是调用方的事） */
export function artifactFromMutation(m: FileMutation, sessionId: string, at: string, turnSeq?: number): Artifact | null {
  if (!PRODUCING_TOOLS.has(m.tool)) return null;
  const { type, mimeType } = classifyArtifact(m.path);
  return {
    id: '', // 由 ArtifactLog 补（它管序号）
    type, mimeType, path: m.path, createdBy: m.tool, createdAt: at, sessionId, ...(turnSeq !== undefined ? { turnSeq } : {}),
  };
}

/** 追加式产物台账：`sessions/<id>/artifacts.jsonl` */
export class ArtifactLog {
  private seq = 0;
  constructor(private readonly runtime: Runtime, private readonly sessionId: string) {}

  private get file(): string {
    return `${this.runtime.storage.sessionsDir()}/${this.sessionId}/artifacts.jsonl`;
  }

  /** 记一条（返回带 id 的完整产物；写盘失败不抛——产物登记不该拖垮回合） */
  async append(a: Omit<Artifact, 'id'>): Promise<Artifact> {
    const id = `art-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const row: Artifact = { ...a, id };
    try {
      await this.runtime.fs.append(this.file, `${JSON.stringify(row)}\n`);
    } catch { /* 见上 */ }
    return row;
  }

  /** 读回（近 limit 条；坏行跳过——台账坏了不该让界面白屏） */
  async list(limit = 500): Promise<Artifact[]> {
    let raw: string;
    try {
      raw = (await this.runtime.fs.read(this.file, { limit: 20_000_000 })).content;
    } catch {
      return []; // 没有台账 = 还没做出过东西（不是错误）
    }
    const out: Artifact[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Artifact); } catch { /* 跳过坏行 */ }
    }
    return out.slice(-limit);
  }
}
