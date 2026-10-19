// 衣柜系统 v0：资产 + 穿衣记忆 + 自主穿搭评分。
// 每件衣服有来历叙事（"这件是你送我的生日礼物"）；偏好穿有故事的衣物。
// v0 = 数据层与决策逻辑（换装渲染待全身 3D 后接入形象层）。

export type WardrobeCategory = 'dress' | 'top' | 'bottom' | 'accessory';
export type WardrobeOrigin = 'birth' | 'milestone' | 'gift' | 'purchase';

export interface WardrobeItem {
  id: string;
  name: string;
  category: WardrobeCategory;
  origin: WardrobeOrigin;
  /** 来历叙事：穿衣记忆的核心（生日礼物/逛街买的/剧情获得…） */
  story: string;
  acquiredAt: number;
  wornCount: number;
}

export interface WardrobeState {
  items: WardrobeItem[];
}

/** 出生基础款（每件都有来历叙事） */
export function initialWardrobe(now: number): WardrobeState {
  return {
    items: [
      { id: 'birth-dress', name: '初生之衣', category: 'dress', origin: 'birth', story: '出生时穿上的第一件衣服', acquiredAt: now, wornCount: 0 },
      { id: 'birth-casual', name: '日常便装', category: 'top', origin: 'birth', story: '陪你度过平常日子的常服', acquiredAt: now, wornCount: 0 },
    ],
  };
}

/** 获得新衣服（礼物/购买/剧情）→ 进衣柜并带叙事；重复 id 忽略 */
export function acquire(state: WardrobeState, item: Omit<WardrobeItem, 'acquiredAt' | 'wornCount'>, now: number): { state: WardrobeState; added: boolean } {
  if (state.items.some((i) => i.id === item.id)) return { state, added: false };
  return {
    state: {
      items: [...state.items, { ...item, acquiredAt: now, wornCount: 0 }],
    },
    added: true,
  };
}

export interface OutfitContext {
  /** 场合：daily 日常 / date 约会 / formal 正式 / home 居家 */
  occasion?: 'daily' | 'date' | 'formal' | 'home';
  /** 心情（情绪分类） */
  emotion?: string;
}

const OCCASION_BIAS: Record<string, Partial<Record<WardrobeCategory, number>>> = {
  daily: { top: 1, bottom: 1 },
  date: { dress: 1.5 },
  formal: { dress: 1.2 },
  home: { top: 0.6 },
};

/** 自主穿搭（按场合/心情/穿衣记忆评分，决策逻辑是宪法风格的延伸） */
export function chooseOutfit(state: WardrobeState, ctx: OutfitContext = {}): WardrobeItem | null {
  const occasion = ctx.occasion ?? 'daily';
  const bias = OCCASION_BIAS[occasion] ?? {};
  let best: WardrobeItem | null = null;
  let bestScore = -Infinity;
  for (const item of state.items) {
    let score = 1;
    score += bias[item.category] ?? 0;
    if (item.story && item.story.trim().length > 0) score += 1.2;   // 穿衣记忆：有故事的衣服加分
    if (item.origin === 'gift') score += 0.4;                       // 礼物有情感加成（"你送的"更有意义）
    if (item.wornCount > 0) score += Math.log2(item.wornCount + 1) * 0.2; // 轻微常穿偏好
    if (ctx.emotion === 'joy' && item.category === 'dress') score += 0.8; // 开心穿裙子
    if (ctx.emotion === 'comfort' && item.category === 'top') score += 0.5; // 需要安慰穿常服
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}

/** 穿着记录：wornCount +1（穿衣记忆累积） */
export function wear(state: WardrobeState, id: string): WardrobeState {
  return {
    items: state.items.map((i) => (i.id === id ? { ...i, wornCount: i.wornCount + 1 } : i)),
  };
}
