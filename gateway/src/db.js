import { MongoClient } from 'mongodb'

const MONGODB_URI = process.env.MONGODB_URI

let client = null
let db = null

export async function connectDB() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is required')
  }

  client = new MongoClient(MONGODB_URI)
  await client.connect()
  db = client.db('threespeak')

  // Ensure collection exists
  const collections = await db.listCollections({ name: 'render-backends' }).toArray()
  if (collections.length === 0) {
    await db.createCollection('render-backends')
  }

  const collection = db.collection('render-backends')
  await collection.createIndex({ apiEndpoint: 1 }, { unique: true })

  console.log('[gateway] Connected to MongoDB')
  return db
}

export function getDB() {
  if (!db) throw new Error('Database not connected')
  return db
}

export function getCollection() {
  return getDB().collection('render-backends')
}
