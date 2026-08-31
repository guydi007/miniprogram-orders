const app = getApp();

function formatDate(date) {
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 提取工单中的规范日期 YYYY-MM-DD
function extractOrderDate(order) {
  const str = order.appointmentTime || order.createTime || '';
  const match = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${match[1]}-${pad(parseInt(match[2], 10))}-${pad(parseInt(match[3], 10))}`;
  }
  return str.slice(0, 10);
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

    // 统计数据看板
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

    // 师傅排行榜
    workerStatsList: []
  },

  onLoad() {
    // 权限校验：仅管理员可访问
    const user = app.globalData.currentUser;
    if (!user || user.role !== 'admin') {
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
    });
  },

  loadAllOrders() {
    wx.showLoading({ title: '正在统计营收...' });
    const db = wx.cloud.database();
    db.collection('orders').limit(1000).get().then(res => {
      this.setData({ allOrders: res.data || [] });
      this.calculateStats();
      wx.hideLoading();
    }).catch(err => {
      console.error(err);
      wx.hideLoading();
    });
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

  // 核心统计计算引擎
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

    // 1. 日期区间过滤
    let filtered = allOrders.filter(o => {
      const orderDate = extractOrderDate(o);
      if (!orderDate) return false;
      return orderDate >= startDate && orderDate <= endDate;
    });

    // 2. 师傅过滤
    if (selectedWorkerName !== '全部师傅') {
      filtered = filtered.filter(o => o.workerName === selectedWorkerName);
    }

    // 3. 财务核算
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

      if (o.status === '已完工' && o.settlement) {
        const s = o.settlement;
        const w = parseFloat(s.wechat) || 0;
        const a = parseFloat(s.alipay) || 0;
        const c = parseFloat(s.cash) || 0;
        const p = parseFloat(s.paidTotal) || (w + a + c);
        const b = parseFloat(s.balanceAmount) || 0;

        wechat += w;
        alipay += a;
        cash += c;
        paidTotal += p;
        balanceTotal += b;
        dealCount += 1;

        workerMap[wName].wechat += w;
        workerMap[wName].alipay += a;
        workerMap[wName].cash += c;
        workerMap[wName].paidTotal += p;
        workerMap[wName].balanceTotal += b;
        workerMap[wName].dealCount += 1;
      } else if (o.status === '未成单') {
        failCount += 1;
        workerMap[wName].failCount += 1;
      }
    });

    const avgTicket = dealCount > 0 ? (paidTotal / dealCount).toFixed(2) : '0.00';

    // 4. 师傅排行榜过滤逻辑（方法 2：自动过滤未分配与已删除且0业绩的历史师傅）
    const workerStatsList = Object.values(workerMap)
      .filter(w => {
        // 过滤掉未分配
        if (w.name === '未分配') return false;
        // 如果师傅已经不在当前 users 表里，且在该周期内没有任何成单业绩，则直接隐藏
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
    text += `📈 完工单数：${stats.dealCount} 单 (客单价: ¥${stats.avgTicket})\n`;
    text += `❌ 未成单数：${stats.failCount} 单\n`;
    text += `==========================\n`;
    text += `🏆 师傅业绩明细：\n`;

    if (workerStatsList.length > 0) {
      workerStatsList.forEach((w, idx) => {
        text += `${idx + 1}. ${w.name}：¥${w.paidTotal} (${w.dealCount}单)`;
        if (parseFloat(w.balanceTotal) > 0) text += ` [尾款:¥${w.balanceTotal}]`;
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