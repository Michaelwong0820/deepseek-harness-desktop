// 诊断 native directory-picker worker（Electron 内置模式）
// 用法: node diag-worker.js <electron-exe> <worker.cjs>
const { spawn } = require('node:child_process')

const exe = process.argv[2]
const worker = process.argv[3]
console.log('exe:', exe)
console.log('worker:', worker)

const child = spawn(exe, [worker], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DIALOG_TITLE: 'diag-test',
  },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})

let got = false
child.on('message', (m) => {
  got = true
  console.log('WORKER_MSG:', JSON.stringify(m).slice(0, 300))
})
child.on('error', (e) => console.log('SPAWN_ERROR:', e.message))
child.on('exit', (code, signal) => {
  console.log(`WORKER_EXIT: code=${code} signal=${signal} gotMessage=${got}`)
  process.exit(0)
})
setTimeout(() => {
  if (!got) console.log('TIMEOUT: no message from worker (likely crashed before IPC ready)')
  child.kill()
}, 10000)
