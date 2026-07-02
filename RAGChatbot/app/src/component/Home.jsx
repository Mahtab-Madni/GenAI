/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable react-hooks/refs */
import { useEffect, useRef, useState } from "react";
import Chat from "./chat";

const SESSION_STORAGE_KEY = "ragchat_session_id";
const CHAT_HISTORY_KEY = "ragchat_history";

export default function Home() {
  const [query, setQuery] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [send, setSend] = useState(false);
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [attachedFileName, setAttachedFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);

  // Shared history tracking state
  const [history, setHistory] = useState([]);
  // eslint-disable-next-line no-unused-vars
  const [activeSessionId, setActiveSessionId] = useState(null);

  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Load chat history on mount
  useEffect(() => {
    const savedHistory = window.localStorage.getItem(CHAT_HISTORY_KEY);
    if (savedHistory) {
      setHistory(JSON.parse(savedHistory));
    }
    const existingSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (existingSessionId) {
      setActiveSessionId(existingSessionId);
    }
  }, [send]); // Reload history whenever switching views back and forth

  // Force multiline layout rules if a file is uploaded or text expands
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (query === "" && !attachedFileName) {
      setIsMultiLine(false);
    } else {
      setIsMultiLine(!!attachedFileName || textarea.scrollHeight > 36);
    }
  }, [query, attachedFileName]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!query.trim() && !attachedFileName) return;

    const finalPrompt = query.trim();
    setInitialPrompt(finalPrompt);

    // Clear out any old explicitly set session so Chat creates a fresh one
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    setActiveSessionId(null);
    setSend(true);
    setQuery("");
  };

  // Switch directly to a historic chat session
  const handleSelectChat = (id) => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, id);
    setActiveSessionId(id);
    setInitialPrompt(""); // No new initial prompt, just viewing old logs
    setSelectedFile(null);
    setAttachedFileName("");
    setSend(true);
  };

  // Reset view back to the clean home landing screen for a new prompt
  const handleNewChatClick = () => {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    setActiveSessionId(null);
    setInitialPrompt("");
    setSelectedFile(null);
    setAttachedFileName("");
    setQuery("");
    setSend(false);
  };

  const handleUploadClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setAttachedFileName(file.name);
    setSelectedFile(file);

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = () => {
    setAttachedFileName("");
    setSelectedFile(null);
  };

  // Switch to Chat Interface view
  if (send) {
    return (
      <Chat
        initialPrompt={initialPrompt}
        file={selectedFile}
        onBack={() => {
          setSend(false);
          setAttachedFileName("");
          setSelectedFile(null);
          setInitialPrompt("");
        }}
      />
    );
  }

  return (
    <div className="flex h-screen w-full bg-white text-slate-950 overflow-hidden">
      {/* LEFT SIDEBAR AREA */}
      <aside className="w-64 border-r border-slate-200 bg-slate-50 flex flex-col shrink-0 h-full hidden md:flex">
        <div className="p-4 border-b border-slate-200">
          <button
            onClick={handleNewChatClick}
            className="w-full py-2 px-4 rounded-xl bg-slate-900 text-white text-sm font-medium transition hover:bg-slate-800 shadow-sm"
          >
            + New Chat
          </button>
        </div>

        {/* Scrollable Chat History List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="px-3 py-1.5 text-xs font-semibold text-slate-400 tracking-wider uppercase">
            Recent Conversations
          </div>
          {history.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400 italic">
              No previous chats
            </div>
          ) : (
            history.map((chat) => (
              <button
                key={chat.id}
                onClick={() => handleSelectChat(chat.id)}
                className="w-full text-left px-3 py-2.5 rounded-xl text-sm transition font-medium truncate block text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                {chat.title}
              </button>
            ))
          )}
        </div>
      </aside>

      {/* MAIN CONTENT LANDING WORKSPACE */}
      <main className="flex-1 overflow-y-auto h-full flex flex-col items-center justify-center relative min-w-0 px-4 py-20 sm:px-6 lg:px-8">
        <div className="w-full text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
            What’s on your mind today?
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-500 sm:text-lg">
            Chat with the assistant using the same layout as the official
            ChatGPT home page.
          </p>

          <form
            onSubmit={handleSubmit}
            className={`mx-auto mt-12 w-full max-w-3xl border border-slate-200 bg-white shadow-[0_20px_70px_rgba(15,23,42,0.08)] flex flex-col justify-between transition-all duration-150
              ${
                isMultiLine
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

            {/* Upper Content/Text Area Section */}
            <div
              className={`w-full flex items-center gap-1 ${isMultiLine ? "translate-y-0" : "translate-y-2"}`}
            >
              {/* Upload Button */}
              {!isMultiLine && (
                <button
                  type="button"
                  onClick={handleUploadClick}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-transparent text-slate-600 text-lg font-light transition hover:bg-slate-100"
                >
                  +
                </button>
              )}

              <div className="flex-1 min-w-0">
                <textarea
                  ref={textareaRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  rows={1}
                  placeholder="Ask anything"
                  className={`w-full resize-none bg-transparent text-base text-slate-900 placeholder:text-slate-400 focus:outline-none block max-h-[200px] custom-scrollbar
                    ${isMultiLine ? "h-auto py-1 px-1" : "h-[24px] overflow-hidden leading-[24px] pr-2"}`}
                  style={
                    isMultiLine
                      ? { height: textareaRef.current?.scrollHeight }
                      : undefined
                  }
                />
              </div>

              {/* Submit Button */}
              {!isMultiLine && (
                <button
                  type="submit"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-950 text-white shadow-sm transition hover:bg-slate-800"
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

            {/* Dynamic Multiline Actions Bar */}
            {isMultiLine && (
              <div className="w-full flex items-center justify-between mt-4 pt-1">
                <button
                  type="button"
                  onClick={handleUploadClick}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-transparent text-slate-600 text-lg font-light transition hover:bg-slate-100"
                >
                  +
                </button>

                <button
                  type="submit"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-950 text-white shadow-sm transition hover:bg-slate-800"
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

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileChange}
            />
          </form>
        </div>
      </main>
    </div>
  );
}
