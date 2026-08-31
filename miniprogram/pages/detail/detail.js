const app = getApp();

function getTimeString() {
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// 智能时间补齐函数
function smartFormatTime(input) {
  if (!input) return '';
  let str = input.trim();
  const now = new Date();
  const pad = (n) => ((n = parseInt(n, 10) || 0) < 10 ? '0' + n : '' + n);
  const currentYear = now.getFullYear();

  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const tomorrowStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  const afterTomorrow = new Date(now.getTime() + 48 * 3600 * 1000);
  const afterTomorrowStr = `${afterTomorrow.getFullYear()}-${pad(afterTomorrow.getMonth() + 1)}-${pad(afterTomorrow.getDate())}`;

  if (str.startsWith('今天')) {
    const slot = str.replace('今天', '').trim() || '下午';
    return `${todayStr} ${slot}`;
  }
  if (str.startsWith('明天')) {
    const slot = str.replace('明天', '').trim() || '下午';
    return `${tomorrowStr} ${slot}`;
  }
  if (str.startsWith('后天')) {
    const slot = str.replace('后天', '').trim() || '下午';
    return `${afterTomorrowStr} ${slot}`;
  }

  const pureDigits = str.replace(/[^0-9]/g, '');
  if (pureDigits.length === 8) {
    return `${currentYear}-${pureDigits.slice(0, 2)}-${pureDigits.slice(2, 4)} ${pureDigits.slice(4, 6)}:${pureDigits.slice(6, 8)}`;
  } else if (pureDigits.length === 12) {
    return `${pureDigits.slice(0, 4)}-${pureDigits.slice(4, 6)}-${pureDigits.slice(6, 8)} ${pureDigits.slice(8, 10)}:${pureDigits.slice(10, 12)}`;
  }

  return str;
}

Page({
  data: {
    orderId: '',
    order: null,
    currentUser: {},
    workerList: [],
    newFeedback: '',

    // 弹窗状态
    showTimeModal: false,
    modalNewTime: '',
    modalChangeReason: '',

    // 1. 成单结单弹窗
    showDealModal: false,
    dealTypeTab: 'full',
    dealForm: {
      cash: '',
      wechat: '',
      alipay: '',
      totalAmount: ''
    },
    dealFormCalculated: {
      paidTotal: '0.00',
      balanceAmount: '0.00'
    },
    tempDealPhotos: [],

    // 2. 未成单弹窗
    showFailModal: false,
    failRemark: '',

    // 3. 修改金额弹窗
    showEditAmountModal: false,
    editAmountForm: {
      cash: '',
      wechat: '',
      alipay: '',
      totalAmount: ''
    },
    editAmountReason: '',

    // 4. 催单弹窗
    showUrgeModal: false,
    urgeReason: ''
  },

  onLoad(options) {
    this.setData({
      orderId: options.id,
      currentUser: app.globalData.currentUser,
      workerList: app.globalData.workerList
    });
  },

  onShow() {
    if (this.data.orderId) {
      this.loadOrderDetail();
    }
  },

  loadOrderDetail() {
    wx.showLoading({ title: '加载中...' });
    const db = wx.cloud.database();
    db.collection('orders').doc(this.data.orderId).get().then(res => {
      let order = res.data;

      // 核心自愈逻辑：如果预付单有在途尾款，自动纠正为“已派单”（进行中）
      if (order.dealType === 'prepay' && order.settlement && parseFloat(order.settlement.balanceAmount) > 0 && order.status !== '已派单') {
        order.status = '已派单';
        db.collection('orders').doc(this.data.orderId).update({
          data: { status: '已派单' }
        }).catch(e => console.error(e));
      }

      this.setData({ order: order });
      wx.hideLoading();
    }).catch(err => {
      console.error(err);
      wx.hideLoading();
    });
  },

  callCustomer() {
    if (this.data.order && this.data.order.customerPhone) {
      wx.makePhoneCall({ phoneNumber: this.data.order.customerPhone });
    }
  },

  // ===================== A. 成单结单流程 =====================
  openDealModal() {
    if (!this.data.currentUser || this.data.currentUser.role !== 'worker') {
      return wx.showToast({ title: '仅师傅可操作结单', icon: 'none' });
    }
    this.setData({
      showDealModal: true,
      dealTypeTab: 'full',
      dealForm: { cash: '', wechat: '', alipay: '', totalAmount: '' },
      dealFormCalculated: { paidTotal: '0.00', balanceAmount: '0.00' },
      tempDealPhotos: []
    });
  },

  closeDealModal() {
    this.setData({ showDealModal: false });
  },

  switchDealTab(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ dealTypeTab: type }, () => {
      this.recalcDealAmounts();
    });
  },

  onDealFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`dealForm.${field}`]: e.detail.value }, () => {
      this.recalcDealAmounts();
    });
  },

  recalcDealAmounts() {
    const { cash, wechat, alipay, totalAmount } = this.data.dealForm;
    const c = parseFloat(cash) || 0;
    const w = parseFloat(wechat) || 0;
    const a = parseFloat(alipay) || 0;
    const paid = c + w + a;
    const total = parseFloat(totalAmount) || 0;
    const balance = Math.max(0, total - paid);

    this.setData({
      dealFormCalculated: {
        paidTotal: paid.toFixed(2),
        balanceAmount: balance.toFixed(2)
      }
    });
  },

  chooseDealPhotos() {
    wx.chooseMedia({
      count: 9 - this.data.tempDealPhotos.length,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newPaths = res.tempFiles.map(f => f.tempFilePath);
        this.setData({
          tempDealPhotos: [...this.data.tempDealPhotos, ...newPaths]
        });
      }
    });
  },

  deleteTempPhoto(e) {
    const idx = e.currentTarget.dataset.index;
    const list = this.data.tempDealPhotos;
    list.splice(idx, 1);
    this.setData({ tempDealPhotos: list });
  },

  previewTempPhoto(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.src,
      urls: this.data.tempDealPhotos
    });
  },

  previewPhoto(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.src,
      urls: this.data.order.settlement.photos || []
    });
  },

  async submitDealOrder() {
    const { dealTypeTab, dealForm, dealFormCalculated, tempDealPhotos } = this.data;
    const paidTotal = parseFloat(dealFormCalculated.paidTotal);
    const balanceAmount = parseFloat(dealFormCalculated.balanceAmount);

    if (paidTotal <= 0 && dealTypeTab === 'full') {
      return wx.showToast({ title: '请至少录入一项收款金额', icon: 'none' });
    }

    wx.showLoading({ title: '正在上传凭证...' });

    try {
      const uploadedCloudFileIDs = [];
      for (let i = 0; i < tempDealPhotos.length; i++) {
        const filePath = tempDealPhotos[i];
        const cloudPath = `orders/${this.data.orderId}/${Date.now()}_${i}.jpg`;
        const uploadRes = await wx.cloud.uploadFile({ cloudPath, filePath });
        uploadedCloudFileIDs.push(uploadRes.fileID);
      }

      const timeStr = getTimeString();
      const opName = (this.data.currentUser && this.data.currentUser.name) || '师傅';

      const settlementData = {
        payType: dealTypeTab,
        cash: parseFloat(dealForm.cash) || 0,
        wechat: parseFloat(dealForm.wechat) || 0,
        alipay: parseFloat(dealForm.alipay) || 0,
        paidTotal: paidTotal,
        totalAmount: dealTypeTab === 'prepay' ? (parseFloat(dealForm.totalAmount) || 0) : paidTotal,
        balanceAmount: dealTypeTab === 'prepay' ? balanceAmount : 0,
        photos: uploadedCloudFileIDs
      };

      const photoLogs = uploadedCloudFileIDs.length > 0 ? [{
        time: timeStr,
        operator: opName,
        note: `初次结单上传了 ${uploadedCloudFileIDs.length} 张现场照片`
      }] : [];

      // 有尾款 -> 保持进行中（已派单）；无尾款/全款 -> 已完工
      const finalStatus = (dealTypeTab === 'prepay' && balanceAmount > 0) ? '已派单' : '已完工';

      const dealText = dealTypeTab === 'full' 
        ? `【全款结单】实收合计：¥${settlementData.paidTotal} (微信:¥${settlementData.wechat}, 支付宝:¥${settlementData.alipay}, 现金:¥${settlementData.cash})`
        : `【预付定金】总额：¥${settlementData.totalAmount}, 已收定金：¥${settlementData.paidTotal}, 待收尾款：¥${settlementData.balanceAmount}（订单处于进行中）`;

      const systemFeedback = {
        id: 'fb_' + Date.now(),
        authorName: opName,
        authorRole: 'worker',
        content: `🎉 师傅已完成${dealText}`,
        createTime: timeStr,
        isSystem: true
      };

      const db = wx.cloud.database();
      await db.collection('orders').doc(this.data.orderId).update({
        data: {
          status: finalStatus,
          dealType: dealTypeTab,
          settlement: settlementData,
          photoChangeLogs: photoLogs,
          feedbacks: [systemFeedback, ...(this.data.order.feedbacks || [])]
        }
      });

      wx.hideLoading();
      this.setData({ showDealModal: false });
      this.loadOrderDetail();
      wx.showToast({ title: '操作成功！', icon: 'success' });
    } catch (err) {
      console.error('结单失败：', err);
      wx.hideLoading();
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    }
  },

  // ===================== B. 未成单流程 =====================
  openFailModal() {
    if (!this.data.currentUser || this.data.currentUser.role !== 'worker') {
      return wx.showToast({ title: '仅师傅可操作未成单', icon: 'none' });
    }
    this.setData({ showFailModal: true, failRemark: '' });
  },

  closeFailModal() {
    this.setData({ showFailModal: false });
  },

  onFailRemarkInput(e) {
    this.setData({ failRemark: e.detail.value });
  },

  submitFailOrder() {
    const remark = this.data.failRemark.trim();
    if (!remark) {
      return wx.showToast({ title: '请填写未成单原因', icon: 'none' });
    }

    wx.showLoading({ title: '正在提交...' });
    const timeStr = getTimeString();
    const opName = (this.data.currentUser && this.data.currentUser.name) || '师傅';

    const systemFeedback = {
      id: 'fb_' + Date.now(),
      authorName: opName,
      authorRole: 'worker',
      content: `❌ 工单标记为未成单。原因：${remark}`,
      createTime: timeStr,
      isSystem: true
    };

    const db = wx.cloud.database();
    db.collection('orders').doc(this.data.orderId).update({
      data: {
        status: '未成单',
        dealType: 'failed',
        unsettledReason: remark,
        feedbacks: [systemFeedback, ...(this.data.order.feedbacks || [])]
      }
    }).then(() => {
      wx.hideLoading();
      this.setData({ showFailModal: false });
      this.loadOrderDetail();
      wx.showToast({ title: '已标记为未成单', icon: 'none' });
    }).catch(err => {
      console.error(err);
      wx.hideLoading();
    });
  },

  // ===================== C. 修改金额流程与留痕 =====================
  openEditAmountModal() {
    if (!this.data.currentUser || this.data.currentUser.role !== 'worker') {
      return wx.showToast({ title: '仅师傅可修改金额', icon: 'none' });
    }
    const s = this.data.order.settlement || {};
    this.setData({
      showEditAmountModal: true,
      editAmountForm: {
        cash: s.cash || 0,
        wechat: s.wechat || 0,
        alipay: s.alipay || 0,
        totalAmount: s.totalAmount || 0
      },
      editAmountReason: ''
    });
  },

  closeEditAmountModal() {
    this.setData({ showEditAmountModal: false });
  },

  onEditAmountInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`editAmountForm.${field}`]: e.detail.value });
  },

  onEditAmountReasonInput(e) {
    this.setData({ editAmountReason: e.detail.value });
  },

  confirmEditAmount() {
    if (!this.data.currentUser || this.data.currentUser.role !== 'worker') {
      return wx.showToast({ title: '仅师傅可修改金额', icon: 'none' });
    }

    const reason = this.data.editAmountReason.trim();
    if (!reason) {
      return wx.showToast({ title: '请填写修改原因', icon: 'none' });
    }

    const { cash, wechat, alipay, totalAmount } = this.data.editAmountForm;
    const c = parseFloat(cash) || 0;
    const w = parseFloat(wechat) || 0;
    const a = parseFloat(alipay) || 0;
    const newPaidTotal = c + w + a;
    const newTotalAmount = this.data.order.dealType === 'prepay' ? (parseFloat(totalAmount) || 0) : newPaidTotal;
    const newBalance = Math.max(0, newTotalAmount - newPaidTotal);

    // 有尾款 -> 已派单（进行中）；尾款为0 -> 已完工
    const newStatus = (this.data.order.dealType === 'prepay' && newBalance > 0) ? '已派单' : '已完工';

    const oldS = this.data.order.settlement || {};
    const timeStr = getTimeString();
    const opName = (this.data.currentUser && this.data.currentUser.name) || '师傅';

    const changeText = `实收由 ¥${oldS.paidTotal || 0} 调整为 ¥${newPaidTotal} (微信:¥${w}, 支付宝:¥${a}, 现金:¥${c})${this.data.order.dealType === 'prepay' ? '，待收尾款:¥' + newBalance : ''}`;

    const newLog = {
      time: timeStr,
      operator: opName,
      changeText: changeText,
      reason: reason
    };

    const newSettlement = {
      ...oldS,
      cash: c,
      wechat: w,
      alipay: a,
      paidTotal: newPaidTotal,
      totalAmount: newTotalAmount,
      balanceAmount: newBalance
    };

    const systemFeedback = {
      id: 'fb_' + Date.now(),
      authorName: opName,
      authorRole: 'worker',
      content: `💰 【修改金额】${changeText}（原因：${reason}）`,
      createTime: timeStr,
      isSystem: true
    };

    wx.showLoading({ title: '正在更新金额...' });
    const db = wx.cloud.database();
    db.collection('orders').doc(this.data.orderId).update({
      data: {
        status: newStatus,
        settlement: newSettlement,
        amountChangeLogs: [newLog, ...(this.data.order.amountChangeLogs || [])],
        feedbacks: [systemFeedback, ...(this.data.order.feedbacks || [])]
      }
    }).then(() => {
      wx.hideLoading();
      this.setData({ showEditAmountModal: false });
      this.loadOrderDetail();
      wx.showToast({ title: '金额已修改', icon: 'success' });
    }).catch(err => {
      console.error(err);
      wx.hideLoading();
    });
  },

  // ===================== D. 追加拍照与留痕 =====================
  appendMorePhotos() {
    if (!this.data.currentUser || this.data.currentUser.role !== 'worker') {
      return wx.showToast({ title: '仅师傅可追加拍照', icon: 'none' });
    }

    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        wx.showLoading({ title: '正在追加上传...' });
        const uploadedIDs = [];
        for (let i = 0; i < res.tempFiles.length; i++) {
          const filePath = res.tempFiles[i].tempFilePath;
          const cloudPath = `orders/${this.data.orderId}/append_${Date.now()}_${i}.jpg`;
          const uploadRes = await wx.cloud.uploadFile({ cloudPath, filePath });
          uploadedIDs.push(uploadRes.fileID);
        }

        const currentPhotos = (this.data.order.settlement && this.data.order.settlement.photos) || [];
        const updatedPhotos = [...currentPhotos, ...uploadedIDs];

        const timeStr = getTimeString();
        const opName = (this.data.currentUser && this.data.currentUser.name) || '师傅';

        const newPhotoLog = {
          time: timeStr,
          operator: opName,
          note: `追加上传了 ${uploadedIDs.length} 张现场照片`
        };

        const systemFeedback = {
          id: 'fb_' + Date.now(),
          authorName: opName,
          authorRole: 'worker',
          content: `📷 追加上传了 ${uploadedIDs.length} 张现场照片/凭证`,
          createTime: timeStr,
          isSystem: true
        };

        const db = wx.cloud.database();
        await db.collection('orders').doc(this.data.orderId).update({
          data: {
            'settlement.photos': updatedPhotos,
            photoChangeLogs: [newPhotoLog, ...(this.data.order.photoChangeLogs || [])],
            feedbacks: [systemFeedback, ...(this.data.order.feedbacks || [])]
          }
        });

        wx.hideLoading();
        this.loadOrderDetail();
        wx.showToast({ title: '照片已追加', icon: 'success' });
      }
    });
  },

  // ===================== E. 客服追加催单 =====================
  openUrgeModal() {
    if (!this.data.currentUser || this.data.currentUser.role !== 'service') {
      return wx.showToast({ title: '仅客服可发起催单', icon: 'none' });
    }
    this.setData({ showUrgeModal: true, urgeReason: '' });
  },

  closeUrgeModal() {
    this.setData({ showUrgeModal: false });
  },

  onUrgeReasonInput(e) {
    this.setData({ urgeReason: e.detail.value });
  },

  submitUrgeOrder() {
    if (!this.data.currentUser || this.data.currentUser.role !== 'service') {
      return wx.showToast({ title: '仅客服可发起催单', icon: 'none' });
    }

    const reason = this.data.urgeReason.trim() || '客户催促尽快上门处理';
    wx.showLoading({ title: '正在发送催单...' });
    const timeStr = getTimeString();
    const opName = (this.data.currentUser && this.data.currentUser.name) || '客服';

    const systemFeedback = {
      id: 'fb_' + Date.now(),
      authorName: opName,
      authorRole: 'service',
      content: `🔥 【客户催单】${reason}`,
      createTime: timeStr,
      isSystem: true
    };

    const db = wx.cloud.database();
    db.collection('orders').doc(this.data.orderId).update({
      data: {
        isUrgent: true,
        urgentAccepted: false,
        feedbacks: [systemFeedback, ...(this.data.order.feedbacks || [])]
      }
    }).then(() => {
      wx.hideLoading();
      this.setData({ showUrgeModal: false });
      this.loadOrderDetail();
      wx.showToast({ title: '催单已发送', icon: 'success' });
    }).catch(err => {
      console.error(err);
      wx.hideLoading();
      wx.showToast({ title: '发送失败，请重试', icon: 'none' });
    });
  },

  // ===================== F. 预约时间修改与派单 =====================
  openChangeTimeModal() {
    this.setData({
      showTimeModal: true,
      modalNewTime: this.data.order.appointmentTime || '',
      modalChangeReason: ''
    });
  },

  closeChangeTimeModal() {
    this.setData({ showTimeModal: false });
  },

  onModalTimeInput(e) {
    this.setData({ modalNewTime: e.detail.value });
  },

  onModalTimeBlur(e) {
    const formatted = smartFormatTime(e.detail.value);
    if (formatted !== e.detail.value) {
      this.setData({ modalNewTime: formatted });
    }
  },

  onModalReasonInput(e) {
    this.setData({ modalChangeReason: e.detail.value });
  },

  confirmChangeTime() {
    const newTime = smartFormatTime(this.data.modalNewTime);
    if (!newTime) return wx.showToast({ title: '请输入有效时间', icon: 'none' });

    const oldTime = this.data.order.appointmentTime;
    if (newTime === oldTime) return wx.showToast({ title: '新时间与原时间一致', icon: 'none' });

    const timeStr = getTimeString();
    const opName = (this.data.currentUser && this.data.currentUser.name) || '客服';

    const logItem = {
      oldTime,
      newTime,
      operator: opName,
      changeTime: timeStr,
      reason: this.data.modalChangeReason.trim()
    };

    const systemFeedback = {
      id: 'fb_' + Date.now(),
      authorName: opName,
      authorRole: (this.data.currentUser && this.data.currentUser.role) || 'service',
      content: `【修改预约时间】由「${oldTime}」调整为「${newTime}」${logItem.reason ? '（原因：' + logItem.reason + '）' : ''}`,
      createTime: timeStr,
      isSystem: true
    };

    wx.showLoading({ title: '正在更新时间...' });
    const db = wx.cloud.database();
    db.collection('orders').doc(this.data.orderId).update({
      data: {
        appointmentTime: newTime,
        timeChangeLogs: [logItem, ...(this.data.order.timeChangeLogs || [])],
        feedbacks: [systemFeedback, ...(this.data.order.feedbacks || [])]
      }
    }).then(() => {
      wx.hideLoading();
      this.setData({ showTimeModal: false });
      this.loadOrderDetail();
      wx.showToast({ title: '时间已更新', icon: 'success' });
    }).catch(() => wx.hideLoading());
  },

  onAssignWorker(e) {
    const selected = this.data.workerList[e.detail.value];
    const db = wx.cloud.database();
    wx.showLoading({ title: '正在指派...' });
    db.collection('orders').doc(this.data.orderId).update({
      data: {
        workerName: selected.name,
        workerPhone: selected.phone,
        status: '已派单'
      }
    }).then(() => {
      wx.hideLoading();
      this.loadOrderDetail();
      wx.showToast({ title: '已指派给 ' + selected.name, icon: 'success' });
    }).catch(() => wx.hideLoading());
  },

  editOrderRemark() {
    wx.showModal({
      title: '修改订单备注',
      editable: true,
      content: this.data.order.remark || '',
      placeholderText: '请输入新的备注内容',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '更新中...' });
          const db = wx.cloud.database();
          db.collection('orders').doc(this.data.orderId).update({
            data: { remark: res.content }
          }).then(() => {
            wx.hideLoading();
            this.loadOrderDetail();
            wx.showToast({ title: '备注已更新' });
          }).catch(() => wx.hideLoading());
        }
      }
    });
  },

  onFeedbackInput(e) {
    this.setData({ newFeedback: e.detail.value });
  },

  submitFeedback() {
    const text = this.data.newFeedback.trim();
    if (!text) return wx.showToast({ title: '反馈内容不能为空', icon: 'none' });

    const timeStr = getTimeString();
    const newFbItem = {
      id: 'fb_' + Date.now(),
      authorName: (this.data.currentUser && this.data.currentUser.name) || '员工',
      authorRole: (this.data.currentUser && this.data.currentUser.role) || 'worker',
      content: text,
      createTime: timeStr,
      isSystem: false
    };

    wx.showLoading({ title: '正在提交...' });
    const db = wx.cloud.database();
    db.collection('orders').doc(this.data.orderId).update({
      data: { feedbacks: [newFbItem, ...(this.data.order.feedbacks || [])] }
    }).then(() => {
      wx.hideLoading();
      this.setData({ newFeedback: '' });
      this.loadOrderDetail();
      wx.showToast({ title: '反馈已录入', icon: 'success' });
    }).catch(() => wx.hideLoading());
  },

  editFeedback(e) {
    const id = e.currentTarget.dataset.id;
    const oldContent = e.currentTarget.dataset.content;

    wx.showModal({
      title: '修改反馈内容',
      editable: true,
      content: oldContent,
      placeholderText: '修改反馈内容',
      success: (res) => {
        if (res.confirm && res.content) {
          const updated = this.data.order.feedbacks.map(f => f.id === id ? { ...f, content: res.content } : f);
          wx.showLoading({ title: '正在修改...' });
          const db = wx.cloud.database();
          db.collection('orders').doc(this.data.orderId).update({
            data: { feedbacks: updated }
          }).then(() => {
            wx.hideLoading();
            this.loadOrderDetail();
            wx.showToast({ title: '修改成功' });
          }).catch(() => wx.hideLoading());
        }
      }
    });
  }
});