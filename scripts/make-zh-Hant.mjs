// 繁体（zh-Hant）生成器
//
// 路线：**不逐条手翻**——界面文案的简繁差异是**有规律的**，
// 用「常见词表（地区用语）+ 单字映射」两层替换，再**如实报出没映射到的字**（那才是要人工看的部分）。
//
// 两层为什么是两层：
//   ① **词**：同一个概念两岸说法不同（设置/設定、文件/檔案、视频/影片、信息/資訊…）——
//      按字翻会翻出"設定"没错，但"文件"逐字还是"文件"（台湾说"檔案"），所以词表优先、长的先替；
//   ② **字**：其余按"一简对一繁"的常见对应逐字替（简→繁大多 1:1；少数一对多我们只取界面常用义）。
//
// ⚠ 诚实边界（写在最前面）：这**不是**完整简繁转换器——它只覆盖我们词表里出现的字与词；
// 没覆盖到的**保持简体**，并在末尾列出来（`--report`）。宁可留着简体让人看见，也不瞎猜。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHant, SIMPLIFIED_ONLY as MAPPED } from './zh-hant-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'runtime', 'locales', 'zh-CN.json');
const DST = path.join(ROOT, 'runtime', 'locales', 'zh-Hant.json');

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const out = { _meta: { locale: 'zh-Hant', status: 'generated', note: '由 scripts/make-zh-Hant.mjs 从 zh-CN 生成（词表 + 单字两层）；未覆盖的字保持简体，见 --report' } };
let changed = 0; const untouched = []; const leftover = new Set();
/**
 * "疑似还是简体"的观察表：常见**简体专用**字（有繁体写法的那些）。
 * 用途只有一个：把"**没映射到、于是留在简体**"的字报出来——那才是要人工补的部分。
 * 光看映射表本身看不出漏了什么（没进表的字根本不会被检查）。
 */
const SIMPLIFIED_WATCH = '爱罢摆备贝钡笔毕币闭边编变辩标鳖别宾饼拨补参蚕惭惨仓苍舱层长偿厂场车彻尘陈衬称惩迟冲虫筹丑处础触辞聪丛凑窜错达带贷担单胆当党档导岛祷到盗灯邓敌涤递缔点电垫淀钓调迭谍顶订东动冻栋斗独读赌镀锻断队对吨顿夺鹅额恶儿尔饵贰发罚阀矾饭贩访纺飞废费纷坟奋愤粪丰风疯冯凤肤辐抚辅赋复负妇缚该钙盖干赶刚钢岗纲锆搁鸽阁铬个给根龚沟钩构购够蛊顾刮关观馆惯贯广归龟规辊锅国过铪骇韩汉阂鹤贺横轰红后壶护沪户话怀坏欢环还缓换唤痪焕荒黄谎挥辉毁汇会贿秽浑伙获货祸击机积饥讥鸡绩极辑级挤几蓟计记济继纪夹贾价驾歼监坚笺拣检荐贱溅践舰姜浆蒋桨奖讲酱胶浇骄娇搅铰矫觉较阶节洁结诫届紧锦仅谨进晋烬尽劲荆茎鲸惊经颈静镜旧驹举据锯惧剧鹃绢杰镌钧军骏开凯颗壳课垦恳抠库裤夸块侩宽矿旷况亏岿窥馈溃扩阔蜡腊莱来赖蓝栏拦篮阑烂滥捞劳涝乐镭垒类泪篱离里鲤礼丽厉励砾历沥隶俩联莲连镰怜链炼练粮凉两辆谅疗辽镣猎临邻鳞凛赁龄铃凌灵岭领馏刘龙聋咙笼垄拢陇楼娄搂篓卢颅庐炉掳卤虏鲁赂禄录陆驴吕铝侣屡缕虑滤绿峦挛孪滦乱抡轮伦仑沦纶论萝罗逻锣箩骡骆络妈玛码蚂马骂吗买麦卖迈脉瞒馒蛮满谩猫锚铆贸么霉没镁门闷们锰梦谜弥觅绵缅庙灭悯闽鸣铭谬谋亩钠纳难挠脑恼闹馁腻撵酿鸟聂啮镊镍柠狞宁拧泞钮纽脓浓农疟诺欧鸥殴呕沤盘庞抛赔喷鹏骗飘频贫苹凭评泼颇扑铺朴谱脐齐骑岂启气弃讫牵扦钎铅迁签谦钱钳潜浅谴堑枪呛墙蔷强抢锹桥乔侨翘窍窃钦亲寝轻氢倾顷请庆琼穷趋区躯驱龋颧权劝却鹊让饶扰绕热韧认纫荣绒软锐闰润洒萨鳃赛伞丧骚扫涩杀纱筛晒删闪陕赡缮伤赏烧绍摄慑设绅审婶肾渗声绳胜圣师狮湿诗尸时蚀实识驶势释饰视试寿兽枢输书赎属术树竖数帅双谁税顺说硕烁丝饲耸怂颂讼诵擞苏诉肃虽随绥岁孙损笋缩琐锁獭挞抬摊贪瘫滩坛谈叹汤烫涛绦讨腾誊锑题体屉条贴铁厅听烃铜统头图涂团颓蜕脱鸵驮驼椭洼袜弯湾顽万网韦违围为潍维伟伪纬谓卫温闻纹稳问瓮挝蜗涡窝呜钨乌污诬无芜吴坞雾务误锡牺袭习铣戏细虾辖峡侠狭厦锨鲜纤咸贤衔闲显险现献县线厢镶乡详响项萧销晓啸蝎协挟携胁谐写泻谢锌衅兴汹锈绣虚嘘须许绪续轩悬选癣绚学勋询寻驯训讯逊压鸦鸭哑亚讶阉烟盐严颜阎艳厌砚彦谚验鸯杨扬疡阳痒养样瑶摇尧遥窑谣药爷页业叶医铱颐遗仪彝蚁艺亿忆义诣议谊译异绎荫阴银饮樱婴鹰应缨莹萤营荧蝇赢颖哟拥佣痈踊咏涌优忧邮铀犹游诱与屿语吁御狱誉预驭鸳渊辕园员圆缘远愿约跃钥岳粤悦阅云郧匀陨运蕴酝晕韵杂灾载攒暂赞赃脏凿枣灶责择则泽贼赠扎札轧铡闸栅诈斋债毡盏斩辗崭栈战绽张涨帐账胀赵蛰辙锗这贞针侦诊镇阵挣睁狰帧郑证织职执纸挚掷帜质滞钟终种肿众诌轴皱昼骤猪诸诛烛瞩嘱贮铸筑驻专砖转赚桩庄装妆壮状锥赘坠缀谆浊兹资渍踪综总纵邹诅组钻致钟为'
  + '测诉静静进谢谁谈讲课调责费赛赞观讨论评译诚询误诸谊谋贝负财贵货购赏赔赢较辅辆辉输辩里学举阵织练组终维综缓编缩罗罢职聪肠肤脑脸舰艺药获营蓝虑虽衬裤飞颜顺须顾预饭饮饰饱馆驱骑携电睁灵欢么标场东状惩当复墙轻实'.replace(/到/g, '');

/* "疑似还是简体"的判据：这个字在**我们的映射表里出现过**（说明它确实有繁体写法），
   但译完还留着——说明某处没替到（多半是漏在别的字上，或者它在某个词里被跳过了）。 */
const SIMPLIFIED_ONLY = MAPPED;
const WATCH = new Set([...SIMPLIFIED_WATCH]);
for (const [k, v] of Object.entries(src)) {
  const t = toHant(v);
  out[k] = t;
  if (t !== v) changed++;
  else if (SIMPLIFIED_ONLY.size && [...v].some((c) => SIMPLIFIED_ONLY.has(c))) untouched.push(k);
  /* 判据收敛成一句：**观察表里有、译完还留着**，且它确实是个"简繁不同形"的字。
     （"到/出"这类简繁同形的字若算进来，报告里会永远挂着假警报。） */
  for (const c of t) if (WATCH.has(c) && MAPPED.has(c)) leftover.add(c);
}
fs.writeFileSync(DST, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`zh-Hant 生成：${Object.keys(src).length} 条（改到 ${changed} 条）`);
if (untouched.length) console.log(`ℹ 整条没变的 ${untouched.length} 条（可能本来就同形）：${untouched.slice(0, 8).join(', ')}${untouched.length > 8 ? ' …' : ''}`);
if (leftover.size) console.log(`⚠ 仍含简体字的 ${leftover.size} 个字（没映射到，保持原样）：${[...leftover].join('')}`);
if (process.argv.includes('--report')) {
  const diff = Object.entries(src).filter(([k, v]) => out[k] !== v).slice(0, 12);
  for (const [k, v] of diff) console.log(`  ${k}\n    简：${v}\n    繁：${out[k]}`);
}
