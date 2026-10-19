// 生产守卫（hooks 的第一条真实配置）——宿主侧单测。
// 用法：node --test hook-guard.test.mjs（或 npm test）；零成本（不调 LLM、不联网）。
//
// 覆盖三件事：
//   ① 守卫脚本本身：该拦的拦（exit 2）、该放的放（exit 0）——成对用例，防"把墙砌到正功能上"；
//   ② **两份名单同源**：脚本里的保留区名字必须与内核 `PROTECTED_INNER_NAMES` 一字不差
//      （名单一漂移这里就红——两层判断，一个真源）；
//   ③ 宿主装载：ensureHookGuard() 把随包守卫落到数据目录（真路径、可执行），且 hooks 配置指得到它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, 'hooks', 'pre-tool-guard.sh');

// ⚠ lib.mjs 在 import 时就会建数据目录/读 state —— 必须**先**把数据目录指到临时目录
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-hook-guard-'));
process.env.LHCD_DATA_DIR = DATA;
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ bound: true, prefs: {} }));

const lib = await import('./lib.mjs');
const brain = await import('../brain/dist/index.js');

/** 按真实约定喂事件：JSON 走 stdin，看退出码（2 = 阻断） */
function runGuard(command) {
  const event = {
    type: 'tool.call', seq: 1, id: 'c1', name: 'bash', args: { command },
  };
  const r = spawnSync('sh', [GUARD], { input: JSON.stringify(event), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

test('守卫：该拦的——用命令行改保留区（写动作 + 保留区落点）', () => {
  const cases = [
    'cp evil.sh .git/hooks/pre-commit',
    'echo "#!/bin/sh" > /Users/me/proj/.git/hooks/post-checkout',
    'sed -i s/x/y/ ~/proj/.git/config',
    'git config core.hooksPath /tmp/evil',
    'rm -rf .git/hooks',
    'chmod +x .git/hooks/pre-push',
    'python3 -c "open(\'.claude/settings.json\',\'w\')"',
    'echo x >> ~/.codex/config.toml',
    'tee ~/.agents/a.md',
    'mv ~/.lhcd/memory/identity.md /tmp/x',
  ];
  for (const c of cases) {
    const r = runGuard(c);
    assert.equal(r.code, 2, `应当拦下：${c}（实际退出码 ${r.code}）`);
    assert.match(r.out, /保留区|core\.hooksPath/, `拦下时要说清为什么：${c}`);
  }
});

test('守卫：不该拦的——只读、以及正常干活（别把墙砌到正功能上）', () => {
  const cases = [
    'ls .git/hooks',                       // 看一眼
    'cat .git/config',                     // 读远端地址
    'grep -r hooks .git/',                 // 翻一翻
    'git config --get core.hooksPath',     // 看当前钩子路径
    'git config --list',                   // 列配置
    'git status',
    'npm test',
    'echo hi > /tmp/note.txt',             // 写普通文件（重定向词在，但落点不是保留区）
    'cp a.txt b.txt',
    'sed -i s/x/y/ README.md',
    'cat .gitignore',                      // 名字像 .git，不是保留区
    'ls .github/workflows',                // 前缀像，不是一段
    'echo "改 .claude.md 里的说明"',        // 提到名字，但没有写动作 + 不是那个路径
  ];
  for (const c of cases) {
    const r = runGuard(c);
    assert.equal(r.code, 0, `不该拦：${c}（退出码 ${r.code}｜${r.out}）`);
  }
});

test('两份名单同源：脚本里的保留区 == 内核 PROTECTED_INNER_NAMES', () => {
  const body = fs.readFileSync(GUARD, 'utf8');
  // 脚本里 `\.(claude|codex|agents|lhcd)/` 那行是唯一的名单来源，逐名做集合比对
  const m = /\\\.\(([a-z|]+)\)\//.exec(body);
  assert.ok(m, '找不到脚本里的保留区名单');
  const inScript = new Set(m[1].split('|').map((s) => `.${s}`));
  assert.match(body, /\\\.git\/hooks/, '脚本要盯着 .git/hooks');
  assert.match(body, /\\\.git\/config/, '脚本要盯着 .git/config（core.hooksPath 在另一条）');
  inScript.add('.git');
  const inKernel = new Set(brain.PROTECTED_INNER_NAMES);
  assert.deepEqual(
    [...inScript].sort(),
    [...inKernel].sort(),
    '两层判断共用一个真源：名单漂移了（改内核就要改脚本，反之亦然）',
  );
});

test('宿主装载：守卫落到数据目录（真路径，sh 读得到）', () => {
  const dst = lib.ensureHookGuard();
  assert.ok(dst, 'ensureHookGuard 应返回装好的路径');
  assert.ok(fs.existsSync(dst), `守卫要真的落到磁盘：${dst}`);
  assert.ok(dst.startsWith(DATA), '要落在数据目录里（打包态 asar 里的文件外部进程读不到）');
  assert.equal(fs.readFileSync(dst, 'utf8'), fs.readFileSync(GUARD, 'utf8'), '内容与随包那份一致');
  // 装出来的那一份照样能拦（不是只测了随包那份）
  const r = spawnSync('sh', [dst], { input: JSON.stringify({ type: 'tool.call', args: { command: 'cp x .git/hooks/pre-commit' } }), encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('授权目录：宿主透传（state > 环境变量；都不给 = 不设边界）', () => {
  assert.deepEqual(lib.workspaceDirsForConfig(), [], '默认什么都不给 → 空 = 不设边界（今天的行为不变）');
  process.env.LHCD_WORKSPACE_DIRS = ['/Users/me/work', '/tmp/scratch'].join(path.delimiter);
  assert.deepEqual(lib.workspaceDirsForConfig(), ['/Users/me/work', '/tmp/scratch']);
  // state 里配了就优先（将来设置页写的就是这里）
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ bound: true, prefs: {}, workspaceDirs: ['/Users/me/proj'] }));
  assert.deepEqual(lib.workspaceDirsForConfig(), ['/Users/me/proj']);
  delete process.env.LHCD_WORKSPACE_DIRS;
});

test('随包装配：守卫在 stage 清单里（漏了它 = 打包态守卫直接失效）', () => {
  // 为什么单独立一条：这个仓库被同一类坑绊过——`credentials.mjs` 是 lib.mjs 的静态导入却没进
  // 装配清单，打包态启动即 ERR_MODULE_NOT_FOUND。守卫更隐蔽：**不报错**，只是打包后不再拦人。
  // 而且它一度放在 runtime/data/ 下（那整片被 .gitignore 忽略）——既不进仓库也不进 dmg。
  const stage = fs.readFileSync(path.join(HERE, 'scripts', 'stage-app.mjs'), 'utf8');
  assert.match(stage, /copy\('hooks',\s*'app\/hooks'\)/, 'stage-app 必须装配 hooks/');
  const lib = fs.readFileSync(path.join(HERE, 'lib.mjs'), 'utf8');
  assert.match(lib, /path\.join\(__dirname, 'hooks', 'pre-tool-guard\.sh'\)/, 'lib.mjs 要按 app/hooks 找它');
  assert.ok(fs.existsSync(GUARD), '守卫脚本本体在 runtime/hooks/');
});
