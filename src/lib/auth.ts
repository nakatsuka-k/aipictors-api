import type { Context, Next } from 'hono'
import { json } from '@/lib/json'

const getBearer = (c: Context) => {
  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) {
    return null
  }
  return header.slice('Bearer '.length)
}

export const requireInternalAuth = async (c: Context, next: Next) => {
  const token = getBearer(c)
  const expected = c.env.INTERNAL_API_TOKEN

  if (!expected || token !== expected) {
    return json({ error: 'Unauthorized' }, 401)
  }

  await next()
}

export const requireAdminAuth = async (c: Context, next: Next) => {
  const token = getBearer(c)
  const expected = c.env.ADMIN_API_TOKEN

  if (!expected || token !== expected) {
    return json({ error: 'Unauthorized' }, 401)
  }

  await next()
}
