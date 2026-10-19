// 宿主注入的能力端口。
//
// 为什么要有这一层：Office 库（mammoth/jszip/exceljs/pdf-lib…）是 npm 依赖，而 **brain 保持零运行时依赖**
// （架构红线：不引原生模块、不撞打包签名）。做法：**库放 runtime 侧，brain 只声明接口，宿主注入实现**
// （与既有 Runtime 抽象同构）。
//
// 端口缺失时工具**如实拒绝**（"我这台机器上没有 Office 能力"），绝不假装成功。

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf';

/** 一处改动（判别联合；每种格式支持哪些由能力矩阵决定） */
export type OfficeChange =
  | { kind: 'replace'; find: string; replace: string; expected?: number }
  | { kind: 'cell'; sheet?: string; cell: string; value: string | number }
  | { kind: 'field'; name: string; value: string }
  | { kind: 'page'; op: 'rotate' | 'remove'; page: number; degrees?: number };

export interface OfficeResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
  /** 产物路径（modify/create/convert 有） */
  path?: string;
  /** 实际命中数（modify；"改了要自证"的依据） */
  hits?: number;
  /** 预览用 HTML（preview 有） */
  html?: string;
}

export interface OfficePort {
  inspect(input: { file: string }): Promise<OfficeResult>;
  modify(input: { file: string; changes: OfficeChange[]; saveAs?: string }): Promise<OfficeResult>;
  create(input: { format: OfficeFormat; saveAs: string; title?: string; text?: string; rows?: Array<Array<string | number>>; headings?: string[] }): Promise<OfficeResult>;
  convert(input: { file: string; to?: string; saveAs?: string }): Promise<OfficeResult>;
  validate(input: { file: string; contains?: string[]; absent?: string[] }): Promise<OfficeResult>;
  preview(input: { file: string }): Promise<OfficeResult>;
}

// ========== 图片/视频处理（媒体端口）==========
// 设计同 OfficePort：**库/二进制在 runtime 侧，brain 只声明接口**（开箱即用：用户不装任何东西）。
// 底层统一走随包的 ffmpeg（图片也走它——`sips` 只有 macOS 有，跨平台要一致）。

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaInfo {
  kind: MediaKind;
  /** 视频/音频时长（秒） */
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** 编码/容器（如 h264 / mp4 / png） */
  codec?: string;
  /** 字节数 */
  sizeBytes?: number;
  /** 音轨信息（有声音没声音） */
  hasAudio?: boolean;
}

/** 一次媒体操作（判别联合；每一种都有明确的"改不成就不产出"判据） */
export type MediaOp =
  /** 合并（同一编码/分辨率的多段；默认不重编码，秒合） */
  | { kind: 'merge'; inputs: string[]; saveAs: string; reencode?: boolean }
  /** 截取片段（秒） */
  | { kind: 'trim'; input: string; from: number; to: number; saveAs: string; reencode?: boolean }
  /** 转格式（换容器/换编码，按扩展名） */
  | { kind: 'convert'; input: string; saveAs: string }
  /** 压缩（视频降码率 / 图片降质量） */
  | { kind: 'compress'; input: string; level?: 'light' | 'standard' | 'strong'; saveAs?: string }
  /** 缩放 */
  | { kind: 'resize'; input: string; width?: number; height?: number; saveAs?: string }
  /** 裁剪 */
  | { kind: 'crop'; input: string; width: number; height: number; x: number; y: number; saveAs?: string }
  /** 旋转/镜像 */
  | { kind: 'rotate'; input: string; degrees: 90 | 180 | 270; saveAs?: string }
  /** 加水印（文字或图片） */
  | { kind: 'watermark'; input: string; text?: string; image?: string; position?: 'tl' | 'tr' | 'bl' | 'br'; saveAs?: string }
  /** 拼图/拼长图（图片） */
  | { kind: 'montage'; inputs: string[]; columns?: number; saveAs: string }
  /** 抽帧做封面 */
  | { kind: 'thumbnail'; input: string; atSec?: number; saveAs?: string }
  /** 转 GIF */
  | { kind: 'gif'; input: string; fromSec?: number; toSec?: number; fps?: number; width?: number; saveAs?: string }
  /** 抽音轨 */
  | { kind: 'extract_audio'; input: string; saveAs?: string };

export interface MediaResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
  /** 产物路径（成功时） */
  path?: string;
  info?: MediaInfo;
  /** 引擎可用性（缺失时如实拒绝，不假装成功） */
  engine?: { ffmpeg: boolean; version?: string };
}

export interface MediaPort {
  /** 引擎探针（没装/没随包 → 工具如实拒绝） */
  available(): Promise<{ ffmpeg: boolean; version?: string }>;
  /** 看：这个文件是什么、多大多长 */
  info(input: { file: string }): Promise<MediaResult>;
  /** 改：跑一次操作（实现方负责"另存新文件 + 产出后自检"） */
  run(op: MediaOp): Promise<MediaResult>;
}

/** 回收站端口：删文件走回收站 = 把"不可逆"变成"可撤回" */
export interface TrashPort {
  trash(path: string): Promise<{ ok: boolean; error?: string }>;
}

export interface AgentPorts {
  office?: OfficePort;
  trash?: TrashPort;
  /** 图片/视频处理（随包 ffmpeg；未注入时工具如实拒绝） */
  media?: MediaPort;
  /** 待办——她把「闲聊里聊出来的事」记进家里右栏那张卡（未注入时 todo 工具如实拒绝） */
  todos?: TodoPort;
}

/** 待办端口。宿主实现它；`add` 记进来的来源固定算「聊天里提到的」。 */
export interface TodoPort {
  add(text: string, opts?: { priority?: 'high' | 'mid' | 'low' | null }): Promise<{ ok: boolean; error?: string }>;
  /** 当日该看见、且还没做完的（宿主已按"第二天可标注、第三天不再展示"过滤过） */
  list(): Promise<Array<{ id: string; text: string; priority: string | null; done: boolean }>>;
}

/** 能力矩阵（与 runtime 侧一致；brain 侧用它给出人话拒绝） */
export const OFFICE_MATRIX: Record<OfficeFormat, string[]> = {
  docx: ['create', 'inspect', 'modify', 'validate', 'convert', 'preview'],
  xlsx: ['create', 'inspect', 'modify', 'validate', 'convert', 'preview'],
  pptx: ['inspect', 'modify', 'validate', 'preview'],
  pdf: ['create', 'inspect', 'modify', 'validate', 'convert', 'preview'],
};
