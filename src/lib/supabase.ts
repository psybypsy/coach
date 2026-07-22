import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // 把登入 session 存進 localStorage，並在背景自動續期，
    // 讓使用者登入一次後長期保持登入、不必再點 email 連結。
    persistSession: true,
    autoRefreshToken: true,
    // 點 email 登入連結導回時，自動從網址擷取 token 建立 session。
    detectSessionInUrl: true,
  },
})
