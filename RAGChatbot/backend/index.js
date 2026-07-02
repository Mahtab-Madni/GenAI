import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import Groq from "groq-sdk";
import cors from "cors";
import multer from "multer";
import { getMongoClient, mongoDbName } from "./config/db.js";
import { GridFSBucket } from "mongodb";
import { prepareDocument } from "./Loader/pdfLoader.js";
import dotenv from "dotenv";
dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function uploadPDFToMongoDB(
  fileBuffer,
  filename,
  contentType = "application/pdf",
) {
  const client = await getMongoClient();
  const db = client.db(mongoDbName);
  const bucket = new GridFSBucket(db);

  const uploadStream = bucket.openUploadStream(filename, {
    contentType,
    metadata: {
      uploadedAt: new Date(),
      source: "api/chat",
      originalName: filename,
    },
  });

  await new Promise((resolve, reject) => {
    uploadStream.on("error", reject);
    uploadStream.on("finish", resolve);
    uploadStream.end(fileBuffer);
  });
  return uploadStream.id;
}

async function saveChatHistory(db, sessionId, messages) {
  if (!sessionId || !Array.isArray(messages) || messages.length === 0) {
    return;
  }

  const collection = db.collection("chat_messages");
  const docs = messages.map((message) => ({
    sessionId,
    role: message.role,
    content: message.content,
    fileName: message.fileName || null,
    mongoFileId: message.mongoFileId ? message.mongoFileId.toString() : null,
    createdAt: new Date(),
  }));

  await collection.insertMany(docs);
}

async function loadChatMemory(db, sessionId, limit = 3) {
  if (!sessionId) return [];
  return db
    .collection("chat_messages")
    .find({ sessionId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

function generateSessionId() {
  return `session-${crypto.randomUUID()}`;
}

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());

const conditionalUpload = (req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    return upload.single("file")(req, res, next);
  }
  return next();
};

app.post("/api/chat", conditionalUpload, async (req, res) => {
  const contentType = req.headers["content-type"] || "";
  console.log("Incoming request content-type:", contentType);
  const query = req.body?.query?.toString?.().trim() || "";
  console.log("Incoming query:", query);
  const file = req.file;

  let sessionId =
    req.body?.sessionId?.toString?.().trim() ||
    req.headers["x-session-id"] ||
    null;
  if (!sessionId) {
    sessionId = generateSessionId();
  }
  const timestamp = new Date();

  let mongoUpload = null;
  let mongoFileId = null;
  if (file) {
    console.log(`Received file upload: ${file.originalname}`);

    if (
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf")
    ) {
      try {
        mongoFileId = await uploadPDFToMongoDB(
          file.buffer,
          file.originalname,
          file.mimetype || "application/pdf",
        );
        mongoUpload = {
          status: "uploaded",
          fileId: mongoFileId.toString(),
          database: mongoDbName,
          connection: "mongodb",
        };
        console.log(`Uploaded PDF to MongoDB with file id: ${mongoFileId}`);
      } catch (error) {
        console.error("MongoDB PDF upload failed:", error);
        mongoUpload = {
          status: "failed",
          error: error.message,
          connection: "mongodb",
          hint: "Set MONGODB_URI to a reachable MongoDB Atlas or local instance and ensure network access.",
        };
      }
    }
  }

  // Build RAG system prompt and retrieve top-k context chunks if a file was uploaded
  let retrievedContext = null;
  if (mongoFileId) {
    try {
      const results = await prepareDocument(mongoFileId.toString(), query);
      // prepareDocument returns an array of Document objects; join their pageContent
      retrievedContext = Array.isArray(results)
        ? results.map((d) => d.pageContent || d).join("\n---\n")
        : String(results || "");
    } catch (err) {
      console.error("Error retrieving context from MongoDB vector store:", err);
      retrievedContext = null;
    }
  }

  let memoryContext = "";
  if (sessionId) {
    try {
      const client = await getMongoClient();
      const db = client.db(mongoDbName);
      const memoryMessages = await loadChatMemory(db, sessionId, 4);
      if (memoryMessages.length > 0) {
        memoryContext = memoryMessages
          .map(
            (msg) =>
              `${msg.role === "assistant" ? "Assistant" : "User"}: ${msg.content}`,
          )
          .reverse()
          .join("\n");
      }
    } catch (err) {
      console.error("Error loading chat memory from MongoDB:", err);
      memoryContext = "";
    }
  }

  const finalprompt = `You are a concise RAG assistant. Use only the provided context and recent conversation memory to answer the user's question. If the context or memory does not contain the answer, reply exactly: I don't know. Do not hallucinate or invent facts. Keep the answer relevant and concise.

Conversation memory:\n${memoryContext || "No prior conversation memory."}\n
Context:\n${retrievedContext || "No context available."}\n
User question: ${query}\n
Answer:`;

  const messages = [
    {
      role: "system",
      content: finalprompt,
    },
  ];

  if (query) {
    messages.push({ role: "user", content: query });
  }

  const chatCompletion = await getGroqChatCompletion(messages);

  try {
    const client = await getMongoClient();
    const db = client.db(mongoDbName);
    await saveChatHistory(db, sessionId, [
      {
        role: "user",
        content: query,
        fileName: file ? file.originalname : null,
        mongoFileId,
      },
      {
        role: "assistant",
        content: chatCompletion.choices?.[0]?.message?.content || "",
      },
    ]);
  } catch (saveError) {
    console.error("Failed to save chat history:", saveError);
  }

  res.json({
    savedFile: file ? file.originalname : null,
    mongoUpload,
    sessionId,
    response: chatCompletion,
  });
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});

async function getGroqChatCompletion(messages) {
  return groq.chat.completions.create({
    messages,
    model: "openai/gpt-oss-20b",
  });
}
