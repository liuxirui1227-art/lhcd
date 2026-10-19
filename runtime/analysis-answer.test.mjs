// 回归单测：截图/文件分析结果播报文案——有答案必播报、没答案明说、失败绝不静默
// 用法：node analysis-answer.test.mjs
import { analysisAnswer } from './lib.mjs';

let n = 0;
const eq = (got, want, label) => {
  n++;
  if (got !== want) throw new Error(`${label}：期望 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`);
};

// 1) 有答案 → 原文播报 + 情绪
eq(analysisAnswer({ ok: true, reply: ' 你在写文档 ', emotion: 'knowledge' }).text, '你在写文档', '有答案取原文');
eq(analysisAnswer({ ok: true, reply: 'x', emotion: 'joy' }).emotion, 'joy', '有答案带情绪');

// 2) ok 但空回复 → 明说没看出
eq(analysisAnswer({ ok: true, reply: '' }).text, '这张截图我看过了，但没看出特别需要说的。', '空回复明说');
eq(analysisAnswer({ ok: true, reply: '   ' }, '这些文件').text, '这些文件我看过了，但没看出特别需要说的。', '空白回复明说（自定义主语）');

// 3) 缺视觉 key → 明确告知，不暴露技术黑话
eq(analysisAnswer({ ok: false, error: 'NO_VISION_KEY' }).emotion, 'sad', '缺 key 情绪');
if (!/看图|视觉/.test(analysisAnswer({ ok: false, error: 'NO_VISION_KEY' }).text)) throw new Error('缺 key 文案未明说不知道');
eq(analysisAnswer({ ok: false, error: 'NO_VISION_PROFILE' }).text, analysisAnswer({ ok: false, error: 'NO_VISION_KEY' }).text, '缺 profile 同文案');

// 4) 其他失败 → 明说分析不了 + 原因
if (!/分析不了/.test(analysisAnswer({ ok: false, error: 'fetch failed' }).text)) throw new Error('失败未明说分析不了');
if (!/fetch failed/.test(analysisAnswer({ ok: false, error: 'fetch failed' }).text)) throw new Error('失败原因未带出');

// 5) 无错误字段失败 → 兜底文案
if (!/分析不了/.test(analysisAnswer({ ok: false }).text)) throw new Error('无 error 字段兜底失败');

console.log(`analysis-answer 播报文案断言 ✅（${n} 项）`);
