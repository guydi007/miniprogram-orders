const app = getApp();

Page({
  data: {
    currentUser: null,
    orders: [],
    filteredOrders: [],
    searchKey: '',

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

    showPhoneModal: false,
    inputPhone: '',

    showUserManageModal: false,
    userManageTab: 'list',
    allUserList: [],
    newUserName: '',
    newUserPhone: '',
    newUserRole: 'worker',
    newUserIsTest: false,

    urgentTimer: null
  },

  onLoad() {
    const cachedUser = wx.getStorageSync('currentUser');
    if (cachedUser && cachedUser.phone) {
      this.handleUserLoaded(cachedUser);
      return;
    }

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
    const cachedUser = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    if (cachedUser && cachedUser.phone) {
      if (!this.data.currentUser || this.data.currentUser.phone !== cachedUser.phone) {
        this.setData({ currentUser: cachedUser });
      }
      this.fetchOrders();
      this.startUrgentCheckTimer();
    } else if (this.data.currentUser) {
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

  // 点击头像卡片：测试账号与管理员自由换号，正式员工强锁定
  async handleUserHeaderTap() {
    const user = this.data.currentUser;

    if (!user) {
      this.setData({ showPhoneModal: true, inputPhone: '' });
      return;
    }

    wx.showLoading({ title: '核验中...' });
    const db = wx.cloud.database();

    try {
      const res = await db.collection('users').doc(user._id).get();
      wx.hideLoading();
      const dbUser = res.data || user;

      // 1. 如果是测试账号 (isTest === true) 或是管理员：允许自由退出换号
      if (dbUser.isTest === true || dbUser.role === 'admin') {
        wx.showModal({
          title: '退出 / 更换账号',
          content: `当前为【${dbUser.name}】${dbUser.isTest ? '（测试免锁账号）' : ''}，确定退出并登录其他账号吗？`,
          confirmText: '退出换号',
          confirmColor: '#e53935',
          success: (mRes) => {
            if (mRes.confirm) {
              wx.removeStorageSync('currentUser');
              if (app.globalData) app.globalData.currentUser = null;
              this.setData({
                currentUser: null,
                orders: [],
                filteredOrders: [],
                showPhoneModal: true,
                inputPhone: ''
              });
            }
          }
        });
        return;
      }

      // 2. 正式员工：已绑定微信则强锁定
      const hasBoundOpenid = dbUser.openid && dbUser.openid.trim() !== '';
      if (hasBoundOpenid) {
        return wx.showModal({
          title: '身份已绑定锁定',
          content: `员工【${dbUser.name}】（${dbUser.phone}）已与当前微信号永久绑定，禁止切换。如需换号请联系管理员解绑。`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }

      // 3. 尚未绑定的正式员工：允许登录
      this.setData({ showPhoneModal: true, inputPhone: '' });
    } catch (e) {
      wx.hideLoading();
      this.setData({ showPhoneModal: true, inputPhone: '' });
    }
  },

  onPhoneInput(e) {
    this.setData({ inputPhone: (e.detail.value || '').trim() });
  },

  // 手机号核验登录（通过云函数）
  async verifyAndBindPhone() {
    const phone = this.data.inputPhone;
    if (!phone || phone.length < 11) {
      return wx.showToast({ title: '请输入正确的11位手机号', icon: 'none' });
    }

    wx.showLoading({ title: '核验登录中...' });

    try {
      const res = await wx.cloud.callFunction({
        name: 'login',
        data: {
          action: 'verifyAndBind',
          phone: phone
        }
      });

      wx.hideLoading();
      const result = res.result || {};

      if (!result.success) {
        return wx.showModal({
          title: '核验/绑定提示',
          content: result.msg || '核验失败，请重试',
          showCancel: false
        });
      }

      const user = result.user;
      wx.setStorageSync('currentUser', user);
      this.handleUserLoaded(user);

      wx.showToast({
        title: `欢迎回来，${user.name}`,
        icon: 'success'
      });
    } catch (err) {
      console.error('云函数核验异常：', err);
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  fetchOrders() {
    return new Promise((resolve) => {
      const user = this.data.currentUser;
      if (!user || !user.phone) return resolve();

      const db = wx.cloud.database();
      wx.showNavigationBarLoading();

      db.collection('orders').orderBy('createTime', 'desc').get().then(res => {
        const allOrders = res.data || [];

        let filteredByRole = allOrders;
        if (user && user.role === 'worker') {
          filteredByRole = allOrders.filter(o => o.workerName === user.name);
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

  openUserManageModal() {
    this.setData({
      showUserManageModal: true,
      userManageTab: 'list',
      newUserName: '',
      newUserPhone: '',
      newUserRole: 'worker',
      newUserIsTest: false
    });
    this.fetchAllUsers();
  },

  closeUserManageModal() {
    this.setData({ showUserManageModal: false });
  },

  switchUserTab(e) {
    this.setData({ userManageTab: e.currentTarget.dataset.tab });
  },

  fetchAllUsers() {
    const db = wx.cloud.database();
    db.collection('users').get().then(res => {
      this.setData({ allUserList: res.data || [] });
    }).catch(e => console.error(e));
  },

  unbindUserOpenid(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认解绑微信号？',
      content: `解绑后，该账号可重新绑定新微信号。`,
      confirmColor: '#e53935',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在解绑...' });
          const db = wx.cloud.database();
          try {
            await db.collection('users').doc(id).update({
              data: { openid: '' }
            });
            wx.hideLoading();
            wx.showToast({ title: '已成功解绑', icon: 'success' });
            this.fetchAllUsers();
          } catch (err) {
            console.error(err);
            wx.hideLoading();
            wx.showToast({ title: '解绑失败', icon: 'none' });
          }
        }
      }
    });
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

  onNewUserIsTestChange(e) {
    this.setData({ newUserIsTest: e.detail.value });
  },

  async submitAddUser() {
    const { newUserName, newUserPhone, newUserRole, newUserIsTest } = this.data;
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
          isTest: newUserIsTest,
          openid: '',
          createTime: new Date().toISOString()
        }
      });
      wx.hideLoading();
      this.setData({
        newUserName: '',
        newUserPhone: '',
        newUserIsTest: false,
        userManageTab: 'list'
      });
      this.fetchAllUsers();
      wx.showToast({ title: '录入成功', icon: 'success' });
    } catch (err) {
      console.error('添加失败：', err);
      wx.hideLoading();
      wx.showToast({ title: '录入失败，请重试', icon: 'none' });
    }
  },

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