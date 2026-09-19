const https = require('https');
const crypto = require('crypto');

function failure(code, msg) {
  return { success: false, code, msg };
}

// 只使用自定义文案和经过校验的数字；服务商原始 message 可能包含 Key / URL。
const providerErrors = {
  110: ['MAP_SOURCE_UNAUTHORIZED', '地图请求来源未授权，请管理员检查 Key 的安全配置'],
  111: ['MAP_SIGNATURE_REJECTED', '地图签名校验失败，请管理员核对配套的 Key 和 SK，或复制地址自行搜索'],
  112: ['MAP_IP_UNAUTHORIZED', '地图请求 IP 未授权，请管理员检查 Key 的安全配置'],
  113: ['MAP_FEATURE_UNAUTHORIZED', '地图地址解析功能未授权，请管理员检查 Key 的接口权限和额度分配'],
  120: ['MAP_RATE_LIMITED', '地图请求过于频繁，请稍后重试；管理员可检查 Key 的并发额度'],
  121: ['MAP_DAILY_QUOTA_EXCEEDED', '地图当日调用额度不足，请管理员检查该 Key 的额度分配和用量，或复制地址自行搜索'],
  190: ['MAP_KEY_INVALID', '地图 Key 无效，请管理员核对云函数中的地图 Key'],
  199: ['MAP_WEBSERVICE_DISABLED', '地图 Key 未启用 WebServiceAPI，请管理员到腾讯位置服务开启'],
  311: ['MAP_KEY_INVALID', '地图 Key 格式错误，请管理员重新复制正确的地图 Key'],
  347: ['MAP_NO_RESULTS', '地图查询没有结果，请核对城市、小区、道路或门牌号，或复制地址自行搜索']
};

function mapFailure(code, msg, status, httpStatus) {
  const providerStatus = Number.isInteger(status) && status >= 0 && status <= 999999 ? status : null;
  const safeHttpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  const diagnostic = { code, providerStatus, httpStatus: safeHttpStatus };
  // 不记录地址、订单、坐标、Key、SK、签名、请求 URL 或原始异常。
  try { console.warn('[map-geocoder]', JSON.stringify(diagnostic)); } catch (error) { /* 日志失败不改变结果 */ }
  const suffix = providerStatus !== null && providerStatus !== 0 ? `（腾讯错误码：${providerStatus}）` : '';
  return { ...failure(code, msg + suffix), providerStatus, httpStatus: safeHttpStatus };
}

function requestGeocoder(target) {
  return new Promise((resolve, reject) => {
    const req = https.get(target, res => {
      res.setEncoding('utf8');
      let body = '';
      let size = 0;
      res.on('data', chunk => {
        size += Buffer.byteLength(chunk, 'utf8');
        if (size > 65536) req.destroy(new Error('MAP_RESPONSE_TOO_LARGE'));
        else body += chunk;
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const error = new Error('MAP_HTTP_FAILED');
          error.httpStatus = res.statusCode;
          return reject(error);
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(new Error('MAP_INVALID_RESPONSE')); }
      });
    });
    // 整体截止时间，防止慢响应拖住工单云函数；错误不包含请求 URL / Key。
    const timer = setTimeout(() => req.destroy(new Error('MAP_TIMEOUT')), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

function cleanCity(value) {
  return value.trim().replace(/(市|地区|自治州|盟)$/, '');
}

function buildGeocoderUrl(address, city, key, secret) {
  const target = new URL('https://apis.map.qq.com/ws/geocoder/v1/');
  const params = { address: address.includes(city) ? address : city + address,
    region: city, key, output: 'json', policy: '0' };
  const names = Object.keys(params).sort();
  // 腾讯 GET 签名使用未编码原值，按参数名排序；路径的末尾斜杠与请求保持一致。
  const originalQuery = names.map(name => `${name}=${params[name]}`).join('&');
  const sig = crypto.createHash('md5').update(`${target.pathname}?${originalQuery}${secret}`, 'utf8').digest('hex');
  names.forEach(name => target.searchParams.set(name, params[name]));
  target.searchParams.set('sig', sig);
  // SK 仅用于计算签名，绝不作为查询参数发送。
  return target;
}

async function resolveOrderLocation(order, key = process.env.TENCENT_MAP_KEY, request = requestGeocoder,
  secret = process.env.TENCENT_MAP_SECRET) {
  const address = typeof order.address === 'string' ? order.address.trim() : '';
  const city = typeof order.city === 'string' ? order.city.trim() : '';
  if (!address || address.length > 256) return failure('INVALID_ADDRESS', '服务地址为空或过长，请先核对地址');
  if (!city || city.length > 64) return failure('INVALID_CITY', '工单城市未填写，无法安全定位，请先联系录单人员');
  if (typeof key !== 'string' || !key.trim()) return failure('MAP_NOT_CONFIGURED', '地图服务尚未配置，请先复制地址到地图中搜索');
  if (typeof secret !== 'string' || !secret.trim()) {
    return failure('MAP_SECRET_NOT_CONFIGURED', '地图签名密钥尚未配置，请管理员配置后重试，或复制地址自行搜索');
  }

  try {
    const target = buildGeocoderUrl(address, city, key.trim(), secret.trim());
    const response = await request(target);
    const status = response && response.status;
    if (!Number.isInteger(status) || status < 0 || status > 999999) {
      return mapFailure('MAP_INVALID_RESPONSE', '地图返回数据异常，请稍后重试，或复制地址自行搜索');
    }
    if (status !== 0) {
      let mapped = providerErrors[status];
      if (!mapped && status >= 300 && status < 500) mapped = ['MAP_INVALID_REQUEST', '地图请求参数不符合要求，请管理员检查地址解析请求'];
      if (!mapped && status >= 500 && status <= 600) mapped = ['MAP_PROVIDER_UNAVAILABLE', '腾讯地图服务暂时异常，请稍后重试，或复制地址自行搜索'];
      mapped = mapped || ['MAP_LOOKUP_FAILED', '地图接口查询失败，请管理员查看错误码，或复制地址自行搜索'];
      return mapFailure(mapped[0], mapped[1], status, 200);
    }
    if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
      return mapFailure('MAP_INVALID_RESPONSE', '地图未返回有效地点数据，请稍后重试，或复制地址自行搜索', 0, 200);
    }
    const result = response.result;
    const point = result.location || {};
    if (typeof point.lat !== 'number' || typeof point.lng !== 'number' ||
        !Number.isFinite(point.lat) || !Number.isFinite(point.lng) ||
        Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180 || (point.lat === 0 && point.lng === 0)) {
      return failure('MAP_INVALID_COORDINATES', '地图未返回有效坐标，请复制地址自行搜索');
    }
    const parts = result.address_components || {};
    if (typeof parts.city !== 'string' || cleanCity(parts.city) !== cleanCity(city)) {
      return failure('MAP_CITY_MISMATCH', '地图匹配城市与工单不一致，已停止打开，请核对地址');
    }
    // level: 0 未知，1 城市，2 区县，3 乡镇，7 道路，9 门址，10 小区，11 POI。
    if (typeof result.level !== 'number' || !Number.isFinite(result.level) || result.level < 7) {
      return failure('MAP_ADDRESS_TOO_VAGUE', '地址未定位到道路或具体地点，请补充小区、道路或门牌号');
    }
    if (typeof result.reliability !== 'number' || !Number.isFinite(result.reliability) || result.reliability < 7) {
      return failure('MAP_LOW_CONFIDENCE', '地址匹配可信度不足，请核对详细地址或复制地址自行搜索');
    }
    const regionParts = parts.province === parts.city ? [parts.city, parts.district] : [parts.province, parts.city, parts.district];
    const resolvedAddress = [...regionParts,
      result.title || [parts.street, parts.street_number].filter(Boolean).join('')].filter(Boolean).join('');
    return { success: true, location: {
      latitude: point.lat, longitude: point.lng, coordinateSystem: 'gcj02',
      name: typeof result.title === 'string' && result.title ? result.title.slice(0, 100) : '工单服务地点（请核对）',
      address, city, resolvedAddress: String(resolvedAddress || '地图匹配位置').slice(0, 256)
    } };
  } catch (error) {
    if (error && error.message === 'MAP_HTTP_FAILED') {
      return mapFailure('MAP_HTTP_FAILED', '地图 HTTP 请求失败，请稍后重试，或复制地址自行搜索', null, error.httpStatus);
    }
    if (error && error.message === 'MAP_TIMEOUT') {
      return mapFailure('MAP_TIMEOUT', '地图查询超时，请稍后重试，或复制地址自行搜索');
    }
    if (error && ['MAP_INVALID_RESPONSE', 'MAP_RESPONSE_TOO_LARGE'].includes(error.message)) {
      return mapFailure('MAP_INVALID_RESPONSE', '地图返回数据异常，请稍后重试，或复制地址自行搜索');
    }
    return mapFailure('MAP_REQUEST_FAILED', '地图查询失败，请检查网络或稍后重试，或复制地址自行搜索');
  }
}

module.exports = { resolveOrderLocation, requestGeocoder, buildGeocoderUrl };
