import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export type UserRole = 'admin' | 'user'

export interface AdminInfo {
  id?: string
  username: string
  role: UserRole
  avatar?: string
  quota?: number | null
  usedQuota?: number
  enabled?: boolean
  expiresAt?: number | null
  mustChangePassword?: boolean
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: 'rate_limit' | 'locked' | 'invalid_credentials' | 'disabled' | 'expired'
  remainingMs?: number
  data?: {
    token: string
    role: UserRole
    user: { id?: string, username: string }
    quota?: number | null
    usedQuota?: number
    expiresAt?: number | null
    mustChangePassword?: boolean
  }
}

function applyAuthPayload(tokenRef: { value: string }, userInfoRef: { value: AdminInfo | null }, data: NonNullable<LoginResult['data']>) {
  tokenRef.value = data.token
  userInfoRef.value = {
    id: data.user.id,
    username: data.user.username,
    role: data.role,
    quota: data.quota,
    usedQuota: data.usedQuota ?? 0,
    expiresAt: data.expiresAt ?? null,
    mustChangePassword: data.mustChangePassword,
  }
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  const userInfo = useStorage<AdminInfo | null>('user_info', null)
  const isLoggedIn = computed(() => !!token.value)
  const username = computed(() => userInfo.value?.username || '')
  const avatar = computed(() => userInfo.value?.avatar || '')
  const role = computed<UserRole>(() => userInfo.value?.role === 'user' ? 'user' : 'admin')
  const isAdmin = computed(() => role.value === 'admin')
  const quota = computed(() => userInfo.value?.quota ?? null)
  const usedQuota = computed(() => userInfo.value?.usedQuota ?? 0)
  const quotaLabel = computed(() => {
    if (isAdmin.value)
      return '不限'
    return `${usedQuota.value} / ${quota.value ?? 99}`
  })
  const roleLabel = computed(() => isAdmin.value ? '超级管理员' : '普通用户')

  async function login(usernameValue: string, password: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username: usernameValue, password })
      if (res.data.ok)
        applyAuthPayload(token, userInfo, res.data.data)
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? { ok: false, error: getApiErrorMessage(data, '网络错误'), errorType: data.errorType, remainingMs: data.remainingMs }
        : { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function register(usernameValue: string, password: string, cardKey = ''): Promise<LoginResult> {
    try {
      const res = await api.post('/api/register', { username: usernameValue, password, cardKey })
      if (res.data.ok)
        applyAuthPayload(token, userInfo, res.data.data)
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? { ok: false, error: getApiErrorMessage(data, '注册失败') }
        : { ok: false, error: getApiErrorMessage(error, '注册失败') }
    }
  }

  async function logout() {
    try {
      await api.post('/api/logout')
    }
    finally {
      token.value = ''
      userInfo.value = null
    }
  }

  async function fetchUserInfo() {
    try {
      const res = await api.get('/api/user/me')
      if (res.data.ok)
        userInfo.value = res.data.data
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await api.post('/api/user/change-password', { oldPassword, newPassword })
    return res.data
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    username,
    avatar,
    role,
    isAdmin,
    quota,
    usedQuota,
    quotaLabel,
    roleLabel,
    login,
    register,
    logout,
    fetchUserInfo,
    changePassword,
  }
})
