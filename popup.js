
import { supabase } from "./lib/supabase.js";

const $ = (id) => document.getElementById(id);

let currentUser = null;
let tabsChannel = null;
let loading = false;

// Display status messages.
function setStatus(message, type = "") {
  const status = $("status");

  status.textContent = message;
  status.className = `status ${type}`;
}

// Switch to login screen.
function showLogin() {
  $("login-view").classList.remove("hidden");
  $("dashboard-view").classList.add("hidden");
  $("refresh-button").classList.add("hidden");
}

// Switch to dashboard.
function showDashboard() {
  $("login-view").classList.add("hidden");
  $("dashboard-view").classList.remove("hidden");
  $("refresh-button").classList.remove("hidden");

  $("account-email").textContent =
    currentUser.email || "Administrator";
}

// Communicate with service_worker.js.
function notifyWorker(type) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message
          });
          return;
        }

        resolve(response || { ok: false });
      }
    );
  });
}

// Create safe HTML elements.
function createElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
}

// Load tracked tabs.
async function loadTabs() {
  if (!currentUser || loading) return;

  loading = true;

  $("refresh-button").disabled = true;

  try {
    const { data, error } = await supabase
      .from("tabs")
      .select(`
        id,
        device_id,
        browser_tab_id,
        window_id,
        url,
        title,
        updated_at
      `)
      .eq("user_id", currentUser.id)
      .order("updated_at", {
        ascending: false
      })
      .limit(200);

    if (error) throw error;

    const tabs = data || [];

    $("tab-count").textContent = tabs.length;

    const container = $("tabs-list");

    container.replaceChildren();

    if (tabs.length === 0) {
      container.append(
        createElement(
          "p",
          "empty",
          "No tracked tabs found."
        )
      );

      return;
    }

    tabs.forEach((tab) => {
      const card = createElement(
        "article",
        "tab-card"
      );

      const details = createElement(
        "div",
        "tab-details"
      );

      const title = createElement(
        "strong",
        "tab-title",
        tab.title || "Untitled tab"
      );

      const url = createElement(
        "a",
        "tab-url",
        tab.url || ""
      );

      url.href = tab.url;
      url.target = "_blank";
      url.rel = "noopener noreferrer";

      const device = createElement(
        "span",
        "tab-meta",
        `Device: ${tab.device_id.slice(0, 8)}`
      );

      const tabId = createElement(
        "span",
        "tab-meta",
        `Tab ID: ${tab.browser_tab_id}`
      );

      details.append(
        title,
        url,
        device,
        tabId
      );

      const actions = createElement(
        "div",
        "tab-actions"
      );

      const closeButton = createElement(
        "button",
        "danger",
        "Close"
      );

      const blockButton = createElement(
        "button",
        "secondary",
        "Block"
      );

      closeButton.type = "button";
      blockButton.type = "button";

      closeButton.addEventListener("click", () => {
        sendCommand(tab, "close", closeButton);
      });

      blockButton.addEventListener("click", () => {
        sendCommand(tab, "block", blockButton);
      });

      actions.append(
        closeButton,
        blockButton
      );

      card.append(details, actions);

      container.append(card);
    });

  } catch (error) {
    setStatus(
      `Failed to load tabs: ${error.message}`,
      "error"
    );

  } finally {
    loading = false;
    $("refresh-button").disabled = false;
  }
}

// Send a remote command.
async function sendCommand(tab, action, button) {
  button.disabled = true;

  const originalText = button.textContent;

  button.textContent = "Sending...";

  try {
    const { error } = await supabase
      .from("commands")
      .insert({
        user_id: currentUser.id,
        device_id: tab.device_id,
        browser_tab_id: tab.browser_tab_id,
        action
      });

    if (error) throw error;

    setStatus(
      `${action} command successfully queued.`,
      "success"
    );

    // Ask the local background worker to check.
    notifyWorker("TAB_MANAGER_REFRESH_COMMANDS");

  } catch (error) {
    setStatus(
      `Command failed: ${error.message}`,
      "error"
    );

    button.disabled = false;
    button.textContent = originalText;
  }
}

// Subscribe to database changes.
async function subscribeToTabs() {
  if (tabsChannel) {
    await supabase.removeChannel(tabsChannel);
  }

  tabsChannel = supabase
    .channel(`popup-tabs-${currentUser.id}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "tabs",
        filter: `user_id=eq.${currentUser.id}`
      },
      () => {
        void loadTabs();
      }
    )
    .subscribe();
}

// Apply authentication session.
async function applySession(session) {
  currentUser = session?.user || null;

  if (!currentUser) {
    if (tabsChannel) {
      await supabase.removeChannel(tabsChannel);
      tabsChannel = null;
    }

    showLogin();
    return;
  }

  showDashboard();

  await subscribeToTabs();
  await loadTabs();

  await notifyWorker(
    "TAB_MANAGER_AUTH_CHANGED"
  );
}

// Login form.
$("login-form").addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const button = $("login-form")
      .querySelector("button[type='submit']");

    button.disabled = true;

    setStatus("Signing in...");

    try {
      const { data, error } =
        await supabase.auth.signInWithPassword({
          email: $("email").value.trim(),
          password: $("password").value
        });

      if (error) throw error;

      $("password").value = "";

      await applySession(data.session);

      setStatus(
        "Successfully signed in.",
        "success"
      );

    } catch (error) {
      setStatus(
        `Login failed: ${error.message}`,
        "error"
      );

    } finally {
      button.disabled = false;
    }
  }
);

// Logout.
$("signout-button").addEventListener(
  "click",
  async () => {
    setStatus("Signing out...");

    const { error } = await supabase.auth.signOut();

    if (error) {
      setStatus(error.message, "error");
      return;
    }

    await notifyWorker(
      "TAB_MANAGER_AUTH_CHANGED"
    );

    currentUser = null;

    showLogin();

    setStatus("Successfully signed out.", "success");
  }
);

// Manual refresh.
$("refresh-button").addEventListener(
  "click",
  () => {
    void loadTabs();
  }
);

// Listen for authentication changes.
supabase.auth.onAuthStateChange(
  (event, session) => {
    if (
      ["SIGNED_IN", "SIGNED_OUT", "TOKEN_REFRESHED"]
        .includes(event)
    ) {
      // Avoid performing Supabase operations
      // inside the authentication callback.
      setTimeout(() => {
        void applySession(session);
      }, 0);
    }
  }
);

// Restore existing session.
const { data, error } =
  await supabase.auth.getSession();

if (error) {
  setStatus(error.message, "error");
}

await applySession(data?.session || null);

$("generate-code-button").addEventListener(
  "click",
  async () => {
    const button = $("generate-code-button");

    button.disabled = true;
    button.textContent = "Generating...";

    try {
      const { data, error } = await supabase.rpc(
        "create_enrollment_code"
      );

      if (error) throw error;

      const result = data?.[0];

      if (!result?.enrollment_code) {
        throw new Error("No enrollment code returned.");
      }

      $("enrollment-code").textContent =
        result.enrollment_code;

      const expiry = new Date(result.expires_at);

      $("enrollment-expiry").textContent =
        `Expires: ${expiry.toLocaleTimeString()}`;

      $("enrollment-code-panel").classList.remove(
        "hidden"
      );

      button.textContent = "Generate New Code";

    } catch (error) {
      setStatus(error.message, "error");
      button.textContent = "Generate Enrollment Code";

    } finally {
      button.disabled = false;
    }
  }
);

$("copy-code-button").addEventListener(
  "click",
  async () => {
    const code = $("enrollment-code").textContent;

    await navigator.clipboard.writeText(code);

    $("copy-code-button").textContent = "Copied!";

    setTimeout(() => {
      $("copy-code-button").textContent = "Copy Code";
    }, 1500);
  }
);
