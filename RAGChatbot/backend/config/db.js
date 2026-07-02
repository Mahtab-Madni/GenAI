import { MongoClient, GridFSBucket } from "mongodb";

const mongoUri =
  process.env.MONGODB_URI ||
  "mongodb://mahtab:root12@ac-kwichgk-shard-00-00.bic4o66.mongodb.net:27017,ac-kwichgk-shard-00-01.bic4o66.mongodb.net:27017,ac-kwichgk-shard-00-02.bic4o66.mongodb.net:27017/?ssl=true&replicaSet=atlas-g3dndu-shard-0&authSource=admin&appName=Airnub";
export const mongoDbName = process.env.MONGODB_DB_NAME || "rag_database";
let mongoClient;

export async function getMongoClient() {
  if (!mongoClient) {
    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
  }
  return mongoClient;
}