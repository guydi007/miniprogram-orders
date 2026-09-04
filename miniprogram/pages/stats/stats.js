const app = getApp();

function formatDate(date) {
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 提取用于营收统计的日期（优先取实际收款结单时间 finishTime）
function extractOrderDate(order) {
  // 优先取结算收款时间，其次取创建时间，最后取预约时间
  const raw = order.finishTime || order.createTime || order.appointmentTime || '';
  if (!raw) return '';

  // 尝试标准 ISO/日期字符串解析本地日期
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return formatDate(d);
  }

  // 兼容纯文本正则提取 YYYY-MM-DD
  const match = String(raw).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${match[1]}-${pad(parseInt(match[2], 10))}-${pad(parseInt(match[3], 10))}`;
  }

  return String(raw).slice(0, 10);
}

Page({
  data: {
    allOrders: [],
    currentPeriod: 'today', // 'today' | 'month' | 'year' | 'custom'
    startDate: '',
    endDate: '',
    periodText: '今日',

    // 师傅筛选
    workerOptions: ['全部师傅'],
    selectedWorkerName: '全部师傅',

    // 统计看板数据
    stats: {
      paidTotal: '0.00',
      wechatTotal: '0.00',
      alipayTotal: '0.00',
      cashTotal: '0.00',
      balanceTotal: '0.00',
      dealCount: 0,
      failCount: 0,
      avgTicket: '0.00'
    },

    workerStatsList: []
  },

  onLoad() {
    // 1. 权限校验：同时兼容 admin、管理、管理员三种写法
    const user = wx.getStorageSync('currentUser') || (app.globalData && app.globalData.currentUser);
    const isAdmin = user && (user.role === 'admin' || user.role === '管理' || user.role === '管理员');
    
    if (!isAdmin) {
      return wx.showModal({
        title: '无权访问',
        content: '财务营收中心仅限管理员查看。',
        showCancel: false,
        success: () => {
          wx.navigateBack();
        }
      });
    }

    const todayStr = formatDate(new Date());
    this.setData({
      startDate: todayStr,
      endDate: todayStr
    });

    this.initWorkerList();
    this.loadAllOrders();
  },

  initWorkerList() {
    const db = wx.cloud.database();
    db.collection('users').where({ role: 'worker' }).get().then(res => {
      const names = (res.data || []).map(u => u.name);
      this.setData({
        workerOptions: ['全部师傅', ...names]
      });
    }).catch(e => console.error('获取师傅列表失败：', e));
  },

  // 突破小程序前端 20 条查询限制，分页加载全部工单
  async loadAllOrders() {
    wx.showLoading({ title: '正在核算营收...' });
    const db = wx.cloud.database();
    const MAX_LIMIT = 20;

    try {
      const countResult = await db.collection('orders').count();
      const total = countResult.total;
      const batchTimes = Math.ceil(total / MAX_LIMIT);
      const tasks = [];

      for (let i = 0; i < batchTimes; i++) {
        const promise = db.collection('orders').skip(i * MAX_LIMIT).limit(MAX_LIMIT).get();
        tasks.push(promise);
      }

      let allOrders = [];
      if (tasks.length > 0) {
        const results = await Promise.all(tasks);
        allOrders = results.reduce((acc, cur) => acc.concat(cur.data || []), []);
      }

      this.setData({ allOrders });
      this.calculateStats();
      wx.hideLoading();
    } catch (err) {
      console.error('拉取工单失败：', err);
      wx.hideLoading();
      wx.showToast({ title: '数据拉取失败', icon: 'none' });
    }
  },

  switchPeriod(e) {
    const p = e.currentTarget.dataset.period;
    const now = new Date();
    const todayStr = formatDate(now);

    let start = todayStr;
    let end = todayStr;

    if (p === 'month') {
      start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      end = todayStr;
    } else if (p === 'year') {
      start = `${now.getFullYear()}-01-01`;
      end = todayStr;
    }

    this.setData({
      currentPeriod: p,
      startDate: start,
      endDate: end
    }, () => {
      this.calculateStats();
    });
  },

  onStartDateChange(e) {
    this.setData({ startDate: e.detail.value }, () => {
      this.calculateStats();
    });
  },

  onEndDateChange(e) {
    this.setData({ endDate: e.detail.value }, () => {
      this.calculateStats();
    });
  },

  onWorkerChange(e) {
    const name = this.data.workerOptions[e.detail.value];
    this.setData({ selectedWorkerName: name }, () => {
      this.calculateStats();
    });
  },

  // 严密财务计算核心
  calculateStats() {
    const { allOrders, currentPeriod, startDate, endDate, selectedWorkerName, workerOptions } = this.data;
    const now = new Date();

    let periodText = '今日';
    if (currentPeriod === 'today') {
      periodText = `今日 (${startDate})`;
    } else if (currentPeriod === 'month') {
      periodText = `本月 (${now.getFullYear()}年${now.getMonth() + 1}月)`;
    } else if (currentPeriod === 'year') {
      periodText = `本年 (${now.getFullYear()}年)`;
    } else if (currentPeriod === 'custom') {
      periodText = `${startDate} 至 ${endDate}`;
    }

    // 1. 日期过滤
    let filtered = allOrders.filter(o => {
      const orderDate = extractOrderDate(o);
      if (!orderDate) return false;
      return orderDate >= startDate && orderDate <= endDate;
    });

    // 2. 师傅过滤
    if (selectedWorkerName !== '全部师傅') {
      filtered = filtered.filter(o => o.workerName === selectedWorkerName);
    }

    let wechat = 0;
    let alipay = 0;
    let cash = 0;
    let paidTotal = 0;
    let balanceTotal = 0;
    let dealCount = 0;
    let failCount = 0;

    const workerMap = {};

    filtered.forEach(o => {
      const wName = o.workerName || '未分配';
      if (!workerMap[wName]) {
        workerMap[wName] = {
          name: wName,
          paidTotal: 0,
          wechat: 0,
          alipay: 0,
          cash: 0,
          balanceTotal: 0,
          dealCount: 0,
          failCount: 0
        };
      }

      // 未成单统计
      if (o.status === '未成单' || o.dealType === 'failed') {
        failCount += 1;
        workerMap[wName].failCount += 1;
        return;
      }

      // 提取各项实收款项（平铺字段兼容老版 settlement 对象）
      const oldS = o.settlement || {};
      const curCash = Number(o.cashAmount) || Number(oldS.cash) || 0;
      const curWechat = Number(o.wechatAmount) || Number(oldS.wechat) || 0;
      const curAlipay = Number(o.alipayAmount) || Number(oldS.alipay) || 0;
      
      // 实收定金或实收全款总计
      const curPaid = Number(o.finalAmount) || Number(o.depositAmount) || Number(oldS.paidTotal) || (curCash + curWechat + curAlipay);
      // 待收尾款
      const curBalance = Number(o.remainingAmount) || Number(oldS.balanceAmount) || 0;

      // 只要该工单有收款行为（已完工、预付款单或实收款大于0），计入营收
      const isPaidOrder = o.status === '已完工' || o.settleType === '预付款' || curPaid > 0;

      if (isPaidOrder) {
        wechat += curWechat;
        alipay += curAlipay;
        cash += curCash;
        paidTotal += curPaid;
        balanceTotal += curBalance;
        dealCount += 1;

        workerMap[wName].wechat += curWechat;
        workerMap[wName].alipay += curAlipay;
        workerMap[wName].cash += curCash;
        workerMap[wName].paidTotal += curPaid;
        workerMap[wName].balanceTotal += curBalance;
        workerMap[wName].dealCount += 1;
      }
    });

    const avgTicket = dealCount > 0 ? (paidTotal / dealCount).toFixed(2) : '0.00';

    // 师傅排行榜格式化
    const workerStatsList = Object.values(workerMap)
      .filter(w => {
        if (w.name === '未分配') return false;
        if (!workerOptions.includes(w.name) && w.paidTotal <= 0 && w.dealCount <= 0) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.paidTotal - a.paidTotal)
      .map(w => ({
        ...w,
        paidTotal: w.paidTotal.toFixed(2),
        wechat: w.wechat.toFixed(2),
        alipay: w.alipay.toFixed(2),
        cash: w.cash.toFixed(2),
        balanceTotal: w.balanceTotal.toFixed(2)
      }));

    this.setData({
      periodText,
      stats: {
        paidTotal: paidTotal.toFixed(2),
        wechatTotal: wechat.toFixed(2),
        alipayTotal: alipay.toFixed(2),
        cashTotal: cash.toFixed(2),
        balanceTotal: balanceTotal.toFixed(2),
        dealCount,
        failCount,
        avgTicket
      },
      workerStatsList
    });
  },

  // 一键复制报表
  copyDailyReport() {
    const { periodText, selectedWorkerName, stats, workerStatsList } = this.data;

    let text = `📊 【财务营收报表】\n`;
    text += `⏰ 统计周期：${periodText}\n`;
    text += `👨‍🔧 统计范围：${selectedWorkerName}\n`;
    text += `--------------------------\n`;
    text += `💰 实收总额：¥ ${stats.paidTotal}\n`;
    text += `  • 微信支付：¥ ${stats.wechatTotal}\n`;
    text += `  • 支付宝：  ¥ ${stats.alipayTotal}\n`;
    text += `  • 现金收款：¥ ${stats.cashTotal}\n`;
    text += `--------------------------\n`;
    text += `⚠️ 待收尾款：¥ ${stats.balanceTotal}\n`;
    text += `📈 成单总数：${stats.dealCount} 单 (客单价: ¥${stats.avgTicket})\n`;
    text += `❌ 未成单数：${stats.failCount} 单\n`;
    text += `==========================\n`;
    text += `🏆 师傅业绩明细：\n`;

    if (workerStatsList.length > 0) {
      workerStatsList.forEach((w, idx) => {
        text += `${idx + 1}. ${w.name}：¥${w.paidTotal} (${w.dealCount}单)`;
        if (parseFloat(w.balanceTotal) > 0) text += ` [待收尾款:¥${w.balanceTotal}]`;
        text += `\n`;
      });
    } else {
      text += `暂无结单明细\n`;
    }

    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制报表文本', icon: 'success' });
      }
    });
  }
});