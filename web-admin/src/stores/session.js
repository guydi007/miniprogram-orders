import { reactive } from 'vue'
import { auth } from '../services/cloudbase'
import { api } from '../services/api'

const state = reactive({
  user: null,
  ready: false,
  loading: false
})

let hydratePromise = null

async function hasValidSession() {
  try {
    const result = await auth.getSession()
    return Boolean(result && result.data && result.data.session)
  } catch {
    return false
  }
}

async function hydrate(force = false) {
  if (!force && state.ready) return state.user
  if (hydratePromise) return hydratePromise
  state.loading = true
  hydratePromise = (async () => {
    try {
      if (!await hasValidSession()) {
        state.user = null
        return null
      }
      const result = await api.sessionUser()
      state.user = result.user || null
      return state.user
    } catch {
      state.user = null
      return null
    } finally {
      state.ready = true
      state.loading = false
      hydratePromise = null
    }
  })()
  return hydratePromise
}

async function login(phone, password) {
  const { data, error } = await auth.signInWithPassword({ phone, password })
  if (error) throw new Error(error.message || '登录失败')
  if (!data?.session) throw new Error('登录失败：未取得有效会话')
  state.ready = false
  state.loading = true
  try {
    // 第一次登录时由后端核验：当前 CloudBase UID 必须确实拥有这个手机号，
    // 然后把 UID 绑定到 users.webUid；已绑定账号会直接返回同一员工。
    const result = await api.bindWebEmployee(phone)
    state.user = result.user || null
    if (!state.user) throw new Error('网页登录账号未能绑定员工')
    state.ready = true
    return state.user
  } catch (error) {
    state.user = null
    state.ready = true
    try { await auth.signOut() } catch { /* ignore */ }
    throw error
  } finally {
    state.loading = false
  }
}

async function logout() {
  try { await auth.signOut() } finally {
    state.user = null
    state.ready = true
  }
}

export const session = { state, hydrate, login, logout }
