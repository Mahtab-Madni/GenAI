import express from "express";
import crypto from "crypto";
import Groq from "groq-sdk";
import cors from "cors";
import multer from "multer";
import { getMongoClient, mongoDbName } from "./config/db.js";
import { GridFSBucket, ObjectId } from "mongodb";
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

async function saveChatHistory(db, sessionId, chatEntry) {
  if (!sessionId || !chatEntry || typeof chatEntry !== "object") {
    return;
  }

  const collection = db.collection("chat_msg");
  await collection.createIndex({ sessionId: 1 }, { unique: true });

  const now = chatEntry.createdAt || new Date();
  const conversationItems = [
    {
      role: "user",
      content: chatEntry.userContent ?? "",
      createdAt: now,
      fileName: chatEntry.fileName || null,
      fileUploaded: Boolean(chatEntry.fileUploaded || chatEntry.mongoFileId),
      mongoFileId: chatEntry.mongoFileId
        ? chatEntry.mongoFileId.toString()
        : null,
      fileType: chatEntry.fileType || null,
      fileInfo: chatEntry.fileInfo || null,
    },
    {
      role: "assistant",
      content: chatEntry.assistantContent ?? "",
      createdAt: now,
    },
  ];

  const existingSession = await collection.findOne({ sessionId });
  const updatedConversation = existingSession?.conversation
    ? [...existingSession.conversation, ...conversationItems]
    : conversationItems;

  const updatedContent = updatedConversation
    .map((item) =>
      item.role === "assistant"
        ? `Assistant: ${item.content}`
        : `User: ${item.content}`,
    )
    .join("\n");

  await collection.updateOne(
    { sessionId },
    {
      $setOnInsert: {
        sessionId,
        createdAt: existingSession?.createdAt || now,
      },
      $set: {
        updatedAt: now,
        content: updatedContent,
        conversation: updatedConversation,
      },
    },
    { upsert: true },
  );
}

async function loadChatMemory(db, sessionId, limit = 20) {
  if (!sessionId) return [];
  const sessionDoc = await db
    .collection("chat_msg")
    .findOne({ sessionId }, { projection: { conversation: 1 } });
  if (!sessionDoc?.conversation) return [];
  return sessionDoc.conversation.slice(-limit);
}

async function getSessionConversation(db, sessionId) {
  if (!sessionId) return [];
  const sessionDoc = await db
    .collection("chat_msg")
    .findOne({ sessionId }, { projection: { conversation: 1 } });
  return sessionDoc?.conversation || [];
}

async function getLatestSessionFileInfo(db, sessionId) {
  if (!sessionId) return null;
  const sessionDoc = await db
    .collection("chat_msg")
    .findOne({ sessionId }, { projection: { conversation: 1 } });
  if (!sessionDoc?.conversation) return null;

  const latestFileEntry = [...sessionDoc.conversation]
    .reverse()
    .find((item) => item.role === "user" && item.mongoFileId);

  if (!latestFileEntry) return null;

  return {
    mongoFileId: latestFileEntry.mongoFileId,
    fileName: latestFileEntry.fileName || null,
    fileType: latestFileEntry.fileType || null,
    fileInfo: latestFileEntry.fileInfo || null,
  };
}

async function getAllSessionSummaries(db) {
  return db
    .collection("chat_msg")
    .find(
      {},
      {
        projection: {
          sessionId: 1,
          conversation: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    )
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();
}

function generateSessionId() {
  return `session-${crypto.randomUUID()}`;
}

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());

// In-memory progress store for file processing stages (keyed by sessionId)
const progressStore = new Map();

function setProgress(sessionId, payload) {
  if (!sessionId) return;
  const existing = progressStore.get(sessionId) || {};
  const next = { ...existing, ...payload, updatedAt: new Date() };
  progressStore.set(sessionId, next);
}

function getProgress(sessionId) {
  return progressStore.get(sessionId) || { stage: "idle", pct: 0 };
}

function isValidObjectId(id) {
  if (!id || typeof id !== "string") return false;
  return ObjectId.isValid(id) && new ObjectId(id).toString() === id;
}

async function getSessionMongoFileIds(db, sessionId) {
  if (!sessionId) return [];

  const sessionDoc = await db
    .collection("chat_msg")
    .findOne({ sessionId }, { projection: { conversation: 1 } });

  if (!sessionDoc?.conversation || !Array.isArray(sessionDoc.conversation)) {
    return [];
  }

  const uniqueIds = new Set();
  for (const item of sessionDoc.conversation) {
    const rawId = item?.mongoFileId;
    const asString =
      typeof rawId === "string"
        ? rawId.trim()
        : rawId?.toString?.()?.trim?.() || "";
    if (isValidObjectId(asString)) {
      uniqueIds.add(asString);
    }
  }

  return [...uniqueIds];
}

async function deleteSessionRelatedData(db, sessionId) {
  const fileIds = await getSessionMongoFileIds(db, sessionId);
  const chatDeleteResult = await db
    .collection("chat_msg")
    .deleteOne({ sessionId });

  let filesDeleted = 0;
  const fileDeleteFailures = [];

  if (fileIds.length > 0) {
    const bucket = new GridFSBucket(db);
    for (const fileId of fileIds) {
      try {
        await bucket.delete(new ObjectId(fileId));
        filesDeleted += 1;
      } catch (error) {
        fileDeleteFailures.push({ fileId, error: error?.message || "unknown" });
      }
    }

    await db.collection("vector_embeddings").deleteMany({
      $or: [
        { "metadata.mongoFileId": { $in: fileIds } },
        { mongoFileId: { $in: fileIds } },
      ],
    });
  }

  progressStore.delete(sessionId);

  return {
    deletedCount: chatDeleteResult.deletedCount,
    filesDeleted,
    filesFound: fileIds.length,
    fileDeleteFailures,
  };
}

app.get("/api/chat/history", async (req, res) => {
  const sessionId = req.query.sessionId?.toString?.().trim() || null;
  if (!sessionId) {
    return res.json([]);
  }

  try {
    const client = await getMongoClient();
    const db = client.db(mongoDbName);
    const conversation = await getSessionConversation(db, sessionId);
    return res.json(conversation);
  } catch (error) {
    console.error("Failed to load chat history from MongoDB:", error);
    return res.status(500).json({ error: "Failed to load chat history" });
  }
});

app.post("/api/chat/history", async (req, res) => {
  const sessionId = req.body?.sessionId?.toString?.trim?.() || null;
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;

  if (!sessionId || !messages) {
    return res
      .status(400)
      .json({ error: "sessionId and messages are required" });
  }

  try {
    const client = await getMongoClient();
    const db = client.db(mongoDbName);
    const conversation = messages.map((msg) => ({
      role: msg.role,
      content: msg.content || "",
      fileName: msg.fileName || null,
      fileUploaded: Boolean(msg.fileUploaded),
      mongoFileId: msg.mongoFileId || null,
      fileType: msg.fileType || null,
      fileInfo: msg.fileInfo || null,
      createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
    }));

    await db.collection("chat_msg").updateOne(
      { sessionId },
      {
        $setOnInsert: {
          sessionId,
          createdAt: new Date(),
        },
        $set: {
          updatedAt: new Date(),
          conversation,
        },
      },
      { upsert: true },
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("Failed to save chat history via /api/chat/history:", error);
    return res.status(500).json({ error: "Failed to save chat history" });
  }
});

app.delete("/api/chat/history", async (req, res) => {
  // Log incoming query for diagnostics
  console.log("DELETE /api/chat/history - raw query:", req.query);

  const sessionIdRaw = req.query?.sessionId ?? req.query?.id ?? null;
  const sessionId =
    typeof sessionIdRaw === "string"
      ? sessionIdRaw.trim()
      : sessionIdRaw?.toString?.()?.trim?.() || null;

  if (!sessionId) {
    console.warn("Missing or empty sessionId in delete request", req.query);
    return res.status(400).json({ error: "sessionId is required" });
  }

  try {
    const client = await getMongoClient();
    const db = client.db(mongoDbName);
    const result = await deleteSessionRelatedData(db, sessionId);
    console.log("Deleted chat history result:", {
      sessionId,
      deletedCount: result.deletedCount,
      filesFound: result.filesFound,
      filesDeleted: result.filesDeleted,
      fileDeleteFailures: result.fileDeleteFailures,
    });
    return res.json({
      success: true,
      deletedCount: result.deletedCount,
      filesFound: result.filesFound,
      filesDeleted: result.filesDeleted,
      fileDeleteFailures: result.fileDeleteFailures,
    });
  } catch (error) {
    console.error("Failed to delete chat history:", error, { sessionId });
    return res.status(500).json({ error: "Failed to delete chat history" });
  }
});

app.get("/api/chat/sessions", async (req, res) => {
  try {
    const client = await getMongoClient();
    const db = client.db(mongoDbName);
    const sessions = await getAllSessionSummaries(db);
    const summaries = sessions.map((doc) => {
      const firstUser =
        doc.conversation?.find((item) => item.role === "user")?.content ||
        "New Chat";
      const title =
        firstUser.slice(0, 24) + (firstUser.length > 24 ? "..." : "");
      return {
        id: doc.sessionId,
        sessionId: doc.sessionId,
        title,
        updatedAt: doc.updatedAt || doc.createdAt,
        lastMessage: doc.conversation?.slice(-1)[0]?.content || "",
      };
    });
    return res.json(summaries);
  } catch (error) {
    console.error("Failed to load chat sessions from MongoDB:", error);
    return res.status(500).json({ error: "Failed to load chat sessions" });
  }
});

// Progress endpoint for file processing and indexing
app.get("/api/chat/progress", async (req, res) => {
  const sessionId = req.query?.sessionId?.toString?.().trim?.() || null;
  if (!sessionId) return res.json({ stage: "idle", pct: 0 });
  const prog = getProgress(sessionId);
  return res.json(prog);
});

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
  console.log("Incoming file:", file ? file.originalname : "No file uploaded");

  let sessionId =
    req.body?.sessionId?.toString?.().trim() ||
    req.headers["x-session-id"] ||
    null;
  if (!sessionId) {
    sessionId = generateSessionId();
  }
  const timestamp = new Date();
  const userMessageContent =
    query || (file ? `Uploaded file: ${file.originalname}` : "");

  let mongoUpload = null;
  let mongoFileId = null;
  let sessionFileInfo = null;

  if (sessionId) {
    try {
      const client = await getMongoClient();
      const db = client.db(mongoDbName);
      sessionFileInfo = await getLatestSessionFileInfo(db, sessionId);
    } catch (err) {
      console.error("Error loading last session file info:", err);
    }
  }

  if (file) {
    console.log(`Received file upload: ${file.originalname}`);
    // mark received in progress map
    setProgress(sessionId, {
      stage: "received",
      pct: 5,
      message: "File received on server",
    });

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
        sessionFileInfo = {
          mongoFileId: mongoFileId.toString(),
          fileName: file.originalname,
          fileType: file.mimetype || null,
          fileInfo: {
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
            uploadedAt: timestamp,
          },
        };
        console.log(`Uploaded PDF to MongoDB with file id: ${mongoFileId}`);
        setProgress(sessionId, {
          stage: "stored",
          pct: 25,
          message: "File stored in GridFS",
        });
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
  if (!mongoFileId && sessionFileInfo?.mongoFileId) {
    mongoFileId = sessionFileInfo.mongoFileId;
  }

  if (mongoFileId) {
    try {
      // request document preparation and pass a progress callback
      setProgress(sessionId, {
        stage: "indexing",
        pct: 40,
        message: "Indexing document and creating embeddings",
      });
      const results = await prepareDocument(
        mongoFileId.toString(),
        query,
        (update) => {
          // progress callback from loader: merge into session progress
          setProgress(sessionId, update);
        },
      );
      // prepareDocument returns an array of Document objects; join their pageContent
      retrievedContext = Array.isArray(results)
        ? results.map((d) => d.pageContent || d).join("\n---\n")
        : String(results || "");
      setProgress(sessionId, {
        stage: "retrieved",
        pct: 85,
        message: "Context retrieved",
      });
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
      const memoryMessages = await loadChatMemory(db, sessionId, 20);
      if (memoryMessages.length > 0) {
        memoryContext = memoryMessages
          .map((msg) => {
            if (!msg.role || !msg.content) return "";
            const roleLabel = msg.role === "assistant" ? "Assistant" : "User";
            return `${roleLabel}: ${msg.content}`;
          })
          .filter(Boolean)
          .join("\n");
      }
    } catch (err) {
      console.error("Error loading chat memory from MongoDB:", err);
      memoryContext = "";
    }
  }

  const hasFile = Boolean(file);
  let chatCompletion = null;
  let assistantContent = null; // null means no assistant reply was generated

  // Only call the chat model when there's an actual user query to answer.
  if (query) {
    const finalprompt = `You are a helpful assistant. Use conversation memory to answer the user's question and remember details from prior exchanges, including the user's name and preferences. If a file was uploaded, act as a retrieval-augmented generation (RAG) assistant: use the provided document context plus conversation memory to answer accurately and do not hallucinate. If no file was uploaded, answer as a normal assistant using only conversation memory and general knowledge. If the answer is not supported by memory or the available document context, say \"I don't know.\" Do not invent facts.\n\n
File uploaded: ${hasFile ? "Yes" : "No"}\n
File name: ${file ? file.originalname : "None"}\n
Conversation memory:\n${memoryContext || "No prior conversation memory."}\n
Document context:\n${retrievedContext || (hasFile ? "No context available." : "No file was uploaded.")}\n
User question: ${query}\n
Answer:`;

    const messages = [
      {
        role: "system",
        content: finalprompt,
      },
      { role: "user", content: query },
    ];

    try {
      chatCompletion = await getGroqChatCompletion(messages);
      assistantContent =
        chatCompletion.choices?.[0]?.message?.content ||
        "Sorry, I couldn't get a response from the assistant.";
    } catch (completionError) {
      console.error("Groq chat completion failed:", completionError);
      assistantContent = "Sorry, I couldn't get a response from the assistant.";
    }
  } else {
    // No query provided: treat this as indexing-only (upload/embedding) request.
    // Do not call the language model and do not fabricate an assistant reply.
    assistantContent = null;
  }

  const currentFileName = file ? file.originalname : null;
  const currentFileType = file ? file.mimetype : null;
  const currentFileInfo = file
    ? {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        uploadedAt: timestamp,
      }
    : null;

  try {
    const client = await getMongoClient();
    const db = client.db(mongoDbName);
    await saveChatHistory(db, sessionId, {
      userContent: userMessageContent,
      assistantContent,
      fileName: currentFileName,
      mongoFileId,
      fileType: currentFileType,
      fileUploaded: Boolean(file),
      fileInfo: currentFileInfo,
      createdAt: timestamp,
    });
    // final progress update
    setProgress(sessionId, {
      stage: "done",
      pct: 100,
      message: "Saved chat and ready",
    });
  } catch (saveError) {
    console.error("Failed to save chat history:", saveError);
  }

  res.json({
    savedFile: file ? file.originalname : null,
    mongoUpload,
    sessionId,
    // If assistantContent is null then this was an indexing-only request
    // and we return an explicit flag so the frontend avoids adding a
    // placeholder assistant message.
    response:
      chatCompletion ||
      (assistantContent !== null
        ? { choices: [{ message: { content: assistantContent } }] }
        : null),
    indexingOnly: assistantContent === null,
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
