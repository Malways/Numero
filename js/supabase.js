import { APP_CONFIG } from "./config.js";

export function getSupabaseStatus() {
    if (!APP_CONFIG.supabaseEnabled) {
        return { ready: false, message: "Supabase: 미설정" };
    }

    const hasUrl = Boolean(APP_CONFIG.supabaseUrl);
    const hasAnonKey = Boolean(APP_CONFIG.supabaseAnonKey);

    if (hasUrl && hasAnonKey) {
        return { ready: true, message: "Supabase: 준비됨" };
    }

    return {
        ready: false,
        message: "Supabase: 키 확인 필요",
    };
}

// 추후 실제 연결 시 @supabase/supabase-js를 추가하고 여기에서 클라이언트를 생성하면 됩니다.
export function createSupabaseClientPlaceholder() {
    return null;
}
