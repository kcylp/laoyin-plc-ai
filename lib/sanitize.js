'use strict';

const STACK_LINE = /^\s*at\s+.+(?:\([^)]*:\d+:\d+\)|:\d+:\d+)\s*$/i;
const INTERNAL_STACK = /^\s*(?:node:internal|internal\/)/i;
const SENSITIVE_ASSIGNMENT = /\b(ADMIN_KEY|JWT_SECRET|SMTP_PASS|IMAP_PASS|API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS)\b\s*[:=]\s*([^\s,;]+)/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/g;
const UNC_PATH = /\\\\[^\s\\/<>:"|?*]+\\[^\s<>:"|?*]*/g;
const BARE_API_KEY = /\bsk-[A-Za-z0-9_-]{4,}\b/g;
const ESCAPED_WINDOWS_PATH = /\b[A-Za-z]:(?:\\\\|\\)(?:[^\s<>:"|?*]+(?:\\\\|\\))*[^\s<>:"|?*]*/g;

function sanitizeLine(value) {
    let line = String(value || '');
    if (STACK_LINE.test(line) || INTERNAL_STACK.test(line)) return '';

    line = line
        .replace(/\b(?:Authorization\s*:\s*)?Bearer\s+[^\s,;]+/gi, '<credential-redacted>')
        .replace(BARE_API_KEY, '<api-key-redacted>')
        .replace(SENSITIVE_ASSIGNMENT, '$1=<redacted>')
        .replace(EMAIL, '<email>')
        .replace(UNC_PATH, '<path>')
        .replace(ESCAPED_WINDOWS_PATH, '<path>')
        .replace(WINDOWS_PATH, '<path>');
    line = line.replace(/\b[A-Za-z]:(?:Users|Private|ProgramData|Windows|Temp)[^\s,;]*/gi, '<path>');
    return line.trimEnd();
}

function sanitizeObject(value) {
    if (Array.isArray(value)) return value.map(sanitizeObject);
    if (!value || typeof value !== 'object') {
        if (typeof value === 'string') return sanitizeDiagnostic(value);
        return value;
    }
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        out[key] = sanitizeObject(entry);
    }
    return out;
}

function sanitizeDiagnostic(value) {
    if (Array.isArray(value)) {
        return value.map(sanitizeLine).filter(line => line.trim());
    }
    if (value === null || value === undefined) return null;
    return String(value)
        .split(/\r?\n/)
        .map(sanitizeLine)
        .filter(line => line.trim())
        .join('\n');
}

module.exports = { sanitizeDiagnostic, sanitizeObject };
