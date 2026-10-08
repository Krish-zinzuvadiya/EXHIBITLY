export type Status = 'interested' | 'called' | 'not-interested' | 'good-presence'
export type User = { id: string; name: string; email: string }
export type CustomizationPreferences = { accent: 'ember' | 'ocean' | 'forest' | 'plum' | 'slate'; density: 'comfortable' | 'compact' }
export type Expo = { _id: string; name: string; startDate?: string; endDate?: string; venue?: string; city?: string; organizer?: string; website?: string; description?: string; notes?: string; createdAt: string; leadCount?: number; interested?: number }
export type Lead = { _id: string; expoId: string | { _id: string; name: string; startDate?: string; city?: string; venue?: string }; personName: string; visitDate?: string; companyName?: string; designation?: string; primaryPhone?: string; otherPhones?: string[]; email?: string; website?: string; socialPlatform?: string; socialProfile?: string; socialMedia?: Record<string, string>; businessCategory?: string; address?: string; city?: string; state?: string; pincode?: string; status: Status; notes?: string; source?: string; createdAt: string; updatedAt: string }
export type Page<T> = { items: T[]; total: number; page: number; pages: number; pageSize: number }
export const statuses: { value: Status; label: string; short: string }[] = [
  { value: 'interested', label: 'Interested', short: 'Interested' },
  { value: 'called', label: 'Called', short: 'Called' },
  { value: 'not-interested', label: 'Not interested', short: 'Not interested' },
  { value: 'good-presence', label: 'Already good presence', short: 'Good presence' },
]
