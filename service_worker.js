
import { supabase } from "./lib/supabase.js";

const DEVICE_KEY = "tab_manager_device_id";
const ALARM_NAME = "tab-manager-command-poll";

let deviceId;
let userId = null;
let commandChannel = null;
let busy = false;

console.log("Chrome:", typeof chrome);
console.log("Runtime:", typeof chrome?.runtime);
console.log("Alarms:", typeof chrome?.alarms);
console.log("Manifest:", chrome?.runtime?.getManifest());

function isValidUrl(url) {
  try {
    return ["http:", "https:"].includes(
      new URL(url).protocol
    );
  } catch {
    return false;
  }
}

async function getDeviceId() {
  if (deviceId) return deviceId;

  const stored = await chrome.storage.local.get(DEVICE_KEY);
  deviceId = stored[DEVICE_KEY];

  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({
      [DEVICE_KEY]: deviceId
    });
  }

  return deviceId;
}

async function getUser() {
  const { data, error } = await supabase.auth.getUser();

  if (error) throw error;

  return data.user;
}

// Synchronize an individual tab.
async function syncTab(tab) {
  if (!userId || !tab || !Number.isInteger(tab.id)) return;

  const url = tab.url || tab.pendingUrl || "";

  if (!isValidUrl(url)) return;

  const row = {
    user_id: userId,
    device_id: await getDeviceId(),
    browser_tab_id: tab.id,
    window_id: tab.windowId,
    url,
    title: tab.title || "",
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("tabs")
    .upsert(row, {
      onConflict: "user_id,device_id,browser_tab_id"
    });

  if (error) {
    console.error("Tab sync failed:", error.message);
  }
}

// Remove a closed tab from Supabase.
async function removeTab(tabId) {
  if (!userId) return;

  const { error } = await supabase
    .from("tabs")
    .delete()
    .eq("user_id", userId)
    .eq("device_id", await getDeviceId())
    .eq("browser_tab_id", tabId);

  if (error) {
    console.error("Tab removal failed:", error.message);
  }
}

// Synchronize existing tabs after startup.
async function syncAllTabs() {
  if (!userId) return;

  const tabs = await chrome.tabs.query({});

  await Promise.all(tabs.map(syncTab));
}

// Mark a command as executed.
async function acknowledge(command) {
  const { error } = await supabase
    .from("commands")
    .update({ executed: true })
    .eq("id", command.id)
    .eq("user_id", userId)
    .eq("device_id", deviceId);

  if (error) {
    console.error("Acknowledgement failed:", error.message);
  }
}

// Execute remote commands.
async function executeCommand(command) {
  if (!userId || !command) return;

  if (command.user_id !== userId) return;
  if (command.device_id !== deviceId) return;
  if (command.executed) return;

  if (!["close", "block"].includes(command.action)) return;

  try {
    const tab = await chrome.tabs.get(
      command.browser_tab_id
    );

    if (command.action === "close") {
      await chrome.tabs.remove(tab.id);
    }

    if (command.action === "block") {
      const blockedUrl = new URL(
        chrome.runtime.getURL("blocked.html")
      );

      blockedUrl.searchParams.set(
        "url",
        tab.url || tab.pendingUrl || ""
      );

      blockedUrl.searchParams.set(
        "title",
        tab.title || ""
      );

      await chrome.tabs.update(tab.id, {
        url: blockedUrl.toString()
      });
    }

    await acknowledge(command);

  } catch (error) {
    console.error("Command execution failed:", error);
  }
}

// Find pending commands for this browser.
async function processCommands() {
  if (!userId || busy) return;

  busy = true;

  try {
    const id = await getDeviceId();

    const { data, error } = await supabase
      .from("commands")
      .select("*")
      .eq("user_id", userId)
      .eq("device_id", id)
      .eq("executed", false)
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) throw error;

    for (const command of data || []) {
      await executeCommand(command);
    }

  } catch (error) {
    console.error("Command polling failed:", error);

  } finally {
    busy = false;
  }
}

// Subscribe to new commands.
async function connectRealtime() {
  if (!userId) return;

  if (commandChannel) {
    await supabase.removeChannel(commandChannel);
  }

  commandChannel = supabase
    .channel(`commands-${userId}-${deviceId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "commands",
        filter: `user_id=eq.${userId}`
      },
      (payload) => {
        void executeCommand(payload.new);
      }
    )
    .subscribe((status) => {
      console.log("Realtime:", status);

      if (status === "SUBSCRIBED") {
        void processCommands();
      }
    });
}

// Initialize authenticated browser session.
async function initializeUser() {
  const user = await getUser();

  if (!user) {
    userId = null;

    if (commandChannel) {
      await supabase.removeChannel(commandChannel);
      commandChannel = null;
    }

    return;
  }

  userId = user.id;

  await getDeviceId();
  await syncAllTabs();
  await connectRealtime();
  await processCommands();
}

// Chrome tab events.
chrome.tabs.onCreated.addListener((tab) => {
  void syncTab(tab);
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (
    change.url ||
    change.title ||
    change.status === "complete"
  ) {
    void syncTab(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTab(tabId);
});

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "sync-commands") {
      initializeUser();
    }
  });
} else {
  console.error("Chrome Alarms API unavailable.");
}

// Messages from popup.js.
chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {

    if (message?.type === "TAB_MANAGER_AUTH_CHANGED") {
      initializeUser()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({
          ok: false,
          error: error.message
        }));

      return true;
    }

    if (message?.type === "TAB_MANAGER_REFRESH_COMMANDS") {
      processCommands().then(() => {
        sendResponse({ ok: true });
      });

      return true;
    }

    return false;
  }
);

// Authentication changes.
supabase.auth.onAuthStateChange((event, session) => {
  if (
    event === "SIGNED_IN" ||
    event === "TOKEN_REFRESHED"
  ) {
    userId = session?.user?.id || null;
    void initializeUser();

  } else if (event === "SIGNED_OUT") {
    userId = null;

    if (commandChannel) {
      void supabase.removeChannel(commandChannel);
      commandChannel = null;
    }
  }
});

// Service worker startup.
async function initialize() {
  await getDeviceId();

  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: 1
  });

  await initializeUser();
}

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

void initialize();
