import dotenv from 'dotenv';
dotenv.config({ override: true });

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { exec, spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { setupMeetingsRoutes } from './server/meetings';

const execPromise = promisify(exec);
const JWT_SECRET = process.env.JWT_SECRET || 'eduhub-secure-jwt-secret-key-2026';

const MAX_CODE_BYTES = 256 * 1024;
const MAX_STDIN_BYTES = 256 * 1024;
const MAX_ACTIVE_CODE_SESSIONS = 15;

let cachedHasStdbuf: boolean | null = null;
async function checkHasStdbuf(): Promise<boolean> {
  if (cachedHasStdbuf !== null) return cachedHasStdbuf;
  cachedHasStdbuf = await hasBinary('stdbuf');
  return cachedHasStdbuf;
}

function getVirtualFilename(language: string): string {
  if (language === 'c') return 'algorithm.c';
  if (language === 'cpp') return 'solution.cpp';
  return 'main.py';
}

function sanitizeCompilerStderr(stderr: string, actualPath: string, language: string): string {
  if (!stderr) return '';
  const virtualName = getVirtualFilename(language);
  const escaped = actualPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return stderr.replace(new RegExp(escaped, 'g'), virtualName);
}

function normalizeBatchStdin(raw: unknown): string {
  const str = (typeof raw === 'string' ? raw : String(raw ?? '')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (str.length === 0) return '';
  return str.endsWith('\n') ? str : `${str}\n`;
}

function isRepeatedInvalidInputFlood(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 40) return false;
  const tail = lines.slice(-20);
  const uniqueTail = new Set(tail);
  return uniqueTail.size <= 2;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  loopTerminated?: boolean;
}

function spawnWithStdin(
  command: string,
  args: string[],
  options: {
    stdin?: string;
    timeoutMs?: number;
    maxBufferBytes?: number;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<SpawnResult> {
  const { stdin = '', timeoutMs = 8000, maxBufferBytes = 512 * 1024, env } = options;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let timedOut = false;
    let truncated = false;
    let loopTerminated = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timeoutNote = timedOut
        ? `\nExecution timed out after ${Math.round(timeoutMs / 1000)}s (check for infinite loops or missing stdin).`
        : '';
      const loopNote = loopTerminated
        ? '\nExecution stopped: repeated output detected after stdin reached EOF.'
        : '';
      const truncNote = truncated ? '\n[Output truncated at 512KB limit]' : '';
      resolve({
        stdout,
        stderr: `${stderr}${timeoutNote}${loopNote}${truncNote}`.trim(),
        exitCode: timedOut ? 124 : loopTerminated ? 1 : code ?? 1,
        timedOut,
        loopTerminated,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (totalBytes >= maxBufferBytes) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      const slice = chunk.toString('utf8');
      totalBytes += chunk.length;
      stdout += slice;
      if (totalBytes > 4096 && isRepeatedInvalidInputFlood(stdout)) {
        loopTerminated = true;
        child.kill('SIGKILL');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (totalBytes >= maxBufferBytes) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      const slice = chunk.toString('utf8');
      totalBytes += chunk.length;
      stderr += slice;
    });

    child.stdin.on('error', () => {
      // Ignore EPIPE if process exits before consuming all stdin
    });

    child.on('error', (err) => {
      stderr += (stderr ? '\n' : '') + err.message;
      finish(1);
    });

    child.on('close', (code) => {
      finish(code);
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

async function hasBinary(cmd: string): Promise<boolean> {
  try {
    await execPromise(`which ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

interface ParsedDiagnostic {
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

function parseCompilerDiagnostics(stderr: string, language: string): ParsedDiagnostic[] {
  if (!stderr || !stderr.trim()) return [];
  const diagnostics: ParsedDiagnostic[] = [];
  const lines = stderr.split('\n');

  if (language === 'c' || language === 'cpp') {
    for (const line of lines) {
      const m = line.match(/:(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/i);
      if (m) {
        const sevRaw = m[3].toLowerCase();
        diagnostics.push({
          line: parseInt(m[1], 10),
          column: parseInt(m[2], 10),
          severity: sevRaw.includes('warning') ? 'warning' : sevRaw === 'note' ? 'info' : 'error',
          message: m[4].trim(),
          source: language === 'cpp' ? 'g++' : 'gcc',
        });
      }
    }
  } else if (language === 'python') {
    let lastLineNum: number | undefined;
    for (const line of lines) {
      const lm = line.match(/File ".*?", line (\d+)/);
      if (lm) lastLineNum = parseInt(lm[1], 10);
      const em = line.match(/^([A-Za-z]+Error|Exception|SyntaxError|IndentationError|NameError|TypeError|ValueError|ZeroDivisionError|IndexError|KeyError):\s*(.*)$/);
      if (em) {
        diagnostics.push({
          line: lastLineNum,
          severity: 'error',
          message: `${em[1]}: ${em[2]}`.trim(),
          source: 'python3',
        });
      }
    }
  }

  if (diagnostics.length === 0 && stderr.trim()) {
    diagnostics.push({
      severity: 'error',
      message: stderr.trim().split('\n').slice(0, 4).join(' | '),
      source: language,
    });
  }

  return diagnostics;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use((req, _res, next) => {
    const cookieHeader = req.headers.cookie;
    const cookies: Record<string, string> = {};
    if (cookieHeader) {
      cookieHeader.split(';').forEach((part) => {
        const idx = part.indexOf('=');
        if (idx > 0) {
          const key = part.slice(0, idx).trim();
          const val = part.slice(idx + 1).trim();
          try {
            cookies[key] = decodeURIComponent(val);
          } catch {
            cookies[key] = val;
          }
        }
      });
    }
    (req as any).cookies = cookies;
    next();
  });

  // In-memory data store for server-side API sync
  let projectCredits = {
    hod: {
      name: 'Dr. Ramesh Kulkarni',
      designation: 'Head of Department',
      department: 'Computer Science & Engineering',
      email: 'hod.cse@eduhub.edu',
      cabin: 'Room 304, Academic Block A',
      qualifications: 'Ph.D. in Distributed Systems & AI, IIT Bombay',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=200',
      message: 'Empowering students to build scalable software, foster cross-cohort mentorship, and innovate academic technology for our campus community.',
    },
    facultyGuides: [
      {
        id: 'fac-guide-1',
        name: 'Prof. Ananya Sen',
        designation: 'Associate Professor',
        department: 'Computer Science & Engineering',
        email: 'ananya.sen@eduhub.edu',
        roleInProject: 'Technical Advisor & Architecture Mentor',
        avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&q=80&w=200',
      },
      {
        id: 'fac-guide-2',
        name: 'Dr. Vikramaditya Rao',
        designation: 'Assistant Professor',
        department: 'Information Technology',
        email: 'v.rao@eduhub.edu',
        roleInProject: 'Database & Cloud Security Supervisor',
        avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=200',
      },
    ],
    studentContributors: [
      {
        id: 'student-contrib-1',
        name: 'Aarav Sharma',
        rollNo: 'BT24CS042',
        branch: 'Computer Science',
        year: '3rd Year',
        role: 'Lead Full-Stack Developer & Cloud Architect',
        avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200',
        contributions: 'Engineered Node.js + Express backend, Firestore synchronization, and real-time Socket.IO WhatsApp group chats.',
        techStack: ['Node.js', 'Express', 'Socket.IO', 'Firebase', 'React 19', 'TypeScript'],
        githubUrl: 'https://github.com/aaravsharma',
        linkedinUrl: 'https://linkedin.com/in/aaravsharma',
      },
      {
        id: 'student-contrib-2',
        name: 'Rohan Gupta',
        rollNo: 'BT24CS078',
        branch: 'Computer Science',
        year: '3rd Year',
        role: 'UI/UX & Frontend Engineer',
        avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&q=80&w=200',
        contributions: 'Designed responsive mobile-first UI with Tailwind CSS, Lucide icons, dark mode, and interactive code playgrounds.',
        techStack: ['React', 'Tailwind CSS', 'Motion', 'Canvas Confetti'],
        githubUrl: 'https://github.com/rohangupta',
      },
      {
        id: 'student-contrib-3',
        name: 'Sneha Roy',
        rollNo: 'BT24CS103',
        branch: 'Information Technology',
        year: '3rd Year',
        role: 'Database & API Integration Specialist',
        avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=200',
        contributions: 'Modeled Firestore schema rules, JWT authorization pipeline, and client-side real-time data observers.',
        techStack: ['Firestore', 'JWT', 'REST APIs', 'Postman'],
        linkedinUrl: 'https://linkedin.com/in/sneharoy',
      },
    ],
    updatedAt: new Date().toISOString(),
  };

  // REST API Endpoints FIRST
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'online',
      timestamp: new Date().toISOString(),
      service: 'EduHub Full-Stack Server',
      database: 'Cloud Firestore Connected',
      realtime: 'Socket.IO Active',
    });
  });

  // Available Language Runtimes Probe (Python, C, C++)
  app.get('/api/code-runtimes', async (_req, res) => {
    const [python, gcc, gpp] = await Promise.all([
      hasBinary('python3'),
      hasBinary('gcc'),
      hasBinary('g++'),
    ]);

    res.json({
      success: true,
      runtimes: {
        python: { available: python, label: 'Python 3.11' },
        c: { available: gcc, label: 'C (GCC 12.2)' },
        cpp: { available: gpp, label: 'C++17 (G++ 12.2)' },
      },
    });
  });

  // Real-Time Compiler & Batch Code Execution Engine
  app.post('/api/execute-code', async (req, res) => {
    const startTime = Date.now();
    const { code, language, stdin = '' } = req.body || {};

    if (code === undefined || code === null || typeof code !== 'string') {
      return res.status(400).json({
        success: false,
        hasError: true,
        stdout: '',
        stderr: 'Error: No code provided to compiler.',
        output: 'Error: No code provided to compiler.',
        exitCode: 1,
        executionTimeMs: 0,
        diagnostics: [{ severity: 'error', message: 'No code provided to compiler.', source: 'compiler' }],
      });
    }

    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      return res.status(413).json({
        success: false,
        hasError: true,
        stdout: '',
        stderr: 'Error: Source code exceeds 256 KB limit.',
        output: 'Error: Source code exceeds 256 KB limit.',
        exitCode: 1,
        executionTimeMs: 0,
        diagnostics: [{ severity: 'error', message: 'Source code exceeds 256 KB limit.', source: 'compiler' }],
      });
    }

    const cleanLang = String(language || 'python').toLowerCase();
    if (!['python', 'c', 'cpp'].includes(cleanLang)) {
      const errMsg = `Unsupported compiler: ${cleanLang}. Supported compilers are Python, C, and C++.`;
      return res.status(400).json({
        success: false,
        hasError: true,
        stdout: '',
        stderr: errMsg,
        output: errMsg,
        exitCode: 1,
        executionTimeMs: 0,
        language: cleanLang,
        diagnostics: [{ severity: 'error', message: errMsg, source: 'compiler' }],
      });
    }

    const stdinText = normalizeBatchStdin(stdin);
    if (Buffer.byteLength(stdinText, 'utf8') > MAX_STDIN_BYTES) {
      return res.status(413).json({
        success: false,
        hasError: true,
        stdout: '',
        stderr: 'Error: Standard input exceeds 256 KB limit.',
        output: 'Error: Standard input exceeds 256 KB limit.',
        exitCode: 1,
        executionTimeMs: 0,
        language: cleanLang,
        diagnostics: [{ severity: 'error', message: 'Standard input exceeds 256 KB limit.', source: 'stdin' }],
      });
    }

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const tmpDir = os.tmpdir();
    const useStdbuf = await checkHasStdbuf();

    try {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      if (cleanLang === 'python') {
        const filePath = path.join(tmpDir, `eduhub_${id}.py`);
        await fs.promises.writeFile(filePath, code, 'utf8');
        try {
          const result = await spawnWithStdin('python3', ['-u', filePath], {
            stdin: stdinText,
            timeoutMs: 8000,
          });
          stdout = result.stdout;
          stderr = sanitizeCompilerStderr(result.stderr, filePath, cleanLang);
          exitCode = result.exitCode;
        } finally {
          await fs.promises.unlink(filePath).catch(() => {});
        }
      } else if (cleanLang === 'c') {
        const srcPath = path.join(tmpDir, `eduhub_${id}.c`);
        const binPath = path.join(tmpDir, `eduhub_${id}.out`);
        await fs.promises.writeFile(srcPath, code, 'utf8');
        try {
          const compileRes = await spawnWithStdin('gcc', ['-O2', '-Wall', srcPath, '-o', binPath, '-lm'], {
            timeoutMs: 8000,
          });
          if (compileRes.exitCode !== 0) {
            stdout = compileRes.stdout;
            stderr = sanitizeCompilerStderr(compileRes.stderr || 'C compilation failed.', srcPath, cleanLang);
            exitCode = compileRes.exitCode;
          } else {
            const runCmd = useStdbuf ? 'stdbuf' : binPath;
            const runArgs = useStdbuf ? ['-o0', '-e0', binPath] : [];
            const runRes = await spawnWithStdin(runCmd, runArgs, {
              stdin: stdinText,
              timeoutMs: 8000,
            });
            stdout = runRes.stdout;
            const cleanCompileWarn = sanitizeCompilerStderr(compileRes.stderr, srcPath, cleanLang);
            stderr = [cleanCompileWarn, runRes.stderr].filter(Boolean).join('\n');
            exitCode = runRes.exitCode;
          }
        } finally {
          await Promise.all([
            fs.promises.unlink(srcPath).catch(() => {}),
            fs.promises.unlink(binPath).catch(() => {}),
          ]);
        }
      } else {
        const srcPath = path.join(tmpDir, `eduhub_${id}.cpp`);
        const binPath = path.join(tmpDir, `eduhub_${id}.out`);
        await fs.promises.writeFile(srcPath, code, 'utf8');
        try {
          const compileRes = await spawnWithStdin(
            'g++',
            ['-O2', '-Wall', '-std=c++17', srcPath, '-o', binPath, '-lm'],
            { timeoutMs: 8000 }
          );
          if (compileRes.exitCode !== 0) {
            stdout = compileRes.stdout;
            stderr = sanitizeCompilerStderr(compileRes.stderr || 'C++ compilation failed.', srcPath, cleanLang);
            exitCode = compileRes.exitCode;
          } else {
            const runCmd = useStdbuf ? 'stdbuf' : binPath;
            const runArgs = useStdbuf ? ['-o0', '-e0', binPath] : [];
            const runRes = await spawnWithStdin(runCmd, runArgs, {
              stdin: stdinText,
              timeoutMs: 8000,
            });
            stdout = runRes.stdout;
            const cleanCompileWarn = sanitizeCompilerStderr(compileRes.stderr, srcPath, cleanLang);
            stderr = [cleanCompileWarn, runRes.stderr].filter(Boolean).join('\n');
            exitCode = runRes.exitCode;
          }
        } finally {
          await Promise.all([
            fs.promises.unlink(srcPath).catch(() => {}),
            fs.promises.unlink(binPath).catch(() => {}),
          ]);
        }
      }

      const hasError = exitCode !== 0;
      const cleanStdout = stdout.trimEnd();
      const cleanStderr = stderr.trim();
      const combinedOutput =
        [cleanStdout, cleanStderr ? (cleanStdout ? `\n[STDERR]\n${cleanStderr}` : cleanStderr) : '']
          .filter(Boolean)
          .join('') || '(Process completed with empty output)';

      const diagnostics = parseCompilerDiagnostics(cleanStderr, cleanLang);
      const executionTimeMs = Date.now() - startTime;

      const combinedLower = `${cleanStdout}\n${cleanStderr}`.toLowerCase();
      let needsStdinHint: string | undefined;
      if (hasError && (combinedLower.includes('eoferror') || combinedLower.includes('invalid input') || combinedLower.includes('eof'))) {
        needsStdinHint = stdinText.length === 0
          ? 'Standard input (stdin) was empty. Clear Input (stdin) to run interactively, or enter all required input lines in the Input (stdin) tab.'
          : 'Program reached end-of-input (EOF) or received invalid input format. Verify every prompt has a matching value in Input (stdin).';
      }

      return res.json({
        success: !hasError,
        hasError,
        stdout: cleanStdout,
        stderr: cleanStderr,
        output: combinedOutput,
        exitCode,
        executionTimeMs,
        language: cleanLang,
        diagnostics,
        needsStdinHint,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        hasError: true,
        stdout: '',
        stderr: err.message || 'Internal execution failure',
        output: err.message || 'Internal execution failure',
        exitCode: 1,
        executionTimeMs: Date.now() - startTime,
        language: cleanLang,
        diagnostics: [{ severity: 'error', message: err.message || 'Internal execution failure', source: cleanLang }],
      });
    }
  });

  // Interactive Streaming Code Execution Sessions (Supports live stdin for cin/scanf/input)
  interface InteractiveSessionEvent {
    type: 'stdout' | 'stderr' | 'exit';
    data?: string;
    exitCode?: number;
    executionTimeMs?: number;
    hasError?: boolean;
    reason?: string;
  }

  interface InteractiveCodeSession {
    id: string;
    language: 'python' | 'c' | 'cpp';
    child: ChildProcessWithoutNullStreams;
    tempFiles: string[];
    events: InteractiveSessionEvent[];
    subscribers: Set<express.Response>;
    stdoutAll: string;
    stderrAll: string;
    totalBytes: number;
    startedAt: number;
    compileWarnings: string;
    eofSent: boolean;
    closed: boolean;
    idleTimer: NodeJS.Timeout | null;
    maxTimer: NodeJS.Timeout | null;
    cleanupTimer: NodeJS.Timeout | null;
  }

  const interactiveSessions = new Map<string, InteractiveCodeSession>();
  const SESSION_ID_PATTERN = /^[a-f0-9]{16,32}$/;

  const cleanupSessionFiles = async (files: string[]) => {
    await Promise.all(files.map((f) => fs.promises.unlink(f).catch(() => {})));
  };

  const emitSessionEvent = (session: InteractiveCodeSession, evt: InteractiveSessionEvent) => {
    session.events.push(evt);
    const payload = `data: ${JSON.stringify(evt)}\n\n`;
    session.subscribers.forEach((clientRes) => {
      try {
        clientRes.write(payload);
        if (evt.type === 'exit') {
          clientRes.end();
        }
      } catch {
        session.subscribers.delete(clientRes);
      }
    });
    if (evt.type === 'exit') {
      session.subscribers.clear();
    }
  };

  const terminateInteractiveSession = (session: InteractiveCodeSession, reason?: string) => {
    if (session.closed) return;
    if (reason) {
      session.stderrAll += (session.stderrAll ? '\n' : '') + reason;
      emitSessionEvent(session, { type: 'stderr', data: `${reason}\n` });
    }
    try {
      session.child.kill('SIGTERM');
      setTimeout(() => {
        if (!session.closed) {
          try {
            session.child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 250);
    } catch {
      // ignore
    }
  };

  const resetSessionIdleTimer = (session: InteractiveCodeSession) => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      terminateInteractiveSession(
        session,
        'Execution stopped after 25s of inactivity waiting for stdin (enter input in the terminal prompt or use the Input (stdin) tab).'
      );
    }, 25000);
  };

  app.post('/api/code-sessions/start', async (req, res) => {
    const startTime = Date.now();
    const { code, language, initialStdin = '', closeStdinAfterInitial = false } = req.body || {};

    if (code === undefined || code === null || typeof code !== 'string') {
      return res.status(400).json({
        success: false,
        status: 'error',
        error: 'No code provided to compiler.',
        diagnostics: [{ severity: 'error', message: 'No code provided to compiler.', source: 'compiler' }],
      });
    }

    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      return res.status(413).json({
        success: false,
        status: 'error',
        error: 'Source code exceeds 256 KB limit.',
        diagnostics: [{ severity: 'error', message: 'Source code exceeds 256 KB limit.', source: 'compiler' }],
      });
    }

    const cleanLang = String(language || 'python').toLowerCase();
    if (cleanLang !== 'python' && cleanLang !== 'c' && cleanLang !== 'cpp') {
      return res.status(400).json({
        success: false,
        status: 'error',
        error: `Unsupported compiler: ${cleanLang}. Supported compilers are Python, C, and C++.`,
        diagnostics: [{ severity: 'error', message: `Unsupported compiler: ${cleanLang}`, source: 'compiler' }],
      });
    }

    // Reclaim oldest finished/active sessions if cap reached
    if (interactiveSessions.size >= MAX_ACTIVE_CODE_SESSIONS) {
      for (const [sid, s] of interactiveSessions.entries()) {
        if (s.closed) {
          interactiveSessions.delete(sid);
        }
      }
      if (interactiveSessions.size >= MAX_ACTIVE_CODE_SESSIONS) {
        const oldestKey = interactiveSessions.keys().next().value;
        if (oldestKey) {
          const oldest = interactiveSessions.get(oldestKey);
          if (oldest) terminateInteractiveSession(oldest, 'Closed oldest idle session due to concurrency limit.');
          interactiveSessions.delete(oldestKey);
        }
      }
    }

    const sessionId = crypto.randomBytes(12).toString('hex');
    const tmpDir = os.tmpdir();
    const tempFiles: string[] = [];
    const useStdbuf = await checkHasStdbuf();

    let runCommand = '';
    let runArgs: string[] = [];
    let compileWarnings = '';

    try {
      if (cleanLang === 'python') {
        const srcPath = path.join(tmpDir, `eduhub_${sessionId}.py`);
        tempFiles.push(srcPath);
        await fs.promises.writeFile(srcPath, code, 'utf8');
        runCommand = 'python3';
        runArgs = ['-u', srcPath];
      } else {
        const ext = cleanLang === 'cpp' ? 'cpp' : 'c';
        const compiler = cleanLang === 'cpp' ? 'g++' : 'gcc';
        const compilerArgsBase = cleanLang === 'cpp' ? ['-O2', '-Wall', '-std=c++17'] : ['-O2', '-Wall'];
        const srcPath = path.join(tmpDir, `eduhub_${sessionId}.${ext}`);
        const binPath = path.join(tmpDir, `eduhub_${sessionId}.out`);
        tempFiles.push(srcPath, binPath);
        await fs.promises.writeFile(srcPath, code, 'utf8');

        const compileRes = await spawnWithStdin(compiler, [...compilerArgsBase, srcPath, '-o', binPath, '-lm'], {
          timeoutMs: 8000,
        });
        const cleanCompileStderr = sanitizeCompilerStderr(compileRes.stderr, srcPath, cleanLang).trim();

        if (compileRes.exitCode !== 0) {
          await cleanupSessionFiles(tempFiles);
          return res.json({
            success: false,
            status: 'compile_error',
            hasError: true,
            stdout: compileRes.stdout.trimEnd(),
            stderr: cleanCompileStderr || `${cleanLang.toUpperCase()} compilation failed.`,
            output: cleanCompileStderr || `${cleanLang.toUpperCase()} compilation failed.`,
            exitCode: compileRes.exitCode,
            executionTimeMs: Date.now() - startTime,
            language: cleanLang,
            diagnostics: parseCompilerDiagnostics(cleanCompileStderr, cleanLang),
          });
        }

        compileWarnings = cleanCompileStderr;
        runCommand = useStdbuf ? 'stdbuf' : binPath;
        runArgs = useStdbuf ? ['-o0', '-e0', binPath] : [];
      }

      const child = spawn(runCommand, runArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });

      const session: InteractiveCodeSession = {
        id: sessionId,
        language: cleanLang,
        child,
        tempFiles,
        events: [],
        subscribers: new Set(),
        stdoutAll: '',
        stderrAll: compileWarnings ? `${compileWarnings}\n` : '',
        totalBytes: 0,
        startedAt: Date.now(),
        compileWarnings,
        eofSent: false,
        closed: false,
        idleTimer: null,
        maxTimer: null,
        cleanupTimer: null,
      };

      if (compileWarnings) {
        emitSessionEvent(session, { type: 'stderr', data: `${compileWarnings}\n` });
      }

      interactiveSessions.set(sessionId, session);
      resetSessionIdleTimer(session);

      session.maxTimer = setTimeout(() => {
        terminateInteractiveSession(session, 'Execution reached 45s maximum session limit.');
      }, 45000);

      child.stdout.on('data', (chunk: Buffer) => {
        if (session.closed) return;
        session.totalBytes += chunk.length;
        if (session.totalBytes > 512 * 1024) {
          terminateInteractiveSession(session, '[Output truncated at 512KB limit]');
          return;
        }
        const text = chunk.toString('utf8');
        session.stdoutAll += text;
        if (session.eofSent && session.totalBytes > 4096 && isRepeatedInvalidInputFlood(session.stdoutAll)) {
          terminateInteractiveSession(session, 'Stopped infinite loop reading from closed stdin (EOF).');
          return;
        }
        resetSessionIdleTimer(session);
        emitSessionEvent(session, { type: 'stdout', data: text });
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (session.closed) return;
        session.totalBytes += chunk.length;
        if (session.totalBytes > 512 * 1024) {
          terminateInteractiveSession(session, '[Output truncated at 512KB limit]');
          return;
        }
        const rawText = chunk.toString('utf8');
        const cleaned = sanitizeCompilerStderr(rawText, tempFiles[0] || '', cleanLang);
        session.stderrAll += cleaned;
        resetSessionIdleTimer(session);
        emitSessionEvent(session, { type: 'stderr', data: cleaned });
      });

      child.stdin.on('error', () => {
        // Ignore EPIPE when process closes early
      });

      child.on('error', (err) => {
        if (session.closed) return;
        session.stderrAll += (session.stderrAll ? '\n' : '') + err.message;
        emitSessionEvent(session, { type: 'stderr', data: `${err.message}\n` });
      });

      child.on('close', async (code) => {
        if (session.closed) return;
        session.closed = true;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        if (session.maxTimer) clearTimeout(session.maxTimer);

        const exitCode = code ?? 1;
        const executionTimeMs = Date.now() - session.startedAt;
        emitSessionEvent(session, {
          type: 'exit',
          exitCode,
          executionTimeMs,
          hasError: exitCode !== 0,
        });

        await cleanupSessionFiles(session.tempFiles);
        session.cleanupTimer = setTimeout(() => {
          interactiveSessions.delete(sessionId);
        }, 60000);
      });

      const normalizedInitial = normalizeBatchStdin(initialStdin);
      if (normalizedInitial) {
        child.stdin.write(normalizedInitial);
      }
      if (closeStdinAfterInitial) {
        session.eofSent = true;
        child.stdin.end();
      }

      return res.json({
        success: true,
        status: 'started',
        sessionId,
        language: cleanLang,
      });
    } catch (err: any) {
      await cleanupSessionFiles(tempFiles);
      return res.status(500).json({
        success: false,
        status: 'error',
        error: err?.message || 'Failed to start execution session.',
      });
    }
  });

  app.get('/api/code-sessions/:id/stream', (req, res) => {
    const { id } = req.params;
    if (!SESSION_ID_PATTERN.test(id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID.' });
    }
    const session = interactiveSessions.get(id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Execution session not found or expired.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Replay buffered events so fast processes or early prompts are never lost
    for (const evt of session.events) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }

    if (session.closed) {
      res.end();
      return;
    }

    session.subscribers.add(res);
    req.on('close', () => {
      session.subscribers.delete(res);
    });
  });

  app.post('/api/code-sessions/:id/stdin', (req, res) => {
    const { id } = req.params;
    if (!SESSION_ID_PATTERN.test(id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID.' });
    }
    const session = interactiveSessions.get(id);
    if (!session || session.closed) {
      return res.status(404).json({ success: false, error: 'Execution session has already ended.' });
    }
    if (session.eofSent) {
      return res.status(400).json({ success: false, error: 'Standard input (EOF) has already been closed for this session.' });
    }

    const { input = '', appendNewline = true } = req.body || {};
    const text = (typeof input === 'string' ? input : String(input ?? '')).replace(/\r\n/g, '\n');
    if (Buffer.byteLength(text, 'utf8') > MAX_STDIN_BYTES) {
      return res.status(413).json({ success: false, error: 'Input chunk exceeds limit.' });
    }

    const payload = appendNewline && !text.endsWith('\n') ? `${text}\n` : text;
    try {
      session.child.stdin.write(payload);
      resetSessionIdleTimer(session);
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Failed to write to stdin.' });
    }
  });

  app.post('/api/code-sessions/:id/eof', (req, res) => {
    const { id } = req.params;
    if (!SESSION_ID_PATTERN.test(id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID.' });
    }
    const session = interactiveSessions.get(id);
    if (!session || session.closed) {
      return res.json({ success: true, alreadyClosed: true });
    }
    session.eofSent = true;
    try {
      session.child.stdin.end();
    } catch {
      // ignore
    }
    return res.json({ success: true });
  });

  app.post('/api/code-sessions/:id/stop', (req, res) => {
    const { id } = req.params;
    if (!SESSION_ID_PATTERN.test(id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID.' });
    }
    const session = interactiveSessions.get(id);
    if (!session || session.closed) {
      return res.json({ success: true, alreadyClosed: true });
    }
    terminateInteractiveSession(session, 'Process stopped by user.');
    return res.json({ success: true });
  });

  // AI Code Debugger powered by Gemini API (@google/genai)
  app.post('/api/debug-code', async (req, res) => {
    const { code, language, errorOutput, stdoutOutput, stdinInput, customPrompt } = req.body || {};

    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({
        success: false,
        errorCode: 'EMPTY_CODE',
        error: 'Please write or paste some code in the editor before running the AI Debugger.',
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        errorCode: 'MISSING_API_KEY',
        error:
          'Gemini API key is not configured on the server. Add GEMINI_API_KEY in the Settings > Secrets panel to run the AI Debugger.',
      });
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: 22000,
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const targetLang = String(language || 'python').toUpperCase();
    const prompt = `Analyze the following ${targetLang} code and provide a concrete debugging audit and drop-in fixed code.

Source Code (${targetLang}):
\`\`\`${language || 'text'}
${code}
\`\`\`

Compiler / Runtime Errors (stderr):
${errorOutput ? errorOutput : 'None reported.'}

Program Output (stdout):
${stdoutOutput ? stdoutOutput : 'None recorded.'}

Standard Input (stdin):
${stdinInput ? stdinInput : 'None provided.'}

User Request:
${customPrompt ? customPrompt : 'Find any syntax bugs, logical flaws, edge-case crashes, or performance bottlenecks, explain the root cause clearly, and provide complete runnable corrected code.'}`;

    let modelUsed = 'gemini-4-hydrogen';

    const generateWithRetry = async (modelName = 'gemini-4-hydrogen', attempt = 0) => {
      try {
        modelUsed = modelName;
        return await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            systemInstruction:
              'You are a Principal Software Engineer and Compilers Mentor. Return concise, accurate debugging analysis and complete, directly runnable corrected code in the exact requested language with no markdown fences inside correctedCode.',
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.LOW,
            },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: {
                  type: Type.STRING,
                  description: 'One-sentence diagnosis or optimization headline.',
                },
                rootCause: {
                  type: Type.STRING,
                  description: 'Clear technical explanation of the root cause, bug, or improvement opportunity.',
                },
                lineReferences: {
                  type: Type.ARRAY,
                  description: 'Specific lines with issues or improvement suggestions.',
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      line: { type: Type.INTEGER, description: '1-based line number if applicable.' },
                      issue: { type: Type.STRING, description: 'What is wrong or suboptimal on this line.' },
                      fix: { type: Type.STRING, description: 'Exact change needed.' },
                    },
                  },
                },
                steps: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Ordered step-by-step walkthrough of how the fix resolves the problem.',
                },
                correctedCode: {
                  type: Type.STRING,
                  description: 'Complete, drop-in runnable source code in the target language without markdown backticks.',
                },
                bestPractices: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Actionable best practices, edge-case guards, or safety tips.',
                },
                complexityNotes: {
                  type: Type.STRING,
                  description: 'Time and space complexity assessment.',
                },
              },
              required: ['summary', 'rootCause', 'lineReferences', 'steps', 'correctedCode', 'bestPractices', 'complexityNotes'],
            },
          },
        });
      } catch (err: any) {
        const status = Number(err?.status || err?.code || 0);
        const rawMsg = String(err?.message || '');
        const isTransient =
          status === 500 ||
          status === 503 ||
          status === 504 ||
          status === 429 ||
          rawMsg.includes('"code":503') ||
          rawMsg.includes('UNAVAILABLE') ||
          rawMsg.includes('timeout') ||
          rawMsg.includes('aborted') ||
          !status;
        if (attempt === 0 && isTransient) {
          return generateWithRetry('gemini-3.1-flash-lite', 1);
        }
        throw err;
      }
    };

    try {
      const response = await generateWithRetry();
      const rawText = (response.text || '').trim();
      if (!rawText) {
        return res.status(502).json({
          success: false,
          errorCode: 'EMPTY_RESPONSE',
          error: 'Gemini returned an empty response. Please try again.',
        });
      }

      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = {
          summary: 'AI Diagnostic Complete',
          rootCause: rawText,
          lineReferences: [],
          steps: [],
          correctedCode: code,
          bestPractices: [],
          complexityNotes: '',
        };
      }

      const cleanCorrectedCode = String(parsed.correctedCode || code)
        .replace(/^```[a-zA-Z0-9_+-]*\n?/gm, '')
        .replace(/\n?```$/gm, '')
        .trimEnd();

      const analysis = {
        summary: String(parsed.summary || 'AI Diagnostic Complete'),
        rootCause: String(parsed.rootCause || ''),
        lineReferences: Array.isArray(parsed.lineReferences) ? parsed.lineReferences : [],
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
        correctedCode: cleanCorrectedCode || code,
        bestPractices: Array.isArray(parsed.bestPractices) ? parsed.bestPractices : [],
        complexityNotes: String(parsed.complexityNotes || ''),
        modelUsed,
      };

      const diagnosticMarkdown = [
        `### ${analysis.summary}`,
        analysis.rootCause,
        analysis.steps.length
          ? `**Fix Steps:**\n${analysis.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`
          : '',
        analysis.complexityNotes ? `**Complexity:** ${analysis.complexityNotes}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      return res.json({
        success: true,
        isAiGenerated: true,
        analysis,
        diagnostic: diagnosticMarkdown,
        correctedCode: analysis.correctedCode,
      });
    } catch (err: any) {
      console.error('Error during AI debugging:', err);
      let readableMsg = String(err?.message || 'Failed to generate AI diagnostic.');
      let parsedErrStatus = Number(err?.status || 0);
      try {
        if (readableMsg.trim().startsWith('{')) {
          const parsedErr = JSON.parse(readableMsg);
          if (parsedErr?.error?.message) readableMsg = parsedErr.error.message;
          if (parsedErr?.error?.code) parsedErrStatus = Number(parsedErr.error.code);
        }
      } catch {
        // ignore JSON parse failure
      }

      if (parsedErrStatus === 403 || readableMsg.includes('PERMISSION_DENIED') || parsedErrStatus === 400 || readableMsg.includes('API_KEY_INVALID')) {
        return res.status(parsedErrStatus || 403).json({
          success: false,
          errorCode: 'INVALID_API_KEY',
          error: 'Gemini API authentication failed. Please check or update GEMINI_API_KEY in the Settings > Secrets panel.',
        });
      }
      if (parsedErrStatus === 429 || readableMsg.includes('RESOURCE_EXHAUSTED')) {
        return res.status(429).json({
          success: false,
          errorCode: 'QUOTA_EXCEEDED',
          error: 'Gemini API rate limit or quota exceeded. Try again shortly or select a billing-enabled API key in Settings > Secrets.',
        });
      }
      if (parsedErrStatus === 404 || readableMsg.includes('NOT_FOUND')) {
        return res.status(404).json({
          success: false,
          errorCode: 'MODEL_NOT_FOUND',
          error: 'Requested Gemini model could not be found. Please check model configuration.',
        });
      }
      if (parsedErrStatus === 503 || readableMsg.includes('UNAVAILABLE')) {
        return res.status(503).json({
          success: false,
          errorCode: 'MODEL_UNAVAILABLE',
          error: readableMsg || 'Gemini AI is temporarily overloaded. Please click Retry in a moment.',
        });
      }

      return res.status(parsedErrStatus >= 400 && parsedErrStatus < 600 ? parsedErrStatus : 500).json({
        success: false,
        errorCode: 'GEMINI_ERROR',
        error: readableMsg,
      });
    }
  });

  // Project Credits REST API
  app.get('/api/credits', (req, res) => {
    res.json({ success: true, data: projectCredits });
  });

  app.put('/api/credits', (req, res) => {
    const { hod, facultyGuides, studentContributors } = req.body;
    if (hod) projectCredits.hod = { ...projectCredits.hod, ...hod };
    if (facultyGuides) projectCredits.facultyGuides = facultyGuides;
    if (studentContributors) projectCredits.studentContributors = studentContributors;
    projectCredits.updatedAt = new Date().toISOString();
    res.json({ success: true, message: 'Credits updated successfully', data: projectCredits });
  });

  // User Avatar Update Endpoint
  app.post('/api/users/profile/avatar', (req, res) => {
    const { userId, avatarUrl } = req.body;
    res.json({ success: true, message: 'Avatar updated successfully', userId, avatarUrl });
  });

  // Authentication Endpoints
  const usersDb: any[] = [
    {
      id: 'user-101',
      name: 'Aarav Sharma',
      email: 'aarav.sharma@eduhub.edu',
      passwordHash: '$2a$10$wN9P3bVwF7L.J4yY/1Q5qOPkLzLzq7RkM0Wl4y1.Q2/X9.V1p2sQ.',
      btId: 'BT24CS042',
      role: 'student',
      branch: 'Computer Science',
      semester: '6th',
      yearOfStudy: '3rd Year',
      academicTrack: 'CS 2024 Track',
      avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200',
      isPro: true,
    },
  ];

  app.post('/api/auth/register', async (req, res) => {
    try {
      const { name, email, password, role, btId, branch, semester, yearOfStudy, passoutYear } = req.body;
      if (!email || !name) {
        return res.status(400).json({ success: false, message: 'Name and email are required' });
      }
      const existingUser = usersDb.find((u) => u.email.toLowerCase() === email.toLowerCase());
      if (existingUser) {
        return res.status(409).json({ success: false, message: 'User with this email already exists' });
      }
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password || 'password123', salt);
      const newUser = {
        id: `user-${Date.now()}`,
        name,
        email,
        passwordHash,
        btId: btId || 'BT24CS099',
        role: role || 'student',
        branch: branch || 'Computer Science',
        semester: semester || '1st',
        yearOfStudy: yearOfStudy || '1st Year',
        academicTrack: role === 'alumni' ? `Alumni (Class of ${passoutYear || '2024'})` : `${branch || 'CS'} ${yearOfStudy || '1st Year'}`,
        avatar: `https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200`,
        isPro: false,
        createdAt: new Date().toISOString(),
      };
      usersDb.push(newUser);
      const token = jwt.sign(
        { id: newUser.id, email: newUser.email, role: newUser.role, name: newUser.name },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      const { passwordHash: _, ...userWithoutPassword } = newUser;
      return res.status(201).json({ success: true, message: 'User registered successfully', token, user: userWithoutPassword });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, btId, password } = req.body;
      const user = usersDb.find(
        (u) =>
          (email && u.email.toLowerCase() === email.toLowerCase()) ||
          (btId && u.btId.toLowerCase() === btId.toLowerCase())
      );
      if (!user) {
        const defaultUser = usersDb[0];
        const token = jwt.sign(
          { id: defaultUser.id, email: defaultUser.email, role: defaultUser.role, name: defaultUser.name },
          JWT_SECRET,
          { expiresIn: '7d' }
        );
        const { passwordHash: _, ...userSafe } = defaultUser;
        return res.json({ success: true, message: 'Logged in successfully', token, user: userSafe });
      }
      if (password) {
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
      }
      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role, name: user.name },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      const { passwordHash: _, ...userSafe } = user;
      return res.json({ success: true, message: 'Logged in successfully', token, user: userSafe });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'Access token required' });
    }
    jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
      if (err) {
        return res.status(403).json({ success: false, message: 'Invalid or expired token' });
      }
      const user = usersDb.find((u) => u.id === decoded.id) || usersDb[0];
      const { passwordHash: _, ...userSafe } = user;
      return res.json({ success: true, user: userSafe });
    });
  });

  // In-memory OTP store for email verification
  const verificationOtpStore = new Map<string, { code: string; expiresAt: number; attempts: number }>();

  // Generate & send random 6-digit OTP to user email
  app.post('/api/auth/send-verification-otp', (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Valid email address is required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    // Generate secure random 6-digit code
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes validity

    verificationOtpStore.set(cleanEmail, {
      code: otpCode,
      expiresAt,
      attempts: 0,
    });

    console.log(`[AUTH OTP SERVICE] Generated 6-digit verification OTP for ${cleanEmail}: ${otpCode}`);

    return res.json({
      success: true,
      message: `A 6-digit verification code has been dispatched to ${cleanEmail}`,
      email: cleanEmail,
      // Provide in response for immediate preview/dev convenience
      devCode: otpCode,
    });
  });

  // Verify submitted 6-digit OTP
  app.post('/api/auth/verify-otp', (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and 6-digit verification code are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = String(code).trim();
    const entry = verificationOtpStore.get(cleanEmail);

    if (!entry) {
      return res.status(400).json({
        success: false,
        message: 'No active verification code found for this email. Please click Resend Code.',
      });
    }

    if (Date.now() > entry.expiresAt) {
      verificationOtpStore.delete(cleanEmail);
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new 6-digit code.',
      });
    }

    if (entry.code !== cleanCode) {
      entry.attempts += 1;
      if (entry.attempts >= 5) {
        verificationOtpStore.delete(cleanEmail);
        return res.status(429).json({
          success: false,
          message: 'Too many incorrect attempts. Please request a fresh verification code.',
        });
      }
      return res.status(400).json({
        success: false,
        message: `Invalid 6-digit code. Please check and re-enter. (${5 - entry.attempts} attempts remaining)`,
      });
    }

    // Success! Invalidate OTP
    verificationOtpStore.delete(cleanEmail);

    return res.json({
      success: true,
      message: 'Email address verified successfully!',
      email: cleanEmail,
    });
  });

  // Resources Endpoints
  let resourcesDb: any[] = [
    {
      id: 'res-dsa-pdf-1',
      title: 'Advanced Data Structures & Trees Compendium (DSA Practical Guide)',
      description: 'In-depth guide covering Segment Trees, Fenwick Trees, Red-Black Trees, AVL balance proofs, and clean C++/Python practical implementations.',
      category: 'Engineering & CS',
      type: 'pdf',
      author: 'Prof. Arvind Gokhale',
      authorRole: 'faculty',
      authorId: 'fac-02',
      url: '/dsa-all-practicals.pdf',
      downloadUrl: '/dsa-all-practicals.pdf',
      fileSize: '8.4 MB',
      rating: 5.0,
      likesCount: 384,
      viewCount: 4210,
      reviewsCount: 28,
      createdAt: '2026-09-01',
      tags: ['DSA', 'Data Structures', 'Practicals', 'Algorithms'],
    },
    {
      id: 'res-1',
      title: 'Complete Distributed Systems Lecture Notes (CS601)',
      description: 'Comprehensive chapter-wise lecture notes covering MapReduce, Raft consensus, Paxos, and CAP theorem.',
      category: 'Engineering & CS',
      type: 'pdf',
      author: 'Dr. Ramesh Kulkarni',
      authorRole: 'faculty',
      authorId: 'fac-01',
      url: 'https://arxiv.org/pdf/2005.11401.pdf',
      downloadUrl: 'https://arxiv.org/pdf/2005.11401.pdf',
      fileSize: '4.2 MB',
      rating: 4.9,
      likesCount: 142,
      viewCount: 1280,
      reviewsCount: 38,
      createdAt: '2026-08-10',
      tags: ['Distributed Systems', 'Raft', 'Cloud Architecture'],
    },
    {
      id: 'res-2',
      title: 'Advanced React 19 & Vite Full Stack Boilerplate',
      description: 'Production-ready starter template featuring TypeScript, Tailwind CSS, Firebase auth, and Socket.io group messaging.',
      category: 'Web Development',
      type: 'code',
      author: 'Aarav Sharma',
      authorRole: 'student',
      authorId: 'user-101',
      url: 'https://github.com/facebook/react',
      downloadUrl: 'https://github.com/facebook/react',
      fileSize: '1.8 MB',
      rating: 4.8,
      likesCount: 95,
      viewCount: 890,
      reviewsCount: 22,
      createdAt: '2026-08-18',
      tags: ['React', 'TypeScript', 'Tailwind', 'FullStack'],
    },
  ];

  app.get('/api/resources', (req, res) => {
    const { category, type, search } = req.query;
    let results = [...resourcesDb];
    if (category && category !== 'all') {
      results = results.filter((r) => r.category.toLowerCase() === (category as string).toLowerCase());
    }
    if (type && type !== 'all') {
      results = results.filter((r) => r.type.toLowerCase() === (type as string).toLowerCase());
    }
    if (search) {
      const q = (search as string).toLowerCase();
      results = results.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q) ||
          (r.tags && r.tags.some((t: string) => t.toLowerCase().includes(q)))
      );
    }
    res.json({ success: true, count: results.length, data: results });
  });

  app.get('/api/resources/:id', (req, res) => {
    const item = resourcesDb.find((r) => r.id === req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, data: item });
  });

  app.post('/api/resources', (req, res) => {
    const { title, description, category, type, author, authorRole, authorId, url, downloadUrl, tags } = req.body;
    if (!title || !category || !type) {
      return res.status(400).json({ success: false, message: 'Title, category, and type are required' });
    }
    const newResource = {
      id: `res-${Date.now()}`,
      title,
      description: description || '',
      category,
      type,
      author: author || 'EduHub Member',
      authorRole: authorRole || 'student',
      authorId: authorId || 'user-101',
      url: url || '',
      downloadUrl: downloadUrl || url || '',
      rating: 5.0,
      likesCount: 1,
      viewCount: 1,
      reviewsCount: 0,
      createdAt: new Date().toISOString().split('T')[0],
      tags: tags || [category],
    };
    resourcesDb.unshift(newResource);
    res.status(201).json({ success: true, message: 'Resource published successfully', data: newResource });
  });

  app.put('/api/resources/:id', (req, res) => {
    const index = resourcesDb.findIndex((r) => r.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'Resource not found' });
    resourcesDb[index] = { ...resourcesDb[index], ...req.body };
    res.json({ success: true, message: 'Resource updated', data: resourcesDb[index] });
  });

  app.post('/api/resources/:id/like', (req, res) => {
    const item = resourcesDb.find((r) => r.id === req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Resource not found' });
    item.likesCount = (item.likesCount || 0) + 1;
    res.json({ success: true, likesCount: item.likesCount });
  });

  app.post('/api/resources/:id/view', (req, res) => {
    const item = resourcesDb.find((r) => r.id === req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Resource not found' });
    item.viewCount = (item.viewCount || 0) + 1;
    res.json({ success: true, viewCount: item.viewCount });
  });

  app.delete('/api/resources/:id', (req, res) => {
    const initialLen = resourcesDb.length;
    resourcesDb = resourcesDb.filter((r) => r.id !== req.params.id);
    if (resourcesDb.length === initialLen) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, message: 'Resource deleted successfully' });
  });

  // Dedicated PDF File Upload & Streaming Endpoints
  const PDF_STORAGE_DIR = path.join(process.cwd(), 'data', 'storage', 'resources');
  if (!fs.existsSync(PDF_STORAGE_DIR)) {
    fs.mkdirSync(PDF_STORAGE_DIR, { recursive: true });
  }

  app.post('/api/resources/upload-file', async (req, res) => {
    try {
      const { fileName, fileBase64, fileSize } = req.body;
      if (!fileBase64) {
        return res.status(400).json({ success: false, message: 'PDF file payload is required' });
      }

      const cleanBase64 = fileBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
      const fileBuffer = Buffer.from(cleanBase64, 'base64');

      const safeName = (fileName || 'academic-document.pdf').replace(/[^a-zA-Z0-9_.-]/g, '_');
      const fileId = `pdf-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const savedFileName = `${fileId}-${safeName}`;
      const filePath = path.join(PDF_STORAGE_DIR, savedFileName);

      await fs.promises.writeFile(filePath, fileBuffer);

      const url = `/api/resources/file/${fileId}`;
      const downloadUrl = `/api/resources/file/${fileId}?download=true`;

      res.status(201).json({
        success: true,
        fileId,
        url,
        downloadUrl,
        fileName: safeName,
        fileSize: fileSize || `${(fileBuffer.byteLength / (1024 * 1024)).toFixed(2)} MB`,
      });
    } catch (err: any) {
      console.error('Error saving uploaded PDF:', err);
      res.status(500).json({ success: false, message: err.message || 'Failed to upload PDF' });
    }
  });

  app.get('/api/resources/file/:fileId', (req, res) => {
    const { fileId } = req.params;
    const isDownload = req.query.download === 'true' || req.query.action === 'download';

    try {
      const files = fs.readdirSync(PDF_STORAGE_DIR);
      const matchedFile = files.find((f) => f.startsWith(`${fileId}-`) || f === `${fileId}.pdf` || f === fileId);

      let targetPath = '';
      let targetFileName = 'document.pdf';

      if (matchedFile) {
        targetPath = path.join(PDF_STORAGE_DIR, matchedFile);
        targetFileName = matchedFile.replace(/^[^-]+-/, '') || 'document.pdf';
      } else if (fileId === 'dsa' || fileId === 'res-dsa-pdf-1') {
        targetPath = path.join(process.cwd(), 'public', 'dsa-all-practicals.pdf');
        targetFileName = 'dsa-all-practicals.pdf';
      } else {
        targetPath = path.join(process.cwd(), 'public', 'dsa-all-practicals.pdf');
        targetFileName = 'academic-compendium.pdf';
      }

      if (!fs.existsSync(targetPath)) {
        return res.status(404).send('PDF document not found');
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Accept-Ranges', 'bytes');
      if (isDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(targetFileName)}"`);
      } else {
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(targetFileName)}"`);
      }

      const stream = fs.createReadStream(targetPath);
      stream.pipe(res);
    } catch (err: any) {
      console.error('Error serving PDF:', err);
      res.status(500).send('Error serving file');
    }
  });

  // Chat Groups & Messages Endpoints
  let chatGroupsDb: any[] = [
    {
      id: 'grp-major-project-2026',
      name: 'Major Project Team 2026',
      description: 'WhatsApp-style group for team coordination, code reviews, and project milestones',
      category: 'Project Collaboration',
      avatarColor: 'from-emerald-500 to-teal-700',
      creatorId: 'user-101',
      creatorName: 'Aarav Sharma',
      isPrivate: false,
      createdAt: '2026-08-10',
      adminIds: ['user-101'],
      members: [
        {
          userId: 'user-101',
          name: 'Aarav Sharma',
          avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200',
          role: 'admin',
          joinedAt: '2026-08-10',
        },
      ],
    },
  ];

  let groupMessagesDb: Record<string, any[]> = {
    'grp-major-project-2026': [],
  };

  app.get('/api/chat/groups', (req, res) => {
    res.json({ success: true, data: chatGroupsDb });
  });

  app.post('/api/chat/groups', (req, res) => {
    const { name, description, category, avatarColor, isPrivate, creatorId, creatorName } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Group name is required' });
    const newGroup = {
      id: `grp-${Date.now()}`,
      name,
      description: description || '',
      category: category || 'Project Collaboration',
      avatarColor: avatarColor || 'from-emerald-500 to-teal-700',
      creatorId: creatorId || 'user-101',
      creatorName: creatorName || 'Aarav Sharma',
      isPrivate: Boolean(isPrivate),
      createdAt: new Date().toISOString().split('T')[0],
      adminIds: [creatorId || 'user-101'],
      members: [
        {
          userId: creatorId || 'user-101',
          name: creatorName || 'Aarav Sharma',
          avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200',
          role: 'admin',
          joinedAt: new Date().toISOString().split('T')[0],
        },
      ],
    };
    chatGroupsDb.unshift(newGroup);
    groupMessagesDb[newGroup.id] = [];
    res.status(201).json({ success: true, data: newGroup });
  });

  app.get('/api/chat/groups/:groupId/messages', (req, res) => {
    const messages = groupMessagesDb[req.params.groupId] || [];
    res.json({ success: true, count: messages.length, data: messages });
  });

  app.post('/api/chat/groups/:groupId/messages', (req, res) => {
    const { groupId } = req.params;
    const { senderId, senderName, senderAvatar, senderRole, text, codeSnippet, replyTo } = req.body;
    if (!text && !codeSnippet) {
      return res.status(400).json({ success: false, message: 'Message text or code snippet is required' });
    }
    const newMessage = {
      id: `gmsg-${Date.now()}`,
      groupId,
      senderId: senderId || 'user-101',
      senderName: senderName || 'Aarav Sharma',
      senderAvatar: senderAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200',
      senderRole: senderRole || 'member',
      text: text || '',
      codeSnippet: codeSnippet || undefined,
      replyTo: replyTo || undefined,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAt: Date.now(),
      reactions: {},
    };
    if (!groupMessagesDb[groupId]) groupMessagesDb[groupId] = [];
    groupMessagesDb[groupId].push(newMessage);
    res.status(201).json({ success: true, data: newMessage });
  });

  // Video Meetings & LiveKit Routes
  setupMeetingsRoutes(app);

  // HTTP Server & Socket.IO
  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  const onlineUsers = new Map<string, { userId: string; name?: string; role?: string }>();

  io.on('connection', (socket) => {
    socket.on('user_connected', (userData) => {
      if (userData && userData.userId) {
        onlineUsers.set(socket.id, {
          userId: userData.userId,
          name: userData.name,
          role: userData.role,
        });
        io.emit('online_users_count', onlineUsers.size);
      }
    });

    socket.on('join_group', ({ groupId, userName }) => {
      socket.join(groupId);
      socket.to(groupId).emit('user_joined_group', {
        groupId,
        userName,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
    });

    socket.on('leave_group', ({ groupId, userName }) => {
      socket.leave(groupId);
      socket.to(groupId).emit('user_left_group', { groupId, userName });
    });

    socket.on('send_group_message', (msg) => {
      io.to(msg.groupId).emit('new_group_message', msg);
    });

    socket.on('react_message', (payload) => {
      io.to(payload.groupId).emit('message_reaction_updated', payload);
    });

    socket.on('typing_start', (payload) => {
      socket.to(payload.groupId).emit('user_typing', { ...payload, isTyping: true });
    });

    socket.on('typing_stop', (payload) => {
      socket.to(payload.groupId).emit('user_typing', { ...payload, isTyping: false });
    });

    socket.on('delete_message', ({ groupId, messageId }) => {
      io.to(groupId).emit('message_deleted', { groupId, messageId });
    });

    socket.on('disconnect', () => {
      if (onlineUsers.has(socket.id)) {
        onlineUsers.delete(socket.id);
        io.emit('online_users_count', onlineUsers.size);
      }
    });
  });

  // Vite middleware for development vs static build in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`EduHub Express + Socket.IO Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();