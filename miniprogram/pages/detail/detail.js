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

    candidateWorkers: [],
    candidateWorkerNames: [],

    // 修改预约时间
    showEditTimeModal: false,
    editTimeInput: '',

    // 取消工单
    showCancelModal: false,
    cancelReason: '',

    // 结单/预付弹窗
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

    modalCompanions: '',
    modalNote: '',
    localPhotos: [],

    // 进度回馈弹窗
    showFeedbackModal: false,
    feedbackContent: '',
    feedbackPhotos: []
  },

  onLoad(options) {
    const user = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    this.setData({ currentUser: user });

    if (options && options.id) {
      this.setData({ orderId: options.id });
      this.fetchOrderDetail(options.id);
    }
  },

  onShow() {
    const user = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    this.setData({ currentUser: user });
  },

  fetchOrderDetail(id) {
    wx.showLoading({ title: '加载中...' });
    const db = wx.cloud.database();

    db.collection('orders').doc(id).get().then(res => {
      wx.hideLoading();
      const order = res.data;

      if (order.finishTime) {
        order.finishTimeFormatted = formatDateTime(order.finishTime);
      }
      if (order.cancelTime) {
        order.cancelTimeFormatted = formatDateTime(order.cancelTime);
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

      const user = this.data.currentUser;
      if (user && user.role === 'admin') {
        this.fetchCandidateWorkers(order.city);
      }
    }).catch(err => {
      wx.hideLoading();
      console.error(err);
      wx.showToast({ title: '加载工单失败', icon: 'none' });
    });
  },

  fetchCandidateWorkers(city) {
    const db = wx.cloud.database();
    db.collection('users').where({ role: 'worker' }).get().then(res => {
      const all = res.data || [];
      const matched = all.filter(w => {
        if (!city) return true;
        let citiesArr = [];
        if (Array.isArray(w.cities)) citiesArr = w.cities;
        else if (w.cities && typeof w.cities === 'object') citiesArr = Object.values(w.cities);
        else if (typeof w.cities === 'string') citiesArr = [w.cities];
        return citiesArr.includes(city);
      });

      this.setData({
        candidateWorkers: matched,
        candidateWorkerNames: matched.map(w => w.name)
      });
    }).catch(e => console.error(e));
  },

  async onAssignWorker(e) {
    const idx = Number(e.detail.value);
    const worker = this.data.candidateWorkers[idx];
    if (!worker) return;

    wx.showLoading({ title: '正在指派师傅...' });
    const db = wx.cloud.database();

    try {
      await db.collection('orders').doc(this.data.orderId).update({
        data: {
          workerName: worker.name,
          workerPhone: worker.phone || '',
          workerGroupId: worker.groupId || '',
          status: '已派单'
        }
      });
      wx.hideLoading();
      wx.showToast({ title: '指派成功', icon: 'success' });
      this.fetchOrderDetail(this.data.orderId);
    } catch (err) {
      wx.hideLoading();
      console.error('指派失败：', err);
      wx.showToast({ title: '指派失败，请重试', icon: 'none' });
    }
  },

  callCustomer() {
    if (this.data.order && this.data.order.customerPhone) {
      wx.makePhoneCall({ phoneNumber: this.data.order.customerPhone });
    }
  },

  triggerUrgent() {
    wx.showLoading({ title: '提交催单...' });
    const db = wx.cloud.database();
    db.collection('orders').doc(this.data.orderId).update({
      data: { isUrgent: true }
    }).then(() => {
      wx.hideLoading();
      wx.showToast({ title: '已标记紧急催单', icon: 'success' });
      this.fetchOrderDetail(this.data.orderId);
    }).catch(e => {
      wx.hideLoading();
      console.error(e);
    });
  },

  // 🌟 修改预约时间方法
  openEditTimeModal() {
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

    // 同步把改期记录写入一条回馈，方便现场人员查阅
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

    const db = wx.cloud.database();
    try {
      await db.collection('orders').doc(this.data.orderId).update({
        data: {
          appointmentTime: newTime,
          appointmentLogs: updatedLogs,
          feedbacks: updatedFeedbacks
        }
      });

      wx.hideLoading();
      this.setData({ showEditTimeModal: false });
      wx.showToast({ title: '改期成功！', icon: 'success' });
      this.fetchOrderDetail(this.data.orderId);
    } catch (err) {
      wx.hideLoading();
      console.error(err);
      wx.showToast({ title: '改期失败，请重试', icon: 'none' });
    }
  },

  // 🌟 取消工单（状态归类为未成单）
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
      operatorName: (currentUser && currentUser.name) || '员工',
      operatorRole: (currentUser && currentUser.role) || 'service',
      content: `[工单取消] 理由：${reason}`,
      photos: []
    };

    const existingFeedbacks = Array.isArray(this.data.order.feedbacks) ? this.data.order.feedbacks : [];
    const updatedFeedbacks = [cancelFeedback, ...existingFeedbacks];

    const db = wx.cloud.database();
    try {
      await db.collection('orders').doc(this.data.orderId).update({
        data: {
          status: '未成单', // 🌟 归类为未成单
          cancelReason: reason,
          cancelOperator: (currentUser && currentUser.name) || '员工',
          cancelTime: now.toISOString(),
          feedbacks: updatedFeedbacks
        }
      });

      wx.hideLoading();
      this.setData({ showCancelModal: false });
      wx.showToast({ title: '工单已取消并归档', icon: 'success' });
      this.fetchOrderDetail(this.data.orderId);
    } catch (err) {
      wx.hideLoading();
      console.error(err);
      wx.showToast({ title: '取消失败，请重试', icon: 'none' });
    }
  },

  // 师傅直接标记未成单
  markFail() {
    wx.showModal({
      title: '确认标为未成单？',
      content: '确认后该工单将进入未成单归档。',
      confirmColor: '#e53935',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '更新中...' });
          const db = wx.cloud.database();
          try {
            await db.collection('orders').doc(this.data.orderId).update({
              data: { status: '未成单' }
            });
            wx.hideLoading();
            wx.showToast({ title: '已置为未成单', icon: 'success' });
            this.fetchOrderDetail(this.data.orderId);
          } catch (err) {
            wx.hideLoading();
            console.error('更新未成单失败：', err);
            wx.showToast({ title: '操作失败', icon: 'none' });
          }
        }
      }
    });
  },

  recalcAmounts() {
    const cash = Number(this.data.inputCash) || 0;
    const wechat = Number(this.data.inputWechat) || 0;
    const alipay = Number(this.data.inputAlipay) || 0;
    const total = Number(this.data.inputTotalAmount) || 0;

    const sum = Number((cash + wechat + alipay).toFixed(2));
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
    const cash = o.cashAmount ? String(o.cashAmount) : '';
    const wechat = o.wechatAmount ? String(o.wechatAmount) : (o.depositAmount ? String(o.depositAmount) : '');
    const alipay = o.alipayAmount ? String(o.alipayAmount) : '';
    const total = o.totalAmount ? String(o.totalAmount) : '';
    const companions = o.companionWorkers || '';

    this.setData({
      showFinishModal: true,
      settleMode: 'prepay',
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

    const cash = Number(inputCash) || 0;
    const wechat = Number(inputWechat) || 0;
    const alipay = Number(inputAlipay) || 0;
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
        inputCash === snap.cash &&
        inputWechat === snap.wechat &&
        inputAlipay === snap.alipay &&
        (settleMode === 'full' || inputTotalAmount === snap.totalAmount) &&
        modalCompanions === snap.companions &&
        modalNote === snap.note
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
      const newLog = {
        id: 'log_' + Date.now(),
        time: now.toISOString(),
        timeFormatted: formatDateTime(now),
        operatorName: (currentUser && currentUser.name) || '员工',
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
      const db = wx.cloud.database();
      await db.collection('orders').doc(orderId).update({ data: updateData });

      wx.hideLoading();
      this.setData({ showFinishModal: false });
      wx.showToast({
        title: settleMode === 'full' ? '全款结单已留痕！' : '预付定金已留痕！',
        icon: 'success'
      });
      this.fetchOrderDetail(orderId);
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

      const db = wx.cloud.database();
      await db.collection('orders').doc(orderId).update({
        data: { feedbacks: updatedFeedbacks }
      });

      wx.hideLoading();
      this.setData({ showFeedbackModal: false });
      wx.showToast({ title: '回馈已提交！', icon: 'success' });
      this.fetchOrderDetail(orderId);
    } catch (err) {
      console.error(err);
      wx.hideLoading();
      wx.showToast({ title: '提交回馈失败', icon: 'none' });
    }
  }
});