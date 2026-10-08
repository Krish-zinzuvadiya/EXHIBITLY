import dotenv from 'dotenv'
import express from 'express'
import { resolve } from 'node:path'

dotenv.config({ path: resolve(process.cwd(), '../.env') })

const [{ default: app }, { connectToDatabase }] = await Promise.all([
  import('./index.js'),
  import('./database.js'),
])

await connectToDatabase()

if (process.env.NODE_ENV === 'production') {
  const distPath = resolve(process.cwd(), '../dist')
  app.use(express.static(distPath))
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(distPath, 'index.html')))
}

const port = Number(process.env.PORT || 4000)
app.listen(port, () => console.log(`Exhibity API listening on http://localhost:${port}`))
