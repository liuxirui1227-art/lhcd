// 1+N 侧面（facet）框架：
// 一个领域侧面 = 宪法 overlay（专业表达规范，不改核心人格）+ 记忆分区 + 技能包 + 专业范例。
// 用户永远只面对 Companion；切换 = 换 overlay 和分区，不换人格、不换脸、不换声音。
// 权限矩阵：Companion 全读写（信任锚点）；侧面最小权限；矩阵随注册表版本化。

export interface FacetDef {
  key: string;
  label: string;
  /** 宪法 overlay：叠加的专业表达规范（注入 user 输入前缀，不破坏冻结前缀） */
  overlay: string;
  /** 记忆分区读写域 */
  domains: string[];
}

/** 数据域（权限矩阵的列） */
export const DOMAINS = ['schedule', 'emotion_log', 'work_log', 'private_diary'] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABELS: Record<Domain, string> = {
  schedule: '日程/目标',
  emotion_log: '情绪日志',
  work_log: '职场沟通记录',
  private_diary: '私人倾诉',
};

/** 出厂侧面（v0 三个，可热插拔扩展） */
export const DEFAULT_FACETS: FacetDef[] = [
  {
    key: 'career',
    label: '职场侧面',
    overlay:
      '【职场侧面】当前以职场侧面交流：表达更严谨、结构化，结论先行，就事论事；' +
      '保持专业判断，给建议时给出理由与利弊；不改变人格，仍是同一个 TA。',
    domains: ['schedule', 'work_log'],
  },
  {
    key: 'emotion',
    label: '情感侧面',
    overlay:
      '【情感侧面】当前以情感侧面交流：更放松、更细腻地谈论感受与关系；' +
      '多倾听、多共情，帮我把情绪理清楚；不改变人格，仍是同一个 TA。',
    domains: ['emotion_log', 'private_diary'],
  },
  {
    key: 'study',
    label: '学习侧面',
    overlay:
      '【学习侧面】当前以学习侧面交流：讲解清晰、由浅入深，善用例子与类比；' +
      '帮我建立知识框架并检验理解；不改变人格，仍是同一个 TA。',
    domains: ['schedule'],
  },
];

/**
 * 权限矩阵：Companion 全读写（信任锚点）；侧面最小权限。
 * 返回 'rw' | 'r' | 'none'；跨域共享需用户授权（授权记录入日志，TODO(spec) 2.0 授权流）。
 */
export function domainAccess(domain: Domain, facetKey: string | 'companion'): 'rw' | 'r' | 'none' {
  if (facetKey === 'companion') return 'rw'; // 信任锚点
  const facet = DEFAULT_FACETS.find((f) => f.key === facetKey);
  if (!facet) return 'none';
  if (facet.domains.includes(domain)) return 'rw'; // 本域数据
  if (domain === 'schedule') return 'r';           // 日程对侧面只读（示例规则）
  return 'none';
}

/** 记忆分区过滤：侧面只能看到自己有权限的域（未打标条目归一为 schedule 域：所有侧面可读） */
export function filterDomains(entries: Array<{ domain?: Domain; [k: string]: unknown }>, facetKey: string | 'companion') {
  return entries.filter((e) => domainAccess(e.domain ?? 'schedule', facetKey) !== 'none');
}

/** facet 切换：换 overlay 和分区，不换人格（宪法/冻结前缀不动） */
export function facetById(key: string): FacetDef | undefined {
  return DEFAULT_FACETS.find((f) => f.key === key);
}

/**
 * 域标签自动分类（记忆写入自动打标，facet 分区过滤才真正生效）。
 * 轻量关键词分类器：工作 → work_log；情绪/私人 → emotion_log；日程/学习 → schedule；默认 schedule。
 * 顺序敏感（先工作后情绪：加班类先归工作域；情绪词优先度实际高于工作，见实现）。
 */
/* ⚠ 三张表按语言补齐，匹配时**五语并集**（用户用什么语言说都能归对域）：
   只收中文不够——英文用户说 "my manager asked for the report" 会被归到通用域（schedule），
   情绪倾诉 "I feel lonely" 也进不了 emotion_log（那是**最敏感**的一档，归错等于分区过滤失效）。 */
const WORK_WORDS = [
  '工作', '项目', '开会', '会议', '领导', '同事', '客户', '汇报', '报告', '任务', '加班', '职场', '方案', '周报', '面试', '合同', '招聘', '公司', '部门', '上线', '交付', 'deadline', 'ddl', '排期', '需求', '复盘工作',
  '工作', '專案', '開會', '會議', '主管', '同事', '客戶', '報告', '任務', '加班', '職場', '方案', '週報', '面試', '合約', '招募', '公司', '部門', '上線', '交付',
  'work', 'project', 'meeting', 'manager', 'colleague', 'client', 'report', 'task', 'overtime', 'deadline', 'proposal', 'review', 'interview', 'contract', 'hiring', 'company', 'team', 'launch', 'deliverable', 'sprint',
  '仕事', 'プロジェクト', '会議', '上司', '同僚', 'クライアント', '報告', 'タスク', '残業', '職場', '提案', '面接', '契約', '採用', '会社', '部署', 'リリース', '納品', '締め切り',
  '일', '업무', '프로젝트', '회의', '상사', '동료', '고객', '보고', '보고서', '업무량', '야근', '직장', '제안', '면접', '계약', '채용', '회사', '부서', '출시', '납품',
];
const EMOTION_WORDS = [
  '难过', '开心', '焦虑', '孤独', '孤单', '压力', '生气', '委屈', '害怕', '想哭', '失眠', '失恋', '崩溃', '喜欢', '爱', '烦', '累', '情绪', '心情', '感受', '倾诉', '秘密', '心事', '表白', '家人', '对象', '男朋友', '女朋友',
  '難過', '開心', '焦慮', '孤獨', '壓力', '生氣', '委屈', '害怕', '失眠', '失戀', '崩潰', '喜歡', '情緒', '心情', '感受', '傾訴', '秘密', '心事', '表白', '家人',
  'sad', 'happy', 'anxious', 'lonely', 'stress', 'angry', 'upset', 'scared', 'cry', 'insomnia', 'heartbroken', 'love', 'feel', 'feeling', 'mood', 'confide', 'secret', 'family', 'partner', 'boyfriend', 'girlfriend',
  '悲しい', '嬉しい', '不安', '寂しい', '孤独', 'ストレス', '怒り', 'つらい', '泣きたい', '不眠', '失恋', '好き', '気持ち', '感情', '相談', '秘密', '家族', '恋人',
  '슬퍼', '기뻐', '불안', '외로워', '스트레스', '화나', '속상해', '무서워', '울고', '불면', '실연', '좋아', '기분', '감정', '고민', '비밀', '가족', '연인',
];
const SCHEDULE_WORDS = [
  '计划', '日程', '安排', '目标', '提醒', '明天', '下周', '学习', '课程', '复习', '考试', '读书', '待办', '约会', '旅行', '预算',
  '計畫', '行程', '安排', '目標', '提醒', '明天', '下週', '學習', '課程', '複習', '考試', '待辦', '約會', '旅行', '預算',
  'plan', 'schedule', 'calendar', 'goal', 'remind', 'tomorrow', 'next week', 'study', 'course', 'exam', 'reading', 'todo', 'date', 'trip', 'budget',
  '予定', 'スケジュール', '目標', 'リマインド', '明日', '来週', '勉強', '講義', '試験', '読書', 'やること', 'デート', '旅行', '予算',
  '계획', '일정', '목표', '알림', '내일', '다음 주', '공부', '강의', '시험', '독서', '할 일', '데이트', '여행', '예산',
];

export function classifyDomain(text: string): Domain {
  const t = String(text ?? '');
  const low = t.toLowerCase();          // 英文词条大小写不敏感（"Report" 也要认）
  const has = (words: string[]) => words.some((w) => (/[a-z]/i.test(w) ? low.includes(w.toLowerCase()) : t.includes(w)));
  // 情绪优先：情绪/私人倾诉最敏感，宁归 emotion_log 也不落到工作域
  if (has(EMOTION_WORDS)) return 'emotion_log';
  if (has(WORK_WORDS)) return 'work_log';
  if (has(SCHEDULE_WORDS)) return 'schedule';
  return 'schedule'; // 无信号 → 通用域
}
