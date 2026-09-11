export * as BaiduCredential from "./baidu-credential"

import { Effect } from "effect"
import { Auth } from "../auth"
import { SyncSecureStore } from "./secure-store"

export const KEY = "opencode-transit/baidu"

export type Application = {
  readonly appKey: string
  readonly secretKey: string
}

export type Credential = Application & {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly account?: {
    readonly id: string
    readonly displayName: string
    readonly maskedDisplay: string
  }
}

export interface Store {
  readonly application: () => Promise<Application | undefined>
  readonly credential: (deviceID: string) => Promise<Credential | undefined>
  readonly saveApplication: (application: Application) => Promise<void>
  readonly saveCredential: (deviceID: string, credential: Credential) => Promise<void>
  readonly remove: (deviceID: string) => Promise<void>
  readonly pending: (deviceID: string) => Promise<string | undefined>
  readonly savePending: (deviceID: string, value: string) => Promise<void>
  readonly removePending: (deviceID: string) => Promise<void>
}

export function auth(auth: Auth.Interface): Store {
  const get = () => Effect.runPromise(auth.get(KEY))
  const set = (value: Auth.Info) => Effect.runPromise(auth.set(KEY, value))
  return {
    async application() {
      return application(await get())
    },
    async credential() {
      const value = await get()
      if (value?.type !== "oauth") return
      const app = application(value)
      if (!app) return
      return {
        ...app,
        accessToken: value.access,
        refreshToken: value.refresh,
        expiresAt: value.expires,
        ...(value.accountId
          ? {
              account: {
                id: value.accountId,
                displayName: value.metadata?.accountDisplayName ?? "Baidu account",
                maskedDisplay: value.metadata?.accountMaskedDisplay ?? "Baidu account",
              },
            }
          : {}),
      }
    },
    async saveApplication(value) {
      validateApplication(value)
      const current = await get()
      if (current?.type === "oauth") {
        await set(
          new Auth.Oauth({
            ...current,
            metadata: { ...current.metadata, appKey: value.appKey, secretKey: value.secretKey },
          }),
        )
        return
      }
      await set(
        new Auth.Api({
          type: "api",
          key: value.secretKey,
          metadata: { ...(current?.type === "api" ? current.metadata : {}), appKey: value.appKey },
        }),
      )
    },
    async saveCredential(_deviceID, value) {
      validateCredential(value)
      const current = await get()
      await set(
        new Auth.Oauth({
          type: "oauth",
          refresh: value.refreshToken,
          access: value.accessToken,
          expires: value.expiresAt,
          accountId: value.account?.id,
          metadata: {
            ...(current?.type === "api" || current?.type === "oauth" ? current.metadata : {}),
            appKey: value.appKey,
            secretKey: value.secretKey,
            ...(value.account
              ? {
                  accountDisplayName: value.account.displayName,
                  accountMaskedDisplay: value.account.maskedDisplay,
                }
              : {}),
          },
        }),
      )
    },
    async remove() {
      await Effect.runPromise(auth.remove(KEY))
    },
    async pending(deviceID) {
      const value = await get()
      if (!value || value.type === "wellknown" || value.metadata?.pendingDeviceID !== deviceID) return
      return value.metadata.oauthPending
    },
    async savePending(deviceID, value) {
      validateDevice(deviceID)
      const current = await get()
      if (!current || current.type === "wellknown") throw new Error("Baidu application credential is missing")
      await set(withMetadata(current, { ...current.metadata, pendingDeviceID: deviceID, oauthPending: value }))
    },
    async removePending(deviceID) {
      const current = await get()
      if (!current || current.type === "wellknown" || current.metadata?.pendingDeviceID !== deviceID) return
      const metadata = { ...current.metadata }
      delete metadata.pendingDeviceID
      delete metadata.oauthPending
      await set(withMetadata(current, metadata))
    },
  }
}

export function legacy(store: SyncSecureStore.Store): Store {
  return {
    application: () => SyncSecureStore.readLegacyBaiduApp(store),
    async credential(deviceID) {
      const value = await store.get(credentialAccount(deviceID))
      if (!value) return
      return parseCredential(value)
    },
    saveApplication: async (value) => store.set(SyncSecureStore.BAIDU_APP_ACCOUNT, JSON.stringify(value)),
    saveCredential: async (deviceID, value) => store.set(credentialAccount(deviceID), JSON.stringify(value)),
    remove: async (deviceID) => store.remove(credentialAccount(deviceID)),
    pending: (deviceID) => store.get(pendingAccount(deviceID)),
    savePending: (deviceID, value) => store.set(pendingAccount(deviceID), value),
    removePending: (deviceID) => store.remove(pendingAccount(deviceID)),
  }
}

export async function importLegacy(current: Store, previous: SyncSecureStore.Store, deviceID: string) {
  const old = legacy(previous)
  const credential = await old.credential(deviceID)
  if (credential) {
    await current.saveCredential(deviceID, credential)
    const verified = await current.credential(deviceID)
    if (JSON.stringify(verified) !== JSON.stringify(credential))
      throw new Error("Legacy credential verification failed")
    return credential
  }
  const app = await old.application()
  if (!app) return
  await current.saveApplication(app)
  const verified = await current.application()
  if (JSON.stringify(verified) !== JSON.stringify(app)) throw new Error("Legacy credential verification failed")
  return app
}

function application(value: Auth.Info | undefined) {
  if (value?.type === "api" && value.metadata?.appKey)
    return { appKey: value.metadata.appKey, secretKey: value.key } satisfies Application
  if (value?.type === "oauth" && value.metadata?.appKey && value.metadata.secretKey)
    return { appKey: value.metadata.appKey, secretKey: value.metadata.secretKey } satisfies Application
}

function withMetadata(value: Auth.Api | Auth.Oauth, metadata: Record<string, string>) {
  if (value.type === "api") return new Auth.Api({ ...value, metadata })
  return new Auth.Oauth({ ...value, metadata })
}

function parseCredential(value: string) {
  const parsed = JSON.parse(value) as Credential
  validateCredential(parsed)
  return parsed
}

function validateCredential(value: Credential) {
  validateApplication(value)
  for (const item of [value.accessToken, value.refreshToken]) {
    if (!item || /[\r\n\0]/.test(item)) throw new Error("Invalid Baidu credential")
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) throw new Error("Invalid Baidu credential")
}

function validateApplication(value: Application) {
  for (const item of [value.appKey, value.secretKey]) {
    if (!item || item.length > 512 || /[\r\n\0]/.test(item)) throw new Error("Invalid Baidu application credential")
  }
}

function credentialAccount(deviceID: string) {
  validateDevice(deviceID)
  return `baidu:${deviceID}`
}

function pendingAccount(deviceID: string) {
  validateDevice(deviceID)
  return `baidu:oauth-pending:${deviceID}`
}

function validateDevice(deviceID: string) {
  if (!deviceID || /[\r\n\0]/.test(deviceID)) throw new Error("Invalid sync device ID")
}
