// 硬底线：禁区。
// 不变量：**被拒的读只存在于沙箱内部**——一旦"提权到沙箱外跑"，那层"禁止读"会静默失效；
// 灵核没有沙箱，对应物就是这一层判定：
// **禁区挂在任何放行路径的下游统一入口上——审批/规则/提权只能改"问不问"，永远不能改"禁不禁"。**
// 默认禁区 = `~/.lhcd`（人格 + 记忆 + 凭据三件套所在）+ 一串**系统敏感目录**。
//
// 另有三样判据：
//   ① **软链防护**：判定前先解析真实路径（`fs.realpathSync`，不存在则解析最近的已存在祖先）——
//      只做字符串归一的话，`~/Documents/link → ~/.lhcd` 这种软链可以绕过禁区；
//   ② **系统敏感目录**：`~/.ssh` `~/.gnupg` `~/.aws` `~/.kube` `~/Library/Keychains` `~/.password-store`
//      ——她的本事是"帮你打理文件"，不是"读你的私钥"；
//   ③ **按文件名的硬拒绝**：`credentials.json` 与 `.env`（任何位置）——数据目录不在 `~/.lhcd` 里时
//      也拦得住（如 `runtime/data/credentials.json` 与 `runtime/.env`）。
//      （没有做"允许根目录"（工作区白名单）：灵核的产品前提就是"她帮你处理你电脑上的文件"，
//      一刀切限制根目录会砍掉正功能；要收窄范围请用**用户可配的授权目录**，见 outsideWorkspace。）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 缺省禁区：灵核自己的数据目录（人格/记忆/模型密钥都在里面） */
export const DEFAULT_READ_ZONES = ['~/.lhcd'];

/** 系统敏感目录：与产品定位无关、出事代价极高的那些 */
export const SENSITIVE_ZONES = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.kube',
  '~/.password-store',
  '~/.config/gh',
  '~/Library/Keychains',
];

/** 按文件名硬拒绝（任何位置）：凭据与密钥文件（数据目录不在禁区内时也拦得住） */
export const FORBIDDEN_FILENAMES = ['credentials.json', '.env'];

/**
 * 保留区：**位于任何目录内**都永远只读的几个名字——写/删/改名一律拒，读照旧放行。
 *
 * 为什么单独一档、不并进"禁区"：禁区是"连读都不许"（私钥、口令、人格记忆所在），
 * 而这里是**代码与配置**——你可能正需要让她读 `.git/config` 看远端地址；危险只在"写"：
 * 改它们等于绕过权限本身（`.git/hooks/*` 会被 git 直接执行；`core.hooksPath` 能把钩子指到别处；
 * 代理配置目录里的 hooks/权限位同理）。
 *
 * 清单按自己的目录习惯定：`.git` / `.codex` / `.agents` 是各类代理的元数据目录，
 * 另补 `.lhcd`（人格/记忆/凭据目录，出现在别处同样算）与 `.claude`。
 */
export const PROTECTED_INNER_NAMES = ['.git', '.lhcd', '.agents', '.codex', '.claude'];

/**
 * 工具入参里"落点路径"的键——**唯一取法**：禁区、保留区、授权目录三处判定共用同一份。
 * 为什么要收成一处：只看 `path`/`paths` 的话，office 的 `file`/`saveAs` 与
 * media 的 `input`/`inputs` 这几条路就走不进禁区判定（同一件事两套取法 = 迟早漂移）。
 * 不含 `to`（media 里是秒数、office 里是格式名）、不含 app 的 `target`（那是应用名，不是文件落点）。
 */
export const PATH_ARG_KEYS = ['path', 'paths', 'file', 'files', 'input', 'inputs', 'saveAs'] as const;

/** 从工具入参里取出全部"落点路径"（字符串或字符串数组；空串不算） */
export function collectPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of PATH_ARG_KEYS) {
    const v = args[k];
    if (typeof v === 'string') {
      if (v.trim()) out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) if (typeof x === 'string' && x.trim()) out.push(x);
    }
  }
  return out;
}

export interface BaselineOptions {
  /** 家目录（测试注入用）；缺省 os.homedir() */
  home?: string;
  /** 相对路径解析基准（测试注入用）；缺省 process.cwd() */
  cwd?: string;
  /** 关掉真实路径解析（测试里对不存在目录做纯字符串判定时用） */
  noRealpath?: boolean;
}

export interface BaselineHit {
  /** 命中的禁区（原样返回给调用方做话术） */
  zone: string;
  /** 人话说明（引擎原文照用） */
  note: string;
}

/** 路径归一：展开 ~、相对路径按 cwd 解析、折叠 . 与 .. */
export function normalizePath(p: string, opts: BaselineOptions = {}): string {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  let s = p.trim();
  if (s === '~') s = home;
  else if (s.startsWith('~/')) s = home + s.slice(1);
  if (!path.isAbsolute(s)) s = path.resolve(cwd, s);
  const norm = path.normalize(s);
  return norm.length > 1 && norm.endsWith(path.sep) ? norm.slice(0, -1) : norm; // 去尾斜杠（根除外）
}

/**
 * 解析真实路径（软链防护）：路径存在就用 realpath；不存在就找到**最近的已存在祖先**再拼回去。
 * 这样"目标还不存在"（先创建再读）也拦得住，且软链不被当作合法路径。
 */
export function realPathOf(p: string, opts: BaselineOptions = {}): string {
  const norm = normalizePath(p, opts);
  if (opts.noRealpath) return norm;
  try {
    return fs.realpathSync(norm);
  } catch { /* 不存在 → 向上找 */ }
  let cur = norm;
  const rest: string[] = [];
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return norm; // 到根
    rest.unshift(path.basename(cur));
    cur = parent;
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch { /* 继续向上 */ }
  }
}

/**
 * `.git` 是**文件**时（worktree / submodule / `git init --separate-git-dir`）顺着 `gitdir:` 指针解析真实目录。
 *
 * 为什么必须解析：真实 git 目录可能根本**不在工作树里**，按名字（`.git`）是看不出来的——
 * 而它里面就躺着 `hooks/`（会被 git 直接执行的代码），所以判定时也要把真实目录并进保护集。
 * 读不动/没这文件 → 返回 null（解析失败只意味着"这条判据用不上"，不改变别的行为）。
 */
export function gitdirTargetOf(dir: string, opts: BaselineOptions = {}): string | null {
  const marker = path.join(normalizePath(dir, opts), '.git');
  try {
    if (!fs.lstatSync(marker).isFile()) return null; // 普通仓库里 .git 是目录，不走这条
    const txt = fs.readFileSync(marker, 'utf8').slice(0, 4096); // 指针只有一行，读 4KB 足够
    const m = /^gitdir:[ \t]*(.+)$/m.exec(txt);
    if (!m) return null;
    const raw = m[1]!.trim();
    const abs = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(marker), raw);
    return normalizePath(abs, opts);
  } catch {
    return null;
  }
}

/**
 * 这个目录长得像 git 目录吗：有 `HEAD` 文件，且 hooks/objects/refs/commondir 至少有一样。
 * `commondir` 是给 **worktree 的 gitdir** 留的（它自己没有 objects/refs/hooks，那些在共用的主仓库里）。
 * 只做 stat，不读内容；不存在的路径一律 false。
 */
export function looksLikeGitDir(dir: string): boolean {
  const has = (name: string): boolean => {
    try {
      return fs.existsSync(path.join(dir, name));
    } catch {
      return false;
    }
  };
  if (!has('HEAD')) return false;
  return has('hooks') || has('objects') || has('refs') || has('commondir');
}


/**
 * 从命令文本里挑出"看起来是路径"的词（软链/`$HOME` 之外的兜底判据要用的）。
 * 规矩：含 `/` 或 `~` 开头才算路径；动态部分（`$`、反引号、通配）**跳过**——
 * 它们解析不出真实路径，已经被 parse.ts 判成 opaque，走"收紧而非放行"那条路。
 * `--file=/x`、`if=/dev/x` 这类 `键=值` 形式取值那一半。最多取 40 个（够用且不扫全盘）。
 */
export function pathTokens(cmd: string): string[] {
  const out: string[] = [];
  for (const raw of cmd.split(/[\s|;&()<>]+/)) {
    let t = raw.replace(/^["']+|["']+$/g, '');
    const eq = t.indexOf('=');
    if (eq > 0 && !t.startsWith('~') && !t.slice(0, eq).includes('/')) t = t.slice(eq + 1);
    t = t.replace(/^["']+|["']+$/g, '');
    if (!t || /[$`*?]/.test(t)) continue;
    if (!t.includes('/') && !t.startsWith('~')) continue;
    out.push(t);
    if (out.length >= 40) break;
  }
  return out;
}

/** 文本里是否"提到"该路径（要求边界：后面跟 / 或分隔符或结尾，避免 ~/.lhcd-backup 误伤） */function mentionsInText(text: string, zone: string): boolean {
  const esc = zone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${esc}(?=[/\\s'"=:;|&)>\\]]|$)`, 'i').test(text);
}

export class BaselineGuard {
  private readonly zones: string[];
  private readonly opts: BaselineOptions;

  /** 家目录（参数级规则的 `~/` 展开要用；与禁区判定同一个口径） */
  get homeDir(): string { return this.opts.home ?? os.homedir(); }

  constructor(zones: string[] = DEFAULT_READ_ZONES, opts: BaselineOptions = {}) {
    this.opts = opts;
    const userZones = zones.filter((z) => typeof z === 'string' && z.trim().length > 0);
    // **默认禁区永远在**，用户配置只能加：写成 `userZones.length ? userZones : DEFAULT_READ_ZONES`
    // 的话就等于"你给了就听你的"，一份普通的 `agent.json` 写个 `readZones: ['/tmp/nothing']`
    // 就能把 `~/.lhcd`（人格/记忆/凭据所在）整条墙拆掉。
    // 禁区是"墙"不是"门"：只许加高，不许拆。
    this.zones = [...new Set([...DEFAULT_READ_ZONES, ...userZones, ...SENSITIVE_ZONES])];
  }

  /** 命中判定的唯一实现：返回 {zone, note} 或 null（软链解析后仍要再判一次） */
  forbiddenHit(p: string): BaselineHit | null {
    const raw = normalizePath(p, this.opts);
    const real = realPathOf(p, this.opts);

    // ① 按文件名硬拒绝（任何位置）：凭据/密钥文件
    for (const name of FORBIDDEN_FILENAMES) {
      if (path.basename(raw) === name || path.basename(real) === name) {
        return { zone: name, note: `「${name}」里是密钥/凭据：任何审批或放行都不会解除——要用的话让用户自己来，或者走「设置」页。` };
      }
    }

    // ② 禁区（含后代）：归一形式与真实形式都要查（防软链绕行）
    for (const zone of this.zones) {
      const z = normalizePath(zone, this.opts);
      const zReal = realPathOf(zone, this.opts);
      for (const cand of [raw, real]) {
        for (const target of [z, zReal]) {
          if (cand === target || cand.startsWith(target + path.sep)) {
            return {
              zone,
              note: zone === '~/.lhcd'
                ? `「${zone}」是禁区（人格/记忆/凭据所在）：任何审批或放行都不会解除，需要动它请你自己来。`
                : `「${zone}」是系统敏感目录（私钥/口令所在）：我不会读也不会改——要用请你自己来。`,
            };
          }
        }
      }
    }
    return null;
  }

  /** 路径是否落在禁区内（含后代；**尚未存在的路径同样拦**——防"先创建再读"） */
  forbiddenPath(p: string): string | null {
    return this.forbiddenHit(p)?.zone ?? null;
  }

  /**
   * 保留区判定：这些路径**只读**——写/删/改名一律拒，读照旧放行。
   * 调用方只在"会动到东西"的调用上问它（见 engine 的写类判据）。
   *
   * 三条判据（每条都有成对用例，见 baseline.test.ts）：
   *   ① 路径里**任意一段**叫保留区名字（`.git` / `.lhcd` / `.claude` / …）→ 命中。
   *      按**段**判而不是按 basename：`.git/hooks/pre-commit` 的 basename 是 `pre-commit`，
   *      只看末段等于没判。尚未存在的路径同样命中（防"先创建再写进去"）。
   *   ② `.git` 是**文件**时（worktree/submodule/separate-git-dir）：顺着 gitdir 指针把真实目录
   *      也当保留区——真实目录可能在别处、名字里根本没有 `.git`。
   *   ③ 目标是**某个禁区的祖先**：改名/删除祖孙链上的一环 = 把禁区挪出保护范围
   *      （把受保护目录的所有祖先登记为禁止改名/删除）。这条只对**禁区**成立，
   *      保留区不需要：它是按名字判的，改个名并逃不掉。
   */
  reservedHit(paths: string[]): BaselineHit | null {
    for (const p of paths) {
      const raw = normalizePath(p, this.opts);
      const real = realPathOf(p, this.opts);
      for (const cand of raw === real ? [raw] : [raw, real]) {
        const seg = cand.split(path.sep).find((s) => PROTECTED_INNER_NAMES.includes(s));
        if (seg) {
          return {
            zone: seg,
            note: `「${seg}」是保留区（放在哪个目录里都算）：它能反过来决定我有多大权限（` +
              `${seg === '.git' ? '.git/hooks 里的东西会被 git 直接执行、.git/config 能改钩子路径' : '这里是代理/人格的运行配置'}）` +
              `，所以只读——读没问题，写/删/改名谁批准都不行。要动它请你自己来。`,
          };
        }
        const g = this.gitDirHit(cand);
        if (g) return g;
        const anc = this.zoneAncestorHit(cand);
        if (anc) return anc;
      }
    }
    return null;
  }

  /**
   * 判据②：这条路径是不是落在**某个 git 目录**里（哪怕那个目录不叫 `.git`）。
   * 两种认法，缺一不可：
   *   a) **指针**：祖先目录里的 `.git` 是文件（worktree/submodule/`--separate-git-dir`）→ 解析 `gitdir:`
   *      指向的真实目录，目标落在里面就算。这条只有在"能看见那棵工作树"时才有用。
   *   b) **内容特征**：祖先目录本身长得像 git 目录（有 `HEAD`，并且有 hooks/objects/refs/commondir 之一）
   *      → 直接算。这条兜住 a) 看不见的那种：真实 git 目录在别处、名字里根本没有 `.git`
   *      （`git init --separate-git-dir=/tmp/foo`、`git worktree` 的 `<main>/.git/worktrees/<n>`），
   *      光有指针是**认不出来**的——那正是这一条要堵的洞。
   * 只向上看 8 层（够到工作树根），避免每次写都扫全盘。
   */
  private gitDirHit(cand: string): BaselineHit | null {
    const note =
      '这条路径在一个 git 目录里（hooks 会被 git 直接执行、config 能改钩子路径）：只读——' +
      '写/删/改名谁批准都不行。要动它请你自己来。';
    // 从**目标自己**开始向上看：目标可能就是那个 git 目录（删掉它 / 改它的名字）
    let dir = cand;
    for (let i = 0; i < 8; i++) {
      // a) 指针
      const g = gitdirTargetOf(dir, this.opts);
      if (g && (cand === g || cand.startsWith(g + path.sep))) return { zone: '.git', note };
      // b) 内容特征（命中就够：真正的 git 目录一定有 HEAD）
      if (looksLikeGitDir(dir)) return { zone: '.git', note };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  /** 判据③：目标是某个禁区的祖先（改名/删除它 = 把禁区挪出保护范围） */
  private zoneAncestorHit(cand: string): BaselineHit | null {
    for (const zone of this.zones) {
      for (const z of [normalizePath(zone, this.opts), realPathOf(zone, this.opts)]) {
        if (z !== cand && z.startsWith(cand + path.sep)) {
          return {
            zone: cand,
            note: `「${cand}」里面放着受保护的东西（${zone}）：改名或删除它等于把受保护的东西挪出保护范围，所以这一条我不做。` +
              `要动请你自己来。`,
          };
        }
      }
    }
    return null;
  }

  /**
   * 授权目录边界：用户**配了**授权目录之后，会动到文件系统的调用
   * 必须落在其中之一的里面，否则交给用户点头（ask，走已有的审批卡——这里不砌砖墙）。
   * **空名单 = 不设边界**：灵核的产品前提是"她帮你处理你电脑上的文件"，
   * 一刀切限制落点会砍掉正功能（`baseline.ts` 开头那段注释就是这么定的）。
   * 返回第一个落在所有授权目录之外的路径；全在里面返回 null。
   */
  outsideWorkspace(paths: string[], dirs: string[]): string | null {
    const roots = dirs
      .filter((d) => typeof d === 'string' && d.trim())
      .map((d) => normalizePath(d, this.opts));
    if (!roots.length) return null;
    for (const p of paths) {
      const raw = normalizePath(p, this.opts);
      const real = realPathOf(p, this.opts);
      const inside = roots.some((root) => {
        const rReal = realPathOf(root, this.opts);
        return [raw, real].some((c) => [root, rReal].some((r) => c === r || c.startsWith(r + path.sep)));
      });
      if (!inside) return raw;
    }
    return null;
  }

  /**
   * 这个读操作碰的是不是"从外面拿来的东西"。
   * 命中返回**规范化后的路径**（调用方拿它当"同一份文件"的键：换一份新文件会再问一次）。
   * 判据：规范化 + realpath 之后落在某个外部来源目录里（默认 `~/Downloads`）。
   */
  externalSourceHit(paths: string[], dirs: string[] = ['~/Downloads']): string | null {
    const roots = dirs
      .filter((d) => typeof d === 'string' && d.trim())
      .map((d) => normalizePath(d, this.opts));
    if (!roots.length) return null;
    for (const p of paths) {
      const raw = normalizePath(p, this.opts);
      const real = realPathOf(p, this.opts);
      const inside = roots.some((root) => {
        const rReal = realPathOf(root, this.opts);
        return [raw, real].some((c) => [root, rReal].some((r) => c === r || c.startsWith(r + path.sep)));
      });
      if (inside) return raw;
    }
    return null;
  }

  /**
   * 命令文本是否提到禁区（~ 形式与展开形式都查）——bash 侧的尽力而为，防"用命令绕过文件工具"。
   *
   * 两条容易绕过的路（都是"看着不像绕，其实绕了"）：
   *   ① **`$HOME` / `${HOME}` 拼出来的路径**：只做字面文本比对时，`cat $HOME/.lhcd/x` 会落进
   *      "没提到禁区"那一支（只到 ask，而它是硬墙该拒的）；
   *   ② **软链**：文件工具有 realpath 防护，bash 侧没有——`ln -s ~/.lhcd /tmp/l` 之后
   *      `cat /tmp/l/data/state.json` 会被只读规则**直接放行**（等于把人格/记忆/凭据目录
   *      用一行命令敞开）。所以把命令里"看起来是路径"的词逐个解析真实路径再判一次。
   * 动态部分（`$VAR`、`` `…` ``、通配）**不在这里猜**——它们已经被 parse.ts 判成 opaque，
   * 走的是"收紧而非放行"那条路。
   */
  forbiddenInCommand(cmd: string): string | null {
    const home = this.opts.home ?? os.homedir();
    const text = cmd.replace(/\$\{?HOME\}?/g, home); // ① 先展开 $HOME，后面按文本比对
    for (const zone of this.zones) {
      const expanded = normalizePath(zone, this.opts);
      if (mentionsInText(text, zone) || mentionsInText(text, expanded)) return zone;
    }
    // 命令里直接点了凭据文件名（`cat .env` / `cat runtime/data/credentials.json`）
    for (const name of FORBIDDEN_FILENAMES) {
      if (mentionsInText(text, name)) return name;
    }
    // ② 软链防护：把路径样的词解析真实路径再判一次（命中也返回区名，话术与禁区一致）
    for (const tok of pathTokens(text)) {
      const hit = this.forbiddenHit(tok);
      if (hit) return hit.zone;
    }
    return null;
  }

  /** 工具调用入口（带说明版）：命中即拒；文件类工具看**全部落点参数**，bash 看命令行 */
  hitDetail(permissionClass: string, args: Record<string, unknown>): BaselineHit | null {
    // 落点取法收成一处（collectPaths）：只看 path/paths 的话，office 的 file/saveAs 与
    // media 的 input/inputs 会漏出禁区判定。
    for (const p of collectPaths(args)) {
      const hit = this.forbiddenHit(p);
      if (hit) return hit;
    }
    if (permissionClass === 'bash' && typeof args.command === 'string') {
      const zone = this.forbiddenInCommand(args.command);
      if (zone) {
        return {
          zone,
          note: `命令里碰到了「${zone}」（禁区）：任何审批或放行都不会解除——要用请让用户自己来。`,
        };
      }
    }
    return null;
  }

  /** 工具调用入口：命中即拒（返回命中的禁区，未命中返回 null）——兼容旧调用方 */
  hit(permissionClass: string, args: Record<string, unknown>): string | null {
    return this.hitDetail(permissionClass, args)?.zone ?? null;
  }
}
