const app = getApp();

// 业务统计固定按北京时间（UTC+8），不跟随查看设备所在时区变化。
const BUSINESS_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const businessParts = (value = Date.now()) => {
  const ms = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : Date.parse(value));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + BUSINESS_TZ_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};
const businessDateStr = (value = Date.now()) => {
  const p = businessParts(value);
  if (!p) return '';
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};
const businessBoundaryMs = (year, month, day) => Date.UTC(year, month - 1, day, 0, 0, 0, 0) - BUSINESS_TZ_OFFSET_MS;

Page({
  data: {
    currentUser: null,
    currentSubTab: 'revenue',

    // 城市地区权限控制
    availableCities: [],
    userVisibleCities: [],
    selectedCityFilter: 'all',

    // 财务营收筛选
    revenueTimeFilterType: 'today',
    revenueCustomDateValue: '',
    workers: [],
    workerFilterNames: ['全部师傅'],
    workerFilterIndex: 0,

    statsData: {
      totalRevenue: 0,
      wechatRevenue: 0,
      alipayRevenue: 0,
      cashRevenue: 0,
      pendingBalance: 0,
      completedCount: 0,
      uncompletedCount: 0,
      pendingSettleCount: 0,
      avgOrderPrice: 0
    },
    workerRankList: [],

    // 客服录单筛选
    serviceTimeFilterType: 'today',
    serviceCustomDateValue: '',
    creators: [],
    creatorFilterNames: ['全部录单人'],
    creatorFilterIndex: 0,

    serviceStatsSummary: {
      totalRevenueCreated: 0,
      collectedDeposit: 0,
      pendingTail: 0,
      totalCreated: 0,
      completedCreated: 0,
      cancelledCreated: 0,
      workerFailCreated: 0,
      sameDayAppoint: 0,
      nextDayAppoint: 0
    },
    serviceRankList: [],

    allOrders: []
  },

  onLoad(options) {
    const user = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    
    // 严格前置准入校验：非管理或主管直接拦截返回
    if (!user || (user.role !== 'admin' && user.role !== 'leader')) {
      wx.showToast({ title: '暂无权限访问统计', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }

    const todayStr = businessDateStr();
    
    this.setData({
      currentUser: user,
      revenueTimeFilterType: 'today',
      revenueCustomDateValue: todayStr,
      serviceTimeFilterType: 'today',
      serviceCustomDateValue: todayStr
    }, () => {
      this.initCitiesAndPermissions();
    });
  },

  initCitiesAndPermissions() {
    const user = this.data.currentUser;
    let allCities = wx.getStorageSync('availableCities') || ['天津', '北京'];
    
    let visible = allCities;
    let defaultCity = 'all';

    if (user && user.role !== 'admin') {
      const myCities = Array.isArray(user.cities)
        ? user.cities.map(c => String(c || '').trim()).filter(Boolean)
        : [];
      visible = allCities.filter(c => myCities.includes(c));
      // 员工城市权限是最终权限来源；本地城市缓存落后时使用员工已授权城市。
      if (visible.length === 0 && myCities.length > 0) visible = myCities;
      defaultCity = visible[0] || 'all';
      if (!visible.length) wx.showToast({ title: '当前账号未配置城市权限', icon: 'none' });
    }

    this.setData({
      availableCities: allCities,
      userVisibleCities: visible,
      selectedCityFilter: defaultCity
    }, () => {
      this.fetchWorkers();
      this.fetchOrdersAndCalculate();
    });
  },

  onCityFilterChange(e) {
    const city = e.currentTarget.dataset.city;
    this.setData({ selectedCityFilter: city }, () => {
      this.fetchWorkers();
      this.processRevenueStats();
      this.processServiceStats();
    });
  },

  switchSubTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ currentSubTab: tab });
  },

  fetchWorkers() {
    const { selectedCityFilter } = this.data;
    wx.cloud.callFunction({
      name: 'manageOrder',
      data: { action: 'getWorkers', data: { city: selectedCityFilter === 'all' ? '' : selectedCityFilter } }
    }).then(res => {
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || 'WORKERS_UNAVAILABLE');
      const workers = result.workers || [];
      const nameCounts = workers.reduce((acc, worker) => {
        const name = String(worker && worker.name || '').trim();
        if (name) acc[name] = (acc[name] || 0) + 1;
        return acc;
      }, {});
      const workerNames = ['全部师傅', ...workers.map(w => {
        const name = String(w.name || '未命名');
        const suffix = nameCounts[name] > 1 && w.phone ? ` (${String(w.phone).slice(-4)})` : '';
        return name + suffix + (w.role === 'leader' ? ' [主管]' : '');
      })];
      this.setData({ 
        workers, 
        workerFilterNames: workerNames,
        workerFilterIndex: 0
      }, () => {
        // 城市切换后师傅列表是异步更新的，列表刷新完成后重新计算一次，避免排行榜使用旧城市的师傅。
        this.processRevenueStats();
      });
    }).catch(e => console.error('获取师傅列表失败：', e));
  },

  onRevenueTimeChange(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ revenueTimeFilterType: type }, () => {
      this.processRevenueStats();
    });
  },

  onRevenueCustomDateChange(e) {
    const val = e.detail.value;
    this.setData({
      revenueTimeFilterType: 'custom',
      revenueCustomDateValue: val
    }, () => {
      this.processRevenueStats();
    });
  },

  onWorkerFilterChange(e) {
    this.setData({ workerFilterIndex: e.detail.value }, () => {
      this.processRevenueStats();
    });
  },

  onServiceTimeChange(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ serviceTimeFilterType: type }, () => {
      this.processServiceStats();
    });
  },

  onServiceCustomDateChange(e) {
    const val = e.detail.value;
    this.setData({
      serviceTimeFilterType: 'custom',
      serviceCustomDateValue: val
    }, () => {
      this.processServiceStats();
    });
  },

  onCreatorFilterChange(e) {
    this.setData({ creatorFilterIndex: e.detail.value }, () => {
      this.processServiceStats();
    });
  },

  async fetchOrdersAndCalculate() {
    const user = this.data.currentUser;
    if (!user) return;

    wx.showLoading({ title: '加载数据中...' });
    try {
      const response = await wx.cloud.callFunction({ name: 'manageOrder', data: { action: 'getOrders' } });
      const result = response.result || {};
      if (!result.success) throw new Error(result.msg || 'ORDERS_UNAVAILABLE');
      const allOrders = Array.isArray(result.orders) ? result.orders : [];

      const creatorMap = new Map();
      allOrders.forEach(order => {
        const name = String(order.creatorName || '').trim();
        if (!name) return;
        const id = String(order.creatorId || '').trim();
        const key = id ? `id:${id}` : `legacy:${name}`;
        if (!creatorMap.has(key)) creatorMap.set(key, { key, id, name, phone: String(order.creatorPhone || '').trim() });
      });
      const creators = [...creatorMap.values()];
      const nameCounts = creators.reduce((acc, item) => {
        acc[item.name] = (acc[item.name] || 0) + 1;
        return acc;
      }, {});
      const creatorNames = ['全部录单人', ...creators.map(item => {
        if (nameCounts[item.name] <= 1) return item.name;
        const suffix = item.phone ? item.phone.slice(-4) : (item.id ? item.id.slice(-4) : '历史');
        return `${item.name} (${suffix})`;
      })];

      this.setData({ 
        allOrders,
        creators,
        creatorFilterNames: creatorNames
      }, () => {
        // 等待页面数据和筛选条件完成同一轮渲染，避免首次进入时营收模块使用旧的空数组。
        wx.nextTick(() => {
          this.processRevenueStats();
          this.processServiceStats();
        });
      });
      wx.hideLoading();
    } catch (err) {
      wx.hideLoading();
      console.error('获取统计工单失败：', err);
      wx.showToast({ title: '获取数据失败', icon: 'none' });
    }
  },

  parseDateStr(text) {
    if (!text) return '';
    const str = String(text).trim();

    if (str.includes('T') || str.endsWith('Z')) {
      const value = businessDateStr(str);
      if (value) return value;
    }

    const match = str.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (match) {
      return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    }
    const cnMatch = str.match(/(\d{1,2})月(\d{1,2})日?/);
    if (cnMatch) {
      const y = (businessParts() || {}).year || new Date().getUTCFullYear();
      return `${y}-${String(cnMatch[1]).padStart(2, '0')}-${String(cnMatch[2]).padStart(2, '0')}`;
    }
    return '';
  },

  getRevenueDateRange() {
    const { revenueTimeFilterType, revenueCustomDateValue } = this.data;
    const now = businessParts() || { year: 1970, month: 1, day: 1 };
    let startMs;
    let endMs;

    if (revenueTimeFilterType === 'month') {
      startMs = businessBoundaryMs(now.year, now.month, 1);
      endMs = businessBoundaryMs(now.year, now.month + 1, 1);
    } else if (revenueTimeFilterType === 'year') {
      startMs = businessBoundaryMs(now.year, 1, 1);
      endMs = businessBoundaryMs(now.year + 1, 1, 1);
    } else {
      let target = { ...now };
      if (revenueTimeFilterType === 'custom' && revenueCustomDateValue) {
        const parts = String(revenueCustomDateValue).split('-').map(Number);
        if (parts.length === 3 && parts.every(Number.isFinite)) target = { year: parts[0], month: parts[1], day: parts[2] };
      }
      startMs = businessBoundaryMs(target.year, target.month, target.day);
      endMs = startMs + 24 * 60 * 60 * 1000;
    }

    return {
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs - 1).toISOString()
    };
  },

  orderMatchesRevenuePeriod(order) {
    const { revenueTimeFilterType, revenueCustomDateValue } = this.data;
    const now = businessParts() || { year: 1970, month: 1, day: 1 };
    const currentYear = now.year;
    const currentMonth = now.month;
    const todayStr = businessDateStr();

    let timeField = '';
    if (order.status === '已完工') {
      timeField = order.finishTime || order.createTime || '';
    } else if (order.status === '未成单') {
      timeField = order.failTime || order.cancelTime || order.createTime || '';
    } else {
      // 未归档订单继续沿用原页面口径：以录单时间为主，缺失时使用预约时间。
      timeField = order.createTime || order.appointmentTime || '';
    }

    const dateStr = this.parseDateStr(timeField);
    if (!dateStr) return false;

    if (revenueTimeFilterType === 'today') return dateStr === todayStr;
    if (revenueTimeFilterType === 'custom' && revenueCustomDateValue) return dateStr === revenueCustomDateValue;

    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3 || !parts.every(Number.isFinite)) return false;
    if (revenueTimeFilterType === 'month') return parts[0] === currentYear && parts[1] === currentMonth;
    if (revenueTimeFilterType === 'year') return parts[0] === currentYear;
    return true;
  },

  async fetchPaymentStats(range, workerId = '', workerPhone = '') {
    const { selectedCityFilter } = this.data;
    const city = selectedCityFilter === 'all' ? 'all' : selectedCityFilter;
    const cacheKey = [range.startAt, range.endAt, city, workerId || 'all', workerPhone || ''].join('|');
    this._paymentStatsCache = this._paymentStatsCache || {};
    const cached = this._paymentStatsCache[cacheKey];
    if (cached && Date.now() - cached.at < 5000) return cached.promise;

    const request = wx.cloud.callFunction({
      name: 'manageOrder',
      data: {
        action: 'getPaymentStats',
        data: {
          startAt: range.startAt,
          endAt: range.endAt,
          city,
          workerId: workerId || '',
          workerPhone: workerPhone || ''
        }
      }
    }).then(response => {
      const result = response.result || {};
      if (!result.success) {
        const error = new Error(result.msg || 'PAYMENT_STATS_UNAVAILABLE');
        error.code = result.code || '';
        throw error;
      }
      return result;
    }).catch(error => {
      // 失败请求不能留在缓存中，否则临时网络错误会导致后续一直失败。
      delete this._paymentStatsCache[cacheKey];
      throw error;
    });

    this._paymentStatsCache[cacheKey] = { at: Date.now(), promise: request };
    return request;
  },

  async processRevenueStats() {
    const requestSeq = (this._revenueRequestSeq || 0) + 1;
    this._revenueRequestSeq = requestSeq;

    const {
      allOrders,
      workerFilterIndex,
      workers,
      currentUser,
      selectedCityFilter,
      userVisibleCities
    } = this.data;

    const selectedWorker = workerFilterIndex > 0 ? workers[workerFilterIndex - 1] : null;
    const selectedWorkerName = selectedWorker ? selectedWorker.name : '';
    const selectedWorkerId = selectedWorker ? String(selectedWorker._id || '') : '';
    const selectedWorkerPhone = selectedWorker ? selectedWorker.phone : '';

    // 订单状态类指标继续来自 orders；现金流类指标只来自 payment_transactions。
    let filteredOrders = (allOrders || []).filter(order => {
      if (selectedCityFilter !== 'all') {
        if (order.city !== selectedCityFilter) return false;
      } else if (currentUser && currentUser.role !== 'admin') {
        if (!order.city || !userVisibleCities.includes(order.city)) return false;
      }
      if (selectedWorker) {
        if (order.workerId && selectedWorkerId) {
          if (String(order.workerId) !== selectedWorkerId) return false;
        } else if (selectedWorkerPhone) {
          if (String(order.workerPhone || '') !== selectedWorkerPhone) return false;
        } else if (selectedWorkerName && order.workerName !== selectedWorkerName) {
          return false;
        }
      }
      return this.orderMatchesRevenuePeriod(order);
    });

    let pendingBalance = 0;
    let completedCount = 0;
    let uncompletedCount = 0;
    let pendingSettleCount = 0;
    let completedOrderValue = 0;

    const workerMap = {};
    const workerKey = (id, phone, name) => {
      const normalizedId = String(id || '').trim();
      if (normalizedId) return `id:${normalizedId}`;
      const normalizedPhone = String(phone || '').trim();
      if (normalizedPhone) return `legacy-phone:${normalizedPhone}`;
      return `legacy-name:${String(name || '').trim()}`;
    };
    const workerCandidates = selectedWorker ? [selectedWorker] : (workers || []);
    workerCandidates.forEach(worker => {
      if (!worker || !worker.name) return;
      const key = workerKey(worker._id, worker.phone, worker.name);
      workerMap[key] = {
        key,
        id: worker._id || '',
        name: worker.name,
        phone: worker.phone || '',
        revenue: 0,
        pending: 0,
        completed: 0,
        uncompleted: 0,
        pendingCount: 0
      };
    });

    filteredOrders.forEach(order => {
      const workerName = order.workerName || '';
      const key = workerKey(order.workerId, order.workerPhone, workerName);
      if (workerName && !workerMap[key]) {
        workerMap[key] = {
          key,
          id: order.workerId || '',
          name: workerName,
          phone: order.workerPhone || '',
          revenue: 0,
          pending: 0,
          completed: 0,
          uncompleted: 0,
          pendingCount: 0
        };
      }

      let remaining = 0;
      if (order.status !== '已完工' && order.status !== '未成单') {
        if (typeof order.remainingAmount === 'number') remaining = order.remainingAmount;
        else if (typeof order.remainingAmount === 'string' && order.remainingAmount.trim() !== '') remaining = Number(order.remainingAmount) || 0;
        else remaining = Number(order.pendingBalance) || 0;
      }

      if (remaining > 0 && order.status !== '已完工' && order.status !== '未成单') {
        pendingSettleCount += 1;
        pendingBalance += remaining;
        if (workerName && workerMap[key]) {
          workerMap[key].pending += remaining;
          workerMap[key].pendingCount += 1;
        }
      }

      if (order.status === '已完工') {
        completedCount += 1;
        completedOrderValue += Number(order.totalAmount || order.finalAmount || order.finalPaidAmount || order.paidAmount || 0);
        if (workerName && workerMap[key]) workerMap[key].completed += 1;
      } else if (order.status === '未成单') {
        if (order.uncompletedType === 'worker_fail' || order.failReason || order.failTime) {
          uncompletedCount += 1;
          if (workerName && workerMap[key]) workerMap[key].uncompleted += 1;
        }
      }
    });

    // “平均客单价”使用完工订单成交额 / 完工订单数，不再拿期间现金流除以完工数。
    const avgOrderPrice = completedCount > 0 ? (completedOrderValue / completedCount).toFixed(1) : '0.0';
    const range = this.getRevenueDateRange();

    try {
      // 服务端一次返回总计 + byWorker 聚合，避免按师傅逐个请求产生 N+1。
      const paymentStats = await this.fetchPaymentStats(range, selectedWorkerId, selectedWorkerPhone);
      if (requestSeq !== this._revenueRequestSeq) return;

      const revenueByWorker = paymentStats.byWorker || {};
      Object.keys(workerMap).forEach(key => {
        const bucket = revenueByWorker[key];
        if (bucket) workerMap[key].revenue = Number(bucket.totalRevenue || 0);
      });
      if (selectedWorker) {
        const selectedKey = workerKey(selectedWorkerId, selectedWorkerPhone, selectedWorkerName);
        if (workerMap[selectedKey]) workerMap[selectedKey].revenue = Number(paymentStats.totalRevenue || 0);
      }

      const duplicateNameCounts = Object.values(workerMap).reduce((acc, item) => {
        acc[item.name] = (acc[item.name] || 0) + 1;
        return acc;
      }, {});
      const workerRankList = Object.values(workerMap)
        .filter(item => item.revenue !== 0 || item.completed || item.uncompleted || item.pendingCount)
        .map(item => ({
          ...item,
          displayName: duplicateNameCounts[item.name] > 1 && item.phone ? `${item.name} (${String(item.phone).slice(-4)})` : item.name,
          revenue: Number(item.revenue || 0).toFixed(1),
          pending: Number(item.pending || 0).toFixed(1)
        }))
        .sort((a, b) => Number(b.revenue) - Number(a.revenue) || b.completed - a.completed);

      this.setData({
        statsData: {
          totalRevenue: Number(paymentStats.totalRevenue || 0).toFixed(1),
          wechatRevenue: Number(paymentStats.wechatRevenue || 0).toFixed(1),
          alipayRevenue: Number(paymentStats.alipayRevenue || 0).toFixed(1),
          cashRevenue: Number(paymentStats.cashRevenue || 0).toFixed(1),
          pendingBalance: Number(pendingBalance || 0).toFixed(1),
          completedCount,
          uncompletedCount,
          pendingSettleCount,
          avgOrderPrice
        },
        workerRankList
      });
    } catch (err) {
      if (requestSeq !== this._revenueRequestSeq) return;
      console.error('获取支付流水统计失败：', err);

      // 财务金额不可退回旧的订单快照算法，否则会再次产生分次付款错账。
      // 请求失败时明确显示 0，并保留订单状态类指标，避免展示看似正常但错误的营业额。
      const duplicateNameCounts = Object.values(workerMap).reduce((acc, item) => {
        acc[item.name] = (acc[item.name] || 0) + 1;
        return acc;
      }, {});
      const workerRankList = Object.values(workerMap)
        .filter(item => item.completed || item.uncompleted || item.pendingCount)
        .map(item => ({
          ...item,
          displayName: duplicateNameCounts[item.name] > 1 && item.phone ? `${item.name} (${String(item.phone).slice(-4)})` : item.name,
          revenue: '0.0',
          pending: Number(item.pending || 0).toFixed(1)
        }))
        .sort((a, b) => b.completed - a.completed);

      this.setData({
        statsData: {
          totalRevenue: '0.0',
          wechatRevenue: '0.0',
          alipayRevenue: '0.0',
          cashRevenue: '0.0',
          pendingBalance: Number(pendingBalance || 0).toFixed(1),
          completedCount,
          uncompletedCount,
          pendingSettleCount,
          avgOrderPrice
        },
        workerRankList
      });
      wx.showToast({ title: '营收流水统计加载失败', icon: 'none' });
    }
  },

  processServiceStats() {
    const { allOrders, serviceTimeFilterType, serviceCustomDateValue, creatorFilterIndex, creators, currentUser, selectedCityFilter, userVisibleCities } = this.data;
    const now = businessParts() || { year: 1970, month: 1, day: 1 };
    const currentYear = now.year;
    const currentMonth = now.month;
    const todayStr = businessDateStr();

    const selectedCreator = creatorFilterIndex > 0 ? creators[creatorFilterIndex - 1] : null;

    let serviceCreatedOrders = allOrders.filter(o => {
      if (selectedCityFilter !== 'all') {
        if (o.city !== selectedCityFilter) return false;
      } else if (currentUser && currentUser.role !== 'admin') {
        if (!o.city || !userVisibleCities.includes(o.city)) return false;
      }

      const createDateStr = this.parseDateStr(o.createTime);
      if (!createDateStr) return false;

      if (serviceTimeFilterType === 'today') {
        return createDateStr === todayStr;
      } else if (serviceTimeFilterType === 'month') {
        const parts = createDateStr.split('-').map(Number);
        return parts[0] === currentYear && parts[1] === currentMonth;
      } else if (serviceTimeFilterType === 'year') {
        const parts = createDateStr.split('-').map(Number);
        return parts[0] === currentYear;
      } else if (serviceTimeFilterType === 'custom' && serviceCustomDateValue) {
        return createDateStr === serviceCustomDateValue;
      }
      return true;
    });

    if (selectedCreator) {
      serviceCreatedOrders = serviceCreatedOrders.filter(o => {
        if (selectedCreator.id) return String(o.creatorId || '') === selectedCreator.id;
        return !o.creatorId && o.creatorName === selectedCreator.name;
      });
    }

    let totalCreated = serviceCreatedOrders.length;
    let completedCreated = 0;
    let cancelledCreated = 0;
    let workerFailCreated = 0;
    let sameDayAppoint = 0;
    let nextDayAppoint = 0;
    let totalRevenueCreated = 0;
    let collectedDeposit = 0;
    let pendingTail = 0;

    const serviceMap = {};

    serviceCreatedOrders.forEach(o => {
      const creatorName = o.creatorName || '系统录入';
      const creatorId = String(o.creatorId || '').trim();
      const creatorKey = creatorId ? `id:${creatorId}` : `legacy:${creatorName}`;
      if (!serviceMap[creatorKey]) {
        serviceMap[creatorKey] = { key: creatorKey, id: creatorId, name: creatorName, phone: o.creatorPhone || '', total: 0, completed: 0, revenue: 0, cancelled: 0, workerFail: 0, sameDay: 0, nextDay: 0 };
      }
      const creatorStats = serviceMap[creatorKey];
      creatorStats.total += 1;

      const createDate = this.parseDateStr(o.createTime);
      const appointDate = this.parseDateStr(o.appointmentTime);

      if (createDate && appointDate) {
        const [cy, cm, cd] = createDate.split('-').map(Number);
        const nextDateObj = new Date(Date.UTC(cy, cm - 1, cd + 1));
        const nextDateStr = `${nextDateObj.getUTCFullYear()}-${String(nextDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDateObj.getUTCDate()).padStart(2, '0')}`;

        if (appointDate === createDate) {
          sameDayAppoint++;
          creatorStats.sameDay += 1;
        }
        if (appointDate === nextDateStr) {
          nextDayAppoint++;
          creatorStats.nextDay += 1;
        }
      }

      if (o.status === '未成单') {
        if (o.uncompletedType === 'service_cancel' || o.cancelReason || o.cancelTime) {
          cancelledCreated++;
          creatorStats.cancelled += 1;
        } else {
          workerFailCreated++;
          creatorStats.workerFail += 1;
        }
      } else {
        const signedTotal = Number(o.totalAmount || o.finalAmount || 0);
        const paidNow = Number(o.depositAmount || o.finalAmount || 0);
        const tail = Math.max(0, signedTotal - paidNow);

        if (o.status === '已完工') {
          completedCreated++;
          creatorStats.completed += 1;
          totalRevenueCreated += signedTotal;
          collectedDeposit += signedTotal;
          creatorStats.revenue += signedTotal;
        } else if (o.settleType === '预付款') {
          completedCreated++;
          creatorStats.completed += 1;
          totalRevenueCreated += signedTotal;
          collectedDeposit += paidNow;
          pendingTail += tail;
          creatorStats.revenue += signedTotal;
        }
      }
    });

    const serviceNameCounts = Object.values(serviceMap).reduce((acc, item) => {
      acc[item.name] = (acc[item.name] || 0) + 1;
      return acc;
    }, {});
    const serviceRankList = Object.values(serviceMap).map(item => ({
      ...item,
      displayName: serviceNameCounts[item.name] > 1
        ? `${item.name} (${item.phone ? String(item.phone).slice(-4) : (item.id ? item.id.slice(-4) : '历史')})`
        : item.name
    })).sort((a, b) => b.revenue - a.revenue || b.completed - a.completed);

    this.setData({
      serviceStatsSummary: {
        totalRevenueCreated: totalRevenueCreated.toFixed(1),
        collectedDeposit: collectedDeposit.toFixed(1),
        pendingTail: pendingTail.toFixed(1),
        totalCreated,
        completedCreated,
        cancelledCreated,
        workerFailCreated,
        sameDayAppoint,
        nextDayAppoint
      },
      serviceRankList
    });
  },

  copyReport() {
    const { currentSubTab, statsData, workerRankList, serviceStatsSummary, serviceRankList, revenueTimeFilterType, revenueCustomDateValue, serviceTimeFilterType, serviceCustomDateValue, selectedCityFilter } = this.data;
    const cityTitle = selectedCityFilter === 'all' ? '全部城市' : selectedCityFilter;

    if (currentSubTab === 'revenue') {
      let timeTitle = revenueTimeFilterType === 'month' ? '本月' : (revenueTimeFilterType === 'year' ? '本年' : (revenueTimeFilterType === 'custom' ? revenueCustomDateValue : '今日'));
      let text = `📊 【财务营收日报】(${cityTitle} · ${timeTitle})\n`;
      text += `-------------------\n`;
      text += `💰 实收总额: ¥${statsData.totalRevenue} (完工${statsData.completedCount}单 / 现场未成${statsData.uncompletedCount}单 / 待成${statsData.pendingSettleCount}单)\n`;
      text += `• 微信: ¥${statsData.wechatRevenue} | 支付宝: ¥${statsData.alipayRevenue} | 现金: ¥${statsData.cashRevenue}\n`;
      text += `• 待收尾款: ¥${statsData.pendingBalance} | 客单价: ¥${statsData.avgOrderPrice}\n\n`;
      text += `👷 师傅业绩榜:\n`;
      workerRankList.forEach((w, index) => {
        text += `${index + 1}. ${w.displayName || w.name}: 营收¥${w.revenue} (完工${w.completed}单 | 未成${w.uncompleted}单 | 待收¥${w.pending})\n`;
      });
      wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '财务日报已复制', icon: 'success' }) });
    } else {
      let timeTitle = serviceTimeFilterType === 'month' ? '本月' : (serviceTimeFilterType === 'year' ? '本年' : (serviceTimeFilterType === 'custom' ? serviceCustomDateValue : '今日'));
      let text = `📞 【客服录单战报】(${cityTitle} · ${timeTitle})\n`;
      text += `-------------------\n`;
      text += `💰 客服锁定成单总额: ¥${serviceStatsSummary.totalRevenueCreated}\n`;
      text += `• 其中定金实收: ¥${serviceStatsSummary.collectedDeposit} | 待收尾款: ¥${serviceStatsSummary.pendingTail}\n`;
      text += `• 录单总数: ${serviceStatsSummary.totalCreated} 单 | 有效成单: ${serviceStatsSummary.completedCreated} 单\n`;
      text += `• 客服退单: ${serviceStatsSummary.cancelledCreated} 单 | 现场未成: ${serviceStatsSummary.workerFailCreated} 单\n`;
      
      if (serviceRankList && serviceRankList.length > 0) {
        text += `\n📞 各客服战报明细:\n`;
        serviceRankList.forEach((s, index) => {
          text += `${index + 1}. ${s.displayName || s.name}: 录单${s.total} | 成单${s.completed} (¥${s.revenue}) | 退单${s.cancelled}\n`;
        });
      }

      wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '客服日报已复制', icon: 'success' }) });
    }
  }
});
