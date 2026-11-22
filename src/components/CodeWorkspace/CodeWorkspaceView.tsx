import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { Breadcrumb } from '../Navigation/Breadcrumb';
import { runClientSyntaxCheck } from '../../lib/codeFormatter';
import { CodeDiagnosticItem, SupportedCodeLanguage } from '../../types';
import {
  Code2,
  Play,
  RotateCcw,
  AlignLeft,
  Users2,
  Send,
  Sparkles,
  Terminal,
  AlertCircle,
  CheckCircle2,
  Share2,
  Bot,
  Wand2,
  Copy,
  Check,
  Keyboard,
  RefreshCw,
  ArrowRightCircle,
  AlertTriangle,
  Square,
  CornerDownLeft,
} from 'lucide-react';

interface RuntimeMeta {
  available: boolean;
  label: string;
}

const DEFAULT_RUNTIME_LABELS: Record<SupportedCodeLanguage, RuntimeMeta> = {
  python: { available: true, label: 'Python 3.11' },
  c: { available: true, label: 'C (GCC 12.2)' },
  cpp: { available: true, label: 'C++17 (G++ 12.2)' },
};

const QUICK_AI_PROMPTS = [
  { label: 'Fix Bugs', prompt: 'Find and fix any syntax, runtime, or logic bugs in this code.' },
  { label: 'Optimize Complexity', prompt: 'Optimize time and space complexity while preserving exact behavior.' },
  { label: 'Add Edge Guards', prompt: 'Add defensive edge-case and null/empty input handling.' },
  { label: 'Explain Code', prompt: 'Explain how this algorithm works step-by-step and note any subtle flaws.' },
];

export const CodeWorkspaceView: React.FC = () => {
  const {
    codeLanguage,
    setCodeLanguage,
    code,
    setCode,
    resetCodeToTemplate,
    stdinInput,
    setStdinInput,
    consoleLogs,
    isExecutingCode,
    interactiveSessionId,
    interactiveEofSent,
    lastExecutionResult,
    runCode,
    sendInteractiveStdin,
    sendInteractiveEof,
    stopCodeExecution,
    clearConsole,
    formatCode,
    debugCodeWithAi,
    aiDebugResult,
    aiDebugAnalysis,
    aiDebugError,
    isAiDebugging,
    clearAiDebugResult,
    applyAiFix,
    chatMessages,
    sendChatMessage,
    activeChannel,
    setActiveChannel,
    showToast,
  } = useApp();

  const [activeConsoleTab, setActiveConsoleTab] = useState<'console' | 'stdin' | 'ai-debugger' | 'problems'>('console');
  const [chatInputText, setChatInputText] = useState('');
  const [customDebugPrompt, setCustomDebugPrompt] = useState('');
  const [interactiveInputValue, setInteractiveInputValue] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedFix, setCopiedFix] = useState(false);
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeMeta>>(DEFAULT_RUNTIME_LABELS);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const consoleBottomRef = useRef<HTMLDivElement>(null);
  const interactiveInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/code-runtimes')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.success && data.runtimes) {
          setRuntimes(data.runtimes);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  useEffect(() => {
    if (activeConsoleTab === 'console') {
      consoleBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [consoleLogs, activeConsoleTab, interactiveSessionId]);

  useEffect(() => {
    if (interactiveSessionId && !interactiveEofSent && activeConsoleTab === 'console') {
      interactiveInputRef.current?.focus();
    }
  }, [interactiveSessionId, interactiveEofSent, activeConsoleTab]);

  useEffect(() => {
    if (aiDebugResult || aiDebugAnalysis || aiDebugError) {
      setActiveConsoleTab('ai-debugger');
    }
  }, [aiDebugResult, aiDebugAnalysis, aiDebugError]);

  const combinedDiagnostics = useMemo<CodeDiagnosticItem[]>(() => {
    const clientChecks = runClientSyntaxCheck(code || '', codeLanguage);
    const serverDiags = lastExecutionResult?.diagnostics || [];
    const seen = new Set<string>();
    const merged: CodeDiagnosticItem[] = [];
    for (const item of [...serverDiags, ...clientChecks]) {
      const key = `${item.line ?? 'none'}:${item.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
    return merged;
  }, [code, codeLanguage, lastExecutionResult]);

  const errorLines = useMemo(() => {
    const lines = new Set<number>();
    combinedDiagnostics.forEach((d) => {
      if (d.severity === 'error' && d.line) {
        lines.add(d.line);
      }
    });
    return lines;
  }, [combinedDiagnostics]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInputText.trim()) return;
    sendChatMessage(chatInputText);
    setChatInputText('');
  };

  const handleShareCodeToChat = () => {
    const snippetPreview = (code || '').slice(0, 320);
    sendChatMessage(
      `Check out my current ${codeLanguage.toUpperCase()} implementation:\n\`\`\`${codeLanguage}\n${snippetPreview}${(code || '').length > 320 ? '\n...' : ''}\n\`\`\``
    );
    showToast('Code shared to active collaboration channel!');
  };

  const handleCopyEditorCode = () => {
    navigator.clipboard.writeText(code || '');
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1800);
    showToast('Code copied to clipboard');
  };

  const handleRunCode = async () => {
    setInteractiveInputValue('');
    setActiveConsoleTab('console');
    await runCode();
  };

  const handleInteractiveStdinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!interactiveSessionId || interactiveEofSent) return;
    const val = interactiveInputValue;
    setInteractiveInputValue('');
    await sendInteractiveStdin(val);
    interactiveInputRef.current?.focus();
  };

  const handleTriggerAiDebugger = async (prompt?: string) => {
    setActiveConsoleTab('ai-debugger');
    await debugCodeWithAi(prompt);
  };

  const handleApplyAiFix = async (runAfter = false) => {
    await applyAiFix(runAfter);
    if (runAfter) {
      setActiveConsoleTab('console');
    }
  };

  // Sync line gutter vertical scroll with editor textarea
  const handleEditorScroll = () => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // IDE keyboard shortcuts: Tab / Shift+Tab, Enter auto-indent, Ctrl/Cmd+Enter Run
  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const indentUnit = '    ';

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleRunCode();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const value = code || '';

      if (start !== end && value.slice(start, end).includes('\n')) {
        // Multi-line block indent / dedent
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const afterEnd = value.indexOf('\n', end);
        const lineEnd = afterEnd === -1 ? value.length : afterEnd;
        const selectedBlock = value.slice(lineStart, lineEnd);
        const blockLines = selectedBlock.split('\n');

        let deltaFirst = 0;
        let deltaTotal = 0;
        const updatedLines = blockLines.map((line, idx) => {
          if (e.shiftKey) {
            const match = line.match(/^( {1,4}|\t)/);
            if (match) {
              const removed = match[0].length;
              if (idx === 0) deltaFirst = -removed;
              deltaTotal -= removed;
              return line.slice(removed);
            }
            return line;
          } else {
            if (idx === 0) deltaFirst = indentUnit.length;
            deltaTotal += indentUnit.length;
            return indentUnit + line;
          }
        });

        const nextValue = value.slice(0, lineStart) + updatedLines.join('\n') + value.slice(lineEnd);
        setCode(nextValue);
        requestAnimationFrame(() => {
          if (!textareaRef.current) return;
          textareaRef.current.selectionStart = Math.max(lineStart, start + deltaFirst);
          textareaRef.current.selectionEnd = Math.max(lineStart, end + deltaTotal);
        });
        return;
      }

      if (e.shiftKey) {
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const linePrefix = value.slice(lineStart, start);
        const match = linePrefix.match(/( {1,4}|\t)$/);
        if (match) {
          const removeLen = match[0].length;
          const nextValue = value.slice(0, start - removeLen) + value.slice(start);
          setCode(nextValue);
          requestAnimationFrame(() => {
            if (!textareaRef.current) return;
            textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start - removeLen;
          });
        }
        return;
      }

      const nextValue = value.slice(0, start) + indentUnit + value.slice(end);
      setCode(nextValue);
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + indentUnit.length;
      });
      return;
    }

    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const value = code || '';
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const currentLineBeforeCursor = value.slice(lineStart, start);
      const baseIndentMatch = currentLineBeforeCursor.match(/^[ \t]*/);
      const baseIndent = baseIndentMatch ? baseIndentMatch[0] : '';
      const trimmedBefore = currentLineBeforeCursor.trimEnd();
      const needsExtraIndent = trimmedBefore.endsWith('{') || trimmedBefore.endsWith(':');
      const insertion = '\n' + baseIndent + (needsExtraIndent ? indentUnit : '');

      e.preventDefault();
      const nextValue = value.slice(0, start) + insertion + value.slice(end);
      setCode(nextValue);
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        const pos = start + insertion.length;
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = pos;
      });
    }
  };

  const lineCount = (code || '').split('\n').length;
  const lineNumbers = Array.from({ length: Math.max(lineCount, 16) }, (_, i) => i + 1);

  const getLanguageFileName = () => {
    switch (codeLanguage) {
      case 'python': return 'main.py';
      case 'c': return 'algorithm.c';
      case 'cpp': return 'solution.cpp';
      default: return 'main.py';
    }
  };

  const isPairWorkspaceActive =
    activeChannel === 'workspace-collab-main' || activeChannel === 'study-group-cs2024';

  const visibleChatMessages = chatMessages.filter((m) => {
    if (m.senderRole === 'system') return true;
    if (isPairWorkspaceActive) {
      return m.channelId === 'workspace-collab-main' || m.channelId === 'study-group-cs2024';
    }
    return m.channelId === activeChannel;
  });

  const currentRuntimeMeta = runtimes[codeLanguage] || DEFAULT_RUNTIME_LABELS[codeLanguage];

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <Breadcrumb
        category="Academic Portal"
        items={[
          { label: 'Code Workspace' },
          { label: `${getLanguageFileName()} (${codeLanguage.toUpperCase()})` },
        ]}
      />

      {/* Main IDE Container */}
      <div
        id="code-workspace-view"
        className="h-[calc(100vh-170px)] min-h-[680px] flex flex-col rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 shadow-sm bg-slate-950"
      >
        {/* Top Workspace Toolbar */}
        <div className="bg-slate-900 px-4 py-2.5 flex items-center justify-between border-b border-slate-800 text-slate-200 gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="flex items-center gap-2 bg-slate-800 px-3 py-1.5 rounded-lg text-xs border border-slate-700">
              <Code2 className="w-4 h-4 text-indigo-400" />
              <span className="font-mono font-semibold text-white">
                {getLanguageFileName()}
              </span>
            </div>

            <select
              id="workspace-lang-select"
              value={codeLanguage}
              onChange={(e) => setCodeLanguage(e.target.value as SupportedCodeLanguage)}
              className="bg-slate-800 text-xs text-slate-200 px-3 py-1.5 rounded-lg border border-slate-700 focus:outline-hidden focus:border-indigo-500 font-medium cursor-pointer"
            >
              <option value="python">{runtimes.python?.label || 'Python 3.11'}</option>
              <option value="c">{runtimes.c?.label || 'C (GCC 12.2)'}</option>
              <option value="cpp">{runtimes.cpp?.label || 'C++17 (G++ 12.2)'}</option>
            </select>

            {currentRuntimeMeta && !currentRuntimeMeta.available && (
              <span className="text-[11px] text-amber-400 bg-amber-950/50 border border-amber-800/60 px-2.5 py-1 rounded-md font-medium">
                Compiler unavailable in container (AI Debugger ready)
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={handleCopyEditorCode}
              className="text-slate-400 hover:text-white px-2.5 py-1.5 rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
              title="Copy Editor Code"
            >
              {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span className="hidden md:inline">{copiedCode ? 'Copied' : 'Copy'}</span>
            </button>

            <button
              onClick={resetCodeToTemplate}
              className="text-slate-400 hover:text-white px-2.5 py-1.5 rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
              title="Reset to Starter Template"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Reset</span>
            </button>

            <button
              onClick={handleShareCodeToChat}
              className="text-slate-400 hover:text-white px-2.5 py-1.5 rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
              title="Share Code to Live Peer Chat"
            >
              <Share2 className="w-3.5 h-3.5" />
              <span className="hidden lg:inline">Share</span>
            </button>

            <button
              id="format-code-btn"
              onClick={formatCode}
              className="text-slate-400 hover:text-white px-2.5 py-1.5 rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
              title="Format Code"
            >
              <AlignLeft className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Format</span>
            </button>

            {/* AI Debugger Button */}
            <button
              id="ai-debugger-trigger-btn"
              onClick={() => handleTriggerAiDebugger(customDebugPrompt || undefined)}
              disabled={isAiDebugging}
              className="flex items-center gap-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg shadow-xs active:scale-98 transition-all disabled:opacity-50 cursor-pointer"
              title="Inspect & Debug with Gemini AI"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
              <span>{isAiDebugging ? 'AI Auditing...' : 'AI Debugger'}</span>
            </button>

            {/* Stop Button (visible during live execution) */}
            {interactiveSessionId && (
              <button
                id="stop-code-btn"
                onClick={stopCodeExecution}
                className="flex items-center gap-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs px-3 py-1.5 rounded-lg shadow-xs active:scale-98 transition-all cursor-pointer"
                title="Stop Running Process"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>Stop</span>
              </button>
            )}

            {/* Run Code Button */}
            <button
              id="run-code-btn"
              onClick={handleRunCode}
              disabled={isExecutingCode}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-4 py-1.5 rounded-lg shadow-xs active:scale-98 transition-all disabled:opacity-50 cursor-pointer"
              title="Compile & Execute (Ctrl+Enter)"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>{isExecutingCode ? 'Running...' : 'Run Code'}</span>
            </button>
          </div>
        </div>

        {/* Main Workspace Split View */}
        <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
          {/* Left Pane: Code Editor + Bottom Diagnostics */}
          <section className="flex-1 flex flex-col overflow-hidden border-b lg:border-b-0 lg:border-r border-slate-800">
            {/* Editor Textarea with Synchronized Line Numbers */}
            <div className="flex-1 flex overflow-hidden bg-slate-950 text-slate-200 font-mono text-xs relative">
              <div
                ref={gutterRef}
                className="w-12 py-3 pr-2 pl-2 text-slate-600 select-none text-right border-r border-slate-800 overflow-hidden font-mono text-xs shrink-0"
              >
                {lineNumbers.map((num) => {
                  const hasErr = errorLines.has(num);
                  return (
                    <span
                      key={num}
                      className={`leading-6 block pr-1 rounded-l ${
                        hasErr ? 'bg-rose-950/70 text-rose-400 font-bold' : ''
                      }`}
                    >
                      {num}
                    </span>
                  );
                })}
              </div>

              <textarea
                ref={textareaRef}
                id="live-code-textarea"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onScroll={handleEditorScroll}
                onKeyDown={handleEditorKeyDown}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                placeholder={`Write your ${codeLanguage.toUpperCase()} code here... (Tab to indent, Ctrl+Enter to run)`}
                className="flex-1 h-full bg-transparent text-slate-100 py-3 px-4 leading-6 resize-none focus:outline-hidden font-mono text-xs border-none overflow-auto caret-indigo-400"
                style={{
                  tabSize: 4,
                  whiteSpace: 'pre',
                }}
              />
            </div>

            {/* Bottom Panel: Output, Stdin, AI Diagnostic, Diagnostics */}
            <div className="h-72 bg-slate-950 border-t border-slate-800 flex flex-col">
              {/* Tab Navigation */}
              <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800 gap-2 flex-wrap">
                <div className="flex items-center gap-4 overflow-x-auto">
                  <button
                    onClick={() => setActiveConsoleTab('console')}
                    className={`text-xs font-bold pb-1 transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                      activeConsoleTab === 'console'
                        ? 'text-white border-b-2 border-indigo-500'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Terminal className="w-3.5 h-3.5" />
                    <span>Terminal Output</span>
                    {lastExecutionResult && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                          lastExecutionResult.hasError
                            ? 'bg-rose-950 text-rose-400 border border-rose-800/70'
                            : 'bg-emerald-950 text-emerald-400 border border-emerald-800/70'
                        }`}
                      >
                        {lastExecutionResult.hasError ? `Exit ${lastExecutionResult.exitCode}` : `${lastExecutionResult.executionTimeMs}ms`}
                      </span>
                    )}
                  </button>

                  <button
                    onClick={() => setActiveConsoleTab('stdin')}
                    className={`text-xs font-bold pb-1 transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                      activeConsoleTab === 'stdin'
                        ? 'text-white border-b-2 border-indigo-500'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Keyboard className="w-3.5 h-3.5" />
                    <span>Input (stdin)</span>
                    {stdinInput.trim() ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
                        Active
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                        Interactive
                      </span>
                    )}
                  </button>

                  <button
                    onClick={() => setActiveConsoleTab('ai-debugger')}
                    className={`text-xs font-bold pb-1 transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                      activeConsoleTab === 'ai-debugger'
                        ? 'text-purple-400 border-b-2 border-purple-500 font-black'
                        : 'text-slate-400 hover:text-purple-300'
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                    <span>AI Diagnostic & Fix</span>
                  </button>

                  <button
                    onClick={() => setActiveConsoleTab('problems')}
                    className={`text-xs font-bold pb-1 transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                      activeConsoleTab === 'problems'
                        ? 'text-white border-b-2 border-indigo-500'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <AlertCircle className={`w-3.5 h-3.5 ${combinedDiagnostics.length > 0 ? 'text-rose-400' : ''}`} />
                    <span>Diagnostics</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                        combinedDiagnostics.length > 0
                          ? 'bg-rose-950 text-rose-400 border border-rose-800'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {combinedDiagnostics.length}
                    </span>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {activeConsoleTab === 'ai-debugger' && (aiDebugResult || aiDebugAnalysis || aiDebugError) && (
                    <button
                      onClick={clearAiDebugResult}
                      className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Reset AI</span>
                    </button>
                  )}

                  {activeConsoleTab === 'stdin' && stdinInput && (
                    <button
                      onClick={() => setStdinInput('')}
                      className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Clear Input</span>
                    </button>
                  )}

                  {activeConsoleTab === 'console' && (
                    <button
                      onClick={clearConsole}
                      className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
                      title="Clear Terminal"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Clear</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Panel Content Stream */}
              <div
                id="console-log-stream"
                className="flex-1 p-3 font-mono text-xs overflow-y-auto space-y-1 bg-slate-950 text-slate-300"
              >
                {activeConsoleTab === 'console' && (
                  <>
                    {consoleLogs.length === 0 ? (
                      <p className="text-slate-500 italic">
                        No active logs. Click "Run Code" (or press Ctrl+Enter) to compile and execute.
                      </p>
                    ) : (
                      consoleLogs.map((log, idx) => (
                        <p
                          key={idx}
                          className={`whitespace-pre-wrap break-words ${
                            log.type === 'success'
                              ? 'text-emerald-400 font-semibold'
                              : log.type === 'error'
                              ? 'text-rose-400 font-semibold'
                              : log.type === 'info'
                              ? 'text-indigo-400'
                              : log.type === 'stdin'
                              ? 'text-cyan-300 font-semibold'
                              : 'text-slate-200'
                          }`}
                        >
                          {log.text}
                        </p>
                      ))
                    )}

                    {/* Interactive Stdin Prompt Bar while program is running without pre-filled stdin */}
                    {interactiveSessionId && (
                      <form
                        onSubmit={handleInteractiveStdinSubmit}
                        className="mt-2 pt-2.5 border-t border-slate-800/80 flex items-center gap-2 flex-wrap"
                      >
                        <span className="text-cyan-400 font-bold shrink-0">stdin &gt;</span>
                        <input
                          ref={interactiveInputRef}
                          id="interactive-stdin-input"
                          type="text"
                          disabled={interactiveEofSent}
                          value={interactiveInputValue}
                          onChange={(e) => setInteractiveInputValue(e.target.value)}
                          placeholder={
                            interactiveEofSent
                              ? 'EOF sent — waiting for process exit...'
                              : 'Type input line and press Enter (e.g. 12)...'
                          }
                          className="flex-1 min-w-[180px] bg-slate-900 border border-indigo-500/60 focus:border-indigo-400 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-hidden disabled:opacity-50"
                        />
                        <button
                          type="submit"
                          disabled={interactiveEofSent}
                          className="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-sans font-semibold text-[11px] flex items-center gap-1 cursor-pointer disabled:opacity-50"
                          title="Send line + newline to stdin"
                        >
                          <CornerDownLeft className="w-3 h-3" />
                          <span>Send</span>
                        </button>
                        <button
                          type="button"
                          onClick={sendInteractiveEof}
                          disabled={interactiveEofSent}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-sans font-semibold text-[11px] cursor-pointer disabled:opacity-50"
                          title="Send End-of-File (Ctrl+D) to stdin"
                        >
                          EOF
                        </button>
                        <button
                          type="button"
                          onClick={stopCodeExecution}
                          className="px-2.5 py-1.5 rounded-lg bg-rose-950/70 hover:bg-rose-900 border border-rose-800/70 text-rose-300 font-sans font-semibold text-[11px] cursor-pointer"
                          title="Terminate running process"
                        >
                          Stop
                        </button>
                      </form>
                    )}

                    {lastExecutionResult?.hasError && !isExecutingCode && (
                      <div className="pt-2 flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => handleTriggerAiDebugger('Diagnose and fix this compiler/runtime error.')}
                          disabled={isAiDebugging}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/35 border border-purple-500/40 text-purple-300 text-xs font-sans font-semibold transition-colors cursor-pointer"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                          <span>Diagnose &amp; Fix Error with AI Debugger</span>
                        </button>
                        {lastExecutionResult?.needsStdinHint && (
                          <button
                            onClick={() => setActiveConsoleTab('stdin')}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-indigo-300 text-xs font-sans font-semibold transition-colors cursor-pointer"
                          >
                            <Keyboard className="w-3.5 h-3.5" />
                            <span>Open Input (stdin) Tab</span>
                          </button>
                        )}
                      </div>
                    )}
                    <div ref={consoleBottomRef} />
                  </>
                )}

                {activeConsoleTab === 'stdin' && (
                  <div className="h-full flex flex-col gap-2 font-sans">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 flex-wrap">
                      <span>
                        Pre-fill standard input for <code className="text-indigo-300">input()</code>,{' '}
                        <code className="text-indigo-300">scanf()</code>, or{' '}
                        <code className="text-indigo-300">cin</code>. Leave empty to type interactively in Terminal Output.
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-slate-500">
                          {stdinInput ? `${stdinInput.split('\n').length} line(s) • ` : ''}{stdinInput.length} chars
                        </span>
                        <button
                          type="button"
                          onClick={handleRunCode}
                          disabled={isExecutingCode}
                          className="px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-[11px] flex items-center gap-1 cursor-pointer disabled:opacity-50"
                        >
                          <Play className="w-3 h-3 fill-current" />
                          <span>Run with Input</span>
                        </button>
                      </div>
                    </div>
                    <textarea
                      id="workspace-stdin-textarea"
                      value={stdinInput}
                      onChange={(e) => setStdinInput(e.target.value)}
                      placeholder={'Enter test input lines here before clicking Run Code...\nExample (two integers):\n12\n30'}
                      spellCheck={false}
                      className="flex-1 w-full bg-slate-900 border border-slate-800 focus:border-indigo-500 rounded-xl p-3 font-mono text-xs text-slate-100 placeholder:text-slate-600 resize-none focus:outline-hidden"
                    />
                  </div>
                )}

                {activeConsoleTab === 'ai-debugger' && (
                  <div className="space-y-3 font-sans">
                    {/* Prompt Box + Quick Actions */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 bg-slate-900 p-2 rounded-xl border border-slate-800">
                        <input
                          type="text"
                          placeholder="Ask Gemini: 'Fix the runtime crash', 'Optimize to O(N)', 'Add input validation'..."
                          value={customDebugPrompt}
                          onChange={(e) => setCustomDebugPrompt(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleTriggerAiDebugger(customDebugPrompt || undefined)}
                          className="flex-1 bg-transparent text-xs text-white placeholder:text-slate-500 focus:outline-hidden"
                        />
                        <button
                          onClick={() => handleTriggerAiDebugger(customDebugPrompt || undefined)}
                          disabled={isAiDebugging}
                          className="px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold flex items-center gap-1 shrink-0 cursor-pointer disabled:opacity-50"
                        >
                          <Wand2 className="w-3 h-3" />
                          <span>{isAiDebugging ? 'Analyzing...' : 'Ask AI'}</span>
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap">
                        {QUICK_AI_PROMPTS.map((preset) => (
                          <button
                            key={preset.label}
                            onClick={() => handleTriggerAiDebugger(preset.prompt)}
                            disabled={isAiDebugging}
                            className="px-2.5 py-1 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] font-medium text-slate-300 hover:text-purple-300 transition-colors cursor-pointer disabled:opacity-50"
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {isAiDebugging ? (
                      <div className="p-6 text-center space-y-2">
                        <Sparkles className="w-7 h-7 text-purple-400 animate-spin mx-auto" />
                        <p className="text-xs text-purple-300 font-semibold">
                          Inspecting {codeLanguage.toUpperCase()} source &amp; execution telemetry with Gemini AI...
                        </p>
                      </div>
                    ) : aiDebugError ? (
                      <div className="p-4 rounded-xl bg-rose-950/30 border border-rose-800/60 text-xs text-rose-200 space-y-2.5">
                        <div className="flex items-start gap-2.5">
                          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                          <div className="space-y-1">
                            <p className="font-bold text-rose-300">AI Debugger Could Not Run</p>
                            <p className="text-rose-200/90 leading-relaxed">{aiDebugError}</p>
                          </div>
                        </div>
                        <div>
                          <button
                            onClick={() => handleTriggerAiDebugger(customDebugPrompt || undefined)}
                            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-900/60 hover:bg-rose-800 text-rose-100 text-[11px] font-semibold cursor-pointer"
                          >
                            <RefreshCw className="w-3 h-3" />
                            <span>Retry Inspection</span>
                          </button>
                        </div>
                      </div>
                    ) : aiDebugAnalysis ? (
                      <div className="p-4 rounded-xl bg-slate-900/90 border border-purple-500/30 text-xs text-slate-200 space-y-3">
                        <div className="flex items-center justify-between border-b border-slate-800 pb-2 gap-2 flex-wrap">
                          <span className="text-xs font-bold text-purple-300 flex items-center gap-1.5">
                            <Bot className="w-4 h-4 text-purple-400" />
                            <span>{aiDebugAnalysis.summary}</span>
                          </span>
                          <div className="flex items-center gap-2">
                            {aiDebugAnalysis.correctedCode && (
                              <>
                                <button
                                  onClick={() => handleApplyAiFix(false)}
                                  className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                                >
                                  <ArrowRightCircle className="w-3 h-3" />
                                  <span>Apply Fix</span>
                                </button>
                                <button
                                  onClick={() => handleApplyAiFix(true)}
                                  className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                                >
                                  <Play className="w-3 h-3 fill-current" />
                                  <span>Apply &amp; Run</span>
                                </button>
                              </>
                            )}
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(aiDebugAnalysis.correctedCode || aiDebugResult || '');
                                setCopiedFix(true);
                                setTimeout(() => setCopiedFix(false), 1800);
                                showToast('Corrected code copied to clipboard');
                              }}
                              className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
                            >
                              {copiedFix ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                              <span>{copiedFix ? 'Copied' : 'Copy'}</span>
                            </button>
                          </div>
                        </div>

                        {aiDebugAnalysis.rootCause && (
                          <div className="space-y-1">
                            <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400">Root Cause</p>
                            <p className="text-slate-200 leading-relaxed">{aiDebugAnalysis.rootCause}</p>
                          </div>
                        )}

                        {aiDebugAnalysis.lineReferences.length > 0 && (
                          <div className="space-y-1.5">
                            <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400">Line Findings</p>
                            <div className="space-y-1.5">
                              {aiDebugAnalysis.lineReferences.map((ref, i) => (
                                <div key={i} className="p-2 rounded-lg bg-slate-950 border border-slate-800 flex flex-col gap-0.5">
                                  <div className="flex items-center gap-2">
                                    {ref.line && (
                                      <span className="px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 font-mono text-[10px] font-bold">
                                        Line {ref.line}
                                      </span>
                                    )}
                                    <span className="text-rose-300 font-semibold">{ref.issue}</span>
                                  </div>
                                  <p className="text-emerald-300/90 text-[11px]">Fix: {ref.fix}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {aiDebugAnalysis.steps.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400">Resolution Steps</p>
                            <ol className="list-decimal list-inside space-y-1 text-slate-300">
                              {aiDebugAnalysis.steps.map((step, i) => (
                                <li key={i}>{step}</li>
                              ))}
                            </ol>
                          </div>
                        )}

                        {aiDebugAnalysis.correctedCode && (
                          <div className="space-y-1.5">
                            <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400">Suggested Fix Preview</p>
                            <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 font-mono text-[11px] overflow-x-auto whitespace-pre">
                              {aiDebugAnalysis.correctedCode}
                            </pre>
                          </div>
                        )}

                        {(aiDebugAnalysis.complexityNotes || aiDebugAnalysis.bestPractices.length > 0) && (
                          <div className="pt-2 border-t border-slate-800 space-y-1.5 text-[11px] text-slate-400">
                            {aiDebugAnalysis.complexityNotes && (
                              <p>
                                <strong className="text-slate-300">Complexity:</strong> {aiDebugAnalysis.complexityNotes}
                              </p>
                            )}
                            {aiDebugAnalysis.bestPractices.length > 0 && (
                              <ul className="list-disc list-inside space-y-0.5">
                                {aiDebugAnalysis.bestPractices.map((bp, i) => (
                                  <li key={i}>{bp}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    ) : aiDebugResult ? (
                      <div className="p-4 rounded-xl bg-slate-900/90 border border-purple-500/30 text-xs text-slate-200 space-y-3 font-mono leading-relaxed">
                        <pre className="whitespace-pre-wrap text-slate-300 text-xs font-mono">{aiDebugResult}</pre>
                      </div>
                    ) : (
                      <div className="p-5 text-center text-slate-500 space-y-2">
                        <Bot className="w-7 h-7 mx-auto text-slate-600" />
                        <p className="text-xs font-medium">
                          Click &ldquo;AI Debugger&rdquo; above or pick a quick prompt to analyze errors, complexity, and receive a 1-click code fix.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {activeConsoleTab === 'problems' && (
                  <div className="p-2 space-y-2 font-sans text-xs">
                    {combinedDiagnostics.length === 0 ? (
                      <div className="p-3 bg-slate-900 rounded-xl border border-slate-800 flex items-center gap-3">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        <div>
                          <span className="font-bold text-slate-200">No Diagnostics Detected</span>
                          <p className="text-[11px] text-slate-400">
                            Syntax brackets are balanced{lastExecutionResult ? ' and the last run exited cleanly.' : '. Run code to verify compiler/runtime checks.'}
                          </p>
                        </div>
                      </div>
                    ) : (
                      combinedDiagnostics.map((diag, idx) => (
                        <div
                          key={idx}
                          className={`p-3 rounded-xl border flex items-start justify-between gap-3 ${
                            diag.severity === 'error'
                              ? 'bg-rose-950/30 border-rose-800/60'
                              : 'bg-amber-950/25 border-amber-800/50'
                          }`}
                        >
                          <div className="flex items-start gap-2.5">
                            <AlertCircle
                              className={`w-4 h-4 shrink-0 mt-0.5 ${
                                diag.severity === 'error' ? 'text-rose-400' : 'text-amber-400'
                              }`}
                            />
                            <div>
                              <div className="flex items-center gap-2">
                                {diag.line && (
                                  <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-900 text-slate-200 border border-slate-700">
                                    Line {diag.line}
                                    {diag.column ? `:${diag.column}` : ''}
                                  </span>
                                )}
                                <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                                  {diag.source}
                                </span>
                              </div>
                              <p className="font-mono text-xs text-slate-200 mt-1 break-words">
                                {diag.message}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Right Pane: Live Collaborative Chat */}
          <section
            id="collab-chat-panel"
            className="w-full lg:w-96 flex flex-col bg-slate-900 border-t lg:border-t-0 border-slate-800"
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/90">
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
                  <Users2 className="w-4 h-4 text-indigo-400" />
                  <span>Peer Study Collaboration</span>
                </h2>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[10px] text-emerald-400 font-bold">ONLINE</span>
                </div>
              </div>

              {/* Room Selector */}
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                <button
                  id="workspace-collab-btn"
                  onClick={() => setActiveChannel('workspace-collab-main')}
                  className={`whitespace-nowrap px-3 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                    isPairWorkspaceActive
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  Live Pair Workspace
                </button>
                <button
                  id="channel-mentor-btn"
                  onClick={() => setActiveChannel('mentor-dr-chen')}
                  className={`whitespace-nowrap px-3 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                    activeChannel === 'mentor-dr-chen'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  Faculty Mentor
                </button>
              </div>
            </div>

            {/* Messages Stream */}
            <div
              id="chat-messages-container"
              className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 bg-slate-950/40"
            >
              {visibleChatMessages.map((msg) => {
                if (msg.senderRole === 'system') {
                  return (
                    <div key={msg.id} className="flex items-center justify-center my-1">
                      <span className="bg-indigo-950/80 text-indigo-300 px-3 py-1 rounded-md text-[10px] font-semibold flex items-center gap-1.5 border border-indigo-800">
                        <Sparkles className="w-3 h-3 text-indigo-400" />
                        {msg.text}
                      </span>
                    </div>
                  );
                }

                return (
                  <div
                    key={msg.id}
                    className={`flex gap-2.5 ${msg.isCurrentUser ? 'flex-row-reverse' : ''}`}
                  >
                    <img
                      src={
                        msg.senderAvatar ||
                        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=200'
                      }
                      alt={msg.senderName}
                      className="w-7 h-7 rounded-full object-cover shrink-0 mt-0.5 border border-indigo-500"
                    />

                    <div
                      className={`flex flex-col max-w-[82%] ${
                        msg.isCurrentUser ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div className="flex items-baseline gap-1.5 mb-1">
                        <span className="text-[11px] font-bold text-white">
                          {msg.senderName}
                        </span>
                        <span className="text-[9px] text-slate-400">{msg.timestamp}</span>
                      </div>

                      <div
                        className={`p-3 rounded-xl text-xs leading-relaxed ${
                          msg.isCurrentUser
                            ? 'bg-indigo-600 text-white shadow-xs'
                            : 'bg-slate-800 text-slate-100 border border-slate-700 shadow-xs'
                        }`}
                      >
                        <p className="whitespace-pre-wrap">{msg.text}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={chatBottomRef} />
            </div>

            {/* Chat Composer */}
            <form
              onSubmit={handleSendMessage}
              className="p-3 border-t border-slate-800 bg-slate-900 flex items-center gap-2"
            >
              <input
                id="collab-chat-input"
                type="text"
                placeholder="Ask faculty or discuss with classmates..."
                value={chatInputText}
                onChange={(e) => setChatInputText(e.target.value)}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-400 focus:outline-hidden focus:border-indigo-500"
              />
              <button
                id="collab-send-btn"
                type="submit"
                className="p-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl transition-colors active:scale-95 shrink-0 cursor-pointer"
                title="Send Message"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
};
