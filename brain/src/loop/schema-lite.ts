// 极简 JSON Schema 校验（零依赖子集，参数校验用）。
// 支持：type=object + properties（string/number/boolean + enum）+ required。
// 不支持的 schema 形态 → 跳过校验（放行）。TODO：mcp 工具复杂 schema 按需扩展。
import type { ToolDef } from '../llm/provider.js';

export interface SchemaLiteError {
  path: string;
  message: string;
}

interface PropSchema {
  type?: string;
  enum?: unknown[];
  description?: string;
  [k: string]: unknown;
}

export function validateArgs(value: unknown, schema: ToolDef['function']['parameters']): SchemaLiteError[] {
  const errs: SchemaLiteError[] = [];
  const s = schema as { type?: string; properties?: Record<string, PropSchema>; required?: string[] };
  if (s.type !== 'object') return errs; // 非对象契约：放行
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path: '$', message: 'args 必须为对象' }];
  }
  const obj = value as Record<string, unknown>;
  for (const req of s.required ?? []) {
    if (!(req in obj)) errs.push({ path: req, message: `缺少必填参数 ${req}` });
  }
  for (const [k, prop] of Object.entries(s.properties ?? {})) {
    const v = obj[k];
    if (v === undefined) continue;
    if (prop.enum) {
      if (!prop.enum.some((e) => e === v)) {
        errs.push({ path: k, message: `${k} 必须为 ${prop.enum.map((e) => JSON.stringify(e)).join('/')} 之一` });
      }
      continue;
    }
    if (prop.type === 'string' && typeof v !== 'string') errs.push({ path: k, message: `${k} 必须为字符串` });
    else if (prop.type === 'number' && typeof v !== 'number') errs.push({ path: k, message: `${k} 必须为数字` });
    else if (prop.type === 'boolean' && typeof v !== 'boolean') errs.push({ path: k, message: `${k} 必须为布尔值` });
  }
  return errs;
}
