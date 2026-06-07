const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { WebSocket } = require("ws");

if (!Object.hasOwn(process.env, "CMUX_WINDOWS_DISABLE_PTY")) {
  process.env.CMUX_WINDOWS_DISABLE_PTY = "1";
}

const { createCmuxWindowsRuntime } = require("./server.cjs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cmux-windows-smoke-${process.pid}-`));
const pipeName = process.platform === "win32"
  ? `\\\\.\\pipe\\cmux-windows-smoke-${process.pid}`
  : path.join(os.tmpdir(), `cmux-windows-smoke-${process.pid}.sock`);
const smokeIoTimeoutMs = Math.max(1, Number.parseInt(process.env.CMUX_WINDOWS_SMOKE_IO_TIMEOUT_MS || "3000", 10) || 3000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchText(url, label) {
  const response = await fetch(url);
  assert(response.ok, `${label} fetch failed`);
  return response.text();
}

function pipeRoundTrip(command, launchToken, timeoutMs = smokeIoTimeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    let output = "";
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const finish = (error, value = "") => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.end();
      resolve(value);
    };
    const onConnect = () => {
      if (launchToken) socket.write(`auth ${launchToken}\n`);
      socket.write(command + "\n");
    };
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("\n")) {
        finish(null, output.trim());
      }
    };
    const onError = (error) => finish(error);
    timer = setTimeout(() => finish(new Error(`pipe round-trip timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function waitForWebSocketOpen(socket, timeoutMs = smokeIoTimeoutMs) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        if (typeof socket.terminate === "function") socket.terminate();
        else socket.close?.();
        reject(error);
        return;
      }
      resolve();
    };
    const onOpen = () => finish(null);
    const onError = (error) => finish(error);
    timer = setTimeout(() => finish(new Error(`websocket open timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

async function waitForCondition(label, probe, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} timed out`);
}

(async () => {
  const repairDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cmux-windows-repair-${process.pid}-`));
  const repairPipeName = process.platform === "win32"
    ? `\\\\.\\pipe\\cmux-windows-repair-${process.pid}`
    : path.join(os.tmpdir(), `cmux-windows-repair-${process.pid}.sock`);
  fs.writeFileSync(path.join(repairDataDir, "session.json"), JSON.stringify({
    activeWorkspaceId: "repair-1",
    workspaces: [
      { id: "repair-1", title: "Workspace 4", cwd: process.cwd(), activePanelId: null, splitDirection: "right", panels: [] },
      { id: "repair-2", title: "Workspace 4", cwd: process.cwd(), activePanelId: null, splitDirection: "right", panels: [] },
      { id: "repair-3", title: "Workspace 6", cwd: process.cwd(), activePanelId: null, splitDirection: "right", panels: [] },
      { id: "repair-4", title: "Workspace 6", cwd: process.cwd(), activePanelId: null, splitDirection: "right", panels: [] },
      { id: "repair-5", title: "Project", cwd: process.cwd(), activePanelId: null, splitDirection: "right", panels: [] },
      { id: "repair-6", title: "Project", cwd: process.cwd(), activePanelId: null, splitDirection: "right", panels: [] }
    ]
  }));
  const repairRuntime = createCmuxWindowsRuntime({
    dataDir: repairDataDir,
    pipeName: repairPipeName,
    logPipeErrors: false
  });
  const repairedTitles = repairRuntime.serializedState().workspaces.map((workspace) => workspace.title);
  assert(repairedTitles[0] === "Workspace 4", "first generated workspace title should be preserved");
  assert(repairedTitles[1] === "Workspace 5", "duplicate generated workspace title should be repaired");
  assert(repairedTitles[2] === "Workspace 6", "next generated workspace title should be preserved");
  assert(repairedTitles[3] === "Workspace 7", "second duplicate generated workspace title should be repaired");
  assert(repairedTitles[4] === "Project" && repairedTitles[5] === "Project", "custom duplicate workspace titles should be preserved");
  const persistedRepaired = JSON.parse(fs.readFileSync(path.join(repairDataDir, "session.json"), "utf8"));
  assert(persistedRepaired.workspaces[1].title === "Workspace 5", "repaired generated titles should be persisted");
  repairRuntime.close();

  const runtime = createCmuxWindowsRuntime({
    dataDir,
    pipeName,
    logPipeErrors: false
  });
  const info = await runtime.listen();
  const rawFetch = global.fetch;
  const unauthorizedState = await rawFetch(`${info.url}api/state`);
  assert(unauthorizedState.status === 401, "state endpoint should require launch token");
  global.fetch = (resource, options = {}) => {
    const resourceUrl = typeof resource === "string" ? resource : resource?.url || "";
    if (resourceUrl.startsWith(`${info.url}api/`)) {
      return rawFetch(resource, {
        ...options,
        headers: {
          ...(options.headers || {}),
          "x-local-token": info.launchToken
        }
      });
    }
    return rawFetch(resource, options);
  };

  const rendererHtml = await fetchText(info.url, "renderer shell");
  assert(rendererHtml.includes('id="splitRightButton"'), "renderer shell should keep split terminal in the titlebar");
  assert(!rendererHtml.includes('id="newTerminalButton"'), "renderer shell should keep the terminal launcher out of the titlebar");
  assert(!rendererHtml.includes('id="newBrowserButton"'), "renderer shell should keep the browser launcher out of the titlebar");

  const rendererApp = await fetchText(`${info.url}app.js`, "renderer app");
  const rendererScrollUtils = fs.readFileSync(path.join(__dirname, "..", "renderer", "scroll-utils.js"), "utf8");
  assert(rendererApp.includes("Use everywhere"), "active background panel should expose a use-everywhere action");
  assert(
    /cycleTemplate\.dataset\.backgroundAction = "cycle-template";[\s\S]*active background image cycle template choose paste save copy open/.test(rendererApp),
    "active background panel should expose a direct cycle-template action"
  );
  assert(rendererApp.includes("function openBackgroundSettings"), "background settings should use a focused navigation helper");
  assert(rendererApp.includes('panel.dataset.settingsScrollTarget = "background"'), "active background panel should be a settings scroll target");
  assert(
    !/Open Background Settings", shortcut: "", run: \(\) => openSettingsCategory\("appearance", \{ query: "background"/.test(rendererApp),
    "background settings command should not open a broad background search"
  );
  assert(!rendererApp.includes("ensureToolbarLaunchButton"), "renderer app should not dynamically recreate titlebar launch buttons");
  assert(!rendererApp.includes("newTerminalButton"), "renderer app should not bind a removed titlebar terminal launcher");
  assert(!rendererApp.includes("newBrowserButton"), "renderer app should not bind a removed titlebar browser launcher");
  assert(rendererApp.includes("getNewSurfaceTabs(workspace)"), "surface tab strip should keep terminal and browser add controls");
  assert(rendererApp.includes('className: "surface-new-terminal"'), "surface tab strip should expose a terminal add control");
  assert(rendererApp.includes('className: "surface-new-browser"'), "surface tab strip should expose a browser add control");
  assert(rendererApp.includes("function createBrowserPanel(direction = newPaneDirection(), options = {})"), "browser pane creation should use a shared placement helper");
  assert(
    rendererApp.includes('contextMenuButton("Browser right"')
      && rendererApp.includes('contextMenuButton("Browser below"')
      && rendererApp.includes("showBrowserPanePlacementMenu"),
    "browser panes should expose explicit right/below placement controls"
  );
  assert(
    rendererApp.includes("normalizeTerminalPasteText")
      && rendererApp.includes("replace(/(?:\\r\\n|\\r|\\n)+$/u, \"\")"),
    "terminal paste should strip accidental trailing blank enters"
  );
  assert(
    rendererApp.includes("attachHorizontalWheelScroll(tabList)")
      && rendererScrollUtils.includes("event.deltaMode === WheelEvent.DOM_DELTA_LINE")
      && rendererScrollUtils.includes("event.stopPropagation()")
      && rendererScrollUtils.includes("element.scrollLeft = next"),
    "crowded command, workspace, and browser tab strips should wheel-scroll smoothly without parent scroll bleed"
  );
  assert(
    rendererApp.includes("function shouldConfirmTerminalPaste")
      && rendererApp.includes("terminalConfirmMultilinePaste")
      && rendererApp.includes('"Paste multiple lines?"')
      && rendererApp.includes('"Confirm multiline paste"'),
    "terminal paste should confirm multi-line clipboard input while keeping normal paste fast"
  );
  assert(
    rendererApp.includes("async function renameBrowserTab")
      && rendererApp.includes('contextMenuButton("Rename tab"')
      && rendererApp.includes('event.key === "F2"'),
    "browser tabs should support custom rename from context menu and keyboard"
  );
  assert(
    rendererApp.includes("function openBrowserTabAsPane")
      && rendererApp.includes('contextMenuButton("Open tab right"')
      && rendererApp.includes('contextMenuButton("Open tab below"'),
    "browser tabs should open directly into right/below panes"
  );
  assert(
    rendererApp.includes("async function moveBrowserTabAsPane")
      && rendererApp.includes('contextMenuButton("Move tab right"')
      && rendererApp.includes('contextMenuButton("Move tab below"')
      && rendererApp.includes("closeBrowserTab(session, tabId, { focus: false })"),
    "browser tabs should move directly into right/below panes without stealing focus back"
  );
  assert(
    rendererApp.includes("function transferBrowserTabToSession")
      && rendererApp.includes("state.browserTabDragSource")
      && rendererApp.includes('event.dataTransfer.setData("application/x-cmux-browser-tab"')
      && rendererApp.includes("transferBrowserTabToSession(source, session, targetTabId, placement)")
      && rendererApp.includes("transferBrowserTabToSession(source, session)"),
    "browser tabs should drag between browser panes, not only reorder inside one pane"
  );
  assert(
    /function clearAllDropTargets\(\) \{[\s\S]*?clearBrowserTabDragSource\(\);/.test(rendererApp),
    "global drag cleanup should clear stale browser tab drag state"
  );
  assert(
    rendererApp.includes('button.addEventListener("dblclick"')
      && rendererApp.includes("double-click or F2 to rename"),
    "browser tabs should support double-click rename like pane tabs"
  );
  assert(
    rendererApp.includes("browserFullscreenMode")
      && rendererApp.includes('view.addEventListener("enter-html-full-screen"'),
    "browser fullscreen requests should be handled by the pane fullscreen setting"
  );
  assert(
    rendererApp.includes("function updateInspectorCloseButtonLabel")
      && rendererApp.includes('"Close settings"'),
    "settings inspector should expose a clear close action label"
  );
  assert(
    rendererApp.includes("previousSettingsSnapshot")
      && rendererApp.includes("function restorePreviousSettings")
      && rendererApp.includes("skipUndo: true")
      && rendererApp.includes("Restore previous settings")
      && rendererApp.includes('id: "settings.restorePrevious"'),
    "settings customization should support one-step restore after profile, preset, and theme changes"
  );
  assert(
    rendererApp.includes('id: "quick.restoreSettings"')
      && rendererApp.includes('label: "Undo settings"')
      && rendererApp.includes("previousSettingsSnapshotLabel()")
      && rendererApp.includes("hasPreviousSettingsSnapshot()"),
    "settings restore should appear as a temporary palette quick action after changes"
  );
  assert(rendererApp.includes("maybeApplyReadableBrowserPaneLayout"), "browser panes should be promoted out of unreadable split slots");
  assert(rendererApp.includes("browserReadableLayoutMinHeightRatio"), "browser pane layout should guard against short half-rendered slots");
  assert(
    rendererApp.includes("function browserPaneDomLooksUnreadable")
      && rendererApp.includes("shellRect.height < bodyRect.height * 0.82")
      && rendererApp.includes("return browserPaneDomLooksUnreadable(panelId);")
      && rendererApp.includes('{ render: false, autoLayout: false }'),
    "browser panes should stay manually resizable while the DOM guard only repairs real browser view sizing failures"
  );
  assert(rendererApp.includes("rect.width > 0 ? rect.width"), "browser view bounds should use the visible pane rect before client fallback");
  assert(
    /setPaneSplitterPercent[\s\S]*scheduleVisibleBrowserViewBoundsSync\(browserViewBoundsSyncFrames\);[\s\S]*scheduleLayoutSettingsRefresh/.test(rendererApp),
    "exact split resizing should resync browser view bounds"
  );
  assert(
    /scheduleBrowserViewBoundsForPanelIds\(panelIds, browserViewBoundsSyncFrames\);[\s\S]*if \(typeof ResizeObserver === "function"\) return;/.test(rendererApp),
    "drag split resizing should resync browser view bounds before relying on ResizeObserver"
  );
  assert(rendererApp.includes("clearPaneLayoutWeightsForWorkspace(workspace)"), "browser auto layout should clear stale pane weights");
  assert(rendererApp.includes("scheduleReadableBrowserPaneDomGuard(workspace)"), "rendered browser panes should be checked for unreadable DOM sizes");
  assert(rendererApp.includes("browserCompactChromeMigrationStorageKey"), "full browser chrome should migrate to the cleaner compact default");
  assert(rendererApp.includes("state.performanceGuardSlowRenderCount += value >= renderVerySlowFrameMs ? 2 : 1"), "performance guard should require repeated slow render evidence");
  assert(rendererApp.includes("crowdedPaneAutoLayoutPanelThreshold = 3"), "crowded pane auto layout should stay enabled for three-pane slivers");
  assert(rendererApp.includes("migrateCrowdedPaneTree(workspace, tree)"), "existing crowded pane trees should be migrated");
  assert(rendererApp.includes("maybeApplyCrowdedPaneAutoLayout(workspace.id, createdPanel?.id"), "new pane creation should apply crowded-pane auto layout");
  assert(
    rendererApp.includes("function terminalPanelColorOverrides")
      && rendererApp.includes("overrides.terminalBackground")
      && /overrides\.terminalCursorColor,\s*paneBackground\s*\]\.join\("\|"\)/.test(rendererApp),
    "terminal theme signature should include pane background and pane color override values"
  );
  assert(
    rendererApp.includes("applyTerminalColorPresetToActivePane")
      && rendererApp.includes("terminalPanelsWithColorOverrides")
      && rendererApp.includes("clearTerminalColorOverridesForUpdates")
      && rendererApp.includes("async function applyTerminalSetupUpdates")
      && rendererApp.includes("async function resetTerminalSetupSettings")
      && rendererApp.includes("async function applySettingsPreset")
      && rendererApp.includes("async function applySavedSettingsProfile")
      && rendererApp.includes("async function applyLookSettingsUpdates")
      && rendererApp.includes("async function applyLookPack")
      && rendererApp.includes("async function resetAppearanceSettings")
      && rendererApp.includes("terminalSetupSettingsAreDefault()")
      && rendererApp.includes("terminalColorOverridesMaskSettings")
      && rendererApp.includes("terminal colors applied to all terminals + new")
      && rendererApp.includes('data-terminal-color-pane'),
    "terminal color presets, setup actions, and settings profiles should support focused-pane overrides and all-terminal default cleanup"
  );
  assert(
    rendererApp.includes("attachCustomKeyEventHandler")
      && rendererApp.includes("handleTerminalCustomKeyEvent")
      && rendererApp.includes("isPlainTerminalCopyShortcut")
      && rendererApp.includes("isPlainTerminalPasteShortcut")
      && rendererApp.includes("terminalSelectionText(panel)")
      && rendererApp.includes("isTerminalAppShortcutEvent")
      && /replace\(\s*\/\(\?:\\r\\n\|\\r\|\\n\)\+\$\/u\s*,\s*""\s*\)/.test(rendererApp),
    "terminal copy/paste shortcuts should support Windows-style Ctrl+C/V without leaking app shortcuts to the shell"
  );
  assert(
    rendererApp.includes('menu.style.maxHeight = `${maxHeight}px`;')
      && rendererApp.includes("const openUp = bottomSpace < height && topSpace > bottomSpace"),
    "context menus should size and flip inside the viewport"
  );
  assert(
    rendererApp.includes('"terminalBackgroundImage",\r\n  "terminalBackground"')
      || rendererApp.includes('"terminalBackgroundImage",\n  "terminalBackground"'),
    "new terminal background default should be part of terminal preview refresh state"
  );
  const rendererConfig = fs.readFileSync(path.join(__dirname, "..", "renderer", "config.js"), "utf8");
  const rendererBrowserTabs = fs.readFileSync(path.join(__dirname, "..", "renderer", "browser-tabs.js"), "utf8");
  const serverApp = fs.readFileSync(path.join(__dirname, "server.cjs"), "utf8");
  assert(
    serverApp.includes("function sanitizeTerminalColor")
      && serverApp.includes("terminalBackground: panel.type === \"terminal\" ? sanitizeTerminalColor(panel.terminalBackground)")
      && serverApp.includes("terminalCursorColor: type === \"terminal\" ? sanitizeTerminalColor(options.terminalCursorColor)")
      && serverApp.includes('for (const key of ["terminalBackground", "terminalForeground", "terminalCursorColor"])'),
    "server should persist per-pane terminal color overrides"
  );
  assert(
    rendererBrowserTabs.includes("titleLocked")
      && rendererApp.includes("if (tab.titleLocked) return;")
      && rendererApp.includes("titleLocked: Boolean(tab.titleLocked)"),
    "custom browser tab titles should persist and not be overwritten by page titles"
  );
  assert(
    rendererConfig.includes('"terminalBackgroundImage",\r\n  "terminalBackground"')
      || rendererConfig.includes('"terminalBackgroundImage",\n  "terminalBackground"'),
    "new terminal background default should be part of terminal appearance refresh state"
  );
  assert(
    rendererApp.includes('cleanUrl.searchParams.delete("token")')
      && rendererApp.includes("window.history.replaceState"),
    "renderer should remove the launch token from the visible URL after startup"
  );
  assert(rendererConfig.includes('addTabStyle: "compact"'), "new pane add tabs should default to compact controls");
  assert(rendererConfig.includes("terminalConfirmMultilinePaste: true"), "multi-line terminal paste confirmation should be enabled by default");
  const releaseCleanupScript = fs.readFileSync(path.join(__dirname, "close-release-processes.cjs"), "utf8");
  assert(
    releaseCleanupScript.includes('"cmux-*-setup.exe"')
      && releaseCleanupScript.includes('"cmux-*-setup.exe.blockmap"')
      && releaseCleanupScript.includes("Removed {0} stale installer artifact(s)."),
    "Windows release cleanup should remove stale installer artifacts before packaging"
  );

  const rendererCss = await fetchText(`${info.url}styles.css`, "renderer styles");
  assert(rendererCss.includes("grid-template-rows: minmax(0, 1fr);"), "root shell should define a single full-height grid row");
  assert(rendererCss.includes(".shell > *:not(.window-resize-edge)"), "resize handles should not be converted into shell grid items");
  assert(rendererCss.includes("max-height: 100%;"), "browser view should be clamped to its pane height");
  assert(rendererCss.includes("overflow-x: hidden;"), "context menus should not grow sideways when scrollable");
  assert(rendererCss.includes("grid-template-columns: 14px minmax(0, 1fr);"), "settings page tabs should show icon and label at readable widths");
  assert(
    rendererCss.includes(".inspector-head .icon-button")
      && rendererCss.includes("order: -1;"),
    "settings inspector close button should remain visible at the start of the header"
  );
  assert(rendererCss.includes("@container (max-width: 560px)"), "quick settings actions should stack before labels clip");
  assert(
    rendererCss.includes("content-visibility: auto;")
      && rendererCss.includes(".settings-react-host.is-searching ~ .settings-section")
      && rendererApp.includes("setSettingsScrollLayoutNeeded"),
    "settings sections should skip offscreen layout while preserving search and scroll-target measurement"
  );
  assert(!rendererCss.includes("#newTerminalButton"), "renderer styles should not target a removed titlebar terminal launcher");
  assert(!rendererCss.includes("#newBrowserButton"), "renderer styles should not target a removed titlebar browser launcher");
  assert(
    !/\.topbar \.command-strip #newTerminalButton,\s*\.topbar \.command-strip #newBrowserButton\s*\{\s*display:\s*none !important;\s*\}/.test(rendererCss),
    "renderer styles should not force-hide titlebar launcher buttons"
  );
  assert(
    /\.workspace-row:not\(\.is-active\) \.workspace-close\s*\{\s*opacity:\s*\.68;\s*pointer-events:\s*auto;\s*\}/.test(rendererCss),
    "workspace close button should remain visible and clickable on inactive rows"
  );
  assert(
    rendererApp.includes("terminalPaneChromeSettings")
      && rendererApp.includes("terminalPaneChromeSettings.has(key)"),
    "terminal background color changes should refresh visible pane chrome"
  );

  const stateResponse = await fetch(`${info.url}api/state`);
  assert(stateResponse.ok, "state endpoint failed");
  const state = await stateResponse.json();
  assert(state.workspaces.length === 1, "expected one initial workspace");

  const autoWorkspaceOneResponse = await fetch(`${info.url}api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert(autoWorkspaceOneResponse.ok, "first default workspace create failed");
  const autoWorkspaceOne = await autoWorkspaceOneResponse.json();
  assert(autoWorkspaceOne.title === "Workspace 2", "first default workspace should use the next free title");

  const autoWorkspaceTwoResponse = await fetch(`${info.url}api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert(autoWorkspaceTwoResponse.ok, "second default workspace create failed");
  const autoWorkspaceTwo = await autoWorkspaceTwoResponse.json();
  assert(autoWorkspaceTwo.title === "Workspace 3", "second default workspace should avoid duplicate titles");

  const workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), `cmux-windows-cwd-${process.pid}-`));
  const folderWorkspaceOneResponse = await fetch(`${info.url}api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: workspaceCwd })
  });
  assert(folderWorkspaceOneResponse.ok, "first folder workspace create failed");
  const folderWorkspaceOne = await folderWorkspaceOneResponse.json();
  assert(folderWorkspaceOne.title === path.basename(workspaceCwd), "folder workspace should use the folder name");

  const folderWorkspaceTwoResponse = await fetch(`${info.url}api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: workspaceCwd })
  });
  assert(folderWorkspaceTwoResponse.ok, "second folder workspace create failed");
  const folderWorkspaceTwo = await folderWorkspaceTwoResponse.json();
  assert(folderWorkspaceTwo.title === `${path.basename(workspaceCwd)} 2`, "duplicate folder workspace should get a suffix");

  const workspaceResponse = await fetch(`${info.url}api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Smoke", cwd: workspaceCwd })
  });
  assert(workspaceResponse.ok, "workspace create failed");
  const workspace = await workspaceResponse.json();
  assert(workspace.cwd === workspaceCwd, "workspace cwd should use requested folder");
  assert(workspace.panels[0]?.cwd === workspaceCwd, "initial workspace panel should inherit requested folder");

  const terminalResponse = await fetch(`${info.url}api/panels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: workspace.id, type: "terminal", direction: "right" })
  });
  assert(terminalResponse.ok, "terminal create failed");
  const terminal = await terminalResponse.json();
  assert(terminal.cwd === workspaceCwd, "new terminal should inherit workspace folder");

  const initialTerminal = workspace.panels[0];
  assert(initialTerminal?.type === "terminal", "workspace should start with a terminal panel");
  const titleResponse = await fetch(`${info.url}api/panels/${initialTerminal.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Pinned Pane" })
  });
  assert(titleResponse.ok, "terminal title update failed");
  const titleStateResponse = await fetch(`${info.url}api/state`);
  const titleState = await titleStateResponse.json();
  const titleWorkspace = titleState.workspaces.find((candidate) => candidate.id === workspace.id);
  const titledTerminal = titleWorkspace.panels.find((panel) => panel.id === initialTerminal.id);
  assert(titledTerminal.title === "Pinned Pane", "manual terminal title should update");
  assert(titledTerminal.titleLocked === true, "manual terminal title should be locked");

  const restartTitleResponse = await fetch(`${info.url}api/panels/${initialTerminal.id}/restart`, {
    method: "POST"
  });
  assert(restartTitleResponse.ok, "terminal restart failed");
  const restartedTitleStateResponse = await fetch(`${info.url}api/state`);
  const restartedTitleState = await restartedTitleStateResponse.json();
  const restartedTitleWorkspace = restartedTitleState.workspaces.find((candidate) => candidate.id === workspace.id);
  const restartedTitledTerminal = restartedTitleWorkspace.panels.find((panel) => panel.id === initialTerminal.id);
  assert(restartedTitledTerminal.title === "Pinned Pane", "manual terminal title should survive restart");

  const firstFontResponse = await fetch(`${info.url}api/panels/${initialTerminal.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalFontSize: 18 })
  });
  assert(firstFontResponse.ok, "first terminal font size update failed");
  const isolatedFontStateResponse = await fetch(`${info.url}api/state`);
  const isolatedFontState = await isolatedFontStateResponse.json();
  const isolatedFontWorkspace = isolatedFontState.workspaces.find((candidate) => candidate.id === workspace.id);
  const isolatedInitialTerminal = isolatedFontWorkspace.panels.find((panel) => panel.id === initialTerminal.id);
  const isolatedSecondTerminal = isolatedFontWorkspace.panels.find((panel) => panel.id === terminal.id);
  assert(isolatedInitialTerminal.terminalFontSize === 18, "target terminal should keep its font size override");
  assert(isolatedSecondTerminal.terminalFontSize === 0, "other terminals should not inherit a pane font size override");

  const secondFontResponse = await fetch(`${info.url}api/panels/${terminal.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalFontSize: 11 })
  });
  assert(secondFontResponse.ok, "second terminal font size update failed");
  const dualFontStateResponse = await fetch(`${info.url}api/state`);
  const dualFontState = await dualFontStateResponse.json();
  const dualFontWorkspace = dualFontState.workspaces.find((candidate) => candidate.id === workspace.id);
  const dualInitialTerminal = dualFontWorkspace.panels.find((panel) => panel.id === initialTerminal.id);
  const dualSecondTerminal = dualFontWorkspace.panels.find((panel) => panel.id === terminal.id);
  assert(dualInitialTerminal.terminalFontSize === 18, "first terminal font size override should remain separate");
  assert(dualSecondTerminal.terminalFontSize === 11, "second terminal font size override should remain separate");

  const defaultBrowserResponse = await fetch(`${info.url}api/panels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: workspace.id, type: "browser" })
  });
  assert(defaultBrowserResponse.ok, "default browser create failed");
  const defaultBrowser = await defaultBrowserResponse.json();
  assert(defaultBrowser.url === "https://www.google.com", "default browser should open Google");

  const eventSocket = new WebSocket(`${info.url.replace(/^http/, "ws")}events?token=${encodeURIComponent(info.launchToken)}`);
  await waitForWebSocketOpen(eventSocket);
  const originalEnsureTerminalProcess = runtime.ensureTerminalProcess.bind(runtime);
  const prewarmedPanelIds = new Set();
  runtime.ensureTerminalProcess = (panel) => {
    prewarmedPanelIds.add(panel.id);
    return { closed: false, close() {} };
  };
  try {
    const prewarmWorkspaceResponse = await fetch(`${info.url}api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Prewarm Smoke" })
    });
    assert(prewarmWorkspaceResponse.ok, "prewarm workspace create failed");
    const prewarmWorkspace = await prewarmWorkspaceResponse.json();
    const prewarmInitialTerminal = prewarmWorkspace.panels[0];
    assert(prewarmInitialTerminal?.type === "terminal", "prewarm workspace should start with a terminal");
    await waitForCondition("initial workspace terminal prewarm", () => prewarmedPanelIds.has(prewarmInitialTerminal.id));

    const prewarmTerminalResponse = await fetch(`${info.url}api/panels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: prewarmWorkspace.id, type: "terminal", direction: "right" })
    });
    assert(prewarmTerminalResponse.ok, "prewarm terminal create failed");
    const prewarmTerminal = await prewarmTerminalResponse.json();
    await waitForCondition("created terminal prewarm", () => prewarmedPanelIds.has(prewarmTerminal.id));
  } finally {
    runtime.ensureTerminalProcess = originalEnsureTerminalProcess;
    eventSocket.close();
  }

  const restartResponse = await fetch(`${info.url}api/panels/${terminal.id}/restart`, {
    method: "POST"
  });
  assert(restartResponse.ok, "terminal restart failed");

  const browserResponse = await fetch(`${info.url}api/panels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: workspace.id, type: "browser", title: "Smoke Browser", color: "#336699", url: "https://example.com" })
  });
  assert(browserResponse.ok, "browser create failed");
  const browser = await browserResponse.json();
  assert(browser.title === "Smoke Browser", "browser title should be preserved on create");
  assert(browser.color === "#336699", "browser color should be preserved on create");

  const browserUpdateResponse = await fetch(`${info.url}api/panels/${browser.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.org" })
  });
  assert(browserUpdateResponse.ok, "browser update failed");

  const reorderWorkspaceResponse = await fetch(`${info.url}api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Reorder Target" })
  });
  assert(reorderWorkspaceResponse.ok, "workspace reorder target create failed");
  const reorderWorkspace = await reorderWorkspaceResponse.json();
  const reorderResponse = await fetch(`${info.url}api/workspaces/${reorderWorkspace.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ beforeWorkspaceId: workspace.id })
  });
  assert(reorderResponse.ok, "workspace reorder failed");
  const reorderedStateResponse = await fetch(`${info.url}api/state`);
  const reorderedState = await reorderedStateResponse.json();
  const smokeIndex = reorderedState.workspaces.findIndex((candidate) => candidate.id === workspace.id);
  const movedIndex = reorderedState.workspaces.findIndex((candidate) => candidate.id === reorderWorkspace.id);
  assert(movedIndex >= 0 && smokeIndex >= 0 && movedIndex < smokeIndex, "workspace reorder should move before target");

  const pngPath = path.join(dataDir, "background.png");
  fs.writeFileSync(pngPath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  ));
  const imageUrl = `${info.url}_cmux/local-image?url=${encodeURIComponent(pathToFileURL(pngPath).href)}`;
  const unauthorizedImageResponse = await rawFetch(imageUrl);
  assert(unauthorizedImageResponse.status === 401, "local background image endpoint should require launch token");
  const imageResponse = await rawFetch(`${imageUrl}&token=${encodeURIComponent(info.launchToken)}`);
  assert(imageResponse.ok, "local background image endpoint failed");
  assert((imageResponse.headers.get("content-type") || "").startsWith("image/png"), "local image endpoint should serve png content type");
  assert((await imageResponse.arrayBuffer()).byteLength > 0, "local image endpoint should return bytes");

  const missingFocusResponse = await fetch(`${info.url}api/panels/missing/focus`, {
    method: "POST"
  });
  assert(missingFocusResponse.status === 404, "missing panel focus should return 404");
  const missingFocus = await missingFocusResponse.json();
  assert(missingFocus.ok === false, "missing panel focus should report ok=false");

  const latestStateResponse = await fetch(`${info.url}api/state`);
  const latestState = await latestStateResponse.json();
  const activeWorkspace = latestState.workspaces.find((candidate) => candidate.id === latestState.activeWorkspaceId);
  assert(activeWorkspace.panels.length >= 1, "expected panels before close check");
  for (const panel of [...activeWorkspace.panels]) {
    const closeResponse = await fetch(`${info.url}api/panels/${panel.id}`, { method: "DELETE" });
    assert(closeResponse.ok, "panel close failed");
  }
  const emptyStateResponse = await fetch(`${info.url}api/state`);
  const emptyState = await emptyStateResponse.json();
  const emptyWorkspace = emptyState.workspaces.find((candidate) => candidate.id === emptyState.activeWorkspaceId);
  assert(emptyWorkspace.panels.length === 0, "workspace should allow zero open panels");

  const unauthenticatedPing = await pipeRoundTrip("ping");
  assert(unauthenticatedPing === "ERROR unauthorized", `unauthenticated pipe command should fail: ${unauthenticatedPing}`);
  const ping = await pipeRoundTrip("ping", info.launchToken);
  assert(ping === "OK", `pipe ping failed: ${ping}`);
  const inlineRpcPing = JSON.parse(await pipeRoundTrip(JSON.stringify({
    jsonrpc: "2.0",
    id: "inline-auth",
    method: "system.ping",
    params: { token: info.launchToken }
  })));
  assert(inlineRpcPing.jsonrpc === "2.0", "inline authenticated JSON-RPC should use JSON-RPC envelope");
  assert(inlineRpcPing.id === "inline-auth", "inline authenticated JSON-RPC should preserve id");
  assert(inlineRpcPing.result?.ok === true, "inline authenticated JSON-RPC should dispatch the first request");
  const parseError = JSON.parse(await pipeRoundTrip("{", info.launchToken));
  assert(parseError.jsonrpc === "2.0", "pipe parse errors should use JSON-RPC envelope");
  assert(parseError.id === null, "pipe parse errors should use null JSON-RPC id");
  assert(parseError.error?.code === -32700, "pipe parse errors should use JSON-RPC parse error code");
  const missingMethod = JSON.parse(await pipeRoundTrip(JSON.stringify({
    jsonrpc: "2.0",
    id: "missing-method",
    method: "system.missing"
  }), info.launchToken));
  assert(missingMethod.jsonrpc === "2.0", "pipe missing method should use JSON-RPC envelope");
  assert(missingMethod.id === "missing-method", "pipe missing method should preserve JSON-RPC id");
  assert(missingMethod.error?.code === -32601, "pipe missing method should use JSON-RPC method-not-found code");
  const originalHandlePipeLine = runtime.handlePipeLine.bind(runtime);
  runtime.handlePipeLine = async () => {
    throw new Error("forced smoke failure");
  };
  try {
    const internalError = JSON.parse(await pipeRoundTrip(JSON.stringify({
      jsonrpc: "2.0",
      id: "internal-error",
      method: "system.ping"
    }), info.launchToken));
    assert(internalError.jsonrpc === "2.0", "pipe fallback errors should use JSON-RPC envelope");
    assert(internalError.id === "internal-error", "pipe fallback errors should preserve JSON-RPC id");
    assert(internalError.error?.code === -32603, "pipe fallback errors should use JSON-RPC internal error code");
  } finally {
    runtime.handlePipeLine = originalHandlePipeLine;
  }

  runtime.close();
process.stdout.write("cmux smoke passed\n");
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
