const app = getApp();

// 智能转换相对时间为具体日期（如：今天 上午 -> 2026-09-10 上午）
function parseDateSmart(text) {
  if (!text) return '';
  let str = String(text).trim();

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
    currentUser: null,

    availableCities: ['天津', '北京'],
    permittedCities: ['天津', '北京'], // 严格兼容 create.wxml
    cityIndex: 0,
    selectedCity: '天津',

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
    
    if (user && user.role === 'admin') {
      wx.showToast({ title: '管理员无录单权限', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }

    this.setData({ currentUser: user }, () => {
      this.loadCities();
      this.loadSources();
      if (user && user.role === 'leader') this.loadWorkers();
    });
  },

  loadCities() {
    let allCities = wx.getStorageSync('availableCities') || ['天津', '北京'];
    const user = this.data.currentUser;

    let userCities = [];
    if (user) {
      if (Array.isArray(user.cities)) userCities = user.cities;
      else if (user.cities && typeof user.cities === 'object') userCities = Object.values(user.cities);
      else if (typeof user.cities === 'string' && user.cities) userCities = [user.cities];
    }
    userCities = userCities.filter(c => c && typeof c === 'string');

    let finalCities = allCities;
    if (user && user.role !== 'admin' && userCities.length > 0) {
      finalCities = allCities.filter(c => userCities.includes(c));
      if (finalCities.length === 0) finalCities = userCities;
    }
    if (!finalCities || finalCities.length === 0) {
      finalCities = ['天津', '北京'];
    }

    this.setData({
      availableCities: finalCities,
      permittedCities: finalCities,
      cityIndex: 0,
      selectedCity: finalCities[0]
    });
  },

  loadSources() {
    const db = wx.cloud.database();
    db.collection('order_sources').orderBy('sort', 'asc').get().then(res => {
      let list = res.data || [];
      if (list.length === 0) {
        list = [{ name: '抖音' }, { name: '美团' }, { name: '转介绍' }];
      }
      const names = list.map(s => (typeof s === 'string' ? s : s.name));
      this.setData({
        sources: list,
        sourceNames: names,
        sourceOptions: names,
        sourceIndex: 0,
        selectedSource: names[0]
      });
    }).catch(err => {
      console.warn('拉取渠道失败，使用兜底配置：', err);
      const fallback = ['抖音', '美团', '转介绍', '其他'];
      this.setData({
        sources: fallback.map(n => ({ name: n })),
        sourceNames: fallback,
        sourceOptions: fallback,
        sourceIndex: 0,
        selectedSource: fallback[0]
      });
    });
  },

  loadWorkers() {
    wx.cloud.callFunction({ name: 'manageOrder', data: { action: 'getWorkers' } }).then(res => {
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || 'WORKERS_UNAVAILABLE');
      const workers = result.workers || [];
      const workerNames = ['暂不指派（保持待派单）', ...workers.map(w => w.name + (w.role === 'leader' ? ' [主管]' : '') + (w.groupId ? ` (${w.groupId})` : ''))];
      this.setData({
        workers: workers,
        workerNames: workerNames,
        workerIndex: 0,
        currentWorkerGroup: ''
      });
    }).catch(err => console.error('获取师傅列表失败：', err));
  },

  onCityChange(e) {
    const idx = Number(e.detail.value) || 0;
    const list = this.data.availableCities || [];
    this.setData({
      cityIndex: idx,
      selectedCity: list[idx] || ''
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

    const city = availableCities[cityIndex] || this.data.selectedCity || '天津';
    const source = sourceNames[sourceIndex] || this.data.selectedSource || '默认渠道';
    const finalAppointmentTime = parseDateSmart(appointmentTime) || appointmentTime;
    const finalFeedback = feedback || initialFeedback || '';

    if (!customerPhone || customerPhone.length < 7) {
      return wx.showToast({ title: '请输入正确的客户电话', icon: 'none' });
    }
    if (!address) {
      return wx.showToast({ title: '请输入服务地址', icon: 'none' });
    }
    if (!finalAppointmentTime) {
      return wx.showToast({ title: '请输入预约时间', icon: 'none' });
    }

    let status = '待派单';
    let workerName = '';
    let workerPhone = '';
    let workerGroupId = '';

    if (workerIndex > 0 && workers[workerIndex - 1]) {
      const selectedWorker = workers[workerIndex - 1];
      status = '已派单';
      workerName = selectedWorker.name;
      workerPhone = selectedWorker.phone || '';
      workerGroupId = selectedWorker.groupId || '';
    }

    // 锁定当前登录客服姓名，彻底杜绝业绩被误挂到 0 号员工名下
    const creatorName = (currentUser && currentUser.name) ? currentUser.name : '客服';

    this.setData({ isSubmitting: true });
    wx.showLoading({ title: '正在提交订单...' });

    const orderData = {
      city: city,
      customerPhone: customerPhone,
      address: address,
      appointmentTime: finalAppointmentTime,
      source: source,
      status: status,
      workerName: workerName,
      workerPhone: workerPhone,
      workerGroupId: workerGroupId,
      totalAmount: totalAmount ? Number(totalAmount) : 0,
      paidAmount: 0,
      pendingBalance: 0,
      feedbacks: finalFeedback ? [{
        time: new Date().toISOString().replace('T', ' ').substring(0, 16),
        author: creatorName,
        content: `【录单回馈】${finalFeedback}`,
        images: []
      }] : [],
    };

    try {
      const res = await wx.cloud.callFunction({ name: 'manageOrder', data: { action: 'createOrder', data: orderData } });
      if (!res.result || !res.result.success) throw new Error((res.result && res.result.msg) || '云端拒绝录单');
      wx.hideLoading();
      this.setData({ isSubmitting: false });
      const notification = res.result.notification;
      if (notification && notification.success) {
        wx.showToast({ title: '录单成功，主管已通知', icon: 'none' });
      } else {
        await new Promise(resolve => wx.showModal({ title: '工单已保存', content: '主管提醒未全部发送成功，可能未订阅或模板未配置。请联系主管查看，不要重复录单。', showCancel: false, success: resolve, fail: resolve }));
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
