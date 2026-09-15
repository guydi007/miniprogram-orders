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

      this.checkClientPolicy();
      this.checkUserAuth().finally(() => {
        this.globalData.authVerified = true;
      });
    }
  },

  onShow() {
    this.checkClientPolicy();
  },

  checkClientPolicy(force) {
    if (!wx.cloud || (this._policyPromise && !force)) return this._policyPromise;
    this._policyPromise = api.callFunction({ name: 'manageOrder', data: { action: 'getClientPolicy' } })
      .then(res => {
        const policy = res.result || {};
        this.globalData.clientPolicy = policy;
        if (policy.code === 'CLIENT_UPDATE_REQUIRED' && policy.minReadBuild && version.BUILD_NO < policy.minReadBuild) {
          wx.reLaunch({ url: '/pages/update/update' });
        }
        return policy;
      }).catch(err => console.warn('版本策略检查失败：', err))
      .finally(() => { this._policyPromise = null; });
    return this._policyPromise;
  },

  handleClientPolicy(policy) {
    this.globalData.clientPolicy = policy;
    if (policy.minReadBuild && version.BUILD_NO < policy.minReadBuild) wx.reLaunch({ url: '/pages/update/update' });
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
      this.fetchWorkerList();

      // 1. 获取当前微信用户的 OpenID
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
            wx.removeStorageSync('currentUser');
            this.globalData.currentUser = null;
            if (this.authReadyCallback) this.authReadyCallback(null);
            resolve(null);
          }
        }).catch(err => {
          console.error('查询用户信息失败：', err);
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

  fetchWorkerList() {
    const db = wx.cloud.database();
    db.collection('users').where({ role: 'worker' }).get().then(res => {
      this.globalData.workerList = res.data || [];
    }).catch(e => console.error('拉取师傅列表失败：', e));
  }
});
