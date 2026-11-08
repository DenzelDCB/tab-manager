import { supabase } from "./lib/supabase.js";

let cycleRunning = false;

async function getDeviceId(userId) {
  const key = `tab_manager_device_id_${userId}`;
  const saved = await chrome.storage.local.get(key);
  if (saved[key]) return saved[key];

  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [key]: id });
  return id;
}

async function getCurrentTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(tab =>
      Number.isInteger(tab.id) &&
      typeof tab.url === "string" &&
      /^https?:\/\//i.test(tab.url)
    )
    .map(tab => ({
      browser_tab_id: tab.id,
      window_id: Number.isInteger(tab.windowId) ? tab.windowId : null,
      url: tab.url,
      title: (tab.title || "").slice(0, 1000)
    }));
}

async function registerDevice(user) {
  const deviceId = await getDeviceId(user.id);
  const { data: existing, error: lookupError } = await supabase
    .from("devices")
    .select("id, revoked_at")
    .eq("id", deviceId)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing?.revoked_at) return null;

  const { error } = await supabase.from("devices").upsert({
    id: deviceId,
    user_id: user.id,
    device_name: `Chrome (${navigator.platform || "Desktop"})`,
    last_seen_at: new Date().toISOString()
  }, { onConflict: "id" });

  if (error) throw error;
  return deviceId;
}

async function syncTabs(user, deviceId) {
  const tabs = await getCurrentTabs();

  console.log("Tabs detected:", tabs.length);
  console.log("Syncing device:", deviceId);
  console.log("Authenticated user:", user.id);

  const { error: deleteError } = await supabase
    .from("tabs")
    .delete()
    .eq("user_id", user.id)
    .eq("device_id", deviceId);

  if (deleteError) {
    console.error("Tab deletion failed:", deleteError);
    throw deleteError;
  }

  if (tabs.length > 0) {
    const rows = tabs.map(tab => ({
      user_id: user.id,
      device_id: deviceId,
      ...tab,
      updated_at: new Date().toISOString()
    }));

    const { data, error } = await supabase
      .from("tabs")
      .insert(rows)
      .select("id");

    if (error) {
      console.error("Tab insertion failed:", error);
      throw error;
    }

    console.log("Tabs successfully synced:", data.length);
  }

  const { error: deviceError } = await supabase
    .from("devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", deviceId);

  if (deviceError) {
    console.error("Device update failed:", deviceError);
    throw deviceError;
  }
}

async function acknowledgeCommand(commandId) {
  const { error } = await supabase.from("commands")
    .update({
      executed: true,
      executed_at: new Date().toISOString()
    })
    .eq("id", commandId);

  if (error) console.error("Command acknowledgement failed:", error.message);
}

async function executeCommands(deviceId) {
  const { data: commands, error } = await supabase
    .from("commands")
    .select("id, browser_tab_id, action")
    .eq("device_id", deviceId)
    .eq("executed", false)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) throw error;

  for (const command of commands || []) {
    const tabId = Number(command.browser_tab_id);

    try {
      if (command.action === "close") {
        await chrome.tabs.remove(tabId);
      } else if (command.action === "block") {
        const tab = await chrome.tabs.get(tabId);
        const params = new URLSearchParams({
          url: tab.url || "",
          title: tab.title || ""
        });

        await chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL(`blocked.html?${params.toString()}`)
        });
      }
    } catch (error) {
      console.warn("Could not execute tab command:", error);
    }

    await acknowledgeCommand(command.id);
  }
}

async function runCycle() {
  if (cycleRunning) return;
  cycleRunning = true;

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;

    const user = data.session?.user;
    if (!user) return;

    const deviceId = await registerDevice(user);
    if (!deviceId) return;

    await syncTabs(user, deviceId);
    await executeCommands(deviceId);
  } catch (error) {
    console.error("Tab Manager sync failed:", error.message || error);
  } finally {
    cycleRunning = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("tab-manager-sync", { periodInMinutes: 0.5 });
  runCycle();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("tab-manager-sync", { periodInMinutes: 0.5 });
  runCycle();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "tab-manager-sync") runCycle();
});

chrome.tabs.onCreated.addListener(() => runCycle());
chrome.tabs.onRemoved.addListener(() => runCycle());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") runCycle();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TAB_MANAGER_SYNC_NOW") {
    runCycle().then(() => sendResponse({ success: true }));
    return true;
  }
});

chrome.alarms.create("tab-manager-sync", { periodInMinutes: 0.5 });
runCycle();
