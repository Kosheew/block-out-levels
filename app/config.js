// Налаштування Supabase для Level Lab.
// Значення беруться з Supabase → Project Settings → API (Project URL і anon public key).
// anon key публічний за задумом: усі права на запис перевіряє база (Row Level Security), тому його можна комітити.
// НЕ вставляйте сюди service_role key.
// Поки поля порожні, сайт працює лише на перегляд (дані з GitHub).
export const SUPABASE = {
  url: '',
  anonKey: '',
};
