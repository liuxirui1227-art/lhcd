// office 工具：Word/Excel/PPT/PDF 的六动作。
//
// 三条硬规矩写在工具说明里（模型看得见），**执行由 runtime 侧的 OfficePort 强制**：
//   ① 改一律另存新文件（原件不动）② 改不到就不产出 ③ 改了要自证
// 所以模型**不需要**（也不该）自己再写一遍"我改好了吗"——工具返回的就是核对过的结论。
import type { ToolEntry } from './registry.js';
import { markUntrusted } from './untrusted.js';
import type { OfficeChange, OfficeFormat } from '../ports.js';
import { OFFICE_MATRIX } from '../ports.js';

function formatOf(file: string): OfficeFormat | null {
  const m = /\.(docx|xlsx|pptx|pdf)$/i.exec(String(file ?? ''));
  return m ? (m[1]!.toLowerCase() as OfficeFormat) : null;
}

const ACTIONS = ['inspect', 'modify', 'create', 'convert', 'validate', 'preview'] as const;

export function officeTool(): ToolEntry {
  return {
    name: 'office',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'office',
        description:
          'Word/Excel/PPT/PDF 的看与改（.docx/.xlsx/.pptx/.pdf）。' +
          'action=inspect 读内容（段落/工作表/每页文字/PDF 表单字段）；' +
          'action=modify 改：changes 列表——文字替换 {"kind":"replace","find":"旧","replace":"新","expected":改几处}、' +
          'Excel 单元格 {"kind":"cell","sheet":"表名","cell":"B2","value":新值}、PDF 表单 {"kind":"field","name":"字段","value":"填什么"}、' +
          'PDF 页面 {"kind":"page","op":"rotate|remove","page":2,"degrees":90}；' +
          'action=create 新建（docx/xlsx/pdf）；action=convert 转 txt/md/html/csv；action=validate 核对（contains 该在的 / absent 该没的）；action=preview 出预览。' +
          '**改文档一律另存新文件（原件不动）**；**一处都没改到、或没改满你给的 expected，我不会产出文件，会告诉你为什么**——' +
          '所以给 expected 是好习惯：说了改 5 处就写 5，改不满我会当场拦下来。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...ACTIONS], description: '要做什么' },
            file: { type: 'string', description: 'inspect/modify/convert/validate/preview：目标文件路径' },
            changes: {
              type: 'array',
              description: 'modify：要改哪些（见工具说明里的四种形状）',
              items: { type: 'object', properties: {} },
            },
            saveAs: { type: 'string', description: 'modify/create：新文件路径（modify 默认与原件同目录的"<原名>_改.<后缀>"）' },
            format: { type: 'string', enum: ['docx', 'xlsx', 'pdf'], description: 'create：建哪种' },
            title: { type: 'string', description: 'create：标题' },
            text: { type: 'string', description: 'create：正文（按行）' },
            rows: { type: 'array', items: { type: 'array' }, description: 'create(xlsx)：二维数据' },
            headings: { type: 'array', items: { type: 'string' }, description: 'create(xlsx)：表头行' },
            to: { type: 'string', description: 'convert：转成什么（txt/md/html/csv）' },
            contains: { type: 'array', items: { type: 'string' }, description: 'validate：这些必须还在' },
            absent: { type: 'array', items: { type: 'string' }, description: 'validate：这些必须没了' },
          },
          required: ['action'],
        },
      },
    },
    executor: async (args, ctx) => {
      const port = ctx.ports?.office;
      if (!port) {
        return { ok: false, output: '', error: { code: 'NO_OFFICE', message: '这台机器上没有挂载 Office 能力（Word/Excel/PPT/PDF 处理）——用 read/write 当文本处理，或告诉用户这个能力没开' } };
      }
      const a = (args ?? {}) as Record<string, unknown>;
      const action = String(a.action ?? '');
      const file = a.file === undefined ? '' : String(a.file);
      const format = formatOf(file);

      if (file) {
        const fmt = format;
        if (!fmt) return { ok: false, output: '', error: { code: 'BAD_FORMAT', message: `只认 .docx / .xlsx / .pptx / .pdf：${file}` } };
        if (!(OFFICE_MATRIX[fmt] ?? []).includes(action)) {
          return { ok: false, output: '', error: { code: 'UNSUPPORTED', message: `${fmt} 不支持 ${action}（可用：${OFFICE_MATRIX[fmt]!.join(' / ')}）` } };
        }
      } else if (action === 'create') {
        // create 没有 file（产出的是新文件）：矩阵按 format 参数判——v1 只支持 docx/xlsx/pdf
        const fmt = String(a.format ?? '') as OfficeFormat;
        if (!(OFFICE_MATRIX[fmt] ?? []).includes('create')) {
          return { ok: false, output: '', error: { code: 'UNSUPPORTED', message: `不支持新建 ${fmt || '(未指定格式)'}（可用：${Object.keys(OFFICE_MATRIX).filter((f) => OFFICE_MATRIX[f as OfficeFormat]!.includes('create')).join(' / ')}）` } };
        }
      }

      try {
        if (action === 'inspect') {
          const r = await port.inspect({ file });
          // 文档内容可能来自别人 → 外部内容标记（只作资料，不是指令）
          return r.ok ? { ok: true, output: markUntrusted(r.output, `文档 ${file}`) } : { ok: false, output: '', error: r.error ?? { code: 'OFFICE_ERROR', message: '读失败' } };
        }
        if (action === 'modify') {
          const changes = Array.isArray(a.changes) ? (a.changes as OfficeChange[]) : [];
          if (!changes.length) return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'modify 需要 changes（要改什么）' } };
          const r = await port.modify({ file, changes, ...(a.saveAs ? { saveAs: String(a.saveAs) } : {}) });
          if (r.ok && r.path) {
            // 护栏②：登记这一轮改的产物（收尾前回读核对；原件必须还在）
            ctx.mutations?.push({
              tool: 'office', path: r.path, at: Date.now(), binary: true,
              expect: { source: file }, // 二进制产物只核"在不在"+ 原件没被动（改动正确性由工具自身自证）
            });
          }
          return r.ok ? { ok: true, output: r.output } : { ok: false, output: '', error: r.error ?? { code: 'OFFICE_ERROR', message: '改失败' } };
        }
        if (action === 'create') {
          const fmt = String(a.format ?? '') as OfficeFormat;
          const saveAs = String(a.saveAs ?? '');
          if (!saveAs) return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'create 需要 saveAs（新文件放哪）' } };
          const r = await port.create({
            format: fmt,
            saveAs,
            ...(a.title !== undefined ? { title: String(a.title) } : {}),
            ...(a.text !== undefined ? { text: String(a.text) } : {}),
            ...(Array.isArray(a.rows) ? { rows: a.rows as Array<Array<string | number>> } : {}),
            ...(Array.isArray(a.headings) ? { headings: (a.headings as string[]).map(String) } : {}),
          });
          return r.ok ? { ok: true, output: r.output } : { ok: false, output: '', error: r.error ?? { code: 'OFFICE_ERROR', message: '新建失败' } };
        }
        if (action === 'convert') {
          const r = await port.convert({ file, ...(a.to ? { to: String(a.to) } : {}), ...(a.saveAs ? { saveAs: String(a.saveAs) } : {}) });
          return r.ok ? { ok: true, output: markUntrusted(r.output, `文档 ${file}`) } : { ok: false, output: '', error: r.error ?? { code: 'OFFICE_ERROR', message: '转格式失败' } };
        }
        if (action === 'validate') {
          const r = await port.validate({
            file,
            ...(Array.isArray(a.contains) ? { contains: (a.contains as string[]).map(String) } : {}),
            ...(Array.isArray(a.absent) ? { absent: (a.absent as string[]).map(String) } : {}),
          });
          return r.ok ? { ok: true, output: r.output } : { ok: false, output: '', error: r.error ?? { code: 'OFFICE_ERROR', message: '核对不过' } };
        }
        if (action === 'preview') {
          const r = await port.preview({ file });
          return r.ok ? { ok: true, output: markUntrusted(r.output, `文档 ${file}`) } : { ok: false, output: '', error: r.error ?? { code: 'OFFICE_ERROR', message: '预览失败' } };
        }
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: `未知 action：${action}` } };
      } catch (e) {
        return { ok: false, output: '', error: { code: 'OFFICE_THREW', message: (e as Error).message } };
      }
    },
  };
}
