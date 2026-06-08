const terminalCursorControlCarryLimit = 32;
const terminalCursorControlPartialPattern = /^\x1b\[(?:\?[0-9;]*|[0-9]*\s?)?$/;
const terminalCursorChoreographyWindowMs = 1400;
const terminalCursorChoreographyHoldMs = 2500;
const terminalPrivateModePattern = /\x1b\[\?([0-9;]*)([hl])/g;
const terminalCursorMovePattern = /\x1b\[[0-9;]*[ABCDGdHf]/g;
const terminalErasePattern = /\x1b\[(?:[0-9]*K|[0-9]*J)/g;

function steadyTerminalCursorStyleSequence(code = "") {
  switch (String(code || "0")) {
    case "":
    case "0":
    case "1":
      return "\x1b[2 q";
    case "3":
      return "\x1b[4 q";
    case "5":
      return "\x1b[6 q";
    default:
      return `\x1b[${code} q`;
  }
}

function splitTerminalCursorControlTail(data) {
  const start = data.lastIndexOf("\x1b[");
  if (start < 0) return ["", data];
  const tail = data.slice(start);
  if (tail.length > terminalCursorControlCarryLimit || !terminalCursorControlPartialPattern.test(tail)) {
    return ["", data];
  }
  return [tail, data.slice(0, start)];
}

function terminalCursorNow() {
  return globalThis.performance?.now?.() || Date.now();
}

function matchCount(pattern, data) {
  return data.match(pattern)?.length || 0;
}

function terminalPrivateModes(value) {
  return String(value || "").split(";").filter(Boolean);
}

function privateModeControlCount(data, mode) {
  let count = 0;
  terminalPrivateModePattern.lastIndex = 0;
  let match = terminalPrivateModePattern.exec(data);
  while (match) {
    if (terminalPrivateModes(match[1]).includes(String(mode))) count += 1;
    match = terminalPrivateModePattern.exec(data);
  }
  return count;
}

function normalizeTerminalPrivateModeSequence(match, rawModes, final) {
  const modes = terminalPrivateModes(rawModes);
  if (final !== "h" || !modes.includes("12")) return match;
  const remainingModes = modes.filter((mode) => mode !== "12");
  return `\x1b[?12l${remainingModes.length ? `\x1b[?${remainingModes.join(";")}h` : ""}`;
}

export function terminalPromptCursorColumn(line) {
  const text = String(line || "");
  const trimmedEndLength = text.replace(/\s+$/u, "").length;
  const simplePromptMatch = text.match(/^\s*(?:[›❯➜»]\s?|[$#%]\s+)(.*)$/u);
  if (simplePromptMatch) {
    const promptIndex = simplePromptMatch.index || 0;
    if (text.slice(0, promptIndex).trim()) return -1;
    return Math.max(promptIndex + simplePromptMatch[0].length - simplePromptMatch[1].length, trimmedEndLength);
  }
  if (/^\s*PS\s+\S.*>\s*.*$/u.test(text)) return trimmedEndLength;
  if (/^\s*(?:[A-Za-z]:\\|\\\\)[^<>|?*\r\n]*>\s*.*$/u.test(text)) return trimmedEndLength;
  if (/^\s*[^@\s]+@[^:\s]+:[^\r\n]+[$#%]\s*.*$/u.test(text)) return trimmedEndLength;
  return -1;
}

function recordTerminalCursorChoreography(data, session) {
  if (!session || !data) return;
  const visibilityControls = privateModeControlCount(data, "25");
  const synchronizedOutputControls = privateModeControlCount(data, "2026");
  const cursorMoves = matchCount(terminalCursorMovePattern, data);
  const erases = matchCount(terminalErasePattern, data);
  if (!visibilityControls && !synchronizedOutputControls && cursorMoves < 2 && erases < 2) return;
  const now = terminalCursorNow();
  const hasRedrawControl = synchronizedOutputControls > 0 || cursorMoves > 0 || erases > 0;
  const immediateChoreography = (
    visibilityControls > 0 && hasRedrawControl
  ) || (
    synchronizedOutputControls > 0 && (cursorMoves > 0 || erases > 0)
  );
  const events = session.cursorChoreographyEvents || [];
  events.push({
    at: now,
    visibilityControls,
    synchronizedOutputControls,
    cursorMoves,
    erases
  });
  const minAt = now - terminalCursorChoreographyWindowMs;
  while (events.length && events[0].at < minAt) events.shift();
  session.cursorChoreographyEvents = events;
  const recent = events.reduce((totals, event) => {
    totals.visibilityControls += event.visibilityControls;
    totals.synchronizedOutputControls += event.synchronizedOutputControls;
    totals.cursorMoves += event.cursorMoves;
    totals.erases += event.erases;
    return totals;
  }, {
    visibilityControls: 0,
    synchronizedOutputControls: 0,
    cursorMoves: 0,
    erases: 0
  });
  if (
    immediateChoreography
    || (
      recent.visibilityControls >= 2
      && (recent.synchronizedOutputControls > 0 || recent.cursorMoves >= 3 || recent.erases >= 2)
    )
  ) {
    session.cursorChoreographyHoldUntil = now + terminalCursorChoreographyHoldMs;
  }
}

export function terminalCursorChoreographyActive(session, now = terminalCursorNow()) {
  return Boolean(session && Number(session.cursorChoreographyHoldUntil || 0) > now);
}

export function stabilizeTerminalCursorOutput(data, session = null) {
  if (!data || typeof data !== "string") return data;
  const input = `${session?.cursorControlTail || ""}${data}`;
  if (session) session.cursorControlTail = "";
  const [tail, output] = splitTerminalCursorControlTail(input);
  if (session) session.cursorControlTail = tail;
  if (!output) return "";
  const normalized = output
    .replace(terminalPrivateModePattern, normalizeTerminalPrivateModeSequence)
    .replace(/\x1b\[([0-9]*)\s+q/g, (_match, code) => steadyTerminalCursorStyleSequence(code));
  recordTerminalCursorChoreography(normalized, session);
  return normalized;
}
