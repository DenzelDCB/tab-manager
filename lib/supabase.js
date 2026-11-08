import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://migxycpmmrdlucnmyqdn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_lUDbBRwtiT3jT0YKOP7-Xg_JO-JfUs9";

const chromeStorage = {
  async getItem(key) {
    const result = await chrome.storage.local.get(key);

    return result[key] ?? null;
  },

  async setItem(key, value) {
    await chrome.storage.local.set({
      [key]: value
    });
  },

  async removeItem(key) {
    await chrome.storage.local.remove(key);
  }
};

// Initialize Supabase.
export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      storage: chromeStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  }
);
