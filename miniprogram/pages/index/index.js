const app = getApp();

Page({
  data: {
    currentUser: null,
    orders: [],
    filteredOrders: [],
    searchKey: '',

    availableCities: ['天津', '北京'],
    userVisibleCities: ['天津', '北京'],
    selectedCityFilter: 'all',

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

    // 员工管理弹窗
    showUserManageModal: false,
    userManageTab: 'list',
    allUserList: [],
    newUserName: '',
    newUserPhone: '',
    newUserRole: 'worker',
    newUserIsTest: false,
    newUserGroupId: '',
    newUserCities: ['天津'],
    newUserCitiesMap: { '天津': true }
  },

  onLoad() {
    this.fetchCities().finally(() => {
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
    });
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
      this.updateUserVisibleCities();
      this.fetchOrders();
    } else if (this.data.currentUser) {
      this.updateUserVisibleCities();
      this.fetchOrders();
    }
  },

  onPullDownRefresh() {
    this.fetchCities().then(() => {
      return this.fetchOrders();
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  stopBubble() {},

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) {
      wx.makePhoneCall({ phoneNumber: phone });
    }
  },

  fetchCities() {
    const db = wx.cloud.database();
    return db.collection('cities')
      .where({ enabled: true })
      .orderBy('sort', 'asc')
      .get()
      .then(res => {
        let list = (res.data || []).map(item => item.name);
        if (!list || list.length === 0) {
          list = ['天津', '北京'];
        }
        if (app.globalData) app.globalData.availableCities = list;
        wx.setStorageSync('availableCities', list);

        const defaultCity = list[0] || '天津';
        this.setData({
          availableCities: list,
          newUserCities: [defaultCity],
          newUserCitiesMap: { [defaultCity]: true }
        }, () => {
          this.updateUserVisibleCities();
        });
      })
      .catch(err => {
        console.warn('拉取城市失败，使用兜底配置：', err);
        const fallback = ['天津', '北京'];
        if (app.globalData) app.globalData.availableCities = fallback;
        this.setData({
          availableCities: fallback,
          newUserCities: ['天津'],
          newUserCitiesMap: { '天津': true }
        }, () => {
          this.updateUserVisibleCities();
        });
      });
  },

  updateUserVisibleCities() {
    const user = this.data.currentUser;
    const all = this.data.availableCities;
    if (!user) return;

    if (user.role === 'admin') {
      this.setData({ userVisibleCities: all });
    } else if (user.role === 'service') {
      const myCities = user.cities || [];
      const visible = all.filter(c => myCities.includes(c));
      this.setData({ userVisibleCities: visible.length > 0 ? visible : all });
    } else {
      this.setData({ userVisibleCities: [] });
    }
  },

  handleUserLoaded(user) {
    if (app.globalData) {
      app.globalData.currentUser = user;
    }
    this.setData({
      currentUser: user,
      showPhoneModal: false
    }, () => {
      this.updateUserVisibleCities();
      this.fetchOrders();
    });
  },

  onCityFilterChange(e) {
    const city = e.currentTarget.dataset.city;
    this.setData({ selectedCityFilter: city }, () => {
      this.applyFilters();
    });
  },

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

      const hasBoundOpenid = dbUser.openid && dbUser.openid.trim() !== '';
      if (hasBoundOpenid) {
        return wx.showModal({
          title: '身份已绑定锁定',
          content: `员工【${dbUser.name}】（${dbUser.phone}）已与当前微信号绑定，禁止切换。如需换号请联系管理员解绑。`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }

      this.setData({ showPhoneModal: true, inputPhone: '' });
    } catch (e) {
      wx.hideLoading();
      this.setData({ showPhoneModal: true, inputPhone: '' });
    }
  },

  onPhoneInput(e) {
    this.setData({ inputPhone: (e.detail.value || '').trim() });
  },

  async verifyAndBindPhone() {
    const phone = (this.data.inputPhone || '').trim();
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
        const userCities = user.cities || [];

        let roleFiltered = allOrders;
        if (user.role === 'worker') {
          roleFiltered = allOrders.filter(o => 
            o.workerName === user.name && (!o.city || userCities.includes(o.city))
          );
        } else if (user.role === 'service') {
          roleFiltered = allOrders.filter(o => 
            !o.city || userCities.includes(o.city)
          );
        }

        this.setData({ orders: roleFiltered }, () => {
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
    const { orders, currentTab, searchKey, selectedCityFilter, currentUser } = this.data;
    let list = [...orders];

    if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'service') && selectedCityFilter !== 'all') {
      list = list.filter(o => o.city === selectedCityFilter);
    }

    const counts = {
      all: list.length,
      '待派单': list.filter(o => o.status === '待派单').length,
      '已派单': list.filter(o => o.status === '已派单').length,
      '已完工': list.filter(o => o.status === '已完工').length,
      '未成单': list.filter(o => o.status === '未成单').length
    };

    if (currentTab !== 'all') {
      list = list.filter(o => o.status === currentTab);
    }

    if (searchKey && searchKey.trim()) {
      const kw = searchKey.trim().toLowerCase();
      list = list.filter(o =>
        ((o.city || '').toLowerCase().includes(kw)) ||
        ((o.customerPhone || '').includes(kw)) ||
        ((o.address || '').toLowerCase().includes(kw)) ||
        ((o.workerName || '').toLowerCase().includes(kw)) ||
        ((o.appointmentTime || '').toLowerCase().includes(kw)) ||
        ((o.source || '').toLowerCase().includes(kw))
      );
    }

    this.setData({
      filteredOrders: list,
      statusCounts: counts
    });
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
    const defaultCity = this.data.availableCities[0] || '天津';
    this.setData({
      showUserManageModal: true,
      userManageTab: 'list',
      newUserName: '',
      newUserPhone: '',
      newUserRole: 'worker',
      newUserIsTest: false,
      newUserGroupId: '',
      newUserCities: [defaultCity],
      newUserCitiesMap: { [defaultCity]: true }
    });
    this.fetchAllUsers();
  },

  closeUserManageModal() {
    this.setData({ showUserManageModal: false });
  },

  switchUserTab(e) {
    this.setData({ userManageTab: e.currentTarget.dataset.tab });
  },

  // 🌟 核心：清洗 cities 格式，确保权限城市 100% 正确显示
  fetchAllUsers() {
    const db = wx.cloud.database();
    db.collection('users').get().then(res => {
      const list = (res.data || []).map(item => {
        let citiesArr = [];
        if (Array.isArray(item.cities)) {
          citiesArr = item.cities;
        } else if (item.cities && typeof item.cities === 'object') {
          citiesArr = Object.values(item.cities);
        } else if (typeof item.cities === 'string' && item.cities) {
          citiesArr = [item.cities];
        }
        citiesArr = citiesArr.filter(c => c && typeof c === 'string');
        return {
          ...item,
          citiesText: citiesArr.length > 0 ? citiesArr.join('、') : '未分配'
        };
      });
      this.setData({ allUserList: list });
    }).catch(e => console.error(e));
  },

  unbindUserOpenid(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认解绑微信号？',
      content: `解绑后，员工【${name}】的微信号将清空，可重新绑定新微信号。`,
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
    this.setData({ newUserName: (e.detail.value || '').trim() });
  },

  onNewUserPhoneInput(e) {
    this.setData({ newUserPhone: (e.detail.value || '').trim() });
  },

  onNewUserGroupIdInput(e) {
    this.setData({ newUserGroupId: (e.detail.value || '').trim() });
  },

  onNewUserRoleChange(e) {
    this.setData({ newUserRole: e.detail.value });
  },

  onNewUserCitiesChange(e) {
    const selected = e.detail.value || [];
    const map = {};
    selected.forEach(c => { map[c] = true; });
    this.setData({
      newUserCities: selected,
      newUserCitiesMap: map
    });
  },

  onNewUserIsTestChange(e) {
    this.setData({ newUserIsTest: e.detail.value });
  },

  async submitAddUser() {
    const name = (this.data.newUserName || '').trim();
    const phone = (this.data.newUserPhone || '').trim();
    const role = this.data.newUserRole || 'worker';
    const cities = this.data.newUserCities || [];
    const groupId = (this.data.newUserGroupId || '').trim();
    const isTest = Boolean(this.data.newUserIsTest);

    if (!name) return wx.showToast({ title: '请输入姓名', icon: 'none' });
    if (!phone || phone.length !== 11) return wx.showToast({ title: '请输入11位手机号', icon: 'none' });
    if (!cities || cities.length === 0) return wx.showToast({ title: '请至少分配一个城市', icon: 'none' });

    wx.showLoading({ title: '正在校验手机号...' });
    const db = wx.cloud.database();

    try {
      const checkRes = await db.collection('users').where({ phone: phone }).get();
      if (checkRes.data && checkRes.data.length > 0) {
        wx.hideLoading();
        const existing = checkRes.data[0];
        const existingRole = existing.role === 'admin' ? '管理员' : (existing.role === 'service' ? '客服' : '师傅');
        return wx.showModal({
          title: '手机号冲突',
          content: `该手机号已被【${existing.name || '员工'}】（${existingRole}）占用！不可重复录入。`,
          showCancel: false
        });
      }

      const userData = {
        name: name,
        phone: phone,
        role: role,
        cities: cities,
        groupId: role === 'worker' ? groupId : '',
        isTest: isTest,
        openid: '',
        createTime: new Date().toISOString()
      };

      wx.showLoading({ title: '正在录入...' });
      await db.collection('users').add({ data: userData });
      wx.hideLoading();
      wx.showToast({ title: '录入成功', icon: 'success' });

      const defaultCity = this.data.availableCities[0] || '天津';
      this.setData({
        newUserName: '',
        newUserPhone: '',
        newUserGroupId: '',
        newUserCities: [defaultCity],
        newUserCitiesMap: { [defaultCity]: true },
        newUserIsTest: false,
        userManageTab: 'list'
      });
      this.fetchAllUsers();
    } catch (err) {
      console.error(err);
      wx.hideLoading();
      wx.showToast({ title: '录入失败，请重试', icon: 'none' });
    }
  }
});