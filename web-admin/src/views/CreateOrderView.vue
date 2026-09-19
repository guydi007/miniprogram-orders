<template>
  <div class="create-layout">
    <el-card class="form-panel" shadow="never">
      <template #header>
        <div class="panel-heading">
          <div>
            <h3>录入新工单</h3>
            <p>客服录单后保持“待派单”，由主管统一派单。</p>
          </div>
          <el-button @click="resetForm">清空</el-button>
        </div>
      </template>

      <el-form label-position="top" class="create-form">
        <div class="form-grid two-cols">
          <el-form-item label="客户电话" required>
            <el-input v-model.trim="form.customerPhone" maxlength="11" placeholder="请输入11位客户手机号" />
          </el-form-item>
          <el-form-item label="订单来源" required>
            <el-select v-model="form.source" placeholder="请选择订单来源" style="width: 100%" :loading="loadingReferences">
              <el-option v-for="item in sources" :key="item.name || item" :label="item.name || item" :value="item.name || item" />
            </el-select>
          </el-form-item>
        </div>

        <div class="form-grid address-grid">
          <el-form-item label="服务城市" required>
            <el-select v-model="form.city" placeholder="请选择城市" style="width: 100%" :loading="loadingReferences">
              <el-option v-for="city in permittedCities" :key="city" :label="city" :value="city" />
            </el-select>
          </el-form-item>
          <el-form-item label="服务地址" required>
            <el-input v-model.trim="form.address" placeholder="例如：和平区南京路诚基中心3号楼" />
          </el-form-item>
        </div>

        <el-form-item label="预约上门时间" required>
          <el-input
            v-model="form.appointmentTime"
            size="large"
            placeholder="可直接输入：9月9日中午12点到1点上门"
          />
          <div class="time-helper">支持自然语言，不要求必须是纯时间；输入内容会原样保存。</div>
          <div class="quick-time-grid">
            <button v-for="item in quickTimes" :key="item.label" type="button" class="quick-time-button" @click="applyQuickTime(item)">
              {{ item.label }}
            </button>
          </div>
        </el-form-item>

        <el-form-item label="初始回馈 / 备注">
          <el-input
            v-model="form.initialFeedback"
            type="textarea"
            :rows="5"
            maxlength="2000"
            show-word-limit
            placeholder="客户特殊要求、上门注意事项、初次沟通进展等（选填）"
          />
        </el-form-item>

        <div class="submit-row">
          <el-button type="primary" size="large" :loading="submitting" @click="submit">立即录入</el-button>
        </div>
      </el-form>
    </el-card>

    <aside class="create-side-note">
      <h4>录单规则</h4>
      <p>不录客户姓名，只保存业务实际需要的信息。</p>
      <p>客服没有派单权限；新订单录入后由主管处理派单。</p>
      <p>预约时间可以直接写“9月10日上门1点-2点之间”等自然语言。</p>
      <p v-if="pendingOperation" class="pending-note">检测到一笔上次未确认的录单操作，本次相同内容会复用原请求编号，避免重复工单。</p>
    </aside>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../services/api'
import { quickAppointment } from '../services/business-time'
import { session } from '../stores/session'

const router = useRouter()
const loadingReferences = ref(false)
const submitting = ref(false)
const cities = ref([])
const sources = ref([])
const STORAGE_KEY = 'webAdminPendingCreateOperation'
const pendingOperation = ref(readPending())

const form = reactive({
  customerPhone: '',
  city: '',
  address: '',
  appointmentTime: '',
  source: '',
  initialFeedback: ''
})

const quickTimes = [
  { label: '今天早上', day: 0, period: '早上' },
  { label: '今天上午', day: 0, period: '上午' },
  { label: '今天下午', day: 0, period: '下午' },
  { label: '今天晚上', day: 0, period: '晚上' },
  { label: '明天早上', day: 1, period: '早上' },
  { label: '明天上午', day: 1, period: '上午' },
  { label: '明天下午', day: 1, period: '下午' },
  { label: '明天晚上', day: 1, period: '晚上' }
]

const permittedCities = computed(() => {
  const user = session.state.user
  if (!user) return []
  if (user.role === 'admin') return cities.value
  const scope = Array.isArray(user.cities) ? user.cities : []
  return cities.value.filter(city => scope.includes(city))
})

function readPending() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') } catch { return null }
}

function savePending(value) {
  pendingOperation.value = value
  if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  else localStorage.removeItem(STORAGE_KEY)
}

function fingerprint(payload) {
  return JSON.stringify({
    customerPhone: payload.customerPhone,
    city: payload.city,
    address: payload.address,
    appointmentTime: payload.appointmentTime,
    source: payload.source,
    initialFeedback: payload.initialFeedback || ''
  })
}

function newOperationId() {
  return `create_web_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function applyQuickTime(item) {
  form.appointmentTime = quickAppointment(item.day, item.period)
}

async function loadReferences() {
  loadingReferences.value = true
  try {
    const [cityResult, sourceResult] = await Promise.all([api.cities(), api.sources()])
    cities.value = (cityResult.cities || []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean)
    sources.value = sourceResult.sources || []
    if (!form.city) form.city = permittedCities.value[0] || ''
    if (!form.source) form.source = (sources.value[0] && (sources.value[0].name || sources.value[0])) || ''
  } catch (error) {
    ElMessage.error(error.message || '基础数据加载失败')
  } finally {
    loadingReferences.value = false
  }
}

function restorePending() {
  const pending = readPending()
  if (!pending || !pending.form) return
  Object.assign(form, pending.form)
  pendingOperation.value = pending
}

async function resetForm() {
  if (pendingOperation.value) {
    try {
      await ElMessageBox.confirm('当前有一笔未确认的录单操作。清空后如果此前请求其实已成功，再重新录入可能形成重复工单。确认清空吗？', '确认清空', { type: 'warning' })
    } catch { return }
  }
  savePending(null)
  Object.assign(form, { customerPhone: '', city: permittedCities.value[0] || '', address: '', appointmentTime: '', source: (sources.value[0] && (sources.value[0].name || sources.value[0])) || '', initialFeedback: '' })
}

async function submit() {
  if (submitting.value) return
  if (!/^1\d{10}$/.test(form.customerPhone)) return ElMessage.warning('请输入正确的11位客户手机号')
  if (!form.city) return ElMessage.warning('请选择服务城市')
  if (!form.address) return ElMessage.warning('请输入服务地址')
  if (!form.appointmentTime.trim()) return ElMessage.warning('请输入预约上门时间')
  if (!form.source) return ElMessage.warning('请选择订单来源')

  const payload = {
    city: form.city,
    customerPhone: form.customerPhone,
    address: form.address,
    appointmentTime: form.appointmentTime.trim(),
    source: form.source,
    totalAmount: 0,
    paidAmount: 0,
    pendingBalance: 0,
    initialFeedback: form.initialFeedback.trim()
  }
  const fp = fingerprint(payload)
  let pending = readPending()
  if (!pending || pending.fingerprint !== fp) {
    pending = { id: newOperationId(), fingerprint: fp, form: { ...form }, createdAt: new Date().toISOString() }
    savePending(pending)
  }

  submitting.value = true
  try {
    const result = await api.createOrder({ ...payload, createOperationId: pending.id })
    savePending(null)
    if (result.duplicate) ElMessage.success('工单已经创建，系统未重复录单')
    else ElMessage.success('录单成功')
    router.push(`/orders/${result.orderId}`)
  } catch (error) {
    ElMessage.error(`${error.message || '录单失败'}。本次请求编号已保留，请不要重新填写成另一笔订单。`)
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  restorePending()
  await loadReferences()
})
</script>
