// TONSPUR config. Public, client-safe values only.
// Supabase anon key is designed to be embedded in the client (RLS protects data).
// Filled in after the one-time Supabase project setup; empty = cloud login disabled
// (the app then runs in local-key mode via localStorage).
export const SUPABASE = {
  url: "https://mmcblaxzrxqxxaojnxzi.supabase.co",
  anon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1tY2JsYXh6cnhxeHhhb2pueHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNDg2NzAsImV4cCI6MjA5NTgyNDY3MH0.JZSgH4g6_aesY7W_aa9GXqWWrF9tGWbyKswcEUHaQg0",
};

// Groq Speech-to-Text pricing (USD per hour of audio) — estimates, verify on groq.com.
export const PRICING = {
  "whisper-large-v3": 0.111,
  "whisper-large-v3-turbo": 0.04,
};
// Cleanup LLM (USD per 1M tokens) — llama-3.3-70b-versatile, rough.
export const CLEANUP_PRICE = { in: 0.59, out: 0.79 };
export const USD_EUR = 0.92; // rough conversion for display
