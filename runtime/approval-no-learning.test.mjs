// 审批**不学习**。
// 用法：node --test approval-no-learning.test.mjs（或 npm test）；零成本。
//
// 决定：**隐式的"同类动作问过三次就静默放行"已删除**。
//   ① 它的键是 `工具|规则号`、**不含参数**——批准过三条 bash（默认兜底 r3 = `.*`）之后，
//      第四条完全不同的命令也不再问：那不是 Ask once，是"问三次之后这一类全放行"；
//   ② 内存里、从不清理 → 同一会话越用越松，与"越宽越紧"的设计相反；
//   ③ 该省的打扰已有**用户显式选过**的闸门（闲聊不问 / 后台不问 / 三档作用域 / 规则白名单）。
// 想加回"Ask once"，正确形态是**显式**的"以后这类直接允许"（brain 的 proposePrefixRule 已就绪，缺界面按钮）。
//
// 这条测试是**源码守卫**：审批桥住在 main.mjs（Electron 主进程，跑不进 node 测试），
// 所以这里盯住"那段隐式放行没有被谁悄悄加回来"。它比行为测试弱，但比"只写在文档里"强。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, 'main.mjs'), 'utf8');

test('审批桥里没有"问过 N 次就自动放行"的隐式学习', () => {
  // 取审批桥那一段（从 setApprovalBridge 到它结束），只在段内判，避免误伤别处的计数逻辑
  const start = MAIN.indexOf('lib.setApprovalBridge(');
  assert.ok(start > 0, '找不到审批桥');
  const seg = MAIN.slice(start, start + 1200);

  assert.equal(/approvalAllowCounts/.test(seg), false, '隐式计数的 Map 不许回来（见文件里的三条理由）');
  assert.equal(/>= *3/.test(seg), false, '不许出现"累计到 3 就放行"这类判断');
  assert.equal(/return Promise\.resolve\('allow'\);\s*\/\/ *兼容旧开关/.test(seg), true, '兼容旧开关那条要留着（冒烟用）');
  assert.equal(/createPendingApproval\(req\)\.promise/.test(seg), true, '每一问都要真的交给用户');
});
