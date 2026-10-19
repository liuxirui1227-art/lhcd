// Spec 校验器：以 spec/spec.schema.json（平台↔运行时唯一契约）为准校验任意 JSON。
// 校验失败时返回全部错误路径，供平台签发、设备导入、包解析三端共用。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ajv / ajv-formats 是 export= 风格的 CJS 包，NodeNext 下用 createRequire 加载
const Ajv2020Class: any = require('ajv/dist/2020');
const addFormatsFn: any = require('ajv-formats');
const Ajv2020 = Ajv2020Class.default ?? Ajv2020Class;
const addFormats = addFormatsFn.default ?? addFormatsFn;

// core/src/spec/validate.ts → 仓库根/spec/spec.schema.json
const schemaPath = path.resolve(__dirname, '../../../spec/spec.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv); // 提供 date-time 等标准格式校验
const validateSpec = ajv.compile(schema);
const validateLogEntry = ajv.compile({ $ref: `${schema.$id}#/$defs/logEntry` });

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function toResult(validate: (data: unknown) => boolean, data: unknown): ValidationResult {
  const ok = validate(data);
  return {
    ok,
    errors: ok
      ? []
      : ((validate as any).errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.message ?? ''}`),
  };
}

/** 校验完整 Spec 对象。 */
export function validateSpecObject(data: unknown): ValidationResult {
  return toResult(validateSpec, data);
}

/** 校验单条日志条目（$defs.logEntry）。 */
export function validateLogEntryObject(data: unknown): ValidationResult {
  return toResult(validateLogEntry, data);
}
