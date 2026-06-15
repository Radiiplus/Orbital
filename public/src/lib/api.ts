const DEFAULT_API_URL = 'https://eiwifodbwwingurqifjx.supabase.co/functions/v1/orbital-api'

const RAW_API_URL = import.meta.env.VITE_API_URL || DEFAULT_API_URL

export const API_URL = RAW_API_URL.replace(/\/+$/, '')

export function apiPath(path: string) {
  if (/^https?:\/\//i.test(path)) return path
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${API_URL}${normalized}`
}

export function backendFromGraphql(graphqlUrl: string) {
  return graphqlUrl.replace(/\/graphql$/, '')
}
