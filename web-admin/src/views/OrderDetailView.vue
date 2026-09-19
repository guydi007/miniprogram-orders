<template>
  <div v-loading="loading">
    <div class="detail-actions">
      <el-button @click="$router.push('/orders')">返回列表</el-button>
      <div v-if="order && !archived" class="action-group">
        <el-button v-if="canAssign" @click="openAssign">派单 / 改派</el-button>
        <el-button v-if="canEdit" @click="openTime">改期</el-button>
        <el-button v-if="canFeedback" @click="openFeedback">添加回馈</el-button>
        <el-button v-if="canUrgent" @click="urgent">催单</el-button>
        <el-button v-if="canCancel" type="danger" plain @click="openCancel">取消工单</el-button>
      </div>
    </div>

    <template v-if="order">
      <div class="detail-grid">
        <el-card shadow="never" class="detail-card main-info">
          <template #header><div class="detail-title"><strong>{{ order.customerPhone }}</strong><span :class="['status-pill', statusClass(order.status)]">{{ order.status }}</span></div></template>
          <div class="info-grid">
            <div><span>服务城市</span><strong>{{ order.city || '-' }}</strong></div>
            <div><span>订单来源</span><strong>{{ order.source || '-' }}</strong></div>
            <div class="wide"><span>服务地址</span><strong>{{ order.address || '-' }}</strong></div>
            <div class="wide"><span>预约上门时间</span><strong>{{ order.appointmentTime || '-' }}</strong></div>
            <div><span>主派师傅</span><strong>{{ order.workerName || '未指派' }}</strong></div>
            <div v-if="order.companionWorkers"><span>同行人员</span><strong>{{ order.companionWorkers }}</strong></div>
            <div><span>录单人</span><strong>{{ order.creatorName || '-' }}</strong></div>
            <div><span>录单时间</span><strong>{{ formatBusinessDateTime(order.createTime) }}</strong></div>
            <div v-if="order.finishTime"><span>{{ order.settleType === '预付款' ? '最新收款时间' : '结算时间' }}</span><strong>{{ formatBusinessDateTime(order.finishTime) }}</strong></div>
            <div><span>版本</span><strong>v{{ order.version || 0 }}</strong></div>
            <div v-if="order.cancelReason" class="wide danger-info"><span>退单取消</span><strong>{{ order.cancelReason }}{{ order.cancelOperator ? `（${order.cancelOperator}）` : '' }}</strong></div>
            <div v-if="order.failReason" class="wide danger-info"><span>现场未成</span><strong>{{ order.failReason }}{{ order.failOperator ? `（${order.failOperator}）` : '' }}</strong></div>
          </div>
        </el-card>

        <el-card shadow="never" class="detail-card">
          <template #header><strong>金额状态</strong></template>

          <div v-if="order.settleType === '预付款'" class="amount-status-block prepay">
            <div class="amount-main-label">工程总计</div>
            <div class="amount-main-value">¥{{ money(order.totalAmount) }}</div>
            <div class="amount-secondary-row">
              <span>已收定金合计</span>
              <strong>¥{{ money(order.depositAmount || order.finalAmount) }}</strong>
            </div>
            <div class="amount-secondary-row">
              <span>待收尾款</span>
              <strong>¥{{ money(order.remainingAmount) }}</strong>
            </div>
            <div v-if="hasPaymentChannels" class="channel-detail">
              渠道明细：微信 ¥{{ money(order.wechatAmount) }} ｜ 支付宝 ¥{{ money(order.alipayAmount) }} ｜ 现金 ¥{{ money(order.cashAmount) }}
            </div>
          </div>

          <div v-else-if="order.status === '已完工' && (Number(order.finalAmount || 0) || Number(order.totalAmount || 0))" class="amount-status-block">
            <div class="amount-main-label">实收合计金额</div>
            <div class="amount-main-value">¥{{ money(order.finalAmount) }}</div>
            <div v-if="hasPaymentChannels" class="channel-detail">
              渠道明细：微信 ¥{{ money(order.wechatAmount) }} ｜ 支付宝 ¥{{ money(order.alipayAmount) }} ｜ 现金 ¥{{ money(order.cashAmount) }}
            </div>
          </div>

          <el-empty v-else description="暂无金额记录" :image-size="72" />
        </el-card>
      </div>

      <el-card v-if="finishPhotos.length" shadow="never" class="detail-card timeline-card">
        <template #header><strong>最新完工凭据照片</strong></template>
        <div class="photo-grid-web">
          <div v-for="(fileRef, index) in finishPhotos" :key="`${fileRef}-${index}`" class="photo-item-web">
            <el-image
              class="detail-photo"
              :src="photoUrl(fileRef)"
              :preview-src-list="photoPreviewList(finishPhotos)"
              :initial-index="index"
              fit="cover"
              preview-teleported
              hide-on-click-modal
            >
              <template #error><div class="photo-error">图片读取失败</div></template>
            </el-image>
            <el-button link type="primary" :loading="downloadingPhoto === fileRef" @click="handleDownload(fileRef, index)">下载图片</el-button>
          </div>
        </div>
        <div v-if="order.finishNote" class="finish-note-web"><strong>施工说明：</strong>{{ order.finishNote }}</div>
      </el-card>

      <el-card shadow="never" class="detail-card timeline-card">
        <template #header><strong>回馈记录</strong></template>
        <el-empty v-if="!feedbacks.length" description="暂无回馈" />
        <el-timeline v-else>
          <el-timeline-item v-for="item in feedbacks" :key="item.id || item.time" :timestamp="formatBusinessDateTime(item.time)" placement="top">
            <div class="feedback-item">
              <strong>{{ item.operatorName || '员工' }}</strong>
              <span>{{ item.content }}</span>
              <div v-if="photoRefs(item.photos).length" class="photo-grid-web compact-photos">
                <div v-for="(fileRef, index) in photoRefs(item.photos)" :key="`${fileRef}-${index}`" class="photo-item-web">
                  <el-image
                    class="detail-photo compact"
                    :src="photoUrl(fileRef)"
                    :preview-src-list="photoPreviewList(item.photos)"
                    :initial-index="index"
                    fit="cover"
                    preview-teleported
                    hide-on-click-modal
                  >
                    <template #error><div class="photo-error">读取失败</div></template>
                  </el-image>
                  <el-button link type="primary" :loading="downloadingPhoto === fileRef" @click="handleDownload(fileRef, index)">下载</el-button>
                </div>
              </div>
            </div>
          </el-timeline-item>
        </el-timeline>
      </el-card>

      <el-card v-if="paymentLogs.length" shadow="never" class="detail-card timeline-card">
        <template #header><strong>支付与修改记录（{{ paymentLogs.length }}）</strong></template>
        <div class="payment-log-list">
          <div v-for="item in paymentLogs" :key="item.id || item.time" class="payment-log-item">
            <div class="payment-log-header">
              <div>
                <span class="payment-log-type">{{ item.settleType || '支付' }}记录</span>
                <strong>{{ item.operationLabel || '收款' }}</strong>
              </div>
              <div class="payment-log-meta">{{ formatBusinessDateTime(item.time) }} · {{ item.operatorName || '员工' }}（{{ roleLabel(item.operatorRole) }}）</div>
            </div>
            <div class="payment-log-body">
              <div class="payment-log-amount">
                <strong>{{ item.isCorrection ? '累计实收' : '本次收款' }} ¥{{ money(item.isCorrection ? item.paidAfter : item.amountThisTime) }}</strong>
                <span v-if="!item.isCorrection">（累计实收：¥{{ money(item.paidAfter) }}）</span>
              </div>
              <div>渠道累计：现金 {{ money(item.cashAmount) }} / 微信 {{ money(item.wechatAmount) }} / 支付宝 {{ money(item.alipayAmount) }}</div>
              <div v-if="item.settleType === '预付款'">工程总计：¥{{ money(item.totalAmount) }} / 待收尾款：¥{{ money(item.remainingAmount) }}</div>
              <div v-if="item.companionWorkers">同行人员：{{ item.companionWorkers }}</div>
              <div v-if="item.note">备注：{{ item.note }}</div>
            </div>
            <div v-if="photoRefs(item.photos).length" class="photo-grid-web compact-photos payment-photos">
              <div v-for="(fileRef, index) in photoRefs(item.photos)" :key="`${fileRef}-${index}`" class="photo-item-web">
                <el-image
                  class="detail-photo compact"
                  :src="photoUrl(fileRef)"
                  :preview-src-list="photoPreviewList(item.photos)"
                  :initial-index="index"
                  fit="cover"
                  preview-teleported
                  hide-on-click-modal
                >
                  <template #error><div class="photo-error">读取失败</div></template>
                </el-image>
                <el-button link type="primary" :loading="downloadingPhoto === fileRef" @click="handleDownload(fileRef, index)">下载</el-button>
              </div>
            </div>
          </div>
        </div>
      </el-card>
    </template>

    <el-dialog v-model="assignVisible" title="派单 / 改派" width="480px">
      <el-select v-model="assignWorkerId" filterable placeholder="请选择师傅" style="width:100%" :loading="workersLoading">
        <el-option v-for="worker in workers" :key="worker._id" :label="`${worker.name} · ${worker.phone}`" :value="worker._id" />
      </el-select>
      <template #footer><el-button @click="assignVisible=false">取消</el-button><el-button type="primary" @click="assign">确认派单</el-button></template>
    </el-dialog>

    <el-dialog v-model="timeVisible" title="修改预约时间" width="560px">
      <el-input v-model="newTime" placeholder="例如：9月10日上门1点-2点之间" />
      <div class="quick-time-grid compact">
        <button v-for="item in quickTimes" :key="item.label" type="button" class="quick-time-button" @click="newTime = quickAppointment(item.day, item.period)">{{ item.label }}</button>
      </div>
      <template #footer><el-button @click="timeVisible=false">取消</el-button><el-button type="primary" @click="saveTime">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="feedbackVisible" title="添加回馈" width="560px">
      <el-input v-model="feedbackText" type="textarea" :rows="5" maxlength="2000" show-word-limit placeholder="请输入本次回馈说明" />
      <template #footer><el-button @click="feedbackVisible=false">取消</el-button><el-button type="primary" @click="saveFeedback">保存回馈</el-button></template>
    </el-dialog>

    <el-dialog v-model="cancelVisible" title="取消工单" width="520px">
      <el-alert title="取消后订单将归档为未成单" type="warning" :closable="false" show-icon />
      <el-input v-model="cancelReason" class="dialog-textarea" type="textarea" :rows="4" maxlength="500" show-word-limit placeholder="请填写取消原因" />
      <template #footer><el-button @click="cancelVisible=false">返回</el-button><el-button type="danger" @click="cancelOrder">确认取消</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../services/api'
import { session } from '../stores/session'
import { formatBusinessDateTime, quickAppointment } from '../services/business-time'
import { downloadPhoto, photoFilename, resolvePhotoUrl } from '../services/storage'

const route = useRoute()
const loading = ref(false)
const order = ref(null)
const workers = ref([])
const workersLoading = ref(false)
const assignVisible = ref(false)
const assignWorkerId = ref('')
const timeVisible = ref(false)
const newTime = ref('')
const feedbackVisible = ref(false)
const feedbackText = ref('')
const feedbackOperationId = ref('')
const cancelVisible = ref(false)
const cancelReason = ref('')
const photoUrls = reactive({})
const downloadingPhoto = ref('')

const role = computed(() => session.state.user?.role)
const archived = computed(() => ['已完工', '未成单'].includes(order.value?.status))
const canAssign = computed(() => role.value === 'leader')
const canEdit = computed(() => ['service', 'leader'].includes(role.value))
const canFeedback = computed(() => ['service', 'leader'].includes(role.value))
const canUrgent = computed(() => ['service', 'leader'].includes(role.value))
const canCancel = computed(() => role.value === 'service')
const feedbacks = computed(() => Array.isArray(order.value?.feedbacks) ? order.value.feedbacks : [])
const finishPhotos = computed(() => photoRefs(order.value?.finishPhotos))
const paymentLogs = computed(() => Array.isArray(order.value?.paymentLogs) ? order.value.paymentLogs : [])
const hasPaymentChannels = computed(() => Boolean(Number(order.value?.wechatAmount || 0) || Number(order.value?.alipayAmount || 0) || Number(order.value?.cashAmount || 0)))
const quickTimes = [
  { label: '今天早上', day: 0, period: '早上' }, { label: '今天上午', day: 0, period: '上午' },
  { label: '今天下午', day: 0, period: '下午' }, { label: '今天晚上', day: 0, period: '晚上' },
  { label: '明天早上', day: 1, period: '早上' }, { label: '明天上午', day: 1, period: '上午' },
  { label: '明天下午', day: 1, period: '下午' }, { label: '明天晚上', day: 1, period: '晚上' }
]

function money(value) { return Number(value || 0).toFixed(2) }
function statusClass(value) { return ({ '待派单': 'pending', '已派单': 'assigned', '已完工': 'done', '未成单': 'failed' })[value] || '' }
function roleLabel(value) { return ({ worker: '师傅', leader: '主管', service: '客服', admin: '管理' })[value] || '员工' }
function photoRefs(value) { return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [] }
function photoUrl(fileRef) { return photoUrls[fileRef] || '' }
function photoPreviewList(value) { return photoRefs(value).map(photoUrl).filter(Boolean) }

function collectOrderPhotos(current) {
  const refs = new Set(photoRefs(current?.finishPhotos))
  const feedbackList = Array.isArray(current?.feedbacks) ? current.feedbacks : []
  const paymentList = Array.isArray(current?.paymentLogs) ? current.paymentLogs : []
  feedbackList.forEach(item => photoRefs(item?.photos).forEach(ref => refs.add(ref)))
  paymentList.forEach(item => photoRefs(item?.photos).forEach(ref => refs.add(ref)))
  return [...refs]
}

async function resolveOrderPhotos(current) {
  const refs = collectOrderPhotos(current)
  await Promise.all(refs.map(async fileRef => {
    if (photoUrls[fileRef]) return
    try {
      photoUrls[fileRef] = await resolvePhotoUrl(fileRef)
    } catch (error) {
      console.warn('图片地址解析失败：', fileRef, error)
      photoUrls[fileRef] = ''
    }
  }))
}

async function handleDownload(fileRef, index) {
  if (downloadingPhoto.value) return
  downloadingPhoto.value = fileRef
  try {
    await downloadPhoto(fileRef, photoFilename(fileRef, index + 1))
  } catch (error) {
    ElMessage.error(error.message || '图片下载失败')
  } finally {
    downloadingPhoto.value = ''
  }
}

function conflict(error) {
  if (error.code === 'ORDER_VERSION_CONFLICT') {
    ElMessage.warning('订单已被其他人修改，已刷新最新数据')
    load()
    return true
  }
  return false
}

async function load() {
  loading.value = true
  try {
    const result = await api.orderDetail(String(route.params.id))
    order.value = result.order
    await resolveOrderPhotos(order.value)
  } catch (error) {
    ElMessage.error(error.message || '工单加载失败')
  } finally { loading.value = false }
}

async function openAssign() {
  assignVisible.value = true
  workersLoading.value = true
  try {
    const result = await api.workers(order.value.city)
    workers.value = result.workers || []
    assignWorkerId.value = order.value.workerId || ''
  } catch (error) { ElMessage.error(error.message || '师傅列表加载失败') }
  finally { workersLoading.value = false }
}
async function assign() {
  if (!assignWorkerId.value) return ElMessage.warning('请选择师傅')
  try {
    await api.assignWorker(order.value._id, order.value.version || 0, assignWorkerId.value)
    ElMessage.success('派单成功')
    assignVisible.value = false
    await load()
  } catch (error) { if (!conflict(error)) ElMessage.error(error.message || '派单失败') }
}

function openTime() { newTime.value = order.value.appointmentTime || ''; timeVisible.value = true }
async function saveTime() {
  if (!newTime.value.trim()) return ElMessage.warning('请输入预约时间')
  try {
    await api.editTime(order.value._id, order.value.version || 0, newTime.value.trim())
    ElMessage.success('改期成功')
    timeVisible.value = false
    await load()
  } catch (error) { if (!conflict(error)) ElMessage.error(error.message || '改期失败') }
}

function openFeedback() {
  feedbackText.value = ''
  feedbackOperationId.value = `fbop_web_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  feedbackVisible.value = true
}
async function saveFeedback() {
  if (!feedbackText.value.trim()) return ElMessage.warning('请输入回馈说明')
  try {
    await api.feedback(order.value._id, order.value.version || 0, feedbackText.value.trim(), feedbackOperationId.value)
    ElMessage.success('回馈已保存')
    feedbackVisible.value = false
    await load()
  } catch (error) { if (!conflict(error)) ElMessage.error(error.message || '回馈保存失败') }
}

async function urgent() {
  try {
    await ElMessageBox.confirm('确认将该工单标记为紧急催单？', '催单确认')
    await api.urgent(order.value._id)
    ElMessage.success('已标记紧急催单')
    await load()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error.message || '催单失败')
  }
}

function openCancel() { cancelReason.value = ''; cancelVisible.value = true }
async function cancelOrder() {
  if (!cancelReason.value.trim()) return ElMessage.warning('请填写取消原因')
  try {
    await api.cancelOrder(order.value._id, order.value.version || 0, cancelReason.value.trim())
    ElMessage.success('工单已取消')
    cancelVisible.value = false
    await load()
  } catch (error) { if (!conflict(error)) ElMessage.error(error.message || '取消失败') }
}

onMounted(load)
</script>
