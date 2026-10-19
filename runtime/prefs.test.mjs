// 回归单测：语音播报开关 + 音色选择持久化（data/state.json）
// 用法：node prefs.test.mjs（独立临时数据目录，不污染 runtime/data）
import fs from 'node:fs';
import path from 'node:path';

const dir = '/tmp/lhcd-prefs-test';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bound: true, intimacy: 0 }));
process.env.LHCD_DATA_DIR = dir;
const lib = await import('./lib.mjs');

let n = 0;
const ok = (cond, label) => { n++; if (!cond) throw new Error(label); };

// 1) 默认偏好：语音开 + 云端自动选音
const d = lib.getPrefs();
ok(d.speechEnabled === true && d.voiceEngine === 'cloud' && d.voiceName === '', '默认偏好（语音开/云端自动）');

// 2) 语音播报关闭 → 持久化 + speak 不合成
const r1 = lib.setPref('speechEnabled', false);
ok(r1.ok && r1.prefs.speechEnabled === false, '关闭语音播报');
const off = await lib.speak('你好呀');
ok(off.ok === false && off.reason === 'SPEECH_OFF', '关闭后 speak 不合成（SPEECH_OFF）');

// 3) 重开 + 系统音色 → speak 返回本地播报指令（零网络）
lib.setPref('speechEnabled', true);
lib.setPref('voiceEngine', 'system');
lib.setPref('voiceName', 'Tingting');
const sys = await lib.speak('你好呀');
ok(sys.ok && sys.engine === 'system' && sys.voice === 'Tingting' && sys.text === '你好呀', '系统音色本地播报指令');

// 4) 云音色手动选择 → voiceName 记录；回云端推荐（voiceName 清空）
lib.setPref('voiceEngine', 'cloud');
lib.setPref('voiceName', 'Jade');
ok(lib.getPrefs().voiceName === 'Jade', '云音色手动选择记录');
lib.setPref('voiceEngine', 'cloud');
lib.setPref('voiceName', '');
ok(lib.getPrefs().voiceName === '' && lib.getPrefs().voiceEngine === 'cloud', '回云端推荐（清空音色名）');

// 5) 非法 key 拒绝 + 未绑定拒绝
ok(lib.setPref('nonsense', 1).ok === false, '非法偏好 key 拒绝');
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({}));
ok(lib.setPref('speechEnabled', true).ok === false, '未绑定拒绝写入');

// 6) 全局显示：默认开，可关并持久化
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bound: true }));
ok(lib.getPrefs().globalVisible === true, '全局显示默认开');
const g = lib.setPref('globalVisible', false);
ok(g.ok && g.prefs.globalVisible === false, '全局显示可关闭');
lib.setPref('globalVisible', true);

// 7) 持久化：state.json 里的 prefs 与 getPrefs 一致
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bound: true }));
lib.setPref('speechEnabled', false);
const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
ok(onDisk.prefs?.speechEnabled === false, '偏好落盘 state.json');

console.log(`prefs 语音开关/音色选择断言 ✅（${n} 项）`);
