App({
  globalData: {
    currentUser: null,
    currentOpenid: '',
    workerList: []
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: 'cloud1-2g9qjh1nf5e56557',
        traceUser: true
      });

      this.checkAppUpdate();
      this.checkUserAuth();
    }
  },

  checkAppUpdate() {
    if (wx.canIUse('getUpdateManager')) {
      const updateManager = wx.getUpdateManager();
      updateManager.onUpdateReady(() => {
        wx.showModal({
          title: '🔄 更新提示',
          content: '系统已更新到最新版本，点击确定立即重启。',
          showCancel: false,
          confirmText: '立即重启',
          success: (res) => {
            if (res.confirm) {
              updateManager.applyUpdate();
            }
          }
        });
      });
    }
  },

  // 用户身份与 OpenID 核验
  checkUserAuth() {
    return new Promise((resolve) => {
      this.fetchWorkerList();

      // 1. 获取当前微信用户的 OpenID
      wx.cloud.callFunction({
        name: 'login'
      }).then(res => {
        const openid = (res.result && (res.result.openid || res.result.OPENID)) || '';
        this.globalData.currentOpenid = openid;

        if (!openid) {
          if (this.authReadyCallback) this.authReadyCallback(null);
          return resolve(null);
        }

        // 2. 根据 OpenID 精准查询绑定的员工
        const db = wx.cloud.database();
        db.collection('users').where({ openid: openid }).get().then(uRes => {
          if (uRes.data && uRes.data.length > 0) {
            const user = uRes.data[0];
            this.globalData.currentUser = user;
            wx.setStorageSync('currentUser', user);
            if (this.authReadyCallback) this.authReadyCallback(user);
            resolve(user);
          } else {
            // 未绑定当前微信号，清除过期缓存触发核验
            wx.removeStorageSync('currentUser');
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
        console.warn('获取 OpenID 失败：', err);
        const cachedUser = wx.getStorageSync('currentUser');
        if (cachedUser && cachedUser.phone) {
          this.globalData.currentUser = cachedUser;
          if (this.authReadyCallback) this.authReadyCallback(cachedUser);
          resolve(cachedUser);
        } else {
          this.globalData.currentUser = null;
          if (this.authReadyCallback) this.authReadyCallback(null);
          resolve(null);
        }
      });
    });
  },

  fetchWorkerList() {
    const db = wx.cloud.database();
    db.collection('users').where({ role: 'worker' }).get().then(res => {
      this.globalData.workerList = res.data || [];
    }).catch(e => console.error('拉取师傅列表失败：', e));
  }
});