// `undo` 工具单测：三条出口都必须是"如实说"，不许假装成功。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeRuntime } from '../runtime/node.js';
import { SnapshotStore } from '../session/snapshots.js';
import { undoTool } from './undo.js';
import type { ExecCtx } from './registry.js';
import type { AgentEvent } from '../session/events.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-undo-'));
  const rt = createNodeRuntime({
    cwd: dir,
    storage: { sessionsDir: `${dir}/s`, logsDir: `${dir}/l`, memoryDir: `${dir}/m`, configDir: `${dir}/c` },
  });
  const store = new SnapshotStore(rt, `${dir}/snapshots`);
  const events: AgentEvent[] = [];
  const ctx = (extra: Partial<ExecCtx> = {}): ExecCtx => ({
    sessionId: 's1', cwd: dir, runtime: rt, config: {} as ExecCtx['config'],
    emit: (ev) => events.push(ev), ...extra,
  });
  return { dir, rt, store, ctx, events };
}

test('没挂快照库 → 如实拒绝（不假装退回去了）', async () => {
  const { ctx } = setup();
  const r = await undoTool().executor({}, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'NO_SNAPSHOTS');
});

test('没有可退的回合 → NOTHING_TO_UNDO', async () => {
  const { ctx, store } = setup();
  const r = await undoTool().executor({}, ctx({ snapshotStore: store }));
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'NOTHING_TO_UNDO');
});

test('改过的写回、新建的送回收站，并在事件里报清三个数', async () => {
  const { dir, rt, store, ctx, events } = setup();
  await rt.fs.write(`${dir}/keep.md`, '改前');
  await store.record('t1', `${dir}/keep.md`, '改前');
  await store.record('t1', `${dir}/made.md`, null);
  await rt.fs.write(`${dir}/keep.md`, '改后');
  await rt.fs.write(`${dir}/made.md`, '新建的');
  const trashed: string[] = [];
  const r = await undoTool().executor({}, ctx({
    snapshotStore: store,
    ports: { trash: { trash: async (p: string) => { trashed.push(p); fs.rmSync(p, { force: true }); } } } as unknown as ExecCtx['ports'],
  }));
  assert.equal(r.ok, true, r.error?.message ?? '');
  assert.equal(fs.readFileSync(`${dir}/keep.md`, 'utf8'), '改前');
  assert.equal(fs.existsSync(`${dir}/made.md`), false);
  assert.deepEqual(trashed, [`${dir}/made.md`]);
  const ev = events.find((e) => e.type === 'undo.done') as Extract<AgentEvent, { type: 'undo.done' }>;
  assert.deepEqual({ r: ev.restored, m: ev.removed, f: ev.failed }, { r: 1, m: 1, f: 0 });
  assert.match(r.output, /写回原样 1 个/);
});

test('没有回收站通道 → **不直接删**，这一项如实记成没退成（其余照常退回）', async () => {
  const { dir, rt, store, ctx } = setup();
  await rt.fs.write(`${dir}/keep.md`, '改前');
  await store.record('t1', `${dir}/keep.md`, '改前');
  await store.record('t1', `${dir}/made.md`, null);
  await rt.fs.write(`${dir}/keep.md`, '改后');
  await rt.fs.write(`${dir}/made.md`, '新建的');
  const r = await undoTool().executor({}, ctx({ snapshotStore: store }));
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(`${dir}/keep.md`, 'utf8'), '改前', '该退回的照常退回');
  assert.equal(fs.existsSync(`${dir}/made.md`), true, '没有回收站就**不许删**（不可逆的事不做）');
  assert.match(r.output, /没退成 1 个/);
  assert.match(r.output, /回收站/);
});
