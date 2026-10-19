// 灵核 UI 2.0 · 组件工厂 components.js
// 原生 DOM 工厂(不引入 React/Vue),全部样式取自 ui.css Token,页面禁止另写硬编码色值。
// 用法:页面 <script src="components.js"></script>(普通脚本,挂 window.UI2,兼容现有页面加载方式)。
// Task State 文案与 runtime/ui/task-state.mjs 保持一致(那边是状态机真源,这边只做展示映射)。
(function () {
  'use strict';

  /* ---------- 底层工厂 ---------- */
  /** h('div', {class:'card', onclick}, [children|string]) → HTMLElement */
  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props ?? {})) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // 仅限受控静态文案;用户内容一律 text
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of [].concat(children ?? [])) {
      if (c == null) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /* ---------- Task State 展示映射 ----------
     ⚠ 表**不在这里**：状态词唯一真源是 `ui/state-words.js`（= window.TaskWords），
     页面按 `<script src="./state-words.js">` 先加载它。多处各存一份必然漂移。 */
  const STATE_LABELS = (globalThis.TaskWords ?? {}).TASK_STATE_LABELS ?? {};

  /** StatePill({state, detail}) → 状态角标(人话;detail 可选补充,如「整理文件」) */
  function StatePill({ state = 'Idle', detail = null } = {}) {
    const label = STATE_LABELS[state] ?? state;
    const text = detail && (state === 'Working' || state === 'Approval') ? `${label}:${detail}` : label;
    return h('span', { class: `pill s-${String(state).toLowerCase()}`, text, 'data-state': state });
  }

  /* ---------- 排版渲染 ----------
     自己写一个极简 Markdown 渲染器，不引任何库（不引 React/Vue；零依赖纪律）。
     安全前提：**先转义、再变换、只产出白名单标签**——她回复里的内容可能来自网页/文档（不可信文本），
     绝不能直接 innerHTML。用户自己的话（role:'me'）保持纯文本，不做变换。 */
  function escAll(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /** 行内规则（入参必须已转义） */
  function mdInline(t) {
    return escAll(t)
      .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  }
  const mdRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function mdToHtml(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // 代码块 ```lang
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre class="md-pre"><code>${escAll(buf.join('\n'))}</code></pre>`);
        continue;
      }
      // 表格（表头 + |---| 分隔行）
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
        const head = mdRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(mdRow(lines[i++]));
        /* **一份内容两种版式** —— 表格 + "字段:值"列表，由 CSS 容器查询按气泡宽度选。
           为什么这么做（而不是渲染后量宽度再换）：
             · 量宽度要等布局 → 流式每来一块都得重量一次（贵，而且会闪）；
             · 容器查询是浏览器自己算的，**流式长出来的时候自动跟着切**，零成本、零闪烁。
           列数 ≥4 的表格用更宽的阈值（520px）就先换版式——4 列以上在窄气泡里本来就挤成一团。
           字段:值 的规则：第一列当字段名，其余列用 `·` 连起来。 */
        const wide = head.length >= 4;
        const fields = rows.map((r) => {
          const k = r[0] ?? '';
          const v = r.slice(1).filter((x) => String(x).trim()).join(' · ');
          return `<div class="f"><span class="k">${mdInline(k)}</span><span class="v">${mdInline(v)}</span></div>`;
        }).join('');
        out.push(`<div class="md-tablewrap${wide ? ' wide' : ''}"><table class="md-table"><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
          + `<div class="md-fields${wide ? ' wide' : ''}">${fields}</div>`);
        continue;
      }
      // 标题（# ## ### ####；UI 里降三级显示：她写 ## 时视觉上是个小节）
      const hMatch = /^\s{0,3}(#{1,4})\s+(.+)$/.exec(line);
      if (hMatch) {
        const lv = hMatch[1].length;
        out.push(`<div class="md-h md-h${lv}">${mdInline(hMatch[2])}</div>`);
        i++;
        continue;
      }
      // 列表（- * + 或 1. ；两格缩进的续行并进上一项）
      if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const items = [];
        while (i < lines.length && (/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
          const m = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
          if (m) items.push(m[1]);
          else if (items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        }
        out.push(`<${ordered ? 'ol' : 'ul'} class="md-list">${items.map((t) => `<li>${mdInline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      // 引用
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote class="md-quote">${mdInline(buf.join(' '))}</blockquote>`);
        continue;
      }
      // 分隔线
      if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }
      if (!line.trim()) { i++; continue; }
      // 段落
      const buf = [];
      while (i < lines.length && lines[i].trim()
        && !/^\s*(?:```|#{1,4}\s|[-*+]\s|\d+\.\s|>|\|)/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<div class="md-p">${buf.map(mdInline).join('<br>')}</div>`);
    }
    return out.join('');
  }

  /* ---------- 可点的小卡片 ----------
     她可以给一个"要不要我做"的结构化块：
       ```lhcd:action {"kind":"confirm","text":"把这三份合并成一份"}
     三条硬约束（都在这里落地）：
       ① **只认自家写法**：不解析自然语言（自然语言永远生不出卡片）；
       ② **点了 = 你说了那句话**：卡片只带一个文本，点了走**同一条对话**（不新开执行通道，
          该问你的照样问）——所以这里只输出 `data-act`，由页面把它交给自己的发送函数；
       ③ **外面的字不算**：这段文本里只要出现过"外部内容·只作资料"的标记，
          里面的同名块**一律不认**（退化成一段普通代码给人看）——否则一段网页就能变出按钮来。
     kinds：confirm（要我做吗）· choose（A 还是 B）· open（打开文件/链接，链接只许 https）。 */
  const ACTION_KINDS = new Set(['confirm', 'choose', 'open']);
  const UNTRUSTED_MARK = '外部内容·只作资料';
  function actionCardsHtml(src) {
    // 先切成"动作块 / 其它"两段；外部标记出现在动作块之前 → 这个块不认
    const parts = String(src ?? '').split(/```lhcd:action\s*\n([\s\S]*?)```/);
    if (parts.length === 1) return null;
    let seen = '';
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) { seen += parts[i]; out.push({ html: mdToHtml(parts[i]) }); continue; }
      const untrusted = seen.includes(UNTRUSTED_MARK);
      let spec = null;
      try { spec = JSON.parse(parts[i].trim()); } catch { spec = null; }
      const okSpec = spec && ACTION_KINDS.has(String(spec.kind)) && typeof spec.text === 'string' && spec.text.trim()
        && (spec.kind !== 'open' || !spec.url || /^https:\/\//.test(String(spec.url)));
      if (!okSpec || untrusted) {
        // 不认：**原样显示**（一段代码），不给她一个"看起来能点其实不能点"的假按钮
        out.push({ html: `<pre class="md-pre md-act-inert"><code>${escAll(parts[i].trim())}</code></pre>` });
        continue;
      }
      const label = String(spec.label ?? (spec.kind === 'confirm' ? '好' : spec.kind === 'choose' ? '就这个' : '打开'));
      out.push({ card: { kind: String(spec.kind), text: String(spec.text).trim(), label, url: spec.url ? String(spec.url) : '' } });
    }
    return out;
  }

  /* ---------- 消息气泡(Home/Pet/Quick 共用) ---------- */
  /** 北极星 mark（品牌标）：内联 SVG，**不引新图片文件**，也就不必管打包与 2x 素材。
   *  用 `currentColor` 上色，不吃出生页那个 `id="lh-star"` 渐变（同页面出现两个同 id 会互相抢）。 */
  function PolarisMark({ size = 16 } = {}) {
    return h('div', { class: 'm-av', 'aria-hidden': 'true', html:
      `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">`
      + '<path d="M12 2.4 13.9 9.6 21.6 12 13.9 14.4 12 21.6 10.1 14.4 2.4 12 10.1 9.6Z" fill="currentColor"/>'
      + '<circle cx="12" cy="12" r="2.3" stroke="currentColor" stroke-width="1.1" opacity=".5"/>'
      + '</svg>' });
  }

  /** Message({role:'ta'|'me'|'sys', text, ops:[{label,onClick}], error}) → 气泡节点
   *  role:'ta' 走 Markdown 渲染（她的回复）；'me'/'sys' 保持纯文本（用户自己的话与系统提示不该被改写） */
  function Message({ role = 'ta', text = '', ops = null, error = false, onAction = null } = {}) {
    // home/conv 传的是 'assistant'，另一套叫法是 'ta'——**两边都算"她"**（否则渲染器与样式都命中不了）
    const isTa = role === 'ta' || role === 'assistant';
    let bubble;
    if (isTa && !error) {
      const parts = actionCardsHtml(String(text ?? ''));
      if (parts) {
        // 有动作块：正文照旧渲染，卡片插在该在的位置（顺序不能乱——她先说话，再给动作）
        bubble = h('div', { class: 'm-bubble md' });
        for (const p of parts) {
          if (p.html) bubble.insertAdjacentHTML('beforeend', p.html);
          else if (p.card) {
            bubble.append(h('div', { class: 'act-card' }, [
              h('div', { class: 'ac-q', text: p.card.text }),
              h('div', { class: 'ac-ops' }, [
                h('button', {
                  class: 'btn sm ghost ac-go', text: p.card.label,
                  // ⚠ 点了 = **你说了那句话**（卡片只带文本，走同一条对话；不新开执行通道）
                  onclick: () => { try { onAction?.(p.card.kind === 'open' && p.card.url ? `${p.card.text}（${p.card.url}）` : p.card.text); } catch { /* 页面没接发送口就什么也不做（但**绝不假装发了**） */ } },
                }),
              ]),
            ]));
          }
        }
      } else {
        bubble = h('div', { class: 'm-bubble md', html: mdToHtml(text) });
      }
    } else {
      bubble = h('div', { class: 'm-bubble' }, [error ? h('span', { class: 'm-err', text }) : text]);
    }
    if (ops?.length) {
      bubble.append(h('div', { class: 'm-ops' }, ops.map((o) => h('button', { text: o.label, onclick: o.onClick }))));
    }
    const kids = [];
    if (isTa) kids.push(PolarisMark());
    kids.push(bubble);
    return h('div', { class: `msg ${isTa ? 'ta' : role}` }, kids);
  }

  /** 系统提示卡。
   *  **为什么必须独立成卡**：此前失败是把整条新消息 `replaceWith` 进**原来的那个气泡**里——
   *  于是 `.msg.ta > .m-av` 里面又套了一层 `.msg.ta > .m-av` = **双头像**，
   *  正文左边缘也从 61px 变成 100px（错位），而状态行左边缘是 24px。
   *  卡片：无头像、不嵌套、可带动作（重试 / 看看为什么）；失败与中止**共用这一种**，不再各画一套。 */
  /**
   * 「**这次的产出**」卡——她这次做出来/改出来的东西。
   * 纪律：只列**产出**（读过什么不算，那是文件页的活）；标题句写清"不是她读过的"；
   * 不做"删掉这条"（产物是有账的东西，删要回文件页）。两页共用这一份实现。
   */
  function ArtifactCard({ items = [], onOpen = null, onReveal = null, onUndo = null } = {}) {
    if (!items.length) return null;
    const KIND_WORD = { document: '文档', sheet: '表格', slides: '演示', pdf: 'PDF', image: '图片',
      audio: '音频', video: '视频', text: '文稿', data: '数据', code: '代码', other: '文件' };
    const wrap = h('div', { class: 'artifact-card' });
    wrap.append(h('div', { class: 'ac-head' }, [
      h('span', { class: 'ac-title', text: '这次的产出' }),
      h('span', { class: 'ac-note', text: '她这次做出来的东西（不是她读过的）' }),
      h('span', { class: 'ac-count', text: `${items.length} 件` }),
    ]));
    for (const a of items) {
      const name = String(a.path ?? a.uri ?? '').split('/').pop() || '（未命名）';
      const row = h('div', { class: 'ac-row' }, [
        h('span', { class: 'ac-kind', text: KIND_WORD[a.kind] ?? '文件' }),
        h('span', { class: 'ac-name', text: name }),
        h('button', { class: 'btn sm ghost ac-open', text: DT('pv.open', '打开'), onclick: () => onOpen?.(a) }),
        h('button', { class: 'btn sm ghost ac-reveal', text: '在文件夹里显示', onclick: () => onReveal?.(a) }),
      ]);
      wrap.append(row);
    }
    /* **撤销这次改动**——改错了要能一键退回去（回合级快照）。
       按钮放在产物卡上：这张卡就是"这次产出"，退回的对象正是它们。 */
    if (onUndo) {
      /* ⚠ 按钮要**一次就退休**。否则撤完不消失，再点一次会拿同一份快照再跑一遍——
         中间新建的文件被送回收站、用户手改过的内容被陈旧快照盖掉（不可逆）。
         约定：`onUndo()` 成功返回 true（按钮变「已退回」并禁用）、失败/取消返回 false（按钮复原可再点）。
         后端也有同一道闸（`plan.alreadyUndone`）——双保险，界面不做唯一的墙。 */
      wrap.append(h('div', { class: 'ac-foot' }, [
        h('button', {
          class: 'btn sm ghost ac-undo', text: '↩ 撤销这次改动',
          title: '把这一轮改过的文件退回改动前；这些文件本来就是新建的，会送进回收站',
          onclick: async (e) => {
            const btn = e.currentTarget;
            if (btn.disabled) return;
            btn.disabled = true;
            try {
              const done = await onUndo();
              if (done === false) { btn.disabled = false; return; }
              btn.textContent = '已退回';
            } catch { btn.disabled = false; }
          },
        }),
      ]));
    }
    return wrap;
  }

  /* ---------- 标记（标签/书签） ----------
     标签是**追加事实**（宿主只往会话日志里追加一条 custom，不改消息）：再标一次就覆盖、标空串就摘掉。
     两页共用这一份实现（家页的对话流与对话房间各 new 一个 kit）。
     对号入座靠**正文**、不靠位置：位置会被工具行/系统提示/流式尾块挤偏，**标错人比不给标更糟**——
     对不上就不挂按钮（宁可少挂，不能挂错）。 */
  function LabelKit({ container, onCountChange = null, api = null } = {}) {
    const call = api ?? (typeof window !== 'undefined' ? window.api : null);
    let map = {};
    /** 正文归一化（去掉空白与标点符号）：渲染后的正文与存下来的原文只差这些 */
    const normKey = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');

    function paint(msgEl) {
      const btn = msgEl?.querySelector?.('.label-btn');
      if (!btn) return;
      const text = map[msgEl.dataset.mid] ?? '';
      btn.textContent = text ? '🏷 改标记' : '🏷 标记';
      btn.title = text ? `现在标的是「${text}」——点一下改，清空就摘掉` : '给这句标一句你自己的话（好回头找）';
      msgEl.classList.toggle('labeled', !!text);
      msgEl.querySelector('.label-chip')?.remove();
      if (!text) return;
      const chip = h('button', { class: 'label-chip', text: `🏷 ${text}`, title: '点一下改掉这个标记',
        onclick: (e) => { e.stopPropagation(); void apply(msgEl.dataset.mid); } });
      msgEl.append(chip);
    }

    /** 给一行挂上「🏷 标记」（已挂过就不重复挂） */
    function attach(msgEl) {
      if (!msgEl?.dataset?.mid || msgEl.querySelector('.label-btn')) return paint(msgEl);
      const btn = h('button', { class: 'label-btn', type: 'button',
        onclick: (e) => { e.stopPropagation(); void apply(msgEl.dataset.mid); } });
      msgEl.append(btn);
      paint(msgEl);
    }

    /** 问一句（回车＝标上，Esc/关闭＝不动）。Electron 没有 prompt()，一律走 Modal。 */
    function ask(mid) {
      return new Promise((resolve) => {
        const now = map[mid] ?? '';
        let done = false;
        Modal({
          title: now ? '改一下这个标记' : '给这句标一句你自己的话',
          body: '清空就摘掉。标记只写在本机的会话记录里，不会跟着请求发出去。比如：那个决定 / 纪念日 / 要记住。',
          input: { value: now, placeholder: '一句你自己看得懂的话' },
          actions: [{ label: now ? '改掉' : '标上', onClick: (v) => { done = true; resolve(String(v ?? '')); } }],
          onClose: () => { if (!done) resolve(null); },
        });
        const box = [...document.querySelectorAll('.mask')].pop()?.querySelector('input.input');
        if (!box) return;
        box.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          done = true;
          resolve(box.value);
          box.closest('.mask')?.remove();
        });
        setTimeout(() => { box.focus(); box.select(); }, 30);
      });
    }

    async function apply(mid) {
      if (!mid) return;
      const got = await ask(mid);
      if (got === null) return;                       // 取消＝不动
      const r = await call?.labelSet?.(mid, got).catch(() => null);
      if (!r?.ok) { Toast('没标上：' + (r?.error ?? '未知原因'), 'err'); return; }
      map = r.labels ?? map;
      const text = String(got).trim();
      if (text) map[mid] = text; else delete map[mid];
      for (const el of container.querySelectorAll(`.msg[data-mid="${cssEscape(mid)}"]`)) paint(el);
      count();
      Toast(text ? `标上了：${text}` : '标记摘掉了', 'ok');
    }

    async function refresh() {
      const r = await call?.labelsList?.().catch(() => null);
      if (r?.ok) map = r.labels ?? {};
      for (const el of container.querySelectorAll('.msg[data-mid]')) paint(el);
      count();
      return map;
    }

    function count() { onCountChange?.(Object.keys(map).length); }

    /** 这一行的正文（**排除文件芯片/动作卡**——它们的文字是页面加的，会话那边没有） */
    function domKeyOf(el) {
      const bubble = el.querySelector('.m-bubble');
      if (!bubble) return '';
      const copy = bubble.cloneNode(true);
      copy.querySelectorAll('.m-files, .file-chip, .m-ops, .act-card').forEach((n) => n.remove());
      return normKey(copy.textContent);
    }

    /**
     * 页面上的正文 vs 会话里存的原文，算不算同一句。
     * 三种正常差异：① 会话那边挂着注入前缀/文件说明（更长）；② 她的话在会话里被截到 200 字（页面更长）；
     * ③ 我的原话夹在注入文本中间。都不属于 → 不认（**标错人比不给标更糟**）。
     */
    function textMatch(a, b) {
      if (!a || !b || a.length < 2) return false;
      if (a === b || b.startsWith(a)) return true;
      if (a.startsWith(b) && b.length >= 4) return true;
      if (a.length >= 6 && b.includes(a)) return true;
      /* 带文件芯片的那句：页面上只剩前面一小截引子（"在吗" + 芯片），会话里是"在吗 帮我处理这个文件：…"
         —— 只有这么短的引子才敢按前两个字认，且认的是**从后往前**最近的一条同角色消息。 */
      return a.length <= 4 && b.startsWith(a.slice(0, 2));
    }

    /**
     * 从会话消息给**已经画出来的**行补挂标记（家页/房间重画历史后各调一次）。
     * 只挂对得上的：`data-mid` 已经有的直接用；没有的按正文认，**从最后一行往前**认
     * （页面上通常只有最近几条历史，从前面对会把顺序错开一整段）。
     */
    function attachFromSession(messages = []) {
      const pools = { user: [], assistant: [] };
      for (const m of messages) if (m.id && m.text && pools[m.role]) pools[m.role].push({ ...m, used: false });
      const rows = [...container.querySelectorAll('.msg')];
      for (let i = rows.length - 1; i >= 0; i--) {
        const el = rows[i];
        const isMe = el.classList.contains('me');
        const isTa = el.classList.contains('ta');
        if (!el.dataset.mid) {
          if (!isMe && !isTa) continue;                       // 系统行不挂
          const key = domKeyOf(el);
          if (!key) continue;                                 // 空气泡（还在流式）先不挂
          const pool = pools[isMe ? 'user' : 'assistant'];
          let hit = -1;
          for (let j = pool.length - 1; j >= 0; j--) {
            if (!pool[j].used && textMatch(key, normKey(pool[j].text))) { hit = j; break; }
          }
          if (hit < 0) continue;
          pool[hit].used = true;
          el.dataset.mid = String(pool[hit].id);
        }
        attach(el);
      }
    }

    /** 标记清单（"回头找得到"）：列出标过的句子，点了滚过去闪一下 */
    async function open() {
      await refresh();
      const ids = Object.keys(map);
      const body = h('div', {});
      if (!ids.length) {
        body.append(h('div', { style: { color: 'var(--ink2)', fontSize: '12.5px' },
          text: '这一段还没标过。把鼠标放到某句话上，会出现「🏷 标记」——标一句你自己的话，回头好找。' }));
      } else {
        for (const mid of ids) {
          const el = container.querySelector(`.msg[data-mid="${cssEscape(mid)}"]`);
          const snip = (el?.querySelector('.m-bubble')?.textContent ?? '').trim().slice(0, 60);
          const row = h('button', { class: 'label-nav-row', type: 'button' }, [
            h('span', { class: 'lr-tag', text: `🏷 ${map[mid]}` }),
            h('span', { class: 'lr-txt', text: snip || '（这句不在这段可见的历史里）' }),
          ]);
          row.addEventListener('click', () => {
            // ⚠ `Modal()` 返回的是**对象** `{close}`，不是函数——写成 `close()` 会 TypeError，
            //   弹层关不掉，"点了滚过去"这条就废了
            modal.close();
            const t = container.querySelector(`.msg[data-mid="${cssEscape(mid)}"]`);
            if (!t) { Toast('这句不在当前这段历史里（可能在老分支上）', ''); return; }
            t.scrollIntoView({ block: 'center', behavior: 'smooth' });
            t.classList.add('label-flash');
            setTimeout(() => t.classList.remove('label-flash'), 1200);
          });
          body.append(row);
        }
      }
      const modal = Modal({ title: '这一段标过的地方', body });
    }

    return { attach, attachFromSession, refresh, open, map: () => map };
  }

  /* ---------- 语言选择（设置 / 我的 TA / 出生向导三处共用一份实现） ----------
     纪律：**不做热切换**——选完提示"重启后生效"，这是最简单也最可靠的做法
     （界面里到处是初始化时算好的字符串，热切换会把一半留在旧语言里）。
     `value` 为空串 = **跟随系统**（这是默认，也是大多数人该选的）。 */
  const LOCALE_NAMES = { 'zh-CN': '简体中文', 'zh-Hant': '繁體中文', en: 'English', ja: '日本語', ko: '한국어' };
  function LocalePicker({ value = '', supported = ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko'], onChange = null } = {}) {
    const wrap = h('div', { class: 'lang-pick' });
    const opts = [{ v: '', label: '跟随系统' }, ...supported.map((l) => ({ v: l, label: LOCALE_NAMES[l] ?? l }))];
    for (const o of opts) {
      const btn = h('button', {
        class: `pill${(value || '') === o.v ? ' on' : ''}`, type: 'button', text: o.label,
        onclick: () => { for (const b of wrap.querySelectorAll('.pill')) b.classList.remove('on'); btn.classList.add('on'); onChange?.(o.v); },
      });
      wrap.append(btn);
    }
    return wrap;
  }

  /** CSS.escape 的兜底（老内核没有它时，消息 id 是自己生成的 `m<数字>`，只需要转义引号/反斜杠） */
  function cssEscape(s) {
    try { return CSS.escape(String(s)); } catch { return String(s).replace(/["\\]/g, '\\$&'); }
  }

  function SystemCard({ text = '', tone = 'err', ops = null } = {}) {
    const mark = tone === 'err' ? '!' : tone === 'ok' ? '✓' : '·';
    const body = h('div', { class: 'sc-b' }, [
      h('div', { class: 'sc-t', text }),
      ops?.length ? h('div', { class: 'sc-ops' }, ops.map((o) => h('button', { text: o.label, onclick: o.onClick }))) : null,
    ].filter(Boolean));
    return h('div', { class: `syscard ${tone}` }, [h('span', { class: 'sc-i', text: mark }), body]);
  }

  /** 把一条消息**整条**换成别的节点（返回新节点）。
   *  ⚠️ 页面里 `addMsg()` 拿到的是**内层 `.m-bubble`**；对它 `replaceWith(整条消息)` 就会套娃。
   *  统一走这个函数：先 `closest('.msg')` 找到外层再换。 */
  function replaceMsg(node, next) {
    const outer = node?.closest?.('.msg') ?? node;
    if (outer?.replaceWith) outer.replaceWith(next);
    return next;
  }

  /* ---------- 任务卡(时间+图标+人话一句话+状态角标) ---------- */
  /** TaskCard({time, icon, text, state, progress(0~100), onClick}) */
  function TaskCard({ time = '', icon = '✦', text = '', state = null, progress = null, onClick = null } = {}) {
    const kids = [];
    if (time) kids.push(h('span', { class: 'tm', text: time }));
    kids.push(h('span', { class: 'ic', text: icon }));
    kids.push(h('span', { class: 'tx', text }));
    if (state) kids.push(StatePill({ state }));
    const row = h('div', { class: 'task-row', onclick: onClick }, kids);
    if (progress != null) {
      const wrap = h('div', {}, [row, h('div', { class: 'prog' }, [h('i', { style: { width: `${Math.max(0, Math.min(100, progress))}%` } })])]);
      return wrap;
    }
    return row;
  }

  /* ---------- 审批卡(人话 + 风险等级;内部调用标识一律不展示) ---------- */
  /* 风险档的人话词——**真源在 `ui/state-words.js`**（唯一一张共享词表）：
     形象端不加载本文件，而审批卡恰恰住在那里，所以词表放共享脚本、两边取同一份。 */
  const Words2 = globalThis.TaskWords ?? {};
  const riskWord = Words2.riskWord ?? ((r) => ({ R0: '只是看一眼', R3: '会删东西', R5: '不可逆 · 得你点头' }[r] ?? '会删东西'));
  const riskSeverity = Words2.riskSeverity ?? ((r) => (r === 'R0' || r === 'R1' ? 'low' : r === 'R2' ? 'mid' : 'high'));

  /**
   * ApprovalCard —— 她问"能不能做"的那一下。
   *
   * 家页与对话窗都用它，而且**文案全部来自宿主一处**（`main.mjs` 的 approvalCardPayload）：
   * 这两个窗口只排版，不自己造句，免得同一句话在三个窗口三种说法。
   *
   * 参数：{title, why, impact, raw, risk, canSession, canRule, ruleNote, onDeny, onAllowOnce, onAllowSession, onAllowRule}
   * `canRule` = 宿主能给出**一条窄规矩**时才为真（「以后这类都允许」）；给不出就不显示那颗按钮
   * （"没做就不显示"是这张卡的纪律：一个点了没用的按钮比没有按钮更坏）。
   * 兼容老调用：只给 summary 时按老样子渲染。
   */
  function ApprovalCard({
    title = '', summary = '', why = '', impact = '', raw = '',
    risk = 'R3', canSession = false, canRule = false, ruleNote = '',
    onAllow = null, onDeny = null, onAllowOnce = null, onAllowSession = null, onAllowRule = null,
    onOpenRaw = null,
  } = {}) {
    const sev = riskSeverity(risk);
    const riskText = riskWord(risk);
    const head = h('div', { class: 'a-t' }, [
      title || 'TA 想做',
      h('span', { class: `risk r-${sev}${risk === 'R5' ? ' r-mandatory' : ''}`, text: riskText }),
    ]);
    const body = [head];
    if (why) body.push(h('div', { class: 'a-why', text: why }));
    if (impact) body.push(h('div', { class: 'a-imp', text: `影响：${impact}` }));
    // 原始命令**叠起来**（默认收起）：它不该是正文——人看不懂，还容易被 `2>/dev/null` 这种尾巴带偏
    if (raw) {
      const pre = h('pre', { class: 'a-raw', text: raw });
      pre.hidden = true;
      const toggle = h('button', { class: 'btn tx a-rawt', text: '看原始命令', onclick: () => { pre.hidden = !pre.hidden; toggle.textContent = pre.hidden ? '看原始命令' : '收起'; } });
      body.push(toggle, pre);
    }
    const allowOnce = onAllowOnce ?? onAllow;
    body.push(h('div', { class: 'a-ops' }, [
      onDeny && h('button', { class: 'btn sm ghost', text: '不允许', onclick: onDeny }),
      allowOnce && h('button', { class: 'btn sm', text: '就这一次', onclick: allowOnce }),
    ].filter(Boolean)));
    /* 第二行 = 两档"更宽"的授权。**都必须比主按钮安静**（`.a-ops.sub .btn` 那条样式），
       尤其「以后这类都行」：它是跨重启的持久授权，做得显眼就等于用视觉把人往宽的那边推。 */
    const wider = [];
    if (canSession && onAllowSession) wider.push(h('button', { class: 'btn sm line', text: '到这次对话结束都允许', onclick: onAllowSession }));
    if (canRule && onAllowRule) wider.push(h('button', { class: 'btn sm line', text: '以后这类都行', onclick: onAllowRule }));
    if (wider.length) {
      body.push(h('div', { class: 'a-ops sub' }, wider));
      // 写清覆盖范围：点了它以后，到底放行了什么（"记下的规矩"要看得见，不然是盲签）
      if (canRule && ruleNote) body.push(h('div', { class: 'a-rule', text: `记下的规矩：${ruleNote}（随时能在设置里删掉）` }));
    }
    return h('div', { class: 'approval' }, body);
  }

  /* ---------- 开关 / 区块 / 空态 / 宫格 ---------- */
  /** Toggle({on, onChange(nextOn)}) → button.sw */
  function Toggle({ on = false, onChange = null } = {}) {
    const b = h('button', { class: `sw${on ? '' : ' off'}`, role: 'switch', 'aria-checked': String(on) });
    b.addEventListener('click', () => {
      const next = b.classList.toggle('off') === false;
      b.setAttribute('aria-checked', String(next));
      onChange?.(next);
    });
    return b;
  }

  /** SectionCard({title, extra, children}) → 白卡区块(标题行+内容) */
  function SectionCard({ title = '', extra = null, children = [] } = {}) {
    return h('div', { class: 'card section' }, [
      title && h('div', { class: 'section-t' }, [h('span', { text: title }), extra && h('span', { class: 'xtra', text: extra })]),
      ...[].concat(children ?? []),
    ].filter(Boolean));
  }

  /** EmptyState({icon, title, desc}) */
  function EmptyState({ icon = '🌙', title = '这里还空空的', desc = '' } = {}) {
    return h('div', { class: 'empty' }, [
      h('div', { class: 'e-ic', text: icon }),
      h('div', { class: 'e-t', text: title }),
      desc && h('div', { class: 'e-d', text: desc }),
    ]);
  }

  /** QuickTile({icon, label, onClick}) → 快捷宫格瓦片(深玻璃底,置于场景/亮底均可) */
  function QuickTile({ icon = '✦', label = '', onClick = null } = {}) {
    return h('button', { class: 'qtile', onclick: onClick }, [h('span', { class: 'em', text: icon }), label]);
  }

  /* ---------- 弹窗 / 轻提示 ---------- */
  /** Modal({title, body, actions:[{label,kind,onClick}], onClose}) → 打开即插入 body,关闭自动移除 */
  /** Modal({title, body, actions, input, onClose}) —— actions[].onClick 会收到输入框的值（没给 input 时是 undefined）。
   *  `input`：收一句用户输入（生日名字 / 加一条待办）用它，**不要用 `window.prompt()`**——
   *  **Electron 不支持 prompt()**（`Error: prompt() is not supported.`），点了会抛错、什么都不发生。
   *  以后一律走这里，别再碰 prompt/alert/confirm。 */
  function Modal({ title = '', body = '', actions = [], onClose = null, input = null } = {}) {
    const close = () => { mask.remove(); onClose?.(); };
    const inp = input
      ? h('input', { class: 'input', placeholder: input.placeholder ?? '', value: input.value ?? '', style: { marginTop: '10px' } })
      : null;
    const mask = h('div', { class: 'mask', onclick: (e) => { if (e.target === mask) close(); } }, [
      h('div', { class: 'modal card' }, [
        h('div', { class: 'mo-t', text: title }),
        /* body 可以是**字符串**（老用法）或**节点**（标记清单这类要列行的）——
           以前只字符串：传节点进去会被 textContent 变成 "[object HTMLDivElement]" */
        h('div', { class: 'mo-b', text: typeof body === 'string' ? body : '' },
          typeof body === 'string' ? [] : [body]),
        inp ? inp : null,
        h('div', { class: 'mo-ops' }, [
          h('button', { class: 'btn sm ghost', text: '关闭', onclick: close }),
          /* ⚠ 顺序很重要：**先跑动作，再关**。
             以前是 `close(); a.onClick?.(…)` —— `close()` 会触发 `onClose`，
             于是"用 onClose 表示取消"的调用方（`onClose: () => resolve(false)` 那种）
             **抢先把结果定成"取消"**，动作里的 `resolve(true)` 成了无声的空操作：
             点「退回去」「标上」等于点取消——按钮看着好使，其实什么都没做。
             反过来（动作在前、关闭在后）两类调用方都对：动作先定结果，onClose 只做收尾。 */
          ...actions.map((a) => h('button', { class: `btn sm${a.kind === 'danger' ? ' danger' : ''}`, text: a.label, onclick: () => { a.onClick?.(inp ? inp.value : undefined); close(); } })),
        ]),
      ]),
    ]);
    document.body.append(mask);
    return { close };
  }

  /** Toast(text, kind:'ok'|'err') → 2.4s 自动消失 */
  function Toast(text, kind = '') {
    const t = h('div', { class: `toast ${kind}`, text });
    document.body.append(t);
    setTimeout(() => t.remove(), 2400);
  }

  /* ---------- 氛围层(程序化 CSS 基准;插画增强可选,缺失时 CSS 兜底) ---------- */
  /** atmosphere({variant:'warm'|'night'|'soft', img?(相对 ui/ 或绝对路径)}) → 载体节点(页面最先 append) */
  function atmosphere({ variant = 'soft', img = null } = {}) {
    const atmo = h('div', { class: 'atmo' }, [h('div', { class: 'atmo-aura' })]);
    if (variant === 'night' || variant === 'warm') atmo.append(h('div', { class: 'atmo-stars' }));
    if (img) {
      // 资产存在才点亮插画层;失败保持纯 CSS 兜底,不破相
      const probe = new Image();
      probe.onload = () => { document.documentElement.classList.add('has-atmo'); document.documentElement.style.setProperty('--atmo-img', `url("${img}")`); };
      probe.src = img;
    }
    return atmo;
  }

  /* ---------- 主题(浅/深/跟随三档,Me 设置页持久化用) ---------- */
  /** setTheme('light'|'dark'|'auto') → 设 html[data-theme];getTheme() 读当前 */
  function setTheme(mode = 'auto') {
    document.documentElement.setAttribute('data-theme', mode === 'auto' ? 'auto' : mode);
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme'); // auto 用媒体查询
  }
  function getTheme() { return document.documentElement.getAttribute('data-theme') ?? 'auto'; }

  /* ---------- 进行中状态行（「已处理 19 秒」+「正在思考」） ----------
     为什么需要它：模型回复是**整包缓冲**的（`message-api.ts` 收完才产 delta），
     所以等待期界面一个字都不出、只有一个空气泡。而这行字**不依赖任何 delta**——从本地时间自己数秒，
     缓冲式架构下照样实时走字，等待期就有东西可看。 */
  const PENDING_KEEP_MS = 5000; // 快问快答不留痕（<5s 直接消失），慢回合才冻结成「已处理 N 秒」当抬头
  /** 已经冻结、还留在流里的计时行（同一窗口一份登记处）。
   *  否则冻结之后**没人收**——每轮 append 一条新的，慢回合越多、流里堆的灰行越多。
   *  规则：**新一轮的计时行一出现，旧的先撤**（它当抬头的使命已经完成，最多留 1 行）。 */
  const settledPending = new Set();
  const mmss = (s) => (s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`);
  /**
   * Pending({ text }) → { el, setText(t), seconds(), settle() }
   * el：插入对话流的一行（「正在思考 · 已 12 秒」，前缀有个呼吸点）
   * setText(t)：换掉"在做什么"（宿主随 task-state 广播带过来，如"正在看资料"）
   * settle()：回合结束调用——≥5 秒冻结成「已处理 N 秒」（去掉呼吸点），否则整行移除
   */
  function Pending({ text = '正在思考' } = {}) {
    const t0 = Date.now();
    let label = text;
    const line = h('span', { class: 'pd-txt' });
    const el = h('div', { class: 'ui-pending' }, [h('span', { class: 'pd-dot' }), line]);
    const secs = () => Math.max(0, Math.round((Date.now() - t0) / 1000));
    // 等久了得有一句"她还在动"——只报秒数、不报在干什么，用户只会觉得"卡住了"
    const paint = (done) => {
      const s = secs();
      line.textContent = done ? `已处理 ${mmss(s)}` : `${label} · 已 ${mmss(s)}${s >= 90 ? ' · 还在动' : ''}`;
    };
    for (const old of settledPending) old.remove(); // 上一回合冻结的行撤掉（不许越堆越多）
    settledPending.clear();
    paint(false);
    const timer = setInterval(() => paint(false), 1000);
    return {
      el,
      setText(t) { if (t && String(t) !== label) { label = String(t); paint(false); } },
      seconds: secs,
      settle() {
        clearInterval(timer);
        const s = secs();
        if (s * 1000 < PENDING_KEEP_MS) { el.remove(); return null; }
        el.classList.add('done');
        paint(true);
        settledPending.add(el);
        return s;
      },
    };
  }

  /* ---------- 产物面板 ----------
     三件：右侧滑出 · 路径面包屑 · 工具条（查看源代码 / 打开 / 在访达中显示）。
     安全纪律：内容一律塞进 **sandbox 空权限 iframe**，脚本另剥一遍当第二道防线。
     **一处实现**，家页与对话房间共用（两套必然漂移）。
     没有原文的产物（Word/PDF/图片）不显示「源代码」按钮——不摆死按钮。 */
  /** 过程节点流——她正在读哪个文件/搜什么/改到哪。
   *  三态：进行中 ◐（带脉冲）/ 成了 ✓ / 没成 ✗；**右侧带耗时**（本地墙钟：从这一行出现到收尾，
   *  内核的 chat-step 事件不带时间戳，所以只能由界面自己计时——量的是用户体感的那个时长）。
   *  折叠：干完之后默认收成一行「做了 N 步（点开看）」，长任务不再刷很长。
   *  用法：const flow = UI2.StepFlow(); box.append(flow.el); flow.start(ev); flow.end(ev); flow.think(t);
   *       flow.finish();  */
  function StepFlow({ title = '她的过程' } = {}) {
    const rows = new Map(); // key → {el, t0, timer}
    const list = h('ol', { class: 'st-list' });
    const head = h('header', {}, [
      h('b', { text: title }),
      h('span', { class: 'pbar' }, [h('i')]),
      h('span', { class: 'st' }, [h('i', { class: 'live' }), h('span', { class: 'st-t2', text: '进行中' })]),
    ]);
    const el = h('div', { class: 'proc' }, [head, list]);
    const tick = (row) => {
      const s = Math.round((Date.now() - row.t0) / 1000);
      row.tm.textContent = s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒` : `${s} 秒`;
    };
    // ⚠ 只数 <li>：`.think`（思考引文条）也挂在同一个列表里，
    //   把它一起数进去 → 分母永远比分子的最大值大 → 收尾时 `done` 反被判成 false，
    //   刚加上的完成标记被自己撤掉。
    const rowsOf = () => [...list.children].filter((r) => r.tagName === 'LI');
    const sync = () => {
      const all = rowsOf();
      const done = all.filter((r) => r.classList.contains('done') || r.classList.contains('fail')).length;
      head.querySelector('.pbar i').style.width = all.length ? `${Math.round((done / all.length) * 100)}%` : '0%';
      el.classList.toggle('done', all.length > 0 && done === all.length);
      // 进行中时表头直接报**第几步**（"第 4 步"比"进行中"有用——
      //   用户要的是"进度到哪了"，不是"它在跑"）。收尾文案由 finish() 负责，这里不许抢。
      if (!el.classList.contains('done')) {
        head.querySelector('.st-t2').textContent = all.length ? `第 ${all.length} 步` : '进行中';
      }
    };
    return {
      el,
      /** start({label, by?}) —— 一个节点开始 */
      start(ev) {
        const key = String(ev?.label ?? '') + '#' + list.children.length;
        const tm = h('span', { class: 'tm2', text: '' });
        const row = h('li', { class: 'now' }, [
          h('span', { class: 'pn', text: '◐' }),
          h('span', { class: 'pt', text: ev?.by ? `${ev.by}：${ev.label}` : String(ev?.label ?? '') }),
          tm,
        ]);
        if (ev?.by) row.classList.add('sub');
        list.append(row);
        const rec = { el: row, t0: Date.now(), tm };
        rows.set(key, rec);
        rec.timer = setInterval(() => tick(rec), 1000);
        tick(rec);
        sync();
        return key;
      },
      /** end({label, ok, by?}) —— 按标签找回那一行收尾（同名多行取最后一个未收的） */
      end(ev) {
        const want = String(ev?.label ?? '');
        let found = null;
        for (const [k, r] of rows) {
          if (k.startsWith(want + '#') && r.el.classList.contains('now')) found = [k, r];
        }
        if (!found) return;
        const [k, r] = found;
        clearInterval(r.timer);
        tick(r);
        r.el.classList.remove('now');
        r.el.classList.add(ev?.ok ? 'done' : 'fail');
        r.el.querySelector('.pn').textContent = ev?.ok ? '✓' : '✗';
        if (!ev?.ok) r.el.querySelector('.pt').textContent += '（没成）';
        rows.delete(k);
        sync();
      },
      /** think(text) —— 思考摘要是**引文条**（左边框 + 浅底），露出她正在比对的那句 */
      think(text) {
        let q = list.querySelector('.think');
        if (!q) { q = h('div', { class: 'think' }); list.append(q); }
        q.textContent = `🧠 ${String(text ?? '').slice(-240)}`;
      },
      /** finish() —— 整块收尾：停掉计时、把"进行中"换成结果、按 N 折叠 */
      finish() {
        for (const [, r] of rows) { clearInterval(r.timer); tick(r); }
        // 回合结束了还挂在"进行中"的行：**不能说它还在跑**。改成中性点 + 冻结已走的时间。
        for (const li of rowsOf()) {
          if (li.classList.contains('now')) { li.classList.remove('now'); li.querySelector('.pn').textContent = '·'; }
        }
        rows.clear();
        const n = rowsOf().length;
        el.classList.add('done');
        const st = head.querySelector('.st');
        st.replaceChildren(h('span', { class: 'st-t2', text: n ? `做了 ${n} 步` : '完成' }));
        const old = el.querySelector('.st-more');
        if (old) old.remove();
        if (n >= 3) {
          el.classList.add('folded');
          const more = h('button', { class: 'st-more', text: `做了 ${n} 步（点开看）`, onclick: () => el.classList.toggle('folded') });
          el.insertBefore(more, list);
        }
        sync();
      },
      /** reopen() —— 收尾之后又来了步骤（验证回读可能晚于 chat-final 才到）：
       *  退回"进行中"，把这一块接着用，别在旁边另起一块单行的小方块。 */
      reopen() {
        if (!el.classList.contains('done')) return;
        el.classList.remove('done', 'folded');
        const old = el.querySelector('.st-more');
        if (old) old.remove();
        head.querySelector('.st').replaceChildren(h('i', { class: 'live' }), h('span', { class: 'st-t2', text: '进行中' }));
      },
    };
  }

  /** 结果卡：绿色 ✓ 头 + 逐条问题 + 动作按钮。
   *  `actions` 由页面给（打开结果 / 在文件夹里看 / 暂停 / 接着干 / 不做了…），
   *  组件只负责画，**不接 IPC**（这样 conv 等页也能用同一套）。 */
  function ResultCard({ title = '做完了', ok = true, lines = [], actions = [], note = '' } = {}) {
    const head = h('div', { class: 'rh' }, [
      h('span', { class: ok ? 'ok' : 'no', text: ok ? '✓' : '!' }),
      h('span', { text: title }),
    ]);
    const body = h('div', { class: 'rb' }, lines.map((l) => (typeof l === 'string'
      ? h('div', { class: 'li' }, [h('span', { text: '' }), h('span', { text: l })])
      : h('div', { class: 'li ' + (l.tone ?? '') }, [h('span', { text: l.mark ?? '' }), h('span', { text: l.text ?? '' })]))));
    if (note) body.append(h('div', { class: 'rn', text: note }));
    const acts = actions.length
      ? h('div', { class: 'acts' }, actions.map((a) => h('button', { class: a.pri ? 'pri' : '', text: a.label, onclick: a.onClick })))
      : null;
    return h('div', { class: 'result' + (ok ? '' : ' bad') }, [head, body, acts]);
  }

  /** 文件芯片：类型色块 + 文件名 + 行数/大小（+ 可选「打开 ›」/「✕」）。
   *  不显示路径，用类型色块标注文件类型（输入框同理）。
   *  ⚠ 纯展示组件——**这里不做 IPC**。数据由页面用 window.api.fileInfo() 取好再传进来，
   *  组件才能被 conv/pet 等页复用而不各自接线。完整路径只在「在文件夹里看」时露。
   *  kind ∈ doc|sheet|pdf|img|other（与 ui.css 的 --ftype-* 一一对应） */
  function FileChip({ name = '', ext = '', kind = 'other', size = 0, lines = null, onOpen = null, onRemove = null } = {}) {
    const label = (ext || 'file').slice(0, 4).toUpperCase();
    const meta = lines != null ? `${lines} 行`
      : size > 0 ? (size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} B`)
      : '';
    const el = h('span', {
      class: `fchip f-${kind}${onOpen ? ' f-clickable' : ''}`,
      title: name,
      onclick: onOpen ? () => onOpen() : null,
    }, [
      h('span', { class: 'fi', text: label }),
      h('span', { class: 'fx' }, [
        h('b', { text: name }),
        meta ? h('i', { text: meta }) : null,
      ]),
      // 「打开 ›」是**提示**不是按钮：整枚芯片就是点击目标（高度 40，命中区天然够）
      onOpen ? h('span', { class: 'fv', text: '打开 ›' }) : null,
      onRemove ? h('button', {
        class: 'fx-x', text: '✕', 'aria-label': `不带上 ${name}`,
        onclick: (e) => { e.stopPropagation(); onRemove(); },
      }) : null,
    ]);
    return el;
  }

  /* ---------- 路径 ⇄ 芯片 ----------
     用户发出去的文件路径换成芯片（不要显示一长串路径）。
     这两件本来只写在家页里（`splitFilePaths` / `attachFiles`），搬到这里 = **一处实现两页用**
     （同 PreviewPanel / StepFlow 的理由：两套必然漂移）。
     ⚠ 仍然不碰 IPC：取 fileInfo 由页面注入 `fetchInfo`。 */
  /** 认得出来才换芯片：绝对路径 + 已知扩展名（避免把散文里的「/ 或 /」也吞掉） */
  const FILE_EXT_RE = /\.(?:md|markdown|txt|docx?|rtf|pages|xlsx?|csv|numbers|pdf|pptx?|png|jpe?g|webp|gif|bmp|avif|heic|tiff?|mp[34]|mov|m4v|mkv|webm|avi|wav|m4a|aac|flac|json|log|ya?ml|toml|ini|conf|html?|js|mjs|cjs|ts|tsx|css|py|sh|go|rs|java|c|cc|cpp|h|swift)$/i;
  /** '…帮我处理这个文件：/a.md、/b.pdf' → { clean:'…（去掉路径与模板话后的正文）', paths:['/a.md','/b.pdf'] } */
  function splitFilePaths(text) {
    const s = String(text ?? '');
    const paths = [];
    for (const m of s.matchAll(/\/[^\s、,，：:）)【】\[\]「」]+/g)) {
      const tok = m[0].replace(/[。；;！!？?]+$/, '');
      if (FILE_EXT_RE.test(tok) && !paths.includes(tok)) paths.push(tok);
    }
    let clean = s;
    for (const p of paths) clean = clean.split(p).join('\u0000');
    clean = clean.replace(/[\u0000、]+/g, ' ')
      .replace(/[：:]\s*(?=\s|$)/g, ' ')                       // 路径被抽走后留下的那个冒号
      .replace(/\s+/g, ' ').trim()
      // 句尾那句模板话也去掉：有芯片就不必再念一遍「帮我处理这个文件」
      //（**只去句尾**——「先别动这个文件，帮我处理这个文件：…」里的第一句是人话，不能吞）
      .replace(/(?:^|\s)帮我处理(?:这个|这些)?文件\s*$/, '').trim();
    return { clean, paths };
  }
  /** 路径数组 → 芯片行。`fetchInfo(path)` 由页面注入（拿 name/ext/kind/size/lines，拿不到就只显示文件名）。 */
  async function FileChipRow(paths = [], { fetchInfo = null, onOpen = null, onRemove = null } = {}) {
    const row = h('div', { class: 'm-files' });
    for (const p of paths) {
      const info = fetchInfo ? await Promise.resolve(fetchInfo(p)).catch(() => null) : null;
      const name = info?.name ?? String(p).split('/').pop() ?? String(p);
      row.append(FileChip({
        name,
        ext: info?.ext ?? (name.includes('.') ? name.split('.').pop() : ''),
        kind: info?.kind ?? 'other',
        size: info?.size ?? 0,
        lines: info?.lines ?? null,
        onOpen: onOpen ? () => onOpen(p) : null,
        onRemove: onRemove ? () => onRemove(p) : null,
      }));
    }
    return row;
  }
  /** 把一条**我发出去的**消息里的路径换成芯片（显示层；异步填芯片，先同步把正文放好别闪）。
   *  返回是否真的换成了芯片（页面据此决定要不要做别的兜底）。 */
  function attachFiles(bubble, text, opts = {}) {
    const { clean, paths } = splitFilePaths(text);
    if (!paths.length || !bubble) return false;
    // 只发了文件、没别的话 → 给一句人话。**不能留空气泡**：CSS 会把空气泡整行藏掉，芯片跟着一起消失
    bubble.textContent = clean || `处理 ${paths.length} 个文件`;
    FileChipRow(paths, opts).then((row) => bubble.append(row)).catch(() => { /* 填芯片失败不影响正文 */ });
    return true;
  }

  /** 粘贴进来的截图缩略图。
   *  落点是"**看得见才敢发**"——所以缩略图必须在输入框里、能删。
   *  ⚠ 只当图片渲染（`img.src`），绝不 innerHTML：剪贴板里的东西一律不可信。 */
  function ImageThumb({ src = '', caption = '截图', onRemove = null } = {}) {
    const el = h('div', { class: 'at-thumb', title: caption }, [
      h('img', { class: 'at-img', src, alt: caption }),
      h('span', { class: 'at-cap', text: caption }),
    ]);
    if (onRemove) el.append(h('button', { class: 'at-x', text: '×', 'aria-label': `不带上这张${caption}`, onclick: (e) => { e.stopPropagation(); onRemove(); } }));
    return el;
  }

  function PreviewPanel({ onOpen, onReveal } = {}) {
    let cur = null, showSrc = false;
    // ⚠️ 必须用**局部具名函数**：写成对象方法后在闭包里调 `close()` 会解析到全局 `window.close()`
    // （对象方法不在词法作用域里）——点 ✕ 会等于没点。
    const closePanel = () => el.classList.remove('open');
    const crumb = h('div', { class: 'pv-crumb' });
    const body = h('div', { class: 'pv-body' });
    const btnSrc = h('button', { class: 'pv-b', text: DT('pv.source', '源代码'), title: '看原始文本（渲染出问题时用）', onclick: () => { showSrc = !showSrc; render(); } });
    const el = h('aside', { class: 'ui-pv' }, [
      h('div', { class: 'pv-h' }, [
        crumb,
        h('div', { class: 'pv-tools' }, [
          btnSrc,
          h('button', { class: 'pv-b', text: DT('pv.open', '打开'), onclick: () => cur?.path && onOpen?.(cur.path) }),
          h('button', { class: 'pv-b', text: DT('pv.reveal', '在访达中显示'), onclick: () => cur?.path && onReveal?.(cur.path) }),
          h('button', { class: 'pv-b pv-x', text: '✕', title: '收起', onclick: () => closePanel() }),
        ]),
      ]),
      body,
    ]);

    function render() {
      if (!cur) return;
      // 面包屑：太深就折中间（`… › 上级 › 文件名`）——目录可点 = 在访达里定位到那儿
      const full = String(cur.path || cur.name || '');
      const abs = full.startsWith('/') ? '/' : ''; // 绝对路径的开头不能丢（否则"在访达中显示"定位不到）
      const segs = full.split('/').filter(Boolean);
      const shown = segs.length > 4 ? ['…', ...segs.slice(-3)] : segs;
      crumb.replaceChildren(...shown.flatMap((s, i) => {
        const nodes = [];
        if (i) nodes.push(h('span', { class: 'pv-sep', text: '›' }));
        const isFile = i === shown.length - 1;
        const seg = h('span', { class: 'pv-seg' + (isFile ? ' file' : ''), text: s, title: s });
        if (!isFile && s !== '…') {
          const upto = abs + segs.slice(0, segs.indexOf(s) + 1).join('/');
          seg.onclick = () => onReveal?.(upto);
        }
        nodes.push(seg);
        return nodes;
      }));
      btnSrc.style.display = cur.text ? '' : 'none';
      const inner = showSrc && cur.text
        ? `<pre>${escAll(cur.text)}</pre>`
        : String(cur.html ?? '').replace(/<script[\s\S]*?<\/script>/gi, '');
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.srcdoc = '<!doctype html><meta charset="utf-8"><style>'
        + 'html,body{background:transparent;margin:0;padding:8px 12px}'
        + 'body{font:12.5px/1.7 -apple-system,system-ui,sans-serif;color:#efeaff;word-break:break-word}'
        + 'table{border-collapse:collapse;font-size:11px}td,th{border:1px solid rgba(255,255,255,.2);padding:2px 6px}'
        + 'pre{white-space:pre-wrap;font-size:11px}img{max-width:100%}a{color:#b7a6ff}'
        + 'h1,h2,h3{font-size:15px;margin:10px 0 6px}</style>' + inner;
      body.replaceChildren(frame);
    }

    return {
      el,
      show(item) { if (!item) return; cur = item; showSrc = false; el.classList.add('open'); render(); },
      close: closePanel,
      isOpen: () => el.classList.contains('open'),
      current: () => cur,
    };
  }

  window.UI2 = {
    h, Message, TaskCard, ApprovalCard, StatePill, Toggle, SectionCard,
    EmptyState, QuickTile, FileChip, StepFlow, ResultCard, Modal, Toast, atmosphere, setTheme, getTheme,
    STATE_LABELS,
    md: mdToHtml, // 排版渲染器（气泡内部用；工作台/证据卡也复用它）
    PreviewPanel, // 产物面板（面包屑 + 源代码 + 打开）
    Pending, // 进行中状态行（本地计时，对抗"整包缓冲期没输出"）
    splitFilePaths, FileChipRow, attachFiles, // 路径 ⇄ 芯片（家页与对话房间**同一处**实现）
    SystemCard, replaceMsg, PolarisMark, // 系统提示卡（无嵌套=无双头像）+ 北极星 mark
    ArtifactCard, // 这次的产出（家页与对话房间共用一份实现）
    LabelKit, // 标记（标签/书签，家页与对话房间共用一份实现）
    LocalePicker, // 语言选择（三处入口共用一份实现）
    ImageThumb, // 粘贴截图的缩略图
    riskWord, riskSeverity, // R 档 → 人话 + 严重度（内核 R0~R5 的一处映射）
    esc: escAll, // 转义（**一处实现**）
  };
})();
