// Runtime 抽象层唯一出处（架构红线）。
// 核心逻辑禁止直接使用 Node 内置模块（fs/child_process/path/os/net…），一律经本接口。
// 平台差异（macOS Node / iOS JavaScriptCore / Android 引擎）全部收敛于本接口的实现。

export interface RuntimeCaps {
  /** 子进程执行（macOS true；iOS false；Android 受限） */
  exec: boolean;
  /** 网络访问 */
  net: boolean;
  /** 应用操作（macOS osascript；移动端原生桥） */
  app: boolean;
  /** 浏览器自动化（仅 macOS） */
  browser: boolean;
  /** 后台持续运行 */
  background: boolean;
}

export interface ReadResult {
  content: string;
  lines: number;
}

export interface StatResult {
  size: number;
  isDir: boolean;
}

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export interface ExecResult {
  ok: boolean;
  code: number;
  output: string;
}

export interface ExecOptions {
  timeoutMs: number;
  /** 可选：进程 stdin（hooks 事件负载用） */
  stdin?: string;
}

/** 最小可用的 fetch 响应形态：避免核心依赖平台 fetch 类型。 */
export interface NetResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /**
   * **真流式**：按到达顺序吐解码后的文本片段。
   * 可选——只有"边收边用"的调用方（SSE 对话流）需要它；不实现时调用方退回 `text()` 整包读
   * （所以一切老 mock / 老端点照样能跑，行为不变）。
   * 为什么值得单开一个方法而不是暴露 `body`：适配器只关心"一段段文本"，
   * 把 ReadableStream/TextDecoder 的细节留在 runtime 层，适配器在两种 runtime 上都一样。
   */
  streamText?(): AsyncIterable<string>;
  /** 最终 URL（跟随重定向之后）与响应头——SSRF 防护要按"最终落到哪"再判一次 */
  url?: string;
  headers?: Record<string, string>;
}

export type NetFetch = (url: string, init?: Record<string, unknown>) => Promise<NetResponse>;

export interface AppResult {
  ok: boolean;
  output: string;
}

export interface BrowserResult {
  ok: boolean;
  output: string;
}

export interface Runtime {
  capabilities: RuntimeCaps;
  fs: {
    read(path: string, opts?: { offset?: number; limit?: number }): Promise<ReadResult>;
    write(path: string, content: string): Promise<void>;
    /** 原子写（临时文件 + fsync + rename：任务表/状态不能被崩溃或并发写吞掉） */
    writeAtomic(path: string, content: string): Promise<void>;
    /** 追加写入（事件流 JSONL 用） */
    append(path: string, content: string): Promise<void>;
    list(path: string): Promise<string[]>;
    stat(path: string): Promise<StatResult>;
    /**
     * 删掉一个文件/目录（快照保留策略要清理老回合）。
     * **可选**：不实现时快照只留不删（如实说明——清理失败不影响回滚本身）。
     * ⚠ 这是给"我们自己数据目录里的东西"用的；用户文件一律走回收站端口（`ports.trash`）。
     */
    remove?(path: string): Promise<void>;
    glob(pattern: string): Promise<string[]>;
    grep(pattern: string, root: string, glob?: string): Promise<GrepHit[]>;
  };
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;
  net: {
    fetch: NetFetch;
    /** 域名 → IP（SSRF 防护用：字面量拦不住"公网域名解析到内网"这种）。
     *  可选——不实现时防护退化成"只查字面量"，调用方要如实说明这一层薄在哪里。 */
    resolve?(host: string): Promise<string[]>;
  };
  app: {
    /** 打开应用或路径（macOS osascript；移动端原生桥），统一结构无平台语义 */
    open(nameOrPath: string): Promise<AppResult>;
    activate(name: string): Promise<AppResult>;
    clipboard(): Promise<{ ok: boolean; content: string }>;
    notify(title: string, body: string): Promise<AppResult>;
    /** macOS: osascript 脚本；移动端: 受限原生指令 */
    run(script: string): Promise<AppResult>;
  };
  browser: {
    open(url: string): Promise<BrowserResult>;
    navigate(url: string): Promise<BrowserResult>;
    content(): Promise<BrowserResult>;
    screenshot(path: string): Promise<BrowserResult>;
    click(selector: string): Promise<BrowserResult>;
    type(selector: string, text: string): Promise<BrowserResult>;
  };
  storage: {
    sessionsDir(): string;
    logsDir(): string;
    memoryDir(): string;
    configDir(): string;
  };
  /** ISO 8601 本地时间 */
  clock(): string;
  /** configHash / 幂等哈希 */
  sha256(input: string): string;
}
