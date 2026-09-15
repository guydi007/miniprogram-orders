const { CACHE_SCHEMA_VERSION } = require('../config/version');

function migrateCache() {
  const key = 'cacheSchemaVersion';
  const old = Number(wx.getStorageSync(key) || 0);
  if (old !== CACHE_SCHEMA_VERSION) {
    // 列表可重拉，用户填写中的草稿不能清理。
    ['ordersCache', 'workerListCache', 'statsCache'].forEach(item => wx.removeStorageSync(item));
    wx.setStorageSync(key, CACHE_SCHEMA_VERSION);
  }
}

function install(app) {
  migrateCache();
  if (!wx.canIUse('getUpdateManager')) return;
  const manager = wx.getUpdateManager();
  manager.onCheckForUpdate(res => { app.globalData.updateAvailable = !!res.hasUpdate; });
  manager.onUpdateReady(() => {
    if (app.globalData.updatePromptShown) return;
    app.globalData.updatePromptShown = true;
    wx.showModal({
      title: '新版本已下载',
      content: '新版本已准备完成，重启小程序后生效。',
      showCancel: false,
      confirmText: '立即重启',
      success: () => manager.applyUpdate()
    });
  });
  manager.onUpdateFailed(() => {
    wx.showModal({
      title: '更新失败',
      content: '请切换网络后重新进入小程序；仍无法更新时请升级微信或联系管理员。',
      showCancel: false,
      confirmText: '知道了'
    });
  });
}

module.exports = { install, migrateCache };
