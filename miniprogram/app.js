const version = require('./config/version');
const updateService = require('./services/update-service');
const api = require('./services/api');

App({
  globalData: {
    currentUser: null,
    currentOpenid: '',
    authVerified: false,
    workerList: [],
    availableCities: ['天津', '北京']
    ,updateAvailable: false
    ,updatePromptShown: false
    ,clientPolicy: null
  },

  onLaunch() {
    this._appLaunched = true;
    updateService.install(this);
    updateService.migrateCache();
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: 'cloud1-2g9qjh1nf5e56557',
        traceUser: true
      });
      this.installApiVersioning();

      this.checkUserAuth().finally(() => {
        this.globalData.authVerified = true;
      });
    }
  },

  onShow() {
    // 版本策略只在进入前台时检查；避免启动阶段和 onShow 重复请求/重复切页。
    if (this._policyTimer) clearTimeout(this._policyTimer);
    this._policyTimer = setTimeout(() => {
      this._policyTimer = null;
      if (this._appLaunched) this.checkClientPolicy();
    }, 500);
  },

  checkClientPolicy(force) {
    if (!wx.cloud || this._policyPromise) return this._policyPromise;
    this._policyPromise = api.callFunction({ name: 'manageOrder', data: { action: 'getClientPolicy' } })
      .then(res => {
        const policy = res.result || {};
        this.globalData.clientPolicy = policy;
        if (policy.code === 'CLIENT_UPDATE_REQUIRED') this.handleClientPolicy(policy);
        return policy;
      }).catch(err => console.warn('版本策略检查失败：', err))
      .finally(() => { this._policyPromise = null; });
    return this._policyPromise;
  },

  handleClientPolicy(policy) {
    this.globalData.clientPolicy = policy;
    if (policy.minReadBuild && version.BUILD_NO < policy.minReadBuild && !this._updatePageOpening) {
      this._updatePageOpening = true;
      wx.reLaunch({ url: '/pages/update/update', fail: error => {
        this._updatePageOpening = false;
        console.warn('打开强制更新页失败：', error && error.errMsg);
      } });
    }
  },

  installApiVersioning() {
    if (wx.cloud.__versionedCallFunction) return;
    const original = wx.cloud.callFunction.bind(wx.cloud);
    const app = this;
    wx.cloud.callFunction = (options = {}) => {
      const data = options.data && typeof options.data === 'object' ? options.data : {};
      return original({ ...options, data: { ...data, clientVersion: version.APP_VERSION, buildNo: version.BUILD_NO, apiSchema: version.API_SCHEMA } })
        .then(res => {
          const result = res && res.result || {};
          if (result.code === 'CLIENT_UPDATE_REQUIRED') app.handleClientPolicy(result.policy || result);
          return res;
        });
    };
    wx.cloud.__versionedCallFunction = true;
  },

  // 用户身份与 OpenID 核验
  checkUserAuth() {
    return new Promise((resolve) => {
      // 1. 获取当前微信用户的 OpenID / 测试会话
      wx.cloud.callFunction({
        name: 'login'
      }).then(res => {
        const openid = (res.result && (res.result.openid || res.result.OPENID)) || '';
        this.globalData.currentOpenid = openid;

        const cachedUser = wx.getStorageSync('currentUser');

        // 测试账号不绑定 users.openid，由云端测试会话恢复身份。
        if (res.result && res.result.user && res.result.user.isTest === true) {
          const testUser = res.result.user;
          this.globalData.currentUser = testUser;
          wx.setStorageSync('currentUser', testUser);
          if (this.authReadyCallback) this.authReadyCallback(testUser);
          return resolve(testUser);
        }

        if (!openid) {
          wx.removeStorageSync('currentUser');
          this.globalData.currentUser = null;
          if (this.authReadyCallback) this.authReadyCallback(null);
          return resolve(null);
        }

        // 2. 正式员工身份只通过云函数读取，客户端不直接访问 users 集合。
        wx.cloud.callFunction({
          name: 'manageOrder',
          data: { action: 'getSessionUser' }
        }).then(sessionRes => {
          const result = sessionRes.result || {};
          if (result.success && result.user) {
            const user = result.user;
            this.globalData.currentUser = user;
            wx.setStorageSync('currentUser', user);
            if (this.authReadyCallback) this.authReadyCallback(user);
            resolve(user);
          } else {
            wx.removeStorageSync('currentUser');
            this.globalData.currentUser = null;
            if (this.authReadyCallback) this.authReadyCallback(null);
            resolve(null);
          }
        }).catch(err => {
          console.error('查询登录员工失败：', err);
          wx.removeStorageSync('currentUser');
          this.globalData.currentUser = null;
          if (this.authReadyCallback) this.authReadyCallback(null);
          resolve(null);
        });
      }).catch(err => {
        console.warn('获取 OpenID 失败：', err);
        wx.removeStorageSync('currentUser');
        this.globalData.currentUser = null;
        if (this.authReadyCallback) this.authReadyCallback(null);
        resolve(null);
      });
    });
  },

});
