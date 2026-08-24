# DSH Desktop — DeepSeek Harness 桌面端

常驻托盘的 DeepSeek Harness 桌面壳：**不用敲命令，点图标就开**，全局快捷键随时唤起。

## 功能

- 🚀 **一键启动**：App 启动时自动拉起 `dsh web`（检测 3080 端口已运行则直接复用）
- 🖥️ **常驻托盘**：关闭窗口 = 隐藏到托盘，服务不退出；下次唤起秒开
- ⌨️ **全局快捷键**：`Cmd/Ctrl + Shift + Space` 随时显示/隐藏
- 📁 **最近项目**：托盘菜单管理（添加/移除/设为当前项目），持久化在 `~/.dsh-desktop/recent-projects.json`
- 🔄 **服务管理**：托盘菜单可重启服务、打开日志目录

## 使用

```bash
# 开发模式
npm start

# 打包 macOS dmg
npm run pack        # 产物在 dist/DSH Desktop-0.1.0-arm64.dmg

# 打包 Windows nsis（在 Windows 上执行）
npx electron-builder --win nsis
```

安装后直接启动 `/Applications/DSH Desktop.app`。首次使用如果系统提示"无法验证开发者"，右键图标 → 打开 即可（开发证书签名，未做公证）。

## 数据

| 路径 | 内容 |
|---|---|
| `~/.dsh-desktop/dsh-web.log` | dsh web 服务日志 |
| `~/.dsh-desktop/recent-projects.json` | 最近项目列表 |
| `~/.dsh-desktop/current-project.json` | 当前项目（Phase 2 会话切换用） |

## 已知边界（MVP）

- 最近项目目前是**壳层记录**（添加/展示/标记当前），真正切换 DSH 会话工作目录留待 Phase 2（接 DSH 会话 API）
- 服务退出：托盘"退出"会一并关闭由本 App 拉起的 dsh web；若服务是外部启动的则不动它
- 开机自启：Phase 2 规划

## 目录结构

```
dsh-desktop/
├── src/main.js          # 主进程（服务管理/窗口/托盘/快捷键/最近项目）
├── scripts/gen-icon.js  # 图标生成（纯 Node）
├── build/               # 生成的图标
└── dist/                # 打包产物
```

---

## v0.2.0 更新（Phase 2）

- **项目 = DSH 工作区**：托盘"项目"菜单实时同步 `workspace.list`，显示每个项目的会话数
- **添加项目**：原生目录选择器 → `workspace.create` 注册到 DSH（非本地 JSON）
- **打开项目**：`session.create {workspaceId}` 创建该工作区会话 → WebView 刷新进入
- **删除/重命名**：托盘菜单直接操作 DSH 工作区
- **开机自启**：托盘开关（`app.setLoginItemSettings`）
- **DSH RPC 客户端**：`src/dsh-api.js`（协议见文件头注释，已用临时工作区做完整往返测试）

---

## v0.3.0 更新（Phase 3）

- **托盘任务状态**：轮询 `session.list`，托盘 tooltip 显示运行中会话数（如"● 2 个会话运行中"）；菜单顶部列出运行中的会话标题
- **Windows 打包验证通过**：`npx electron-builder --win nsis` 产出安装包（NSIS 交叉构建成功）
- 会话状态数据源：`session.list`（含 running / cwd / title / stats）

## 打包产物

| 平台 | 命令 | 产物 |
|---|---|---|
| macOS | `npx electron-builder --mac dmg` | `dist/DSH Desktop-<ver>-arm64.dmg` |
| Windows | `npx electron-builder --win nsis` | `dist/DSH Desktop Setup <ver>.exe` |
| Windows 便携 | `npx electron-builder --win zip` | `dist/DSH Desktop-<ver>-win.zip` |

---

## v0.3.1 更新（修复）

- **修复 code=127 启动失败**：桌面 App 的 PATH 精简导致找不到 `dsh` 命令。
  现在按优先级解析：`DSH_CMD` 环境变量 > 用户 shell 的 `which/where dsh` > npx 缓存扫描 > 裸 `dsh`；
  并注入用户登录 shell 的完整 PATH（含 nvm / npx 缓存）再 spawn。

---

## v0.3.3 更新（体验修复）

- **修复 macOS 退出卡 Dock**：`Cmd+Q` / Dock 退出 / 系统关机现在走 `before-quit` 放行，
  不再被窗口关闭拦截（之前只能强制退出）
- **端口占用保护**：3080 被其他程序占用时不再误连，提示用户关闭占用程序
- **开箱即用增强**：
  - dsh 解析 4 级回退（环境变量 > shell which > npx 缓存 > npm 全局 > npx 自动下载）
  - 服务启动失败弹窗带安装指引（npm install -g @deepseek-ai/dsh）
  - 服务意外退出弹窗提供"重启服务"按钮
  - 启动等待期间托盘提示"正在启动 DSH 服务…"

---

## v0.4.0 更新（体验优化）

- **首次启动引导**：欢迎页说明快捷键/托盘/项目管理/任务状态，开箱即用
- **快捷键可配置**：托盘 → 快捷键，4 组预设任意切换（持久化到 settings.json）
- **任务完成系统通知**：会话 running→idle 自动发通知（含任务标题）
- **崩溃自愈**：主进程异常自动重启、渲染进程崩溃自动重建窗口
- 设置持久化模块 `src/settings.js`

---

## v0.5.0 更新（内嵌 dsh，彻底开箱即用）

- **内嵌 dsh 运行时**：App 自带完整 @deepseek-ai/dsh 依赖树（195 包，精确锁定 rc.7 版本），
  用 Electron 的 Node 模式（ELECTRON_RUN_AS_NODE）直接运行 —— **用户无需安装 node/npm/dsh，
  无需网络下载，首次安装即开箱即用**
- 解决 Windows 首次安装"npx 下载超时"问题（不再依赖 npx 兜底）
- 依赖版本全部锁定精确版本（复刻自验证可用的 npx 缓存树，517 包）
- 构建配置：`asar: false`（避免 ESM 模块在 asar 内解析失败）+ `npmRebuild: false`（N-API 模块免 rebuild）

---

## v0.5.1 更新（HMR 修复）

- **修复内置 dsh 启动失败**：Electron 的 Node 模式（ELECTRON_RUN_AS_NODE）默认拿不到
  Node 内部模块，HMR 插件报 `--expose-internals is required` → spawn 时显式传
  `--expose-internals` flag
- 注：外部手动 `node dsh web` 无此问题（系统 Node 默认可用 internal），Node v24 实测正常

---

## v0.5.2 更新（koffi 原生模块修复）

- **修复 Windows 内置 dsh 启动失败**：`Cannot find the native Koffi module`
  koffi 的 prebuilt 按平台分发（`@koromix/koffi-<平台>-<架构>`），npm 只装了当前平台包。
  交叉打包 Windows 时缺 `@koromix/koffi-win32-x64` → 显式装入 dependencies（锁 3.1.5），
  Windows 包现在自带 `win32_x64/koffi.node`

---

## v0.5.3 更新（目录选择器修复）

- **修复 Windows 目录选择失败**：`win32 folder dialog worker exited before
  reporting a result` —— 原生目录对话框 worker 在 Electron 内置模式下
  （ELECTRON_RUN_AS_NODE）不可靠。改为固定使用 **browse 模式**
  （`--patch src/browse-picker.patch.yml`，WebView 内文件浏览），跨平台稳定

---

## v0.5.5 更新（目录选择器双面修复 + 一致性保障）

- **修复 Windows 点选工作区无响应**：browse patch 补上 client UI surface
  （directory-picker 是 host 端 + client 端双面组件，之前只挂了 host 端）
- **CI 增加包完整性检查**：真 Windows 上自动验证内置 dsh / koffi 原生模块 /
  browse patch 双面 / main.js 关键逻辑，保证 Windows 与 macOS 行为一致

---

## v0.5.7 更新（ripgrep 修复）

- **修复 Windows glob/grep 全报 "ripgrep launch failed"**：补装平台包
  `@vscode/ripgrep-win32-x64`（含 rg.exe）
- **修复 dsh-tool-fs-search 的 resolveRgPath 缓存 bug**（patch-package 打补丁）：
  import 失败后永久缓存 rejected promise，导致服务生命周期内搜索永久失败；
  现在失败清缓存允许重试 + 错误信息带平台包名
- CI 完整性检查新增：rg.exe 存在 + fs-search patch 已应用
