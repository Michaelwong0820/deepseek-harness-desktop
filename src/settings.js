/**
 * 设置持久化 — ~/.dsh-desktop/settings.json
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DATA_DIR = path.join(os.homedir(), '.dsh-desktop')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

const DEFAULTS = {
  shortcut: 'CommandOrControl+Shift+Space',
  onboarded: false,
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return { ...DEFAULTS, ...raw }
  }
  catch {
    return { ...DEFAULTS }
  }
}

function save(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const next = { ...load(), ...patch }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2))
  return next
}

module.exports = { load, save, DATA_DIR }
