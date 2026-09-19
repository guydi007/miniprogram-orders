import { cloudbase } from './cloudbase'

const resolvedUrlCache = new Map()

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''))
}

function sanitizeFilename(name) {
  return String(name || 'image.jpg').replace(/[\\/:*?"<>|]+/g, '_')
}

function clickDownloadLink(url, filename) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = sanitizeFilename(filename || 'image.jpg')
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function photoFilename(fileRef, fallbackIndex = 1) {
  const raw = String(fileRef || '')
  const withoutQuery = raw.split('?')[0]
  const last = withoutQuery.split('/').pop() || ''
  let decoded = last
  try { decoded = decodeURIComponent(last) } catch { /* keep original */ }
  if (decoded && /\.[a-z0-9]{2,5}$/i.test(decoded)) return sanitizeFilename(decoded)
  return `photo_${fallbackIndex}.jpg`
}

export async function resolvePhotoUrl(fileRef) {
  const ref = String(fileRef || '').trim()
  if (!ref) return ''
  if (isHttpUrl(ref)) return ref
  if (resolvedUrlCache.has(ref)) return resolvedUrlCache.get(ref)

  const storage = cloudbase.storage.from()
  const { data, error } = await storage.createSignedUrl(ref, 3600)
  if (error) throw error
  const url = data?.signedUrl || ''
  if (!url) throw new Error('未取得图片访问地址')
  resolvedUrlCache.set(ref, url)
  return url
}

export async function downloadPhoto(fileRef, filename) {
  const ref = String(fileRef || '').trim()
  if (!ref) throw new Error('图片地址为空')

  const safeFilename = sanitizeFilename(filename || photoFilename(ref))

  // 普通 HTTP(S) 地址直接交给浏览器下载。
  // 对同源地址 download 属性会直接生效；跨域地址则由服务端响应头决定。
  if (isHttpUrl(ref)) {
    clickDownloadLink(ref, safeFilename)
    return
  }

  // CloudBase 传统云存储：不要使用 storage.download() 再转 Blob。
  // 当前 Web SDK / 存储返回链路在部分文件上会出现
  // "Download failed: no file content"。
  // 直接生成带 Content-Disposition 的签名下载地址更稳定。
  const storage = cloudbase.storage.from()
  const { data, error } = await storage.createSignedUrl(ref, 3600, {
    download: safeFilename
  })
  if (error) throw error

  const url = data?.signedUrl || ''
  if (!url) throw new Error('未取得图片下载地址')

  clickDownloadLink(url, safeFilename)
}
