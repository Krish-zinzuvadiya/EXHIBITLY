import type { Request, Response } from 'express'
import app from '../server/src/index.js'
import { connectToDatabase } from '../server/src/database.js'

export default async function handler(req: Request, res: Response) {
  try {
    await connectToDatabase()
    app(req, res)
  } catch (error) {
    console.error('Exhibity API could not connect to MongoDB:', error)
    res.status(503).json({ message: 'The database is temporarily unavailable. Please try again.' })
  }
}
