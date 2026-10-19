// 文件/命令工具单测——read 行号/二进制拒绝；write 备份；edit 双模式；bash 截断；grep/glob。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import type { ExecCtx, ToolEntry } from './registry.js';
import { bashTool } from './bash.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { loadConfig } from '../config/load.js';

function makeCtx(dir: string): ExecCtx {
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return {
    sessionId: 'test',
    cwd: dir,
    runtime: rt,
    config: loadConfig({ cwd: dir, home: dir }),
    policy: undefined,
    memory: undefined,
    emit: () => undefined,
  };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tools-'));
}

async function run(tool: ToolEntry, args: unknown, ctx: ExecCtx) {
  return tool.executor(args, ctx);
}

test('read：行号<TAB>内容 + offset/limit + 二进制拒绝', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), '一\n二\n三\n');
  const r1 = await run(readTool(), { path: 'a.txt' }, ctx);
  assert.equal(r1.ok, true);
  assert.match(r1.output, /1\t一/);
  assert.match(r1.output, /共 3 行/);

  const r2 = await run(readTool(), { path: 'a.txt', offset: 2, limit: 1 }, ctx);
  assert.match(r2.output, /2\t二/);

  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
  const r3 = await run(readTool(), { path: 'bin.dat' }, ctx);
  assert.equal(r3.ok, false);
  assert.equal(r3.error?.code, 'BINARY_FILE');
});

test('write：写入 + 覆盖前备份 .bak', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'w.txt'), 'old');
  const r1 = await run(writeTool(), { path: 'w.txt', content: 'new' }, ctx);
  assert.equal(r1.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(dir, 'w.txt.bak'), 'utf8'), 'old');
});

test('edit 模式A：唯一替换；未找到/非唯一报错', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'e.txt'), 'abc abc\n');
  const r1 = await run(editTool(), { path: 'e.txt', oldString: 'c a', newString: 'X' }, ctx);
  assert.equal(r1.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'e.txt'), 'utf8'), 'abXbc\n');
  assert.equal(fs.readFileSync(path.join(dir, 'e.txt.bak'), 'utf8'), 'abc abc\n');

  const r2 = await run(editTool(), { path: 'e.txt', oldString: 'zzz', newString: 'y' }, ctx);
  assert.equal(r2.error?.code, 'NOT_FOUND');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'bc bc');
  const r3 = await run(editTool(), { path: 'f.txt', oldString: 'bc', newString: 'y' }, ctx);
  assert.equal(r3.error?.code, 'NOT_UNIQUE');
});

test('edit 模式B：行号区间替换 + 非法区间报错', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'e.txt'), 'a\nb\nc\nd\n');
  const r1 = await run(editTool(), { path: 'e.txt', startLine: 2, endLine: 3, replacement: 'X' }, ctx);
  assert.equal(r1.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'e.txt'), 'utf8'), 'a\nX\nd\n');
  const r2 = await run(editTool(), { path: 'e.txt', startLine: 9, endLine: 10, replacement: 'Y' }, ctx);
  assert.equal(r2.error?.code, 'BAD_RANGE');
});

test('edit 降级匹配（迭代 10）：全角引号/破折号不一致也能改，并在结果里回报用了哪一档', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'd.txt'), '他说：“今天先这样。”\n后面还有别的，不许动。\n');
  const r = await run(editTool(), { path: 'd.txt', oldString: '他说:"今天先这样。"', newString: '他说:"今天就到这儿。"' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /标点\/空格归一/); // 回报用了哪一档，便于模型复核
  assert.match(r.output, /请核对/);
  const after = fs.readFileSync(path.join(dir, 'd.txt'), 'utf8');
  assert.match(after, /今天就到这儿/);
  assert.match(after, /后面还有别的，不许动。/); // 只换命中的那一段，其余字节一个不动
});

test('edit 降级匹配也要唯一：归一后两处同形 → 报多处命中，不静默改第一处', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'u.txt'), '第一处“引号”，第二处“引号”。');
  const r = await run(editTool(), { path: 'u.txt', oldString: '"引号"', newString: 'X' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'NOT_UNIQUE');
  assert.match(r.error!.message, /2 处/);
});

test('edit 找不到时回显"你要找的原文"（codex 做法）+ 给下一步', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'n.txt'), '实际内容是这样\n');
  const r = await run(editTool(), { path: 'n.txt', oldString: '我以为是这样的一段话', newString: 'X' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'NOT_FOUND');
  assert.match(r.error!.message, /找不到你要找的这段/);
  assert.match(r.error!.message, /我以为是这样的一段话/); // 回显期望内容
  assert.match(r.error!.message, /多带几行上下文/); // 回显后给出的下一步提示
});

test('edit：A/B 模式必须二选一', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'e.txt'), 'a\n');
  const r = await run(editTool(), { path: 'e.txt' }, ctx);
  assert.equal(r.error?.code, 'BAD_ARGS');
});

test('bash：成功输出 / 非零退出 / 50KB 截断 / 缺 command 报错', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  const r1 = await run(bashTool(), { command: 'echo hello' }, ctx);
  assert.equal(r1.ok, true);
  assert.equal(r1.output.trim(), 'hello');

  const r2 = await run(bashTool(), { command: 'exit 7' }, ctx);
  assert.equal(r2.ok, false);
  assert.match(r2.error?.message ?? '', /7/);

  const big = `head -c 60000 /dev/zero | tr '\\0' 'a'`;
  const r3 = await run(bashTool(), { command: big, timeout: 10 }, ctx);
  assert.equal(r3.ok, true);
  assert.equal(r3.truncated, true);

  const r4 = await run(bashTool(), {}, ctx);
  assert.equal(r4.error?.code, 'BAD_ARGS');
});

test('grep / glob 工具格式化与截断', async () => {
  const dir = tmpdir();
  const ctx = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'g.ts'), 'alpha\nbeta\n');
  const r1 = await run(grepTool(), { pattern: 'alp', path: '.' }, ctx);
  assert.equal(r1.ok, true);
  assert.match(r1.output, /g\.ts:1:alpha/);

  const r2 = await run(globTool(), { pattern: '*.ts' }, ctx);
  assert.equal(r2.ok, true);
  assert.equal(r2.output, 'g.ts');

  const r3 = await run(grepTool(), { pattern: '[', path: '.' }, ctx);
  assert.equal(r3.error?.code, 'BAD_REGEX');
});
