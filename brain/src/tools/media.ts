// media 工具：图片/视频的看与改——合并/截取/转格式/压缩/缩放/裁剪/旋转/水印/拼图/抽帧/GIF/抽音轨。
//
// 设计同 office 工具：
//   · 库/二进制在 runtime 侧（随包 ffmpeg），brain 只声明 MediaPort；没挂载就**如实拒绝**
//   · **改一律另存新文件**（原件不动）；**改不成就不产出**；**产出后自检**（时长/分辨率/大小对不上就报错）
//   · 拿不准就说拿不准（比如"这些片段的编码不一样，合起来会花屏，要不要我先统一转一遍"）
import type { ToolEntry } from './registry.js';
import type { MediaOp } from '../ports.js';

const ACTIONS = ['info', 'merge', 'trim', 'convert', 'compress', 'resize', 'crop', 'rotate', 'watermark', 'montage', 'thumbnail', 'gif', 'extract_audio'] as const;

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function mediaTool(): ToolEntry {
  return {
    name: 'media',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'media',
        description:
          '图片/视频的看与改（照片、录屏、家庭视频都算）。' +
          'action=info 看它是什么（多大多长、什么编码）；' +
          'action=merge 把几段拼成一段（inputs 按顺序给；**同来源的片段默认秒合不重编码**）；' +
          'action=trim 截一段（from/to 秒）；action=convert 转格式（按 saveAs 扩展名）；' +
          'action=compress 压小（level: light/standard/strong）；action=resize 缩放（width/height 给一个即可）；' +
          'action=crop 裁剪（width/height/x/y）；action=rotate 旋转（90/180/270）；' +
          'action=watermark 加水印（text 或 image，position: tl/tr/bl/br）；' +
          'action=montage 把多张图拼成一张（columns 几列）；action=thumbnail 抽一帧当封面（atSec 秒）；' +
          'action=gif 转成动图（fromSec/toSec/fps/width）；action=extract_audio 把声音抽出来。' +
          '**改过的文件一律另存为新文件（原件不动）**；**做完我会自己核对**（时长/尺寸对不上就说没成）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...ACTIONS], description: '要做什么' },
            input: { type: 'string', description: '输入文件（单文件操作用）' },
            inputs: { type: 'array', items: { type: 'string' }, description: 'merge/montage：按顺序给多个输入' },
            saveAs: { type: 'string', description: '产物路径（缺省自动起名，如 xxx_剪辑.mp4，放在原文件旁边）' },
            from: { type: 'number', description: 'trim：从第几秒开始' },
            to: { type: 'number', description: 'trim：到第几秒结束' },
            fromSec: { type: 'number', description: 'gif：从第几秒开始' },
            toSec: { type: 'number', description: 'gif：到第几秒结束' },
            atSec: { type: 'number', description: 'thumbnail：抽第几秒的帧（缺省 1 秒）' },
            width: { type: 'number', description: 'resize/crop/gif：宽' },
            height: { type: 'number', description: 'resize/crop：高' },
            x: { type: 'number', description: 'crop：左上角横坐标' },
            y: { type: 'number', description: 'crop：左上角纵坐标' },
            degrees: { type: 'number', description: 'rotate：90 / 180 / 270' },
            text: { type: 'string', description: 'watermark：水印文字' },
            image: { type: 'string', description: 'watermark：水印图片路径' },
            position: { type: 'string', enum: ['tl', 'tr', 'bl', 'br'], description: 'watermark：位置（左上/右上/左下/右下）' },
            columns: { type: 'number', description: 'montage：几列' },
            fps: { type: 'number', description: 'gif：每秒几帧（缺省 12）' },
            level: { type: 'string', enum: ['light', 'standard', 'strong'], description: 'compress：压到什么程度' },
            reencode: { type: 'boolean', description: 'merge/trim：是否强制重编码（片段编码不一致时用）' },
          },
          required: ['action'],
        },
      },
    },
    executor: async (args, ctx) => {
      const port = ctx.ports?.media;
      if (!port) {
        return { ok: false, output: '', error: { code: 'NO_MEDIA', message: '这台机器上没有挂载图片/视频能力——告诉用户这个能力没开，别硬来' } };
      }
      const a = (args ?? {}) as Record<string, unknown>;
      const action = String(a.action ?? '');
      const input = a.input === undefined ? '' : String(a.input);
      const saveAs = a.saveAs === undefined ? undefined : String(a.saveAs);
      const inputs = Array.isArray(a.inputs) ? (a.inputs as unknown[]).map(String).filter(Boolean) : [];

      // 先探引擎：没引擎就**如实拒绝**（不假装成功）——图片也走它（跨平台一致）
      const engine = await port.available();
      if (!engine.ffmpeg) {
        return { ok: false, output: '', error: { code: 'NO_ENGINE', message: '我这边没有可用的图片/视频引擎（随包的 ffmpeg 没找到）——如实告诉用户，别假装处理了' } };
      }

      let op: MediaOp;
      switch (action) {
        case 'info':
          if (!input) return bad('info 需要 input');
          return await port.info({ file: input });
        case 'merge':
          if (inputs.length < 2) return bad('merge 至少要两段（inputs 按顺序给）');
          op = { kind: 'merge', inputs, saveAs: saveAs ?? '' , ...(a.reencode !== undefined ? { reencode: a.reencode === true } : {}) };
          break;
        case 'trim': {
          const from = num(a.from);
          const to = num(a.to);
          if (!input || from === undefined || to === undefined || to <= from) return bad('trim 需要 input 与 from/to（秒，且 to 要大于 from）');
          op = { kind: 'trim', input, from, to, saveAs: saveAs ?? '', ...(a.reencode !== undefined ? { reencode: a.reencode === true } : {}) };
          break;
        }
        case 'convert':
          if (!input || !saveAs) return bad('convert 需要 input 与 saveAs（要转成什么看扩展名）');
          op = { kind: 'convert', input, saveAs };
          break;
        case 'compress':
          if (!input) return bad('compress 需要 input');
          op = { kind: 'compress', input, level: (a.level as 'light' | 'standard' | 'strong') ?? 'standard', ...(saveAs ? { saveAs } : {}) };
          break;
        case 'resize': {
          const w = num(a.width); const h = num(a.height);
          if (!input || (w === undefined && h === undefined)) return bad('resize 需要 input 和 width 或 height（给一个即可，另一个按比例）');
          op = { kind: 'resize', input, ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}), ...(saveAs ? { saveAs } : {}) };
          break;
        }
        case 'crop': {
          const w = num(a.width); const h = num(a.height); const x = num(a.x) ?? 0; const y = num(a.y) ?? 0;
          if (!input || w === undefined || h === undefined) return bad('crop 需要 input 与 width/height（x/y 缺省 0）');
          op = { kind: 'crop', input, width: w, height: h, x, y, ...(saveAs ? { saveAs } : {}) };
          break;
        }
        case 'rotate': {
          const deg = num(a.degrees);
          if (!input || (deg !== 90 && deg !== 180 && deg !== 270)) return bad('rotate 需要 input 与 degrees（90/180/270）');
          op = { kind: 'rotate', input, degrees: deg as 90 | 180 | 270, ...(saveAs ? { saveAs } : {}) };
          break;
        }
        case 'watermark':
          if (!input || (!a.text && !a.image)) return bad('watermark 需要 input 与 text 或 image');
          op = {
            kind: 'watermark', input,
            ...(a.text ? { text: String(a.text) } : {}),
            ...(a.image ? { image: String(a.image) } : {}),
            ...(a.position ? { position: a.position as 'tl' | 'tr' | 'bl' | 'br' } : {}),
            ...(saveAs ? { saveAs } : {}),
          };
          break;
        case 'montage':
          if (inputs.length < 2) return bad('montage 至少要两张图');
          op = { kind: 'montage', inputs, ...(num(a.columns) !== undefined ? { columns: num(a.columns)! } : {}), saveAs: saveAs ?? '' };
          break;
        case 'thumbnail':
          if (!input) return bad('thumbnail 需要 input');
          op = { kind: 'thumbnail', input, ...(num(a.atSec) !== undefined ? { atSec: num(a.atSec)! } : {}), ...(saveAs ? { saveAs } : {}) };
          break;
        case 'gif':
          if (!input) return bad('gif 需要 input');
          op = {
            kind: 'gif', input,
            ...(num(a.fromSec) !== undefined ? { fromSec: num(a.fromSec)! } : {}),
            ...(num(a.toSec) !== undefined ? { toSec: num(a.toSec)! } : {}),
            ...(num(a.fps) !== undefined ? { fps: num(a.fps)! } : {}),
            ...(num(a.width) !== undefined ? { width: num(a.width)! } : {}),
            ...(saveAs ? { saveAs } : {}),
          };
          break;
        case 'extract_audio':
          if (!input) return bad('extract_audio 需要 input');
          op = { kind: 'extract_audio', input, ...(saveAs ? { saveAs } : {}) };
          break;
        default:
          return bad(`未知 action：${action}（可用：${ACTIONS.join(' / ')}）`);
      }

      try {
        const r = await port.run(op);
        return r.ok ? { ok: true, output: r.output } : { ok: false, output: '', error: r.error ?? { code: 'MEDIA_ERROR', message: '没做成' } };
      } catch (e) {
        return { ok: false, output: '', error: { code: 'MEDIA_THREW', message: (e as Error).message } };
      }

      function bad(message: string) {
        return { ok: false as const, output: '', error: { code: 'BAD_ARGS', message } };
      }
    },
  };
}
