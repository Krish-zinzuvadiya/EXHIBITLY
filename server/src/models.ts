import mongoose, { Schema, type InferSchemaType, type Types } from 'mongoose'

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String },
  googleId: { type: String, trim: true, unique: true, sparse: true },
  preferences: {
    type: new Schema({
      accent: { type: String, enum: ['ember', 'ocean', 'forest', 'plum', 'slate'], default: 'ember' },
      density: { type: String, enum: ['comfortable', 'compact'], default: 'comfortable' },
    }, { _id: false }),
    default: () => ({}),
  },
}, { timestamps: true })

const expoSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  startDate: Date,
  endDate: Date,
  venue: { type: String, trim: true, maxlength: 180 },
  city: { type: String, trim: true, maxlength: 120 },
  organizer: { type: String, trim: true, maxlength: 180 },
  website: { type: String, trim: true, maxlength: 300 },
  description: { type: String, trim: true, maxlength: 2000 },
  notes: { type: String, trim: true, maxlength: 5000 },
}, { timestamps: true })
expoSchema.index({ userId: 1, name: 1 })

const leadSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  expoId: { type: Schema.Types.ObjectId, ref: 'Expo', required: true, index: true },
  personName: { type: String, required: true, trim: true, maxlength: 160 },
  visitDate: Date,
  companyName: { type: String, trim: true, maxlength: 180 },
  designation: { type: String, trim: true, maxlength: 160 },
  primaryPhone: { type: String, trim: true, maxlength: 40 },
  otherPhones: { type: [String], default: [] },
  email: { type: String, trim: true, lowercase: true, maxlength: 254 },
  website: { type: String, trim: true, maxlength: 300 },
  socialPlatform: { type: String, trim: true, maxlength: 80 },
  socialProfile: { type: String, trim: true, maxlength: 300 },
  socialMedia: {
    linkedin: String, instagram: String, facebook: String, youtube: String, other: String,
  },
  businessCategory: { type: String, trim: true, maxlength: 120 },
  address: { type: String, trim: true, maxlength: 500 },
  city: { type: String, trim: true, maxlength: 120 },
  state: { type: String, trim: true, maxlength: 120 },
  pincode: { type: String, trim: true, maxlength: 20 },
  status: { type: String, enum: ['interested', 'called', 'not-interested', 'good-presence'], default: 'interested', index: true },
  notes: { type: String, trim: true, maxlength: 5000 },
  source: { type: String, trim: true, maxlength: 120, default: 'Manual entry' },
}, { timestamps: true })
leadSchema.index({ userId: 1, expoId: 1, createdAt: -1 })
leadSchema.index({ userId: 1, expoId: 1, status: 1, createdAt: -1 })
leadSchema.index({ userId: 1, expoId: 1, businessCategory: 1 })
leadSchema.index({ userId: 1, expoId: 1, city: 1 })
leadSchema.index({ userId: 1, expoId: 1, personName: 'text', companyName: 'text', email: 'text', businessCategory: 'text', city: 'text', notes: 'text' })

const activitySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  expoId: { type: Schema.Types.ObjectId, ref: 'Expo' },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
  action: { type: String, required: true },
  description: { type: String, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true })
activitySchema.index({ userId: 1, createdAt: -1 })

export const User = mongoose.model('User', userSchema)
export const Expo = mongoose.model('Expo', expoSchema)
export const Lead = mongoose.model('Lead', leadSchema)
export const Activity = mongoose.model('Activity', activitySchema)

export type LeadRecord = InferSchemaType<typeof leadSchema> & { _id: Types.ObjectId }
