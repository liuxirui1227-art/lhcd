// 灵核 · 日历（年月日周 + 假期 + 24 节气 + 生日标注 + 黄道日历）
//
// 数据来源（都真，不编）：
//   · 农历 / 24 节气 / 干支 / 生肖 / 宜忌（黄道）—— `lunar-javascript`（MIT，纯 JS，随包）
//   · 法定节假日与调休 —— `data/holidays-2026.json`（**数据文件**，来源是国务院办公厅通知，逐年更新）
//   · 生日 —— 用户手填（`<dataDir>/birthdays.json`）+ 从她的记忆里认（认出来的会标"来自记忆"）
//
// 一条纪律：**不知道就说不知道**——某年节假日数据没录进来时，如实显示"这一年的放假安排还没更新"，
// 不拿往年的日期糊弄（放假日期差一天，是要误事的）。
import fs from 'node:fs';
import path from 'node:path';
// 农历/节气/干支/宜忌引擎（MIT）——**静态导入**，这样打包时能被压进单文件
import lunarPkg from 'lunar-javascript';

const Solar = lunarPkg.Solar ?? lunarPkg.default?.Solar;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 公历固定节日（不含农历节日——那些从农历库取） */
const SOLAR_FESTIVALS = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '03-12': '植树节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '07-01': '建党节',
  '08-01': '建军节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
};

/** 常见农历节日（农历月-日） */
const LUNAR_FESTIVALS = {
  '1-1': '春节',
  '1-15': '元宵节',
  '2-2': '龙抬头',
  '5-5': '端午节',
  '7-7': '七夕',
  '7-15': '中元节',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节',
  '12-23': '小年',
};

function pad(n) {
  return String(n).padStart(2, '0');
}
export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function lmd(d) {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把 `M-D` / `MM-DD` 归一成 `M-D`（手填的生日常常不补零，两边都要认） */
function normMd(v) {
  const [m, d] = String(v ?? '').split('-');
  return `${Number(m)}-${Number(d)}`;
}

/** 内置农历适配器（把 lunar-javascript 包成上面 dayInfo 要的形状） */
export function lunarAdapter(date) {
  const l = Solar.fromDate(date).getLunar();
  return {
    lunarText: l.getMonthInChinese() + '月' + l.getDayInChinese(),
    lunarMonthDay: `${Math.abs(l.getMonth())}-${l.getDay()}`,
    jieqi: l.getJieQi() || null,
    ganzhi: `${l.getYearInGanZhi()}年 ${l.getDayInGanZhi()}日`,
    shengxiao: l.getYearShengXiao(),
    yi: l.getDayYi(),
    ji: l.getDayJi(),
  };
}

/** 未来节气表（库自带；用于"接下里要过的日子"兜底） */
export function jieqiTable(from) {
  const t = Solar.fromDate(from).getLunar().getJieQiTable();
  const ymdOf = (d) => `${d.getYear()}-${pad(d.getMonth())}-${pad(d.getDay())}`;
  return Object.entries(t)
    .map(([name, solar]) => ({ name, date: ymdOf(solar) }))
    .filter((x) => x.date >= ymd(from))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 一站式：今天 / 某月 / 接下来（宿主直接用这三个，不必自己拼适配器） */
export function todayInfo(dataDir, holidaysFile, now = new Date()) {
  const hol = holidaysFor(now.getFullYear(), holidaysFile);
  return { info: dayInfo(now, { lunar: lunarAdapter, birthdays: readBirthdays(dataDir), holidays: hol }), holidays: hol };
}
export function monthInfo(dataDir, holidaysFile, year, month) {
  const hol = holidaysFor(year, holidaysFile);
  return { grid: monthGrid(year, month, { lunar: lunarAdapter, birthdays: readBirthdays(dataDir), holidays: hol }), holidays: hol };
}
export function upcomingInfo(dataDir, holidaysFile, count, now = new Date()) {
  const hol = holidaysFor(now.getFullYear(), holidaysFile);
  return upcoming(now, count, { lunar: lunarAdapter, birthdays: readBirthdays(dataDir), holidays: hol, jieqiTable });
}

/** 读节假日数据（逐年；没有那一年就如实返回 null，不拿别的年份凑） */
export function holidaysFor(year, file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const y = j?.years?.[String(year)];
    if (!y) return { year, known: false, holidays: {}, workdays: {}, source: j?.source ?? '' };
    return { year, known: true, holidays: y.holidays ?? {}, workdays: y.workdays ?? {}, source: j?.source ?? '' };
  } catch {
    return { year, known: false, holidays: {}, workdays: {}, source: '' };
  }
}

/** 读生日表（`MM-DD` 或 `YYYY-MM-DD`；值是人话标签） */
export function readBirthdays(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'birthdays.json'), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
export function writeBirthdays(dataDir, map) {
  const f = path.join(dataDir, 'birthdays.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(map, null, 2));
  return { ok: true };
}
/** 今天是不是谁的生日（兼容 `MM-DD` 与 `YYYY-MM-DD` 两种写法） */
export function birthdaysOn(key, map) {
  const out = [];
  const want = normMd(key);
  for (const [k, label] of Object.entries(map ?? {})) {
    const mmdd = k.length > 5 ? k.slice(5) : k; // 兼容 YYYY-MM-DD
    if (normMd(mmdd) === want) out.push({ key: k, label: String(label) });
  }
  return out;
}

/**
 * 某一天的完整信息（农历/节气/节日/假期/干支/宜忌/生日）。
 * lunarLib 由调用方注入（便于单测替换）；缺了就用不了农历那部分，但**公历与假期照常**。
 */
export function dayInfo(date, { lunar, birthdays = {}, holidays = { known: false, holidays: {}, workdays: {} } } = {}) {
  const key = ymd(date);
  const mmdd = lmd(date);
  const info = {
    date: key,
    weekday: WEEKDAYS[date.getDay()],
    solarFestival: SOLAR_FESTIVALS[mmdd] ?? null,
    holiday: holidays.holidays?.[key] ?? null,
    workday: holidays.workdays?.[key] ?? null,
    lunar: null,
    jieqi: null,
    lunarFestival: null,
    ganzhi: null,
    shengxiao: null,
    yi: [],
    ji: [],
    birthdays: birthdaysOn(mmdd, birthdays),
  };
  if (lunar) {
    try {
      const l = lunar(date);
      info.lunar = l.lunarText; // 如「八月初九」
      info.lunarMonthDay = l.lunarMonthDay; // 如「8-9」（传统节日匹配用）
      info.jieqi = l.jieqi ?? null;
      info.lunarFestival = info.lunarMonthDay ? (LUNAR_FESTIVALS[info.lunarMonthDay] ?? null) : null;
      info.ganzhi = l.ganzhi;
      info.shengxiao = l.shengxiao;
      info.yi = l.yi ?? [];
      info.ji = l.ji ?? [];
    } catch { /* 农历失败不影响公历部分 */ }
  }
  return info;
}

/** 一个月（按周铺开，前面补空） */
export function monthGrid(year, month, opts = {}) {
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const lead = first.getDay(); // 周日开头
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(dayInfo(new Date(year, month - 1, d), opts));
  while (cells.length % 7 !== 0) cells.push(null);
  return {
    year,
    month,
    title: `${year} 年 ${month} 月`,
    weekdays: WEEKDAYS,
    weeks: [], // 由 UI 按 7 切；这里给 cells 就够
    cells,
    holidaysKnown: !!(opts.holidays?.known),
  };
}

/** 接下来要过的日子（节气/节日/假期/生日/调休），带倒计时 */
export function upcoming(from, count = 6, opts = {}) {
  const out = [];
  const lunar = opts.lunar;
  const birthdays = opts.birthdays ?? {};
  const holidays = opts.holidays ?? { known: false, holidays: {}, workdays: {} };
  // 节气：从农历库里取未来一年内的（库自带节气表）
  let jieqiList = [];
  if (lunar && typeof opts.jieqiTable === 'function') {
    try { jieqiList = opts.jieqiTable(from); } catch { jieqiList = []; }
  }
  for (let i = 0; i < 400 && out.length < count * 3; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const info = dayInfo(d, { lunar, birthdays, holidays });
    const tags = [];
    if (info.jieqi) tags.push(`节气·${info.jieqi}`);
    if (info.holiday) tags.push(`放假·${info.holiday}`);
    if (info.solarFestival) tags.push(info.solarFestival);
    if (info.lunarFestival) tags.push(info.lunarFestival);
    for (const b of info.birthdays) tags.push(`生日·${b.label}`);
    // 节气表里那天也算（有些节气不在当日 jieqi 字段里，用表兜底）
    for (const jq of jieqiList) {
      if (jq.date === info.date && !tags.some((t) => t.startsWith('节气'))) tags.push(`节气·${jq.name}`);
    }
    if (tags.length) {
      out.push({ date: info.date, weekday: info.weekday, daysAway: i, tags, lunar: info.lunar });
      if (out.filter((x) => x.daysAway > 0).length >= count) break;
    }
  }
  return out.filter((x) => x.daysAway > 0).slice(0, count);
}
