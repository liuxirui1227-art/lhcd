// 验证契约单测（证据从哪来 / 过不过怎么判 / confidence 是估计不是事实）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { buildVerificationReport, verifyNudge, type VerifiableSession } from './verify.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-verify-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  return { dir, rt };
}

test('文件证据：写对 → passed；对不上 → failed；没留预期 → unknown', async () => {
  const { dir, rt } = setup();
  fs.writeFileSync(path.join(dir, 'a.txt'), '新内容');
  fs.writeFileSync(path.join(dir, 'b.txt'), '还是旧的');
  const session = {
    runtime: rt,
    mutations: [
      { tool: 'edit', path: path.join(dir, 'a.txt'), at: Date.now(), expect: { newString: '新内容' } },
      { tool: 'edit', path: path.join(dir, 'b.txt'), at: Date.now(), expect: { newString: '应该在但不在' } },
    ],
    turnToolLog: [{ name: 'edit', ok: true }],
  } as unknown as VerifiableSession;
  const r = await buildVerificationReport(session, { attempts: 2 });
  assert.equal(r.evidence.length, 2);
  assert.equal(r.evidence.find((e) => e.target.endsWith('a.txt'))?.status, 'passed');
  assert.equal(r.evidence.find((e) => e.target.endsWith('b.txt'))?.status, 'failed');
  assert.equal(r.passed, false, '有一条失败就不算过');
  assert.ok(r.confidence <= 0.3, `有失败时 confidence 要压低，实际 ${r.confidence}`);

  const noExpect = await buildVerificationReport({ runtime: rt, mutations: [{ tool: 'edit', path: path.join(dir, 'a.txt'), at: Date.now() }] } as unknown as VerifiableSession);
  assert.equal(noExpect.evidence[0]?.status, 'unknown');
  assert.equal(noExpect.passed, false);
});

test('弱证据：没有文件可核时，用"这一轮跑成功的工具"兜底（研究类任务）', async () => {
  const { rt } = setup();
  const r = await buildVerificationReport({ runtime: rt, mutations: [], turnToolLog: [{ name: 'web_search', ok: true }, { name: 'read', ok: true }] } as unknown as VerifiableSession);
  assert.equal(r.evidence.length, 2);
  assert.ok(r.evidence.every((e) => e.type === 'tool-ok' && e.status === 'passed'));
  assert.equal(r.passed, true);
});

test('纯文本回合（没动手）不产出证据 → 不该据此判"没过"（闸门自己会跳过）', async () => {
  const { rt } = setup();
  const r = await buildVerificationReport({ runtime: rt, mutations: [], turnToolLog: [] } as unknown as VerifiableSession);
  assert.equal(r.evidence.length, 0);
  assert.equal(r.passed, false); // 报告本身是"无凭据"；但 turn.ts 只在 didWork 时才拦
  assert.match(verifyNudge(r), /没有留下任何可核对的结果/);
});

test('Office 产物：核产物在 + 原件没被动；原件丢了要报出来', async () => {
  const { dir, rt } = setup();
  fs.writeFileSync(path.join(dir, '改后.docx'), 'x');
  const ok = await buildVerificationReport({
    runtime: rt,
    mutations: [{ tool: 'office', path: path.join(dir, '改后.docx'), at: Date.now(), binary: true, expect: { source: path.join(dir, '原件.docx') } }],
  } as unknown as VerifiableSession);
  assert.ok(ok.evidence.some((e) => e.type === 'office-selfcheck' && e.status === 'passed'));
  assert.ok(ok.evidence.some((e) => e.type === 'file-exists' && e.status === 'failed'), '原件不在要报失败');
  assert.equal(ok.passed, false);

  fs.writeFileSync(path.join(dir, '原件.docx'), 'y');
  const ok2 = await buildVerificationReport({
    runtime: rt,
    mutations: [{ tool: 'office', path: path.join(dir, '改后.docx'), at: Date.now(), binary: true, expect: { source: path.join(dir, '原件.docx') } }],
  } as unknown as VerifiableSession);
  assert.equal(ok2.passed, true);
});

test('confidence：是系统内部估计，全过且没失败工具时最高、磨太久要扣、封顶 0.95', async () => {
  const { dir, rt } = setup();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'ok');
  const good = await buildVerificationReport({ runtime: rt, mutations: [{ tool: 'write', path: path.join(dir, 'a.txt'), at: Date.now(), expect: { content: 'ok' } }], turnToolLog: [{ name: 'write', ok: true }] } as unknown as VerifiableSession, { attempts: 3 });
  assert.ok(good.confidence >= 0.9, String(good.confidence));
  assert.ok(good.confidence <= 0.95, '不许吹成 1.0（那是"事实"的语气了）');
  const long = await buildVerificationReport({ runtime: rt, mutations: [{ tool: 'write', path: path.join(dir, 'a.txt'), at: Date.now(), expect: { content: 'ok' } }], turnToolLog: [{ name: 'write', ok: true }] } as unknown as VerifiableSession, { attempts: 9 });
  assert.ok(long.confidence < good.confidence, '磨了 9 轮才收尾要扣一点');
});
