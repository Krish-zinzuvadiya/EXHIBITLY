import express, { type NextFunction, type Request, type Response } from 'express'
import mongoose, { Types } from 'mongoose'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import XLSX from 'xlsx'
import { z } from 'zod'
import { Activity, Expo, Lead, User } from './models.js'

const app = express()
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET must be configured in production.')
if (process.env.NODE_ENV === 'production' && !process.env.MONGODB_URI) throw new Error('MONGODB_URI must be configured in production.')
const jwtSecret = process.env.JWT_SECRET || 'local-development-secret-change-before-deploying'
const statuses = ['interested', 'called', 'not-interested', 'good-presence'] as const
type LeadStatus = typeof statuses[number]
type AuthedRequest = Request & { userId?: string }

app.set('trust proxy', 1)
app.use(helmet({ contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'https://www.google.com', 'https://*.googleusercontent.com'] } } }))
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }))

const objectId = (value: unknown) => typeof value === 'string' && Types.ObjectId.isValid(value)
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || '' : value || ''
const auth = (req: AuthedRequest, res: Response, next: NextFunction) => {
  const token = req.cookies?.expo_session as string | undefined
  if (!token) return res.status(401).json({ message: 'Please sign in to continue.' })
  try {
    const claims = jwt.verify(token, jwtSecret) as jwt.JwtPayload
    req.userId = String(claims.sub)
    next()
  } catch { return res.status(401).json({ message: 'Your session has expired. Please sign in again.' }) }
}
const userOnly = (req: AuthedRequest) => ({ userId: req.userId })
const isStatus = (value: unknown): value is LeadStatus => statuses.includes(value as LeadStatus)
const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' }
const issueSession = (res: Response, userId: string) => res.cookie('expo_session', jwt.sign({}, jwtSecret, { subject: userId, expiresIn: '7d' }), { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 })
const asyncRoute = (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req as AuthedRequest, res)).catch(next)
const recordActivity = (userId: string, description: string, fields: { action: string; expoId?: Types.ObjectId | string; leadId?: Types.ObjectId | string; metadata?: object }) => Activity.create({ userId, description, ...fields })
const getOwnedExpo = (expoId: string, userId: string) => Expo.findOne({ _id: expoId, userId })

app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 }))

app.get('/api/auth/registration-open', asyncRoute(async (_req, res) => res.json({ open: (await User.countDocuments()) === 0 })))
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().email().max(254), password: z.string().min(10).max(128) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Enter your name, a valid email and a password with at least 10 characters.' })
  if (await User.exists({})) return res.status(403).json({ message: 'Workspace setup is already complete. Sign in instead.' })
  const { name, email, password } = parsed.data
  const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 12) })
  issueSession(res, String(user._id))
  return res.status(201).json({ user: { id: user._id, name: user.name, email: user.email } })
}))
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const parsed = z.object({ email: z.string().trim().email(), password: z.string().min(1) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Enter your email and password.' })
  const user = await User.findOne({ email: parsed.data.email.toLowerCase() })
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ message: 'Email or password is incorrect.' })
  issueSession(res, String(user._id))
  return res.json({ user: { id: user._id, name: user.name, email: user.email } })
}))
app.post('/api/auth/logout', (_req, res) => res.clearCookie('expo_session', cookieOptions).json({ ok: true }))
app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const user = await User.findById(req.userId).select('name email')
  if (!user) return res.status(401).json({ message: 'Account not found.' })
  return res.json({ user: { id: user._id, name: user.name, email: user.email } })
}))

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  const userId = req.userId!
  const [expoCount, leadCount, statusCounts, expos, activities] = await Promise.all([
    Expo.countDocuments(userOnly(req)), Lead.countDocuments(userOnly(req)),
    Lead.aggregate([{ $match: { userId: new Types.ObjectId(userId) } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Expo.aggregate([{ $match: { userId: new Types.ObjectId(userId) } }, { $lookup: { from: 'leads', let: { expoId: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$expoId', '$$expoId'] } } }, { $group: { _id: '$status', count: { $sum: 1 } } }], as: 'statusCounts' } }, { $addFields: { leadCount: { $sum: '$statusCounts.count' } } }, { $sort: { startDate: -1, createdAt: -1 } }, { $limit: 5 }]),
    Activity.find(userOnly(req)).sort({ createdAt: -1 }).limit(8).populate('expoId', 'name').lean(),
  ])
  const counts = Object.fromEntries(statusCounts.map((item: { _id: string; count: number }) => [item._id, item.count]))
  return res.json({ stats: { expoCount, leadCount, interested: counts.interested || 0, called: counts.called || 0, notInterested: counts['not-interested'] || 0, goodPresence: counts['good-presence'] || 0 }, expos, activities })
}))

app.get('/api/expos', auth, asyncRoute(async (req, res) => {
  const search = String(req.query.search || '').trim()
  const regex = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null
  const filter = { userId: new Types.ObjectId(req.userId!), ...(regex ? { $or: [{ name: regex }, { venue: regex }, { city: regex }, { organizer: regex }] } : {}) }
  const rows = await Expo.aggregate([{ $match: filter }, { $lookup: { from: 'leads', let: { id: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$expoId', '$$id'] } } }, { $group: { _id: '$status', count: { $sum: 1 } } }], as: 'counts' } }, { $addFields: { leadCount: { $sum: '$counts.count' }, interested: { $sum: { $map: { input: '$counts', as: 's', in: { $cond: [{ $eq: ['$$s._id', 'interested'] }, '$$s.count', 0] } } } } } }, { $sort: { startDate: -1, createdAt: -1 } }])
  return res.json(rows)
}))
app.post('/api/expos', auth, asyncRoute(async (req, res) => {
  const parsed = expoSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Expo name is required.' })
  const expo = await Expo.create({ ...parsed.data, ...userOnly(req) })
  await recordActivity(req.userId!, `Created ${expo.name}`, { action: 'expo.created', expoId: expo._id })
  return res.status(201).json(expo)
}))
app.get('/api/expos/:expoId', auth, asyncRoute(async (req, res) => {
  const expoId = param(req.params.expoId)
  if (!objectId(expoId)) return res.status(400).json({ message: 'Invalid expo.' })
  const [expo] = await Expo.aggregate([{ $match: { _id: new Types.ObjectId(expoId), userId: new Types.ObjectId(req.userId!) } }, { $lookup: { from: 'leads', let: { id: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$expoId', '$$id'] } } }, { $group: { _id: '$status', count: { $sum: 1 } } }], as: 'counts' } }, { $addFields: { leadCount: { $sum: '$counts.count' }, interested: { $sum: { $map: { input: '$counts', as: 's', in: { $cond: [{ $eq: ['$$s._id', 'interested'] }, '$$s.count', 0] } } } } } }])
  return expo ? res.json(expo) : res.status(404).json({ message: 'Expo not found.' })
}))
app.put('/api/expos/:expoId', auth, asyncRoute(async (req, res) => {
  if (!objectId(param(req.params.expoId))) return res.status(400).json({ message: 'Invalid expo.' })
  const parsed = expoSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Expo name is required.' })
  const expo = await Expo.findOneAndUpdate({ _id: param(req.params.expoId), ...userOnly(req) }, parsed.data, { new: true, runValidators: true })
  if (!expo) return res.status(404).json({ message: 'Expo not found.' })
  await recordActivity(req.userId!, `Updated ${expo.name}`, { action: 'expo.updated', expoId: expo._id })
  return res.json(expo)
}))
app.delete('/api/expos/:expoId', auth, asyncRoute(async (req, res) => {
  if (!objectId(param(req.params.expoId))) return res.status(400).json({ message: 'Invalid expo.' })
  const expo = await getOwnedExpo(param(req.params.expoId), req.userId!)
  if (!expo) return res.status(404).json({ message: 'Expo not found.' })
  await Promise.all([Lead.deleteMany({ expoId: expo._id, ...userOnly(req) }), Activity.deleteMany({ expoId: expo._id, ...userOnly(req) }), expo.deleteOne()])
  await recordActivity(req.userId!, `Deleted ${expo.name} and its leads`, { action: 'expo.deleted' })
  return res.json({ ok: true })
}))

app.get('/api/expos/:expoId/leads', auth, asyncRoute(async (req, res) => {
  const expoId = param(req.params.expoId)
  if (!objectId(expoId)) return res.status(400).json({ message: 'Invalid expo.' })
  if (!(await getOwnedExpo(expoId, req.userId!))) return res.status(404).json({ message: 'Expo not found.' })
  const query = leadQuery(req, expoId)
  const [items, total] = await Promise.all([Lead.find(query.filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(), Lead.countDocuments(query.filter)])
  return res.json({ items, total, page: query.page, pageSize: query.limit, pages: Math.ceil(total / query.limit) })
}))
app.get('/api/expos/:expoId/filters', auth, asyncRoute(async (req, res) => {
  const expoId = param(req.params.expoId)
  if (!objectId(expoId)) return res.status(400).json({ message: 'Invalid expo.' })
  if (!(await getOwnedExpo(expoId, req.userId!))) return res.status(404).json({ message: 'Expo not found.' })
  const filter = { expoId, ...userOnly(req) }
  const [categories, cities, sources] = await Promise.all([Lead.distinct('businessCategory', filter), Lead.distinct('city', filter), Lead.distinct('source', filter)])
  return res.json({ categories: categories.filter(Boolean).sort(), cities: cities.filter(Boolean).sort(), sources: sources.filter(Boolean).sort() })
}))
app.post('/api/expos/:expoId/leads', auth, asyncRoute(async (req, res) => {
  const expoId = param(req.params.expoId)
  if (!objectId(expoId)) return res.status(400).json({ message: 'Invalid expo.' })
  const expo = await getOwnedExpo(expoId, req.userId!)
  if (!expo) return res.status(404).json({ message: 'Expo not found.' })
  const parsed = leadSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'A lead name is required. Check the details and try again.' })
  const lead = await Lead.create({ ...parsed.data, ...userOnly(req), expoId: expo._id, source: parsed.data.source || 'Manual entry' })
  await recordActivity(req.userId!, `Added ${lead.personName} to ${expo.name}`, { action: 'lead.created', expoId: expo._id, leadId: lead._id })
  return res.status(201).json(lead)
}))
app.get('/api/leads', auth, asyncRoute(async (req, res) => {
  const query = leadQuery(req)
  const [items, total] = await Promise.all([Lead.find(query.filter).sort(query.sort).skip(query.skip).limit(query.limit).populate('expoId', 'name').lean(), Lead.countDocuments(query.filter)])
  return res.json({ items, total, page: query.page, pageSize: query.limit, pages: Math.ceil(total / query.limit) })
}))
app.get('/api/leads/:leadId', auth, asyncRoute(async (req, res) => {
  if (!objectId(param(req.params.leadId))) return res.status(400).json({ message: 'Invalid lead.' })
  const lead = await Lead.findOne({ _id: param(req.params.leadId), ...userOnly(req) }).populate('expoId', 'name startDate city venue').lean()
  return lead ? res.json(lead) : res.status(404).json({ message: 'Lead not found.' })
}))
app.put('/api/leads/:leadId', auth, asyncRoute(async (req, res) => {
  if (!objectId(param(req.params.leadId))) return res.status(400).json({ message: 'Invalid lead.' })
  const parsed = leadSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'A lead name is required. Check the details and try again.' })
  const lead = await Lead.findOneAndUpdate({ _id: param(req.params.leadId), ...userOnly(req) }, parsed.data, { new: true, runValidators: true })
  if (!lead) return res.status(404).json({ message: 'Lead not found.' })
  await recordActivity(req.userId!, `Updated ${lead.personName}`, { action: 'lead.updated', expoId: lead.expoId, leadId: lead._id })
  return res.json(lead)
}))
app.patch('/api/leads/:leadId/status', auth, asyncRoute(async (req, res) => {
  if (!objectId(param(req.params.leadId)) || !isStatus(req.body.status)) return res.status(400).json({ message: 'Choose a valid lead status.' })
  const lead = await Lead.findOneAndUpdate({ _id: param(req.params.leadId), ...userOnly(req) }, { status: req.body.status }, { new: true })
  if (!lead) return res.status(404).json({ message: 'Lead not found.' })
  await recordActivity(req.userId!, `${lead.personName} moved to ${statusLabel(lead.status)}`, { action: 'lead.status', expoId: lead.expoId, leadId: lead._id, metadata: { status: lead.status } })
  return res.json(lead)
}))
app.post('/api/leads/bulk-status', auth, asyncRoute(async (req, res) => {
  const parsed = z.object({ ids: z.array(z.string().refine(objectId)).min(1).max(500), status: z.enum(statuses) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Select leads and a valid status.' })
  const result = await Lead.updateMany({ _id: { $in: parsed.data.ids }, ...userOnly(req) }, { status: parsed.data.status })
  await recordActivity(req.userId!, `Changed ${result.modifiedCount} leads to ${statusLabel(parsed.data.status)}`, { action: 'lead.bulk-status', metadata: { count: result.modifiedCount, status: parsed.data.status } })
  return res.json({ updated: result.modifiedCount })
}))
app.delete('/api/leads/:leadId', auth, asyncRoute(async (req, res) => {
  if (!objectId(param(req.params.leadId))) return res.status(400).json({ message: 'Invalid lead.' })
  const lead = await Lead.findOneAndDelete({ _id: param(req.params.leadId), ...userOnly(req) })
  if (!lead) return res.status(404).json({ message: 'Lead not found.' })
  await recordActivity(req.userId!, `Deleted ${lead.personName}`, { action: 'lead.deleted', expoId: lead.expoId })
  return res.json({ ok: true })
}))

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => cb(null, /\.(xlsx|xls)$/i.test(file.originalname)) })
app.post('/api/expos/:expoId/import/preview', auth, memoryUpload.single('file'), asyncRoute(async (req, res) => {
  const expoId = param(req.params.expoId)
  if (!objectId(expoId)) return res.status(400).json({ message: 'Invalid expo.' })
  const expo = await getOwnedExpo(expoId, req.userId!)
  if (!expo) return res.status(404).json({ message: 'Expo not found.' })
  if (!req.file) return res.status(400).json({ message: 'Choose an .xlsx or .xls file up to 4 MB.' })
  let rows: Record<string, unknown>[]
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    if (!sheet) return res.status(400).json({ message: 'The workbook has no sheets.' })
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  } catch { return res.status(400).json({ message: 'This Excel file could not be read.' }) }
  if (!rows.length) return res.status(400).json({ message: 'No data rows were found in the first sheet.' })
  if (rows.length > 3000) return res.status(400).json({ message: 'This spreadsheet has more than 3,000 rows. Split it into smaller files and import each one.' })
  let mapping: Record<string, string> = autoMap(Object.keys(rows[0] || {}))
  if (req.body.mapping) {
    try {
      const supplied = JSON.parse(String(req.body.mapping)) as unknown
      const checked = z.record(z.string(), z.string()).safeParse(supplied)
      if (!checked.success) return res.status(400).json({ message: 'Column mapping is invalid.' })
      mapping = checked.data
    } catch { return res.status(400).json({ message: 'Column mapping is invalid.' }) }
  }
  const headers = Object.keys(rows[0] || {})
  const mapped = rows.map((row) => mapExcelRow(row, mapping))
  const existing = await Lead.find({ expoId: expo._id, ...userOnly(req) }).select('personName companyName primaryPhone otherPhones email').lean()
  const duplicateSet = new Set<string>()
  for (const lead of existing) duplicateKeys(lead).forEach((key) => duplicateSet.add(key))
  let duplicates = 0
  let invalid = 0
  const seenInFile = new Set<string>()
  const preview = mapped.map((row, index) => {
    const parsed = leadSchema.safeParse(row)
    if (!parsed.success || !row.personName?.trim()) { invalid++; return { rowNumber: index + 2, data: row, issue: row.personName?.trim() ? 'Check field format' : 'Name is required', duplicate: false, valid: false } }
    const keys = duplicateKeys(row)
    const duplicate = keys.some((key) => duplicateSet.has(key) || seenInFile.has(key))
    if (duplicate) duplicates++
    else keys.forEach((key) => seenInFile.add(key))
    return { rowNumber: index + 2, data: parsed.data, duplicate, valid: true }
  })
  return res.json({ total: rows.length, valid: rows.length - invalid - duplicates, duplicates, invalid, rows: preview.slice(0, 7), truncated: preview.length > 7, headers, mapping })
}))
app.get('/api/expos/:expoId/import/template', auth, asyncRoute(async (req, res) => {
  const expoId = param(req.params.expoId)
  const expo = objectId(expoId) ? await getOwnedExpo(expoId, req.userId!) : null
  if (!expo) return res.status(404).json({ message: 'Expo not found.' })
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([['Date Visited', 'Company Name', 'Business Category (Optional)', 'Person Name', 'Designation', 'Number', 'Other Numbers', 'Email', 'Website', 'Social Media Platform', 'Social Media Link']])
  XLSX.utils.book_append_sheet(workbook, sheet, 'Leads')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${expo.name.replace(/[^a-z0-9]+/gi, '_')}_Lead_Template.xlsx"`)
  return res.send(buffer)
}))
app.post('/api/expos/:expoId/import', auth, memoryUpload.single('file'), asyncRoute(async (req, res) => {
  const expoId = param(req.params.expoId)
  if (!objectId(expoId)) return res.status(400).json({ message: 'Invalid expo.' })
  const expo = await getOwnedExpo(expoId, req.userId!)
  if (!expo) return res.status(404).json({ message: 'Expo not found.' })
  if (!req.file) return res.status(400).json({ message: 'Choose an .xlsx or .xls file up to 4 MB.' })
  let rows: Record<string, unknown>[]
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    if (!sheet) return res.status(400).json({ message: 'The workbook has no sheets.' })
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  } catch { return res.status(400).json({ message: 'This Excel file could not be read.' }) }
  if (!rows.length) return res.status(400).json({ message: 'No data rows were found in the first sheet.' })
  if (rows.length > 3000) return res.status(400).json({ message: 'This spreadsheet has more than 3,000 rows. Split it into smaller files and import each one.' })
  let mapping: Record<string, string> = autoMap(Object.keys(rows[0] || {}))
  if (req.body.mapping) {
    try {
      const supplied = JSON.parse(String(req.body.mapping)) as unknown
      const checked = z.record(z.string(), z.string()).safeParse(supplied)
      if (!checked.success) return res.status(400).json({ message: 'Column mapping is invalid.' })
      mapping = checked.data
    } catch { return res.status(400).json({ message: 'Column mapping is invalid.' }) }
  }
  const mappedRows = rows.map((row) => mapExcelRow(row, mapping))
  const current = await Lead.find({ expoId: expo._id, ...userOnly(req) }).select('personName companyName primaryPhone otherPhones email').lean()
  const keys = new Set(current.flatMap(duplicateKeys))
  const accepted: Record<string, unknown>[] = []
  let duplicates = 0, invalid = 0
  for (const raw of mappedRows) {
    const checked = leadSchema.safeParse(raw)
    if (!checked.success || !checked.data.personName.trim()) { invalid++; continue }
    const rowKeys = duplicateKeys(checked.data)
    if (rowKeys.some((key) => keys.has(key))) { duplicates++; continue }
    rowKeys.forEach((key) => keys.add(key))
    accepted.push({ ...checked.data, userId: req.userId, expoId: expo._id, source: checked.data.source || 'Excel import' })
  }
  if (accepted.length) await Lead.insertMany(accepted, { ordered: false })
  if (accepted.length) await recordActivity(req.userId!, `Imported ${accepted.length} leads to ${expo.name}`, { action: 'lead.imported', expoId: expo._id, metadata: { count: accepted.length, duplicates, invalid } })
  return res.json({ imported: accepted.length, duplicates, invalid })
}))

app.get('/api/expos/:expoId/analytics', auth, asyncRoute(async (req, res) => {
  const expoId = param(req.params.expoId)
  if (!objectId(expoId)) return res.status(400).json({ message: 'Invalid expo.' })
  if (!(await getOwnedExpo(expoId, req.userId!))) return res.status(404).json({ message: 'Expo not found.' })
  const match = { expoId: new Types.ObjectId(expoId), userId: new Types.ObjectId(req.userId!) }
  const [statuses, categories, trend, completeness] = await Promise.all([
    Lead.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Lead.aggregate([{ $match: match }, { $group: { _id: { $ifNull: ['$businessCategory', 'Uncategorized'] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 8 }]),
    Lead.aggregate([{ $match: match }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: 31 }]),
    Lead.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: 1 }, withPhone: { $sum: { $cond: [{ $ne: ['$primaryPhone', ''] }, 1, 0] } }, withEmail: { $sum: { $cond: [{ $ne: ['$email', ''] }, 1, 0] } }, withCompany: { $sum: { $cond: [{ $ne: ['$companyName', ''] }, 1, 0] } } } }]),
  ])
  return res.json({ statuses, categories, trend, completeness: completeness[0] || { total: 0, withPhone: 0, withEmail: 0, withCompany: 0 } })
}))

app.get('/api/activity', auth, asyncRoute(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
  const filter = { ...userOnly(req), ...(objectId(req.query.expoId) ? { expoId: req.query.expoId } : {}) }
  const [items, total] = await Promise.all([Activity.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('expoId', 'name').lean(), Activity.countDocuments(filter)])
  return res.json({ items, total, page, pages: Math.ceil(total / limit) })
}))

app.post('/api/expos/:expoId/export', auth, asyncRoute(async (req, res) => {
  const expoId = param(req.params.expoId)
  if (!objectId(expoId)) return res.status(400).json({ message: 'Invalid expo.' })
  const expo = await getOwnedExpo(expoId, req.userId!)
  if (!expo) return res.status(404).json({ message: 'Expo not found.' })
  const parsed = z.object({ statuses: z.array(z.enum(statuses)).optional(), leadIds: z.array(z.string().refine(objectId)).optional() }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Invalid export selection.' })
  const filter: Record<string, unknown> = { expoId: expo._id, ...userOnly(req) }
  if (parsed.data.statuses?.length) filter.status = { $in: parsed.data.statuses }
  if (parsed.data.leadIds?.length) filter._id = { $in: parsed.data.leadIds }
  const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean()
  const rows = leads.map(({ visitDate, companyName, businessCategory, personName, designation, primaryPhone, otherPhones, email, website, socialPlatform, socialProfile, socialMedia, status, notes }) => {
    const legacySocial = Object.entries(socialMedia || {}).find(([, value]) => value)
    return { 'Date Visited': visitDate ? new Date(visitDate).toISOString().slice(0, 10) : '', 'Company Name': companyName, 'Business Category (Optional)': businessCategory, 'Person Name': personName, Designation: designation, Number: primaryPhone, 'Other Numbers': otherPhones.join(', '), Email: email, Website: website, 'Social Media Platform': socialPlatform || legacySocial?.[0], 'Social Media Link': socialProfile || legacySocial?.[1], Status: statusLabel(status), Notes: notes, LinkedIn: socialMedia?.linkedin, Instagram: socialMedia?.instagram, Facebook: socialMedia?.facebook, YouTube: socialMedia?.youtube }
  })
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Leads')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  const filename = `${expo.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}_Leads.xlsx`
  await recordActivity(req.userId!, `Exported ${leads.length} leads from ${expo.name}`, { action: 'lead.exported', expoId: expo._id, metadata: { count: leads.length } })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  return res.send(buffer)
}))

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  void _next
  console.error(err)
  if (err instanceof multer.MulterError) return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'Excel file must be 4 MB or smaller.' : 'Excel file could not be uploaded.' })
  return res.status(500).json({ message: 'Something went wrong. Please try again.' })
})

const expoSchema = z.object({ name: z.string().trim().min(1).max(160), startDate: z.coerce.date().optional().or(z.literal('')), endDate: z.coerce.date().optional().or(z.literal('')), venue: z.string().max(180).optional(), city: z.string().max(120).optional(), organizer: z.string().max(180).optional(), website: z.string().max(300).optional(), description: z.string().max(2000).optional(), notes: z.string().max(5000).optional() }).transform((data) => ({ ...data, startDate: data.startDate || undefined, endDate: data.endDate || undefined }))
const leadSchema = z.object({ personName: z.string().trim().min(1).max(160), visitDate: z.coerce.date().optional().or(z.literal('')), companyName: z.string().max(180).optional(), designation: z.string().max(160).optional(), primaryPhone: z.string().max(40).optional(), otherPhones: z.array(z.string().max(40)).max(30).optional(), email: z.union([z.string().email().max(254), z.literal('')]).optional(), website: z.string().max(300).optional(), socialPlatform: z.string().max(80).optional(), socialProfile: z.string().max(300).optional(), socialMedia: z.object({ linkedin: z.string().max(300).optional(), instagram: z.string().max(300).optional(), facebook: z.string().max(300).optional(), youtube: z.string().max(300).optional(), other: z.string().max(300).optional() }).optional(), businessCategory: z.string().max(120).optional(), address: z.string().max(500).optional(), city: z.string().max(120).optional(), state: z.string().max(120).optional(), pincode: z.string().max(20).optional(), status: z.enum(statuses).optional().default('interested'), notes: z.string().max(5000).optional(), source: z.string().max(120).optional() }).transform((data) => ({ ...data, visitDate: data.visitDate || undefined, otherPhones: (data.otherPhones || []).filter(Boolean), email: data.email || '' }))

function leadQuery(req: AuthedRequest, expoId?: string) {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
  const filter: Record<string, unknown> = { ...userOnly(req), ...(expoId ? { expoId } : {}) }
  if (req.query.status && isStatus(req.query.status)) filter.status = req.query.status
  if (req.query.category) filter.businessCategory = String(req.query.category)
  if (req.query.city) filter.city = String(req.query.city)
  if (req.query.source) filter.source = String(req.query.source)
  if (req.query.search) {
    const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'i')
    filter.$or = [{ personName: regex }, { companyName: regex }, { primaryPhone: regex }, { otherPhones: regex }, { email: regex }, { businessCategory: regex }, { city: regex }, { website: regex }, { notes: regex }]
  }
  const sortKey = String(req.query.sort || 'newest')
  const sort: Record<string, 1 | -1> = sortKey === 'oldest' ? { createdAt: 1 } : sortKey === 'name' ? { personName: 1 } : { createdAt: -1 }
  return { filter, page, limit, skip: (page - 1) * limit, sort }
}
const columnAliases: Record<string, string[]> = {
  visitDate: ['visitdate', 'datevisited', 'dateofvisit', 'visitedon', 'visit', 'date'],
  personName: ['personname', 'fullname', 'name', 'contactname'], companyName: ['companyname', 'company', 'businessname', 'organization'],
  designation: ['designation', 'title', 'jobtitle'], primaryPhone: ['primaryphone', 'primarynumber', 'mobilenumber1', 'mobile', 'mobilenumber', 'phone', 'number', 'contactnumber'],
  otherPhones: ['otherphones', 'alternatenumbers', 'alternatemobile', 'mobile2', 'mobilenumber2', 'alternatephone', 'otherphone'], otherPhones3: ['mobile3', 'mobilenumber3', 'phone2'], email: ['email', 'emailaddress'],
  website: ['website', 'web', 'url'], socialPlatform: ['socialmediaplatform', 'socialmediaplatformifavailable', 'socialplatform', 'socialnetwork', 'socialmedia'], socialProfile: ['socialmedialink', 'socialprofile', 'sociallink', 'socialmediaurl', 'profilelink'], businessCategory: ['businesscategory', 'businesscategoryoptional', 'category', 'industry'], city: ['city', 'town'], state: ['state', 'region'],
  pincode: ['pincode', 'zipcode', 'postalcode'], address: ['address', 'location'], notes: ['notes', 'note', 'remarks'], status: ['status', 'leadstatus'],
  linkedin: ['linkedin', 'linkedinurl'], instagram: ['instagram', 'instagramurl'], facebook: ['facebook', 'facebookurl'], youtube: ['youtube', 'youtubeurl'],
}
const normalizeColumn = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
const isOtherPhoneColumn = (header: string) => /^(other|alternate|alt).*(number|phone|mobile)/.test(normalizeColumn(header)) || /^(mobile|mobilenumber|phone|phonenumber|contactnumber)[2-9]\d*$/.test(normalizeColumn(header))
function autoMap(headers: string[]) {
  return Object.fromEntries(Object.entries(columnAliases).map(([field, aliases]) => {
    const header = headers.find((value) => aliases.includes(normalizeColumn(value)) || (field === 'otherPhones' && isOtherPhoneColumn(value)))
    return [field, header || '']
  }))
}
function excelVisitDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parts = XLSX.SSF.parse_date_code(value)
    if (parts) return `${String(parts.y).padStart(4, '0')}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`
  }
  const text = String(value ?? '').trim()
  if (!text) return ''
  const dayFirst = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (dayFirst) {
    const [, day, month, rawYear] = dayFirst
    const year = rawYear.length === 2 ? `${Number(rawYear) >= 50 ? '19' : '20'}${rawYear}` : rawYear
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day) ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : text
  }
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? text : date.toISOString().slice(0, 10)
}
function mapExcelRow(row: Record<string, unknown>, mapping: Record<string, string> = {}) {
  const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeColumn(key), String(value ?? '').trim()]))
  const pick = (field: string, ...aliases: string[]) => {
    const mappedColumn = mapping[field] ? normalized[normalizeColumn(mapping[field])] : undefined
    return mappedColumn || aliases.map((key) => normalized[key]).find((value) => value !== undefined) || ''
  }
  const rawDate = mapping.visitDate ? row[mapping.visitDate] : Object.entries(row).find(([key]) => columnAliases.visitDate.includes(normalizeColumn(key)))?.[1]
  const rawStatus = pick('status', 'status', 'leadstatus').toLowerCase()
  const status: LeadStatus = /called/.test(rawStatus) ? 'called' : /notinterested/.test(rawStatus) ? 'not-interested' : /alreadygood|goodpresence/.test(rawStatus) ? 'good-presence' : 'interested'
  const otherPhoneColumns = Object.keys(row).filter(isOtherPhoneColumn)
  if (mapping.otherPhones && row[mapping.otherPhones] !== undefined) otherPhoneColumns.push(mapping.otherPhones)
  const extras = [...new Set(otherPhoneColumns)].flatMap((column) => String(row[column] ?? '').split(/[;,|\n]/).map((number) => number.trim()).filter(Boolean))
  return {
    visitDate: excelVisitDate(rawDate), personName: pick('personName', 'personname', 'fullname', 'name', 'contactname'), companyName: pick('companyName', 'companyname', 'company', 'businessname', 'organization'), designation: pick('designation', 'designation', 'title', 'jobtitle'),
    primaryPhone: pick('primaryPhone', 'primaryphone', 'primarynumber', 'mobilenumber1', 'mobile', 'mobilenumber', 'phone', 'number', 'contactnumber'), otherPhones: extras,
    email: pick('email', 'email', 'emailaddress'), website: pick('website', 'website', 'web', 'url'), businessCategory: pick('businessCategory', 'businesscategory', 'category', 'industry'),
    socialPlatform: pick('socialPlatform', 'socialmediaplatform', 'socialplatform', 'socialnetwork', 'socialmedia'), socialProfile: pick('socialProfile', 'socialmedialink', 'socialprofile', 'sociallink', 'socialmediaurl', 'profilelink'),
    socialMedia: { linkedin: pick('linkedin', 'linkedin', 'linkedinurl'), instagram: pick('instagram', 'instagram', 'instagramurl'), facebook: pick('facebook', 'facebook', 'facebookurl'), youtube: pick('youtube', 'youtube', 'youtubeurl') },
    city: pick('city', 'city', 'town'), state: pick('state', 'state', 'region'), pincode: pick('pincode', 'pincode', 'zipcode', 'postalcode'), address: pick('address', 'address', 'location'), notes: pick('notes', 'notes', 'note', 'remarks'), status, source: 'Excel import',
  }
}
function duplicateKeys(lead: { personName?: string | null; companyName?: string | null; primaryPhone?: string | null; otherPhones?: string[] | null; email?: string | null }) {
  const keys = [lead.primaryPhone, ...(lead.otherPhones || [])].map((item) => (item || '').replace(/\D/g, '')).filter((phone) => phone.length >= 7).map((phone) => `phone:${phone}`)
  if (lead.email?.trim()) keys.push(`email:${lead.email.trim().toLowerCase()}`)
  if (lead.personName?.trim() && lead.companyName?.trim()) keys.push(`name:${lead.personName.trim().toLowerCase()}|${lead.companyName.trim().toLowerCase()}`)
  return keys.length ? keys : [`name:${(lead.personName || '').trim().toLowerCase()}|${(lead.companyName || '').trim().toLowerCase()}`]
}
function statusLabel(status?: string) { return ({ interested: 'Interested', called: 'Called', 'not-interested': 'Not interested', 'good-presence': 'Already good presence' } as Record<string, string>)[status || ''] || 'Interested' }

export default app
