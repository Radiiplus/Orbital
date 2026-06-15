import { useEffect, useState } from 'react'
import AuthPage from './pages/auth'
import {
  AUTH_PAGE_PATH,
  DASH_PAGE_PATH,
  clearStoredSession,
  getStoredAccessToken,
  getStoredDeviceId,
  refreshSession,
  setDeviceCookie,
  setSessionCookie,
} from './lib/session'
import { apiPath } from './lib/api'
import HomePage from './pages/home'

type SessionPayload = {
  ok?: boolean
  accessToken?: string
  deviceId?: string
  refreshed?: boolean
  message?: string
}

const SESSION_LOG_PREFIX = '[orbital:session]'

function redactValue(value: string | null | undefined) {
  const text = String(value || '').trim()
  if (!text) return null
  if (text.length <= 10) return `${text.slice(0, 4)}...`
  return `${text.slice(0, 6)}...${text.slice(-4)}`
}

function sessionLog(event: string, detail: Record<string, unknown> = {}) {
  console.info(SESSION_LOG_PREFIX, event, detail)
}

async function readSession(accessToken: string, deviceId: string) {
  sessionLog('read_session_start', {
    token: redactValue(accessToken),
    deviceId: redactValue(deviceId),
  })
  const response = await fetch(apiPath('/session'), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-device-id': deviceId,
    },
  })
  const payload = (await response.json().catch(() => ({}))) as SessionPayload
  sessionLog(response.ok && payload.ok === true ? 'read_session_response_ok' : 'read_session_response_failed', {
    status: response.status,
    ok: payload.ok ?? null,
    refreshed: payload.refreshed ?? null,
    returnedToken: redactValue(payload.accessToken),
    returnedDeviceId: redactValue(payload.deviceId),
    headerToken: redactValue(response.headers.get('x-access-token')),
    refreshedHeader: response.headers.get('x-session-refreshed'),
    message: payload.message ?? null,
  })
  if (!response.ok || payload.ok !== true || !payload.accessToken) {
    throw new Error('Session is no longer valid.')
  }

  return {
    accessToken: response.headers.get('x-access-token') || payload.accessToken,
    deviceId: payload.deviceId,
  }
}

function requireAuthForPath(pathname: string) {
  return pathname !== AUTH_PAGE_PATH
}

function replacePath(path: string, setPathname: (pathname: string) => void) {
  sessionLog('replace_path', {
    from: window.location.pathname,
    to: path,
  })
  window.history.replaceState(null, '', path)
  queueMicrotask(() => setPathname(path))
}

function LoadingScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#000000] px-6 text-zinc-100">
      <section className="glass-panel app-reveal w-full max-w-md p-8 text-center">
        <p className="auth-kicker">Orbital</p>
        <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-white">Checking session</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-500">
          Verifying your access token and device before opening the project console.
        </p>
      </section>
    </main>
  )
}

export default function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const [validatedPath, setValidatedPath] = useState<string | null>(null)

  useEffect(() => {
    const syncPath = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', syncPath)
    return () => window.removeEventListener('popstate', syncPath)
  }, [])

  useEffect(() => {
    if (!requireAuthForPath(pathname)) {
      sessionLog('auth_path_skip_validation', {
        pathname,
      })
      return
    }

    const accessToken = getStoredAccessToken()
    const deviceId = getStoredDeviceId()
    sessionLog('guard_start', {
      pathname,
      token: redactValue(accessToken),
      deviceId: redactValue(deviceId),
      hasAccessToken: Boolean(accessToken),
      hasDeviceId: Boolean(deviceId),
    })
    if (!accessToken || !deviceId) {
      sessionLog('guard_missing_credentials_redirect', {
        pathname,
        hasAccessToken: Boolean(accessToken),
        hasDeviceId: Boolean(deviceId),
      })
      replacePath(AUTH_PAGE_PATH, setPathname)
      return
    }

    let active = true

    async function validateSession() {
      try {
        let session = await readSession(accessToken, deviceId)
        if (!session.accessToken) {
          sessionLog('read_session_missing_token_refreshing', {
            token: redactValue(accessToken),
            deviceId: redactValue(deviceId),
          })
          const refreshed = await refreshSession(accessToken, deviceId)
          session = {
            accessToken: refreshed.accessToken,
            deviceId: refreshed.deviceId,
          }
        }

        setSessionCookie(session.accessToken)
        if (session.deviceId) {
          setDeviceCookie(session.deviceId)
        }

        if (!active) {
          sessionLog('guard_inactive_after_validate', {
            pathname,
          })
          return
        }
        const nextPath = pathname === '/' ? DASH_PAGE_PATH : pathname
        sessionLog('guard_validated', {
          pathname,
          nextPath,
          token: redactValue(session.accessToken),
          deviceId: redactValue(session.deviceId),
        })
        setValidatedPath(nextPath)
        if (pathname === '/') {
          replacePath(DASH_PAGE_PATH, setPathname)
        }
      } catch (error) {
        sessionLog('read_session_failed_try_refresh', {
          pathname,
          token: redactValue(accessToken),
          deviceId: redactValue(deviceId),
          message: error instanceof Error ? error.message : String(error),
        })
        if (!active) {
          sessionLog('guard_inactive_after_read_failure', {
            pathname,
          })
          return
        }
        try {
          const refreshed = await refreshSession(accessToken, deviceId)
          setSessionCookie(refreshed.accessToken)
          if (refreshed.deviceId) {
            setDeviceCookie(refreshed.deviceId)
          }
          const nextPath = pathname === '/' ? DASH_PAGE_PATH : pathname
          sessionLog('guard_refresh_recovered', {
            pathname,
            nextPath,
            token: redactValue(refreshed.accessToken),
            deviceId: redactValue(refreshed.deviceId),
          })
          setValidatedPath(nextPath)
          if (pathname === '/') {
            replacePath(DASH_PAGE_PATH, setPathname)
          }
          return
        } catch (refreshError) {
          sessionLog('guard_refresh_failed_redirect_auth', {
            pathname,
            message: refreshError instanceof Error ? refreshError.message : String(refreshError),
          })
          clearStoredSession()
        }
        replacePath(AUTH_PAGE_PATH, setPathname)
        setValidatedPath(null)
      }
    }

    void validateSession()

    return () => {
      active = false
      sessionLog('guard_cleanup', {
        pathname,
      })
    }
  }, [pathname])

  if (pathname === AUTH_PAGE_PATH) {
    return <AuthPage />
  }

  if (validatedPath !== pathname) {
    return <LoadingScreen />
  }

  return <HomePage />
}
