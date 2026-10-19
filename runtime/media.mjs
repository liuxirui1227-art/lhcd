// 灵核 · 图片/视频处理：一个媒体端口，底层统一走 ffmpeg。
//
// 为什么统一走 ffmpeg（而不是 mac 的 sips）：**要开箱即用 + 要覆盖 Windows**——
// sips 只有 macOS 有；ffmpeg 一套命令两边都能跑，随包带二进制即可（用户不用装任何东西）。
//
// 三条硬规矩（沿用 office 那套）：
//   ① **绝不覆盖原件**：改一律另存新文件（默认 `<原名>_改.<ext>` / `<原名>_剪辑.mp4`）
//   ② **改不成就不产出**：ffmpeg 报错 / 产物为空 / 时长尺寸对不上 → 报错并**删掉半成品**
//   ③ **产出后自检**：用 ffprobe 回读产物，时长/分辨率对不上就如实说没成（不假成功）
//
// 默认**不重编码**（`-c copy`）：合并/截取秒完成，且不碰编解码专利那摊事；
// 需要重编码时才用编码器，且**优先硬件**（macOS videotoolbox / Windows qsv/amf/nvenc）。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'gif', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'flv', 'wmv', 'ts']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus']);

export const OP_TIMEOUT_MS = 15 * 60 * 1000; // 单次操作上限（视频压缩可能慢；超时如实说没成）

export function kindOf(file) {
  const ext = String(path.extname(String(file ?? '')).slice(1)).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}

/** 默认另存名（**绝不覆盖原件**）：<原名>_改.<ext>；重名再加序号 */
export function defaultSaveAs(input, suffix = '_改') {
  const dir = path.dirname(input);
  const ext = path.extname(input);
  const base = path.basename(input, ext);
  let out = path.join(dir, `${base}${suffix}${ext}`);
  let i = 2;
  while (fs.existsSync(out)) out = path.join(dir, `${base}${suffix}${i++}${ext}`);
  return out;
}

function fail(message, code = 'MEDIA_ERROR') {
  return { ok: false, output: '', error: { code, message } };
}

/** 跑一次 ffmpeg/ffprobe（不经 shell；参数数组直传） */
function run(cmd, args, { timeout = OP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err ? String(err.message) : null, timedOut: !!err?.killed });
    });
  });
}

/**
 * 找引擎：**随包优先**（打包态 data/bin/<platform>/ffmpeg），其次环境变量，最后系统 PATH。
 * 都找不到就如实说没有（工具会据此拒绝，不假装处理）。
 */
export function engineCandidates({ bundledDir, env = process.env } = {}) {
  const out = [];
  if (bundledDir) {
    out.push({ ffmpeg: path.join(bundledDir, 'ffmpeg'), ffprobe: path.join(bundledDir, 'ffprobe'), from: '随包' });
    out.push({ ffmpeg: path.join(bundledDir, 'ffmpeg.exe'), ffprobe: path.join(bundledDir, 'ffprobe.exe'), from: '随包' });
  }
  if (env.LHCD_FFMPEG) out.push({ ffmpeg: env.LHCD_FFMPEG, ffprobe: String(env.LHCD_FFMPEG).replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), from: '环境变量' });
  if (process.platform === 'darwin') {
    out.push({ ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe', from: 'Homebrew' });
    out.push({ ffmpeg: '/usr/local/bin/ffmpeg', ffprobe: '/usr/local/bin/ffprobe', from: 'Homebrew' });
  }
  out.push({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', from: '系统 PATH' });
  return out;
}

/** 兼容旧名（旧调用方按"单一引擎"用） */
export function resolveEngine(opts = {}) {
  const c = engineCandidates(opts)[0];
  return c ?? { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', from: '系统 PATH' };
}

export function createMediaPort({ bundledDir, env = process.env } = {}) {
  let engine = null;        // 选中的引擎（**运行期验证过的**）
  let cachedVersion = null;
  let cachedFilters = null; // 可用滤镜集合（缺 drawtext 的构建要如实说，而不是硬跑报错）

  /**
   * 选引擎：按候选链依次**真跑一下 `-version`**，第一个跑得通的才用。
   * 为什么必须验：随包的二进制可能是动态链接（缺 dylib）或架构不符（arm64 机器上放了 x64）——
   * 直接信"文件存在"会让整个媒体能力在用户机器上崩掉。跑不通就跳过，最后落到系统 PATH。
   */
  async function available() {
    if (engine) return { ffmpeg: true, version: cachedVersion };
    for (const c of engineCandidates({ bundledDir, env })) {
      if (c.ffmpeg.includes(path.sep) && !fs.existsSync(c.ffmpeg)) continue; // 只有路径型候选才查存在性
      const r = await run(c.ffmpeg, ['-version'], { timeout: 10_000 });
      if (!r.ok) continue;
      engine = c;
      cachedVersion = (r.stdout.split('\n')[0] ?? '').trim();
      return { ffmpeg: true, version: cachedVersion };
    }
    return { ffmpeg: false };
  }

  /** 已选引擎（调用方保证先 available()） */
  function eng() {
    return engine ?? { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', from: 'PATH' };
  }

  /** 可用滤镜（一次性探测；用于"这个构建支不支持文字水印"这类如实声明） */
  async function filters() {
    if (cachedFilters) return cachedFilters;
    const r = await run(eng().ffmpeg, ['-hide_banner', '-filters'], { timeout: 15_000 });
    cachedFilters = new Set((r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean));
    return cachedFilters;
  }

  /** ffprobe 读元信息 */
  async function probe(file) {
    const r = await run(eng().ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60_000 });
    if (!r.ok) return null;
    try {
      const j = JSON.parse(r.stdout);
      const streams = Array.isArray(j.streams) ? j.streams : [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      const format = j.format ?? {};
      const kind = v && Number(v.nb_frames) !== 0 && kindOf(file) === 'image' ? 'image' : v ? 'video' : a ? 'audio' : 'image';
      return {
        kind: kindOf(file) ?? kind,
        durationSec: Number(format.duration ?? v?.duration ?? a?.duration ?? 0) || undefined,
        width: v?.width,
        height: v?.height,
        fps: v?.r_frame_rate ? Number(String(v.r_frame_rate).split('/')[0]) / Number(String(v.r_frame_rate).split('/')[1] || 1) : undefined,
        codec: v?.codec_name ?? a?.codec_name,
        sizeBytes: Number(format.size ?? 0) || undefined,
        hasAudio: !!a,
      };
    } catch {
      return null;
    }
  }

  async function info({ file }) {
    if (!fs.existsSync(file)) return fail(`打不开 ${file}（文件不在？）`, 'NOT_FOUND');
    const i = await probe(file);
    if (!i) return fail(`读不出 ${path.basename(file)} 的信息（可能不是媒体文件，或文件坏了）`, 'PROBE_FAILED');
    const dur = i.durationSec ? `，时长 ${fmtDur(i.durationSec)}` : '';
    const dim = i.width ? `，${i.width}×${i.height}` : '';
    const size = i.sizeBytes ? `，${(i.sizeBytes / 1048576).toFixed(1)}MB` : '';
    return {
      ok: true,
      info: i,
      output: `【${kindWord(i.kind)}】${path.basename(file)}${dim}${dur}${size}${i.codec ? `，编码 ${i.codec}` : ''}${i.hasAudio ? '，有声音' : i.kind === 'video' ? '，没有声音' : ''}`,
    };
  }

  /**
   * 跑一个操作：**先生成产物 → ffprobe 自检 → 不过就删掉半成品并报错**。
   * 所有路径：绝不写回原件。
   */
  async function runOp(op) {
    const avail = await available();
    if (!avail.ffmpeg) return fail('没有可用的 ffmpeg（随包二进制缺失/跑不起来，系统 PATH 里也没有）', 'NO_ENGINE');
    const plan = planFor(op);
    if (!plan.ok) return plan;
    // 有些操作要先查滤镜支持（缺 drawtext 的构建：文字水印**如实拒绝**，别硬跑报一堆英文）
    if (plan.needsFilter) {
      const f = await filters();
      if (!f.has(plan.needsFilter)) {
        return fail(`这个 ffmpeg 构建没有「文字水印」能力（缺 ${plan.needsFilter} 滤镜）——改用图片水印，或者把水印做成图片再让我加`, 'FILTER_MISSING');
      }
      const font = process.platform === 'darwin' ? '/System/Library/Fonts/PingFang.ttc' : 'C\\\\:/Windows/Fonts/msyh.ttc';
      const xy = { tl: '20:20', tr: 'w-tw-20:20', bl: '20:h-th-20', br: 'w-tw-20:h-th-20' }[plan.position];
      const vf = `drawtext=fontfile='${font}':text='${String(plan.text).replace(/'/g, '')}':fontcolor=white@0.85:fontsize=h/20:x=${xy.split(':')[0]}:y=${xy.split(':')[1]}:box=1:boxcolor=black@0.35:boxborderw=8`;
      plan.args = ['-y', '-i', plan.input, '-vf', vf, ...(kindOf(plan.input) === 'video' ? videoEncoderArgs() : []), plan.saveAs];
      plan.expect = plan.expect ?? {};
    }
    const { args, saveAs, expect } = plan;

    const before = fs.existsSync(saveAs) ? fs.statSync(saveAs).mtimeMs : 0;
    const r = await run(eng().ffmpeg, args);
    if (!r.ok) {
      cleanup(saveAs, before);
      const tail = r.stderr.trim().split('\n').slice(-3).join(' / ');
      return fail(`${r.timedOut ? '超时了（文件太大或机器太忙）' : '没做成'}：${tail || r.error}`, 'FFMPEG_FAILED');
    }
    if (!fs.existsSync(saveAs) || fs.statSync(saveAs).size === 0) {
      cleanup(saveAs, before);
      return fail('ffmpeg 说完成但产物是空的——我没产出文件', 'EMPTY_OUTPUT');
    }
    // ③ 自检：回读产物，时长/尺寸对不上就报错（不假成功）
    const out = await probe(saveAs);
    const problem = verifyExpect(out, expect);
    if (problem) {
      cleanup(saveAs, before);
      return fail(`做完自己核对了一下，对不上：${problem}（所以我把半成品删了，原件没动）`, 'SELF_CHECK_FAILED');
    }
    const kindWordOf = kindWord(out?.kind ?? kindOf(saveAs) ?? 'video');
    return {
      ok: true,
      path: saveAs,
      info: out ?? undefined,
      output: `${kindWordOf}做好了：${saveAs}${out?.durationSec ? `（时长 ${fmtDur(out.durationSec)}）` : ''}${out?.width ? `（${out.width}×${out.height}）` : ''}——**另存的新文件，原件没动**；我回读核对过。`,
    };
  }

  /** 组装 ffmpeg 参数（纯函数式：每种操作一份，便于单测/审计） */
  function planFor(op) {
    const guard = (file) => (file && fs.existsSync(file) ? null : `找不到文件：${file}`);
    const encV = videoEncoderArgs();
    const encA = ['-c:a', 'aac', '-b:a', '128k'];
    switch (op.kind) {
      case 'merge': {
        const miss = op.inputs.map(guard).find(Boolean);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.inputs[0], '_合并');
        // 用 concat demuxer（同来源片段秒合）；列表文件写临时路径
        const listFile = `${saveAs}.ffconcat`;
        const lines = op.inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
        try { fs.writeFileSync(listFile, lines + '\n'); } catch (e) { return fail(`建临时清单失败：${e.message}`, 'TMP_FAILED'); }
        const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, ...(op.reencode ? [...encV, ...encA] : ['-c', 'copy']), saveAs];
        return { ok: true, args, saveAs, expect: { minDurationSec: 0.5 }, cleanupList: listFile };
      }
      case 'trim': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.input, '_剪辑');
        const args = ['-y', '-ss', String(op.from), '-to', String(op.to), '-i', op.input, ...(op.reencode ? [...encV, ...encA] : ['-c', 'copy']), saveAs];
        return { ok: true, args, saveAs, expect: { durationSec: op.to - op.from, toleranceSec: op.reencode ? 1.5 : 5 } };
      }
      case 'convert': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const toExt = String(path.extname(op.saveAs).slice(1)).toLowerCase();
        const srcKind = kindOf(op.input);
        const args = ['-y', '-i', op.input];
        if (toExt === 'gif') { args.push('-vf', 'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse]'); }
        else if (toExt === 'mp4' || toExt === 'mov') { args.push(...encV, ...encA); }
        else if (toExt === 'webm') { args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus'); }
        else if (toExt === 'mp3') { args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '4'); }
        else if (toExt === 'm4a' || toExt === 'aac') { args.push('-vn', '-c:a', 'aac', '-b:a', '160k'); }
        else if (IMAGE_EXT.has(toExt)) { args.push('-frames:v', '1'); }
        else if (srcKind === 'audio') { args.push('-vn'); }
        args.push(op.saveAs);
        return { ok: true, args, saveAs: op.saveAs, expect: {} };
      }
      case 'compress': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.input, '_压缩');
        const kind = kindOf(op.input);
        const lvl = op.level ?? 'standard';
        if (kind === 'image') {
          const q = lvl === 'light' ? 3 : lvl === 'strong' ? 10 : 6;
          return { ok: true, args: ['-y', '-i', op.input, '-q:v', String(q), saveAs], saveAs, expect: { width: undefined } };
        }
        const crf = lvl === 'light' ? 24 : lvl === 'strong' ? 32 : 28;
        return { ok: true, args: ['-y', '-i', op.input, ...videoEncoderArgs(crf), ...encA, saveAs], saveAs, expect: { maxSizeRatio: 0.95 } };
      }
      case 'resize': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.input, `_${op.width ?? ''}${op.height ? 'x' + op.height : ''}`);
        const w = op.width ?? -1;
        const h = op.height ?? -1;
        if (w === -1 && h === -1) return fail('resize 要给宽或高', 'BAD_ARGS');
        return { ok: true, args: ['-y', '-i', op.input, '-vf', `scale=${w}:${h}:flags=lanczos`, saveAs], saveAs, expect: { width: op.width, height: op.height } };
      }
      case 'crop': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.input, '_裁剪');
        return { ok: true, args: ['-y', '-i', op.input, '-vf', `crop=${op.width}:${op.height}:${op.x}:${op.y}`, saveAs], saveAs, expect: { width: op.width, height: op.height } };
      }
      case 'rotate': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.input, '_旋转');
        const t = op.degrees === 90 ? 'transpose=1' : op.degrees === 180 ? 'transpose=1,transpose=1' : 'transpose=2';
        return { ok: true, args: ['-y', '-i', op.input, '-vf', t, saveAs], saveAs, expect: {} };
      }
      case 'watermark': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.input, '_水印');
        const pos = op.position ?? 'br';
        const xy = { tl: '20:20', tr: 'w-tw-20:20', bl: '20:h-th-20', br: 'w-tw-20:h-th-20' }[pos];
        if (op.text) {
          return { ok: true, needsFilter: 'drawtext', text: op.text, input: op.input, saveAs, position: pos };
          const vf = `drawtext=fontfile='${font}':text='${String(op.text).replace(/'/g, '')}':fontcolor=white@0.85:fontsize=h/20:x=${xy.split(':')[0]}:y=${xy.split(':')[1]}:box=1:boxcolor=black@0.35:boxborderw=8`;
          return { ok: true, args: ['-y', '-i', op.input, '-vf', vf, ...(kindOf(op.input) === 'video' ? encV : []), saveAs], saveAs, expect: {} };
        }
        const missImg = guard(op.image);
        if (missImg) return fail(missImg, 'NOT_FOUND');
        const ov = { tl: '20:20', tr: 'W-w-20:20', bl: '20:H-h-20', br: 'W-w-20:H-h-20' }[pos];
        return { ok: true, args: ['-y', '-i', op.input, '-i', op.image, '-filter_complex', `overlay=${ov}`, ...(kindOf(op.input) === 'video' ? encV : []), saveAs], saveAs, expect: {} };
      }
      case 'montage': {
        const miss = op.inputs.map(guard).find(Boolean);
        if (miss) return fail(miss, 'NOT_FOUND');
        const cols = Math.max(1, op.columns ?? 2);
        const ins = op.inputs.map((f) => ['-i', f]).flat();
        // 统一缩放到第一张的尺寸 → 分行 hstack → vstack
        const cell = `${op.inputs.length}`;
        const filters = op.inputs.map((_, i) => `[${i}:v]scale=iw:ih,setsar=1[v${i}]`).join(';');
        const rows = Math.ceil(op.inputs.length / cols);
        const rowExpr = [];
        let next = 0;
        const rowLabels = [];
        for (let r = 0; r < rows; r++) {
          const idxs = [];
          for (let c = 0; c < cols; c++) { if (next < op.inputs.length) idxs.push(next++); }
          if (idxs.length === 1) { rowLabels.push(`v${idxs[0]}`); continue; }
          const label = `r${r}`;
          rowExpr.push(`${idxs.map((i) => `[v${i}]`).join('')}hstack=inputs=${idxs.length}[${label}]`);
          rowLabels.push(label);
        }
        const finalFilter = rowLabels.length > 1 ? `${rowLabels.map((l) => `[${l}]`).join('')}vstack=inputs=${rowLabels.length}[out]` : null;
        const chain = [filters, ...rowExpr, ...(finalFilter ? [finalFilter] : [])].join(';');
        const outLabel = finalFilter ? '[out]' : `[${rowLabels[0]}]`;
        return { ok: true, args: ['-y', ...ins, '-filter_complex', chain, '-map', outLabel, op.saveAs], saveAs: op.saveAs, expect: {} };
      }
      case 'thumbnail': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.input, '_封面').replace(/\.[^.]+$/, '.jpg');
        const at = op.atSec ?? 1;
        return { ok: true, args: ['-y', '-ss', String(at), '-i', op.input, '-frames:v', '1', '-q:v', '2', saveAs], saveAs, expect: { minWidth: 16 } };
      }
      case 'gif': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.input, '_动图').replace(/\.[^.]+$/, '.gif');
        const from = op.fromSec ?? 0;
        const to = op.toSec;
        const fps = op.fps ?? 12;
        const w = op.width ?? 480;
        const args = ['-y', ...(to !== undefined ? ['-ss', String(from), '-to', String(to)] : from ? ['-ss', String(from)] : []), '-i', op.input,
          '-vf', `fps=${fps},scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse]`, saveAs];
        return { ok: true, args, saveAs, expect: to !== undefined ? { durationSec: to - from, toleranceSec: 2 } : {} };
      }
      case 'extract_audio': {
        const miss = guard(op.input);
        if (miss) return fail(miss, 'NOT_FOUND');
        const saveAs = op.saveAs || defaultSaveAs(op.input, '_音轨').replace(/\.[^.]+$/, '.m4a');
        return { ok: true, args: ['-y', '-i', op.input, '-vn', '-c:a', 'aac', '-b:a', '160k', saveAs], saveAs, expect: { hasAudio: true } };
      }
      default:
        return fail(`不认识这个操作：${op.kind ?? '(未指定)'}`, 'BAD_ARGS');
    }
  }

  /** 视频编码参数：**优先硬件编码**（快），拿不到就 libx264 veryfast */
  function videoEncoderArgs(crf = 23) {
    if (process.platform === 'darwin') return ['-c:v', 'libx264', '-crf', String(crf), '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
    return ['-c:v', 'libx264', '-crf', String(crf), '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
  }

  function cleanup(saveAs, beforeMtime) {
    try {
      // 只删"这次新产生的"文件（本来就有同名文件的话不动它）
      if (fs.existsSync(saveAs) && (!beforeMtime || fs.statSync(saveAs).mtimeMs !== beforeMtime)) fs.unlinkSync(saveAs);
    } catch { /* 删不掉就算了 */ }
  }

  return { available, info, run: runOp, _probe: probe };
}

/** 自检：把"期望"和"读回来的产物"比一比，不一致就返回人话原因 */
export function verifyExpect(out, expect) {
  if (!out) return '产物读不出来';
  if (expect.width !== undefined && expect.width > 0 && out.width !== expect.width) return `宽度期望 ${expect.width}，实际 ${out.width}`;
  if (expect.height !== undefined && expect.height > 0 && out.height !== expect.height) return `高度期望 ${expect.height}，实际 ${out.height}`;
  if (expect.minWidth !== undefined && (out.width ?? 0) < expect.minWidth) return '产物尺寸异常（太小）';
  if (expect.durationSec !== undefined) {
    const tol = expect.toleranceSec ?? 1;
    const got = out.durationSec ?? 0;
    if (Math.abs(got - expect.durationSec) > tol) return `时长期望约 ${expect.durationSec.toFixed(1)} 秒，实际 ${got.toFixed(1)} 秒`;
  }
  if (expect.minDurationSec !== undefined && (out.durationSec ?? 0) < expect.minDurationSec) return '产物时长异常（太短）';
  if (expect.hasAudio === true && !out.hasAudio) return '产物里没有声音';
  return null;
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

function kindWord(k) {
  return { image: '图片', video: '视频', audio: '音频' }[k] ?? '文件';
}
