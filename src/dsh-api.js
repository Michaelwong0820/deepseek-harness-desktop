/**
 * DSH RPC 客户端 — 通过 HTTP 调用 DeepSeek Harness Web 的 API
 *
 * 协议（与浏览器前端一致）：
 *   POST /api/<method>
 *   {"type":"client-request","rpcId":"<uuid>","method":"<ns.method>","payload":{...}}
 *   → {"type":"server-response","rpcId":"...","result":{"ok":true,"value":...}}
 *
 * 已确认的 API（来自 dsh-host-apiproxy schema）：
 *   workspace.list     {} → {items:[{workspaceId,path,title,sessionIds,createdAt,updatedAt}], archivedSessionIds}
 *   workspace.create   {path} → {workspace, created}
 *   workspace.rename   {workspaceId,title}
 *   workspace.delete   {workspaceId} → {deleted}
 *   session.create     {workspaceId | cwd, sessionId?, agentPreset?} → {sessionId}
 */
const { randomUUID } = require('node:crypto')

const WEB_PORT = 3080
const BASE = `http://127.0.0.1:${WEB_PORT}`

async function rpc(method, payload = {}) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload,
    }),
  })
  if (!res.ok) {
    throw new Error(`RPC ${method} HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  }
  const data = await res.json()
  if (!data.result || !data.result.ok) {
    throw new Error(`RPC ${method} failed: ${JSON.stringify(data.result?.error || data)}`)
  }
  return data.result.value
}

/** 列出所有工作区（= 项目） */
function listWorkspaces() {
  return rpc('workspace.list', {})
}

/** 注册一个目录为工作区（已存在则直接返回） */
async function createWorkspace(path) {
  const value = await rpc('workspace.create', { path })
  return value.workspace
}

/** 在工作区创建新会话 */
function createSession({ workspaceId, cwd } = {}) {
  return rpc('session.create', { workspaceId, cwd })
}

/** 列出所有会话（含 running 状态、标题、统计） */
function listSessions() {
  return rpc('session.list', {})
}

module.exports = {
  WEB_PORT,
  BASE,
  rpc,
  listWorkspaces,
  createWorkspace,
  createSession,
  listSessions,
}
