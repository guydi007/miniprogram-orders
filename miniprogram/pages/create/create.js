const app = getApp();

function getTimeString() {
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// 智能时间与时段补齐函数
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

  // 纯数字匹配支持
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
    currentUser: null,
    customerPhone: '',
    address: '',
    appointmentTime: '',
    source: '悦乐居',
    remark: ''
  },

  onLoad() {
    const cachedUser = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    this.setData({ currentUser: cachedUser });
  },

  // 预约时间快捷点选
  setQuickTime(e) {
    const val = e.currentTarget.dataset.val;
    const formatted = smartFormatTime(val);
    this.setData({ appointmentTime: formatted });
  },

  onAppointmentTimeInput(e) {
    this.setData({ appointmentTime: e.detail.value });
  },

  onAppointmentTimeBlur(e) {
    const formatted = smartFormatTime(e.detail.value);
    if (formatted !== e.detail.value) {
      this.setData({ appointmentTime: formatted });
    }
  },

  // 表单字段输入
  onPhoneInput(e) {
    this.setData({ customerPhone: (e.detail.value || '').trim() });
  },

  onAddressInput(e) {
    this.setData({ address: e.detail.value.trim() });
  },

  onSourceInput(e) {
    this.setData({ source: e.detail.value.trim() });
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value.trim() });
  },

  // 兼容性通用 input 处理器
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    if (field) {
      this.setData({ [field]: e.detail.value.trim() });
    }
  },

  // 提交工单
  async submitOrder() {
    const { customerPhone, address, appointmentTime, source, remark, currentUser } = this.data;

    const cleanPhone = (customerPhone || '').trim();
    const isPhoneValid = /^1[3-9]\d{9}$/.test(cleanPhone) || /^(\d{3,4}-?)?\d{7,8}$/.test(cleanPhone);

    if (!cleanPhone || !isPhoneValid) {
      return wx.showToast({ title: '请填写正确的客户电话', icon: 'none' });
    }
    if (!address) {
      return wx.showToast({ title: '请填写服务地址', icon: 'none' });
    }
    if (!appointmentTime) {
      return wx.showToast({ title: '请填写预约时间', icon: 'none' });
    }

    const timeStr = getTimeString();
    const serviceName = (currentUser && currentUser.name) || '客服';

    const newOrder = {
      customerPhone: cleanPhone,
      phone: cleanPhone, // 兼容字段
      address: address,
      appointmentTime: appointmentTime,
      time: appointmentTime, // 兼容字段
      source: source || '其他渠道',
      remark: remark || '',
      serviceName: serviceName,
      workerName: '', // 初始为待派单
      workerPhone: '',
      status: '待派单',
      createTime: timeStr,
      feedbacks: [
        {
          id: 'fb_' + Date.now(),
          authorName: serviceName,
          authorRole: (currentUser && currentUser.role) || 'service',
          content: '创建工单（待派单）',
          createTime: timeStr,
          isSystem: true
        }
      ]
    };

    wx.showLoading({ title: '正在创建工单...' });
    const db = wx.cloud.database();

    try {
      await db.collection('orders').add({
        data: newOrder
      });

      wx.hideLoading();
      wx.showToast({
        title: '录单成功！',
        icon: 'success',
        duration: 1500,
        success: () => {
          setTimeout(() => {
            wx.navigateBack();
          }, 1500);
        }
      });
    } catch (err) {
      console.error('录单失败：', err);
      wx.hideLoading();
      wx.showToast({ title: '录单失败，请重试', icon: 'none' });
    }
  }
});