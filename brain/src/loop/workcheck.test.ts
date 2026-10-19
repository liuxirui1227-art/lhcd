// 改后自检回插（三道护栏 + 真读盘核对）单测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { reviewMutations, workCheckNudge, type FileMutation } from './workcheck.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-workcheck-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { dir, rt };
}

test('write 的改动：重读一致 → 放行；被别的东西改过 → 回插（抓出"没落到盘上"）', async () => {
  const { dir, rt } = setup();
  const f = path.join(dir, 'a.json');
  fs.writeFileSync(f, '{"ok":true}');
  const good: FileMutation[] = [{ tool: 'write', path: f, at: Date.now(), expect: { content: '{"ok":true}' } }];
  assert.equal((await reviewMutations(good, rt)).action, 'allow');

  fs.writeFileSync(f, '{"ok":false}'); // 文件在收尾前被别的东西改了
  const r = await reviewMutations(good, rt);
  assert.equal(r.action, 'continue');
  assert.match(r.problems!.join('；'), /内容和你写进去的不一致/);
});

test('结构性自检：写出非法 JSON / frontmatter 没闭合会被拦（§19）', async () => {
  const { dir, rt } = setup();
  const j = path.join(dir, 'bad.json');
  fs.writeFileSync(j, '{ 这不是 JSON');
  const r1 = await reviewMutations([{ tool: 'write', path: j, at: Date.now(), expect: { content: '{ 这不是 JSON' } }], rt);
  assert.equal(r1.action, 'continue');
  assert.match(r1.problems!.join(), /不是合法 JSON/);

  const md = path.join(dir, 'note.md');
  fs.writeFileSync(md, '---\ntitle: x\n没有结束线');
  const r2 = await reviewMutations([{ tool: 'write', path: md, at: Date.now(), expect: { content: '---\ntitle: x\n没有结束线' } }], rt);
  assert.equal(r2.action, 'continue');
  assert.match(r2.problems!.join(), /frontmatter 没闭合/);
});

test('lint delta（迭代 10）：结构性毛病只报这次新引入的，历史噪音不报', async () => {
  const { dir, rt } = setup();
  // 改前就烂的 JSON：改完还是同样的毛病 → 不报（拿老毛病触发"回插重做"是白烧一轮）
  const legacy = path.join(dir, 'legacy.json');
  fs.writeFileSync(legacy, '{ 这文件本来就烂 改后文字'); // 替换确实落上了（newString 在），只是文件本来就烂
  const quiet = await reviewMutations(
    [{ tool: 'edit', path: legacy, at: Date.now(), expect: { newString: '改后文字', preLint: ['json-invalid'] } }],
    rt,
  );
  assert.equal(quiet.action, 'allow');

  // 这次才写坏的 → 照报
  const fresh = path.join(dir, 'fresh.json');
  fs.writeFileSync(fresh, '{ 这次才写坏 改后文字');
  const r = await reviewMutations(
    [{ tool: 'edit', path: fresh, at: Date.now(), expect: { newString: '改后文字', preLint: [] } }],
    rt,
  );
  assert.equal(r.action, 'continue');
  assert.match(r.problems!.join(), /不是合法 JSON/);
});

test('edit 的改动：旧文字该没了还在 → 回插（"这次替换没落到文件上"）', async () => {
  const { dir, rt } = setup();
  const f = path.join(dir, 'b.txt');
  fs.writeFileSync(f, '新版文字 旧版文字');
  const r = await reviewMutations([{ tool: 'edit', path: f, at: Date.now(), expect: { newString: '新版文字', oldString: '旧版文字', oldCountBefore: 1 } }], rt);
  assert.equal(r.action, 'continue');
  assert.match(r.problems!.join(), /旧文字还在/);
  // 真换掉了 → 放行
  fs.writeFileSync(f, '新版文字');
  assert.equal((await reviewMutations([{ tool: 'edit', path: f, at: Date.now(), expect: { newString: '新版文字', oldString: '旧版文字', oldCountBefore: 1 } }], rt)).action, 'allow');
});

test('office 产物（二进制）：只核在不在 + 原件没被动，不按文本回读', async () => {
  const { dir, rt } = setup();
  const src = path.join(dir, '报告.docx');
  const out = path.join(dir, '报告_改.docx');
  fs.writeFileSync(src, Buffer.from([0x50, 0x4b, 3, 4]));
  fs.writeFileSync(out, Buffer.from([0x50, 0x4b, 3, 4]));
  const m: FileMutation[] = [{ tool: 'office', path: out, at: Date.now(), binary: true, expect: { source: src } }];
  assert.equal((await reviewMutations(m, rt)).action, 'allow');
  fs.rmSync(out);
  const r = await reviewMutations(m, rt);
  assert.equal(r.action, 'continue');
  assert.match(r.problems!.join(), /找不到了/);
});

test('同一文件改多次：只认最后一次（前一次被覆盖是正常的，不该误报）', async () => {
  const { dir, rt } = setup();
  const f = path.join(dir, 'c.txt');
  fs.writeFileSync(f, '第三版');
  const r = await reviewMutations([
    { tool: 'write', path: f, at: 1, expect: { content: '第一版' } },
    { tool: 'write', path: f, at: 2, expect: { content: '第三版' } },
  ], rt);
  assert.equal(r.action, 'allow', JSON.stringify(r.problems));
});

test('护栏③：回插措辞写明"补充意见，不是替代"并要求回到用户原本的请求', () => {
  const n = workCheckNudge(['文件 x 没改到']);
  assert.match(n, /补充意见，不是替代/);
  assert.match(n, /回到用户原本的请求/);
  assert.match(n, /文件 x 没改到/);
});

test('没改过文件 → 什么都不做（不打扰）', async () => {
  const { rt } = setup();
  assert.equal((await reviewMutations([], rt)).action, 'allow');
});
