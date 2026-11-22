import { CodeDiagnosticItem, SupportedCodeLanguage } from '../types';

/**
 * Deterministic multi-language code formatter supporting C, C++,
 * and Python whitespace normalization.
 */
export function formatCodeByLanguage(source: string, language: SupportedCodeLanguage): string {
  const normalized = (source || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.trim()) return '';

  switch (language) {
    case 'python':
      return formatPython(normalized);
    case 'c':
    case 'cpp':
      return formatCStyle(normalized, 4);
    default:
      return normalized
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .trimEnd() + '\n';
  }
}

function formatPython(code: string): string {
  const lines = code.split('\n');
  const cleaned: string[] = [];
  let consecutiveBlanks = 0;

  for (const rawLine of lines) {
    // Convert leading tabs to 4 spaces and strip trailing whitespace
    const leadingTabsReplaced = rawLine.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length));
    const trimmedRight = leadingTabsReplaced.replace(/[ \t]+$/g, '');

    if (trimmedRight === '') {
      consecutiveBlanks += 1;
      if (consecutiveBlanks <= 2) {
        cleaned.push('');
      }
    } else {
      consecutiveBlanks = 0;
      cleaned.push(trimmedRight);
    }
  }

  while (cleaned.length > 0 && cleaned[0] === '') cleaned.shift();
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();

  return cleaned.length ? `${cleaned.join('\n')}\n` : '';
}

function formatCStyle(code: string, indentSize: number): string {
  const lines = code.split('\n');
  const result: string[] = [];
  let indentLevel = 0;
  let inBlockComment = false;
  let consecutiveBlanks = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed === '') {
      consecutiveBlanks += 1;
      if (consecutiveBlanks <= 1 && result.length > 0) {
        result.push('');
      }
      continue;
    }
    consecutiveBlanks = 0;

    if (inBlockComment) {
      result.push(' '.repeat(indentLevel * indentSize) + trimmed);
      if (trimmed.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }

    // Count leading closing braces on this line
    let leadingCloses = 0;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '}' || trimmed[i] === ']') {
        leadingCloses++;
      } else if (trimmed[i] !== ' ' && trimmed[i] !== '\t') {
        break;
      }
    }

    const lineIndent = Math.max(0, indentLevel - leadingCloses);
    result.push(' '.repeat(lineIndent * indentSize) + trimmed);

    // Track net brace balance outside strings and comments
    let netDelta = 0;
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    let escaped = false;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      const next = trimmed[i + 1];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && (inSingle || inDouble || inBacktick)) {
        escaped = true;
        continue;
      }
      if (!inSingle && !inDouble && !inBacktick) {
        if (ch === '/' && next === '/') {
          break; // rest of line is comment
        }
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          i++;
          continue;
        }
      }

      if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
      else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
      else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
      else if (!inSingle && !inDouble && !inBacktick) {
        if (ch === '{') netDelta++;
        else if (ch === '}') netDelta--;
      }
    }

    indentLevel = Math.max(0, indentLevel + netDelta);
  }

  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  return result.length ? `${result.join('\n')}\n` : '';
}

/**
 * Lightweight client-side syntax sanity checker (unclosed brackets/quotes)
 * to complement real compiler diagnostics.
 */
export function runClientSyntaxCheck(
  code: string,
  language: SupportedCodeLanguage
): CodeDiagnosticItem[] {
  const diagnostics: CodeDiagnosticItem[] = [];
  if (!code.trim()) {
    diagnostics.push({
      line: 1,
      severity: 'warning',
      message: 'Editor buffer is empty. Add code before running.',
      source: 'Editor Check',
    });
    return diagnostics;
  }

  const stack: Array<{ char: string; line: number }> = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closingToOpening: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

  const lines = code.split('\n');
  let inBlockComment = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNum = lineIdx + 1;
    const lineText = lines[lineIdx];
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < lineText.length; i++) {
      const ch = lineText[i];
      const next = lineText[i + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\' && (inSingle || inDouble)) {
        escaped = true;
        continue;
      }

      if (!inSingle && !inDouble) {
        if (language === 'python' && ch === '#') break;
        if (language !== 'python') {
          if (ch === '/' && next === '/') break;
          if (ch === '/' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
          }
        }
      }

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }

      if (inSingle || inDouble) continue;

      if (pairs[ch]) {
        stack.push({ char: ch, line: lineNum });
      } else if (closingToOpening[ch]) {
        const last = stack[stack.length - 1];
        if (!last || last.char !== closingToOpening[ch]) {
          diagnostics.push({
            line: lineNum,
            severity: 'error',
            message: `Unmatched closing '${ch}' on line ${lineNum}.`,
            source: 'Syntax Check',
          });
        } else {
          stack.pop();
        }
      }
    }
  }

  for (const unclosed of stack) {
    diagnostics.push({
      line: unclosed.line,
      severity: 'error',
      message: `Unclosed '${unclosed.char}' opened on line ${unclosed.line}.`,
      source: 'Syntax Check',
    });
  }

  return diagnostics;
}
