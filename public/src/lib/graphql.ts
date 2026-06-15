import { apiPath, API_URL } from './api'

const DEFAULT_GRAPHQL_URL = 'https://eiwifodbwwingurqifjx.supabase.co/functions/v1/orbital-api/graphql'

function defaultGraphqlEndpoint() {
  if (API_URL) return apiPath('/graphql')
  return DEFAULT_GRAPHQL_URL
}

export const GRAPHQL_ENDPOINT = import.meta.env.VITE_GRAPHQL_URL || defaultGraphqlEndpoint()
export const BACKEND_ENDPOINT = GRAPHQL_ENDPOINT.replace(/\/graphql$/, '')
