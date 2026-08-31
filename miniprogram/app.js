App({
  globalData: {
    currentUser: null, // 仅存放真正认证成功的员工对象 { _id, name, role, phone, openid }
    workerList: []
  },

  onLaunch() {
    // 1. 初始化云开发环境
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: 'cloud1-2g9qjh1nf5e56557',
        traceUser: true
      });

      // 2. 检查更新
      this.checkAppUpdate();

      // 3. 执行身份鉴权
      this.checkUserAuth();
    }
  },

  // 🚀 版本管理：自动检测新版本并提示热更新
  checkAppUpdate() {
    if (wx.canIUse('getUpdateManager')) {
      const updateManager = wx.getUpdateManager();

      updateManager.onCheckForUpdate((res) => {
        if (res.hasUpdate) {
          console.log('检测到小程序有新版本发布！');
        }
      });

      updateManager.onUpdateReady(() => {
        wx.showModal({
          title: '🔄 更新提示',
          content: '系统已更新到最新版本，点击确定立即重启体验新功能。',
          showCancel: false,
          confirmText: '立即重启',
          success: (res) => {
            if (res.confirm) {
              updateManager.applyUpdate();
            }
          }
        });
      });

      updateManager.onUpdateFailed(() => {
        wx.showToast({
          title: '新版本下载失败，请稍后重试',
          icon: 'none'
        });
      });
    }
  },

  // 用户身份核验
  checkUserAuth() {
    return new Promise((resolve) => {
      // 1. 同步拉取师傅列表备用
      this.fetchWorkerList();

      // 2. 优先检查本地缓存（防止断网或重复请求）
      const cachedUser = wx.getStorageSync('currentUser');
      if (cachedUser && cachedUser.phone) {
        this.globalData.currentUser = cachedUser;
        if (this.authReadyCallback) {
          this.authReadyCallback(cachedUser);
        }
        return resolve(cachedUser);
      }

      // 3. 通过云函数获取 OpenID 匹配数据库
      wx.cloud.callFunction({
        name: 'login'
      }).then(res => {
        const openid = (res.result && (res.result.openid || res.result.OPENID)) || '';
        if (!openid) {
          if (this.authReadyCallback) this.authReadyCallback(null);
          return resolve(null);
        }

        const db = wx.cloud.database();
        db.collection('users').where({ openid: openid }).get().then(uRes => {
          if (uRes.data && uRes.data.length > 0) {
            const user = uRes.data[0];
            this.globalData.currentUser = user;
            wx.setStorageSync('currentUser', user); // 持久化
            if (this.authReadyCallback) this.authReadyCallback(user);
            resolve(user);
          } else {
            // 未绑定的微信号，置空触发弹窗
            this.globalData.currentUser = null;
            if (this.authReadyCallback) this.authReadyCallback(null);
            resolve(null);
          }
        }).catch(err => {
          console.error('查询用户信息失败：', err);
          this.globalData.currentUser = null;
          if (this.authReadyCallback) this.authReadyCallback(null);
          resolve(null);
        });
      }).catch(err => {
        console.warn('调用 login 云函数失败或未部署，转为手动输入手机号：', err);
        this.globalData.currentUser = null;
        if (this.authReadyCallback) this.authReadyCallback(null);
        resolve(null);
      });
    });
  },

  fetchWorkerList() {
    const db = wx.cloud.database();
    db.collection('users').where({ role: 'worker' }).get().then(res => {
      this.globalData.workerList = res.data || [];
    }).catch(e => console.error(e));
  }
});