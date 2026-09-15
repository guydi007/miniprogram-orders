const version = require('../config/version');

function callFunction(options = {}) {
  const data = options.data && typeof options.data === 'object' ? options.data : {};
  return wx.cloud.callFunction({
    ...options,
    data: { ...data, clientVersion: version.APP_VERSION, buildNo: version.BUILD_NO, apiSchema: version.API_SCHEMA }
  }).then(res => {
    const result = res && res.result || {};
    if (result.code === 'CLIENT_UPDATE_REQUIRED') {
      const app = getApp();
      if (app && app.handleClientPolicy) app.handleClientPolicy(result.policy || result);
    }
    return res;
  });
}

module.exports = { callFunction, version };
