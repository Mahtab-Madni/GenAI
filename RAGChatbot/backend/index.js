import express from "express";
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
  const sessionId = req.query?.sessionId?.toString?.trim?.() || null;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  try {
    const client = await getMongoClient();
    const db = client.db(mongoDbName);
    await db.collection("chat_msg").deleteOne({ sessionId });
    return res.json({ success: true });
  } catch (error) {
    console.error("Failed to delete chat history:", error);
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
  const finalprompt = `You are a helpful assistant. Use conversation memory to answer the user's question and remember details from prior exchanges, including the user's name and preferences. If a file was uploaded, act as a retrieval-augmented generation (RAG) assistant: use the provided document context plus conversation memory to answer accurately and do not hallucinate. If no file was uploaded, answer as a normal assistant using only conversation memory and general knowledge. If the answer is not supported by memory or the available document context, say "I don't know." Do not invent facts.\n\n
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
  ];

  if (query) {
    messages.push({ role: "user", content: query });
  }

  let chatCompletion = null;
  let assistantContent = "Sorry, I couldn't get a response from the assistant.";

  try {
    chatCompletion = await getGroqChatCompletion(messages);
    assistantContent =
      chatCompletion.choices?.[0]?.message?.content || assistantContent;
  } catch (completionError) {
    console.error("Groq chat completion failed:", completionError);
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
  } catch (saveError) {
    console.error("Failed to save chat history:", saveError);
  }

  res.json({
    savedFile: file ? file.originalname : null,
    mongoUpload,
    sessionId,
    response: chatCompletion || {
      choices: [{ message: { content: assistantContent } }],
    },
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
