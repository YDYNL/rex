import { ipcMain } from 'electron'
import { safeStorage } from 'electron'

/**
 * 密钥安全存储（safeStorage）
 * - Windows 走 DPAPI（绑定当前用户），macOS 走 Keychain，Linux 走 libsecret
 * - 密文格式：enc:<base64>；加密不可用环境降级 b64:<base64>（仅混淆）
 * - 无前缀 = 明文（旧数据兼容，读取时原样返回）
 */
export function registerSecureIpc(): void {
  ipcMain.handle('secure:encrypt', (_e, plain: string) => {
    try {
      if (!plain) return { ok: true as const, cipher: '' }
      if (safeStorage.isEncryptionAvailable()) {
        const buf = safeStorage.encryptString(plain)
        return { ok: true as const, cipher: `enc:${buf.toString('base64')}` }
      }
      return { ok: true as const, cipher: `b64:${Buffer.from(plain, 'utf8').toString('base64')}` }
    } catch (err) {
      return { ok: false as const, error: `加密失败：${String(err)}` }
    }
  })

  ipcMain.handle('secure:decrypt', (_e, cipher: string) => {
    try {
      if (!cipher) return { ok: true as const, plain: '' }
      if (cipher.startsWith('enc:')) {
        const plain = safeStorage.decryptString(Buffer.from(cipher.slice(4), 'base64'))
        return { ok: true as const, plain }
      }
      if (cipher.startsWith('b64:')) {
        return { ok: true as const, plain: Buffer.from(cipher.slice(4), 'base64').toString('utf8') }
      }
      /* 明文（旧数据 / 加密不可用环境） */
      return { ok: true as const, plain: cipher }
    } catch (err) {
      return { ok: false as const, error: `解密失败：${String(err)}` }
    }
  })
}
