const app = getApp();

// 业务日期统一按北京时间（UTC+8）解释，避免日本等时区在午夜附近把“今天/明天”算错。
const BUSINESS_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
function businessDateString(offsetDays = 0) {
  const shifted = new Date(Date.now() + BUSINESS_TZ_OFFSET_MS + offsetDays * 86400000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 智能转换相对时间为具体日期（如：今天 上午 -> 2026-09-10 上午）
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
    currentUser: null,

    availableCities: [],
    permittedCities: [], // 严格兼容 create.wxml
    cityIndex: 0,
    selectedCity: '',

    sources: [{ name: '抖音' }, { name: '美团' }, { name: '转介绍' }],
    sourceNames: ['抖音', '美团', '转介绍'],
    sourceOptions: ['抖音', '美团', '转介绍'], // 严格兼容 create.wxml
    sourceIndex: 0,
    selectedSource: '抖音',

    workers: [],
    workerNames: ['暂不指派（保持待派单）'],
    workerIndex: 0,
    currentWorkerGroup: '',

    customerPhone: '',
    address: '',
    appointmentTime: '',
    totalAmount: '',
    
    // 双向字段绑定，防止备注丢失
    feedback: '',
    initialFeedback: '',
    
    isSubmitting: false
  },

  onLoad() {
    const user = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    
    if (!user || !['service', 'leader'].includes(user.role)) {
      wx.showToast({ title: '当前账号无录单权限', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }

    this.setData({ currentUser: user }, () => {
      this.loadCities();
      this.loadSources();
    });
  },

  async loadCities() {
    const user = this.data.currentUser;
    let allCities = [];
    try {
      const res = await wx.cloud.callFunction({ name: 'manageOrder', data: { action: 'getCities' } });
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || 'CITIES_UNAVAILABLE');
      allCities = (result.cities || []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
      if (allCities.length) {
        wx.setStorageSync('availableCities', allCities);
        if (app.globalData) app.globalData.availableCities = allCities;
      }
    } catch (error) {
      console.warn('拉取城市失败，使用本地缓存：', error);
      allCities = wx.getStorageSync('availableCities') || [];
    }

    let userCities = [];
    if (user) {
      if (Array.isArray(user.cities)) userCities = user.cities;
      else if (user.cities && typeof user.cities === 'object') userCities = Object.values(user.cities);
      else if (typeof user.cities === 'string' && user.cities) userCities = [user.cities];
    }
    userCities = userCities.filter(c => c && typeof c === 'string');

    let finalCities = [];
    if (user && user.role !== 'admin' && userCities.length > 0) {
      finalCities = allCities.filter(c => userCities.includes(c));
      if (finalCities.length === 0) finalCities = userCities;
    }

    this.setData({
      availableCities: finalCities,
      permittedCities: finalCities,
      cityIndex: 0,
      selectedCity: finalCities[0] || ''
    }, () => {
      if (!finalCities.length) {
        wx.showToast({ title: '当前账号未配置城市权限', icon: 'none' });
        this.setData({ workers: [], workerNames: ['暂不指派（保持待派单）'], workerIndex: 0 });
        return;
      }
      if (user && user.role === 'leader') this.loadWorkers();
    });
  },

  loadSources() {
    wx.cloud.callFunction({ name: 'manageOrder', data: { action: 'getSources' } }).then(res => {
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || 'SOURCES_UNAVAILABLE');
      let list = result.sources || [];
      if (list.length === 0) list = [{ name: '抖音' }, { name: '美团' }, { name: '转介绍' }];
      const names = list.map(s => typeof s === 'string' ? s : s.name).filter(Boolean);
      if (names.length) wx.setStorageSync('availableSources', names);
      this.setData({
        sources: list,
        sourceNames: names,
        sourceOptions: names,
        sourceIndex: 0,
        selectedSource: names[0] || ''
      });
    }).catch(err => {
      console.warn('拉取渠道失败，使用兜底配置：', err);
      const fallback = wx.getStorageSync('availableSources') || ['抖音', '美团', '转介绍'];
      this.setData({
        sources: fallback.map(n => ({ name: n })),
        sourceNames: fallback,
        sourceOptions: fallback,
        sourceIndex: 0,
        selectedSource: fallback[0]
      });
    });
  },

  onCityChange(e) {
    const idx = Number(e.detail.value) || 0;
    const list = this.data.availableCities || [];
    this.setData({
      cityIndex: idx,
      selectedCity: list[idx] || ''
    }, () => {
      const user = this.data.currentUser;
      if (user && user.role === 'leader') this.loadWorkers();
    });
  },

  onSourceChange(e) {
    const idx = Number(e.detail.value) || 0;
    const list = this.data.sourceNames || [];
    this.setData({
      sourceIndex: idx,
      selectedSource: list[idx] || ''
    });
  },

  onWorkerChange(e) {
    const idx = Number(e.detail.value) || 0;
    let groupId = '';
    if (idx > 0 && this.data.workers[idx - 1]) {
      groupId = this.data.workers[idx - 1].groupId || '';
    }
    this.setData({
      workerIndex: idx,
      currentWorkerGroup: groupId
    });
  },

  onPhoneInput(e) {
    this.setData({ customerPhone: (e.detail.value || '').trim() });
  },

  onAddressInput(e) {
    this.setData({ address: (e.detail.value || '').trim() });
  },

  onTimeInput(e) {
    this.setData({ appointmentTime: e.detail.value });
  },

  onTimeBlur(e) {
    const val = (e.detail.value || '').trim();
    const formatted = parseDateSmart(val);
    this.setData({ appointmentTime: formatted });
  },

  onQuickTime(e) {
    const val = e.currentTarget.dataset.val;
    const formatted = parseDateSmart(val);
    this.setData({ appointmentTime: formatted });
  },

  // 兼容 WXML 中的 bindinput="onFeedbackInput"
  onFeedbackInput(e) {
    const val = (e.detail.value || '').trim();
    this.setData({ feedback: val, initialFeedback: val });
  },

  // 兼容 WXML 中的 bindinput="onInitialFeedbackInput"
  onInitialFeedbackInput(e) {
    const val = (e.detail.value || '').trim();
    this.setData({ feedback: val, initialFeedback: val });
  },

  async submitOrder() {
    if (this.data.isSubmitting) return;

    const { availableCities, cityIndex, customerPhone, address, appointmentTime, sourceNames, sourceIndex, workers, workerIndex, totalAmount, feedback, initialFeedback, currentUser } = this.data;

    const city = availableCities[cityIndex] || this.data.selectedCity || '';
    const source = sourceNames[sourceIndex] || this.data.selectedSource || '默认渠道';
    const finalAppointmentTime = parseDateSmart(appointmentTime) || appointmentTime;
    const finalFeedback = feedback || initialFeedback || '';

    if (!city) {
      return wx.showToast({ title: '当前账号没有可录单城市', icon: 'none' });
    }
    if (!/^1\d{10}$/.test(customerPhone)) {
      return wx.showToast({ title: '请输入正确的11位客户手机号', icon: 'none' });
    }
    if (!address) {
      return wx.showToast({ title: '请输入服务地址', icon: 'none' });
    }
    if (!finalAppointmentTime) {
      return wx.showToast({ title: '请输入预约时间', icon: 'none' });
    }

    let status = '待派单';
    let workerId = '';
    let workerName = '';
    let workerPhone = '';
    let workerGroupId = '';

    if (workerIndex > 0 && workers[workerIndex - 1]) {
      const selectedWorker = workers[workerIndex - 1];
      status = '已派单';
      workerId = selectedWorker._id || '';
      workerName = selectedWorker.name;
      workerPhone = selectedWorker.phone || '';
      workerGroupId = selectedWorker.groupId || '';
    }

    const createFingerprint = JSON.stringify({
      city, customerPhone, address, appointmentTime: finalAppointmentTime, source,
      workerId, workerPhone, totalAmount: totalAmount ? Number(totalAmount) : 0,
      feedback: finalFeedback
    });
    if (!this._createOperation || this._createOperation.fingerprint !== createFingerprint) {
      this._createOperation = {
        id: 'create_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10),
        fingerprint: createFingerprint
      };
    }
    const createOperationId = this._createOperation.id;

    this.setData({ isSubmitting: true });
    wx.showLoading({ title: '正在提交订单...' });

    const orderData = {
      city: city,
      customerPhone: customerPhone,
      address: address,
      appointmentTime: finalAppointmentTime,
      source: source,
      status: status,
      workerId: workerId,
      workerName: workerName,
      workerPhone: workerPhone,
      totalAmount: totalAmount ? Number(totalAmount) : 0,
      paidAmount: 0,
      pendingBalance: 0,
      // 审计字段由服务端生成，客户端只提交录单备注正文。
      initialFeedback: finalFeedback,
    };

    try {
      const res = await wx.cloud.callFunction({ name: 'manageOrder', data: { action: 'createOrder', data: { ...orderData, createOperationId } } });
      if (!res.result || !res.result.success) throw new Error((res.result && res.result.msg) || '云端拒绝录单');
      wx.hideLoading();
      this.setData({ isSubmitting: false });
      const isDuplicate = res.result.duplicate === true;
      const notification = res.result.notification;
      this._createOperation = null;
      if (isDuplicate) {
        wx.showToast({ title: '工单已存在，未重复创建', icon: 'none' });
      } else if (notification && notification.success) {
        wx.showToast({ title: '录单成功，主管已通知', icon: 'none' });
      } else {
        const eventId = res.result.eventId || '未知';
        const code = notification && notification.code;
        const reason = code === 'NO_GROUP_CONFIGURED'
          ? '没有找到该城市已启用的正式入单群配置。'
          : code === 'NO_TEST_GROUP_CONFIGURED'
            ? '这是测试账号，但没有找到该城市已启用的测试入单群配置。'
            : code === 'NOTIFICATION_PROCESSING_FAILED'
              ? '云端处理群通知时发生异常，请管理员根据事件编号查看云函数日志。'
              : `群通知状态：${(notification && notification.status) || '未确认'}${code ? `（${code}）` : ''}。请管理员根据事件编号检查投递记录。`;
        await new Promise(resolve => wx.showModal({ title: '工单已保存', content: `${reason}\n事件编号：${eventId}\n请勿重复录单。`, showCancel: false, success: resolve, fail: resolve }));
      }
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (err) {
      console.error('录单异常：', err);
      wx.hideLoading();
      this.setData({ isSubmitting: false });
      wx.showToast({ title: '录单失败，请重试', icon: 'none' });
    }
  }
});
