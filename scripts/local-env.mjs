// 本机私有环境变量：读仓库根的 `.env.local`（已在 .gitignore 里），只补**没设置**的 key。
//
// 用途：`test-preset-local-tools` 需要知道 DSH 安装在哪才能对账工具名。桌面版把整个
// `@deepseek-ai/*` 打进 `app.asar`，光靠 `$DSH_HOME/profiles` 反查不到，所以要么每次
// 手动 `set DSH_ASAR=...`，要么把路径写进这个本地文件（不进公开仓库）。
//
// 优先级：真实环境变量 > .env.local > 什么都没有（调用方自行降级/跳过）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} [file] 缺省 `<仓库根>/.env.local`
 * @returns {string[]} 实际补上的 key（便于日志）
 */
export function loadLocalEnv(file = path.join(ROOT, '.env.local')) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const applied = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[m[1]]) continue; // 真环境变量优先
    process.env[m[1]] = value;
    applied.push(m[1]);
  }
  return applied;
}
