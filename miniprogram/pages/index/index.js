const app = getApp();

function checkIsAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

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

    showUserManageModal: false,
    userManageTab: 'list',
    allUserList: [],
    newUserName: '',
    newUserPhone: '',
    newUserRole: 'worker',
    newUserIsTest: false,
    newUserGroupId: '',
    newUserCities: ['天津'],
    newUserCitiesMap: { '天津': true },

    allSourceList: [],
    newSourceName: '',

    showEditUserModal: false,
    editingUser: null,
    editUserCities: [],
    editUserCitiesMap: {},
    editUserGroupId: ''
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

    if (checkIsAdmin(user)) {
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

      if (dbUser.isTest === true || checkIsAdmin(dbUser)) {
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

  async fetchOrders() {
    const user = this.data.currentUser;
    if (!user || !user.phone) return;

    const db = wx.cloud.database();
    wx.showNavigationBarLoading();
    const MAX_LIMIT = 20;

    try {
      const countResult = await db.collection('orders').count();
      const total = countResult.total;
      const batchTimes = Math.ceil(total / MAX_LIMIT);
      const tasks = [];

      for (let i = 0; i < batchTimes; i++) {
        const promise = db.collection('orders')
          .orderBy('createTime', 'desc')
          .skip(i * MAX_LIMIT)
          .limit(MAX_LIMIT)
          .get();
        tasks.push(promise);
      }

      let allOrders = [];
      if (tasks.length > 0) {
        const results = await Promise.all(tasks);
        allOrders = results.reduce((acc, cur) => acc.concat(cur.data || []), []);
      }

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
      });
    } catch (err) {
      console.error('拉取工单失败：', err);
      wx.hideNavigationBarLoading();
    }
  },

  applyFilters() {
    const { orders, currentTab, searchKey, selectedCityFilter, currentUser } = this.data;
    let list = [...orders];

    if (currentUser && (checkIsAdmin(currentUser) || currentUser.role === 'service') && selectedCityFilter !== 'all') {
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
    if (!checkIsAdmin(this.data.currentUser)) {
      return wx.showToast({ title: '仅限管理员访问', icon: 'none' });
    }
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
      newUserCitiesMap: { [defaultCity]: true },
      newSourceName: ''
    });
    this.fetchAllUsers();
    this.fetchSources();
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

  fetchSources() {
    const db = wx.cloud.database();
    db.collection('order_sources').orderBy('sort', 'asc').get().then(res => {
      this.setData({ allSourceList: res.data || [] });
    }).catch(e => console.error('获取渠道列表失败：', e));
  },

  onNewSourceNameInput(e) {
    this.setData({ newSourceName: (e.detail.value || '').trim() });
  },

  async addSource() {
    if (!checkIsAdmin(this.data.currentUser)) {
      return wx.showToast({ title: '无权操作', icon: 'none' });
    }
    const name = (this.data.newSourceName || '').trim();
    if (!name) return wx.showToast({ title: '请输入渠道名称', icon: 'none' });

    const exists = this.data.allSourceList.some(s => s.name === name);
    if (exists) return wx.showToast({ title: '该渠道已存在', icon: 'none' });

    wx.showLoading({ title: '正在添加...' });
    const db = wx.cloud.database();
    try {
      await db.collection('order_sources').add({
        data: {
          name: name,
          sort: Date.now(),
          enabled: true,
          createTime: new Date().toISOString()
        }
      });
      wx.hideLoading();
      wx.showToast({ title: '添加成功', icon: 'success' });
      this.setData({ newSourceName: '' });
      this.fetchSources();
    } catch (err) {
      console.error('添加渠道失败：', err);
      wx.hideLoading();
      wx.showToast({ title: '添加失败，请重试', icon: 'none' });
    }
  },

  deleteSource(e) {
    if (!checkIsAdmin(this.data.currentUser)) {
      return wx.showToast({ title: '无权操作', icon: 'none' });
    }
    const { id, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认删除渠道？',
      content: `确定要删除【${name}】渠道吗？`,
      confirmColor: '#e53935',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在删除...' });
          const db = wx.cloud.database();
          try {
            await db.collection('order_sources').doc(id).remove();
            wx.hideLoading();
            wx.showToast({ title: '已删除', icon: 'success' });
            this.fetchSources();
          } catch (err) {
            console.error(err);
            wx.hideLoading();
            wx.showToast({ title: '删除失败', icon: 'none' });
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
    if (!checkIsAdmin(this.data.currentUser)) {
      return wx.showToast({ title: '无权操作', icon: 'none' });
    }
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
        const existingRole = existing.role === 'admin' ? '管理' : (existing.role === 'service' ? '客服' : '师傅');
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
  },

  openEditUserModal(e) {
    if (!checkIsAdmin(this.data.currentUser)) {
      return wx.showToast({ title: '仅限管理员操作', icon: 'none' });
    }
    const user = e.currentTarget.dataset.user;
    if (!user) return;

    let citiesArr = [];
    if (Array.isArray(user.cities)) citiesArr = user.cities;
    else if (user.cities && typeof user.cities === 'object') citiesArr = Object.values(user.cities);
    else if (typeof user.cities === 'string' && user.cities) citiesArr = [user.cities];

    const map = {};
    citiesArr.forEach(c => { map[c] = true; });

    this.setData({
      showEditUserModal: true,
      editingUser: user,
      editUserCities: citiesArr,
      editUserCitiesMap: map,
      editUserGroupId: user.groupId || ''
    });
  },

  closeEditUserModal() {
    this.setData({
      showEditUserModal: false,
      editingUser: null
    });
  },

  onEditUserCitiesChange(e) {
    const selected = e.detail.value || [];
    const map = {};
    selected.forEach(c => { map[c] = true; });
    this.setData({
      editUserCities: selected,
      editUserCitiesMap: map
    });
  },

  onEditUserGroupIdInput(e) {
    this.setData({
      editUserGroupId: (e.detail.value || '').trim()
    });
  },

  async submitEditUser() {
    if (!checkIsAdmin(this.data.currentUser)) {
      return wx.showToast({ title: '仅限管理员操作', icon: 'none' });
    }
    const { editingUser, editUserCities, editUserGroupId } = this.data;
    if (!editingUser) return;

    if (!editUserCities || editUserCities.length === 0) {
      return wx.showToast({ title: '请至少保留一个城市', icon: 'none' });
    }

    const isWorker = editingUser.role === 'worker';
    const updateData = {
      cities: editUserCities,
      groupId: isWorker ? editUserGroupId : ''
    };

    wx.showLoading({ title: '正在保存...' });
    const db = wx.cloud.database();

    try {
      await db.collection('users').doc(editingUser._id).update({
        data: updateData
      });

      wx.hideLoading();
      wx.showToast({ title: '保存成功', icon: 'success' });
      this.setData({ showEditUserModal: false });
      this.fetchAllUsers();
    } catch (err) {
      console.error('更新员工信息失败：', err);
      wx.hideLoading();
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  unbindUserInModal() {
    if (!checkIsAdmin(this.data.currentUser)) {
      return wx.showToast({ title: '仅限管理员操作', icon: 'none' });
    }
    const { editingUser, currentUser } = this.data;
    if (!editingUser) return;

    if (editingUser._id === currentUser._id) {
      return wx.showToast({ title: '无法解绑自身账号', icon: 'none' });
    }

    wx.showModal({
      title: '确认解绑？',
      content: `确定解绑员工【${editingUser.name}】的微信号吗？`,
      confirmColor: '#e53935',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在解绑...' });
          const db = wx.cloud.database();
          try {
            await db.collection('users').doc(editingUser._id).update({
              data: { openid: '' }
            });
            wx.hideLoading();
            wx.showToast({ title: '解绑成功', icon: 'success' });
            
            const updated = { ...editingUser, openid: '' };
            this.setData({ editingUser: updated });
            this.fetchAllUsers();
          } catch (err) {
            console.error('解绑失败：', err);
            wx.hideLoading();
            wx.showToast({ title: '解绑失败，请重试', icon: 'none' });
          }
        }
      }
    });
  }
});