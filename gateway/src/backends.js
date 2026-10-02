import { ObjectId } from 'mongodb'
import { getCollection } from './db.js'

export async function addBackend(apiEndpoint) {
  const collection = getCollection()
  const doc = {
    apiEndpoint,
    addedOn: new Date(),
    lastJobOn: null,
    countJobsTotal: 0,
    isActive: true
  }
  const result = await collection.insertOne(doc)
  return { ...doc, _id: result.insertedId }
}

export async function updateBackend(id, updates) {
  const collection = getCollection()
  const allowedFields = {}
  if (updates.apiEndpoint !== undefined) allowedFields.apiEndpoint = updates.apiEndpoint
  if (updates.isActive !== undefined) allowedFields.isActive = updates.isActive

  const result = await collection.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: allowedFields },
    { returnDocument: 'after' }
  )
  return result
}

export async function getAllBackends() {
  const collection = getCollection()
  return collection.find({}).toArray()
}

export async function getActiveBackends() {
  const collection = getCollection()
  return collection.find({ isActive: true }).toArray()
}

export async function recordJobSent(id) {
  const collection = getCollection()
  await collection.updateOne(
    { _id: new ObjectId(id) },
    {
      $set: { lastJobOn: new Date() },
      $inc: { countJobsTotal: 1 }
    }
  )
}

export async function deleteBackend(id) {
  const collection = getCollection()
  return collection.deleteOne({ _id: new ObjectId(id) })
}
