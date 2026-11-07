import mongoose from 'mongoose'

type MongooseCache = typeof globalThis & { exhibityMongoPromise?: Promise<typeof mongoose> }
const globalCache = globalThis as MongooseCache

export async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose

  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI must be configured.')

  if (!globalCache.exhibityMongoPromise) {
    globalCache.exhibityMongoPromise = mongoose.connect(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10_000 }).catch((error: unknown) => {
      globalCache.exhibityMongoPromise = undefined
      throw error
    })
  }

  return globalCache.exhibityMongoPromise
}
