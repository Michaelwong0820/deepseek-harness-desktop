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
} = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const dsh = require('./dsh-api')

const WEB_URL = dsh.BASE
const DATA_DIR = path.join(os.homedir(), '.dsh-desktop')
const RECENT_FILE = path.join(DATA_DIR, 'recent-projects.json')
const LOG_FILE = path.join(DATA_DIR, 'dsh-web.log')
const SHORTCUT = 'CommandOrControl+Shift+Space'

const BUILD_DIR = path.join(__dirname, '..', 'build')
const TRAY_ICON = process.platform === 'darwin'
  ? path.join(BUILD_DIR, 'trayTemplate.png')
  : path.join(BUILD_DIR, 'tray.png')
const APP_ICON = path.join(BUILD_DIR, 'icon.png')

let mainWindow = null
let tray = null
let dshProcess = null
let weSpawnedDsh = false
let isQuitting = false
let workspaces = [] // DSH 工作区缓存
let sessions = []   // DSH 会话缓存（状态提示用）
let statusTimer = null

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

async function waitForPort(port, tries = 120, interval = 500) {
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
let cachedDshCmd = null

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
 * 解析 dsh 可执行文件路径。
 * 优先级：DSH_CMD 环境变量 > 用户 shell 的 which/where > npx 缓存扫描 > 裸 'dsh'
 */
function resolveDshCmd() {
  if (cachedDshCmd) return cachedDshCmd
  const { execFileSync } = require('node:child_process')
  const isWin = process.platform === 'win32'

  // 1. 显式指定
  if (process.env.DSH_CMD) {
    cachedDshCmd = process.env.DSH_CMD
    return cachedDshCmd
  }

  // 2. 用户 shell 解析（which dsh / where dsh）
  try {
    const shell = isWin ? 'cmd.exe' : '/bin/zsh'
    const args = isWin ? ['/c', 'where dsh'] : ['-lc', 'which dsh']
    const out = execFileSync(shell, args, { encoding: 'utf8' }).trim().split('\n')[0]
    if (out) {
      cachedDshCmd = out.trim()
      return cachedDshCmd
    }
  }
  catch { /* 继续回退 */ }

  // 3. 扫描 npx 缓存目录（macOS/Linux: ~/.npm/_npx/*/node_modules/.bin/dsh）
  try {
    const home = os.homedir()
    const npxRoot = path.join(home, '.npm', '_npx')
    if (fs.existsSync(npxRoot)) {
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
        cachedDshCmd = matches[0].full
        return cachedDshCmd
      }
    }
  }
  catch { /* 继续回退 */ }

  // 4. 最后回退：裸命令（依赖 PATH）
  cachedDshCmd = 'dsh'
  return cachedDshCmd
}

async function ensureDshWeb() {
  if (await checkPort(dsh.WEB_PORT)) {
    return { reused: true, error: null }
  }

  const cmd = resolveDshCmd()
  const shellPath = resolveShellPath()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const logFd = fs.openSync(LOG_FILE, 'a')
  fs.appendFileSync(LOG_FILE, `\n[${new Date().toISOString()}] starting: ${cmd} web (port ${dsh.WEB_PORT})\n`)

  try {
    dshProcess = spawn(cmd, ['web'], {
      cwd: os.homedir(),
      shell: true,
      env: { ...process.env, PATH: shellPath },
      stdio: ['ignore', logFd, logFd],
    })
    weSpawnedDsh = true
  }
  catch (err) {
    fs.appendFileSync(LOG_FILE, `spawn failed: ${err.message}\n`)
    return { reused: false, error: `无法启动 ${cmd}: ${err.message}` }
  }

  dshProcess.on('exit', (code, signal) => {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] dsh web exited code=${code} signal=${signal}\n`)
    if (!isQuitting && weSpawnedDsh) {
      dialog.showErrorBox('DSH 服务已退出', `dsh web 进程退出(code=${code})。\n日志：${LOG_FILE}`)
    }
  })

  const ok = await waitForPort(dsh.WEB_PORT)
  if (!ok) {
    return {
      reused: false,
      error: `等待 ${cmd} web 就绪超时。\n请确认已安装 dsh 命令（或在环境变量 DSH_CMD 中指定）。\n日志：${LOG_FILE}`,
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
    sessions = items || []
  }
  catch {
    // 服务未就绪：保留旧缓存
  }
  updateTrayStatus()
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
          <div style="text-align:center">
            <h2>DSH 服务未就绪</h2>
            <p>${desc}</p>
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
    const ok = globalShortcut.register(SHORTCUT, () => toggleWindow())
    if (!ok) {
      console.warn(`全局快捷键注册失败: ${SHORTCUT}`)
    }

    createTray()

    const { error } = await ensureDshWeb()
    if (error) {
      dialog.showErrorBox('DSH 服务启动失败', error)
    }
    createWindow()
    refreshWorkspaces()
    refreshSessions()

    // 周期同步工作区与会话状态
    setInterval(() => refreshWorkspaces(), 30000)
    setInterval(() => refreshSessions(), 15000)
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (statusTimer) clearInterval(statusTimer)
  })

  app.on('activate', () => showWindow())

  app.on('window-all-closed', () => {
    // 常驻托盘，不退出
  })
}
