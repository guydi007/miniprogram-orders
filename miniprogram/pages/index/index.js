const app = getApp();
const URGENT_TEMPLATE_ID = 'h2xwE4YRkuI4r-DmVqJHVpN_l_YSTdKMutIg0Lmwrug';

Page({
  data: {
    currentUser: null,
    orders: [],
    filteredOrders: [],
    searchKey: '',

    // Tab 栏配置
    currentTab: 'all',
    tabList: [
      { key: 'all', label: '全部' },
      { key: '待派单', label: '待派单' },
      { key: '已派单', label: '进行中' },
      { key: '已完工', label: '已完工' },
      { key: '未成单', label: '未成单' }
    ],
    statusCounts: {
      all: 0,
      '待派单': 0,
      '已派单': 0,
      '已完工': 0,
      '未成单': 0
    },

    // 手机号核验弹窗
    showPhoneModal: false,
    inputPhone: '',

    // 添加新员工弹窗
    showAddUserModal: false,
    newUserName: '',
    newUserPhone: '',
    newUserRole: 'worker',

    // 定时器
    urgentTimer: null
  },

  onLoad() {
    // 1. 优先读取持久化存储
    const cachedUser = wx.getStorageSync('currentUser');
    if (cachedUser && cachedUser.phone) {
      this.handleUserLoaded(cachedUser);
      return;
    }

    // 2. 监听全局登录结果
    if (app.globalData && app.globalData.currentUser) {
      this.handleUserLoaded(app.globalData.currentUser);
    } else {
      app.authReadyCallback = (user) => {
        if (user && user.phone) {
          this.handleUserLoaded(user);
        } else {
          this.setData({ showPhoneModal: true });
        }
      };
    }
  },

  onReady() {
    const cachedUser = wx.getStorageSync('currentUser');
    if (!this.data.currentUser && (!cachedUser || !cachedUser.phone)) {
      this.setData({ showPhoneModal: true });
    }
  },

  onShow() {
    if (this.data.currentUser) {
      this.fetchOrders();
      this.startUrgentCheckTimer();
    }
  },

  onHide() {
    this.stopUrgentCheckTimer();
  },

  onUnload() {
    this.stopUrgentCheckTimer();
  },

  onPullDownRefresh() {
    this.fetchOrders().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  stopBubble() {},

  // 用户认证成功统一入口
  handleUserLoaded(user) {
    if (app.globalData) {
      app.globalData.currentUser = user;
    }
    this.setData({
      currentUser: user,
      showPhoneModal: false
    }, () => {
      this.fetchOrders();
      this.startUrgentCheckTimer();
    });
  },

  // 点击卡片手动触发登录/换绑
  handleUserHeaderTap() {
    this.setData({
      showPhoneModal: true,
      inputPhone: this.data.currentUser ? this.data.currentUser.phone : ''
    });
  },

  // 手机号输入绑定
  onPhoneInput(e) {
    this.setData({ inputPhone: (e.detail.value || '').trim() });
  },

  // 验证手机号并持久化登录
  async verifyAndBindPhone() {
    const phone = this.data.inputPhone;
    if (!phone || phone.length < 11) {
      return wx.showToast({ title: '请输入正确的11位手机号', icon: 'none' });
    }

    wx.showLoading({ title: '核验身份中...' });
    const db = wx.cloud.database();

    try {
      const res = await db.collection('users').where({ phone: phone }).get();
      wx.hideLoading();

      if (!res.data || res.data.length === 0) {
        return wx.showModal({
          title: '核验失败',
          content: '未找到该手机号对应的员工记录，请联系管理员录入。',
          showCancel: false
        });
      }

      const user = res.data[0];
      // 写入持久化存储
      wx.setStorageSync('currentUser', user);
      this.handleUserLoaded(user);

      wx.showToast({ title: `欢迎回来，${user.name}`, icon: 'success' });
    } catch (err) {
      console.error('核验异常：', err);
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  // 拉取工单列表
  fetchOrders() {
    return new Promise((resolve) => {
      const user = this.data.currentUser;
      if (!user || !user.phone) return resolve();

      const db = wx.cloud.database();
      wx.showNavigationBarLoading();

      db.collection('orders').orderBy('createTime', 'desc').get().then(res => {
        const allOrders = res.data || [];

        // 师傅角色数据过滤
        let filteredByRole = allOrders;
        if (user && user.role === 'worker') {
          filteredByRole = allOrders.filter(o => o.workerName === user.name || o.status === '待派单');
        }

        const counts = {
          all: filteredByRole.length,
          '待派单': filteredByRole.filter(o => o.status === '待派单').length,
          '已派单': filteredByRole.filter(o => o.status === '已派单').length,
          '已完工': filteredByRole.filter(o => o.status === '已完工').length,
          '未成单': filteredByRole.filter(o => o.status === '未成单').length
        };

        this.setData({
          orders: filteredByRole,
          statusCounts: counts
        }, () => {
          this.applyFilters();
          wx.hideNavigationBarLoading();
          resolve();
        });
      }).catch(err => {
        console.error('拉取工单失败：', err);
        wx.hideNavigationBarLoading();
        resolve();
      });
    });
  },

  // 搜索与 Tab 过滤
  applyFilters() {
    const { orders, currentTab, searchKey } = this.data;
    let list = [...orders];

    if (currentTab !== 'all') {
      list = list.filter(o => o.status === currentTab);
    }

    if (searchKey.trim()) {
      const kw = searchKey.trim().toLowerCase();
      list = list.filter(o =>
        ((o.customerPhone || o.phone || '').includes(kw)) ||
        ((o.address || '').toLowerCase().includes(kw)) ||
        ((o.workerName || '').toLowerCase().includes(kw)) ||
        ((o.appointmentTime || o.time || '').toLowerCase().includes(kw)) ||
        ((o.source || '').toLowerCase().includes(kw))
      );
    }

    // 催单优先置顶
    list.sort((a, b) => {
      const aUrgent = (a.isUrgent && !a.urgentAccepted) ? 1 : 0;
      const bUrgent = (b.isUrgent && !b.urgentAccepted) ? 1 : 0;
      return bUrgent - aUrgent;
    });

    this.setData({ filteredOrders: list });
  },

  onTabChange(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ currentTab: key }, () => {
      this.applyFilters();
    });
  },

  onSearchInput(e) {
    this.setData({ searchKey: e.detail.value }, () => {
      this.applyFilters();
    });
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  goToCreate() {
    wx.navigateTo({ url: '/pages/create/create' });
  },

  goToStats() {
    wx.navigateTo({ url: '/pages/stats/stats' });
  },

  // 管理员添加员工
  openAddUserModal() {
    this.setData({
      showAddUserModal: true,
      newUserName: '',
      newUserPhone: '',
      newUserRole: 'worker'
    });
  },

  closeAddUserModal() {
    this.setData({ showAddUserModal: false });
  },

  onNewUserNameInput(e) {
    this.setData({ newUserName: e.detail.value.trim() });
  },

  onNewUserPhoneInput(e) {
    this.setData({ newUserPhone: e.detail.value.trim() });
  },

  onNewUserRoleChange(e) {
    this.setData({ newUserRole: e.detail.value });
  },

  async submitAddUser() {
    const { newUserName, newUserPhone, newUserRole } = this.data;
    if (!newUserName) return wx.showToast({ title: '请输入姓名', icon: 'none' });
    if (!newUserPhone || newUserPhone.length < 11) return wx.showToast({ title: '请输入正确的11位手机号', icon: 'none' });

    wx.showLoading({ title: '正在录入...' });
    const db = wx.cloud.database();

    try {
      await db.collection('users').add({
        data: {
          name: newUserName,
          phone: newUserPhone,
          role: newUserRole,
          createTime: new Date().toISOString()
        }
      });
      wx.hideLoading();
      this.setData({ showAddUserModal: false });
      wx.showToast({ title: '员工录入成功', icon: 'success' });
    } catch (err) {
      console.error('添加失败：', err);
      wx.hideLoading();
      wx.showToast({ title: '录入失败，请重试', icon: 'none' });
    }
  },

  // 师傅端催单提醒
  startUrgentCheckTimer() {
    this.stopUrgentCheckTimer();
    const user = this.data.currentUser;
    if (user && user.role === 'worker') {
      this.checkWorkerUrgentOrders();
      const timer = setInterval(() => {
        this.checkWorkerUrgentOrders();
      }, 60000);
      this.setData({ urgentTimer: timer });
    }
  },

  stopUrgentCheckTimer() {
    if (this.data.urgentTimer) {
      clearInterval(this.data.urgentTimer);
      this.setData({ urgentTimer: null });
    }
  },

  checkWorkerUrgentOrders() {
    const user = this.data.currentUser;
    if (!user || user.role !== 'worker') return;

    const urgentOrder = (this.data.orders || []).find(o =>
      o.workerName === user.name &&
      o.isUrgent === true &&
      o.urgentAccepted !== true &&
      o.status !== '已完工' &&
      o.status !== '未成单'
    );

    if (urgentOrder) {
      wx.showModal({
        title: '🚨 客户紧急催单提醒',
        content: `您负责的工单（客户电话：${urgentOrder.customerPhone || urgentOrder.phone}，地址：${urgentOrder.address}）已被催单，请尽快处理！`,
        confirmText: '接受（不提示）',
        cancelText: '稍后',
        success: (res) => {
          if (res.confirm) {
            this.acceptUrgentOrder(urgentOrder._id);
          }
        }
      });
    }
  },

  acceptUrgentOrder(orderId) {
    wx.showLoading({ title: '正在确认...' });
    const db = wx.cloud.database();
    db.collection('orders').doc(orderId).update({
      data: {
        urgentAccepted: true,
        isUrgent: false
      }
    }).then(() => {
      wx.hideLoading();
      wx.showToast({ title: '已确认接受', icon: 'success' });
      this.fetchOrders();
    }).catch(err => {
      console.error(err);
      wx.hideLoading();
    });
  }
});