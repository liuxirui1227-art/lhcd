// 预构建检查（秒开优化）：dist 已存在则跳过 tsc 构建（npm start 快路径）；
// 缺失时再构建 core+brain（首次/源码更新后手动 npm run build 亦可）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const needBuild = !fs.existsSync(path.join(root, '..', 'core', 'dist')) || !fs.existsSync(path.join(root, '..', 'brain', 'dist'));
if (!needBuild) {
  console.log('prestart: dist 已就绪（秒开快路径，跳过构建）');
  process.exit(0);
}
console.log('prestart: dist 缺失，构建 core+brain …');
for (const pkg of ['core', 'brain']) {
  const r = spawnSync('npm', ['--prefix', path.join(root, '..', pkg), 'run', 'build'], {
    stdio: 'inherit',
    env: { ...process.env, npm_config_allow_scripts: '' }, // npm 12 EALLOWSCRIPTS 规避（与既有约定一致）
  });
  if (r.status !== 0) {
    console.error(`prestart: ${pkg} 构建失败`);
    process.exit(r.status ?? 1);
  }
}
console.log('prestart: 构建完成');
