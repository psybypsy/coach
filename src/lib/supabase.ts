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
    // 明確指定 implicit：PKCE 會把 code_verifier 存在「發出登入請求的那個瀏覽器」，
    // 使用者若在 Gmail App 內建瀏覽器點連結就會驗證失敗。implicit 沒有這個限制，
    // 也避免日後 supabase-js 改預設值時無聲破壞既有的 email 登入連結。
    flowType: 'implicit',
    // 註：storageKey 刻意不自訂——改掉會讓現有已登入的使用者讀不到舊 key 而被登出。
  },
})
