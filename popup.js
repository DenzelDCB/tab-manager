import { supabase } from "./lib/supabase.js";

const $ = id => document.getElementById(id);

const loginView = $("login-view");
const connectedView = $("connected-view");
const adminLoginView = $("admin-login-view");
const adminView = $("admin-view");

let currentUser = null;
let adminVerified = false;

function showStatus(id, message, type = "") {
  const element = $(id);
  element.textContent = message;
  element.className = `status ${type}`;
}

function showView(view) {
  [loginView, connectedView, adminLoginView, adminView]
    .forEach(section => section.classList.add("hidden"));
  view.classList.remove("hidden");
}

async function getDeviceId(userId) {
  const key = `tab_manager_device_id_${userId}`;
  const saved = await chrome.storage.local.get(key);
  if (saved[key]) return saved[key];

  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [key]: id });
  return id;
}

async function registerThisDevice(user) {
  const deviceId = await getDeviceId(user.id);
  const { data: existing, error: lookupError } = await supabase
    .from("devices")
    .select("id, revoked_at")
    .eq("id", deviceId)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing?.revoked_at) {
    throw new Error("This browser has been revoked. Contact the account admin.");
  }

  const { error } = await supabase.from("devices").upsert({
    id: deviceId,
    user_id: user.id,
    device_name: `Chrome (${navigator.platform || "Desktop"})`,
    last_seen_at: new Date().toISOString()
  }, { onConflict: "id" });

  if (error) throw error;
  return deviceId;
}

async function loadConnectedView(user) {
  currentUser = user;
  showView(connectedView);
  $("account-email").textContent = user.email || "Signed in";
  $("connection-label").textContent = "Registering this browser...";
  showStatus("connection-status", "");

  try {
    await registerThisDevice(user);
    $("connection-label").textContent = "This browser is connected and syncing.";
    chrome.runtime.sendMessage({ type: "TAB_MANAGER_SYNC_NOW" });
  } catch (error) {
    $("connection-label").textContent = "Connection needs attention.";
    showStatus("connection-status", error.message, "error");
  }
}

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("login-button");
  button.disabled = true;
  button.textContent = "Connecting...";
  showStatus("login-status", "");

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value
    });
    if (error) throw error;
    if (!data.user) throw new Error("Sign-in did not return a user.");
    $("password").value = "";
    await loadConnectedView(data.user);
  } catch (error) {
    showStatus("login-status", error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Sign in and connect";
  }
});

$("open-admin").addEventListener("click", () => {
  $("admin-password").value = "";
  showStatus("admin-login-status", "");
  showView(adminLoginView);
});

$("cancel-admin").addEventListener("click", () => showView(connectedView));

$("admin-login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("admin-login-button");
  button.disabled = true;
  button.textContent = "Verifying...";
  showStatus("admin-login-status", "");

  try {
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: currentUser.email,
      password: $("admin-password").value
    });
    if (authError) throw authError;

    const { data: isAdmin, error: roleError } = await supabase.rpc(
      "is_tab_manager_admin"
    );
    if (roleError) throw roleError;
    if (isAdmin !== true) {
      throw new Error("This account has not been granted admin access.");
    }

    adminVerified = true;
    $("admin-password").value = "";
    showView(adminView);
    await refreshAdminDashboard();
  } catch (error) {
    showStatus("admin-login-status", error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Verify and continue";
  }
});

$("close-admin").addEventListener("click", () => {
  adminVerified = false;
  showView(connectedView);
});

$("sign-out").addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) {
    showStatus("connection-status", error.message, "error");
    return;
  }
  currentUser = null;
  adminVerified = false;
  showView(loginView);
});

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function refreshAdminDashboard() {
  if (!adminVerified || !currentUser) return;

  showStatus("admin-status", "Loading...");
  const [{ data: devices, error: devicesError },
         { data: tabs, error: tabsError }] = await Promise.all([
    supabase.from("devices")
      .select("id, device_name, created_at, last_seen_at, revoked_at")
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: true }),
    supabase.from("tabs")
      .select("id, device_id, browser_tab_id, url, title, updated_at")
      .eq("user_id", currentUser.id)
      .order("updated_at", { ascending: false })
  ]);

  if (devicesError || tabsError) {
    showStatus("admin-status",
      devicesError?.message || tabsError?.message, "error");
    return;
  }

  const deviceMap = new Map((devices || []).map(device => [device.id, device]));
  const devicesList = $("devices-list");
  const tabsList = $("tabs-list");
  devicesList.replaceChildren();
  tabsList.replaceChildren();

  if (!devices?.length) {
    devicesList.append(makeElement("p", "muted", "No connected devices yet."));
  }

  for (const device of devices || []) {
    const card = makeElement("div", "device");
    card.append(makeElement("strong", "", device.device_name || "Chrome device"));
    card.append(makeElement("small", "",
      device.revoked_at ? "Revoked" :
      `Last seen: ${device.last_seen_at || "Not available"}`));
    if (!device.revoked_at) {
      const revoke = makeElement("button", "danger", "Disconnect device");
      revoke.addEventListener("click", async () => {
        const { error } = await supabase.from("devices")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", device.id);
        if (error) showStatus("admin-status", error.message, "error");
        else await refreshAdminDashboard();
      });
      card.append(revoke);
    }
    devicesList.append(card);
  }

  if (!tabs?.length) {
    tabsList.append(makeElement("p", "muted", "No synced tabs found."));
  }

  for (const tab of tabs || []) {
    const device = deviceMap.get(tab.device_id);
    const card = makeElement("div", "tab");
    card.append(makeElement("strong", "", tab.title || tab.url));
    card.append(makeElement("small", "",
      `${device?.device_name || "Unknown device"} · ${tab.url}`));

    const actions = makeElement("div", "tab-actions");
    for (const action of ["close", "block"]) {
      const button = makeElement("button",
        action === "block" ? "danger" : "secondary",
        action === "close" ? "Close tab" : "Block tab");
      button.addEventListener("click", async () => {
        const { error } = await supabase.from("commands").insert({
          user_id: currentUser.id,
          device_id: tab.device_id,
          browser_tab_id: tab.browser_tab_id,
          action
        });
        if (error) showStatus("admin-status", error.message, "error");
        else showStatus("admin-status", `${action} command queued.`, "success");
      });
      actions.append(button);
    }
    card.append(actions);
    tabsList.append(card);
  }

  showStatus("admin-status", "Dashboard updated.", "success");
}

async function initialize() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    showStatus("login-status", error.message, "error");
    return;
  }
  if (data.session?.user) {
    await loadConnectedView(data.session.user);
  } else {
    showView(loginView);
  }
}

initialize();
