<template>
  <div>
    <div class="toolbar-card">
      <div class="toolbar-row">
        <el-input v-model.trim="keyword" clearable placeholder="搜索客户电话 / 地址 / 工单号" class="search-input" />
        <el-select v-model="status" clearable placeholder="全部状态" style="width: 150px">
          <el-option v-for="item in statuses" :key="item" :label="item" :value="item" />
        </el-select>
        <el-select v-model="city" clearable placeholder="全部城市" style="width: 140px">
          <el-option v-for="item in availableCities" :key="item" :label="item" :value="item" />
        </el-select>
        <el-button :loading="loading" @click="load">刷新</el-button>
        <el-button v-if="canCreate" type="primary" @click="$router.push('/create')">新建工单</el-button>
      </div>

      <div class="time-filter-row">
        <span class="filter-label">预约时间</span>
        <el-button-group>
          <el-button :type="timeFilter === 'today' ? 'primary' : 'default'" @click="selectTimeFilter('today')">今日</el-button>
          <el-button :type="timeFilter === 'tomorrow' ? 'primary' : 'default'" @click="selectTimeFilter('tomorrow')">次日</el-button>
          <el-button :type="timeFilter === 'week' ? 'primary' : 'default'" @click="selectTimeFilter('week')">本周</el-button>
          <el-button :type="timeFilter === 'custom' ? 'primary' : 'default'" @click="selectTimeFilter('custom')">自定义</el-button>
          <el-button :type="timeFilter === 'all' ? 'primary' : 'default'" @click="selectTimeFilter('all')">全部</el-button>
        </el-button-group>
        <el-date-picker
          v-if="timeFilter === 'custom'"
          v-model="customDate"
          type="date"
          value-format="YYYY-MM-DD"
          format="YYYY-MM-DD"
          placeholder="选择日期"
          :clearable="false"
          style="width: 150px"
        />
      </div>

      <div class="order-summary">
        <span>当前 {{ filtered.length }} 单</span>
        <span>待派 {{ counts.pending }}</span>
        <span>已派 {{ counts.assigned }}</span>
        <span>已完工 {{ counts.done }}</span>
        <span>未成 {{ counts.failed }}</span>
      </div>
    </div>

    <el-card shadow="never" class="table-card">
      <el-table :data="paged" v-loading="loading" height="calc(100vh - 330px)" stripe @row-dblclick="openDetail">
        <el-table-column prop="customerPhone" label="客户电话" width="135" fixed />
        <el-table-column prop="city" label="城市" width="90" />
        <el-table-column prop="address" label="服务地址" min-width="230" show-overflow-tooltip />
        <el-table-column prop="appointmentTime" label="预约上门时间" min-width="190" show-overflow-tooltip />
        <el-table-column prop="source" label="来源" width="100" />
        <el-table-column prop="workerName" label="师傅" width="100">
          <template #default="scope">{{ scope.row.workerName || '待派' }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="105">
          <template #default="scope"><span :class="['status-pill', statusClass(scope.row.status)]">{{ scope.row.status }}</span></template>
        </el-table-column>
        <el-table-column prop="createTime" label="录单时间" width="160">
          <template #default="scope">{{ formatBusinessDateTime(scope.row.createTime) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="95" fixed="right">
          <template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">详情</el-button></template>
        </el-table-column>
      </el-table>
      <div class="pagination-row">
        <el-pagination v-model:current-page="page" v-model:page-size="pageSize" background layout="total, prev, pager, next" :total="filtered.length" />
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../services/api'
import { session } from '../stores/session'
import {
  businessDateParts,
  businessDateString,
  businessWeekRange,
  formatBusinessDateTime,
  parseAppointmentDate
} from '../services/business-time'

const router = useRouter()
const loading = ref(false)
const orders = ref([])
const keyword = ref('')
const status = ref('')
const city = ref('')
const timeFilter = ref('today')
const customDate = ref('')
const page = ref(1)
const pageSize = ref(30)
const statuses = ['待派单', '已派单', '已完工', '未成单']
const canCreate = computed(() => ['service', 'leader'].includes(session.state.user?.role))
const availableCities = computed(() => session.state.user?.role === 'admin' ? [...new Set(orders.value.map(o => o.city).filter(Boolean))] : (session.state.user?.cities || []))

const filtered = computed(() => {
  const key = keyword.value.toLowerCase()
  const currentYear = businessDateParts().year
  const today = businessDateString(0)
  const tomorrow = businessDateString(1)
  const week = businessWeekRange()

  return orders.value.filter(order => {
    if (status.value && order.status !== status.value) return false
    if (city.value && order.city !== city.value) return false

    if (timeFilter.value !== 'all') {
      const orderDate = parseAppointmentDate(order.appointmentTime, currentYear)
      if (!orderDate) return false
      if (timeFilter.value === 'today' && orderDate !== today) return false
      if (timeFilter.value === 'tomorrow' && orderDate !== tomorrow) return false
      if (timeFilter.value === 'week' && (orderDate < week.start || orderDate > week.end)) return false
      if (timeFilter.value === 'custom' && customDate.value && orderDate !== customDate.value) return false
    }

    if (!key) return true
    return [order._id, order.customerPhone, order.address, order.appointmentTime, order.workerName]
      .some(value => String(value || '').toLowerCase().includes(key))
  })
})
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const counts = computed(() => ({
  pending: filtered.value.filter(o => o.status === '待派单').length,
  assigned: filtered.value.filter(o => o.status === '已派单').length,
  done: filtered.value.filter(o => o.status === '已完工').length,
  failed: filtered.value.filter(o => o.status === '未成单').length
}))

watch([keyword, status, city, timeFilter, customDate], () => { page.value = 1 })

function selectTimeFilter(type) {
  timeFilter.value = type
  if (type === 'custom' && !customDate.value) customDate.value = businessDateString(0)
}

function statusClass(value) {
  return ({ '待派单': 'pending', '已派单': 'assigned', '已完工': 'done', '未成单': 'failed' })[value] || ''
}
function openDetail(row) { router.push(`/orders/${row._id}`) }
async function load() {
  loading.value = true
  try {
    const result = await api.orders()
    orders.value = (result.orders || []).sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')))
  } catch (error) {
    ElMessage.error(error.message || '工单加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>
