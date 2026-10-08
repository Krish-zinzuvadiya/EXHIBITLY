import type { Request, Response } from 'express'
import app from '../server/src/index.js'
import { connectToDatabase } from '../server/src/database.js'

export default async function handler(req: Request, res: Response) {
  try {
    const currentUrl = new URL(req.url || '/api/bridge', 'http://localhost')
    const route = currentUrl.searchParams.get('__route') || ''
    if (!route || !/^[a-z0-9/_-]+$/i.test(route) || route.includes('..')) {
      return res.status(400).json({ message: 'Invalid API route.' })
    }

    currentUrl.searchParams.delete('__route')
    req.url = `/api/${route}${currentUrl.search}`

    await connectToDatabase()
    return app(req, res)
  } catch (error) {
    console.error('Exhibity API could not connect to MongoDB:', error)
    return res.status(503).json({ message: 'The database is temporarily unavailable. Please try again.' })
  }
}
