// 记忆三工具：remember / recall / forget。记忆写入只经 memory 服务（红线）。
import type { ToolEntry } from './registry.js';
import type { MemoryService } from '../memory/service.js';
import { filterDomains, domainAccess, classifyDomain, type Domain } from '../lifecycle/facets.js';
import { truncateToTokens } from '../prompt/tokens.js';
import { IDENTITY_MAX } from '../memory/identity.js';

export function rememberTool(): ToolEntry {
  return {
    name: 'remember',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'remember',
        description: '保存一条长期记忆（按 scope+key 唯一，覆盖旧值）。用于记住用户偏好、事实、决策。domain 为数据域标签（schedule/emotion_log/work_log/private_diary），缺省自动分类。scope=identity 表示**用户明说的长期规矩**（"以后一直这样对我"）——只有用户明确要求长期如此时才用，别把一次小事升格成长期要求；identity 时按内容去重，key 用不上。',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', description: 'global（全局）/ project（当前项目）/ identity（用户明说的长期规矩）' },
            key: { type: 'string', description: '记忆唯一标识，如 user.preferred_language' },
            content: { type: 'string', description: '记忆内容（不超过 500 token）' },
            domain: { type: 'string', enum: ['schedule', 'emotion_log', 'work_log', 'private_diary'], description: '数据域标签；缺省按内容自动分类' },
          },
          required: ['scope', 'key', 'content'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { scope?: unknown; key?: unknown; content?: unknown; domain?: unknown };
      if (typeof a.key !== 'string' || !a.key || typeof a.content !== 'string' || !a.content) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'scope/key/content 必填' } };
      }
      // Identity 层：**用户定过的长期规矩** —— 单独一条路，
      // 进的是 memory/identity.md（一条一行，人能直接改），不是语义记忆。
      if (a.scope === 'identity') {
        const m = ctx.memory as MemoryService | undefined;
        if (!m) return { ok: false, output: '', error: { code: 'NO_MEMORY', message: '记忆层未挂载' } };
        const r = await m.identity.add(String(a.content), 'user-request');
        if (r.action === 'full') {
          // 满了**如实说**（不静默丢老规矩）——规矩多了等于没规矩，该由用户来删
          return { ok: false, output: '', error: { code: 'IDENTITY_FULL', message: `长期规矩最多 ${IDENTITY_MAX} 条，已经满了：请先在「我的 TA」里删掉不再作数的，再加新的` } };
        }
        if (r.action === 'redacted') return { ok: false, output: '', error: { code: 'MEMORY_REDACTED', message: '内容疑似含敏感信息（密钥/密码等），已拒绝写入' } };
        if (r.action === 'empty') return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'content 不能为空' } };
        ctx.emit({ type: 'memory.write', scope: 'identity', key: String(a.key), action: r.action === 'update' ? 'overwrite' : 'write' });
        return {
          ok: true,
          output: r.action === 'update'
            ? `这条长期规矩你说过，我按新的措辞记下了（共 ${r.count} 条）`
            : `记住了，以后一直这样（共 ${r.count} 条长期规矩）`,
        };
      }
      const scope = a.scope === 'project' ? 'project' : 'global';
      const memory = ctx.memory as MemoryService | undefined;
      if (!memory) {
        return { ok: false, output: '', error: { code: 'NO_MEMORY', message: '记忆层未挂载' } };
      }
      // 写路径权限校验（权限矩阵收口）——侧面只写本域（rw），companion 全读写
      const domain: Domain = ['schedule', 'emotion_log', 'work_log', 'private_diary'].includes(String(a.domain))
        ? String(a.domain) as Domain
        : classifyDomain(a.content);
      const facet = ctx.facet ?? 'companion';
      if (domainAccess(domain, facet) !== 'rw') {
        return { ok: false, output: '', error: { code: 'FACET_DENIED', message: `当前侧面无 ${domain} 域写入权限（只读或无权）` } };
      }
      const content = truncateToTokens(a.content, 500).text;
      const r = await memory.remember({ scope, key: a.key, content, domain, source: ctx.sessionId });
      const action = r.action;
      ctx.emit({ type: 'memory.write', scope, key: a.key, action: action === 'overwrite' ? 'overwrite' : action === 'redacted' ? 'redacted' : 'write' });
      if (action === 'redacted') {
        return { ok: false, output: '', error: { code: 'MEMORY_REDACTED', message: '内容疑似含敏感信息（密钥/密码等），已拒绝写入' } };
      }
      return { ok: true, output: `已记住 [${scope}] ${a.key}（${action === 'overwrite' ? '覆盖旧值' : '新增'}）` };
    },
  };
}

export function recallTool(): ToolEntry {
  return {
    name: 'recall',
    permissionClass: 'read',
    schema: {
      type: 'function',
      function: {
        name: 'recall',
        description: '主动检索长期记忆。用于需要确认已记住的信息时。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词' },
            max: { type: 'number', description: '最多返回条数（默认 8）' },
          },
          required: ['query'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { query?: unknown; max?: unknown };
      if (typeof a.query !== 'string') {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'query 必填' } };
      }
      const memory = ctx.memory as MemoryService | undefined;
      if (!memory) return { ok: false, output: '', error: { code: 'NO_MEMORY', message: '记忆层未挂载' } };
      const max = typeof a.max === 'number' && a.max >= 1 ? Math.floor(a.max) : 8;
      // 分区过滤：先多取再按当前侧面权限域过滤（未打标条目按 schedule 域可见性：所有侧面可读）
      const facet = ctx.facet ?? 'companion';
      // 混合召回：向量可用走向量路径，缺省走关键词+图谱+时间衰减+重要性（BM25 保底不消失）
      const hits = memory.embedder
        ? await memory.searchHybrid(a.query, max + 8, { embed: memory.embedder })
        : await memory.searchHybrid(a.query, max + 8);
      const visible = filterDomains(
        hits.map((h) => ({ domain: h.entry.domain ?? 'schedule', ...h.entry })),
        facet,
      );
      const kept = hits.filter((h) => visible.some((v) => v.name === h.entry.name)).slice(0, max);
      return { ok: true, output: memory.render(kept) };
    },
  };
}

export function forgetTool(): ToolEntry {
  return {
    name: 'forget',
    permissionClass: 'write',
    exclusive: true,
    schema: {
      type: 'function',
      function: {
        name: 'forget',
        description: '删除一条长期记忆（用于纠正过时/错误信息）。',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', description: 'global / project / identity（长期规矩）' },
            key: { type: 'string', description: '要删除的记忆标识；scope=identity 时这里填**那条规矩的原文**' },
          },
          required: ['scope', 'key'],
        },
      },
    },
    executor: async (args, ctx) => {
      const a = (args ?? {}) as { scope?: unknown; key?: unknown };
      if (typeof a.key !== 'string' || !a.key) {
        return { ok: false, output: '', error: { code: 'BAD_ARGS', message: 'key 必填' } };
      }
      const scope = a.scope === 'project' ? 'project' : 'global';
      const memory = ctx.memory as MemoryService | undefined;
      if (!memory) return { ok: false, output: '', error: { code: 'NO_MEMORY', message: '记忆层未挂载' } };
      // Identity 层：删规矩（用户说"以后不用这样了"）——按原文匹配，key 就是那句话
      if (a.scope === 'identity') {
        const gone = await memory.identity.removeByText(a.key);
        if (!gone) return { ok: false, output: '', error: { code: 'NOT_FOUND', message: `没找到这条长期规矩：${a.key}` } };
        ctx.emit({ type: 'memory.write', scope: 'identity', key: a.key, action: 'delete' });
        return { ok: true, output: `好了，这条规矩不作数了：${a.key}` };
      }
      // 删除路径同样过权限矩阵（与 remember 对齐）——侧面无权删除他域记忆
      const existing = await memory.get(a.key);
      const domain: Domain = existing?.domain ?? 'schedule';
      const facet = ctx.facet ?? 'companion';
      if (domainAccess(domain, facet) !== 'rw') {
        return { ok: false, output: '', error: { code: 'FACET_DENIED', message: `当前侧面无 ${domain} 域删除权限` } };
      }
      const ok = await memory.forget(a.key);
      if (!ok) return { ok: false, output: '', error: { code: 'NOT_FOUND', message: `记忆 ${a.key} 不存在` } };
      ctx.emit({ type: 'memory.write', scope, key: a.key, action: 'delete' });
      return { ok: true, output: `已删除记忆 [${scope}] ${a.key}` };
    },
  };
}
