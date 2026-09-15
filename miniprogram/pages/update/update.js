Page({
  retry() {
    const app = getApp();
    if (app && app.checkClientPolicy) app.checkClientPolicy(true);
  }
});
