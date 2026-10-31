# 安装与质检报告（2026-10-31）

对象：[nefelibata5136-code/surfcore-life](https://github.com/nefelibata5136-code/surfcore-life) `main`（推送时间 2026-10-28，package.json `0.7.0`）
安装位置：`D:\surfcore-life`
执行人：DSH（本机，Windows）

## 一、环境

| 项 | 实际值 |
| --- | --- |
| Node | v24.21.0（`C:\Users\35378\dsh-tui\bin\node.cmd`，满足 engines ≥22.13） |
| 包管理器 | pnpm 11.28.5；本机无 npm，通过 `pnpm dlx npm@10.9.4` 执行 `npm ci` |
| DSH | 0.2.1-rc.2，桌面版（`@deepseek-ai/*` 打包在 `D:\大肥鱼\resources\app.asar`） |
| git | 本机未安装，改用 codeload zip 下载（7,412,815 字节） |

## 二、安装步骤

1. 下载 zip → 解压 → 落到 `D:\surfcore-life`。
2. `npm ci`：128 个包，10s；postinstall 修补 `@snowluma/sdk` 13 个文件。
3. 修掉两处环境/仓库问题（见第三节）。
4. 下载产物保留在 `D:\surfcore\_downloads\surfcore-life-main.zip`，asar 副本在 `D:\dsh-asar`（供工具名对账，见第三节第 2 条）。

## 三、发现的问题与修复

### 1. `start.bat` 被提交成 LF（真实缺陷）

- 现象：`node scripts/test-audit-setup-guards.mjs` 失败，报 `start.bat 必须使用 CRLF`。
- 根因：仓库里的 `start.bat` 是 LF（19 行）；上游 `D:\surfcore` 的同名文件是 CRLF。cmd.exe 对含 `:loop` / `goto` 的 LF 批处理容错很差，可能整段不执行。
- 修法：字节级归一成 CRLF（19 CRLF / 0 LF，无 BOM），内容未改。
- 验证：该测试通过；`test:audit` 83/83。

### 2. DSH 工具名对账在 asar 安装上误报 51 个「假名」

- 现象：`test-preset-local-tools.mjs` 失败，把守卫 restrict 清单里 51 个真实工具名判成「DSH 里找不到」。
- 根因：桌面版把 `@deepseek-ai/*` 整个打进 `app.asar`，仓库 `node_modules/@deepseek-ai` 只有 `dsh-host-apiproxy` + `schemastery` 两个包；旧收集器只读 `node_modules`，扫描面太小。
- 修法：从 `D:\surfcore`（本地 2026-10-30 已修的版本）移植了同一套修复：
  - `scripts/dsh-tool-names.mjs`：新增直接读 `app.asar` 头 + 条目（不落盘）、扫描 profile `node_modules`（含 junction）、导出 `DYNAMIC_TOOL_NAMES` / `INTENTIONAL_ABSENT_TOOLS`；
  - `scripts/local-env.mjs`：读取仓库根 `.env.local` 里未设置的环境变量；
  - `scripts/test-preset-local-tools.mjs`、`scripts/scan-dsh-tool-names.mjs`：同步新口径；
  - 新增 `.env.local`（`DSH_ASAR=D:\大肥鱼\resources\app.asar`），并加进 `.gitignore`。
- 验证：测试通过；`scan-dsh-tool-names` 报「悬空（假名）0 个」，只保留 5 个显式声明的回归网名字（`dsh_snapshot` / `dsh_rollback` / `incident_resolved` / `subagent_codex` / `subagent_claude_code`）。
- 备份：原文件在 `_backups\port-20261031\`。

## 四、验收结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 生活参数核心 | `npm run test:life` | 全过：14 核心场景 / 9 个 MCP schema / QQ 生命周期 11 / B站 runtime / 导出 / 凭据 |
| 离线全量审计 | `npm run test:audit` | **83/83 脚本通过**（修复前 81/83） |
| 回归 | `npm run test:regressions` | 16/16 全过 |
| 安装器幂等 | `npm run test:setup-idempotent` | 通过 |
| 版本一致 | `npm run version:check` | v0.7.0 一致 |
| 演示闭环 | `npm run demo:life` | 8 步全通：MCP→解释→联动预览→保存待验→真实消费者采用→观察→回滚复验 |

演示证据：`state/life-demo/2026-10-31T07-18-46-363Z-b3789e05/`（`transcript.md` / `transcript.json`）。

## 五、DSH 接入演练（隔离，不动线上）

```
$env:DSH_HOME="D:\surfcore-life\.sandbox-dsh"
node scripts/setup-dsh.mjs life-sandbox
```

结果：profile `life-sandbox` 建成，`surfcore` bundle 以 junction 挂入，`cordis.patch.yml` 写入 3 个 MCP 条目（snowluma / snowluma-host / web-search-safe），`dsh plugin --profile life-sandbox install` 返回 OK。该目录链到仓库真实路径，未触碰 `~/.dsh/profiles/desktop`。`.sandbox-dsh/` 已加入 `.gitignore`。

## 六、未覆盖 / 风险

1. **未接线上 profile**：`~/.dsh/profiles/desktop` 仍指向 `D:\surfcore`；切换需重启 DSH，会中断当前会话，故留给用户决定。
2. **无 `config.json`**：仓库只带 `config.example.json`。桥接、QQ、B站要真正跑起来还需要本人配置与 SnowLuma 扫码，本次没有伪造这类数据。
3. **`verify:adaptation` 跑不了**：脚本固定读 `~/.dsh/profiles/web`，本机是 `profiles/desktop`；且需要 DSH `node_modules`。属环境限制，不影响其余验收。
4. **扫描器 ② 段有 17 个未覆盖的「危险语义」名字**（`terminal_*`、`session_*`、`undo_*`、`plugin_market`、`web_*`、`meme_*` 等）：这些工具没有进 QQ preset 的工具面，执行期白名单仍会拒绝；若要收口，需按实际 composition 再对一轮账。
5. 演示里的 `state/` 与会话产物都在本机，未上传。
