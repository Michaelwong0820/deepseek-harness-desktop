# ============================================================
# DSH Web 服务自启部署脚本（Windows 10/11）
# 用途：规避 DSH Desktop 内置 Node 24 的 HMR bug
#       让 Node 22 的 dsh web 常驻 3080 端口，供 DSH Desktop 复用
# 用法：右键"以管理员身份运行 PowerShell"，执行本脚本
# ============================================================

$ErrorActionPreference = "Stop"
Write-Host "=== DSH Web 自启部署 ===" -ForegroundColor Cyan

# ---- 第 1 步：检查 Node ----
$nodeVer = node --version 2>$null
if (-not $nodeVer) {
    Write-Host "[X] 未检测到 Node.js，请先安装 Node.js 22 LTS（https://nodejs.org）" -ForegroundColor Red
    Write-Host "    安装完成后重新运行本脚本。"
    pause
    exit 1
}
Write-Host "[OK] Node.js $nodeVer" -ForegroundColor Green

# 确保主版本是 22（node-addon 兜底 / 兼容性最好）
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($major -ne 22) {
    Write-Host "[!] 建议使用 Node 22（当前 $nodeVer），继续执行可能出现兼容问题" -ForegroundColor Yellow
}

# ---- 第 2 步：安装 dsh 全局包 ----
Write-Host "正在安装 @deepseek-ai/dsh（首次需联网下载）..." -ForegroundColor Cyan
npm install -g @deepseek-ai/dsh
if ($LASTEXITCODE -ne 0) { Write-Host "[X] 安装失败" -ForegroundColor Red; pause; exit 1 }
Write-Host "[OK] dsh 已安装" -ForegroundColor Green

# ---- 第 3 步：定位 bin.js ----
$dshBin = Join-Path (npm root -g) "@deepseek-ai\dsh\lib\bin.js"
if (-not (Test-Path $dshBin)) {
    Write-Host "[X] 找不到 dsh bin.js：$dshBin" -ForegroundColor Red
    pause; exit 1
}
Write-Host "[OK] dsh 路径：$dshBin" -ForegroundColor Green

# ---- 第 4 步：立即启动一次（验证）----
Write-Host "正在启动 dsh web（端口 3080）..." -ForegroundColor Cyan
$proc = Start-Process node -ArgumentList "--expose-internals", "`"$dshBin`"", "web" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 8
$test = Test-NetConnection -ComputerName 127.0.0.1 -Port 3080 -WarningAction SilentlyContinue
if ($test.TcpTestSucceeded) {
    Write-Host "[OK] dsh web 已在 127.0.0.1:3080 运行" -ForegroundColor Green
} else {
    Write-Host "[!] 端口 3080 暂未就绪（可能已被其他程序占用，或启动较慢）" -ForegroundColor Yellow
    Write-Host "    检查：netstat -ano | findstr 3080"
}

# ---- 第 5 步：注册开机自启（计划任务，登录时启动）----
$taskName = "DSHWeb"
$action = "node --expose-internals `"$dshBin`" web"
Write-Host "正在注册计划任务 [$taskName] ..." -ForegroundColor Cyan
schtasks /Create /TN $taskName /TR $action /SC ONLOGON /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] 计划任务已注册：登录时自动启动 dsh web" -ForegroundColor Green
} else {
    Write-Host "[X] 计划任务注册失败（请确认以管理员运行）" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== 完成！===" -ForegroundColor Cyan
Write-Host "现在可以打开 DSH Desktop 正常使用（会自动复用 3080 端口，不再报错）。"
Write-Host "如需卸载：schtasks /Delete /TN $taskName /F"
pause
