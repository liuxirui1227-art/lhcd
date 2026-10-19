// 授权目录的设置页**数据层**单测。零成本（不调 LLM、不起窗口）。
// 用法：node --test workspace-dirs.test.mjs（或 npm test）
//
// 这里钉住三件容易做错的事：
//   ① 校验：禁区不能当授权目录（那儿是"墙"，加了也没用，只会让人以为给了）；
//   ② 去重与上限（同一个文件夹 realpath 相同就不许加两遍）；
//   ③ **改完立即生效，且不重建会话**——重建会换一份新 config，SessionStore 的 configHash
//      随之变化 → 宿主那句 `if (loaded && !loaded.configChanged)` 不成立 → **对话历史不续接**。
//      为一次"划范围"丢掉当前对话上下文，代价太大，所以引擎是"判定时现取"这份配置的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-wsdirs-'));
process.env.LHCD_DATA_DIR = DATA;
// 造两个"用户的文件夹"和一个禁区
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-work-'));
const WORK2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lhcd-work2-'));
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ bound: true, prefs: {} }));

const lib = await import('./lib.mjs');

test('空态：不给就是空列表（缺省 = 不设边界）', () => {
  assert.deepEqual(lib.listWorkspaceDirs(), []);
  assert.deepEqual(lib.workspaceDirsForConfig(), []);
});

test('加一个：列表里有名字（最后一段目录名）与完整路径，且落盘', () => {
  const r = lib.addWorkspaceDir(WORK);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dirs.length, 1);
  assert.equal(r.dirs[0].name, path.basename(WORK));
  assert.equal(r.dirs[0].path, path.resolve(WORK));
  assert.equal(r.dirs[0].exists, true);
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  assert.deepEqual(st.workspaceDirs, [path.resolve(WORK)], '要落盘（下次启动还在）');
});

test('上屏形式：家目录下给相对路径（用户第 5 条：不要显示路径），家目录外照原样', () => {
  const home = os.homedir();
  const inside = path.join(home, 'wsd-test-相对');
  fs.mkdirSync(inside, { recursive: true });
  lib.addWorkspaceDir(inside);
  const d = lib.listWorkspaceDirs().find((x) => x.path === inside);
  assert.ok(d, '应当列出来');
  assert.equal(d.display, 'wsd-test-相对', '家目录下要给相对形式（不是 /Users/… 那种）');
  assert.equal(d.path, inside, 'path 仍是绝对路径（动作要用）');
  lib.removeWorkspaceDir(inside);
  fs.rmdirSync(inside);
});

test('禁区不能当授权目录（那是墙，不是门）', () => {
  const zone = path.join(os.homedir(), '.lhcd');
  const r = lib.addWorkspaceDir(zone);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /数据目录/);
});

test('去重与上限：同一个文件夹不许加两遍', () => {
  assert.equal(lib.addWorkspaceDir(WORK).ok, false, '重复加要被拦住');
  assert.equal(lib.addWorkspaceDir('~/../' + path.basename(WORK)).ok, false, '换个写法也认得出是同一个');
  assert.equal(lib.addWorkspaceDir(WORK2).ok, true);
  assert.equal(lib.listWorkspaceDirs().length, 2);
});

test('不存在的路径 / 文件（不是文件夹）都要如实拒绝', () => {
  assert.equal(lib.addWorkspaceDir(path.join(WORK, '并不存在')).ok, false);
  const f = path.join(WORK, 'a.txt');
  fs.writeFileSync(f, 'x');
  assert.equal(lib.addWorkspaceDir(f).ok, false);
});

test('移除：去掉之后就回到空（空 = 不设边界）', () => {
  assert.equal(lib.removeWorkspaceDir(WORK2).ok, true);
  assert.equal(lib.listWorkspaceDirs().length, 1);
  assert.equal(lib.removeWorkspaceDir(WORK).ok, true);
  assert.deepEqual(lib.listWorkspaceDirs(), []);
  assert.deepEqual(lib.workspaceDirsForConfig(), []);
});

test('改完**立即生效**：内核那份配置被原地更新，且**不重建会话**（对话上下文不丢）', async () => {
  // 要有真会话才测得到这件事：先聊一句把 brainCtx 建起来
  fs.writeFileSync(path.join(DATA, 'mock-script.json'), JSON.stringify([[{ type: 'text.delta', text: '好' }, { type: 'done' }]]));
  process.env.LHCD_LLM_MOCK = '1';
  process.env.LHCD_LLM_MOCK_SCRIPT = path.join(DATA, 'mock-script.json');
  if (!fs.existsSync('/tmp/birth-3.json')) throw new Error('缺少 /tmp/birth-3.json（先跑 make-birth-fixture.mjs）');
  lib.importPackageFromPath('/tmp/birth-3.json');
  lib.bind();
  await lib.chat('在吗');

  const ctxBefore = lib._brainForTest();
  assert.ok(ctxBefore?.agent, '这一步之后应当已经有会话了');
  const historyLen = ctxBefore.session.history.length;
  assert.ok(historyLen > 0, '会话里应当有刚才那一轮');

  // 划范围：应当**原地生效**——引擎判定时现取这份配置，不需要重建
  const r = lib.addWorkspaceDir(WORK);
  assert.equal(r.ok, true, r.error);
  const ctxAfter = lib._brainForTest();
  assert.equal(ctxAfter, ctxBefore, '不重建会话（重建会换 config → configHash 变 → 宿主不续接历史）');
  assert.deepEqual(ctxAfter.agent.config.permissions.workspaceDirs, [path.resolve(WORK)],
    '内核那份配置要就地更新（它判定时读的就是这里）');
  assert.equal(ctxAfter.session.history.length, historyLen, '对话历史一条不能少');

  // 清空之后回到"不设边界"（undefined 与空数组同义）
  lib.removeWorkspaceDir(WORK);
  assert.equal(ctxAfter.agent.config.permissions.workspaceDirs, undefined);
});
