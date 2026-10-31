// DSH 工具名抽取：**唯一实现**，供
//   · `scripts/scan-dsh-tool-names.mjs`（人工/升级时对账，打印清单）
//   · `scripts/test-preset-local-tools.mjs`（登记期断言，防拼错假名）
// 共同使用。
//
// 为什么要抽成模块：这两处过去各有一份实现，而测试那份是**模糊**的
// （`\bname:\s*['"]x['"]` 全文件乱扫 + 只认少数包名前缀 + 只读包根目录的
// cordis.patch.yml）。结果 0.2.0 对账时把 10 个**真实存在**的工具名误判成
// 「假名」——`dsh-mcp-resources` 与 `dsh-experimental-tool-agent-team` 不匹配它
// 的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而不是
// 包根。误判方向是危险的：它会逼人把真名字从守卫名单里删掉。
//
// 抽取规则（都要求**就近锚定**，不把 `systemPrompt.section({ name: 'tool:read' })`
// 这类非工具名当工具）：
//   ① `.register(defineTool({ … name: "X" … }))` —— DSH 所有工具包的注册形状
//   ② `toolName: "X"` / `toolName: z.string().default("X")` —— 配置化工具名
//      （dsh-tool-subagent 的 subagent / subagent_fork 就是这样声明的）
//   ③ YAML patch 里的 `toolName: X` 行（任意层级 *.patch.yml，含 presets/ 子目录）
import fs from 'node:fs';
import path from 'node:path';
import { dshModulesDir } from './dsh-modules.mjs';

/** 名字形态：小写字母开头，允许下划线与连字符，长度合理。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/;

/** DSH 自带包所在目录（`<node_modules>/@deepseek-ai`）。 */
export function dshPackagesDir() {
  return process.env.DSH_TOOL_PACKAGES || path.join(dshModulesDir(), '@deepseek-ai');
}

/** 用户安装的第三方插件目录（也会注册工具：plugin-guard / 超级注入器等）。 */
export function dshPluginDirs() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  const dirs = [];
  if (home) {
    dirs.push(path.join(home, 'plugins'));
    // 2026-10-30：npm 装的插件（dsh-undo-savepoint / @liustack/modlens / dsh-meme …）
    // 落在 profile 的 node_modules 里，不在 ~/.dsh/plugins ⇒ 它们注册的工具
    // （undo_* / modlens_read_image / learn_meme / meme_update）过去全查不到，
    // 会被误判成「假名」。这里补上 profile 的 node_modules（跳过 .pnpm 这类点目录）。
    let profiles = [];
    try {
      profiles = fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => path.join(home, 'profiles', e.name, 'node_modules'));
    } catch { /* 没有 profiles 目录就跳过 */ }
    dirs.push(...profiles);
  }
  return dirs.filter((p) => p && fs.existsSync(p));
}

/** 目录或指向目录的链接都算「真目录」。 */
function isRealDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 插件目录里只挑**真插件**：名字 `dsh-*`，或 package.json 里带 `dsh` 字段。
 * 不加这条会把 profile 里的依赖（playwright-core / undici …）也当插件扫，
 * 它们内部的字符串会冒出一堆假候选（实测：`browser_file_upload`、`apply_patch`）。
 */
function looksLikeDshPlugin(pkgDir, name) {
  if (/^dsh-/.test(name)) return true;
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).dsh);
  } catch {
    return false;
  }
}

function walkFiles(dir, out = [], depth = 0, maxDepth = 5) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walkFiles(full, out, depth + 1, maxDepth); }
    else out.push(full);
  }
  return out;
}

/** 从一个 JS/TS 源文件里抽取工具名。 */
function extractFromSource(text, source, add) {
  for (const m of text.matchAll(/\.register\(\s*defineTool\(\{[\s\S]{0,400}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
  for (const m of text.matchAll(/\btoolName:\s*["']([^"']+)["']/g)) add(m[1], source);
  for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*["']([^"']+)["']/g)) add(m[1], source);
  // 独立的一次性工具文件（defineTool 不挂在 .register( 上时的兜底）
  for (const m of text.matchAll(/defineTool\(\{[\s\S]{0,200}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
}

/** 从 YAML patch 里抽取配置化的工具名。 */
function extractFromPatch(text, source, add) {
  for (const m of text.matchAll(/^\s*(?:-\s*)?toolName:\s*([^\s#]+)\s*$/gm)) {
    add(m[1].replace(/^['"]|['"]$/g, ''), source);
  }
}

/**
 * 从打包安装的 `app.asar` 里抽工具名（不落盘）。
 *
 * 为什么需要：桌面版 DSH 把 `dsh/node_modules/@deepseek-ai/*` 整个打进 `app.asar`，
 * electron 运行时之外既没有可 `require` 的 node_modules，也没有 unpacked 目录
 * ⇒ 2026-10-30 之前测试只能「跳过」，守卫名单等于没对账。
 * 传入 `asarPath`（或设 `DSH_ASAR`）即可直接从归档里读源码文本。
 */
function collectFromAsar(asarPath, add, packages) {
  let buf;
  try { buf = fs.readFileSync(asarPath); } catch { return false; }
  let json; let data;
  try {
    const head = buf.readUInt32LE(12);
    data = 16 + head;
    json = JSON.parse(buf.subarray(16, data).toString('utf8'));
  } catch { return false; }

  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${k}`;
      if (v.files) { walk(v, p); continue; }
      const m = /(?:^|\/)node_modules\/@deepseek-ai\/(dsh-[^/]+)\//.exec(p);
      if (!m) continue;
      const rel = p.slice(p.indexOf(m[0]) + m[0].length);
      if (!/\.(js|mjs|cjs|d\.ts)$/.test(rel) && !/\.patch\.ya?ml$/.test(rel)) continue;
      const start = data + Number(v.offset);
      let text = '';
      try { text = buf.subarray(start, start + Number(v.size)).toString('utf8'); } catch { continue; }
      if (!packages.includes(m[1])) packages.push(m[1]);
      if (/\.patch\.ya?ml$/.test(rel)) extractFromPatch(text, m[1], add);
      else extractFromSource(text, m[1], add);
    }
  };
  walk(json, '');
  return true;
}

/**
 * 抽取已安装 DSH（及其插件）里出现的全部工具名。
 *
 * @param options.packagesDir - `@deepseek-ai` 目录；缺省按 {@link dshPackagesDir} 解析。
 * @param options.asarPath - 打包安装的 `app.asar`；缺省读 `DSH_ASAR` 环境变量（没有就跳过）。
 * @param options.pluginDirs - 第三方插件目录列表；缺省按 {@link dshPluginDirs} 解析。
 * @returns `{ names: Map<name, Set<source>>, packages: string[] }`。
 *          `packages` 是实际扫过的包/插件名，便于诊断「一个都没扫到」。
 */
export function collectDshToolNames({ packagesDir, asarPath, pluginDirs } = {}) {
  const names = new Map();
  const packages = [];
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };

  const roots = [];
  let pkgRoot = packagesDir;
  if (!pkgRoot) {
    // 打包安装时 dshModulesDir() 会抛错；只要给了 asarPath 就不该因此整体失败。
    try { pkgRoot = dshPackagesDir(); } catch { pkgRoot = null; }
  }
  const scannedDshPackages = Boolean(pkgRoot && fs.existsSync(pkgRoot));
  if (scannedDshPackages) roots.push({ dir: pkgRoot, filter: /^dsh-/ });
  const asar = asarPath || process.env.DSH_ASAR;
  const scannedAsar = asar ? collectFromAsar(asar, add, packages) : false;
  for (const dir of pluginDirs ?? dshPluginDirs()) {
    // 用户的插件目录里全是插件包（含 .bak-* 备份，也一起扫：备份里的旧名字
    // 仍然说明这个名字曾经真实存在）。
    roots.push({ dir, filter: null });
  }

  for (const { dir, filter } of roots) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // 符号链接/junction 也算目录：profile 里 npm 装的插件全是链接，只认 isDirectory()
      // 会把它们整批漏掉（modlens_read_image 就是这么被误判成「假名」的）。
      if (e.name.startsWith('.')) continue; // .pnpm / .bin 之类
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.isSymbolicLink() && !isRealDir(path.join(dir, e.name))) continue;
      // 作用域目录（@liustack / @deepseek-ai …）展开一层，否则 npm 装的
      // `@liustack/modlens` 这种包整片漏掉（modlens_read_image 就在里面）。
      const pkgs = e.name.startsWith('@')
        ? (() => {
          try {
            return fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })
              .filter((c) => !c.name.startsWith('.') && isRealDir(path.join(dir, e.name, c.name)))
              .map((c) => ({ name: `${e.name}/${c.name}`, at: path.join(dir, e.name, c.name) }));
          } catch { return []; }
        })()
        : [{ name: e.name, at: path.join(dir, e.name) }];
      for (const pkg of pkgs) {
        if (filter && !filter.test(pkg.name)) continue;
        if (!filter && !looksLikeDshPlugin(pkg.at, pkg.name)) continue;
        packages.push(pkg.name);
        for (const f of walkFiles(pkg.at)) {
          let text = '';
          try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
          if (/\.(js|mjs|cjs)$/.test(f) || f.endsWith('.d.ts')) extractFromSource(text, pkg.name, add);
          else if (/\.patch\.ya?ml$/.test(f)) extractFromPatch(text, pkg.name, add);
        }
      }
    }
  }
  return { names, packages, sources: { packagesDir: scannedDshPackages ? pkgRoot : null, asar: scannedAsar ? asar : null } };
}

/** 便利包装：只要名字集合。 */
export function dshToolNameSet(options) {
  return new Set(collectDshToolNames(options).names.keys());
}

/**
 * 「危险语义」判定：与本地执行 / 文件 / 进程 / 派生 agent / 宿主运行期相关的名字。
 * 守卫**必须**覆盖它们。纯模型侧无害工具由 {@link SAFE_MODEL_TOOLS} 显式排除。
 *
 * 这是**发现用**的启发式（宁可多报，人工再判），不是安全边界本身；
 * 边界是守卫的 restrict 名单 + 执行期白名单。
 */
export const DANGER_TOOL_RE = /(pwsh|bash|shell|exec|spawn|process|terminal|pty|read|write|edit|file|fs_|glob|grep|patch|str_replace|subagent|agent_|teammate|workflow|ralph|job|skill|present|goal|plan|todo|memory|snapshot|rollback|incident|plugin|cordis|dsh_|dev_|import|install|reload|inject|stage|config|workspace|session|export|office|slash|command|schedule|voice|speech|team|mcp_resource)/;

/** 明确无害、允许出现在仿真会话 schema 里的模型侧工具。 */
export const SAFE_MODEL_TOOLS = new Set(['ask_user_question', 'todo_write']);

/**
 * 抽取器**原理上看不见**、但确实注册了的名字：注册时用的是变量而不是字面量。
 * `@liustack/modlens` 是 `ctx.tools.register(readImageTool(preferred))`，
 * 名字来自 `config.toolName || 'modlens_read_image'`。放行是安全的（它真的在），
 * 删掉才是错。
 */
export const DYNAMIC_TOOL_NAMES = new Set(['modlens_read_image']);

/**
 * 守卫名单里**故意保留、但当前安装里没有**的名字（回归网）。
 *   · `dsh_snapshot` / `dsh_rollback` / `incident_resolved` ← `dsh-plugin-guard`
 *     （web profile bundle，本机没装；它会改写配置并 spawn pnpm）
 *   · `subagent_codex` / `subagent_claude_code` ← 只在 DSH 自带 preset 里挂，
 *     0.2.1 的 `dsh-web-app` 里已经找不到这两个名字
 * 留着是为了别的 composition 把它们推进全局层时能挡住；守卫逐个 try/catch，
 * 名字不存在只会多一行日志，不会让整批限制失效。
 */
export const INTENTIONAL_ABSENT_TOOLS = new Set([
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  'subagent_codex', 'subagent_claude_code',
]);
