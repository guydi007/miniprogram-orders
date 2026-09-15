const app = getApp();

function formatDateTime(dateVal) {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

function parseDateSmart(text) {
  if (!text) return '';
  let str = text.trim();

  const now = new Date();
  const getFormat = (offsetDays) => {
    const d = new Date(now.getTime() + offsetDays * 86400000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const today = getFormat(0);
  const tomorrow = getFormat(1);

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

    modalCompanions: '',
    modalNote: '',
    localPhotos: [],

    showFeedbackModal: false,
    feedbackContent: '',
    feedbackPhotos: []
  },

  updatePermissions(order, user) {
    const role = user ? user.role : '';
    const isLeader = role === 'leader';
    const isServiceOrLeader = role === 'admin' || role === 'service' || role === 'leader';
    const isWorkerOrLeader = role === 'worker' || role === 'leader';
    const canOperateSettle = isLeader || (role === 'worker' && order && user && order.workerName === user.name);
    const canEditAppointment = Boolean(order && !['已完工', '未成单'].includes(order.status) &&
      (role === 'service' || isLeader || (role === 'worker' && user && order.workerName === user.name)));

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
        order.paymentLogs = order.paymentLogs.map(item => ({
          ...item,
          timeFormatted: formatDateTime(item.time)
        }));
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
        candidateWorkerNames: matched.map(w => w.name + (w.role === 'leader' ? ' [主管]' : '') + (w.groupId ? ` (${w.groupId})` : ''))
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
      workerName: worker.name,
      workerPhone: worker.phone || '',
      workerGroupId: worker.groupId || '',
      status: '已派单'
    };

    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'updateOrder',
          orderId: this.data.orderId,
          data: updateData
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        this.setData({
          'order.workerName': updateData.workerName,
          'order.workerPhone': updateData.workerPhone,
          'order.workerGroupId': updateData.workerGroupId,
          'order.status': updateData.status
        });
        this.updatePermissions(this.data.order, this.data.currentUser);
        wx.showToast({ title: '指派成功', icon: 'success' });
      } else {
        const errMsg = result.error ? (result.error.errMsg || JSON.stringify(result.error)) : (result.msg || '更新未生效');
        wx.showModal({
          title: '指派未成功',
          content: `云端返回：${errMsg}`,
          showCancel: false
        });
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
          data: { isUrgent: true }
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        if (result.notification && result.notification.success) {
          wx.showToast({ title: '已催单，接单人员已通知', icon: 'none' });
        } else {
          wx.showModal({ title: '已标记紧急催单', content: '提醒未全部发送成功，可能未订阅或授权次数已用完。请直接联系接单人员。', showCancel: false });
        }
        this.fetchOrderDetail(this.data.orderId);
      } else {
        wx.showToast({ title: result.msg || '催单失败', icon: 'none' });
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
    const newTime = parseDateSmart(this.data.editTimeInput);
    const oldTime = this.data.order.appointmentTime || '';

    if (!newTime) {
      return wx.showToast({ title: '请输入预约时间', icon: 'none' });
    }

    if (newTime === oldTime) {
      this.setData({ showEditTimeModal: false });
      return wx.showToast({ title: '时间未做修改', icon: 'none' });
    }

    wx.showLoading({ title: '正在保存改期...' });
    const now = new Date();
    const currentUser = this.data.currentUser;

    const newLog = {
      id: 'time_' + Date.now(),
      oldTime: oldTime,
      newTime: newTime,
      operatorName: (currentUser && currentUser.name) || '员工',
      operatorRole: (currentUser && currentUser.role) || 'service',
      time: now.toISOString(),
      timeFormatted: formatDateTime(now)
    };

    const existingLogs = Array.isArray(this.data.order.appointmentLogs) ? this.data.order.appointmentLogs : [];
    const updatedLogs = [newLog, ...existingLogs];

    const changeFeedback = {
      id: 'fb_' + Date.now(),
      time: now.toISOString(),
      timeFormatted: formatDateTime(now),
      operatorName: (currentUser && currentUser.name) || '员工',
      operatorRole: (currentUser && currentUser.role) || 'service',
      content: `[预约改期] 预约时间由【${oldTime}】更改为【${newTime}】`,
      photos: []
    };
    const existingFeedbacks = Array.isArray(this.data.order.feedbacks) ? this.data.order.feedbacks : [];
    const updatedFeedbacks = [changeFeedback, ...existingFeedbacks];

    const updateData = {
      appointmentTime: newTime,
      appointmentLogs: updatedLogs,
      feedbacks: updatedFeedbacks
    };

    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'editTime',
          orderId: this.data.orderId,
          data: updateData
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        this.setData({ showEditTimeModal: false });
        wx.showToast({ title: '改期成功！', icon: 'success' });
        this.fetchOrderDetail(this.data.orderId);
      } else {
        wx.showToast({ title: result.msg || '改期失败，请重试', icon: 'none' });
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
    if (!reason) {
      return wx.showToast({ title: '请填写取消原因', icon: 'none' });
    }

    wx.showLoading({ title: '正在取消工单...' });
    const now = new Date();
    const currentUser = this.data.currentUser;

    const cancelFeedback = {
      id: 'fb_' + Date.now(),
      time: now.toISOString(),
      timeFormatted: formatDateTime(now),
      operatorName: (currentUser && currentUser.name) || '客服',
      operatorRole: 'service',
      content: `[客服退单取消] 理由：${reason}`,
      photos: []
    };

    const existingFeedbacks = Array.isArray(this.data.order.feedbacks) ? this.data.order.feedbacks : [];
    const updatedFeedbacks = [cancelFeedback, ...existingFeedbacks];

    const updateData = {
      status: '未成单',
      uncompletedType: 'service_cancel',
      cancelReason: reason,
      cancelOperator: (currentUser && currentUser.name) || '客服',
      cancelTime: now.toISOString(),
      feedbacks: updatedFeedbacks
    };

    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'cancelOrder',
          orderId: this.data.orderId,
          data: updateData
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        this.setData({ showCancelModal: false });
        wx.showToast({ title: '工单已退单归档', icon: 'success' });
        this.fetchOrderDetail(this.data.orderId);
      } else {
        wx.showToast({ title: result.msg || '取消失败，请重试', icon: 'none' });
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
          data: { failReason: reason }
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        this.setData({ showFailModal: false });
        wx.showToast({ title: '已归入未成单', icon: 'success' });
        this.fetchOrderDetail(this.data.orderId);
      } else {
        wx.showToast({ title: result.msg || '操作失败，请重试', icon: 'none' });
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

    const existing = this.data.settleMode === 'prepay' ? Number(this.data.existingPrepayPaid || 0) : 0;
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

  openFinishModal() {
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
      inputCash: cash,
      inputWechat: wechat,
      inputAlipay: alipay,
      modalCompanions: companions,
      modalNote: '',
      localPhotos: [],
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

  openPrepayModal() {
    const o = this.data.order || {};
    const hasExisting = o.settleType === '预付款';
    const cash = hasExisting ? '' : (o.cashAmount ? String(o.cashAmount) : '');
    const wechat = hasExisting ? '' : (o.wechatAmount ? String(o.wechatAmount) : '');
    const alipay = hasExisting ? '' : (o.alipayAmount ? String(o.alipayAmount) : '');
    const existingPaid = hasExisting ? Number(o.depositAmount || o.finalAmount || 0) : 0;
    const total = o.totalAmount ? String(o.totalAmount) : '';
    const companions = o.companionWorkers || '';

    this.setData({
      showFinishModal: true,
      settleMode: 'prepay',
      existingPrepayPaid: existingPaid,
      existingPrepayChannels: hasExisting ? { cash: Number(o.cashAmount || 0), wechat: Number(o.wechatAmount || 0), alipay: Number(o.alipayAmount || 0) } : { cash: 0, wechat: 0, alipay: 0 },
      inputCash: cash,
      inputWechat: wechat,
      inputAlipay: alipay,
      inputTotalAmount: total,
      modalCompanions: companions,
      modalNote: '',
      localPhotos: [],
      initialSnapshot: {
        cash: cash,
        wechat: wechat,
        alipay: alipay,
        totalAmount: total,
        companions: companions,
        note: ''
      }
    }, () => this.recalcAmounts());
  },

  closeFinishModal() {
    this.setData({ showFinishModal: false });
  },

  chooseFinishPhoto() {
    const remain = 4 - this.data.localPhotos.length;
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
    const { settleMode, inputCash, inputWechat, inputAlipay, inputTotalAmount, fullTotal, depositTotal, remainTotal, modalCompanions, modalNote, localPhotos, orderId, order, currentUser, initialSnapshot } = this.data;

    const existingChannels = settleMode === 'prepay' ? (this.data.existingPrepayChannels || {}) : {};
    const cash = (Number(inputCash) || 0) + (Number(existingChannels.cash) || 0);
    const wechat = (Number(inputWechat) || 0) + (Number(existingChannels.wechat) || 0);
    const alipay = (Number(inputAlipay) || 0) + (Number(existingChannels.alipay) || 0);
    const paidSum = settleMode === 'full' ? fullTotal : depositTotal;

    if (paidSum <= 0) {
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

    if (order && (order.settleType === (settleMode === 'full' ? '全款' : '预付款'))) {
      const snap = initialSnapshot || {};
      const isNoChange = (
        localPhotos.length === 0 &&
        String(inputCash) === String(snap.cash || '') &&
        String(inputWechat) === String(snap.wechat || '') &&
        String(inputAlipay) === String(snap.alipay || '') &&
        (settleMode === 'full' || String(inputTotalAmount) === String(snap.totalAmount || '')) &&
        String(modalCompanions) === String(snap.companions || '') &&
        String(modalNote) === String(snap.note || '')
      );

      if (isNoChange) {
        wx.showToast({ title: '内容未做修改，无需重复保存', icon: 'none' });
        this.setData({ showFinishModal: false });
        return;
      }
    }

    wx.showLoading({ title: '正在上传拍照凭据...' });

    try {
      const uploadedCloudIds = [];
      for (let i = 0; i < localPhotos.length; i++) {
        const localPath = localPhotos[i];
        const cloudPath = `orders/${orderId}/pay_${Date.now()}_${i}.jpg`;
        const res = await wx.cloud.uploadFile({
          cloudPath: cloudPath,
          filePath: localPath
        });
        if (res.fileID) uploadedCloudIds.push(res.fileID);
      }

      const now = new Date();
      const opRole = (currentUser && currentUser.role === 'leader') ? '主管' : '师傅';
      const newLog = {
        id: 'log_' + Date.now(),
        time: now.toISOString(),
        timeFormatted: formatDateTime(now),
        operatorName: (currentUser && currentUser.name) || opRole,
        operatorRole: (currentUser && currentUser.role) || 'worker',
        settleType: settleMode === 'full' ? '全款' : '预付款',
        cashAmount: cash,
        wechatAmount: wechat,
        alipayAmount: alipay,
        currentPaid: paidSum,
        totalAmount: settleMode === 'full' ? paidSum : (Number(inputTotalAmount) || paidSum),
        remainingAmount: settleMode === 'full' ? 0 : remainTotal,
        companionWorkers: modalCompanions,
        photos: uploadedCloudIds,
        note: modalNote
      };

      const existingLogs = Array.isArray(order.paymentLogs) ? order.paymentLogs : [];
      const updatedLogs = [newLog, ...existingLogs];

      const existingPhotos = Array.isArray(order.finishPhotos) ? order.finishPhotos : [];
      const mergedPhotos = uploadedCloudIds.length > 0 ? [...uploadedCloudIds, ...existingPhotos] : existingPhotos;

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
        finishPhotos: mergedPhotos,
        finishNote: modalNote || order.finishNote || '',
        paymentLogs: updatedLogs,
        isUrgent: false,
        finishTime: now.toISOString()
      };

      if (settleMode === 'full' || remainTotal === 0) {
        updateData.status = '已完工';
      } else {
        updateData.status = '已派单';
      }

      wx.showLoading({ title: '正在保存并留痕...' });
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'finishOrder',
          orderId: orderId,
          data: updateData
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        this.setData({ showFinishModal: false });
        wx.showToast({
          title: settleMode === 'full' ? '全款结单已留痕！' : '预付定金已留痕！',
          icon: 'success'
        });
        this.fetchOrderDetail(orderId);
      } else {
        wx.showToast({ title: result.msg || '保存失败，请重试', icon: 'none' });
      }
    } catch (err) {
      console.error(err);
      wx.hideLoading();
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  openFeedbackModal() {
    this.setData({
      showFeedbackModal: true,
      feedbackContent: '',
      feedbackPhotos: []
    });
  },

  closeFeedbackModal() {
    this.setData({ showFeedbackModal: false });
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
    const { feedbackContent, feedbackPhotos, orderId, order, currentUser } = this.data;

    if (!feedbackContent) {
      return wx.showToast({ title: '请输入回馈说明', icon: 'none' });
    }

    wx.showLoading({ title: '正在提交回馈...' });

    try {
      const uploadedCloudIds = [];
      for (let i = 0; i < feedbackPhotos.length; i++) {
        const localPath = feedbackPhotos[i];
        const cloudPath = `orders/${orderId}/feedback_${Date.now()}_${i}.jpg`;
        const res = await wx.cloud.uploadFile({
          cloudPath: cloudPath,
          filePath: localPath
        });
        if (res.fileID) uploadedCloudIds.push(res.fileID);
      }

      const now = new Date();
      const newFeedback = {
        id: 'fb_' + Date.now(),
        time: now.toISOString(),
        timeFormatted: formatDateTime(now),
        operatorName: (currentUser && currentUser.name) || '员工',
        operatorRole: (currentUser && currentUser.role) || 'worker',
        content: feedbackContent,
        photos: uploadedCloudIds
      };

      const existingFeedbacks = Array.isArray(order.feedbacks) ? order.feedbacks : [];
      const updatedFeedbacks = [newFeedback, ...existingFeedbacks];

      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'feedback',
          orderId: orderId,
          data: { feedbacks: updatedFeedbacks }
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        this.setData({ showFeedbackModal: false });
        wx.showToast({ title: '回馈已提交！', icon: 'success' });
        this.fetchOrderDetail(orderId);
      } else {
        wx.showToast({ title: result.msg || '提交回馈失败', icon: 'none' });
      }
    } catch (err) {
      console.error(err);
      wx.hideLoading();
      wx.showToast({ title: '提交回馈失败', icon: 'none' });
    }
  }
});
