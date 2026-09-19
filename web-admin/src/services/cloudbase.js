import cloudbaseSDK from '@cloudbase/js-sdk'

const options = {
  env: import.meta.env.VITE_CLOUDBASE_ENV_ID || 'cloud1-2g9qjh1nf5e56557'
}

if (import.meta.env.VITE_CLOUDBASE_REGION) {
  options.region = import.meta.env.VITE_CLOUDBASE_REGION
}
if (import.meta.env.VITE_CLOUDBASE_ACCESS_KEY) {
  options.accessKey = import.meta.env.VITE_CLOUDBASE_ACCESS_KEY
}

export const cloudbase = cloudbaseSDK.init(options)
export const auth = cloudbase.auth
