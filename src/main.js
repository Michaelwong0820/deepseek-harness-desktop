/**
 * DSH Desktop — DeepSeek Harness 桌面端壳
 *
 * Phase 2：
 *  - 项目 = DSH 工作区（workspace.list 为权威来源，托盘实时同步）
 *  - 添加项目 → 原生目录选择 → workspace.create 注册到 DSH
 *  - 切换项目 → session.create {workspaceId} → WebView 刷新进入新工作区
 *  - 开机自启开关
 */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  dialog,
  nativeImage,
  shell,
  Notification,
} = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const dsh = require('./dsh-api')
const settings = require('./settings')

const WEB_URL = dsh.BASE
const DATA_DIR = settings.DATA_DIR
const RECENT_FILE = path.join(DATA_DIR, 'recent-projects.json')
const LOG_FILE = path.join(DATA_DIR, 'dsh-web.log')
const ONBOARDING_HTML = path.join(__dirname, 'onboarding.html')
const SHORTCUT_PRESETS = [
  { label: 'Cmd / Ctrl + Shift + Space', value: 'CommandOrControl+Shift+Space' },
  { label: 'Cmd / Ctrl + Alt + Space', value: 'CommandOrControl+Alt+Space' },
  { label: 'Alt + Space', value: 'Alt+Space' },
  { label: 'Cmd / Ctrl + Shift + D', value: 'CommandOrControl+Shift+D' },
]

const BUILD_DIR = path.join(__dirname, '..', 'build')
const TRAY_ICON = process.platform === 'darwin'
  ? path.join(BUILD_DIR, 'trayTemplate.png')
  : path.join(BUILD_DIR, 'tray.png')
const APP_ICON = path.join(BUILD_DIR, 'icon.png')

let mainWindow = null
let onboardingWindow = null
let tray = null
let dshProcess = null
let weSpawnedDsh = false
let isQuitting = false
let workspaces = [] // DSH 工作区缓存
let sessions = []   // DSH 会话缓存（状态提示用）
let statusTimer = null
let notifiedRunningIds = new Set() // 已通知过的运行中会话（任务完成通知用）

function getShortcut() {
  return settings.load().shortcut
}

/** 注册/重注册全局快捷键（支持运行时切换） */
function registerShortcut() {
  globalShortcut.unregisterAll()
  const accel = getShortcut()
  const ok = globalShortcut.register(accel, () => toggleWindow())
  if (!ok) {
    dialog.showErrorBox('快捷键注册失败', `「${accel}」已被其他应用占用，请在托盘菜单中换一个。`)
  }
  return ok
}

// ---------------------------------------------------------------------------
// 端口 / 服务管理
// ---------------------------------------------------------------------------
function checkPort(port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
    sock.setTimeout(timeout, () => { sock.destroy(); resolve(false) })
  })
}

async function waitForPort(port, tries = 240, interval = 500) {
  for (let i = 0; i < tries; i++) {
    if (await checkPort(port)) return true
    await new Promise(r => setTimeout(r, interval))
  }
  return false
}

// ---------------------------------------------------------------------------
// 解析 dsh 命令与环境（桌面 App 的 PATH 很精简，需要从用户 shell 补齐）
// ---------------------------------------------------------------------------
let cachedShellPath = null
let cachedDshInvocation = null

/** 解析过程写日志，方便跨平台排查 */
function resolverLog(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[resolve] ${msg}\n`)
  }
  catch { /* 日志写失败不影响主流程 */ }
}

/** 从用户登录 shell 拿完整 PATH（含 nvm / npx 缓存等） */
function resolveShellPath() {
  if (cachedShellPath) return cachedShellPath
  const { execFileSync } = require('node:child_process')
  const isWin = process.platform === 'win32'
  try {
    const shell = isWin ? 'cmd.exe' : '/bin/zsh'
    const args = isWin ? ['/c', 'echo %PATH%'] : ['-lc', 'echo $PATH']
    cachedShellPath = execFileSync(shell, args, { encoding: 'utf8' }).trim()
    if (cachedShellPath) return cachedShellPath
  }
  catch { /* 回退到进程自带 PATH */ }
  cachedShellPath = process.env.PATH || ''
  return cachedShellPath
}

/**
 * 解析 dsh 的调用方式（cmd + 前置 args）。
/**
 * 内置 dsh：App 自带 @deepseek-ai/dsh（打进 asar），用 Electron 二进制的
 * Node 模式运行 —— 用户机器无需安装 node/npm/dsh，也无需网络下载。
 * @returns {string|null} 内置 bin.js 路径
 */
function builtinDshBin() {
  try {
    // 开发时: 项目 node_modules；打包后: app.asar/node_modules（__dirname 在 app.asar/src 内）
    const bin = path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    return fs.existsSync(bin) ? bin : null
  }
  catch {
    return null
  }
}

/**
 * 探测系统 Node（>=18 才可用）：
 * native 目录选择器（koffi）与 Electron 内置 Node 的 ABI 不兼容会崩溃，
 * 用系统 Node 运行服务即可让 native 选择器正常工作（原生对话框体验）。
 * 返回系统 node 绝对路径；不存在或版本过老返回 null。
 */
function resolveSystemNode() {
  const { execFileSync } = require('node:child_process')
  const isWin = process.platform === 'win32'
  try {
    const shell = isWin ? 'cmd.exe' : '/bin/zsh'
    const args = isWin ? ['/c', 'where node'] : ['-lc', 'which node']
    const out = execFileSync(shell, args, { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    if (!out) return null
    const ver = execFileSync(out, ['--version'], { encoding: 'utf8' }).trim()
    const major = Number.parseInt(ver.replace('v', '').split('.')[0], 10)
    if (major >= 18) return out
    resolverLog(`系统 node 版本过老(${ver})，回退内置`)
    return null
  }
  catch {
    return null
  }
}

/**
 * 解析 dsh 的调用方式（cmd + 前置 args）。
 * 优先级：
 *   内置 dsh + 系统 node（native 选择器可用，原生对话框体验）
 *   > 内置 dsh + Electron node（browse 选择器兜底）
 *   > DSH_CMD 环境变量
 *   > 用户 shell 的 which/where dsh
 *   > npx 缓存扫描（默认 ~/.npm/_npx + npm config get cache 的 _npx）
 *   > npm 全局安装（%APPDATA%\npm 或 npm root -g）
 *   > npx --yes @deepseek-ai/dsh 兜底（跨平台最稳，首次可能需下载）
 */
function resolveDshInvocation() {
  if (cachedDshInvocation) return cachedDshInvocation
  const { execFileSync } = require('node:child_process')
  const isWin = process.platform === 'win32'

  // 0. 内置 dsh（最优先）
  const builtinBin = builtinDshBin()
  if (builtinBin) {
    const systemNode = resolveSystemNode()
    if (systemNode) {
      // 系统 Node：koffi 兼容 → native 目录选择器可用（无需 browse patch）
      resolverLog(`内置 dsh + 系统 node 命中: ${systemNode}`)
      cachedDshInvocation = {
        cmd: systemNode,
        args: [builtinBin, '--profile', 'web'],
        source: 'builtin-node',
        useSystemNode: true,
      }
      return cachedDshInvocation
    }
    // Electron Node：koffi ABI 不兼容 → browse 选择器兜底
    resolverLog(`内置 dsh + Electron node（无系统 node）`)
    cachedDshInvocation = {
      cmd: process.execPath,
      args: [builtinBin],
      source: 'builtin',
      useNodeMode: true,
    }
    return cachedDshInvocation
  }
  resolverLog('内置 dsh 不存在，走外部解析')

  // 1. 显式指定
  if (process.env.DSH_CMD) {
    resolverLog(`使用 DSH_CMD=${process.env.DSH_CMD}`)
    cachedDshInvocation = { cmd: process.env.DSH_CMD, args: [], source: 'env' }
    return cachedDshInvocation
  }

  // 2. 用户 shell 解析（which dsh / where dsh）
  try {
    const shell = isWin ? 'cmd.exe' : '/bin/zsh'
    const args = isWin ? ['/c', 'where dsh'] : ['-lc', 'which dsh']
    const out = execFileSync(shell, args, { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    const bad = !out || /not found|找不到|不是内部或外部命令/i.test(out)
    if (!bad) {
      resolverLog(`which/where 命中: ${out}`)
      cachedDshInvocation = { cmd: out.trim(), args: [], source: 'shell' }
      return cachedDshInvocation
    }
    resolverLog(`which/where 未命中: ${out || '(空)'}`)
  }
  catch (e) {
    resolverLog(`which/where 失败: ${String(e.message).slice(0, 120)}`)
  }

  // 3. npx 缓存扫描（默认 + npm config get cache）
  try {
    const npxRoots = [path.join(os.homedir(), '.npm', '_npx')]
    try {
      const cacheRoot = execFileSync(
        isWin ? 'cmd.exe' : '/bin/zsh',
        isWin ? ['/c', 'npm config get cache'] : ['-lc', 'npm config get cache'],
        { encoding: 'utf8' },
      ).trim()
      if (cacheRoot && !npxRoots.includes(path.join(cacheRoot, '_npx'))) {
        npxRoots.push(path.join(cacheRoot, '_npx'))
      }
    }
    catch { /* 忽略 */ }

    for (const npxRoot of npxRoots) {
      if (!fs.existsSync(npxRoot)) continue
      const matches = []
      for (const dir of fs.readdirSync(npxRoot)) {
        const binDir = path.join(npxRoot, dir, 'node_modules', '.bin')
        if (!fs.existsSync(binDir)) continue
        for (const name of fs.readdirSync(binDir)) {
          if (name === 'dsh' || name === 'dsh.cmd' || name === 'dsh.exe') {
            const full = path.join(binDir, name)
            try { matches.push({ full, mtime: fs.statSync(full).mtimeMs }) } catch {}
          }
        }
      }
      if (matches.length) {
        matches.sort((a, b) => b.mtime - a.mtime)
        resolverLog(`npx 缓存命中: ${matches[0].full}`)
        cachedDshInvocation = { cmd: matches[0].full, args: [], source: 'npx-cache' }
        return cachedDshInvocation
      }
    }
    resolverLog(`npx 缓存未命中（扫描 ${npxRoots.join(', ')}）`)
  }
  catch (e) {
    resolverLog(`npx 扫描失败: ${String(e.message).slice(0, 120)}`)
  }

  // 4. npm 全局安装
  try {
    const globalRoot = isWin
      ? path.join(process.env.APPDATA || os.homedir(), 'npm')
      : execFileSync('/bin/zsh', ['-lc', 'npm root -g'], { encoding: 'utf8' }).trim()
    const binDir = path.join(globalRoot, 'node_modules', '.bin')
    if (fs.existsSync(binDir)) {
      for (const name of ['dsh.cmd', 'dsh', 'dsh.exe']) {
        if (fs.existsSync(path.join(binDir, name))) {
          resolverLog(`npm 全局命中: ${path.join(binDir, name)}`)
          cachedDshInvocation = { cmd: path.join(binDir, name), args: [], source: 'npm-global' }
          return cachedDshInvocation
        }
      }
    }
    resolverLog(`npm 全局未命中: ${binDir}`)
  }
  catch (e) {
    resolverLog(`npm 全局失败: ${String(e.message).slice(0, 120)}`)
  }

  // 5. 兜底：npx 执行（跨平台最稳，首次可能触发下载）
  resolverLog('所有本地路径未命中，回退 npx --yes @deepseek-ai/dsh')
  cachedDshInvocation = {
    cmd: isWin ? 'npx.cmd' : 'npx',
    args: ['--yes', '@deepseek-ai/dsh'],
    source: 'npx',
  }
  return cachedDshInvocation
}

async function ensureDshWeb() {
  // 端口已被监听：验证是 DSH 服务再复用（防止被其他程序占用后误连）
  if (await checkPort(dsh.WEB_PORT)) {
    try {
      await dsh.listWorkspaces()
      return { reused: true, error: null }
    }
    catch {
      return {
        reused: false,
        error: `端口 ${dsh.WEB_PORT} 已被其他程序占用（不是 DSH 服务）。\n请关闭占用该端口的程序后重新打开。`,
      }
    }
  }

  const inv = resolveDshInvocation()
  const shellPath = resolveShellPath()
  const spawnArgs = [...inv.args, 'web']
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const logFd = fs.openSync(LOG_FILE, 'a')
  fs.appendFileSync(LOG_FILE, `\n[${new Date().toISOString()}] starting: ${inv.cmd} ${spawnArgs.join(' ')} (source=${inv.source}, port ${dsh.WEB_PORT})\n`)

  // 启动等待期间给用户反馈（首次 npx 下载可能较久）
  if (tray) tray.setToolTip('正在启动 DSH 服务…')

  try {
    if (inv.useSystemNode) {
      // 系统 Node 运行内置 dsh：koffi ABI 兼容 → native 目录选择器可用。
      // 不带 browse patch，不带 --expose-internals（系统 node 无 HMR 问题）。
      dshProcess = spawn(inv.cmd, [...inv.args, 'web'], {
        cwd: os.homedir(),
        shell: false,
        env: { ...process.env, PATH: shellPath },
        stdio: ['ignore', logFd, logFd],
      })
    }
    else if (inv.useNodeMode) {
      // 内置 dsh：直接用 Electron 二进制以 Node 模式运行（无需 shell/系统 node）
      // --expose-internals: HMR 插件在 Node 24 下强制要求（否则报错退出）
      // --profile web + --patch: 固定 browse 目录选择器（koffi 与 Electron 内置
      //   Node ABI 不兼容，native worker 崩溃：win32 folder dialog worker exited
      //   before reporting a result）。browse 模式在 WebView 内浏览，跨平台兜底。
      const bootArgs = ['--expose-internals', ...inv.args, '--profile', 'web']
      const pickerPatch = path.join(__dirname, 'browse-picker.patch.yml')
      if (fs.existsSync(pickerPatch)) {
        bootArgs.push('--patch', pickerPatch)
      }
      dshProcess = spawn(process.execPath, bootArgs, {
        cwd: os.homedir(),
        env: { ...process.env, PATH: shellPath, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', logFd, logFd],
      })
    }
    else {
      dshProcess = spawn(inv.cmd, spawnArgs, {
        cwd: os.homedir(),
        shell: true,
        env: { ...process.env, PATH: shellPath },
        stdio: ['ignore', logFd, logFd],
      })
    }
    weSpawnedDsh = true
  }
  catch (err) {
    fs.appendFileSync(LOG_FILE, `spawn failed: ${err.message}\n`)
    if (tray) tray.setToolTip('DeepSeek Harness')
    return { reused: false, error: `无法启动 ${inv.cmd}: ${err.message}` }
  }

  dshProcess.on('exit', (code, signal) => {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] dsh web exited code=${code} signal=${signal}\n`)
    if (!isQuitting && weSpawnedDsh) {
      const choice = dialog.showMessageBoxSync({
        type: 'error',
        title: 'DSH 服务已退出',
        message: `${inv.cmd} 进程退出(code=${code})。`,
        detail: `日志：${LOG_FILE}`,
        buttons: ['🔄 重启服务', '关闭'],
        defaultId: 0,
        cancelId: 1,
      })
      if (choice === 0) {
        dshProcess = null
        weSpawnedDsh = false
        ensureDshWeb().then(({ error }) => {
          if (!error && mainWindow) mainWindow.loadURL(WEB_URL)
        })
      }
    }
  })

  const ok = await waitForPort(dsh.WEB_PORT)
  if (tray) tray.setToolTip('DeepSeek Harness')
  if (!ok) {
    const installHint = inv.source === 'npx'
      ? '\n正在通过 npx 下载 DSH，如网络较慢请耐心等待；\n也可以手动安装后重启：npm install -g @deepseek-ai/dsh'
      : '\n如未安装 dsh，请先安装（需 Node.js 18+）：\n  npm install -g @deepseek-ai/dsh'
    return {
      reused: false,
      error: `等待 ${inv.cmd} web 就绪超时。${installHint}\n日志：${LOG_FILE}`,
    }
  }
  return { reused: false, error: null }
}

function stopDshWeb() {
  if (weSpawnedDsh && dshProcess && !dshProcess.killed) {
    dshProcess.kill()
  }
}

// ---------------------------------------------------------------------------
// 工作区（项目）同步
// ---------------------------------------------------------------------------
async function refreshWorkspaces() {
  try {
    const { items } = await dsh.listWorkspaces()
    workspaces = items || []
  }
  catch {
    // 服务未就绪：保留旧缓存
  }
  rebuildTrayMenu()
}

function workspaceById(id) {
  return workspaces.find(w => w.workspaceId === id)
}

// ---------------------------------------------------------------------------
// 会话状态轮询（任务状态提示）
// ---------------------------------------------------------------------------
async function refreshSessions() {
  try {
    const { items } = await dsh.listSessions()
    const prevRunning = sessions.filter(s => s.running).map(s => s.sessionId)
    sessions = items || []
    notifyTaskCompletions(prevRunning)
  }
  catch {
    // 服务未就绪：保留旧缓存
  }
  updateTrayStatus()
}

/** 检测 running → idle 的会话并发送系统通知 */
function notifyTaskCompletions(prevRunningIds) {
  if (!Notification.isSupported()) return
  const nowRunning = new Set(sessions.filter(s => s.running).map(s => s.sessionId))
  for (const id of prevRunningIds) {
    if (!nowRunning.has(id)) {
      const s = sessions.find(x => x.sessionId === id)
      if (s) {
        new Notification({
          title: '✅ 任务完成',
          body: sessionTitle(s),
        }).show()
      }
    }
  }
}

function updateTrayStatus() {
  if (!tray) return
  const running = sessions.filter(s => s.running)
  const title = running.length
    ? `● ${running.length} 个会话运行中`
    : `DSH 空闲`
  tray.setToolTip(`${title} · DeepSeek Harness`)
  rebuildTrayMenu()
}

function sessionTitle(s) {
  const t = s.projections?.values?.title
  return typeof t === 'string' && t.trim() ? t.trim() : s.cwd || s.sessionId
}

async function openWorkspace(ws) {
  try {
    await dsh.createSession({ workspaceId: ws.workspaceId })
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(WEB_URL)
    }
    showWindow()
  }
  catch (err) {
    dialog.showErrorBox('打开项目失败', err.message)
  }
}

async function pickAndAddWorkspace() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '添加项目到 DSH',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths.length) return
  try {
    await dsh.createWorkspace(filePaths[0])
    await refreshWorkspaces()
    showWindow()
  }
  catch (err) {
    dialog.showErrorBox('添加项目失败', err.message)
  }
}

async function renameWorkspace(ws) {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: '重命名项目',
    message: `重命名「${ws.title}」为：`,
    buttons: ['确定', '取消'],
  })
  // 简单交互：用 input 对话框（Electron 无内置 input，退化为提示）
  if (response !== 0) return
  dialog.showErrorBox('提示', 'Electron MVP 暂不支持内联输入重命名，可在 DSH Web 界面中操作。')
}

async function deleteWorkspace(ws) {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: '删除项目',
    message: `确定从 DSH 移除「${ws.title}」？\n（仅移除工作区记录，不会删除磁盘文件）`,
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
  })
  if (response !== 0) return
  try {
    await dsh.rpc('workspace.delete', { workspaceId: ws.workspaceId })
    await refreshWorkspaces()
  }
  catch (err) {
    dialog.showErrorBox('删除失败', err.message)
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'DeepSeek Harness',
    icon: APP_ICON,
    backgroundColor: '#12162e',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.loadURL(WEB_URL)
  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -102 || code === -105) {
      mainWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="font-family:-apple-system,sans-serif;background:#12162e;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center;max-width:560px;padding:24px">
            <h2>DSH 服务未就绪</h2>
            <p>${desc}</p>
            <p style="color:#8a8f9d">服务可能还在启动中，或需要安装 DSH：</p>
            <pre style="background:#1c2340;padding:12px;border-radius:8px;text-align:left;font-size:13px">npm install -g @deepseek-ai/dsh</pre>
            <p style="color:#8a8f9d">日志：${LOG_FILE}</p>
          </div></body></html>`)}`,
      )
    }
  })
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleWindow() {
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide()
  }
  else {
    showWindow()
  }
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON)
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  }
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  tray.on('click', () => toggleWindow())
  rebuildTrayMenu()
}

function loginItemEnabled() {
  try {
    return app.getLoginItemSettings().openAtLogin
  }
  catch {
    return false
  }
}

function toggleLoginItem() {
  const next = !loginItemEnabled()
  app.setLoginItemSettings({ openAtLogin: next })
  rebuildTrayMenu()
}

function rebuildTrayMenu() {
  if (!tray) return

  const running = sessions.filter(s => s.running)

  // 状态区
  const statusItems = running.length
    ? [
        { label: `● ${running.length} 个会话运行中`, enabled: false },
        ...running.slice(0, 5).map(s => ({
          label: `   ${sessionTitle(s)}`,
          enabled: false,
        })),
      ]
    : [{ label: '○ DSH 空闲', enabled: false }]

  // 项目（工作区）子菜单
  const wsSubmenu = workspaces.length
    ? workspaces.map(ws => ({
        label: `📁 ${ws.title}（${ws.sessionIds.length} 会话）`,
        submenu: [
          { label: '🚀 打开（新建会话）', click: () => openWorkspace(ws) },
          { type: 'separator' },
          { label: '重命名…', click: () => renameWorkspace(ws) },
          { label: '🗑 从 DSH 移除', click: () => deleteWorkspace(ws) },
        ],
      }))
    : [{ label: '（暂无项目）', enabled: false }]

  const menu = Menu.buildFromTemplate([
    ...statusItems,
    { type: 'separator' },
    {
      label: '🖥 显示 / 隐藏窗口',
      click: () => toggleWindow(),
    },
    { type: 'separator' },
    {
      label: `📂 项目（${workspaces.length}）`,
      submenu: [
        ...wsSubmenu,
        { type: 'separator' },
        { label: '➕ 添加项目…', click: () => pickAndAddWorkspace() },
        { label: '🔄 刷新项目列表', click: () => refreshWorkspaces() },
      ],
    },
    { type: 'separator' },
    {
      label: '⚙️ DSH 服务',
      submenu: [
        {
          label: '重启服务',
          enabled: weSpawnedDsh,
          click: async () => {
            if (weSpawnedDsh && dshProcess) {
              dshProcess.kill()
              dshProcess = null
              weSpawnedDsh = false
            }
            const { error } = await ensureDshWeb()
            if (!error && mainWindow) mainWindow.loadURL(WEB_URL)
            if (error) dialog.showErrorBox('服务启动失败', error)
            refreshWorkspaces()
            refreshSessions()
          },
        },
        { label: '打开日志目录', click: () => shell.openPath(DATA_DIR) },
      ],
    },
    { type: 'separator' },
    {
      label: '⌨️ 快捷键',
      submenu: SHORTCUT_PRESETS.map(preset => ({
        label: preset.label,
        type: 'radio',
        checked: getShortcut() === preset.value,
        click: () => {
          settings.save({ shortcut: preset.value })
          registerShortcut()
          rebuildTrayMenu()
        },
      })),
    },
    {
      label: '☑️ 开机自启',
      type: 'checkbox',
      checked: loginItemEnabled(),
      click: () => toggleLoginItem(),
    },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        stopDshWeb()
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}
else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(async () => {
    registerShortcut()

    createTray()

    const { error } = await ensureDshWeb()
    if (error) {
      dialog.showErrorBox('DSH 服务启动失败', error)
    }
    createWindow()
    refreshWorkspaces()
    refreshSessions()

    // 首次启动：展示引导窗口
    if (!settings.load().onboarded) {
      showOnboarding()
    }

    // 周期同步工作区与会话状态
    setInterval(() => refreshWorkspaces(), 30000)
    setInterval(() => refreshSessions(), 15000)
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (statusTimer) clearInterval(statusTimer)
  })

  // 关键修复：Cmd+Q / Dock 退出 / 系统关机都会触发 before-quit。
  // 必须在这里放行 isQuitting，否则窗口 close 的 preventDefault 会拦截退出，
  // 导致 App 卡在 Dock 上只能强制退出。
  app.on('before-quit', () => {
    isQuitting = true
    stopDshWeb()
  })

  // 崩溃自愈：主进程未捕获异常 → 记录日志并自动重启
  process.on('uncaughtException', (err) => {
    try {
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] uncaughtException: ${err.stack || err.message}\n`)
    }
    catch {}
    app.relaunch()
    app.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    try {
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] unhandledRejection: ${reason}\n`)
    }
    catch {}
  })

  // 渲染进程崩溃 → 重建窗口
  app.on('render-process-gone', (_event, _webContents, details) => {
    try {
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] renderer gone: ${details.reason}\n`)
    }
    catch {}
    if (!isQuitting) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(WEB_URL)
        }
        else {
          createWindow()
        }
      }, 1500)
    }
  })

  app.on('activate', () => showWindow())

  app.on('window-all-closed', () => {
    // 常驻托盘，不退出
  })
}

// ---------------------------------------------------------------------------
// 首次启动引导
// ---------------------------------------------------------------------------
function showOnboarding() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show()
    return
  }
  onboardingWindow = new BrowserWindow({
    width: 620,
    height: 680,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '欢迎使用 DSH Desktop',
    icon: APP_ICON,
    backgroundColor: '#12162e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  onboardingWindow.loadFile(ONBOARDING_HTML)
  onboardingWindow.on('closed', () => {
    settings.save({ onboarded: true })
    onboardingWindow = null
  })
  onboardingWindow.on('close', () => {
    settings.save({ onboarded: true })
  })
}
