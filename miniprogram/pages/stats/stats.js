const app = getApp();

Page({
  data: {
    currentUser: null,
    currentSubTab: 'revenue',

    // 城市地区权限控制
    availableCities: ['天津', '北京'],
    userVisibleCities: ['天津', '北京'],
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

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    
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
      const myCities = Array.isArray(user.cities) ? user.cities : [];
      visible = allCities.filter(c => myCities.includes(c));
      if (visible.length === 0) visible = myCities.length > 0 ? myCities : ['天津'];
      defaultCity = visible[0] || '天津';
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
      const workerNames = ['全部师傅', ...workers.map(w => w.name + (w.role === 'leader' ? ' [主管]' : ''))];
      this.setData({ 
        workers, 
        workerFilterNames: workerNames,
        workerFilterIndex: 0
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

      const uniqueCreators = [...new Set(allOrders.map(o => o.creatorName).filter(Boolean))];
      const creatorNames = ['全部录单人', ...uniqueCreators];

      this.setData({ 
        allOrders,
        creators: uniqueCreators,
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
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
    }

    const match = str.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (match) {
      return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    }
    const cnMatch = str.match(/(\d{1,2})月(\d{1,2})日?/);
    if (cnMatch) {
      const y = new Date().getFullYear();
      return `${y}-${String(cnMatch[1]).padStart(2, '0')}-${String(cnMatch[2]).padStart(2, '0')}`;
    }
    return '';
  },

  processRevenueStats() {
    const { allOrders, revenueTimeFilterType, revenueCustomDateValue, workerFilterIndex, workers, currentUser, selectedCityFilter, userVisibleCities } = this.data;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const todayStr = `${currentYear}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const selectedWorkerName = workerFilterIndex > 0 ? workers[workerFilterIndex - 1].name : '';

    let filteredOrders = allOrders.filter(o => {
      if (selectedCityFilter !== 'all') {
        if (o.city !== selectedCityFilter) return false;
      } else if (currentUser && currentUser.role !== 'admin') {
        if (!o.city || !userVisibleCities.includes(o.city)) return false;
      }

      let timeField = '';
      if (o.status === '已完工' || o.settleType === '预付款') {
        timeField = o.finishTime || o.createTime || '';
      } else if (o.status === '未成单') {
        timeField = o.failTime || o.cancelTime || o.createTime || '';
      } else {
        timeField = o.createTime || o.appointmentTime || '';
      }

      const dateStr = this.parseDateStr(timeField);
      if (!dateStr) return false;

      if (revenueTimeFilterType === 'today') {
        return dateStr === todayStr;
      } else if (revenueTimeFilterType === 'month') {
        const d = new Date(dateStr.replace(/-/g, '/'));
        return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
      } else if (revenueTimeFilterType === 'year') {
        const d = new Date(dateStr.replace(/-/g, '/'));
        return d.getFullYear() === currentYear;
      } else if (revenueTimeFilterType === 'custom' && revenueCustomDateValue) {
        return dateStr === revenueCustomDateValue;
      }
      return true;
    });

    if (selectedWorkerName) {
      filteredOrders = filteredOrders.filter(o => o.workerName === selectedWorkerName);
    }

    let totalRevenue = 0;
    let wechatRevenue = 0;
    let alipayRevenue = 0;
    let cashRevenue = 0;
    let pendingBalance = 0;
    let completedCount = 0;
    let uncompletedCount = 0;
    let pendingSettleCount = 0;

    filteredOrders.forEach(o => {
      let rem = 0;
      if (o.status !== '已完工' && o.status !== '未成单') {
        if (typeof o.remainingAmount === 'number') rem = o.remainingAmount;
        else if (typeof o.remainingAmount === 'string' && o.remainingAmount.trim() !== '') rem = Number(o.remainingAmount) || 0;
        else rem = Number(o.pendingBalance) || 0;
      }

      if (rem > 0 && o.status !== '已完工' && o.status !== '未成单') {
        pendingSettleCount++;
        pendingBalance += rem;
      }

      if (o.status === '已完工') {
        completedCount++;
        const paid = Number(o.finalPaidAmount || o.finalAmount || o.paidAmount || o.totalAmount || 0);
        totalRevenue += paid;

        if (o.wechatAmount || o.alipayAmount || o.cashAmount) {
          wechatRevenue += Number(o.wechatAmount || 0);
          alipayRevenue += Number(o.alipayAmount || 0);
          cashRevenue += Number(o.cashAmount || 0);
        } else {
          const payWay = (o.payWay || '').toLowerCase();
          if (payWay.includes('微信')) wechatRevenue += paid;
          else if (payWay.includes('支付宝')) alipayRevenue += paid;
          else cashRevenue += paid;
        }
      } else if (o.status === '未成单') {
        if (o.uncompletedType === 'worker_fail' || o.failReason || o.failTime) {
          uncompletedCount++;
        }
      } else if (o.settleType === '预付款') {
        const deposit = Number(o.depositAmount || o.finalAmount || 0);
        if (deposit > 0) {
          totalRevenue += deposit;
          if (o.wechatAmount || o.alipayAmount || o.cashAmount) {
            wechatRevenue += Number(o.wechatAmount || 0);
            alipayRevenue += Number(o.alipayAmount || 0);
            cashRevenue += Number(o.cashAmount || 0);
          } else {
            wechatRevenue += deposit;
          }
        }
      }
    });

    const avgOrderPrice = completedCount > 0 ? (totalRevenue / completedCount).toFixed(1) : 0;

    const workerMap = {};
    filteredOrders.forEach(o => {
      const wName = o.workerName;
      if (!wName) return;

      if (!workerMap[wName]) {
        workerMap[wName] = { name: wName, revenue: 0, pending: 0, completed: 0, uncompleted: 0, pendingCount: 0 };
      }

      if (o.status === '已完工') {
        workerMap[wName].revenue += Number(o.finalPaidAmount || o.finalAmount || o.paidAmount || o.totalAmount || 0);
        workerMap[wName].completed += 1;
      } else if (o.status === '未成单') {
        if (o.uncompletedType === 'worker_fail' || o.failReason || o.failTime) {
          workerMap[wName].uncompleted += 1;
        }
      } else if (o.settleType === '预付款') {
        workerMap[wName].revenue += Number(o.depositAmount || o.finalAmount || 0);
      }

      let r = 0;
      if (o.status !== '已完工' && o.status !== '未成单') {
        if (typeof o.remainingAmount === 'number') r = o.remainingAmount;
        else if (typeof o.remainingAmount === 'string' && o.remainingAmount.trim() !== '') r = Number(o.remainingAmount) || 0;
        else r = Number(o.pendingBalance) || 0;
      }

      if (r > 0 && o.status !== '已完工' && o.status !== '未成单') {
        workerMap[wName].pending += r;
        workerMap[wName].pendingCount += 1;
      }
    });

    const workerRankList = Object.values(workerMap).sort((a, b) => b.revenue - a.revenue);

    this.setData({
      statsData: {
        totalRevenue: totalRevenue.toFixed(1),
        wechatRevenue: wechatRevenue.toFixed(1),
        alipayRevenue: alipayRevenue.toFixed(1),
        cashRevenue: cashRevenue.toFixed(1),
        pendingBalance: pendingBalance.toFixed(1),
        completedCount,
        uncompletedCount,
        pendingSettleCount,
        avgOrderPrice
      },
      workerRankList
    });
  },

  processServiceStats() {
    const { allOrders, serviceTimeFilterType, serviceCustomDateValue, creatorFilterIndex, creators, currentUser, selectedCityFilter, userVisibleCities } = this.data;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const todayStr = `${currentYear}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const selectedCreatorName = creatorFilterIndex > 0 ? creators[creatorFilterIndex - 1] : '';

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
        const d = new Date(createDateStr.replace(/-/g, '/'));
        return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
      } else if (serviceTimeFilterType === 'year') {
        const d = new Date(createDateStr.replace(/-/g, '/'));
        return d.getFullYear() === currentYear;
      } else if (serviceTimeFilterType === 'custom' && serviceCustomDateValue) {
        return createDateStr === serviceCustomDateValue;
      }
      return true;
    });

    if (selectedCreatorName) {
      serviceCreatedOrders = serviceCreatedOrders.filter(o => o.creatorName === selectedCreatorName);
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
      const creator = o.creatorName || '系统录入';
      if (!serviceMap[creator]) {
        serviceMap[creator] = { name: creator, total: 0, completed: 0, revenue: 0, cancelled: 0, workerFail: 0, sameDay: 0, nextDay: 0 };
      }
      serviceMap[creator].total += 1;

      const createDate = this.parseDateStr(o.createTime);
      const appointDate = this.parseDateStr(o.appointmentTime);

      if (createDate && appointDate) {
        const cDateObj = new Date(createDate.replace(/-/g, '/'));
        const nextDateObj = new Date(cDateObj);
        nextDateObj.setDate(cDateObj.getDate() + 1);
        const nextDateStr = `${nextDateObj.getFullYear()}-${String(nextDateObj.getMonth() + 1).padStart(2, '0')}-${String(nextDateObj.getDate()).padStart(2, '0')}`;

        if (appointDate === createDate) {
          sameDayAppoint++;
          serviceMap[creator].sameDay += 1;
        }
        if (appointDate === nextDateStr) {
          nextDayAppoint++;
          serviceMap[creator].nextDay += 1;
        }
      }

      if (o.status === '未成单') {
        if (o.uncompletedType === 'service_cancel' || o.cancelReason || o.cancelTime) {
          cancelledCreated++;
          serviceMap[creator].cancelled += 1;
        } else {
          workerFailCreated++;
          serviceMap[creator].workerFail += 1;
        }
      } else {
        const signedTotal = Number(o.totalAmount || o.finalAmount || 0);
        const paidNow = Number(o.depositAmount || o.finalAmount || 0);
        const tail = Math.max(0, signedTotal - paidNow);

        if (o.status === '已完工') {
          completedCreated++;
          serviceMap[creator].completed += 1;
          totalRevenueCreated += signedTotal;
          collectedDeposit += signedTotal;
          serviceMap[creator].revenue += signedTotal;
        } else if (o.settleType === '预付款') {
          completedCreated++;
          serviceMap[creator].completed += 1;
          totalRevenueCreated += signedTotal;
          collectedDeposit += paidNow;
          pendingTail += tail;
          serviceMap[creator].revenue += signedTotal;
        }
      }
    });

    const serviceRankList = Object.values(serviceMap).sort((a, b) => b.revenue - a.revenue || b.completed - a.completed);

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
        text += `${index + 1}. ${w.name}: 营收¥${w.revenue} (完工${w.completed}单 | 未成${w.uncompleted}单 | 待收¥${w.pending})\n`;
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
          text += `${index + 1}. ${s.name}: 录单${s.total} | 成单${s.completed} (¥${s.revenue}) | 退单${s.cancelled}\n`;
        });
      }

      wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '客服日报已复制', icon: 'success' }) });
    }
  }
});
