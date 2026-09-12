const app = getApp();

function checkIsAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

function checkCanAssign(user) {
  return Boolean(user && user.role === 'leader');
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

    timeFilterType: 'today',
    customDateText: '',
    customDateValue: '',

    isBatchMode: false,
    selectedOrderMap: {},
    selectedOrderIds: [],
    candidateWorkers: [],
    candidateWorkerNames: ['请选择师傅'],

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
    isSubmittingPhone: false,

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
    editUserName: '',
    editUserPhone: '',
    editUserRole: 'worker',
    editUserIsTest: false,
    editUserCities: [],
    editUserCitiesMap: {},
    editUserGroupId: '',
    editUserWebhookUrl: '',
    // TODO: 完善提醒样式、模板和真机验证后，再开放首页订阅入口。
    notificationEntryEnabled: false,
    notificationTemplates: [],
    newOrderTemplateConfigured: false,
    subscriptionBusy: false,
    subscriptionHint: ''
  },

  onLoad() {
    this.fetchCities().finally(() => {
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
        if (!app.authReadyCallback) {
          this.setData({ showPhoneModal: true });
        }
      }
    });
  },

  onReady() {},

  onShow() {
    if (!app.globalData || !app.globalData.authVerified) return;
    const cachedUser = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    if (cachedUser && cachedUser.phone) {
      if (!this.data.currentUser || this.data.currentUser.phone !== cachedUser.phone) {
        this.setData({ currentUser: cachedUser });
      }
      this.updateUserVisibleCities();
      this.fetchOrders();
      if (checkCanAssign(cachedUser)) {
        this.fetchCandidateWorkers();
      }
    } else if (this.data.currentUser) {
      this.updateUserVisibleCities();
      this.fetchOrders();
      if (checkCanAssign(this.data.currentUser)) {
        this.fetchCandidateWorkers();
      }
    }
  },

  fetchCandidateWorkers() {
    const db = wx.cloud.database();
    const _ = db.command;
    db.collection('users').where({
      role: _.in(['worker', 'leader'])
    }).get().then(res => {
      const workers = res.data || [];
      this.setData({
        candidateWorkers: workers,
        candidateWorkerNames: ['请选择师傅', ...workers.map(w => w.name + (w.role === 'leader' ? ' [主管]' : '') + (w.groupId ? ` (${w.groupId})` : ''))]
      });
    }).catch(e => console.error('获取师傅列表失败：', e));
  },

  toggleBatchMode() {
    if (!checkCanAssign(this.data.currentUser)) {
      return wx.showToast({ title: '仅限主管使用批量派单', icon: 'none' });
    }
    const nextMode = !this.data.isBatchMode;
    this.setData({
      isBatchMode: nextMode,
      selectedOrderMap: {},
      selectedOrderIds: []
    });
  },

  onToggleSelectOrder(e) {
    if (!this.data.isBatchMode) {
      return this.goToDetail(e);
    }
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    const order = (this.data.orders || []).find(o => o._id === id);
    if (order && (order.status === '已完工' || order.status === '未成单')) {
      return wx.showToast({ title: '已结单/归档工单不可派单', icon: 'none' });
    }

    const map = { ...this.data.selectedOrderMap };
    map[id] = !map[id];

    const ids = [];
    Object.keys(map).forEach(k => {
      if (map[k]) ids.push(k);
    });

    this.setData({
      selectedOrderMap: map,
      selectedOrderIds: ids
    });
  },

  selectAllOrders() {
    const list = (this.data.filteredOrders || []).filter(o => o.status !== '已完工' && o.status !== '未成单');
    const currentIds = this.data.selectedOrderIds || [];

    if (list.length === 0) {
      return wx.showToast({ title: '无待派单或进行中工单', icon: 'none' });
    }

    if (currentIds.length === list.length) {
      this.setData({
        selectedOrderMap: {},
        selectedOrderIds: []
      });
      wx.showToast({ title: '已取消全选', icon: 'none' });
      return;
    }

    const map = {};
    const ids = [];
    list.forEach(o => {
      map[o._id] = true;
      ids.push(o._id);
    });
    this.setData({
      selectedOrderMap: map,
      selectedOrderIds: ids
    });
    wx.showToast({ title: `已全选 ${ids.length} 单`, icon: 'none' });
  },

  async onBatchAssignWorker(e) {
    if (!checkCanAssign(this.data.currentUser)) {
      return wx.showToast({ title: '仅限主管使用批量派单', icon: 'none' });
    }

    const idx = Number(e.detail.value) - 1;
    const worker = this.data.candidateWorkers[idx];
    const orderIds = this.data.selectedOrderIds;

    if (!worker) {
      return wx.showToast({ title: '请选择有效师傅', icon: 'none' });
    }
    if (!orderIds || orderIds.length === 0) {
      return wx.showToast({ title: '请先勾选需要派单的工单', icon: 'none' });
    }

    const selectedOrders = (this.data.orders || []).filter(o => orderIds.includes(o._id));
    const orderCities = [...new Set(selectedOrders.map(o => o.city).filter(Boolean))];

    let workerCities = [];
    if (Array.isArray(worker.cities)) workerCities = worker.cities;
    else if (worker.cities && typeof worker.cities === 'object') workerCities = Object.values(worker.cities);
    else if (typeof worker.cities === 'string') workerCities = [worker.cities];

    if (workerCities.length > 0 && orderCities.length > 0) {
      const hasMismatch = orderCities.some(orderCity => {
        return !workerCities.some(wc => wc && (wc.includes(orderCity) || orderCity.includes(wc)));
      });
      if (hasMismatch) {
        return wx.showModal({
          title: '❌ 派单城市冲突',
          content: `所选人员【${worker.name}】（管辖城市：${workerCities.join('/')}）与您勾选的工单城市（${orderCities.join('/')}）不匹配，禁止跨城市派单！`,
          showCancel: false
        });
      }
    }

    wx.showLoading({ title: `正在批量派单 (${orderIds.length}单)...` });

    const updateData = {
      workerName: worker.name,
      workerPhone: worker.phone || '',
      workerGroupId: worker.groupId || '',
      status: '已派单'
    };

    try {
      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'batchAssignWorker',
          orderIds: orderIds,
          data: updateData
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        wx.showToast({ title: `成功派单 ${orderIds.length} 单`, icon: 'success' });
        this.setData({
          isBatchMode: false,
          selectedOrderMap: {},
          selectedOrderIds: []
        });
        this.fetchOrders();
      } else {
        wx.showToast({ title: '批量派单失败，请重试', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('批量派单异常：', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  onTimeFilterChange(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({
      timeFilterType: type,
      customDateText: ''
    }, () => {
      this.applyFilters();
    });
  },

  onCustomDateChange(e) {
    const val = e.detail.value;
    this.setData({
      timeFilterType: 'custom',
      customDateText: val,
      customDateValue: val
    }, () => {
      this.applyFilters();
    });
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
    } else if (user.role === 'service' || user.role === 'leader') {
      const myCities = Array.isArray(user.cities) ? user.cities : [];
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
      showPhoneModal: false,
      notificationTemplates: [],
      newOrderTemplateConfigured: false,
      subscriptionHint: ''
    }, () => {
      this.updateUserVisibleCities();
      this.fetchOrders();
      this.loadNotificationConfig();
      if (checkCanAssign(user)) {
        this.fetchCandidateWorkers();
      }
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
                isBatchMode: false,
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
          content: `员工【${dbUser.name}】（${dbUser.phone}）已与当前微信号绑定，禁止切换。`,
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
    if (this.data.isSubmittingPhone) return;

    const phone = (this.data.inputPhone || '').trim();
    if (!phone || phone.length < 11) {
      return wx.showToast({ title: '请输入正确的11位手机号', icon: 'none' });
    }

    this.setData({ isSubmittingPhone: true });
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
      this.setData({ isSubmittingPhone: false });
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
      this.setData({ isSubmittingPhone: false });
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
        allOrders = results.reduce((acc, cur) => {
          const list = (cur && Array.isArray(cur.data)) ? cur.data : [];
          return acc.concat(list);
        }, []);
      }

      allOrders.sort((a, b) => {
        const timeA = a.appointmentTime || '';
        const timeB = b.appointmentTime || '';
        if (timeA !== timeB) {
          return timeB.localeCompare(timeA);
        }
        const createA = a.createTime || '';
        const createB = b.createTime || '';
        return createB.localeCompare(createA);
      });

      const userCities = Array.isArray(user.cities) ? user.cities : [];
      let roleFiltered = allOrders;

      if (user.role === 'worker') {
        roleFiltered = allOrders.filter(o => 
          o.workerName === user.name && (!o.city || userCities.includes(o.city))
        );
      } else if (user.role === 'service' || user.role === 'leader') {
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
    const { orders, currentTab, searchKey, selectedCityFilter, currentUser, timeFilterType, customDateValue } = this.data;
    let list = [...orders];

    if (currentUser && (checkIsAdmin(currentUser) || currentUser.role === 'service' || currentUser.role === 'leader') && selectedCityFilter !== 'all') {
      list = list.filter(o => o.city === selectedCityFilter);
    }

    const parseOrderDateStr = (text, defaultYear = new Date().getFullYear()) => {
      if (!text) return '';
      const str = String(text).trim();

      const standardMatch = str.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
      if (standardMatch) {
        const y = standardMatch[1];
        const m = String(standardMatch[2]).padStart(2, '0');
        const d = String(standardMatch[3]).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }

      const cnMatch = str.match(/(\d{1,2})月(\d{1,2})日?/);
      if (cnMatch) {
        const m = String(cnMatch[1]).padStart(2, '0');
        const d = String(cnMatch[2]).padStart(2, '0');
        return `${defaultYear}-${m}-${d}`;
      }

      const dotMatch = str.match(/(?:^|[^\d])(\d{1,2})\.(\d{1,2})(?:[^\d]|$)/);
      if (dotMatch) {
        const m = String(dotMatch[1]).padStart(2, '0');
        const d = String(dotMatch[2]).padStart(2, '0');
        return `${defaultYear}-${m}-${d}`;
      }

      return '';
    };

    if (timeFilterType !== 'all') {
      const now = new Date();
      const currentYear = now.getFullYear();
      
      const todayStr = `${currentYear}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

      list = list.filter(o => {
        const tField = (o.appointmentTime || '').trim();
        if (!tField) return false;

        const orderDateFormatted = parseOrderDateStr(tField, currentYear);
        if (!orderDateFormatted) return false;

        // 仅精准展示“今日”预约工单，不再并入历史过期的待派单
        if (timeFilterType === 'today') {
          return orderDateFormatted === todayStr;
        } else if (timeFilterType === 'tomorrow') {
          return orderDateFormatted === tomorrowStr;
        } else if (timeFilterType === 'week') {
          const d = new Date(orderDateFormatted.replace(/-/g, '/') + ' 12:00:00');
          const day = now.getDay() || 7;
          
          const monday = new Date(now);
          monday.setDate(now.getDate() - day + 1);
          monday.setHours(0, 0, 0, 0);
          
          const sunday = new Date(monday);
          sunday.setDate(monday.getDate() + 6);
          sunday.setHours(23, 59, 59, 999);
          
          return d >= monday && d <= sunday;
        } else if (timeFilterType === 'custom' && customDateValue) {
          return orderDateFormatted === customDateValue;
        }
        return true;
      });
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
    if (this._isNavigating) return;
    this._isNavigating = true;
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`,
      complete: () => {
        setTimeout(() => { this._isNavigating = false; }, 500);
      }
    });
  },
  
  goToCreate() {
    if (this._isNavigating) return;
    if (this.data.currentUser && this.data.currentUser.role === 'admin') {
      return wx.showToast({ title: '管理员无录单权限', icon: 'none' });
    }
    this._isNavigating = true;
    wx.navigateTo({
      url: '/pages/create/create',
      complete: () => {
        setTimeout(() => { this._isNavigating = false; }, 500);
      }
    });
  },
  
  goToStats() {
    if (this._isNavigating) return;
    this._isNavigating = true;
    wx.navigateTo({
      url: '/pages/stats/stats',
      complete: () => {
        setTimeout(() => { this._isNavigating = false; }, 500);
      }
    });
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

    if (role === 'admin') {
      return wx.showToast({ title: '禁止增加管理员权限', icon: 'none' });
    }
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
        const existingRole = existing.role === 'admin' ? '管理' : (existing.role === 'leader' ? '主管' : (existing.role === 'service' ? '客服' : '师傅'));
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
      editUserName: user.name || '',
      editUserPhone: user.phone || '',
      editUserRole: user.role || 'worker',
      editUserIsTest: Boolean(user.isTest),
      editUserCities: citiesArr,
      editUserCitiesMap: map,
      editUserGroupId: user.groupId || '',
      editUserWebhookUrl: user.webhookUrl || ''
    });
  },

  closeEditUserModal() {
    this.setData({
      showEditUserModal: false,
      editingUser: null
    });
  },

  onEditUserNameInput(e) {
    this.setData({ editUserName: (e.detail.value || '').trim() });
  },

  onEditUserPhoneInput(e) {
    this.setData({ editUserPhone: (e.detail.value || '').trim() });
  },

  onEditUserRoleChange(e) {
    this.setData({ editUserRole: e.detail.value });
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

  onEditUserIsTestChange(e) {
    this.setData({ editUserIsTest: e.detail.value });
  },

  async loadNotificationConfig() {
    if (!this.data.notificationEntryEnabled) return;
    const phone = this.data.currentUser && this.data.currentUser.phone;
    try {
      const res = await wx.cloud.callFunction({ name: 'manageOrder', data: { action: 'getNotificationConfig' } });
      if (!this.data.currentUser || this.data.currentUser.phone !== phone) return;
      const templates = res.result && res.result.success ? res.result.templates || [] : [];
      this.setData({ notificationTemplates: templates, newOrderTemplateConfigured: templates.some(item => item.type === 'newOrder') });
    } catch (error) { this.setData({ subscriptionHint: '订阅配置加载失败，请稍后重试' }); }
  },

  subscribeNotifications() {
    if (!this.data.notificationEntryEnabled) return;
    if (this.data.subscriptionBusy) return;
    const list = this.data.notificationTemplates || [];
    if (!list.length) {
      this.loadNotificationConfig();
      return wx.showToast({ title: '模板未配置或加载中，请稍后再点', icon: 'none' });
    }
    if (!wx.requestSubscribeMessage) return wx.showToast({ title: '请升级微信后再订阅', icon: 'none' });
    const tmplIds = [...new Set(list.map(item => item.templateId))].slice(0, 3);
    this.setData({ subscriptionBusy: true });
    // 直接由用户点击触发，不在此之前等待异步云函数。
    wx.requestSubscribeMessage({
      tmplIds,
      success: res => {
        const accepted = tmplIds.filter(id => res[id] === 'accept').length;
        this.setData({ subscriptionHint: accepted ? '本次已接受订阅；普通一次性消息每次授权对应一条提醒' : '未接受订阅，无法保证微信提醒' });
      },
      fail: () => this.setData({ subscriptionHint: '订阅未成功，请用手机微信打开后重试' }),
      complete: () => this.setData({ subscriptionBusy: false })
    });
  },

  onEditUserWebhookInput(e) {
    this.setData({ editUserWebhookUrl: (e.detail.value || '').trim() });
  },

  async submitEditUser() {
    if (!checkIsAdmin(this.data.currentUser)) {
      return wx.showToast({ title: '仅限管理员操作', icon: 'none' });
    }
    const { editingUser, editUserName, editUserPhone, editUserRole, editUserCities, editUserGroupId, editUserIsTest } = this.data;
    if (!editingUser) return;

    const name = (editUserName || '').trim();
    const phone = (editUserPhone || '').trim();

    if (!name) return wx.showToast({ title: '请输入姓名', icon: 'none' });
    if (!phone || phone.length !== 11) return wx.showToast({ title: '请输入11位手机号', icon: 'none' });
    if (!editUserCities || editUserCities.length === 0) {
      return wx.showToast({ title: '请至少保留一个城市', icon: 'none' });
    }

    const db = wx.cloud.database();
    wx.showLoading({ title: '正在保存...' });

    try {
      if (phone !== editingUser.phone) {
        const checkRes = await db.collection('users').where({ phone: phone }).get();
        const conflict = (checkRes.data || []).find(u => u._id !== editingUser._id);
        if (conflict) {
          wx.hideLoading();
          const existingRole = conflict.role === 'admin' ? '管理' : (conflict.role === 'leader' ? '主管' : (conflict.role === 'service' ? '客服' : '师傅'));
          return wx.showModal({
            title: '手机号冲突',
            content: `该手机号已被【${conflict.name || '员工'}】（${existingRole}）占用！`,
            showCancel: false
          });
        }
      }

      const finalRole = editingUser.role === 'admin' ? 'admin' : editUserRole;
      const isWorker = finalRole === 'worker';

      const updateData = {
        name: name,
        phone: phone,
        role: finalRole,
        cities: editUserCities,
        groupId: isWorker ? (editUserGroupId || '').trim() : '',
        isTest: Boolean(editUserIsTest),
        webhookUrl: (this.data.editUserWebhookUrl || '').trim()
      };

      const res = await wx.cloud.callFunction({
        name: 'manageOrder',
        data: {
          action: 'updateUser',
          userId: editingUser._id,
          data: updateData
        }
      });

      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        wx.showToast({ title: '保存成功', icon: 'success' });
        this.setData({ showEditUserModal: false });
        this.fetchAllUsers();
      } else {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
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
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在解绑...' });
          wx.cloud.callFunction({
            name: 'manageOrder',
            data: {
              action: 'unbindUser',
              userId: editingUser._id,
              data: { openid: '' }
            }
          }).then(cRes => {
            wx.hideLoading();
            const result = cRes.result || {};
            if (result.success) {
              wx.showToast({ title: '解绑成功', icon: 'success' });
              const updated = { ...editingUser, openid: '' };
              this.setData({ editingUser: updated });
              this.fetchAllUsers();
            } else {
              wx.showToast({ title: '解绑失败', icon: 'none' });
            }
          }).catch(err => {
            console.error('解绑异常：', err);
            wx.hideLoading();
            wx.showToast({ title: '解绑失败，请重试', icon: 'none' });
          });
        }
      }
    });
  }
});
