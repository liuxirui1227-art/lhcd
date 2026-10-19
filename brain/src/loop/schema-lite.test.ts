// 参数 schema 轻量校验（required / 类型 / enum / 非对象）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from './schema-lite.js';

const schema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    timeout: { type: 'number', default: 60 },
    mode: { type: 'string', enum: ['open', 'activate'] },
    verbose: { type: 'boolean' },
  },
  required: ['path'],
} as const;

test('合法参数无错误', () => {
  assert.deepEqual(validateArgs({ path: 'a', timeout: 3, mode: 'open', verbose: true }, schema), []);
});

test('缺必填 / 类型不符 / enum 越界', () => {
  const errs = validateArgs({ timeout: 'x', mode: 'other' }, schema);
  assert.ok(errs.some((e) => e.path === 'path' && /必填/.test(e.message)));
  assert.ok(errs.some((e) => e.path === 'timeout' && /数字/.test(e.message)));
  assert.ok(errs.some((e) => e.path === 'mode' && /open/.test(e.message)));
});

test('args 非对象 → 单条错误', () => {
  const errs = validateArgs('oops', schema);
  assert.equal(errs.length, 1);
  assert.equal(errs[0]!.path, '$');
});

test('非 object 契约 → 放行（不误杀复杂 schema）', () => {
  assert.deepEqual(validateArgs({}, { type: 'array' }), []);
});
