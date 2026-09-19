const app = getApp();

const BUSINESS_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatDateTime(dateVal) {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);
  // 所有业务时间固定按北京时间（UTC+8）展示，不跟随手机所在时区变化。
  const shifted = new Date(d.getTime() + BUSINESS_TZ_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

function businessDateString(offsetDays = 0) {
  const shifted = new Date(Date.now() + BUSINESS_TZ_OFFSET_MS + offsetDays * 86400000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateSmart(text) {
  if (!text) return '';
  let str = String(text).trim();
  const today = businessDateString(0);
  const tomorrow = businessDateString(1);
  str = str.replace(/(今天|当天|今日)\s*/g, `${today} `);
  str = str.replace(/(明天|次日)\s*/g, `${tomorrow} `);
  return str.replace(/\s+/g, ' ').trim();
}

Page({
  data: {
    orderId: '',
    order: null,
    currentUser: null,

    isLeader: false,
    isServiceOrLeader: false,
    isWorkerOrLeader: false,
    canOperateSettle: false,
    canEditAppointment: false,

    candidateWorkers: [],
    candidateWorkerNames: [],

    showEditTimeModal: false,
    editTimeInput: '',

    showCancelModal: false,
    cancelReason: '',

    showFailModal: false,
    failReason: '',

    showFinishModal: false,
    settleMode: 'full',
    initialSnapshot: null,

    inputCash: '',
    inputWechat: '',
    inputAlipay: '',
    inputTotalAmount: '',

    fullTotal: 0,
    depositTotal: 0,
    remainTotal: 0,
    existingPrepayPaid: 0,
    existingPrepayChannels: { cash: 0, wechat: 0, alipay: 0 },
    prepayAdjustmentMode: 'add', // add=追加收款；correct=修正累计金额/支付渠道

    modalCompanions: '',
    modalNote: '',
    correctionReason: '',
    localPhotos: [],
    pendingPaymentCloudIds: [],
    paymentRetryLocked: false,

    showFeedbackModal: false,
    feedbackContent: '',
    feedbackPhotos: []
  },

  updatePermissions(order, user) {
    const role = user ? user.role : '';
    const isLeader = role === 'leader';
    const isServiceOrLeader = role === 'admin' || role === 'service' || role === 'leader';
    const isWorkerOrLeader = role === 'worker' || role === 'leader';
    const isAssignedWorker = Boolean(role === 'worker' && order && user && (
      order.workerId ? String(order.workerId) === String(user._id) : (user.phone && order.workerPhone === user.phone)
    ));
    const canOperateSettle = isLeader || isAssignedWorker;
    const canEditAppointment = Boolean(order && !['已完工', '未成单'].includes(order.status) &&
      (role === 'service' || isLeader || isAssignedWorker));

    this.setData({
      currentUser: user,
      isLeader,
      isServiceOrLeader,
      isWorkerOrLeader,
      canOperateSettle,
      canEditAppointment
    });
  },

  onLoad(options) {
    const user = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    this.updatePermissions(null, user);

    if (options && options.id) {
      this.setData({ orderId: options.id });
    }
  },

  onShow() {
    const user = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    this.updatePermissions(this.data.order, user);
    if (this.data.orderId) this.fetchOrderDetail(this.data.orderId);
  },

  onUnload() {
    this._detailUnloaded = true;
    this._refreshDetailAfterLoad = false;
    if (this._detailPromise || this._openingOrderLocation) wx.hideLoading();
  },

  fetchOrderDetail(id) {
    if (this._detailUnloaded || !id) return Promise.resolve();
    if (this._detailPromise) {
      this._refreshDetailAfterLoad = true;
      return this._detailPromise;
    }
    wx.showLoading({ title: '加载中...' });
    this._detailPromise = wx.cloud.callFunction({
      name: 'manageOrder',
      data: { action: 'getOrderDetail', orderId: id }
    }).then(res => {
      if (this._detailUnloaded) return;
      wx.hideLoading();
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || 'ORDER_ACCESS_DENIED');
      const order = result.order;
      if (!order) throw new Error('ORDER_NOT_FOUND');

      if (order.finishTime) {
        order.finishTimeFormatted = formatDateTime(order.finishTime);
      }
      if (order.cancelTime) {
        order.cancelTimeFormatted = formatDateTime(order.cancelTime);
      }
      if (order.failTime) {
        order.failTimeFormatted = formatDateTime(order.failTime);
      }
      if (Array.isArray(order.paymentLogs)) {
        order.paymentLogs = order.paymentLogs.map(item => {
          const paidAfter = Number(item.paidAfter !== undefined ? item.paidAfter : item.currentPaid || 0);
          const amountThisTime = Number(item.amountThisTime !== undefined ? item.amountThisTime : item.currentPaid || 0);
          const operationType = String(item.operationType || '');
          const isLegacyCorrection = !operationType && item.amountThisTime !== undefined && Number(item.amountThisTime || 0) === 0 && item.paidBefore !== undefined && item.paidAfter !== undefined;
          const isCorrection = operationType === 'amount_correction' || isLegacyCorrection;
          return {
            ...item,
            paidAfter,
            amountThisTime,
            isCorrection,
            operationLabel: isCorrection ? '金额/渠道修正' : (operationType === 'deposit_payment' ? '首次预付' : (operationType === 'additional_payment' ? '追加收款' : (operationType === 'final_payment' ? '尾款结清' : (operationType === 'full_payment' ? '全款收款' : '支付记录')))),
            timeFormatted: formatDateTime(item.time)
          };
        });
      }
      if (Array.isArray(order.feedbacks)) {
        order.feedbacks = order.feedbacks.map(item => ({
          ...item,
          timeFormatted: formatDateTime(item.time)
        }));
      }
      if (Array.isArray(order.appointmentLogs)) {
        order.appointmentLogs = order.appointmentLogs.map(item => ({
          ...item,
          timeFormatted: formatDateTime(item.time)
        }));
      }

      this.setData({ order: order });
      this.updatePermissions(order, this.data.currentUser);

      const user = this.data.currentUser;
      if (user && user.role === 'leader') {
        this.fetchCandidateWorkers(order.city);
      }
    }).catch(err => {
      if (this._detailUnloaded) return;
      wx.hideLoading();
      console.error(err);
      wx.showToast({ title: '加载工单失败', icon: 'none' });
    }).finally(() => {
      this._detailPromise = null;
      if (this._refreshDetailAfterLoad && !this._detailUnloaded) {
        this._refreshDetailAfterLoad = false;
        this.fetchOrderDetail(this.data.orderId);
      }
    });
    return this._detailPromise;
  },

  async handleOrderMutationFailure(result, fallbackMessage) {
    const payload = result || {};
    const refreshCodes = new Set([
      'ORDER_VERSION_CONFLICT',
      'INVALID_ORDER_VERSION',
      'ORDER_STATE_CHANGED',
      'ORDER_ARCHIVED'
    ]);

    if (refreshCodes.has(payload.code)) {
      await new Promise(resolve => wx.showModal({
        title: '工单状态已更新',
        content: payload.msg || '该工单已被其他操作更新，请刷新后重试。',
        showCancel: false,
        success: () => resolve(),
        fail: () => resolve()
      }));
      await this.fetchOrderDetail(this.data.orderId);
      return true;
    }

    wx.showToast({ title: payload.msg || fallbackMessage || '操作失败，请重试', icon: 'none' });
    return false;
  },

  paymentPendingStorageKey() {
    return `pendingPayment:${this.data.orderId || ''}`;
  },

  buildPaymentPendingSnapshot(operationId, cloudFileIDs) {
    const keys = [
      'settleMode', 'prepayAdjustmentMode', 'inputCash', 'inputWechat', 'inputAlipay', 'inputTotalAmount',
      'modalCompanions', 'modalNote', 'correctionReason', 'existingPrepayPaid', 'existingPrepayChannels',
      'initialSnapshot', 'fullTotal', 'depositTotal', 'remainTotal'
    ];
    const form = {};
    keys.forEach(key => { form[key] = this.data[key]; });
    return {
      orderId: this.data.orderId,
      operationId,
      cloudFileIDs: Array.isArray(cloudFileIDs) ? [...new Set(cloudFileIDs.filter(Boolean))] : [],
      form,
      savedAt: Date.now()
    };
  },

  savePendingPaymentOperation(operationId, cloudFileIDs) {
    if (!operationId || !this.data.orderId) return;
    const payload = this.buildPaymentPendingSnapshot(operationId, cloudFileIDs);
    wx.setStorageSync(this.paymentPendingStorageKey(), payload);
    this._paymentOperationId = operationId;
    this._paymentUploadedCloudIds = payload.cloudFileIDs;
    this._paymentOutcomeUnknown = true;
  },

  clearPendingPaymentOperation() {
    try { wx.removeStorageSync(this.paymentPendingStorageKey()); } catch (e) { /* ignore */ }
    this._paymentOperationId = null;
    this._paymentUploadedCloudIds = [];
    this._paymentOutcomeUnknown = false;
    this.setData({ pendingPaymentCloudIds: [], paymentRetryLocked: false });
  },

  async getPaymentOperationStatus(operationId) {
    const res = await wx.cloud.callFunction({
      name: 'manageOrder',
      data: {
        action: 'getPaymentOperationStatus',
        orderId: this.data.orderId,
        data: { operationId }
      }
    });
    const result = res.result || {};
    if (!result.success) throw new Error(result.msg || 'PAYMENT_STATUS_CHECK_FAILED');
    return result;
  },

  async restorePendingPaymentIfNeeded() {
    const pending = wx.getStorageSync(this.paymentPendingStorageKey());
    if (!pending || String(pending.orderId || '') !== String(this.data.orderId || '') || !pending.operationId) return false;
    wx.showLoading({ title: '核对上次付款...' });
    try {
      const status = await this.getPaymentOperationStatus(pending.operationId);
      wx.hideLoading();
      if (status.committed) {
        if (Array.isArray(pending.cloudFileIDs) && pending.cloudFileIDs.length) await this.confirmUploadedFiles(pending.cloudFileIDs);
        this.clearPendingPaymentOperation();
        await this.fetchOrderDetail(this.data.orderId);
        wx.showToast({ title: '上次付款已确认入账', icon: 'success' });
        return true;
      }

      this._paymentOperationId = pending.operationId;
      this._paymentUploadedCloudIds = Array.isArray(pending.cloudFileIDs) ? pending.cloudFileIDs : [];
      this._paymentOutcomeUnknown = true;
      this.setData({
        ...(pending.form || {}),
        showFinishModal: true,
        localPhotos: [],
        pendingPaymentCloudIds: this._paymentUploadedCloudIds,
        paymentRetryLocked: true
      }, () => this.recalcAmounts());
      wx.showModal({
        title: '继续上次付款',
        content: '上次付款结果未确认。本次会复用原流水号重试，不会创建新的付款流水。',
        showCancel: false
      });
      return true;
    } catch (error) {
      wx.hideLoading();
      console.warn('核对上次付款失败：', error);
      wx.showToast({ title: '暂时无法核对上次付款，请稍后重试', icon: 'none' });
      return true;
    }
  },

  async trackUploadedFile(fileID, orderId, operationId, kind) {
    if (!fileID) throw new Error('UPLOAD_FILE_ID_MISSING');
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'trackUploadedFiles',
          data: { orderId, operationId, kind, fileIDs: [fileID] }
        }
      });
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || 'UPLOAD_TRACK_FAILED');
      return true;
    } catch (error) {
      // 登记失败时文件尚未进入业务提交，可立即删除，避免产生无法追踪的孤儿文件。
      try { await wx.cloud.deleteFile({ fileList: [fileID] }); } catch (deleteError) { console.warn('登记失败后的文件删除失败：', deleteError); }
      throw error;
    }
  },

  async confirmUploadedFiles(fileIDs) {
    const fileList = Array.isArray(fileIDs) ? fileIDs.filter(Boolean) : [];
    if (!fileList.length) return;
    try {
      await wx.cloud.callFunction({
        name: 'manageOrder',
        data: { action: 'confirmUploadedFiles', data: { fileIDs: fileList } }
      });
    } catch (error) {
      // 确认失败不影响业务；72小时清理任务会先检查数据库引用，已引用文件不会被删除。
      console.warn('确认云文件引用失败，将由72小时清理任务复核：', error);
    }
  },

  async cleanupUploadedFiles(fileIDs) {
    const fileList = Array.isArray(fileIDs) ? fileIDs.filter(Boolean) : [];
    if (!fileList.length) return;
    let deleted = false;
    try {
      await wx.cloud.deleteFile({ fileList });
      deleted = true;
    } catch (error) {
      // 删除失败不能影响主业务；登记记录保留，超过72小时后由云端清理任务再次尝试。
      console.warn('清理未引用云文件失败：', error);
    }
    if (deleted) {
      try {
        await wx.cloud.callFunction({
          name: 'manageOrder',
          data: { action: 'untrackUploadedFiles', data: { fileIDs: fileList } }
        });
      } catch (error) {
        // 文件已经删除，即使登记记录暂时保留，定时任务也会在后续清掉记录。
        console.warn('移除云文件登记失败：', error);
      }
    }
  },

  fetchCandidateWorkers(city) {
    wx.cloud.callFunction({
      name: 'manageOrder',
      data: { action: 'getWorkers', data: { city } }
    }).then(res => {
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || 'WORKERS_UNAVAILABLE');
      const matched = result.workers || [];
      this.setData({
        candidateWorkers: matched,
        candidateWorkerNames: matched.map(w => w.name + (w.role === 'leader' ? ' [主管]' : ''))
      });
    }).catch(e => console.error('获取师傅列表失败：', e));
  },

  async onAssignWorker(e) {
    if (!this.data.isLeader) {
      return wx.showToast({ title: '仅限主管指派师傅', icon: 'none' });
    }

    const idx = Number(e.detail.value);
    const worker = this.data.candidateWorkers[idx];
    if (!worker) {
      return wx.showToast({ title: '请选择有效师傅', icon: 'none' });
    }

    wx.showLoading({ title: '正在指派师傅...', mask: true });
    const updateData = {
      workerId: worker._id || '',
      workerName: worker.name,
      workerPhone: worker.phone || '',
      workerGroupId: '',
      status: '已派单'
    };

    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'updateOrder',
          orderId: this.data.orderId,
          expectedVersion: Number(this.data.order && this.data.order.version || 0),
          data: updateData
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        wx.showToast({ title: '指派成功', icon: 'success' });
        await this.fetchOrderDetail(this.data.orderId);
      } else {
        const handled = await this.handleOrderMutationFailure(result, '指派未成功');
        if (!handled) {
          const errMsg = result.error ? (result.error.errMsg || JSON.stringify(result.error)) : (result.msg || '更新未生效');
          wx.showModal({
            title: '指派未成功',
            content: `云端返回：${errMsg}`,
            showCancel: false
          });
        }
      }
    } catch (err) {
      wx.hideLoading();
      console.error('指派异常：', err);
      wx.showModal({
        title: '调用失败',
        content: `异常信息：${err.message || err.errMsg || '网络请求超时'}`,
        showCancel: false
      });
    }
  },

  callCustomer() {
    if (this.data.order && this.data.order.customerPhone) {
      wx.makePhoneCall({ phoneNumber: this.data.order.customerPhone });
    }
  },

  showMapFallback(message) {
    if (this._detailUnloaded) return Promise.resolve();
    return new Promise(resolve => wx.showModal({
      title: '暂时无法打开地图',
      content: message || '请核对详细地址，或复制地址到地图 App 中搜索。',
      confirmText: '复制地址', cancelText: '取消',
      success: res => {
        if (res.confirm && this.data.order) {
          const order = this.data.order;
          const address = typeof order.address === 'string' ? order.address.trim() : '';
          const city = typeof order.city === 'string' ? order.city.trim() : '';
          if (address) wx.setClipboardData({ data: address.includes(city) ? address : city + address });
        }
        resolve();
      },
      fail: () => resolve()
    }));
  },

  async openOrderLocation() {
    if (this._openingOrderLocation || this._detailUnloaded) return;
    const order = this.data.order;
    if (!order || !this.data.orderId || typeof order.address !== 'string' || !order.address.trim()) {
      return wx.showToast({ title: '暂无有效服务地址', icon: 'none' });
    }
    if (!wx.openLocation) return this.showMapFallback('当前微信版本不支持打开地图，请升级微信或复制地址自行搜索。');
    this._openingOrderLocation = true;
    wx.showLoading({ title: '查询服务地点...', mask: true });
    let loading = true;
    try {
      const res = await wx.cloud.callFunction({ name: 'manageOrder', data: {
        action: 'getOrderLocation', orderId: this.data.orderId
      } });
      loading = false;
      if (this._detailUnloaded) return;
      wx.hideLoading();
      const result = res.result || {};
      if (!result.success) {
        if (result.code === 'UNAUTHORIZED') return wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' });
        return await this.showMapFallback(result.msg);
      }
      const point = result.location || {};
      if (point.coordinateSystem !== 'gcj02' || typeof point.latitude !== 'number' || typeof point.longitude !== 'number' ||
          !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
          Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180 || (point.latitude === 0 && point.longitude === 0)) {
        return await this.showMapFallback('地图坐标无效，请复制地址自行搜索。');
      }
      const confirmed = await new Promise(resolve => wx.showModal({
        title: '核对地图地点',
        content: `工单地址：${point.city || ''} ${point.address || ''}\n地图匹配：${point.resolvedAddress || point.name || ''}\n文字地址可能有偏差，打开后请核对地图标记，确认无误再导航。`,
        confirmText: '查看地图', cancelText: '取消',
        success: value => resolve(value.confirm), fail: () => resolve(false)
      }));
      if (!confirmed || this._detailUnloaded) return;
      await new Promise(resolve => wx.openLocation({
        latitude: point.latitude, longitude: point.longitude, scale: 18,
        name: point.name, address: `${point.city || ''} ${point.address || ''}`.trim(),
        success: () => resolve(),
        fail: () => { this.showMapFallback('微信未能打开地图，请重试或复制地址自行搜索。').then(resolve); }
      }));
    } catch (error) {
      if (loading) { if (!this._detailUnloaded) wx.hideLoading(); loading = false; }
      await this.showMapFallback('查询地图失败，请确认网络，或复制地址自行搜索。');
    } finally {
      if (loading && !this._detailUnloaded) wx.hideLoading();
      this._openingOrderLocation = false;
    }
  },

  async triggerUrgent() {
    if (this._urgentSubmitting) return;
    this._urgentSubmitting = true;
    wx.showLoading({ title: '提交催单...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'urgent',
          orderId: this.data.orderId,
          expectedVersion: Number(this.data.order && this.data.order.version || 0),
          data: { isUrgent: true }
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        wx.showToast({ title: '已标记紧急催单', icon: 'none' });
        await this.fetchOrderDetail(this.data.orderId);
      } else {
        await this.handleOrderMutationFailure(result, '催单失败');
      }
    } catch (e) {
      wx.hideLoading();
      console.error(e);
      wx.showToast({ title: '网络异常', icon: 'none' });
    } finally {
      this._urgentSubmitting = false;
    }
  },

  openEditTimeModal() {
    if (!this.data.canEditAppointment) return wx.showToast({ title: '当前工单不可改期', icon: 'none' });
    this.setData({
      showEditTimeModal: true,
      editTimeInput: this.data.order.appointmentTime || ''
    });
  },

  closeEditTimeModal() {
    this.setData({ showEditTimeModal: false });
  },

  onEditTimeInput(e) {
    this.setData({ editTimeInput: e.detail.value });
  },

  onEditTimeBlur(e) {
    const formatted = parseDateSmart(e.detail.value);
    this.setData({ editTimeInput: formatted });
  },

  onQuickEditTime(e) {
    const raw = e.currentTarget.dataset.val;
    const formatted = parseDateSmart(raw);
    this.setData({ editTimeInput: formatted });
  },

  async submitEditTime() {
    if (!this.data.canEditAppointment) return wx.showToast({ title: '当前工单不可改期', icon: 'none' });
    const order = this.data.order || {};
    const newTime = parseDateSmart(this.data.editTimeInput);
    const oldTime = order.appointmentTime || '';

    if (!newTime) {
      return wx.showToast({ title: '请输入预约时间', icon: 'none' });
    }

    if (newTime === oldTime) {
      this.setData({ showEditTimeModal: false });
      return wx.showToast({ title: '时间未做修改', icon: 'none' });
    }

    wx.showLoading({ title: '正在保存改期...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'editTime',
          orderId: this.data.orderId,
          expectedVersion: Number(order.version || 0),
          // 历史 appointmentLogs / feedbacks 由云端事务读取最新订单后追加。
          data: { appointmentTime: newTime }
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        this.setData({ showEditTimeModal: false });
        wx.showToast({ title: '改期成功！', icon: 'success' });
        await this.fetchOrderDetail(this.data.orderId);
      } else {
        await this.handleOrderMutationFailure(result, '改期失败，请重试');
      }
    } catch (err) {
      wx.hideLoading();
      console.error(err);
      wx.showToast({ title: '改期失败，请重试', icon: 'none' });
    }
  },

  openCancelModal() {
    this.setData({
      showCancelModal: true,
      cancelReason: ''
    });
  },

  closeCancelModal() {
    this.setData({ showCancelModal: false });
  },

  onCancelReasonInput(e) {
    this.setData({ cancelReason: e.detail.value.trim() });
  },

  // 客服取消订单：打上 service_cancel 标识
  async submitCancelOrder() {
    const reason = this.data.cancelReason;
    const order = this.data.order || {};
    if (!reason) {
      return wx.showToast({ title: '请填写取消原因', icon: 'none' });
    }

    wx.showLoading({ title: '正在取消工单...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'cancelOrder',
          orderId: this.data.orderId,
          expectedVersion: Number(order.version || 0),
          // 状态、取消时间、操作人和 feedback 由云端事务生成，客户端只提交原因。
          data: { cancelReason: reason }
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        this.setData({ showCancelModal: false });
        wx.showToast({
          title: result.notification && !result.notification.success ? '退单已保存，群通知待处理' : '工单已退单归档',
          icon: 'success'
        });
        await this.fetchOrderDetail(this.data.orderId);
      } else {
        await this.handleOrderMutationFailure(result, '取消失败，请重试');
      }
    } catch (err) {
      wx.hideLoading();
      console.error(err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  openFailModal() {
    this.setData({
      showFailModal: true,
      failReason: ''
    });
  },

  closeFailModal() {
    this.setData({ showFailModal: false });
  },

  onFailReasonInput(e) {
    this.setData({ failReason: e.detail.value.trim() });
  },

  // 师傅/主管现场未成单：由云端校验身份并生成归档留痕。
  async submitFailOrder() {
    const reason = this.data.failReason;
    if (!reason) {
      return wx.showToast({ title: '请填写未成单原因', icon: 'none' });
    }

    wx.showLoading({ title: '正在归档未成单...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'failOrder',
          orderId: this.data.orderId,
          expectedVersion: Number(this.data.order && this.data.order.version || 0),
          data: { failReason: reason }
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        this.setData({ showFailModal: false });
        wx.showToast({
          title: result.notification && !result.notification.success ? '未成单已保存，群通知待处理' : '已归入未成单',
          icon: 'success'
        });
        await this.fetchOrderDetail(this.data.orderId);
      } else {
        await this.handleOrderMutationFailure(result, '操作失败，请重试');
      }
    } catch (err) {
      wx.hideLoading();
      console.error(err);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }
  },

  recalcAmounts() {
    const cash = Number(this.data.inputCash) || 0;
    const wechat = Number(this.data.inputWechat) || 0;
    const alipay = Number(this.data.inputAlipay) || 0;
    const total = Number(this.data.inputTotalAmount) || 0;

    const isPrepayAdd = this.data.settleMode === 'prepay' && this.data.prepayAdjustmentMode === 'add';
    const existing = isPrepayAdd ? Number(this.data.existingPrepayPaid || 0) : 0;
    const sum = Number((cash + wechat + alipay + existing).toFixed(2));
    const remain = Math.max(0, Number((total - sum).toFixed(2)));

    this.setData({
      fullTotal: sum,
      depositTotal: sum,
      remainTotal: remain
    });
  },

  onCashInput(e) {
    this.setData({ inputCash: e.detail.value.trim() }, () => this.recalcAmounts());
  },

  onWechatInput(e) {
    this.setData({ inputWechat: e.detail.value.trim() }, () => this.recalcAmounts());
  },

  onAlipayInput(e) {
    this.setData({ inputAlipay: e.detail.value.trim() }, () => this.recalcAmounts());
  },

  onTotalAmountInput(e) {
    this.setData({ inputTotalAmount: e.detail.value.trim() }, () => this.recalcAmounts());
  },

  onModalCompanionsInput(e) {
    this.setData({ modalCompanions: e.detail.value.trim() });
  },

  onModalNoteInput(e) {
    this.setData({ modalNote: e.detail.value.trim() });
  },

  onCorrectionReasonInput(e) {
    this.setData({ correctionReason: e.detail.value.trim() });
  },

  async openFinishModal() {
    if (await this.restorePendingPaymentIfNeeded()) return;
    this.clearPendingPaymentOperation();
    const o = this.data.order || {};
    const cash = o.cashAmount ? String(o.cashAmount) : '';
    const wechat = o.wechatAmount ? String(o.wechatAmount) : (o.finalAmount && !o.cashAmount && !o.alipayAmount ? String(o.finalAmount) : '');
    const alipay = o.alipayAmount ? String(o.alipayAmount) : '';
    const companions = o.companionWorkers || '';

    this.setData({
      showFinishModal: true,
      settleMode: 'full',
      existingPrepayPaid: 0,
      existingPrepayChannels: { cash: 0, wechat: 0, alipay: 0 },
      prepayAdjustmentMode: 'add',
      inputCash: cash,
      inputWechat: wechat,
      inputAlipay: alipay,
      modalCompanions: companions,
      modalNote: '',
      correctionReason: '',
      localPhotos: [],
      pendingPaymentCloudIds: [],
      paymentRetryLocked: false,
      initialSnapshot: {
        cash: cash,
        wechat: wechat,
        alipay: alipay,
        totalAmount: '',
        companions: companions,
        note: ''
      }
    }, () => this.recalcAmounts());
  },

  async openPrepayModal() {
    if (await this.restorePendingPaymentIfNeeded()) return;
    this.clearPendingPaymentOperation();
    const o = this.data.order || {};
    const hasExisting = o.settleType === '预付款';
    const existingPaid = hasExisting ? Number(o.depositAmount || o.finalAmount || 0) : 0;
    const existingChannels = hasExisting ? {
      cash: Number(o.cashAmount || 0),
      wechat: Number(o.wechatAmount || 0),
      alipay: Number(o.alipayAmount || 0)
    } : { cash: 0, wechat: 0, alipay: 0 };
    const mode = hasExisting && Number(o.remainingAmount || 0) <= 0 ? 'correct' : 'add';
    const cash = mode === 'correct' && existingChannels.cash ? String(existingChannels.cash) : '';
    const wechat = mode === 'correct' && existingChannels.wechat ? String(existingChannels.wechat) : '';
    const alipay = mode === 'correct' && existingChannels.alipay ? String(existingChannels.alipay) : '';
    const total = o.totalAmount ? String(o.totalAmount) : '';
    const companions = o.companionWorkers || '';

    this.setData({
      showFinishModal: true,
      settleMode: 'prepay',
      prepayAdjustmentMode: mode,
      existingPrepayPaid: existingPaid,
      existingPrepayChannels: existingChannels,
      inputCash: cash,
      inputWechat: wechat,
      inputAlipay: alipay,
      inputTotalAmount: total,
      modalCompanions: companions,
      modalNote: '',
      correctionReason: '',
      localPhotos: [],
      pendingPaymentCloudIds: [],
      paymentRetryLocked: false,
      initialSnapshot: {
        cash,
        wechat,
        alipay,
        totalAmount: total,
        companions,
        note: ''
      }
    }, () => this.recalcAmounts());
  },

  switchPrepayAdjustmentMode(e) {
    if (this.data.paymentRetryLocked) return wx.showToast({ title: '上次付款待确认，请直接重试原操作', icon: 'none' });
    const mode = e.currentTarget.dataset.mode === 'correct' ? 'correct' : 'add';
    if (mode === this.data.prepayAdjustmentMode) return;
    const channels = this.data.existingPrepayChannels || {};
    const cash = mode === 'correct' && Number(channels.cash || 0) ? String(Number(channels.cash || 0)) : '';
    const wechat = mode === 'correct' && Number(channels.wechat || 0) ? String(Number(channels.wechat || 0)) : '';
    const alipay = mode === 'correct' && Number(channels.alipay || 0) ? String(Number(channels.alipay || 0)) : '';
    const previousSnapshot = this.data.initialSnapshot || {};
    this.clearPendingPaymentOperation();
    this.setData({
      prepayAdjustmentMode: mode,
      inputCash: cash,
      inputWechat: wechat,
      inputAlipay: alipay,
      correctionReason: '',
      initialSnapshot: {
        cash,
        wechat,
        alipay,
        totalAmount: previousSnapshot.totalAmount !== undefined ? previousSnapshot.totalAmount : (this.data.inputTotalAmount || ''),
        companions: previousSnapshot.companions !== undefined ? previousSnapshot.companions : '',
        note: previousSnapshot.note !== undefined ? previousSnapshot.note : ''
      }
    }, () => this.recalcAmounts());
  },

  closeFinishModal() {
    if (this._paymentOutcomeUnknown && this._paymentOperationId) {
      // 结果未知时不能丢掉原 operationId。关闭只隐藏窗口，下次打开先核对并复用同一流水号。
      this.setData({ showFinishModal: false, localPhotos: [] });
      wx.showToast({ title: '已保留上次付款状态', icon: 'none' });
      return;
    }
    this.clearPendingPaymentOperation();
    this.setData({ showFinishModal: false, localPhotos: [] });
  },

  chooseFinishPhoto() {
    if (this.data.paymentRetryLocked) return wx.showToast({ title: '上次付款待确认，暂不能修改凭据', icon: 'none' });
    const remain = Math.max(0, 4 - this.data.localPhotos.length - (this.data.pendingPaymentCloudIds || []).length);
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const paths = (res.tempFiles || []).map(f => f.tempFilePath);
        this.setData({
          localPhotos: [...this.data.localPhotos, ...paths]
        });
      }
    });
  },

  deletePhoto(e) {
    const idx = e.currentTarget.dataset.index;
    const list = [...this.data.localPhotos];
    list.splice(idx, 1);
    this.setData({ localPhotos: list });
  },

  previewPhoto(e) {
    const current = e.currentTarget.dataset.url;
    const list = e.currentTarget.dataset.list || [current];
    wx.previewImage({
      current: current,
      urls: list
    });
  },

  async submitFinishOrder() {
    const { settleMode, prepayAdjustmentMode, inputCash, inputWechat, inputAlipay, inputTotalAmount, fullTotal, depositTotal, remainTotal, modalCompanions, modalNote, correctionReason, localPhotos, orderId, order, initialSnapshot } = this.data;
    const operationId = this._paymentOperationId || ('op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    this._paymentOperationId = operationId;

    const existingChannels = settleMode === 'prepay' ? (this.data.existingPrepayChannels || {}) : {};
    const isExistingPrepay = Boolean(order && order.settleType === '预付款');
    const isPrepayCorrection = settleMode === 'prepay' && isExistingPrepay && prepayAdjustmentMode === 'correct';
    const shouldAddExisting = settleMode === 'prepay' && !isPrepayCorrection;
    const cash = (Number(inputCash) || 0) + (shouldAddExisting ? Number(existingChannels.cash || 0) : 0);
    const wechat = (Number(inputWechat) || 0) + (shouldAddExisting ? Number(existingChannels.wechat || 0) : 0);
    const alipay = (Number(inputAlipay) || 0) + (shouldAddExisting ? Number(existingChannels.alipay || 0) : 0);
    const paidSum = settleMode === 'full' ? fullTotal : depositTotal;

    if (paidSum <= 0 && !isPrepayCorrection) {
      return wx.showToast({ title: '请输入至少一项收款金额', icon: 'none' });
    }

    if (settleMode === 'prepay') {
      const total = Number(inputTotalAmount) || 0;
      if (total <= 0) {
        return wx.showToast({ title: '请输入工程总计金额', icon: 'none' });
      }
      if (total < paidSum) {
        return wx.showToast({ title: '工程总计不能小于已收定金', icon: 'none' });
      }
    }

    const isExistingFullCorrection = settleMode === 'full' && Boolean(order && order.settleType === '全款');
    if (settleMode === 'prepay' && isExistingPrepay && prepayAdjustmentMode === 'add') {
      const previousPaid = Number(order.depositAmount || order.finalAmount || 0);
      const previousTotal = Number(order.totalAmount || 0);
      const currentTotal = Number(inputTotalAmount) || 0;
      if (Math.abs(paidSum - previousPaid) <= 0.01 && Math.abs(currentTotal - previousTotal) > 0.01) {
        return wx.showToast({ title: '修改工程总额请切换到修正模式', icon: 'none' });
      }
    }

    if (order && (order.settleType === (settleMode === 'full' ? '全款' : '预付款'))) {
      const snap = initialSnapshot || {};
      const isNoChange = (
        !this._paymentOutcomeUnknown &&
        localPhotos.length === 0 && (this.data.pendingPaymentCloudIds || []).length === 0 &&
        String(inputCash) === String(snap.cash || '') &&
        String(inputWechat) === String(snap.wechat || '') &&
        String(inputAlipay) === String(snap.alipay || '') &&
        (settleMode === 'full' || String(inputTotalAmount) === String(snap.totalAmount || '')) &&
        String(modalCompanions) === String(snap.companions || '') &&
        String(modalNote) === String(snap.note || '')
      );

      if (isNoChange) {
        wx.showToast({ title: '内容未做修改，无需重复保存', icon: 'none' });
        this.clearPendingPaymentOperation();
        this.setData({ showFinishModal: false });
        return;
      }
    }

    if ((isPrepayCorrection || isExistingFullCorrection) && !String(correctionReason || '').trim()) {
      return wx.showToast({ title: '请填写金额修正原因', icon: 'none' });
    }

    wx.showLoading({ title: '正在上传拍照凭据...' });
    const uploadedCloudIds = Array.isArray(this._paymentUploadedCloudIds) ? [...this._paymentUploadedCloudIds] : [];

    try {
      for (let i = 0; i < localPhotos.length; i++) {
        const localPath = localPhotos[i];
        const cloudPath = `orders/${orderId}/payments/${operationId}/${Date.now()}_${i}.jpg`;
        const res = await wx.cloud.uploadFile({
          cloudPath: cloudPath,
          filePath: localPath
        });
        if (res.fileID) {
          await this.trackUploadedFile(res.fileID, orderId, operationId, 'payment');
          uploadedCloudIds.push(res.fileID);
        }
      }

      let updateData = {
        settleType: settleMode === 'full' ? '全款' : '预付款',
        cashAmount: cash,
        wechatAmount: wechat,
        alipayAmount: alipay,
        finalAmount: paidSum,
        depositAmount: settleMode === 'prepay' ? paidSum : 0,
        totalAmount: settleMode === 'full' ? paidSum : (Number(inputTotalAmount) || paidSum),
        remainingAmount: settleMode === 'full' ? 0 : remainTotal,
        companionWorkers: modalCompanions,
        finishPhotos: uploadedCloudIds,
        newFinishPhotos: uploadedCloudIds,
        finishNote: modalNote || order.finishNote || '',
        isUrgent: false
      };

      let operationType;
      if (settleMode === 'prepay' && isPrepayCorrection) {
        operationType = 'amount_correction';
      } else if (order && order.settleType) {
        operationType = settleMode === 'prepay'
          ? (paidSum > Number(order.depositAmount || order.finalAmount || 0) ? (remainTotal === 0 ? 'final_payment' : 'additional_payment') : 'amount_correction')
          : 'amount_correction';
      } else {
        operationType = settleMode === 'full' ? 'full_payment' : 'deposit_payment';
      }

      wx.showLoading({ title: '正在保存并留痕...' });
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'finishOrder',
          orderId: orderId,
          expectedVersion: Number(order && order.version || 0),
          data: { ...updateData, operationId, operationType, amountThisTime: settleMode === 'prepay' ? Math.max(0, paidSum - Number(order && (order.depositAmount || order.finalAmount) || 0)) : paidSum, correctionReason: correctionReason || modalNote || '' }
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        // duplicate 也可能是“第一次已提交但响应丢失”。只做引用确认，不立即删除照片；未引用文件由72小时任务清理。
        if (uploadedCloudIds.length) await this.confirmUploadedFiles(uploadedCloudIds);
        this.clearPendingPaymentOperation();
        this.setData({ showFinishModal: false, localPhotos: [] });
        wx.showToast({
          title: result.notification && !result.notification.success ? '订单已保存，群通知待处理' : (settleMode === 'full' ? '全款结单已留痕！' : '预付定金已留痕！'),
          icon: 'success'
        });
        await this.fetchOrderDetail(orderId);
      } else {
        // 云函数明确返回失败，说明本次上传文件未被此次业务提交引用，可以清理。
        await this.cleanupUploadedFiles(uploadedCloudIds);
        this.clearPendingPaymentOperation();
        await this.handleOrderMutationFailure(result, '保存失败，请重试');
      }
    } catch (err) {
      console.error(err);
      wx.hideLoading();
      // 网络/调用异常无法判断服务端是否已经提交。保留 operationId 和已上传文件，后续只能核对或使用同一流水号重试。
      this.savePendingPaymentOperation(operationId, uploadedCloudIds);
      this.setData({ pendingPaymentCloudIds: uploadedCloudIds });
      wx.showModal({
        title: '付款结果待确认',
        content: '网络异常，暂时无法确认本次付款是否已入账。请勿重新创建一笔付款；再次打开付款窗口时系统会先核对并复用同一流水号。',
        showCancel: false
      });
    }
  },

  openFeedbackModal() {
    this._feedbackOperationId = null;
    this.setData({
      showFeedbackModal: true,
      feedbackContent: '',
      feedbackPhotos: []
    });
  },

  closeFeedbackModal() {
    this._feedbackOperationId = null;
    this.setData({ showFeedbackModal: false, feedbackContent: '', feedbackPhotos: [] });
  },

  onFeedbackContentInput(e) {
    this.setData({ feedbackContent: e.detail.value.trim() });
  },

  chooseFeedbackPhoto() {
    const remain = 4 - this.data.feedbackPhotos.length;
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const paths = (res.tempFiles || []).map(f => f.tempFilePath);
        this.setData({
          feedbackPhotos: [...this.data.feedbackPhotos, ...paths]
        });
      }
    });
  },

  deleteFeedbackPhoto(e) {
    const idx = e.currentTarget.dataset.index;
    const list = [...this.data.feedbackPhotos];
    list.splice(idx, 1);
    this.setData({ feedbackPhotos: list });
  },

  async submitFeedback() {
    const { feedbackContent, feedbackPhotos, orderId, order } = this.data;

    if (!feedbackContent) {
      return wx.showToast({ title: '请输入回馈说明', icon: 'none' });
    }

    wx.showLoading({ title: '正在提交回馈...' });
    const feedbackOperationId = this._feedbackOperationId || ('fbop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    this._feedbackOperationId = feedbackOperationId;

    const uploadedCloudIds = [];
    try {
      for (let i = 0; i < feedbackPhotos.length; i++) {
        const localPath = feedbackPhotos[i];
        const cloudPath = `orders/${orderId}/feedback/${feedbackOperationId}/${Date.now()}_${i}.jpg`;
        const res = await wx.cloud.uploadFile({
          cloudPath: cloudPath,
          filePath: localPath
        });
        if (res.fileID) {
          await this.trackUploadedFile(res.fileID, orderId, feedbackOperationId, 'feedback');
          uploadedCloudIds.push(res.fileID);
        }
      }

      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'feedback',
          orderId: orderId,
          expectedVersion: Number(order && order.version || 0),
          // 只提交本次回馈；服务端事务读取最新 feedbacks 后追加，避免并发覆盖。
          data: {
            content: feedbackContent,
            photos: uploadedCloudIds,
            operationId: feedbackOperationId
          }
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        if (result.duplicate && uploadedCloudIds.length) await this.cleanupUploadedFiles(uploadedCloudIds);
        else if (uploadedCloudIds.length) await this.confirmUploadedFiles(uploadedCloudIds);
        this._feedbackOperationId = null;
        this.setData({ showFeedbackModal: false, feedbackContent: '', feedbackPhotos: [] });
        wx.showToast({ title: '回馈已提交！', icon: 'success' });
        await this.fetchOrderDetail(orderId);
      } else {
        // 服务端明确拒绝时，此次上传的文件没有形成数据库引用，可以安全清理。
        await this.cleanupUploadedFiles(uploadedCloudIds);
        this._feedbackOperationId = null;
        await this.handleOrderMutationFailure(result, '提交回馈失败');
      }
    } catch (err) {
      // 网络异常时不能判断服务端是否已经提交成功，因此不主动删除云文件，避免误删已引用照片。
      console.error(err);
      wx.hideLoading();
      wx.showToast({ title: '提交结果未确认，请刷新工单后再操作', icon: 'none' });
      await this.fetchOrderDetail(orderId);
    }
  }
});
