const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /**
   * 拖放/粘贴取本地路径。
   * **Electron 33 移除了 `File.path`**（官方 d.ts 自陈改为 `webUtils.getPathForFile`），
   * 而 conv/home/pet 三处还在读 `f.path` → 拿到 undefined 被 filter 掉，拖文件进窗口
   * **静默无反应**（不报错、也没提示）。这是官方给的那条替代路（必须写在 preload 里，
   * 渲染层拿不到 webUtils）。
   * 返回 '' 表示拿不到路径（调用方自己决定怎么提示，别再静默吞掉）。
   */
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  importPackage: () => ipcRenderer.invoke('import-package'),
  importPath: (p) => ipcRenderer.invoke('import-path', p),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),
  bind: () => ipcRenderer.invoke('bind'),
  // 第二个参数是可选的**图**（data URL 数组）——粘截图/拖图片都走它
  chat: (text, images) => ipcRenderer.invoke('chat', text, images),
  correct: (target, text) => ipcRenderer.invoke('correct', { target, text }),
  forget: (target) => ipcRenderer.invoke('forget', target),
  status: () => ipcRenderer.invoke('status'),
  focusChat: () => ipcRenderer.invoke('focus-chat'),
  petProfile: () => ipcRenderer.invoke('pet-profile'),
  onPetAudio: (cb) => ipcRenderer.on('pet-audio', (_e, a) => cb(a)),
  onPetEffect: (cb) => ipcRenderer.on('pet-effect', (_e, a) => cb(a)),
  onBubble: (cb) => ipcRenderer.on('bubble', (_e, t) => cb(t)),
  onWalk: (cb) => ipcRenderer.on('walk', () => cb()),
  onChatDelta: (cb) => ipcRenderer.on('chat-delta', (_e, t) => cb(t)),

  // 快捷输入（⌥Space 随时告诉 TA）
  quickSubmit: (text) => ipcRenderer.invoke('quick-submit', text),
  quickHide: () => ipcRenderer.invoke('quick-hide'),
  onQuickDelta: (cb) => ipcRenderer.on('quick-delta', (_e, t) => cb(t)),
  // 全屏宠物层：鼠标悬停角色时接管事件（可拖拽/点按钮），离开时点击穿透
  petEnter: () => ipcRenderer.send('pet-enter'),
  petLeave: () => ipcRenderer.send('pet-leave'),

  // 管理中心与备份
  manageOpen: (opts) => ipcRenderer.invoke('manage-open', opts),   // opts.page 可直达某页
  onManagePage: (cb) => ipcRenderer.on('manage-page', (_e, p) => cb(p)),
  // TA 的家直达 + 对话房间递文件 + 弹层可见性(TA 原地等)
  homeOpen: () => ipcRenderer.invoke('home-open'),
  homePrefill: (text) => ipcRenderer.invoke('home-prefill', text),          // 开家页 + 预填一句开头
  onHomePrefill: (cb) => ipcRenderer.on('home-prefill', (_e, text) => cb(String(text ?? ''))),
  filePick: () => ipcRenderer.invoke('file-pick'),
  onQuickVisible: (cb) => ipcRenderer.on('quick-visible', (_e, v) => cb(v)),
  // 导出带用户自设密码（6 位数字，界面输两次）——修复「导出静默丢恢复密钥」
  // 导出落点在外面（云盘/外接卷）时，宿主返回 needsConfirm —— 界面点头后
  // 带着 `path` + `confirmed` 再调一次（**第一次一个字节都不写**）
  backupExport: (passphrase, opts) => ipcRenderer.invoke('backup-export', { passphrase, ...(opts ?? {}) }),
  // 记忆包「接回 TA」：用之前带走的包 + 密码把 TA 接回来（不走账号、不联网）。
  // 内核 importPortablePackage 与 IPC portable-import 已有，这里补 preload 与界面的入口。
  backupPick: () => ipcRenderer.invoke('backup-pick'),
  backupImport: (filePath, passphrase) => ipcRenderer.invoke('portable-import', { path: filePath, passphrase }),
  budgetSet: (b) => ipcRenderer.invoke('budget-set', b),
  wardrobe: () => ipcRenderer.invoke('wardrobe'),
  // 授权目录（设置 → 数据与安全）
  folderPick: () => ipcRenderer.invoke('folder-pick'),
  workspaceList: () => ipcRenderer.invoke('workspace-list'),
  workspaceAdd: (dir) => ipcRenderer.invoke('workspace-add', dir),
  workspaceRemove: (dir) => ipcRenderer.invoke('workspace-remove', dir),
  // 销毁本机智能体：先看账单 → 打字确认 → 销毁 → 重启从头开始
  agentFootprint: () => ipcRenderer.invoke('agent-footprint'),
  agentDestroy: (confirm, groups) => ipcRenderer.invoke('agent-destroy', { confirm, groups }),
  appRestart: () => ipcRenderer.invoke('app-restart'),
  // 她看过屏幕几次（从签名链数出来）+ 定时观察开着没有
  screenUsage: () => ipcRenderer.invoke('screen-usage'),
  // 最近几轮的输入是谁给的（你自己说的 / 定时 / 心跳 / 屏幕…）
  turnOrigins: (n) => ipcRenderer.invoke('turn-origins', n),
  // 等待语三套（温柔/干脆/俏皮）
  waitTone: () => ipcRenderer.invoke('wait-tone'),
  waitToneSet: (tone) => ipcRenderer.invoke('wait-tone-set', tone),
  waitTonePreview: () => ipcRenderer.invoke('wait-tone-preview'),
  // 我的规矩（审批卡上点过"以后这类都行"记下的那些）
  myRules: () => ipcRenderer.invoke('my-rules'),
  myRuleRemove: (id) => ipcRenderer.invoke('my-rule-remove', id),
  myRuleAdd: (r) => ipcRenderer.invoke('my-rule-add', r),
  // 市场：源与目录
  marketSources: () => ipcRenderer.invoke('market-sources'),
  marketCatalog: () => ipcRenderer.invoke('market-catalog'),
  marketSourceAdd: (r) => ipcRenderer.invoke('market-source-add', r),
  marketSourceRemove: (id) => ipcRenderer.invoke('market-source-remove', id),
  marketSourceRefresh: (id) => ipcRenderer.invoke('market-source-refresh', id),
  marketPrepare: (item) => ipcRenderer.invoke('market-prepare', item),
  marketInstall: (item) => ipcRenderer.invoke('market-install', item),
  marketInstalled: () => ipcRenderer.invoke('market-installed'),
  marketUninstallPreview: (name) => ipcRenderer.invoke('market-uninstall-preview', name),
  marketUninstallSkill: (name, forget) => ipcRenderer.invoke('market-uninstall-skill', { name, forget }),
  marketUninstallMcp: (name) => ipcRenderer.invoke('market-uninstall-mcp', name),
  marketCheckUpdate: (name) => ipcRenderer.invoke('market-check-update', name),
  myRuleCheck: (r) => ipcRenderer.invoke('my-rule-check', r),
  socialInbox: () => ipcRenderer.invoke('social-inbox'),

  // 换脑不换人 + 能力档位
  llmProviders: () => ipcRenderer.invoke('llm-providers'),
  llmSetProvider: (name) => ipcRenderer.invoke('llm-set-provider', name),
  llmTierSet: (tier) => ipcRenderer.invoke('llm-tier-set', tier),
  plannerPlan: (text) => ipcRenderer.invoke('planner-plan', text),

  // 数字人身上交互——单击对话 / 双击菜单 / 处理文件 / 动作
  // mode 第三参 = lite 纯输入条形态（此前被丢弃 → 单击 TA 总弹完整快捷入口）
  petChat: (at, prefill, mode) => ipcRenderer.invoke('pet-chat', at, prefill, mode),
  petFileTask: () => ipcRenderer.invoke('pet-file-task'),
  petAction: (name) => ipcRenderer.invoke('pet-action', name),
  onPetAction: (cb) => ipcRenderer.on('pet-action', (_e, name) => cb(name)),
  onQuickPrefill: (cb) => ipcRenderer.on('quick-prefill', (_e, t) => cb(t)),
  onQuickMode: (cb) => ipcRenderer.on('quick-mode', (_e, m) => cb(m)),
  outfitWear: (id) => ipcRenderer.invoke('outfit-wear', id),
  live2dModels: () => ipcRenderer.invoke('live2d-models'),
  live2dSetModel: (id) => ipcRenderer.invoke('live2d-set-model', id),
  onPetLive2dModel: (cb) => ipcRenderer.on('pet-live2d-model', (_e, id) => cb(id)),
  // 出镜模式（虚拟摄像头/直播采集）+ 眼神升级（看向输入框/应用）
  stageOpen: () => ipcRenderer.invoke('stage-open'),
  stageClose: () => ipcRenderer.invoke('stage-close'),
  onPetLook: (cb) => ipcRenderer.on('pet-look', (_e, t) => cb(t)),
  // 截图处理 + 拖放文件 + 管理中心关闭通知
  petScreenshot: () => ipcRenderer.invoke('pet-screenshot'),
  petFileDrop: (paths) => ipcRenderer.invoke('pet-file-drop', paths),
  onManageClosed: (cb) => ipcRenderer.on('manage-closed', () => cb()),
  // 屏幕观察（数字人看用户在做什么）
  onScreenObserve: (cb) => ipcRenderer.on('screen-observe', (_e, t) => cb(t)),
  petScreenToggle: () => ipcRenderer.invoke('pet-screen-toggle'),
  // 语音播报开关 + 音色选择（管理面板 → 主进程持久化）
  prefSet: (key, value) => ipcRenderer.invoke('pref-set', { key, value }),
  // 国际化：渲染层取当前语言与词表（ui/i18n.js 消费）
  i18nGet: () => ipcRenderer.invoke('i18n-get'),
  onPetSpeechLocal: (cb) => ipcRenderer.on('pet-speech-local', (_e, a) => cb(a)),
  // 审批通道（宠物窗气泡「TA 想执行：xxx [允许][拒绝]」）
  onApprovalAsk: (cb) => ipcRenderer.on('approval-ask', (_e, d) => cb(d)),
  onApprovalResolved: (cb) => ipcRenderer.on('approval-resolved', (_e, d) => cb(d)),
  // 工作/闲聊模式（家页胶囊 + 桌面形象端都读它）
  modeGet: () => ipcRenderer.invoke('mode-get'),
  modeSet: (mode, lock) => ipcRenderer.invoke('mode-set', { mode, lock }),
  onModeChanged: (cb) => ipcRenderer.on('mode-changed', (_e, d) => cb(d)),
  // 过程可见——关键节点（读什么/改什么/搜什么）与思考摘要
  approvalScopeGet: () => ipcRenderer.invoke('approval-scope-get'),
  approvalScopeSet: (scope) => ipcRenderer.invoke('approval-scope-set', { scope }),
  onChatStep: (cb) => ipcRenderer.on('chat-step', (_e, d) => cb(d)),
  onChatThink: (cb) => ipcRenderer.on('chat-think', (_e, d) => cb(d)),
  onPetStep: (cb) => ipcRenderer.on('pet-step', (_e, d) => cb(d)),
  // 她"开心一下"（用户说了谢谢/夸她/爱她）
  onPetMood: (cb) => ipcRenderer.on('pet-mood', (_e, m) => cb(m)),
  // 答复带**作用域**——'deny' | 'allow' | 'allow-session'；老的布尔写法继续认
  approvalAnswer: (id, decision) => ipcRenderer.invoke('approval-answer', typeof decision === 'boolean' ? { id, allow: decision } : { id, decision }),
  // 长任务中止（输入气泡「停止」按钮）
  // 停止会把队列里的原文一起交还（{ returned:[{id,text}] }），界面放回输入框
  // 对话树（从某句重说 / 分支列表 / 切回）
  chatBranch: (messageId) => ipcRenderer.invoke('chat-branch', { messageId }),
  chatBranches: () => ipcRenderer.invoke('chat-branches'),
  chatBranchSwitch: (id) => ipcRenderer.invoke('chat-branch-switch', { id }),
  chatBranchInfo: () => ipcRenderer.invoke('chat-branch-info'),
  sessionMessages: (limit) => ipcRenderer.invoke('session-messages', { limit }),
  artifactsList: (limit) => ipcRenderer.invoke('artifacts-list', { limit }),
  labelSet: (messageId, text) => ipcRenderer.invoke('label-set', { messageId, text }),
  labelsList: () => ipcRenderer.invoke('labels-list'),
  reviewGet: () => ipcRenderer.invoke('review-get'),
  reviewSet: (on) => ipcRenderer.invoke('review-set', on),
  skillCandidates: () => ipcRenderer.invoke('skill-candidates'),
  skillCandidateDecide: (name, action) => ipcRenderer.invoke('skill-candidate-decide', name, action),
  turnChanges: (turnId) => ipcRenderer.invoke('turn-changes', turnId),
  undoLastTurn: (turnId) => ipcRenderer.invoke('undo-last-turn', turnId),
  kpiSummary: (days) => ipcRenderer.invoke('kpi-summary', days),
  kpiRecord: () => ipcRenderer.invoke('kpi-record'),
  chatExportHtml: (title) => ipcRenderer.invoke('chat-export-html', { title }),
  chatStop: () => ipcRenderer.invoke('chat-stop'),
  // 重连一次问全 + 两档插话 + 队列取回
  chatReattach: () => ipcRenderer.invoke('chat-reattach'),
  chatSteer: (text, expectedTurnId) => ipcRenderer.invoke('chat-steer', { text, expectedTurnId }),
  chatActiveTurn: () => ipcRenderer.invoke('chat-active-turn'),
  chatFollowUp: (text) => ipcRenderer.invoke('chat-followup', { text }),
  chatQueueTake: (kind, id) => ipcRenderer.invoke('chat-queue-take', { kind, id }),
  // 回合结束事件（重载后的窗口也能拿到最终答复）/ 队列变化 / 会话状态
  onChatFinal: (cb) => ipcRenderer.on('chat-final', (_e, d) => cb(d)),
  onChatQueue: (cb) => ipcRenderer.on('chat-queue', (_e, d) => cb(d)),
  onSessionStatus: (cb) => ipcRenderer.on('session-status', (_e, d) => cb(d)),
  onApprovalResolved: (cb) => ipcRenderer.on('approval-resolved', (_e, d) => cb(d)),
  // TA 主动说的一句话（心跳/定时任务/里程碑…）——进对话流，像在同一条对话里继续
  onChatProactive: (cb) => ipcRenderer.on('chat-proactive', (_e, d) => cb(d)),
  // 双击面板「退出」——确认后退出应用
  appQuit: () => ipcRenderer.invoke('app-quit'),
  // App 内出生（欢迎/账号/向导/出生动画——替代导入面板）
  birthDiag: (msg) => ipcRenderer.send('birth-diag', msg),
  // 形象端现场诊断（点环绕钮时把「模型还在不在 / 她在哪」写进 diag.log）
  petDiag: (msg) => ipcRenderer.send('pet-diag', msg),
  // 平台服务器地址（换服务器可在出生向导里填地址）
  birthPlatformGet: () => ipcRenderer.invoke('birth-platform-get'),
  birthPlatformSet: (base) => ipcRenderer.invoke('birth-platform-set', { base }),
  birthPlatformTest: (base) => ipcRenderer.invoke('birth-platform-test', { base }),
  // 离线测试假登录/出生（测试阶段免平台）
  birthMockMode: (on) => ipcRenderer.invoke('birth-mock-mode', { on }),
  birthMockStatus: () => ipcRenderer.invoke('birth-mock-status'),
  birthRegister: (email, pass) => ipcRenderer.invoke('birth-auth-register', { email, pass }),
  birthLogin: (email, pass) => ipcRenderer.invoke('birth-auth-login', { email, pass }),
  birthMe: (token) => ipcRenderer.invoke('birth-auth-me', { token }),
  birthTemplates: () => ipcRenderer.invoke('birth-templates'),
  birthApply: (token, selections) => ipcRenderer.invoke('birth-apply', { token, selections }),
  // 本地出生（不用账号）——内置性格卡 + 本地自签包，不联网
  birthLocalTemplates: () => ipcRenderer.invoke('birth-local-templates'),
  birthLocal: (selections) => ipcRenderer.invoke('birth-local', { selections }),
  birthWaitReady: (token, id) => ipcRenderer.invoke('birth-wait-ready', { token, id }),
  birthBind: (token, id) => ipcRenderer.invoke('birth-bind', { token, id }),
  birthSpeak: (text, emotion) => ipcRenderer.invoke('birth-speak', { text, emotion }),
  birthDone: () => ipcRenderer.invoke('birth-done'),
  // 自定义大脑/连通测试/历史聊天/技能库/MCP 管理（管理中心四功能）
  llmCustomSet: (cfg) => ipcRenderer.invoke('llm-custom-set', cfg),
  llmCustomRemove: (name) => ipcRenderer.invoke('llm-custom-remove', name),
  llmTestProvider: (cfg) => ipcRenderer.invoke('llm-test-provider', cfg),
  llmTestSaved: (name) => ipcRenderer.invoke('llm-test-saved', name),
  // 面板配置供应商密钥 + 自由切换供应商模型（大脑卡片内操作）
  llmKeySet: (name, key) => ipcRenderer.invoke('llm-key-set', { name, key }),
  llmModelSet: (name, model) => ipcRenderer.invoke('llm-model-set', { name, model }),
  chatHistory: (limit) => ipcRenderer.invoke('chat-history', limit),
  // Home 主场（今日聚合/关系问候/任务状态只读查询——set 是测试钩子不对 UI 开放）
  todayAggregate: () => ipcRenderer.invoke('today-aggregate'),
  greeting: () => ipcRenderer.invoke('greeting'),
  moodBar: () => ipcRenderer.invoke('mood-bar'),   // 她的心情（家页情绪条）
  // 右栏待办（增删改优先级/勾选；数据在 <dataDir>/todos.json）
  todoList: () => ipcRenderer.invoke('todo-list'),
  todoAdd: (text, opts) => ipcRenderer.invoke('todo-add', { text, ...(opts ?? {}) }),
  todoSetPriority: (id, priority) => ipcRenderer.invoke('todo-set-priority', { id, priority }),
  todoToggle: (id, done) => ipcRenderer.invoke('todo-toggle', { id, done }),
  todoRemove: (id) => ipcRenderer.invoke('todo-remove', { id }),
  taskStateGet: () => ipcRenderer.invoke('__ui2-task-state', { op: 'get' }),
  onTaskState: (cb) => ipcRenderer.on('task-state', (_e, ev) => cb(ev)),
  onOpenChatlog: (cb) => ipcRenderer.on('open-chatlog', () => cb()),
  recentIntents: (next) => ipcRenderer.invoke('recent-intents', next),
  // 记忆中心 + 我的 TA
  memoriesAll: () => ipcRenderer.invoke('memories-all'),
  memoryUpdate: (name, patch) => ipcRenderer.invoke('memory-update', { name, ...patch }),
  memoryDelete: (name) => ipcRenderer.invoke('memory-delete', { name }),
  memoriesClearAll: () => ipcRenderer.invoke('memories-clear-all'),
  memoryPausedSet: (on) => ipcRenderer.invoke('memory-paused-set', { on }),
  // 候选态批准/忽略 + Identity 规矩三件 + TTL 开关
  memorySetStatus: (name, status) => ipcRenderer.invoke('memory-set-status', { name, status }),
  // 用户打分（有用 +0.05 / 没用 −0.10，罚是奖的两倍）
  memoryRate: (name, kind) => ipcRenderer.invoke('memory-rate', { name, kind }),
  identityAll: () => ipcRenderer.invoke('identity-all'),
  identityAdd: (text) => ipcRenderer.invoke('identity-add', { text }),
  identityRemove: (index) => ipcRenderer.invoke('identity-remove', { index }),
  memoryTtlSet: (on) => ipcRenderer.invoke('memory-ttl-set', { on }),
  meOpen: (view, tab) => ipcRenderer.invoke('me-open', { view, tab }),
  convOpen: () => ipcRenderer.invoke('conv-open'),
  // 冒烟钩子（与生产同一条链路：createPendingApproval / approvalPublicList）；普通界面不调用
  __ui2Approval: (payload) => ipcRenderer.invoke('__ui2-approval', payload),
  convClose: () => ipcRenderer.invoke('conv-close'),
  onConvInvite: (cb) => ipcRenderer.on('conv-invite', () => cb()),
  facetSet: (key) => ipcRenderer.invoke('facet-set', key),
  facetGet: () => ipcRenderer.invoke('facet-get'),
  skillInstall: (source, name) => ipcRenderer.invoke('skill-install', { source, name }),
  skillSetEnabled: (name, enabled) => ipcRenderer.invoke('skill-set-enabled', { name, enabled }),
  mcpInstall: (name, url) => ipcRenderer.invoke('mcp-install', { name, url }),
  mcpSetEnabled: (name, enabled) => ipcRenderer.invoke('mcp-set-enabled', { name, enabled }),
  skillsList: () => ipcRenderer.invoke('skills-list'),
  mcpList: () => ipcRenderer.invoke('mcp-list'),
  // 任务账本 + 定时任务（管理中心「进行中的事」卡片）
  taskList: () => ipcRenderer.invoke('task-list'),
  taskControl: (id, action) => ipcRenderer.invoke('task-control', { id, action }),
  arrangeOpen: (tab) => ipcRenderer.invoke('arrange-open', { tab }),   // 帮我安排三页
  cronList: () => ipcRenderer.invoke('cron-list'),
  cronStopAll: () => ipcRenderer.invoke('cron-stop-all'),
  // 无人值守时被拒的那些事（攒着等用户回来）
  bgBlockedList: () => ipcRenderer.invoke('bg-blocked-list'),
  bgBlockedClear: (id) => ipcRenderer.invoke('bg-blocked-clear', id),
  cronCancel: (id) => ipcRenderer.invoke('cron-cancel', id),
  // 日历（家页面的日历卡）
  calendarToday: () => ipcRenderer.invoke('calendar-today'),
  calendarMonth: (year, month) => ipcRenderer.invoke('calendar-month', { year, month }),
  calendarYear: (year) => ipcRenderer.invoke('calendar-year', year),
  calendarDay: (date) => ipcRenderer.invoke('calendar-day', date),
  calendarUpcoming: (count) => ipcRenderer.invoke('calendar-upcoming', count),
  birthdayAdd: (key, label) => ipcRenderer.invoke('birthday-add', { key, label }),
  birthdayRemove: (key) => ipcRenderer.invoke('birthday-remove', key),
  birthdayList: () => ipcRenderer.invoke('birthday-list'),
  // 模型清单（状态 / 联网开关 / 手动刷新）
  catalogStatus: () => ipcRenderer.invoke('catalog-status'),
  catalogSetNetwork: (on, baseUrl) => ipcRenderer.invoke('catalog-set-network', { on, baseUrl }),
  catalogRefresh: (provider) => ipcRenderer.invoke('catalog-refresh', provider),
  // 真拉一次该厂商的可用模型列表（进下拉）
  llmFetchModels: (name) => ipcRenderer.invoke('llm-models-fetch', name),
  // 花销（这个月花了多少 / 刚才那轮为什么贵）
  costSummary: () => ipcRenderer.invoke('cost-summary'),
  costExplainLast: () => ipcRenderer.invoke('cost-explain-last'),
  // 右侧预览（改完的文档不切出去也能看；也能用系统应用打开/在访达里显示）
  previewFile: (file) => ipcRenderer.invoke('preview-file', file),
  previewOpenExternal: (file) => ipcRenderer.invoke('preview-open-external', file),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),   // 开 https 外链（获取 API Key）
  previewReveal: (file) => ipcRenderer.invoke('preview-reveal', file),
  fileInfo: (file) => ipcRenderer.invoke('file-info', file),   // 文件芯片的「行数/大小」
  fileHistory: (limit) => ipcRenderer.invoke('file-history', limit),   // 经手文件流
  petOutfitOpen: () => ipcRenderer.invoke('pet-outfit-open'),           // 换装面板入口
  onPetOpenOutfit: (cb) => ipcRenderer.on('pet-open-outfit', () => cb()),
  onFilesChanged: (cb) => ipcRenderer.on('files-changed', (_e, list) => cb(list)),
});
