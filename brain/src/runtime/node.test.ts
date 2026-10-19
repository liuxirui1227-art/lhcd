// Node Runtime——fs/glob/grep/exec/env 白名单/超时/sha256/storage。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from './node.js';
import { globToRegExp, matchGlob, listGlob } from './glob.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-rt-'));
}

function makeRuntime() {
  const dir = tmpdir();
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { rt, dir };
}

test('globToRegExp：* / ** / ? / {a,b}', () => {
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('x/a.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/deep/a.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a.ts'));
  assert.ok(globToRegExp('a?.ts').test('ab.ts'));
  assert.ok(globToRegExp('a.{ts,js}').test('a.js'));
  assert.ok(!globToRegExp('a.{ts,js}').test('a.css'));
  assert.ok(globToRegExp('exact.txt').test('exact.txt'));
});

test('fs：write/read（offset/limit）/list/stat/glob 排除默认目录', async () => {
  const { rt, dir } = makeRuntime();
  await rt.fs.write('a.txt', 'l1\nl2\nl3\n');
  const r = await rt.fs.read('a.txt');
  assert.equal(r.lines, 3);
  assert.equal(r.content, 'l1\nl2\nl3\n');
  const r2 = await rt.fs.read('a.txt', { offset: 2, limit: 1 });
  assert.equal(r2.content, 'l2');

  await rt.fs.write('src/deep/b.ts', 'x');
  const list = await rt.fs.list('.');
  assert.ok(list.includes('src'));

  const st = await rt.fs.stat('a.txt');
  assert.equal(st.isDir, false);
  const std = await rt.fs.stat('src');
  assert.equal(std.isDir, true);

  const files = await rt.fs.glob('**/*');
  assert.ok(files.includes('a.txt'));
  assert.ok(files.includes('src/deep/b.ts'));
  // 排除默认目录
  await rt.fs.write('node_modules/p/x.js', 'x');
  await rt.fs.write('.git/config', 'x');
  assert.ok(!listGlob(dir, '**/*').includes('node_modules/p/x.js'));
  assert.ok(!listGlob(dir, '**/*').includes('.git/config'));
});

test('grep：正则 + glob 过滤 + 行号 + 二进制跳过', async () => {
  const { rt } = makeRuntime();
  await rt.fs.write('a.ts', 'const x = 1;\nconst y = x;\n');
  await rt.fs.write('b.txt', 'hello x\n');
  const hits = await rt.fs.grep('x', '.', '*.ts');
  assert.deepEqual(hits, [{ file: 'a.ts', line: 1, text: 'const x = 1;' }, { file: 'a.ts', line: 2, text: 'const y = x;' }]);
  const hits2 = await rt.fs.grep('hello', '.');
  assert.equal(hits2.length, 1);
  assert.equal(hits2[0]!.file, 'b.txt');
});

test('exec：成功/失败/超时杀进程', async () => {
  const { rt } = makeRuntime();
  const ok = await rt.exec('echo hi', { timeoutMs: 5000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.output.trim(), 'hi');

  const bad = await rt.exec('exit 3', { timeoutMs: 5000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);

  const timed = await rt.exec('sleep 10', { timeoutMs: 300 });
  assert.equal(timed.ok, false);
  assert.equal(timed.code, 124);
});

test('exec：env 白名单（不允许注入密钥类变量）', async () => {
  const { rt } = makeRuntime();
  process.env.BRAIN_TEST_SECRET = 's3cret';
  try {
    const ok = await rt.exec('echo $BRAIN_TEST_SECRET', { timeoutMs: 5000 });
    assert.equal(ok.output.trim(), ''); // 白名单外变量不可见
  } finally {
    delete process.env.BRAIN_TEST_SECRET;
  }
});

test('sha256 / clock / storage 目录', () => {
  const { rt, dir } = makeRuntime();
  assert.equal(rt.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(!Number.isNaN(Date.parse(rt.clock())));
  assert.equal(rt.storage.sessionsDir(), `${dir}/s`);
  assert.equal(rt.storage.memoryDir(), `${dir}/m`);
});

test('matchGlob 便捷函数', () => {
  assert.ok(matchGlob('src/main.ts', 'src/**/*.ts'));
  assert.ok(!matchGlob('test/main.ts', 'src/**/*.ts'));
});
