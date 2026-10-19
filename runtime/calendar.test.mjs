// 日历单测：农历/节气/干支/宜忌/假期/调休/生日/倒计时（真 lunar-javascript，真官方假期数据）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { dayInfo, monthGrid, upcoming, holidaysFor, readBirthdays, writeBirthdays, birthdaysOn, ymd } from './calendar.mjs';

const { Solar } = await import('lunar-javascript');
const DATA = path.join(path.dirname(new URL(import.meta.url).pathname), 'data', 'holidays-2026.json');

/** 适配器：把 lunar-javascript 包成 dayInfo 要的形状 */
function lunarAdapter(date) {
  const s = Solar.fromDate(date);
  const l = s.getLunar();
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
function jieqiTable(from) {
  const s = Solar.fromDate(from);
  const t = s.getLunar().getJieQiTable();
  return Object.entries(t)
    .map(([name, solar]) => ({ name, date: ymd(new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay())) }))
    .filter((x) => x.date >= ymd(from))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

test('官方假期数据：春节 2/15–2/23 九天、调休 2/14 与 2/28（照 gov.cn 通知核对）', () => {
  const h = holidaysFor(2026, DATA);
  assert.equal(h.known, true);
  assert.equal(h.holidays['2026-02-15'], '春节');
  assert.equal(h.holidays['2026-02-23'], '春节');
  assert.equal(h.holidays['2026-02-14'], undefined, '2/14 是调休上班，不是放假日');
  assert.match(h.workdays['2026-02-14'], /调休上班/);
  assert.equal(h.holidays['2026-10-01'], '国庆节');
  assert.equal(h.holidays['2026-10-07'], '国庆节');
  assert.match(h.workdays['2026-09-20'], /调休上班/);
  // 没录入的年份要**如实说不知道**（不拿别的年份凑）
  const h2027 = holidaysFor(2027, DATA);
  assert.equal(h2027.known, false);
  assert.deepEqual(h2027.holidays, {});
});

test('某一天：公历+农历+节气+干支+生肖+宜忌 都在（真农历库）', () => {
  const d = new Date(2026, 8, 19); // 2026-09-19
  const info = dayInfo(d, { lunar: lunarAdapter, holidays: holidaysFor(2026, DATA) });
  assert.equal(info.date, '2026-09-19');
  assert.equal(info.weekday, '六');
  assert.match(info.lunar, /八月/);
  assert.equal(info.lunarMonthDay, '8-9');
  assert.match(info.ganzhi, /丙午年/);
  assert.equal(info.shengxiao, '马');
  assert.ok(info.yi.length > 0, '宜要有内容（黄道日历数据）');
  assert.ok(info.ji.length > 0, '忌要有内容');
  // 那天是调休上班日之外的普通周六
  assert.equal(info.holiday, null);
});

test('传统节日：中秋（农历八月十五）与春节（正月初一）认得出来', () => {
  const mid = dayInfo(new Date(2026, 8, 25), { lunar: lunarAdapter, holidays: holidaysFor(2026, DATA) });
  assert.equal(mid.lunarFestival, '中秋节');
  assert.equal(mid.holiday, '中秋节', '2026-09-25 也是官方放假日');
  const cny = dayInfo(new Date(2026, 1, 17), { lunar: lunarAdapter, holidays: holidaysFor(2026, DATA) });
  assert.equal(cny.lunarFestival, '春节');
});

test('节气：立冬那天读得出来（24 节气）', () => {
  const info = dayInfo(new Date(2026, 10, 7), { lunar: lunarAdapter, holidays: holidaysFor(2026, DATA) });
  assert.equal(info.jieqi, '立冬');
});

test('生日标注：手填的生日在当天标出来（两种写法都认）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-cal-'));
  writeBirthdays(dir, { '09-19': '妈妈', '1990-02-15': '老同学' });
  const map = readBirthdays(dir);
  assert.equal(birthdaysOn('09-19', map).length, 1);
  assert.equal(birthdaysOn('09-19', map)[0].label, '妈妈');
  assert.equal(birthdaysOn('02-15', map)[0].label, '老同学', '带年份的写法也要在每年同一天标出来');
  const info = dayInfo(new Date(2026, 8, 19), { lunar: lunarAdapter, birthdays: map, holidays: holidaysFor(2026, DATA) });
  assert.equal(info.birthdays[0].label, '妈妈');
});

test('月历：铺成整周（前面补空），每天的假期/节气/生日都带出来', () => {
  const grid = monthGrid(2026, 10, { lunar: lunarAdapter, holidays: holidaysFor(2026, DATA) });
  assert.equal(grid.title, '2026 年 10 月');
  assert.ok(grid.cells.length % 7 === 0, '必须是整周');
  const d1 = grid.cells.find((c) => c && c.date === '2026-10-01');
  assert.equal(d1.holiday, '国庆节');
  assert.equal(d1.solarFestival, '国庆节');
  const d10 = grid.cells.find((c) => c && c.date === '2026-10-10');
  assert.match(d10.workday, /调休上班/);
});

test('倒计时：接下来要过的日子（假期/节气/生日）带"还有几天"', () => {
  const from = new Date(2026, 8, 19);
  const up = upcoming(from, 5, { lunar: lunarAdapter, birthdays: { '09-25': '小美' }, holidays: holidaysFor(2026, DATA), jieqiTable });
  assert.ok(up.length >= 3, JSON.stringify(up));
  assert.ok(up.every((x) => x.daysAway > 0), '不含今天');
  assert.ok(up.some((x) => x.tags.some((t) => t.includes('中秋'))), JSON.stringify(up.map((x) => x.tags)));
  const distance = up.find((x) => x.tags.some((t) => t.includes('生日')));
  assert.equal(distance.daysAway, 6, '9/19 → 9/25 是 6 天后');
});
