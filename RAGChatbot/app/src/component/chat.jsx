/* eslint-disable no-unused-vars */
/* eslint-disable react-hooks/immutability */
/* eslint-disable react-hooks/set-state-in-effect */
import axios from "axios";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useEffect, useRef, useState } from "react";
import "katex/dist/katex.min.css";

const SESSION_STORAGE_KEY = "ragchat_session_id";

function createSessionId() {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function Chat({
  initialPrompt = "",
  file = null,
  onBack,
  onNewChat,
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);

  // Session summaries list for the sidebar
  const [history, setHistory] = useState([]);

  const hasSentInitialRef = useRef(false);
  const messagesEndRef = useRef(null);

  const [selectedFile, setSelectedFile] = useState(null);
  const [attachedFileName, setAttachedFileName] = useState("");
  const fileInputRef = useRef(null);

  const syncHistoryFromServer = async (currentSessionId) => {
    if (!currentSessionId) return;

    try {
      const { data } = await axios.get(
        "http://localhost:3000/api/chat/history",
        {
          params: { sessionId: currentSessionId },
        },
      );

      if (Array.isArray(data)) {
        const loadedMessages = data
          .filter((msg) => msg?.role)
          .map((msg) => ({
            id:
              msg._id?.$oid ||
              msg._id ||
              `${currentSessionId}-${msg.createdAt}`,
            role: msg.role,
            content: msg.content || "",
            fileName: msg.fileName || null,
          }));

        setMessages(loadedMessages);
      }
    } catch (error) {
      console.error("Failed to load chat history from MongoDB:", error);
    }
  };

  const fetchSessionSummaries = async () => {
    try {
      const { data } = await axios.get(
        "http://localhost:3000/api/chat/sessions",
      );

      if (Array.isArray(data)) {
        setHistory(data);
      }
    } catch (error) {
      console.error("Failed to load chat sessions from MongoDB:", error);
    }
  };

  const startNewChat = () => {
    const sessionKey = createSessionId();
    setSessionId(sessionKey);
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionKey);
    setMessages([]);
    setInput("");
    setAttachedFileName("");
    setSelectedFile(null);
    hasSentInitialRef.current = false;
    void fetchSessionSummaries();
  };

  const updateHistoryWithMessages = async (nextMessages) => {
    if (!sessionId) return;

    try {
      await axios.post("http://localhost:3000/api/chat/history", {
        sessionId,
        messages: nextMessages,
      });
      setMessages(nextMessages);
    } catch (error) {
      console.error("Failed to save chat history:", error);
      setMessages(nextMessages);
    }
  };

  // Delete handler for individual chat history sessions
  const handleDeleteChat = async (id, e) => {
    e.stopPropagation(); // Prevents selection click event from triggering

    if (!window.confirm("Are you sure you want to delete this conversation?"))
      return;

    try {
      await axios.delete("http://localhost:3000/api/chat/history", {
        params: { sessionId: id },
      });

      // Refresh sidebar sessions history list
      await fetchSessionSummaries();

      // If the currently open chat is the one being deleted, reset window state to a new chat
      if (id === sessionId) {
        startNewChat();
      }
    } catch (error) {
      console.error("Failed to delete chat session from MongoDB:", error);
    }
  };

  // 1. Initialize History and Session on Mount
  useEffect(() => {
    const existingSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (existingSessionId) {
      setSessionId(existingSessionId);
      void syncHistoryFromServer(existingSessionId);
    } else {
      void startNewChat();
    }

    void fetchSessionSummaries();
  }, []);

  // 2. Switch between different history items
  const handleSelectChat = (id) => {
    if (isLoading) return; // Prevent switching while waiting for AI response
    window.localStorage.setItem(SESSION_STORAGE_KEY, id);
    setSessionId(id);
    setMessages([]);
    void syncHistoryFromServer(id);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Handle Initial Landing Setup
  useEffect(() => {
    const hasContent = initialPrompt || file?.name;
    if (!hasContent || hasSentInitialRef.current) return;
    if (!sessionId) return;

    hasSentInitialRef.current = true;

    const userMessage = {
      id: Date.now().toString(),
      role: "user",
      content: initialPrompt,
      fileName: file ? file.name : null,
      fileType: file ? file.type : null,
      fileUploaded: Boolean(file),
      fileInfo: file
        ? {
            originalName: file.name,
            mimeType: file.type,
            size: file.size,
          }
        : null,
    };

    const updatedMsgs = [...messages, userMessage];
    setMessages(updatedMsgs);
    setIsLoading(true);

    const sendRequest = () => {
      if (file) {
        const formData = new FormData();
        formData.append("query", initialPrompt);
        formData.append("file", file);
        formData.append("sessionId", sessionId);
        return axios.post("http://localhost:3000/api/chat", formData);
      }
      return axios.post("http://localhost:3000/api/chat", {
        query: initialPrompt,
        sessionId,
      });
    };

    sendRequest()
      .then((response) => {
        const assistantContent =
          response.data.response?.choices?.[0]?.message?.content ||
          "Sorry, I couldn't get a response from the assistant.";

        const aiResponse = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: assistantContent,
        };
        updateHistoryWithMessages([...updatedMsgs, aiResponse]);
      })
      .catch((error) => {
        console.error("Error calling chat API:", error);
        const aiResponse = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content:
            "There was an error contacting the assistant. Please try again.",
        };
        updateHistoryWithMessages([...updatedMsgs, aiResponse]);
      })
      .finally(() => setIsLoading(false));
  }, [initialPrompt, file, sessionId, messages]);

  // Handle subsequent manual input sends
  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim() && !selectedFile) return;
    if (isLoading) return;

    const userMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
      fileName: selectedFile ? selectedFile.name : null,
      fileType: selectedFile ? selectedFile.type : null,
      fileUploaded: Boolean(selectedFile),
      fileInfo: selectedFile
        ? {
            originalName: selectedFile.name,
            mimeType: selectedFile.type,
            size: selectedFile.size,
          }
        : null,
    };

    const updatedMsgs = [...messages, userMessage];
    setMessages(updatedMsgs);
    setIsLoading(true);

    const fileToSend = selectedFile;
    setInput("");
    setAttachedFileName("");
    setSelectedFile(null);

    const sendRequest = () => {
      if (fileToSend) {
        const formData = new FormData();
        formData.append("query", userMessage.content);
        formData.append("file", fileToSend);
        formData.append("sessionId", sessionId);
        return axios.post("http://localhost:3000/api/chat", formData);
      }
      return axios.post("http://localhost:3000/api/chat", {
        query: userMessage.content,
        sessionId,
      });
    };

    sendRequest()
      .then((response) => {
        const assistantContent =
          response.data.response?.choices?.[0]?.message?.content ||
          "Sorry, I couldn't get a response from the assistant.";

        const aiResponse = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: assistantContent,
        };
        updateHistoryWithMessages([...updatedMsgs, aiResponse]);
      })
      .catch((error) => {
        console.error("Error calling chat API:", error);
        const aiResponse = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content:
            "There was an error contacting the assistant. Please try again.",
        };
        updateHistoryWithMessages([...updatedMsgs, aiResponse]);
      })
      .finally(() => setIsLoading(false));
  };

  const handleFileChange = (event) => {
    const fileObj = event.target.files?.[0];
    if (!fileObj) return;
    setAttachedFileName(fileObj.name);
    setSelectedFile(fileObj);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = () => {
    setAttachedFileName("");
    setSelectedFile(null);
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="flex h-screen w-full bg-white text-slate-900 overflow-hidden">
      {/* LEFT SIDEBAR AREA */}
      <aside className="w-64 border-r border-slate-200 bg-slate-50 flex flex-col shrink-0 h-full  md:flex">
        <div className="p-4 border-b border-slate-200 flex flex-col gap-2">
          <button
            onClick={() => {
              if (onNewChat) {
                onNewChat();
              } else {
                onBack();
              }
            }}
            className="mt-2 w-full py-2 px-4 rounded-xl bg-slate-900 text-white text-sm font-medium transition hover:bg-slate-800 shadow-sm"
          >
            + New Chat
          </button>
        </div>

        {/* Scrollable Chat History List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="px-3 py-1.5 text-xs font-semibold text-slate-400 tracking-wider uppercase">
            Recent Conversations
          </div>
          {history.map((chat) => (
            <div
              key={chat.id}
              className={`group relative flex items-center justify-between rounded-xl transition-all duration-150
                ${
                  chat.id === sessionId
                    ? "bg-slate-200/80 text-slate-900 font-semibold"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
            >
              <button
                onClick={() => handleSelectChat(chat.id)}
                className="w-full text-left px-3 py-2.5 text-sm font-medium truncate pr-10 block"
              >
                {chat.title}
              </button>

              {/* Trash Action Button revealed on parent item hover */}
              <button
                type="button"
                onClick={(e) => handleDeleteChat(chat.id, e)}
                className="absolute right-2 opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-slate-200/60 transition-all duration-150"
                title="Delete Conversation"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4"
                >
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* RIGHT CHAT WINDOW AREA */}
      <div className="flex flex-1 flex-col h-full bg-white relative min-w-0">
        {/* Header bar back interface */}
        <header className="flex h-14 shrink-0 items-center border-b border-slate-150 bg-white px-4">
          <button
            onClick={onBack}
            className="md:hidden rounded-xl px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            <span>← Back</span>
          </button>
          <div className="ml-3 font-semibold text-slate-800 truncate">
            {history.find((h) => h.id === sessionId)?.title || "Chat Interface"}
          </div>
        </header>

        {/* Message Feed Area */}
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.length === 0 && !isLoading && (
              <div className="text-center py-12 text-slate-400 text-sm">
                No messages yet. Ask a question or drop a file below to start!
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-4 text-base ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                {/* AI Avatar */}
                {msg.role === "assistant" && (
                  <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-700 shadow-sm">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-4 w-4 text-emerald-600"
                    >
                      <path d="M12 2a10 10 0 0 1 7.54 16.59c-.24.25-.47.5-.63.79l-1.22 2.13a1 1 0 0 1-1.73 0l-1.22-2.13c-.16-.29-.39-.54-.63-.79A10 10 0 0 1 12 2z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                  </div>
                )}

                {/* Message Content Container */}
                <div
                  className={`max-w-[85%] rounded-2xl text-base leading-7 ${
                    msg.role === "user"
                      ? "bg-slate-100 text-slate-900 px-4 py-3"
                      : "bg-transparent text-slate-900 px-0 py-2.5"
                  }`}
                >
                  {/* Render the Attached File Bubble inside User message feed item */}
                  {msg.role === "user" && msg.fileName && (
                    <div className="mb-2 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm max-w-xs">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="h-4 w-4 text-slate-500 shrink-0"
                      >
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="truncate font-medium max-w-[200px]">
                        {msg.fileName}
                      </span>
                    </div>
                  )}

                  {msg.content && (
                    <div className="prose prose-slate max-w-none whitespace-pre-wrap break-words">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                          p: ({ node, children }) => (
                            <p className="m-0">{children}</p>
                          ),
                          li: ({ node, children }) => (
                            <li className="ml-4 list-disc">{children}</li>
                          ),
                          code: ({ node, inline, className, children }) => {
                            const match = /language-(\w+)/.exec(
                              className || "",
                            );
                            return inline ? (
                              <code className="rounded bg-slate-100 px-1 py-0.5 text-sm text-slate-900">
                                {children}
                              </code>
                            ) : (
                              <pre className="rounded bg-slate-950 p-3 text-sm text-white overflow-x-auto">
                                <code className={className}>{children}</code>
                              </pre>
                            );
                          },
                          table: ({ node, children }) => (
                            <div className="overflow-x-auto">
                              <table className="min-w-full border-collapse border border-slate-200">
                                {children}
                              </table>
                            </div>
                          ),
                          th: ({ node, children }) => (
                            <th className="border border-slate-200 bg-slate-100 px-3 py-2 text-left font-semibold">
                              {children}
                            </th>
                          ),
                          td: ({ node, children }) => (
                            <td className="border border-slate-200 px-3 py-2">
                              {children}
                            </td>
                          ),
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Assistant Loading Skeleton State */}
            {isLoading && (
              <div className="flex gap-4 justify-start">
                <div className="flex h-8 w-8 shrink-0 animate-pulse items-center justify-center rounded-full bg-slate-100 text-slate-400">
                  ✨
                </div>
                <div className="space-y-2 pt-2 w-full max-w-[60%]">
                  <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-5/6 animate-pulse rounded bg-slate-100" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Form Footer Container */}
        <footer className="bg-transparent p-2 pb-4">
          <form onSubmit={handleSend} className="mx-auto max-w-3xl relative">
            <div
              className={`mx-auto w-full border border-slate-200 bg-white shadow-[0_10px_40px_rgba(15,23,42,0.04)] flex flex-col justify-between transition-all duration-150
                ${
                  input.length > 75 || input.includes("\n") || attachedFileName
                    ? "rounded-[26px] p-4 pb-3"
                    : "rounded-full h-[56px] px-4 justify-center"
                }`}
            >
              {/* File Attachment Chip Layer */}
              {attachedFileName && (
                <div className="w-full flex justify-start mb-2 px-1">
                  <div className="group relative flex items-center gap-2 rounded-xl border border-slate-150 bg-slate-50/80 px-3 py-1.5 pr-8 text-sm text-slate-800 shadow-sm max-w-xs">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-4 w-4 text-slate-500 shrink-0"
                    >
                      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="truncate font-medium max-w-[180px]">
                      {attachedFileName}
                    </span>
                    <button
                      type="button"
                      onClick={removeFile}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full bg-slate-200/70 text-slate-600 transition hover:bg-slate-300 text-xs font-bold"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}

              {/* Main Input Segment */}
              <div className="w-full flex items-center gap-1 translate-y-2">
                {/* Upload Button */}
                {!(
                  input.length > 75 ||
                  input.includes("\n") ||
                  attachedFileName
                ) && (
                  <button
                    type="button"
                    onClick={handleUploadClick}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-transparent text-slate-600 text-lg font-light transition hover:bg-slate-100"
                    disabled={isLoading}
                  >
                    +
                  </button>
                )}

                {/* Textarea Input styling */}
                <div className="flex-1 min-w-0 grid content-center">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={isLoading}
                    rows={1}
                    placeholder="Message AI Assistant..."
                    className={`w-full resize-none bg-transparent text-base text-slate-900 placeholder:text-slate-400 focus:outline-none block max-h-[200px] custom-scrollbar
                      ${
                        input.length > 75 ||
                        input.includes("\n") ||
                        attachedFileName
                          ? "h-auto py-1 px-1"
                          : "h-[24px] overflow-hidden leading-[24px] pr-2"
                      }`}
                    style={
                      input.length > 75 ||
                      input.includes("\n") ||
                      attachedFileName
                        ? {
                            height: `${Math.min(input.split("\n").length * 24 + 24, 200)}px`,
                          }
                        : undefined
                    }
                  />
                </div>

                {/* Submit Button */}
                {!(
                  input.length > 75 ||
                  input.includes("\n") ||
                  attachedFileName
                ) && (
                  <button
                    type="submit"
                    disabled={(!input.trim() && !attachedFileName) || isLoading}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-950 text-white shadow-sm transition hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-300"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className="h-4 w-4"
                    >
                      <path d="M10.5 5.25L16.5 9.75L10.5 14.25" />
                      <path d="M16.5 9.75H7.5" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Expanded Multi-line Action Footer Row */}
              {(input.length > 75 ||
                input.includes("\n") ||
                attachedFileName) && (
                <div className="w-full flex items-center justify-between mt-4 pt-1">
                  <button
                    type="button"
                    onClick={handleUploadClick}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-transparent text-slate-600 text-lg font-light transition hover:bg-slate-100"
                    disabled={isLoading}
                  >
                    +
                  </button>

                  <button
                    type="submit"
                    disabled={(!input.trim() && !attachedFileName) || isLoading}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-950 text-white shadow-sm transition hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-300"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className="h-4 w-4"
                    >
                      <path d="M10.5 5.25L16.5 9.75L10.5 14.25" />
                      <path d="M16.5 9.75H7.5" />
                    </svg>
                  </button>
                </div>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileChange}
            />
          </form>
        </footer>
      </div>
    </div>
  );
}
