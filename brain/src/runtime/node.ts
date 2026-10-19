// Runtime 的 Node 实现（macOS 壳）。这是核心之外唯一允许使用 Node 内置模块的地方。
// 职责：原始能力。行号格式化/截断/env 白名单/超时杀进程组/权限判定在工具层与沙箱层。
import fs from 'node:fs';
import { decodeBody } from './stream.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  Runtime, RuntimeCaps, ReadResult, StatResult, GrepHit, ExecResult, NetResponse,
} from './types.js';
import { listGlob, matchGlob, walkFiles } from './glob.js';

/** env 白名单 */
const ENV_WHITELIST = ['PATH', 'HOME', 'SHELL', 'TERM', 'LC_ALL', 'LANG', 'TMPDIR', 'USER'];
const MAX_EXEC_OUTPUT = 1024 * 1024; // 运行时防御性上限 1MB；展示截断 50KB 在 bash 工具层

/** shell 单引号包裹（转义内嵌单引号） */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** osascript 单条语句（-e） */
export function osa(script: string): string {
  return `osascript -e ${shq(script)}`;
}

/** AppleScript 双引号字符串（转义内嵌引号与反斜杠） */
export function dq(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 出站守卫（「记忆不出本机」）：**发出去之前**看一眼这次请求里有没有
 * 她的私密内容（私钥材料 / 签名日志 / 记忆原文 / 禁区路径）。
 * 判据由**宿主**给（指纹在数据目录里，内核拿不到），这里只负责"每次出站都问一次"，问不过就不发。
 */
export type NetEgressGuard = (req: { url: string; body?: string }) => { ok: true } | { ok: false; reason: string };

export interface NodeRuntimeOptions {
  cwd: string;
  storage: {
    sessionsDir: string;
    logsDir: string;
    memoryDir: string;
    configDir: string;
  };
  capabilities?: Partial<RuntimeCaps>;
  /** 出站守卫（可选）：缺省 = 不设这道闸（老调用方/测试不变） */
  netGuard?: NetEgressGuard;
}

export function createNodeRuntime(opts: NodeRuntimeOptions): Runtime {
  const cwd = path.resolve(opts.cwd);
  const capabilities: RuntimeCaps = {
    exec: true,
    net: true,
    app: true,
    browser: false,
    background: true,
    ...opts.capabilities,
  };
  const storage = { ...opts.storage };

  const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.join(cwd, p));

  const exec = (cmd: string, { timeoutMs, stdin }: { timeoutMs: number; stdin?: string }): Promise<ExecResult> => {
    return new Promise((resolve) => {
      const env: Record<string, string> = {};
      for (const k of ENV_WHITELIST) {
        const v = process.env[k];
        if (v !== undefined) env[k] = v;
      }
      let output = '';
      let timedOut = false;
      let settled = false;
      const child = spawn('sh', ['-c', cmd], {
        cwd,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
      const finish = (ok: boolean, code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: ok && !timedOut, code: timedOut ? 124 : code, output });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // 已退出
          }
        }
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => {
        if (output.length < MAX_EXEC_OUTPUT) output += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        if (output.length < MAX_EXEC_OUTPUT) output += d.toString('utf8');
      });
      child.on('error', (err) => {
        void err;
        finish(false, -1);
      });
      child.on('close', (code) => {
        finish(code === 0, code ?? -1);
      });
    });
  };

  return {
    capabilities,
    fs: {
      async read(p, o): Promise<ReadResult> {
        const full = resolvePath(p);
        const raw = fs.readFileSync(full, 'utf8');
        const lines = raw.split('\n');
        const total = raw.endsWith('\n') ? lines.length - 1 : lines.length;
        const offset = o?.offset ?? 1;
        const limit = o?.limit ?? 2000;
        const slice = lines.slice(offset - 1, offset - 1 + limit).join('\n');
        return { content: slice, lines: total };
      },
      async write(p, content): Promise<void> {
        const full = resolvePath(p);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      },
      // 原子写——同目录临时文件 + fsync + rename（rename 同文件系统内原子）。
      // 崩溃/断电时要么旧文件要么新文件，绝不出现半截 JSON；并发写也不互吞。
      async writeAtomic(p, content): Promise<void> {
        const full = resolvePath(p);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const tmp = `${full}.tmp-${process.pid}-${Date.now().toString(36)}`;
        const fd = fs.openSync(tmp, 'w');
        try {
          fs.writeFileSync(fd, content, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, full);
      },
      async append(p, content): Promise<void> {
        const full = resolvePath(p);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.appendFileSync(full, content, 'utf8');
      },
      async list(p): Promise<string[]> {
        return fs.readdirSync(resolvePath(p));
      },
      async stat(p): Promise<StatResult> {
        const st = fs.statSync(resolvePath(p));
        return { size: st.size, isDir: st.isDirectory() };
      },
      async glob(pattern): Promise<string[]> {
        return listGlob(cwd, pattern);
      },
      /* 快照清理用（只对数据目录里自己的东西；用户文件走回收站端口） */
      async remove(p): Promise<void> {
        fs.rmSync(resolvePath(p), { recursive: true, force: true });
      },
      async grep(pattern, root, glob): Promise<GrepHit[]> {
        const re = new RegExp(pattern);
        const files = walkFiles(resolvePath(root));
        const out: GrepHit[] = [];
        for (const rel of files) {
          if (glob && !matchGlob(rel, glob)) continue;
          const full = path.join(resolvePath(root), rel);
          let text: string;
          try {
            text = fs.readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          if (text.includes('\0')) continue; // 二进制跳过
          const ls = text.split('\n');
          for (let i = 0; i < ls.length && out.length < 5000; i++) {
            if (re.test(ls[i]!)) out.push({ file: rel, line: i + 1, text: ls[i]! });
          }
        }
        return out;
      },
    },
    exec,
    net: {
      async fetch(url, init): Promise<NetResponse> {
        /* **出站之前**过一道守卫。这是"记忆不出本机"那条底线唯一的落点——
           内核里所有对外请求（抓网页 / 搜索 / 外部服务）都走这里；挡下来时**抛错**，
           由调用方按"这次没发出去"如实回报（绝不静默改成发一个空请求）。
           ⚠ LLM 调用不走这里（适配器直连），所以这道闸管的是"她替你发出去的内容"，
             不是"她跟大脑说的话"——两件事，别混。 */
        if (opts.netGuard) {
          const body = typeof (init as RequestInit | undefined)?.body === 'string'
            ? String((init as RequestInit).body)
            : undefined;
          const verdict = opts.netGuard({ url: String(url), body });
          if (!verdict.ok) throw new Error(`EGRESS_BLOCKED：${verdict.reason}`);
        }
        const res = await fetch(url, init as RequestInit);
        return {
          status: res.status,
          ok: res.ok,
          text: () => res.text(),
          json: () => res.json() as Promise<unknown>,
          // 真流式：把响应体按块解码成文本片段。
          // ⚠ 只在这里做一次 `res.body` 的读取；调用方**要么**用 streamText **要么**用 text()，
          //   两个都调会读到已经流干的身体（适配器里已按"有 stream 就不走整包"分流）。
          ...(res.body
            ? { streamText: () => decodeBody(res.body as ReadableStream<Uint8Array>) }
            : {}),
          url: res.url,
          headers: Object.fromEntries(res.headers.entries()),
        };
      },
      async resolve(host) {
        const { lookup } = await import('node:dns/promises');
        const rows = await lookup(host, { all: true });
        return rows.map((r) => r.address);
      },
    },
    app: {
      async open(nameOrPath) {
        // 路径/应用包 → open 命令；应用名 → osascript launch+activate
        if (nameOrPath.includes('/') || nameOrPath.endsWith('.app')) {
          const r = await exec(`open ${shq(nameOrPath)}`, { timeoutMs: 15000 });
          return { ok: r.ok, output: r.output };
        }
        const r = await exec(
          `${osa(`tell application ${dq(nameOrPath)} to launch`)} ${osa(`tell application ${dq(nameOrPath)} to activate`)}`,
          { timeoutMs: 15000 },
        );
        return { ok: r.ok, output: r.output };
      },
      async activate(name) {
        const r = await exec(osa(`tell application ${dq(name)} to activate`), { timeoutMs: 15000 });
        return { ok: r.ok, output: r.output };
      },
      async clipboard() {
        // 测试钩子：`LHCD_MOCK_CLIPBOARD=<假内容>` → 走桩，**不碰真实剪贴板**。
        // 存在的理由：测试会把剪贴板原文写进审计日志——跑一次测试就等于把
        // 剪贴板内容落到磁盘上，测试不该有这个副作用。
        const stub = process.env.LHCD_MOCK_CLIPBOARD;
        if (stub !== undefined) return { ok: true, content: stub };
        const r = await exec(osa('the clipboard as text'), { timeoutMs: 10000 });
        return r.ok ? { ok: true, content: r.output.trim() } : { ok: false, content: '' };
      },
      async notify(title, body) {
        const r = await exec(osa(`display notification ${dq(body)} with title ${dq(title)}`), { timeoutMs: 10000 });
        return { ok: r.ok, output: r.output };
      },
      async run(script) {
        const r = await exec(osa(script), { timeoutMs: 30000 });
        return { ok: r.ok, output: r.output };
      },
    },
    browser: {
      // TODO(spec)：browser 后置
      async open(_url) { return { ok: false, output: 'browser 未实现（后置）' }; },
      async navigate(_url) { return { ok: false, output: 'browser 未实现（后置）' }; },
      async content() { return { ok: false, output: 'browser 未实现（后置）' }; },
      async screenshot(_p) { return { ok: false, output: 'browser 未实现（后置）' }; },
      async click(_s) { return { ok: false, output: 'browser 未实现（后置）' }; },
      async type(_s, _t) { return { ok: false, output: 'browser 未实现（后置）' }; },
    },
    storage: {
      sessionsDir: () => storage.sessionsDir,
      logsDir: () => storage.logsDir,
      memoryDir: () => storage.memoryDir,
      configDir: () => storage.configDir,
    },
    clock: () => new Date().toISOString(),
    sha256: (input: string) => createHash('sha256').update(input).digest('hex'),
  };
}
