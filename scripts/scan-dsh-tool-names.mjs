// DSH 工具名清单扫描器：从**已安装的 DSH 包/插件**里抽取真实注册的工具名，
// 与 QQ 守卫的 restrict 名单对账。
//
// 为什么要有这个脚本（而不是把清单抄死在注释里）
// ----------------------------------------------
// `tools.restrict({ deny: [name] })` 对**不存在的工具名会抛错**，而守卫是逐个
// try/catch 的 ⇒ 拼错/过期的名字 = 静默 no-op，安全边界无声地少一层。
// 反过来，DSH 每个版本都会新增工具，守卫漏掉新名字 = 该隐藏的能力留在
// 仿真会话的 schema 里。两类漂移都只能靠「拿安装包重新对账」发现。
//
// 抽取逻辑在 scripts/dsh-tool-names.mjs（唯一实现，测试与扫描器共用）；
// 本文件只是 CLI：打印、分类、给退出码。
//
// 本脚本是**只读**的：不改任何文件。
//
// 用法：
//   node scripts/scan-dsh-tool-names.mjs            # 对账并打印全部候选
//   node scripts/scan-dsh-tool-names.mjs --missing  # 只打印值得补进守卫的名字
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectDshToolNames, dshPackagesDir, DANGER_TOOL_RE, SAFE_MODEL_TOOLS, TOOL_NAME_RE,
  DYNAMIC_TOOL_NAMES, INTENTIONAL_ABSENT_TOOLS,
} from './dsh-tool-names.mjs';
import { loadLocalEnv } from './local-env.mjs';

// 仓库根 .env.local（git 忽略）：桌面版 DSH 打的是 app.asar，反查不到安装目录时靠
// 这里的 DSH_ASAR 才能抽到 DSH 本体的工具名。
loadLocalEnv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { names, packages } = collectDshToolNames();
const guardPath = path.join(ROOT, 'plugins', 'surfcore', 'qq-tool-restrict.mjs');
const guard = await import(pathToFileURL(guardPath).href);
const guarded = new Set(guard.RESTRICTED_TOOL_NAMES);

const sorted = [...names.keys()].sort();
const onlyFlag = process.argv.includes('--missing');

let pkgDirLabel = '(未解析：已改用 asar 或插件目录)';
try { pkgDirLabel = dshPackagesDir(); } catch { /* 打包安装反查不到，不阻塞扫描 */ }
console.log(`DSH 包目录：${pkgDirLabel}`);
console.log(`扫描包数：${packages.length}；抽到工具名候选：${sorted.length}\n`);

/** ① 守卫名单里的名字必须真实存在，否则 restrict 抛错被吞、限制静默失效。 */
const knownExempt = new Set([...DYNAMIC_TOOL_NAMES, ...INTENTIONAL_ABSENT_TOOLS]);
const exemptHits = [...guarded].filter((n) => knownExempt.has(n));
const fabricated = [...guarded]
  .filter((n) => TOOL_NAME_RE.test(n) && !n.startsWith('dev_') && !knownExempt.has(n) && !names.has(n));
console.log('=== ① 守卫名单里、但安装包中找不到的名字（restrict 会抛错并静默失效） ===');
console.log(fabricated.length ? fabricated.map((n) => `  ${n}`).join('\n') : '  (无)');
if (exemptHits.length) {
  console.log(`  ℹ 另有 ${exemptHits.length} 个共用白名单里的名字已忽略（动态注册 / 故意保留的回归网）：${exemptHits.join(', ')}`);
}

/** ② 安装包里有、守卫没覆盖的危险语义名字（可能是新版本新增的能力）。 */
const missing = sorted.filter((n) => DANGER_TOOL_RE.test(n) && !guarded.has(n) && !SAFE_MODEL_TOOLS.has(n));
console.log('\n=== ② 安装包里有、守卫名单里没有的「危险语义」名字（可能漏隐藏） ===');
console.log(missing.length ? missing.map((n) => `  ${n}  ← ${[...names.get(n)].join(', ')}`).join('\n') : '  (无)');

if (!onlyFlag) {
  console.log('\n=== ③ 全部候选名字（含来源包） ===');
  for (const n of sorted) {
    console.log(`  ${guarded.has(n) ? '[在名单]' : '[      ]'} ${n}  ← ${[...names.get(n)].join(', ')}`);
  }
}

console.log(`\n守卫名单 ${guarded.size} 个名字；其中悬空（假名）${fabricated.length} 个；候选里未覆盖的危险名 ${missing.length} 个。`);
process.exitCode = (fabricated.length === 0 && missing.length === 0) ? 0 : 1;
