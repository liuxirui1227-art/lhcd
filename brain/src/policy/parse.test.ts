// 命令结构化（切段 + 剥壳）。成对用例：该拦的 / 不该误伤的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCommand, executableName, splitSegments, splitWords, MAX_SHELL_DEPTH } from './parse.js';
import { checkDanger } from './deny.js';

test('executableName：去目录与扩展名', () => {
  assert.equal(executableName('/bin/rm'), 'rm');
  assert.equal(executableName('rm.exe'), 'rm');
  assert.equal(executableName('./scripts/run.sh'), 'run.sh');
});

test('splitWords：引号内容合成一个词；未闭合引号 → null', () => {
  assert.deepEqual(splitWords("bash -c 'rm -rf /'"), ['bash', '-c', 'rm -rf /']);
  assert.deepEqual(splitWords('cat "a b.txt"'), ['cat', 'a b.txt']);
  assert.deepEqual(splitWords('echo a\\ b'), ['echo', 'a b']);
  assert.equal(splitWords("echo 'unclosed"), null);
});

test('切段：&& || ; | 与换行；多段各自成形', () => {
  const r = splitSegments('git status && rm -rf x');
  assert.equal(r.opaque, false);
  assert.deepEqual(r.segments, ['git status', 'rm -rf x']);
  assert.deepEqual(splitSegments('a; b | c || d && e\nf').segments, ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('opaque：重定向/变量/替换/括号/后台 & → 结构不可信（但照样切段）', () => {
  for (const cmd of ['echo x > /tmp/f', 'echo $HOME', 'ls $(ls)', 'ls `ls`', 'ls (x)', 'a & b', "echo 'unclosed"]) {
    assert.equal(splitSegments(cmd).opaque, true, `应判 opaque: ${cmd}`);
  }
  // 引号里的内容不算 opaque（引号是允许的）
  assert.equal(splitSegments('echo "a > b"').opaque, false);
  assert.equal(analyzeCommand('cat a.txt > out.txt').opaque, true);
});

test('剥壳：sudo/env/bash -c/trap/nohup/timeout/xargs 剥到真命令', () => {
  const inner = (cmd: string) => analyzeCommand(cmd).commands.map((c) => c.inner.join(' '));
  assert.deepEqual(inner('sudo rm -rf x'), ['rm -rf x']);
  assert.deepEqual(inner('sudo -u alice rm -rf x'), ['rm -rf x']);
  assert.deepEqual(inner('env X=1 rm -rf x'), ['rm -rf x']);
  assert.deepEqual(inner('env -i A=b rm -rf x'), ['rm -rf x']);
  assert.deepEqual(inner("bash -c 'rm -rf x'"), ['rm -rf x']);
  assert.deepEqual(inner("sh -lc 'rm -rf x'"), ['rm -rf x']);
  assert.deepEqual(inner('nohup rm -rf x'), ['rm -rf x']);
  assert.deepEqual(inner('timeout 5 rm -rf x'), ['rm -rf x']);
  assert.deepEqual(inner('xargs -0 rm -rf x'), ['rm -rf x']);
  assert.deepEqual(inner('/bin/rm -rf x'), ['/bin/rm -rf x']);
  // trap 的动作串也按命令解析
  assert.ok(inner("trap 'rm -rf x' EXIT").includes('rm -rf x'));
});

test('剥壳：嵌套 shell 递归剥（每层 depth +1）', () => {
  const a = analyzeCommand("bash -c \"bash -c 'rm -rf x'\"");
  assert.deepEqual(a.commands.map((c) => c.inner.join(' ')), ['rm -rf x']);
  assert.equal(a.commands[0]!.depth, 2);
  assert.equal(a.tooDeep, false);
  // 套娃式包装（sudo/nohup）同样层层计入深度
  assert.equal(analyzeCommand('sudo nohup rm -rf x').commands[0]!.depth, 2);
});

test('剥壳：超过 8 层 → tooDeep（剥不完 = 看不清 = 不放行）', () => {
  let cmd = 'rm -rf x';
  for (let i = 0; i <= MAX_SHELL_DEPTH; i++) cmd = `sudo ${cmd}`;
  assert.equal(analyzeCommand(cmd).tooDeep, true);
  assert.equal(analyzeCommand('sudo sudo rm -rf x').tooDeep, false); // 没超就不误判
});

test('剥壳：内层脚本说不清 → 整条 opaque（不能自证安全）', () => {
  const a = analyzeCommand('bash -c "ls $(ls)"');
  assert.equal(a.opaque, true);
});

test('不该误伤：引号里的字样不参与剥壳（echo "rm -rf x" 的真命令是 echo）', () => {
  const a = analyzeCommand('echo "rm -rf /"');
  assert.equal(a.opaque, false); // 引号本身不是 opaque
  assert.deepEqual(a.commands.map((c) => c.inner.join(' ')), ['echo rm -rf /']); // 真命令仍是 echo
});

// watch / setsid 也要剥壳：不在壳清单里时，里面的真命令看不见
test('watch / setsid 也要剥壳（wrappers 补两条）', () => {
  assert.deepEqual(analyzeCommand('watch -n1 rm -rf build').commands.map((c) => c.inner.join(' ')), ['rm -rf build']);
  assert.deepEqual(analyzeCommand('watch -n 1 rm -rf build').commands.map((c) => c.inner.join(' ')), ['rm -rf build']);
  assert.deepEqual(analyzeCommand('setsid rm -rf build').commands.map((c) => c.inner.join(' ')), ['rm -rf build']);
  assert.deepEqual(analyzeCommand('setsid -f rm -rf build').commands.map((c) => c.inner.join(' ')), ['rm -rf build']);
  // 剥壳之后，硬 deny 那道按"可执行名+参数"的判据就看得见它了
  assert.equal(checkDanger('watch -n1 rm -rf build').denied, true);
});
