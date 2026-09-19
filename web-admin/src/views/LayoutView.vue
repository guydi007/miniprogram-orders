<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="brand-mark small">工</div>
        <div>
          <strong>工单后台</strong>
          <span>PC Workspace</span>
        </div>
      </div>

      <nav class="nav-list">
        <router-link to="/orders" class="nav-item">工单管理</router-link>
        <router-link v-if="canCreate" to="/create" class="nav-item">新建工单</router-link>
      </nav>

      <div class="sidebar-bottom">
        <div class="user-card">
          <div class="avatar">{{ initials }}</div>
          <div class="user-meta">
            <strong>{{ user?.name || '员工' }}</strong>
            <span>{{ roleLabel }}</span>
          </div>
        </div>
        <el-button plain class="logout-button" @click="logout">退出当前账号</el-button>
      </div>
    </aside>

    <main class="main-area">
      <header class="topbar">
        <div>
          <h2>{{ pageTitle }}</h2>
          <p>与微信小程序共用同一套订单数据和权限规则</p>
        </div>
        <div class="city-scope" v-if="user?.role !== 'admin'">
          城市权限：{{ (user?.cities || []).join('、') || '未配置' }}
        </div>
      </header>
      <section class="content-area">
        <router-view />
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { session } from '../stores/session'

const route = useRoute()
const router = useRouter()
const user = computed(() => session.state.user)
const canCreate = computed(() => ['service', 'leader'].includes(user.value?.role))
const initials = computed(() => (user.value?.name || '员').slice(0, 1))
const roleLabel = computed(() => ({ admin: '管理员', leader: '主管', service: '客服', worker: '师傅' }[user.value?.role] || user.value?.role || ''))
const pageTitle = computed(() => {
  if (route.path === '/create') return '新建工单'
  if (route.path.startsWith('/orders/')) return '工单详情'
  return '工单管理'
})

async function logout() {
  await session.logout()
  router.replace('/login')
}
</script>
