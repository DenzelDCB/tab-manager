
import { supabase } from "./lib/supabase.js";

const SYNC_ALARM = "tab-manager-sync";

let running = false;

async function getDeviceId() {
  const stored = await chrome.storage.local.get(
    "tab_manager_device_id"
  );

  if (stored.tab_manager_device_id) {
    return stored.tab_manager_device_id;
  }

  const id = crypto.randomUUID();

  await chrome.storage.local.set({
    tab_manager_device_id: id
  });

  return id;
}

async function getCurrentTabs() {
  const tabs = await chrome.tabs.query({});

  return tabs
    .filter(tab =>
      tab.id !== undefined &&
      tab.url &&
      /^https?:\/\//i.test(tab.url)
    )
    .map(tab => ({
      browser_tab_id: tab.id,
      window_id: tab.windowId,
      url: tab.url,
      title: tab.title || ""
    }));
}

async function callDeviceFunction(name, body = {}) {
  const stored = await chrome.storage.local.get(
    "tab_manager_device_token"
  );

  const token = stored.tab_manager_device_token;

  if (!token) {
    throw new Error("Device token is missing.");
  }

  const { data, error } = await supabase.functions.invoke(
    name,
    {
      body,
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (error) {
    throw error;
  }

  return data;
}

async function syncEnrolledDevice() {
  const tabs = await getCurrentTabs();

  const result = await callDeviceFunction(
    "sync-tabs",
    { tabs }
  );

  console.log("Device tabs synced:", result.synced);
}

async function syncAdminDevice(user) {
  const deviceId = await getDeviceId();
  const tabs = await getCurrentTabs();

  // Replace this device's previous tab snapshot.
  const { error: deleteError } = await supabase
    .from("tabs")
    .delete()
    .eq("user_id", user.id)
    .eq("device_id", deviceId);

  if (deleteError) {
    throw deleteError;
  }

  if (tabs.length > 0) {
    const rows = tabs.map(tab => ({
      ...tab,
      user_id: user.id,
      device_id: deviceId,
      updated_at: new Date().toISOString()
    }));

    const { error } = await supabase
      .from("tabs")
      .insert(rows);

    if (error) {
      throw error;
    }
  }

  console.log("Administrator tabs synced:", tabs.length);
}

async function getDeviceCommands() {
  const result = await callDeviceFunction(
    "fetch-commands"
  );

  return result.commands || [];
}

async function getAdminCommands(user) {
  const deviceId = await getDeviceId();

  const { data, error } = await supabase
    .from("commands")
    .select("id, browser_tab_id, action")
    .eq("user_id", user.id)
    .eq("device_id", deviceId)
    .eq("executed", false)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    throw error;
  }

  return data || [];
}

async function acknowledgeDeviceCommand(commandId) {
  await callDeviceFunction("ack-command", {
    command_id: commandId
  });
}

async function acknowledgeAdminCommand(commandId, user) {
  const deviceId = await getDeviceId();

  const { error } = await supabase
    .from("commands")
    .update({ executed: true })
    .eq("id", commandId)
    .eq("user_id", user.id)
    .eq("device_id", deviceId);

  if (error) {
    throw error;
  }
}

async function executeCommands(commands, acknowledge) {
  for (const command of commands) {
    try {
      const tabId = Number(command.browser_tab_id);

      if (!Number.isInteger(tabId)) {
        continue;
      }

      if (command.action === "close") {
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          // The tab may already be closed.
        }
      }

      else if (command.action === "block") {
        try {
          await chrome.tabs.update(tabId, {
            url: chrome.runtime.getURL(
              "blocked.html"
            )
          });
        } catch {
          // The tab may no longer exist.
        }
      }

      else {
        console.warn(
          "Unknown command:",
          command.action
        );

        continue;
      }

      await acknowledge(command.id);

      console.log(
        "Executed command:",
        command.action,
        tabId
      );

    } catch (error) {
      console.error(
        "Command execution failed:",
        error
      );
    }
  }
}

async function runCycle() {
  if (running) return;

  running = true;

  try {
    const stored = await chrome.storage.local.get([
      "tab_manager_device_token"
    ]);

    // Enrolled browser: no user login needed.
    if (stored.tab_manager_device_token) {
      await syncEnrolledDevice();

      const commands = await getDeviceCommands();

      await executeCommands(
        commands,
        acknowledgeDeviceCommand
      );

      return;
    }

    // Administrator browser: use Supabase login.
    const { data, error } = await supabase.auth.getSession();

    if (error) throw error;

    const user = data.session?.user;

    if (!user) {
      console.log("Waiting for administrator login.");
      return;
    }

    await syncAdminDevice(user);

    const commands = await getAdminCommands(user);

    await executeCommands(
      commands,
      commandId =>
        acknowledgeAdminCommand(commandId, user)
    );

  } catch (error) {
    console.error("Tab Manager sync failed:", error);
  } finally {
    running = false;
  }
}

// Run periodically.
if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === SYNC_ALARM) {
      runCycle();
    }
  });

  chrome.alarms.create(SYNC_ALARM, {
    periodInMinutes: 0.5
  });
}

// Refresh after tab changes.
chrome.tabs.onCreated.addListener(() => runCycle());

chrome.tabs.onRemoved.addListener(() => runCycle());

chrome.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    if (
      changeInfo.status === "complete" ||
      changeInfo.url ||
      changeInfo.title
    ) {
      runCycle();
    }
  }
);

// Handle extension startup.
chrome.runtime.onStartup.addListener(() => {
  runCycle();
});

chrome.runtime.onInstalled.addListener(() => {
  runCycle();
});

// Handle messages from the popup and enrollment page.
chrome.runtime.onMessage.addListener(message => {
  if (
    message.type === "TAB_MANAGER_AUTH_CHANGED" ||
    message.type === "TAB_MANAGER_REFRESH_COMMANDS" ||
    message.type === "TAB_MANAGER_DEVICE_ENROLLED"
  ) {
    runCycle();
  }
});

// Initial synchronization.
runCycle();
