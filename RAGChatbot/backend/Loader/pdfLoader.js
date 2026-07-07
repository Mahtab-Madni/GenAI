import { WebPDFLoader } from "@langchain/community/document_loaders/web/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { getMongoClient, mongoDbName } from "../config/db.js";
import { GridFSBucket, ObjectId } from "mongodb";
import { GoogleGenAI } from "@google/genai";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import dotenv from "dotenv";
dotenv.config();

class GoogleGenAIEmbeddings {
  constructor({
    model = "gemini-embedding-2",
    apiKey = process.env.GEMINI_API_KEY,
  } = {}) {
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY must be set in the environment to generate embeddings.",
      );
    }
    this.model = model;
    this.ai = new GoogleGenAI({ apiKey });
  }

  // Embed an array of texts -> returns array of numeric vectors matching order
  async embedDocuments(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const jobs = texts.map(async (text, idx) => {
      const response = await this.ai.models.embedContent({
        model: this.model,
        contents: [text],
      });

      let embObj = null;
      if (
        response &&
        Array.isArray(response.embeddings) &&
        response.embeddings.length > 0
      ) {
        embObj = response.embeddings[0];
      } else if (
        response &&
        response.inlinedEmbedContentResponses &&
        response.inlinedEmbedContentResponses[0]
      ) {
        const inlined = response.inlinedEmbedContentResponses[0];
        if (
          inlined &&
          inlined.response &&
          Array.isArray(inlined.response.embeddings) &&
          inlined.response.embeddings.length > 0
        ) {
          embObj = inlined.response.embeddings[0];
        }
      }

      const values = embObj?.values || embObj?.embedding || null;
      if (!Array.isArray(values)) {
        throw new Error(
          `Embedding at index ${idx} did not return a numeric values array.`,
        );
      }
      return values;
    });

    return Promise.all(jobs);
  }

  // Embed a single query string
  async embedQuery(text) {
    const arr = await this.embedDocuments([text]);
    return arr[0];
  }
}

export async function prepareDocument(fileId, prompt) {
  const client = await getMongoClient();
  let vectorStore = null;
  let splitDocs = [];
  try {
    const db = client.db(mongoDbName);
    const bucket = new GridFSBucket(db);

    const id = typeof fileId === "string" ? new ObjectId(fileId) : fileId;
    const chunks = [];
    const downloadStream = bucket.openDownloadStream(id);

    const buffer = await new Promise((resolve, reject) => {
      downloadStream.on("data", (chunk) => chunks.push(chunk));
      downloadStream.on("error", reject);
      downloadStream.on("end", () => resolve(Buffer.concat(chunks)));
    });

    const blob = new Blob([buffer], { type: "application/pdf" });
    const loader = new WebPDFLoader(blob, { splitPages: false });
    const documents = await loader.load();

    console.log(
      `📚 Loaded ${documents.length} pages into LangChain from MongoDB.`,
    );

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    splitDocs = await splitter.splitDocuments(documents);

    // Attach file linkage metadata so session deletes can cascade vector cleanup.
    splitDocs = splitDocs.map((doc) => ({
      ...doc,
      metadata: {
        ...(doc?.metadata || {}),
        mongoFileId: id.toString(),
      },
    }));

    const embeddings = new GoogleGenAIEmbeddings({
      model: "gemini-embedding-2",
      apiKey: process.env.GEMINI_API_KEY,
    });

    const collection = db.collection("vector_embeddings");
    vectorStore = new MongoDBAtlasVectorSearch(embeddings, {
      collection,
      indexName: "vector_index",
      textKey: "text",
      embeddingKey: "embedding",
    });

    // Re-indexing the same file should replace older vectors, not duplicate them.
    await collection.deleteMany({ "metadata.mongoFileId": id.toString() });

    // Add split documents to the vector store
    await vectorStore.addDocuments(splitDocs);

    // If a prompt was provided, run a similarity search and return the top matches
    if (prompt && typeof prompt === "string" && prompt.trim().length > 0) {
      try {
        const topK = 3;
        const results = await vectorStore.similaritySearch(prompt, topK);

        if (!results || results.length === 0) {
          console.warn(
            "No results found for the similarity search. Returning all split documents.",
          );
          return splitDocs;
        }
        return results;
      } catch (e) {
        console.error("Error during similarity search:", e);
        // fall back to returning all split docs as context
        return splitDocs;
      }
    }

    return splitDocs;
  } finally {
    // Do not close the shared MongoClient here.
    // getMongoClient() returns a singleton client used across the backend.
  }
}
