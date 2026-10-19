// 禁区（提权不拆墙）。成对用例：该拦的 / 不该误伤的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaselineGuard, DEFAULT_READ_ZONES, normalizePath, gitdirTargetOf } from './baseline.js';
import { PolicyEngine } from './engine.js';
import { DEFAULT_CONFIG, type PermissionsCfg } from '../config/schema.js';

const OPTS = { home: '/Users/me', cwd: '/Users/me/proj' };

function perms(over: Partial<PermissionsCfg> = {}): PermissionsCfg {
  return { ...DEFAULT_CONFIG.permissions, ...over };
}

test('normalizePath：~ 展开、相对路径按 cwd、. 与 .. 折叠', () => {
  assert.equal(normalizePath('~/x', OPTS), '/Users/me/x');
  assert.equal(normalizePath('~', OPTS), '/Users/me');
  assert.equal(normalizePath('a/../b', OPTS), '/Users/me/proj/b');
  assert.equal(normalizePath('/tmp/./x/', OPTS), '/tmp/x');
});

test('禁区判定：命中自身与后代；未存在的路径同样拦', () => {
  const g = new BaselineGuard(['~/.lhcd'], OPTS);
  assert.equal(g.forbiddenPath('~/.lhcd'), '~/.lhcd');
  assert.equal(g.forbiddenPath('~/.lhcd/data/state.json'), '~/.lhcd');
  assert.equal(g.forbiddenPath('/Users/me/.lhcd/nope/not-yet.md'), '~/.lhcd'); // 尚未存在也拦
  assert.equal(g.forbiddenPath('~/.lhcd/../lhcd2/x'), null);
});

test('禁区判定：不该误伤相似路径与普通目录', () => {
  const g = new BaselineGuard(['~/.lhcd'], OPTS);
  for (const p of ['~/.lhcd-backup/x', '~/.lhcd2/x', '~/Documents', '/Users/me/.lhcdx']) {
    assert.equal(g.forbiddenPath(p), null, `不应拦: ${p}`);
  }
});

test('禁区判定：命令文本里提到禁区（~ 形式与展开形式都查）', () => {
  const g = new BaselineGuard(['~/.lhcd'], OPTS);
  assert.equal(g.forbiddenInCommand('cat ~/.lhcd/data/state.json'), '~/.lhcd');
  assert.equal(g.forbiddenInCommand('cp /Users/me/.lhcd/data/seed.enc /tmp/'), '~/.lhcd');
  assert.equal(g.forbiddenInCommand('cat ~/.lhcd-backup/x'), null);
  assert.equal(g.forbiddenInCommand('cat ./README.md'), null);
});

test('提权不拆墙：审批/规则/auto 全放行都改不了"禁不禁"（条 25 验收）', () => {
  const allAllow = perms({
    autonomy: 'auto',
    readZones: ['~/.lhcd'],
    defaults: { ...perms().defaults, read: 'allow', write: 'allow', bash: 'allow' },
    rules: [{ id: 'allow-all', tool: '*', match: '.*', action: 'allow' }],
  });
  const p = new PolicyEngine(allAllow, OPTS);
  // 读/写/列 禁区 → 一律 deny，且规则 id 是 baseline-zone（不是被规则顺走）
  for (const cls of ['read', 'write'] as const) {
    const d = p.check(cls, cls, { path: '~/.lhcd/data/state.json' });
    assert.equal(d.action, 'deny', `${cls} 应被禁区拒绝`);
    assert.equal(d.ruleId, 'baseline-zone');
    assert.ok(d.warning?.includes('禁区'));
  }
  // bash 里提到禁区同样拒（防"用命令绕过文件工具"）
  assert.equal(p.check('bash', 'bash', { command: 'cat ~/.lhcd/data/state.json' }).action, 'deny');
  // 禁区之外照常（不该因为有了禁区就什么都不让干）
  assert.equal(p.check('read', 'read', { path: '~/Documents/a.md' }).action, 'allow');
});

test('迭代 11：系统敏感目录（私钥/口令）也在禁区内，且不该误伤同名前缀', () => {
  const g = new BaselineGuard(['~/.lhcd'], OPTS);
  assert.equal(g.forbiddenPath('~/.ssh/id_rsa'), '~/.ssh');
  assert.equal(g.forbiddenPath('~/Library/Keychains/login.keychain-db'), '~/Library/Keychains');
  assert.equal(g.forbiddenPath('~/.aws/credentials'), '~/.aws');
  // 同名前缀不该误伤
  for (const p of ['~/.ssh-backup/x', '~/Documents/ssh/notes.md', '~/.awsome/x']) {
    assert.equal(g.forbiddenPath(p), null, `不应拦: ${p}`);
  }
});

test('迭代 11：凭据文件按文件名硬拒绝（任何位置）', () => {
  const g = new BaselineGuard(['~/.lhcd'], OPTS);
  assert.equal(g.forbiddenPath('/Users/me/proj/credentials.json'), 'credentials.json'); // 开发态数据目录的洞
  assert.equal(g.forbiddenPath('~/proj/.env'), '.env');
  assert.equal(g.forbiddenPath('~/proj/.env.local'), null); // 只认精确名
  assert.equal(g.forbiddenInCommand('cat runtime/data/credentials.json'), 'credentials.json');
  assert.equal(g.forbiddenInCommand('cat /Users/me/proj/.env'), '.env');
});

test('迭代 11：软链不绕过禁区（realpath 解析后仍要判）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-baseline-'));
  const secret = path.join(home, '.lhcd');
  fs.mkdirSync(secret, { recursive: true });
  const link = path.join(home, 'Documents', 'link');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(secret, link); // 软链指向禁区
  const g = new BaselineGuard(['~/.lhcd'], { home, cwd: home });
  assert.equal(g.forbiddenPath(link), '~/.lhcd', '软链指向禁区必须被拦');
  assert.equal(g.forbiddenPath(path.join(link, 'data', 'state.json')), '~/.lhcd');
  // 正常软链（指向普通目录）不该误伤
  const plain = path.join(home, 'work');
  fs.mkdirSync(plain, { recursive: true });
  const link2 = path.join(home, 'link2');
  fs.symlinkSync(plain, link2);
  assert.equal(g.forbiddenPath(link2), null);
});

test('缺省禁区 = ~/.lhcd（人格/记忆/凭据所在）', () => {
  assert.deepEqual(DEFAULT_READ_ZONES, ['~/.lhcd']);
  const p = new PolicyEngine(perms(), OPTS);
  assert.equal(p.check('read', 'read', { path: '~/.lhcd/data/auth.json' }).ruleId, 'baseline-zone');
});

// ---------- 保留区（.git / .lhcd / .claude / … 放在哪都只读） ----------

test('保留区：任意深度的一段叫 .git 就算——写被拒，读照旧', () => {
  const g = new BaselineGuard(['~/.lhcd'], OPTS);
  const res = (p: string) => g.reservedHit([p])?.zone ?? null;

  // 该拦的：只按 basename 判会全漏（末段分别是 pre-commit / config / x）
  assert.equal(res('~/proj/.git/hooks/pre-commit'), '.git');
  assert.equal(res('~/proj/.git/config'), '.git');
  assert.equal(res('/tmp/wt/.git'), '.git');
  assert.equal(res('~/x/.claude/settings.json'), '.claude');
  assert.equal(res('~/x/.codex/config.toml'), '.codex');
  assert.equal(res('~/x/.agents/a.md'), '.agents');
  assert.equal(res('~/proj/.lhcd/memory/identity.md'), '.lhcd');
  // 尚未存在（先创建再写）同样拦
  assert.equal(res('~/new-proj/.git/hooks/pre-push'), '.git');
});

test('保留区：读不拦（她可能正需要看 .git/config 的远端地址）', () => {
  const p = new PolicyEngine(perms(), OPTS);
  assert.equal(p.check('read', 'read', { path: '~/proj/.git/config' }).action, 'allow');
  assert.equal(p.check('grep', 'read', { path: '~/proj/.git' }).action, 'allow');
});

test('保留区：写/删一律 deny，且"全部放行"也解除不了（ruleId=reserved-zone）', () => {
  const yolo = new PolicyEngine(
    perms({
      autonomy: 'auto',
      defaults: { ...DEFAULT_CONFIG.permissions.defaults, read: 'allow', write: 'allow', bash: 'allow' },
      rules: [{ id: 'allow-all', tool: '*', match: '.*', action: 'allow' }],
    }),
    OPTS,
  );
  const w = yolo.check('write', 'write', { path: '~/proj/.git/hooks/pre-commit', content: 'x' });
  assert.equal(w.action, 'deny');
  assert.equal(w.ruleId, 'reserved-zone');
  assert.ok(w.warning && w.alternative, '拒绝要带"为什么"和"换个办法"');
  assert.equal(yolo.check('delete', 'write', { paths: ['~/proj/.git'] }).action, 'deny');
  assert.equal(yolo.check('edit', 'write', { path: '~/proj/.claude/settings.json' }).action, 'deny');
});

test('保留区：不该误伤的——普通文件、名字像但不同段', () => {
  const p = new PolicyEngine(perms(), OPTS);
  assert.equal(p.check('write', 'write', { path: '~/proj/notes.md' }).action, 'allow');
  assert.equal(p.check('write', 'write', { path: '~/proj/.gitignore' }).action, 'allow');   // 前缀像 .git，不是一段
  assert.equal(p.check('write', 'write', { path: '~/proj/.github/workflows/ci.yml' }).action, 'allow');
  assert.equal(p.check('write', 'write', { path: '~/proj/.claude.md' }).action, 'allow');   // 名字像 .claude
});

test('保留区：真实 git 目录在别处、名字不叫 .git —— 按内容特征也认出来', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-reserved-'));
  const wt = path.join(home, 'proj');
  const realGit = path.join(home, 'repos', 'proj-git'); // 名字里没有 .git：只按名字看是看不出来的
  fs.mkdirSync(path.join(realGit, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(realGit, 'HEAD'), 'ref: refs/heads/main\n'); // 真 git 目录长这样
  fs.mkdirSync(path.join(realGit, 'refs'), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${realGit}\n`); // worktree 的 .git 是**文件**

  const g = new BaselineGuard(['~/.lhcd'], { home, cwd: home });
  assert.equal(g.reservedHit([path.join(realGit, 'hooks', 'pre-commit')])?.zone, '.git');
  assert.equal(g.reservedHit([realGit])?.zone, '.git');
  assert.equal(gitdirTargetOf(wt, { home, cwd: home }), realGit, '指针要解析得出来');
  // 普通过日子不该被连带：工作树里的源码、以及"有 HEAD 但没有 hooks/objects/refs"的目录
  assert.equal(g.reservedHit([path.join(wt, 'src', 'a.ts')]), null);
  const notGit = path.join(home, 'notes');
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, 'HEAD'), 'just a file named HEAD\n');
  assert.equal(g.reservedHit([path.join(notGit, 'a.md')]), null, '只有一个叫 HEAD 的文件不算 git 目录');
});

test('保留区：禁区的祖先不许改名/删除（改个名就能把禁区挪出保护范围）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-anc-'));
  fs.mkdirSync(path.join(home, '.lhcd'), { recursive: true });
  const g = new BaselineGuard(['~/.lhcd'], { home, cwd: home });
  assert.equal(g.reservedHit([home])?.zone, home, '删掉家目录 = 连带删掉 ~/.lhcd');
  assert.equal(g.reservedHit([path.join(home, 'Documents')]), null, '禁区不在里面的目录不误伤');
  // 保留区本身不需要这条（按名字判，改名逃不掉）——这里确认它也没被祖先规则误伤
  assert.equal(g.reservedHit([path.join(home, 'proj', 'a.txt')]), null);
});

// ---------- 单一落点取法（office/media 的落点参数也要进禁区判定） ----------

test('落点取法收成一处：office 的 file/saveAs、media 的 input/inputs 进禁区判定', () => {
  const g = new BaselineGuard(['~/.lhcd'], OPTS);
  assert.equal(g.hitDetail('write', { file: '~/.lhcd/a.docx' })?.zone, '~/.lhcd');
  assert.equal(g.hitDetail('write', { saveAs: '~/.lhcd/out.pdf' })?.zone, '~/.lhcd');
  assert.equal(g.hitDetail('write', { input: '~/.ssh/id_rsa' })?.zone, '~/.ssh');
  assert.equal(g.hitDetail('write', { inputs: ['~/a.mp4', '~/.lhcd/b.mp4'] })?.zone, '~/.lhcd');
  assert.equal(g.hitDetail('write', { path: '~/a.txt' }), null);
});

// ---------- 授权目录（用户可配；空 = 不设边界） ----------

test('授权目录：配了之后，界外的写走审批（是门不是墙）；界内照常', () => {
  const p = new PolicyEngine(perms({ workspaceDirs: ['~/work'] }), OPTS);
  const outside = p.check('write', 'write', { path: '~/Documents/a.md', content: 'x' });
  assert.equal(outside.action, 'ask');
  assert.equal(outside.ruleId, 'outside-workspace');
  assert.ok(outside.warning && outside.alternative, '"门"要说清拦在哪、怎么开');
  assert.equal(p.check('write', 'write', { path: '~/work/a.md', content: 'x' }).action, 'allow');
  assert.equal(p.check('write', 'write', { path: '~/work/sub/deep/a.md', content: 'x' }).action, 'allow');
  // 读不受限（她本来就要读你的文件才能帮你）
  assert.equal(p.check('read', 'read', { path: '~/Documents/a.md' }).action, 'allow');
});

test('授权目录：不配 = 与今天一字不差（别砍正功能）', () => {
  const p = new PolicyEngine(perms(), OPTS);
  assert.equal(p.check('write', 'write', { path: '~/Documents/a.md', content: 'x' }).action, 'allow');
  assert.equal(p.check('write', 'write', { path: '/tmp/a.md', content: 'x' }).action, 'allow');
});

test('授权目录：刀口边界——同名前缀不算界内', () => {
  const p = new PolicyEngine(perms({ workspaceDirs: ['~/work'] }), OPTS);
  assert.equal(p.check('write', 'write', { path: '~/workshop/a.md', content: 'x' }).ruleId, 'outside-workspace');
});

// ---------- bash 侧的两条真绕过（软链 / $HOME 拼路径） ----------

test('bash 侧软链不得绕过禁区（文件工具有 realpath，命令侧以前没有）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bashlink-'));
  fs.mkdirSync(path.join(home, '.lhcd', 'data'), { recursive: true });
  const link = path.join(home, 'tmp-link'); // 名字人畜无害
  fs.symlinkSync(path.join(home, '.lhcd'), link);
  const g = new BaselineGuard(['~/.lhcd'], { home, cwd: home });

  assert.equal(g.forbiddenInCommand(`cat ${link}/data/state.json`), '~/.lhcd', '软链指向禁区必须拦');
  assert.equal(g.forbiddenInCommand(`cat ${home}/tmp-link/data/state.json`), '~/.lhcd');
  // 不该误伤：软链指向普通目录照样能读
  const plain = path.join(home, 'work');
  fs.mkdirSync(plain, { recursive: true });
  const link2 = path.join(home, 'work-link');
  fs.symlinkSync(plain, link2);
  assert.equal(g.forbiddenInCommand(`cat ${link2}/notes.md`), null);
  // 文件工具那条路一直是对的（对照组）
  assert.equal(g.forbiddenPath(`${link}/data/state.json`), '~/.lhcd');
});

test('bash 侧 $HOME / ${HOME} 拼出来的禁区路径要硬拒（以前只到 ask）', () => {
  const g = new BaselineGuard(['~/.lhcd'], OPTS);
  assert.equal(g.forbiddenInCommand('cat $HOME/.lhcd/data/state.json'), '~/.lhcd');
  assert.equal(g.forbiddenInCommand('cat ${HOME}/.lhcd/data/state.json'), '~/.lhcd');
  assert.equal(g.forbiddenInCommand('cat $HOME/.lhcd-backup/x'), null, '相似的目录名不误伤');
  // 逐层判也走这条路（engine 会用整条原文再查一次）
  const p = new PolicyEngine(perms(), OPTS);
  assert.equal(p.check('bash', 'bash', { command: 'cat $HOME/.lhcd/data/state.json' }).ruleId, 'baseline-zone');
});
