import { cloudbase } from './cloudbase'

export class ApiError extends Error {
  constructor(message, code = '', payload = null) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.payload = payload
  }
}

function normalizeResult(response) {
  let result = response && response.result !== undefined ? response.result : response
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { /* keep raw string */ }
  }
  return result || {}
}

export async function callManage(action, payload = {}) {
  const response = await cloudbase.callFunction({
    name: 'manageOrderWeb',
    data: { action, ...payload },
    parse: true
  })
  const result = normalizeResult(response)
  if (!result.success) {
    throw new ApiError(result.msg || '操作失败', result.code || '', result)
  }
  return result
}

export const api = {
  bindWebEmployee: phone => callManage('bindWebEmployee', { data: { phone } }),
  sessionUser: () => callManage('getSessionUser'),
  cities: () => callManage('getCities'),
  sources: () => callManage('getSources'),
  orders: () => callManage('getOrders'),
  orderDetail: orderId => callManage('getOrderDetail', { orderId }),
  createOrder: data => callManage('createOrder', { data }),
  workers: city => callManage('getWorkers', { data: { city } }),
  assignWorker: (orderId, expectedVersion, workerId) => callManage('updateOrder', {
    orderId,
    data: { expectedVersion, workerId }
  }),
  editTime: (orderId, expectedVersion, appointmentTime) => callManage('editTime', {
    orderId,
    data: { expectedVersion, appointmentTime }
  }),
  cancelOrder: (orderId, expectedVersion, cancelReason) => callManage('cancelOrder', {
    orderId,
    data: { expectedVersion, cancelReason }
  }),
  urgent: orderId => callManage('urgent', { orderId }),
  feedback: (orderId, expectedVersion, content, operationId) => callManage('feedback', {
    orderId,
    data: { expectedVersion, content, photos: [], operationId }
  })
}
