const app = getApp();

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
    currentUser: null,
    permittedCities: ['天津', '北京'],
    cityIndex: 0,

    allWorkers: [],
    workerNames: ['暂不指派'],
    workerIndex: 0,
    currentWorkerGroup: '',

    customerPhone: '',
    address: '',
    appointmentTime: '',
    source: '',
    initialFeedback: '' // 🌟 纯文本初始回馈
  },

  onLoad() {
    const user = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    let allCities = wx.getStorageSync('availableCities') || (app.globalData && app.globalData.availableCities) || ['天津', '北京'];

    let permitted = allCities;
    if (user && user.role !== 'admin' && user.cities && user.cities.length) {
      permitted = allCities.filter(c => user.cities.includes(c));
    }
    if (!permitted.length) permitted = ['天津'];

    this.setData({
      currentUser: user,
      permittedCities: permitted,
      cityIndex: 0
    });

    if (user && user.role === 'admin') {
      this.fetchWorkers();
    }
  },

  async fetchWorkers() {
    const db = wx.cloud.database();
    try {
      const res = await db.collection('users').where({ role: 'worker' }).get();
      const workers = res.data || [];
      this.setData({ allWorkers: workers }, () => {
        this.filterWorkersByCity();
      });
    } catch (e) {
      console.error('拉取师傅列表失败：', e);
    }
  },

  filterWorkersByCity() {
    const currentCity = this.data.permittedCities[this.data.cityIndex];
    const matchWorkers = this.data.allWorkers.filter(w => !w.cities || w.cities.includes(currentCity));
    const names = ['暂不指派', ...matchWorkers.map(w => w.name)];

    this.setData({
      workerNames: names,
      workerIndex: 0,
      currentWorkerGroup: ''
    });
  },

  onCityChange(e) {
    this.setData({ cityIndex: Number(e.detail.value) }, () => {
      if (this.data.currentUser && this.data.currentUser.role === 'admin') {
        this.filterWorkersByCity();
      }
    });
  },

  onWorkerChange(e) {
    const idx = Number(e.detail.value);
    const currentCity = this.data.permittedCities[this.data.cityIndex];
    const matchWorkers = this.data.allWorkers.filter(w => !w.cities || w.cities.includes(currentCity));

    let group = '';
    if (idx > 0) {
      const selected = matchWorkers[idx - 1];
      group = selected ? (selected.groupId || '') : '';
    }

    this.setData({
      workerIndex: idx,
      currentWorkerGroup: group
    });
  },

  onPhoneInput(e) {
    this.setData({ customerPhone: e.detail.value.trim() });
  },

  onAddressInput(e) {
    this.setData({ address: e.detail.value.trim() });
  },

  onTimeInput(e) {
    this.setData({ appointmentTime: e.detail.value });
  },

  onTimeBlur(e) {
    const formatted = parseDateSmart(e.detail.value);
    this.setData({ appointmentTime: formatted });
  },

  onQuickTime(e) {
    const raw = e.currentTarget.dataset.val;
    const formatted = parseDateSmart(raw);
    this.setData({ appointmentTime: formatted });
  },

  onSourceInput(e) {
    this.setData({ source: e.detail.value.trim() });
  },

  onInitialFeedbackInput(e) {
    this.setData({ initialFeedback: e.detail.value.trim() });
  },

  async submitOrder() {
    let { permittedCities, cityIndex, customerPhone, address, appointmentTime, source, workerIndex, currentUser, initialFeedback } = this.data;
    appointmentTime = parseDateSmart(appointmentTime);

    if (!customerPhone || customerPhone.length < 11) {
      return wx.showToast({ title: '请输入正确的11位电话', icon: 'none' });
    }
    if (!address) {
      return wx.showToast({ title: '请输入服务地址', icon: 'none' });
    }
    if (!appointmentTime) {
      return wx.showToast({ title: '请输入预约时间', icon: 'none' });
    }

    const currentCity = permittedCities[cityIndex];
    let workerName = '';
    let workerPhone = '';
    let workerGroupId = '';

    if (currentUser && currentUser.role === 'admin' && workerIndex > 0) {
      const matchWorkers = this.data.allWorkers.filter(w => !w.cities || w.cities.includes(currentCity));
      const w = matchWorkers[workerIndex - 1];
      if (w) {
        workerName = w.name;
        workerPhone = w.phone;
        workerGroupId = w.groupId || '';
      }
    }

    const creatorName = (currentUser && currentUser.name) || '员工';
    const creatorPhone = (currentUser && currentUser.phone) || '';
    const creatorRole = (currentUser && currentUser.role) || '';

    // 🌟 将纯文本回馈直接作为第一条回馈记录
    const initialFeedbacks = [];
    if (initialFeedback) {
      const now = new Date();
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      const timeFormatted = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      initialFeedbacks.push({
        id: 'fb_' + Date.now(),
        time: now.toISOString(),
        timeFormatted: timeFormatted,
        operatorName: creatorName,
        operatorRole: creatorRole,
        content: initialFeedback,
        photos: []
      });
    }

    wx.showLoading({ title: '正在录入...' });
    const db = wx.cloud.database();

    try {
      await db.collection('orders').add({
        data: {
          city: currentCity,
          customerPhone: customerPhone,
          address: address,
          appointmentTime: appointmentTime,
          appointmentLogs: [],
          workerName: workerName,
          workerPhone: workerPhone,
          workerGroupId: workerGroupId,
          companionWorkers: '',
          finalAmount: 0,
          finishPhotos: [],
          finishNote: '',
          source: source || '手工录入',
          status: workerName ? '已派单' : '待派单',
          isUrgent: false,
          creatorName: creatorName,
          creatorPhone: creatorPhone,
          creatorRole: creatorRole,
          feedbacks: initialFeedbacks,
          paymentLogs: [],
          createTime: new Date().toISOString()
        }
      });

      wx.hideLoading();
      wx.showToast({ title: '录入成功', icon: 'success' });
      setTimeout(() => {
        wx.navigateBack();
      }, 1000);
    } catch (err) {
      console.error(err);
      wx.hideLoading();
      wx.showToast({ title: '录单失败，请重试', icon: 'none' });
    }
  }
});